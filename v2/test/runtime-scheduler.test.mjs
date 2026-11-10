import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  COLLECTOR_HEARTBEAT_MS,
  createCollectionScheduler,
  pickTasks,
  resolveOptions,
  RUNTIME_SETTINGS_POLL_MS,
  runOnce,
} from '../jobs/run-scheduler.mjs';
import { createRuntimeSettingsStore } from '../lib/runtime-settings.mjs';

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

function fakeClock(initial = 60_000) {
  let nowMs = initial;
  const pending = new Set();
  const history = [];
  const add = (kind, fn, ms) => {
    const handle = { kind, fn, ms, at: nowMs + ms };
    pending.add(handle);
    history.push(handle);
    return handle;
  };
  return {
    now: () => nowMs,
    history,
    pending: (kind) => [...pending].filter((entry) => !kind || entry.kind === kind),
    setTimeout: (fn, ms) => add('timeout', fn, ms),
    clearTimeout: (handle) => pending.delete(handle),
    setInterval: (fn, ms) => add('interval', fn, ms),
    clearInterval: (handle) => pending.delete(handle),
    async advance(ms) {
      const until = nowMs + ms;
      let count = 0;
      while (true) {
        const next = [...pending].filter((entry) => entry.at <= until)
          .sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        assert.ok(count++ < 1000, '假时钟出现定时器空转');
        nowMs = next.at;
        if (next.kind === 'interval') next.at += next.ms;
        else pending.delete(next);
        void next.fn();
        await flush();
      }
      nowMs = until;
      await flush();
    },
  };
}

function harness(t, {
  argv = [],
  initial = 60_000,
  logsMinutes = 5,
  spendMinutes = 5,
  tasks = { spend: async () => {}, logs: async () => {} },
  store: externalStore,
} = {}) {
  const clock = fakeClock(initial);
  const statuses = [];
  const errors = [];
  const lines = [];
  let snapshot = { revision: 'initial', settings: { collection: { logsMinutes, spendMinutes } } };
  let readError = null;
  let writeError = null;
  let listener = null;
  let oldListener = null;
  let watchCount = 0;
  let unwatchCount = 0;
  const store = externalStore ?? {
    path: '/fake/runtime-settings.json',
    read() {
      if (readError) throw readError;
      return snapshot;
    },
    writeCollectorStatus(status) {
      if (writeError) throw writeError;
      statuses.push(structuredClone(status));
    },
  };
  const options = resolveOptions(argv);
  const scheduler = createCollectionScheduler({
    argv, options, tasks, store, now: clock.now, timer: clock,
    log: (line) => lines.push(line),
    errorLog: (line) => errors.push(line),
    watchFile(file, config, callback) {
      assert.equal(file, store.path);
      assert.equal(config.interval, RUNTIME_SETTINGS_POLL_MS);
      watchCount += 1;
      listener = callback;
      oldListener = callback;
    },
    unwatchFile(file, callback) {
      assert.equal(file, store.path);
      assert.equal(callback, listener);
      unwatchCount += 1;
      listener = null;
    },
  });
  t.after(() => scheduler.stop());
  return {
    clock, statuses, errors, lines, scheduler, store, tasks, options,
    get watchCount() { return watchCount; },
    get unwatchCount() { return unwatchCount; },
    notify() { listener?.(); },
    notifyAfterStop() { oldListener?.(); },
    update(collection, revision = 'changed') {
      snapshot = { settings: { collection }, revision };
      listener?.();
    },
    failRead(error) { readError = error; },
    failWrite(error) { writeError = error; },
  };
}

test('运行时调度：缺少持久化配置时采用实例默认值，并通过真实 store 写入状态', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-runtime-scheduler-'));
  const store = createRuntimeSettingsStore({
    dataDir: dir,
    collectionDefaults: { logsMinutes: 2, spendMinutes: 3 },
  });
  const h = harness(t, { store });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  h.scheduler.start();
  assert.deepEqual(h.scheduler.intervals, { logsIntervalMs: 120_000, spendIntervalMs: 180_000 });
  assert.deepEqual(h.clock.pending('timeout').map((entry) => entry.at), [190_000, 165_000]);
  const status = JSON.parse(fs.readFileSync(store.statusPath, 'utf8'));
  assert.deepEqual(status.effective, { logsMinutes: 2, spendMinutes: 3 });
  assert.equal(status.observedRevision, store.read().revision);
  assert.equal(status.updatedAt, 60_000);
  assert.deepEqual(status.overrides, { logs: false, spend: false });
  assert.equal(status.logsEnabled, true);
});

