/**
 * run-scheduler 单测：参数解析、首轮延迟、--once、--no-logs、防重入、故障隔离、输出脱敏。
 * 全部用假 run 与假时钟/假 timer，不连网络、不等真实定时器。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { nextHourDelayMs } from '../jobs/scheduler.mjs';
import {
  computeInitialDelayMs,
  createLoop,
  createTaskRunner,
  DEFAULT_LOGS_INTERVAL_MS,
  DEFAULT_SPEND_INTERVAL_MS,
  LOGS_ALIGN_MS,
  nextSlotDelayMs,
  pickTasks,
  redactMessage,
  resolveOptions,
  runOnce,
  shouldRunNow,
  SPEND_ALIGN_MS,
  TASK_LOGS,
  TASK_SPEND,
} from '../jobs/run-scheduler.mjs';

function makeFakeTimer() {
  const timeouts = [];
  const intervals = [];
  return {
    timeouts,
    intervals,
    setTimeout(fn, ms) {
      const id = { fn, ms, cleared: false };
      timeouts.push(id);
      return id;
    },
    clearTimeout(id) {
      id.cleared = true;
    },
    setInterval(fn, ms) {
      const id = { fn, ms, cleared: false };
      intervals.push(id);
      return id;
    },
    clearInterval(id) {
      id.cleared = true;
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('resolveOptions：默认参数', () => {
  assert.deepEqual(resolveOptions([]), {
    once: false,
    noLogs: false,
    help: false,
    spendIntervalMs: DEFAULT_SPEND_INTERVAL_MS,
    logsIntervalMs: DEFAULT_LOGS_INTERVAL_MS,
  });
});

test('resolveOptions：--once / --no-logs / 间隔与 --help', () => {
  const opts = resolveOptions([
    '--once',
    '--no-logs',
    '--spend-interval-ms=1800000',
    '--logs-interval-ms=7200000',
  ]);
  assert.equal(opts.once, true);
  assert.equal(opts.noLogs, true);
  assert.equal(opts.spendIntervalMs, 1_800_000);
  assert.equal(opts.logsIntervalMs, 7_200_000);
  assert.equal(resolveOptions(['--help']).help, true);
  assert.equal(resolveOptions(['-h']).help, true);
});

test('resolveOptions：非法间隔与未知参数报错', () => {
  assert.throws(() => resolveOptions(['--spend-interval-ms=-1']), /spend-interval-ms/);
  assert.throws(() => resolveOptions(['--spend-interval-ms=0']), /spend-interval-ms/);
  assert.throws(() => resolveOptions(['--logs-interval-ms=abc']), /logs-interval-ms/);
  assert.throws(() => resolveOptions(['--logs-interval-ms=1.5']), /logs-interval-ms/);
  assert.throws(() => resolveOptions(['--spend-interval-ms=99999999999999']), /spend-interval-ms/);
  assert.throws(() => resolveOptions(['--bogus']), /未知参数/);
});

test('computeInitialDelayMs：对齐 15 分钟网格 + 10 秒，不等下一整点', () => {
  const base = Date.UTC(2026, 0, 15, 2, 28, 59);
  // 02:28:59 → 02:30:10，只等 71 秒；按整点对齐会等到 03:00:10，白丢半小时
  assert.equal(computeInitialDelayMs(base, 15 * 60 * 1000), 71_000);
  // 恰好在槽位上：跳到下一个槽位，不返回 0
  assert.equal(computeInitialDelayMs(Date.UTC(2026, 0, 15, 2, 30, 10), 15 * 60 * 1000), 15 * 60 * 1000);
  // 槽位前 1 秒：1 秒后到期，但最小延迟 1000ms 仍成立
  assert.equal(computeInitialDelayMs(Date.UTC(2026, 0, 15, 2, 30, 9, 0), 15 * 60 * 1000), 1000);
  // 跨日、跨月都落在网格上
  assert.equal(computeInitialDelayMs(Date.UTC(2026, 0, 31, 23, 59, 59), 15 * 60 * 1000), 11_000);
  // 默认间隔 15 分钟，与调度器一致
  assert.equal(computeInitialDelayMs(base), computeInitialDelayMs(base, 15 * 60 * 1000));
});

test('nextSlotDelayMs：任意间隔与偏移都对得上网格', () => {
  const now = Date.UTC(2026, 0, 15, 2, 28, 59);
  assert.equal(nextSlotDelayMs(now, 15 * 60 * 1000, 45_000), 106_000); // 02:30:45
  assert.equal(nextSlotDelayMs(now, 60 * 60 * 1000, 10_000), 1_871_000); // 03:00:10
  // 非法间隔退回 15 分钟网格
  assert.equal(nextSlotDelayMs(now, 0, 10_000), nextSlotDelayMs(now, 15 * 60 * 1000, 10_000));
});

test('shouldRunNow：运行中跳过，未到期不跑，到期才跑', () => {
  assert.deepEqual(shouldRunNow({ running: true }), { run: false, reason: 'already_running' });
  assert.deepEqual(shouldRunNow({ running: false, nowMs: 10, dueAtMs: 20 }), {
    run: false,
    reason: 'not_due',
  });
  assert.deepEqual(shouldRunNow({ running: false, nowMs: 20, dueAtMs: 20 }), {
    run: true,
    reason: 'due',
  });
});

test('--once：各任务各跑一次，成功退出码为 0', async () => {
  const calls = [];
  const lines = [];
  const result = await runOnce({
    tasks: [
      {
        name: TASK_SPEND,
        run: async () => {
          calls.push('spend');
          return { status: 'ok' };
        },
      },
      {
        name: TASK_LOGS,
        run: async () => {
          calls.push('logs');
          return { status: 'ok' };
        },
      },
    ],
    now: () => 1000,
    log: (line) => lines.push(line),
    errorLog: (line) => lines.push(line),
  });

  assert.deepEqual(calls, ['spend', 'logs']);
  assert.equal(result.failed, 0);
  assert.deepEqual(lines, [
    `[run-scheduler] ${TASK_SPEND} ok 0ms`,
    `[run-scheduler] ${TASK_LOGS} ok 0ms`,
  ]);
});

test('--no-logs：只挑余额任务', async () => {
  const options = resolveOptions(['--once', '--no-logs']);
  const calls = [];
  const tasks = {
    spend: async () => {
      calls.push('spend');
      return { status: 'ok' };
    },
    logs: async () => {
      calls.push('logs');
      return { status: 'ok' };
    },
  };

  const picked = pickTasks({ options, tasks });
  assert.deepEqual(picked.map((t) => t.name), [TASK_SPEND]);

  await runOnce({ tasks: picked, log: () => {}, errorLog: () => {} });
  assert.deepEqual(calls, ['spend']);
});

test('防重入：上一轮未结束时跳过本次，不重复调用 run', async () => {
  let release;
  let calls = 0;
  const lines = [];
  const runner = createTaskRunner({
    name: TASK_SPEND,
    run: () => {
      calls += 1;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    now: () => 0,
    log: (line) => lines.push(line),
    errorLog: (line) => lines.push(line),
  });

  const first = runner.execute();
  const second = await runner.execute();
  assert.equal(second.ran, false);
  assert.equal(second.skipped, true);
  assert.equal(second.reason, 'already_running');
  assert.equal(calls, 1);
  assert.equal(lines.filter((l) => l.includes('skipped')).length, 1);
  assert.equal(runner.running, true);

  release({ status: 'ok' });
  await first;
  assert.equal(runner.running, false);
  assert.equal(lines.filter((l) => l.includes(' ok ')).length, 1);
});

test('某任务抛错：不影响另一个任务，也不向外抛', async () => {
  const calls = [];
  const out = [];
  const errs = [];
  let clock = 0;

  const result = await runOnce({
    tasks: [
      {
        name: TASK_SPEND,
        run: async () => {
          calls.push('spend');
          throw new Error('boom sk-abcdefghijkl');
        },
      },
      {
        name: TASK_LOGS,
        run: async () => {
          calls.push('logs');
          return { status: 'ok' };
        },
      },
    ],
    now: () => (clock += 5),
    log: (line) => out.push(line),
    errorLog: (line) => errs.push(line),
  });

  assert.deepEqual(calls, ['spend', 'logs']);
  assert.equal(result.failed, 1);
  assert.equal(result.results[0].failed, true);
  assert.equal(result.results[0].elapsedMs, 5);
  assert.equal(result.results[1].status, 'ok');
  assert.equal(errs.length, 1);
  assert.match(errs[0], new RegExp(`^\\[run-scheduler\\] ${TASK_SPEND} failed 5ms: boom sk-\\*\\*\\*$`));
  assert.equal(out.length, 1);
});

test('输出行：不含凭据字段与日志原文', async () => {
  const lines = [];
  const secret = 'sk-live1234567890abcdef';
  const log = (line) => lines.push(line);

  await runOnce({
    tasks: [
      { name: TASK_SPEND, run: async () => ({ status: 'ok' }) },
      {
        name: TASK_LOGS,
        run: async () => {
          throw new Error(`token=${secret} cookie: session=abc123 Authorization: Bearer abcdefghijkl`);
        },
      },
    ],
    now: () => 0,
    log,
    errorLog: log,
  });

  const text = lines.join('\n');
  assert.ok(!text.includes(secret), '不能输出 sk- token');
  assert.ok(!text.includes('session=abc123'), '不能输出 cookie 原文');
  assert.ok(!text.includes('Bearer abcdefghijkl'), '不能输出 bearer 原文');
  assert.ok(!/\b(token|cookie|authorization)\s*[=:]\s*(?!\*\*\*)\S/i.test(text), '凭据字段值必须脱敏');
  assert.match(text, /failed 0ms: token=\*\*\*/);

  // 成功行只含任务名、状态、耗时
  assert.match(lines[0], /^\[run-scheduler\] collect-spend ok 0ms$/);
});