test('运行时调度：启动采用持久化值，只重排变化的 pending loop；无变化与仅版本变化不重排', async (t) => {
  const calls = [];
  const h = harness(t, {
    tasks: { spend: async () => calls.push('spend'), logs: async () => calls.push('logs') },
  });
  h.scheduler.start();
  const [spend, logs] = h.clock.pending('timeout');
  assert.deepEqual([spend.at, logs.at], [310_000, 345_000]);
  assert.deepEqual(h.statuses[0].effective, { logsMinutes: 5, spendMinutes: 5 });
  const timerCount = h.clock.history.length;
  h.notify();
  assert.equal(h.clock.history.length, timerCount);
  assert.equal(h.statuses.length, 1);
  h.update({ logsMinutes: 5, spendMinutes: 5 }, 'monitoring-only');
  assert.equal(h.clock.history.length, timerCount);
  assert.equal(h.statuses.at(-1).observedRevision, 'monitoring-only');
  h.update({ logsMinutes: 5, spendMinutes: 3 }, 'spend-change');
  assert.ok(h.clock.pending().includes(logs), '日志配置未变，不动日志 pending timer');
  assert.ok(!h.clock.pending().includes(spend), '清理余额原来的 pending timer');
  assert.deepEqual(h.clock.pending('timeout').map((entry) => entry.at).sort(), [190_000, 345_000]);
  h.update({ logsMinutes: 2, spendMinutes: 3 });
  assert.ok(!h.clock.pending().includes(logs));
  assert.deepEqual(h.clock.pending('timeout').map((entry) => entry.at).sort(), [165_000, 190_000]);
  assert.equal(h.watchCount, 1, '修改配置不重建 watcher');
  await h.clock.advance(130_000);
  assert.deepEqual(calls, ['logs', 'spend']);
  assert.equal(h.clock.pending('interval').length, 1, '只有心跳使用 interval');
});

test('运行时调度：任务执行中修改间隔不重入，完成后使用新槽位', async (t) => {
  let release;
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const h = harness(t, {
    initial: 0,
    spendMinutes: 1,
    tasks: {
      spend: async () => {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => { release = resolve; });
        active -= 1;
      },
      logs: async () => {},
    },
  });
  h.scheduler.start();
  await h.clock.advance(10_000);
  assert.equal(calls, 1);
  h.update({ logsMinutes: 5, spendMinutes: 3 });
  await h.clock.advance(180_000);
  assert.equal(calls, 1, '跨过新旧槽位都不启动第二轮');
  assert.equal(maxActive, 1);
  release();
  await flush();
  assert.ok(h.clock.pending('timeout').some((entry) => entry.at === 370_000));
  await h.clock.advance(180_000);
  assert.equal(calls, 2);
  assert.equal(maxActive, 1);
  h.scheduler.stop();
  release();
  await flush();
  assert.equal(h.clock.pending().length, 0, '停止后在途任务完成也不再挂 timer');
});

test('运行时调度：与默认值相同的 CLI 显式参数仍覆盖设置，状态说明实际间隔', async (t) => {
  let calls = 0;
  const h = harness(t, {
    argv: ['--spend-interval-ms=900000'],
    spendMinutes: 1,
    logsMinutes: 2,
    tasks: { spend: async () => { calls += 1; }, logs: async () => {} },
  });
  h.scheduler.start();
  const spendTimer = h.clock.pending('timeout')[0];
  assert.equal(spendTimer.at, 910_000);
  h.update({ logsMinutes: 4, spendMinutes: 3 });
  assert.ok(h.clock.pending().includes(spendTimer));
  assert.deepEqual(h.statuses.at(-1), {
    observedRevision: 'changed', updatedAt: 60_000,
    effective: { logsMinutes: 4, spendMinutes: 15 },
    overrides: { logs: false, spend: true }, logsEnabled: true,
  });
  await h.clock.advance(850_000);
  assert.equal(calls, 1);
  assert.ok(h.clock.pending('timeout').some((entry) => entry.at === 1_810_000));
});

test('运行时调度：CLI 可同时覆盖日志及余额，并允许毫秒间隔换算成小数分钟', (t) => {
  const h = harness(t, { argv: ['--spend-interval-ms=30000', '--logs-interval-ms=90000'] });
  h.scheduler.start();
  h.update({ logsMinutes: 2, spendMinutes: 3 });
  assert.deepEqual(h.statuses.at(-1).effective, { logsMinutes: 1.5, spendMinutes: 0.5 });
  assert.deepEqual(h.statuses.at(-1).overrides, { logs: true, spend: true });
  assert.deepEqual(h.scheduler.intervals, { spendIntervalMs: 30_000, logsIntervalMs: 90_000 });
});

test('运行时调度：--no-logs 不挂日志 loop，状态保留关闭信息', async (t) => {
  const calls = [];
  const h = harness(t, {
    argv: ['--no-logs'], initial: 0, spendMinutes: 1,
    tasks: { spend: async () => calls.push('spend'), logs: async () => calls.push('logs') },
  });
  h.scheduler.start();
  assert.equal(h.clock.pending('timeout').length, 1);
  assert.equal(h.statuses.at(-1).logsEnabled, false);
  h.update({ logsMinutes: 2, spendMinutes: 1 });
  await h.clock.advance(70_000);
  assert.deepEqual(calls, ['spend', 'spend']);
  assert.equal(h.clock.pending('timeout').length, 1);
  assert.equal(h.statuses.at(-1).logsEnabled, false);
});

test('运行时调度：--once 各跑一次，不写状态、不声称采用常驻设置、不创建 watcher 或 timer', async (t) => {
  for (const noLogs of [false, true]) {
    const calls = [];
    const h = harness(t, {
      argv: ['--once', ...(noLogs ? ['--no-logs'] : [])],
      tasks: { spend: async () => calls.push('spend'), logs: async () => calls.push('logs') },
    });
    h.scheduler.start();
    const result = await runOnce({
      tasks: pickTasks({ options: h.options, tasks: h.tasks }),
      now: h.clock.now, log: (line) => h.lines.push(line), errorLog: (line) => h.errors.push(line),
    });
    assert.equal(result.failed, 0);
    assert.deepEqual(calls, noLogs ? ['spend'] : ['spend', 'logs']);
    assert.equal(h.clock.history.length, 0);
    assert.equal(h.watchCount, 0);
    assert.equal(h.statuses.length, 0);
    assert.equal(h.lines.some((line) => line.includes('已采用运行时设置')), false);
    assert.equal(h.lines.filter((line) => /collect-spend ok 0ms$/.test(line)).length, 1);
    assert.equal(h.lines.filter((line) => /collect-site-logs ok 0ms$/.test(line)).length, noLogs ? 0 : 1);
    await h.clock.advance(COLLECTOR_HEARTBEAT_MS * 4);
    assert.equal(h.statuses.length, 0, '超过心跳周期仍不写状态');
  }
});

test('运行时调度：--once 不触碰真实 store 中已有的 CLI 覆盖和日志关闭状态', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-runtime-scheduler-once-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createRuntimeSettingsStore({ dataDir: dir });
  const previousStatus = {
    observedRevision: 'resident-collector-revision', updatedAt: 55_000,
    effective: { logsMinutes: 12.5, spendMinutes: 37.5 },
    overrides: { logs: true, spend: true }, logsEnabled: false,
  };
  store.writeCollectorStatus(previousStatus);
  const previousBytes = fs.readFileSync(store.statusPath);
  const previousStat = fs.statSync(store.statusPath, { bigint: true });
  let statusWrites = 0;
  let settingsReads = 0;
  const onceStore = {
    ...store,
    read() { settingsReads += 1; return store.read(); },
    writeCollectorStatus(status) {
      statusWrites += 1;
      return store.writeCollectorStatus(status);
    },
  };
  for (const argv of [['--once'], ['--once', '--no-logs', '--spend-interval-ms=30000']]) {
    const h = harness(t, { argv, store: onceStore });
    h.scheduler.start();
    await runOnce({
      tasks: pickTasks({ options: h.options, tasks: h.tasks }),
      now: h.clock.now, log: () => {}, errorLog: () => {},
    });
    await h.clock.advance(COLLECTOR_HEARTBEAT_MS * 4);
    h.scheduler.stop();
    assert.equal(statusWrites, 0, '一次性采集不能调用状态 writer');
    assert.deepEqual(fs.readFileSync(store.statusPath), previousBytes);
    const afterStat = fs.statSync(store.statusPath, { bigint: true });
    assert.equal(afterStat.mtimeNs, previousStat.mtimeNs);
    assert.equal(afterStat.ino, previousStat.ino);
    assert.equal(h.clock.history.length, 0);
    assert.equal(h.watchCount, 0);
    assert.equal(h.unwatchCount, 0);
    assert.equal(h.lines.some((line) => line.includes('已采用运行时设置')), false);
  }
  assert.equal(settingsReads, 2, '每次一次性启动仍读取运行时配置');
});