test('redactMessage：空值、超长与裸 JWT', () => {
  assert.equal(redactMessage(undefined), '');
  assert.equal(redactMessage('plain error'), 'plain error');
  assert.equal(redactMessage('x'.repeat(500)).length, 300);
  assert.equal(redactMessage('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijkl'), '***');
});

test('常驻定时链：余额首轮对齐槽位，触发后按间隔重复', async () => {
  const timer = makeFakeTimer();
  const lines = [];
  const runner = createTaskRunner({
    name: TASK_SPEND,
    run: async () => ({ status: 'ok' }),
    now: () => 0,
    log: (line) => lines.push(line),
    errorLog: (line) => lines.push(line),
  });

  const nowMs = Date.UTC(2026, 0, 15, 10, 30, 0);
  const loop = createLoop({
    delayMs: computeInitialDelayMs(nowMs),
    intervalMs: 60_000,
    task: runner,
    timer,
  });
  loop.start();

  assert.equal(loop.scheduled, true);
  assert.equal(timer.timeouts.length, 1);
  assert.equal(timer.timeouts[0].ms, computeInitialDelayMs(nowMs));
  assert.equal(timer.timeouts[0].ms, 10_000);
  assert.equal(timer.intervals.length, 0);

  timer.timeouts[0].fn();
  await flush();
  assert.equal(timer.intervals.length, 1);
  assert.equal(timer.intervals[0].ms, 60_000);
  assert.equal(lines.filter((l) => l.includes(' ok ')).length, 1);

  loop.stop();
  assert.equal(loop.scheduled, false);
  assert.equal(timer.intervals[0].cleared, true);
  assert.equal(timer.timeouts[0].cleared, false, '已触发的 timeout 不再清理');
});