test('运行时调度：--once 不创建缺失的真实采集器状态文件', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-runtime-scheduler-once-empty-'));
  const store = createRuntimeSettingsStore({ dataDir: dir });
  const h = harness(t, { argv: ['--once'], store });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  h.scheduler.start();
  assert.equal(fs.existsSync(store.statusPath), false);
  assert.equal(h.clock.history.length, 0);
  assert.equal(h.watchCount, 0);
});

test('运行时调度：损坏设置保留最近有效值与版本，错误可见，恢复后继续采用', async (t) => {
  const h = harness(t);
  h.scheduler.start();
  const pending = h.clock.pending();
  h.failRead(new SyntaxError('非法 JSON'));
  h.notify();
  assert.deepEqual(h.scheduler.intervals, { spendIntervalMs: 300_000, logsIntervalMs: 300_000 });
  assert.deepEqual(h.clock.pending(), pending);
  assert.equal(h.statuses.at(-1).observedRevision, 'initial');
  assert.match(h.errors[0], /读取运行时设置失败.*保留最近有效.*非法 JSON/);
  await h.clock.advance(COLLECTOR_HEARTBEAT_MS);
  assert.equal(h.statuses.at(-1).observedRevision, 'initial');
  assert.equal(h.statuses.at(-1).updatedAt, 90_000);
  h.failRead(null);
  h.update({ logsMinutes: 2, spendMinutes: 3 }, 'repaired');
  assert.equal(h.statuses.at(-1).observedRevision, 'repaired');
  assert.deepEqual(h.statuses.at(-1).effective, { logsMinutes: 2, spendMinutes: 3 });
});

test('运行时调度：启动文件损坏时明确失败，不伪装为默认配置成功启动', (t) => {
  const h = harness(t);
  h.failRead(new SyntaxError('非法 JSON'));
  assert.throws(() => h.scheduler.start(), /非法 JSON/);
  assert.match(h.errors[0], /读取运行时设置失败/);
  assert.equal(h.statuses.length, 0);
  assert.equal(h.clock.history.length, 0);
  assert.equal(h.watchCount, 0);
});

test('运行时调度：心跳每 30 秒报告实际间隔，写入失败明确报错', async (t) => {
  const h = harness(t);
  h.scheduler.start();
  await h.clock.advance(COLLECTOR_HEARTBEAT_MS * 2);
  assert.deepEqual(h.statuses.map((status) => status.updatedAt), [60_000, 90_000, 120_000]);
  h.failWrite(new Error('status write failed'));
  await h.clock.advance(COLLECTOR_HEARTBEAT_MS);
  assert.match(h.errors.at(-1), /写入采集器设置状态失败.*status write failed/);
  assert.equal(h.clock.pending('interval').length, 1);
});

test('运行时调度：停止清理全部 timer 与 watcher，迟到的文件通知不起作用', async (t) => {
  const h = harness(t);
  h.scheduler.start();
  assert.equal(h.clock.pending().length, 3);
  h.scheduler.stop();
  h.scheduler.stop();
  assert.equal(h.clock.pending().length, 0);
  assert.equal(h.unwatchCount, 1);
  const statusCount = h.statuses.length;
  h.notifyAfterStop();
  await h.clock.advance(600_000);
  assert.equal(h.statuses.length, statusCount);
  assert.equal(h.clock.pending().length, 0);
});