test('站点日志对齐槽位 +45 秒、默认间隔 15 分钟', () => {
  assert.equal(LOGS_ALIGN_MS, 35_000);
  assert.equal(DEFAULT_LOGS_INTERVAL_MS, 15 * 60 * 1000);

  // 10:07:56 启动 → 10:15:45（槽位 +45s）= 469,000ms；按整点对齐会白等到 11:00
  const base = Date.UTC(2026, 10, 2, 10, 7, 56);
  const delayMs = nextSlotDelayMs(base, DEFAULT_LOGS_INTERVAL_MS, SPEND_ALIGN_MS + LOGS_ALIGN_MS);
  assert.equal(delayMs, 469_000);

  const timer = makeFakeTimer();
  const loop = createLoop({
    delayMs,
    intervalMs: DEFAULT_LOGS_INTERVAL_MS,
    task: { execute: async () => ({ ran: true }) },
    timer,
  }).start();
  assert.equal(timer.timeouts[0].ms, 469_000);
  timer.timeouts[0].fn();
  assert.equal(timer.intervals[0].ms, 900_000);
  loop.stop();
});

test('stop 后重复 start 可重新挂上定时器', () => {
  const timer = makeFakeTimer();
  const loop = createLoop({
    delayMs: 1000,
    intervalMs: 2000,
    task: { execute: async () => ({ ran: true }) },
    timer,
  });
  loop.start();
  loop.stop();
  assert.equal(loop.scheduled, false);
  loop.start();
  assert.equal(loop.scheduled, true);
  assert.equal(timer.timeouts.length, 2);
  loop.stop();
});

test('createLoop：传 nextDelayMs 时每轮按墙钟重算，不再用 setInterval（防主机挂起后相位漂移）', async () => {
  const timer = makeFakeTimer();
  let runs = 0;
  const planned = [900_000, 15_000];
  const loop = createLoop({
    delayMs: 10_000,
    intervalMs: 900_000,
    task: {
      async execute() {
        runs += 1;
      },
    },
    timer,
    nextDelayMs: () => planned[Math.min(runs - 1, planned.length - 1)],
  }).start();

  assert.equal(timer.timeouts.length, 1);
  assert.equal(timer.timeouts[0].ms, 10_000);

  await timer.timeouts[0].fn();
  assert.equal(runs, 1);
  assert.equal(timer.intervals.length, 0, '自校正模式不应创建 setInterval');
  assert.equal(timer.timeouts.length, 2);
  assert.equal(timer.timeouts[1].ms, 900_000);

  await timer.timeouts[1].fn();
  assert.equal(runs, 2);
  assert.equal(timer.timeouts.length, 3);
  assert.equal(timer.timeouts[2].ms, 15_000, '延迟来自 nextDelayMs，不是固定 intervalMs');

  loop.stop();
  assert.equal(timer.timeouts[2].cleared, true);
  assert.equal(loop.scheduled, false);
});
