/**
 * prune-logs 单测：只清过期 raw_json、幂等、dry-run、job_runs 按天删、SQLITE_BUSY 重试、
 * 输出不含日志内容、vacuum 体积回收，以及调度侧的首轮延迟与日志行。
 * 全部用临时 sqlite，不连站点、不碰仓库里的真实库。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  DEFAULT_JOBS_DAYS,
  DEFAULT_RAW_DAYS,
  isBusyError,
  main,
  parseArgs,
  runPrune,
  withBusyRetry,
} from '../jobs/prune-logs.mjs';
import { INSTANCE } from '../lib/instance.mjs';
import {
  createLoop,
  createTaskRunner,
  DEFAULT_PRUNE_INTERVAL_MS,
  PRUNE_INITIAL_DELAY_MS,
  splitPruneArgs,
  TASK_PRUNE,
} from '../jobs/run-scheduler.mjs';
import { LOGS_SCHEMA } from '../store/site-logs.mjs';
import { openDashboardDb } from '../store/dashboard.mjs';
import { makeTempDir } from './helpers/fixture.mjs';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);

function makeLogsDb(file, rows, { nullable = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(
    nullable ? LOGS_SCHEMA.replace(/raw_json\s+TEXT\s+NOT NULL/, 'raw_json TEXT') : LOGS_SCHEMA,
  );
  const ins = db.prepare(
    `INSERT INTO logs (req_id, site, source_kind, input_format, t_ms, t_local,
                       channel_id, channel_name, cost, output, raw_json)
     VALUES (?, 'relay', 'api', 'openai', ?, '2026-11-02 12:00:00', ?, ?, ?, 10, ?)`,
  );
  for (const row of rows) {
    ins.run(
      row.req_id,
      row.t_ms,
      row.channel_id ?? 13,
      row.channel_name ?? '渠道一',
      row.cost ?? 0.01,
      row.raw_json,
    );
  }
  db.close();
  return file;
}

function makeJobsDb(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = openDashboardDb(file);
  const ins = db.prepare(
    'INSERT INTO job_runs (job, started_at, finished_at, status, detail) VALUES (?, ?, ?, ?, ?)',
  );
  for (const row of rows) {
    ins.run(row.job ?? 'collect-spend', row.started_at, row.started_at + 1000, 'ok', 'detail');
  }
  db.close();
  return file;
}

function query(file, sql, ...params) {
  const db = new DatabaseSync(file);
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

function readRaw(file, reqId) {
  return query(file, 'SELECT raw_json FROM logs WHERE req_id = ?', reqId)[0]?.raw_json;
}

function silent() {
  const lines = [];
  return { lines, log: (line) => lines.push(line) };
}

test('parseArgs：默认值按仓库结构推导', () => {
  const opts = parseArgs([]);
  assert.equal(opts.rawDays, DEFAULT_RAW_DAYS);
  assert.equal(opts.jobsDays, DEFAULT_JOBS_DAYS);
  assert.equal(DEFAULT_RAW_DAYS, 7);
  assert.equal(DEFAULT_JOBS_DAYS, 30);
  assert.equal(opts.dryRun, false);
  assert.equal(opts.vacuum, false);
  assert.equal(opts.dbFile, INSTANCE.paths.siteDbFile);
  assert.equal(opts.jobsDbFile, INSTANCE.paths.dashboardFile);
});

test('parseArgs：参数组合、相对路径与非法值', () => {
  const opts = parseArgs([
    '--db=tmp/x.db',
    '--raw-days=3',
    '--jobs-days=0',
    '--dry-run',
    '--vacuum',
  ]);
  assert.equal(opts.dbFile, path.resolve('tmp/x.db'));
  assert.equal(opts.rawDays, 3);
  assert.equal(opts.jobsDays, 0);
  assert.equal(opts.dryRun, true);
  assert.equal(opts.vacuum, true);

  for (const arg of ['--raw-days=-1', '--raw-days=abc', '--jobs-days=1.5', '--bogus', '--db=']) {
    assert.throws(() => parseArgs([arg]), /raw-days|jobs-days|未知参数|不能为空/, arg);
  }

  const out = [];
  assert.equal(main(['--help'], { log: (l) => out.push(l) }), 0);
  assert.match(out.join('\n'), /--raw-days/);
  assert.equal(main(['--bogus'], { log: () => {}, errorLog: () => {} }), 1);
});

test('只清过期 raw_json：未过期不动，其余列与行数不变', () => {
  const dir = makeTempDir('prune-test-');
  const dbFile = makeLogsDb(path.join(dir, 'sites', 'relay.db'), [
    { req_id: 'old-8d', t_ms: NOW - 8 * DAY, raw_json: 'OLD-A' },
    { req_id: 'old-10d', t_ms: NOW - 10 * DAY, raw_json: 'OLD-B' },
    { req_id: 'fresh-1d', t_ms: NOW - 1 * DAY, raw_json: 'FRESH' },
    { req_id: 'fp-old', t_ms: NOW - 9 * DAY, raw_json: '' },
  ]);
  const out = silent();

  const result = runPrune({
    dbFile,
    jobsDbFile: path.join(dir, 'missing.db'),
    rawDays: 7,
    now: NOW,
    log: out.log,
  });

  assert.equal(result.rawRows, 2);
  assert.equal(result.rawBytes, 10);
  assert.equal(result.rawTarget, "''", 'NOT NULL 列写空串');
  assert.equal(readRaw(dbFile, 'old-8d'), '');
  assert.equal(readRaw(dbFile, 'old-10d'), '');
  assert.equal(readRaw(dbFile, 'fresh-1d'), 'FRESH');
  assert.equal(readRaw(dbFile, 'fp-old'), '');
  assert.equal(query(dbFile, 'SELECT COUNT(*) AS n FROM logs')[0].n, 4);
  const row = query(dbFile, 'SELECT channel_id, channel_name, cost FROM logs WHERE req_id = ?', 'old-8d')[0];
  assert.deepEqual({ ...row }, { channel_id: 13, channel_name: '渠道一', cost: 0.01 });
  assert.match(out.lines[0], /^\[prune-logs\] raw_json 清空 2 行（释放约 [\d.]+ MB）/);
});

test('raw_json 可空时写 NULL', () => {
  const dir = makeTempDir('prune-test-');
  const dbFile = makeLogsDb(
    path.join(dir, 'sites', 'relay.db'),
    [{ req_id: 'old', t_ms: NOW - 9 * DAY, raw_json: 'OLD' }],
    { nullable: true },
  );

  const result = runPrune({
    dbFile,
    jobsDbFile: path.join(dir, 'missing.db'),
    now: NOW,
    log: () => {},
  });

  assert.equal(result.rawTarget, 'NULL');
  assert.equal(readRaw(dbFile, 'old'), null);
});

test('幂等：重复跑第二次影响 0 行', () => {
  const dir = makeTempDir('prune-test-');
  const dbFile = makeLogsDb(path.join(dir, 'sites', 'relay.db'), [
    { req_id: 'old', t_ms: NOW - 30 * DAY, raw_json: 'OLD' },
  ]);
  const jobsDbFile = makeJobsDb(path.join(dir, 'dashboard.db'), [
    { started_at: NOW - 40 * DAY },
  ]);

  const first = runPrune({ dbFile, jobsDbFile, now: NOW, log: () => {} });
  const second = runPrune({ dbFile, jobsDbFile, now: NOW, log: () => {} });

  assert.equal(first.rawRows, 1);
  assert.equal(first.jobRows, 1);
  assert.equal(second.rawRows, 0);
  assert.equal(second.jobRows, 0);
  assert.equal(second.rawBytes, 0);
});

test('dry-run：只统计，不改库、不 vacuum', () => {
  const dir = makeTempDir('prune-test-');
  const dbFile = makeLogsDb(path.join(dir, 'sites', 'relay.db'), [
    { req_id: 'old', t_ms: NOW - 20 * DAY, raw_json: 'KEEP-ME-UNTIL-REAL-RUN' },
  ]);
  const jobsDbFile = makeJobsDb(path.join(dir, 'dashboard.db'), [
    { started_at: NOW - 60 * DAY },
  ]);
  const out = silent();

  const result = runPrune({
    dbFile,
    jobsDbFile,
    dryRun: true,
    vacuum: true,
    now: NOW,
    log: out.log,
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.rawRows, 1);
  assert.equal(result.rawBytes, 'KEEP-ME-UNTIL-REAL-RUN'.length);
  assert.equal(result.jobRows, 1);
  assert.equal(result.vacuum, null);
  assert.equal(readRaw(dbFile, 'old'), 'KEEP-ME-UNTIL-REAL-RUN');
  assert.equal(query(jobsDbFile, 'SELECT COUNT(*) AS n FROM job_runs')[0].n, 1);
  assert.match(out.lines[0], /^\[prune-logs\] dry-run：raw_json 将清空 1 行/);
});

test('now 传函数（CLI 默认）时按调用取值', () => {
  const dir = makeTempDir('prune-test-');
  const dbFile = makeLogsDb(path.join(dir, 'sites', 'relay.db'), [
    { req_id: 'old', t_ms: NOW - 9 * DAY, raw_json: 'OLD' },
  ]);

  const result = runPrune({
    dbFile,
    jobsDbFile: path.join(dir, 'missing.db'),
    now: () => NOW,
    log: () => {},
  });

  assert.equal(result.rawRows, 1);
  assert.equal(readRaw(dbFile, 'old'), '');
});

test('job_runs 按天删：过界删、边界内留、started_at 为空留', () => {
  const dir = makeTempDir('prune-test-');
  const dbFile = makeLogsDb(path.join(dir, 'sites', 'relay.db'), []);
  const jobsDbFile = makeJobsDb(path.join(dir, 'dashboard.db'), [
    { job: 'old-31d', started_at: NOW - 31 * DAY },
    { job: 'keep-30d', started_at: NOW - 30 * DAY },
    { job: 'keep-29d', started_at: NOW - 29 * DAY },
    { job: 'null-time', started_at: null },
  ]);

  const result = runPrune({ dbFile, jobsDbFile, jobsDays: 30, now: NOW, log: () => {} });

  assert.equal(result.jobRows, 1);
  assert.deepEqual(
    query(jobsDbFile, 'SELECT job FROM job_runs ORDER BY job').map((r) => r.job),
    ['keep-29d', 'keep-30d', 'null-time'],
  );
});

test('看板库不存在时跳过 job_runs，不新建文件', () => {
  const dir = makeTempDir('prune-test-');
  const dbFile = makeLogsDb(path.join(dir, 'sites', 'relay.db'), []);
  const jobsDbFile = path.join(dir, 'no-such', 'dashboard.db');

  const result = runPrune({ dbFile, jobsDbFile, now: NOW, log: () => {} });

  assert.equal(result.jobRows, 0);
  assert.equal(fs.existsSync(jobsDbFile), false);
});

test('输出一行汇总，且不含日志内容与凭据', () => {
  const dir = makeTempDir('prune-test-');
  const secret = 'SECRET-LOG-CONTENT sk-live1234567890abcdef';
  const dbFile = makeLogsDb(path.join(dir, 'sites', 'relay.db'), [
    { req_id: 'old', t_ms: NOW - 9 * DAY, raw_json: secret },
  ]);
  const out = silent();

  runPrune({
    dbFile,
    jobsDbFile: path.join(dir, 'missing.db'),
    now: NOW,
    log: out.log,
    errorLog: out.log,
  });

  const text = out.lines.join('\n');
  assert.equal(out.lines.length, 1);
  assert.ok(!text.includes('SECRET-LOG-CONTENT'), '不能输出日志原文');
  assert.ok(!text.includes('sk-live'), '不能输出凭据');
  assert.match(
    text,
    /^\[prune-logs\] raw_json 清空 1 行（释放约 [\d.]+ MB），job_runs 删除 0 行，耗时 \d+ ms$/,
  );
});

test('withBusyRetry：忙错误重试 2 次后成功，非忙错误不重试', () => {
  const sleeps = [];
  let calls = 0;
  const busy = () => Object.assign(new Error('database is locked'), { errcode: 5 });

  const value = withBusyRetry(
    () => {
      calls += 1;
      if (calls <= 2) throw busy();
      return 'ok';
    },
    { sleep: (ms) => sleeps.push(ms) },
  );

  assert.equal(value, 'ok');
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [500, 1000]);

  let once = 0;
  assert.throws(
    () =>
      withBusyRetry(
        () => {
          once += 1;
          throw new Error('syntax error');
        },
        { sleep: () => {} },
      ),
    /syntax error/,
  );
  assert.equal(once, 1);
});

test('withBusyRetry：重试 3 次仍失败则抛出，退避 500/1000/1500', () => {
  const sleeps = [];
  let calls = 0;
  const err = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });

  assert.throws(
    () =>
      withBusyRetry(
        () => {
          calls += 1;
          throw err;
        },
        { sleep: (ms) => sleeps.push(ms) },
      ),
    /database is locked/,
  );
  assert.equal(calls, 4, '首次 + 重试 3 次');
  assert.deepEqual(sleeps, [500, 1000, 1500]);
  assert.equal(isBusyError(err), true);
  assert.equal(isBusyError(Object.assign(new Error('x'), { errcode: 6 })), true);
  assert.equal(isBusyError(new Error('SQLITE_BUSY: locked')), true);
  assert.equal(isBusyError(new Error('NOT NULL constraint failed')), false);
});

test('真实写锁冲突：重试后退出码 1', () => {
  const dir = makeTempDir('prune-test-');
  const dbFile = makeLogsDb(path.join(dir, 'sites', 'relay.db'), [
    { req_id: 'old', t_ms: NOW - 9 * DAY, raw_json: 'OLD' },
  ]);
  const holder = new DatabaseSync(dbFile);
  holder.exec('BEGIN IMMEDIATE');
  const lines = [];
  try {
    const code = main(['--db=' + dbFile], {
      now: NOW,
      log: (l) => lines.push(l),
      errorLog: (l) => lines.push(l),
      busyTimeoutMs: 10,
      retryBackoffMs: 1,
    });
    assert.equal(code, 1);
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
  }
  assert.match(lines.join('\n'), /\[prune-logs\] 失败：/);
  assert.equal(readRaw(dbFile, 'old'), 'OLD');
});

test('--vacuum：报告耗时与站点库大小前后，并回收空间', () => {
  const dir = makeTempDir('prune-test-');
  const pad = 'x'.repeat(8 * 1024);
  const rows = [];
  for (let i = 0; i < 200; i++) rows.push({ req_id: `old-${i}`, t_ms: NOW - 30 * DAY, raw_json: pad });
  const dbFile = makeLogsDb(path.join(dir, 'sites', 'relay.db'), rows);
  const sizeBefore = fs.statSync(dbFile).size;
  const out = silent();

  const result = runPrune({
    dbFile,
    jobsDbFile: path.join(dir, 'missing.db'),
    vacuum: true,
    now: NOW,
    log: out.log,
  });

  assert.equal(result.rawRows, 200);
  assert.ok(result.vacuum);
  assert.ok(result.vacuum.sizeBefore > 0);
  assert.ok(result.vacuum.sizeAfter < sizeBefore, `VACUUM 后应变小：${result.vacuum.sizeAfter} < ${sizeBefore}`);
  assert.ok(result.vacuum.elapsedMs >= 0);
  assert.match(out.lines.join('\n'), /vacuum \d+ms，站点库 [\d.]+ MB → [\d.]+ MB/);
});

test('schema：logs_daily 建表且为空（只建不写）', () => {
  const dir = makeTempDir('prune-test-');
  const file = path.join(dir, 'dashboard.db');
  const db = openDashboardDb(file);
  const cols = db
    .prepare('PRAGMA table_info(logs_daily)')
    .all()
    .map((c) => c.name);
  const rows = db.prepare('SELECT COUNT(*) AS n FROM logs_daily').get().n;
  db.close();
  assert.deepEqual(cols, [
    'site',
    'day',
    'channel_id',
    'channel_name',
    'requests',
    'cost',
    'quota_raw',
    'input_total',
    'output',
    'updated_at',
  ]);
  assert.equal(rows, 0);
});

test('scheduler：splitPruneArgs 默认与参数解析', () => {
  assert.deepEqual(splitPruneArgs([]), {
    prune: { enabled: true, daysRaw: DEFAULT_RAW_DAYS, daysJobs: DEFAULT_JOBS_DAYS },
    rest: [],
  });

  const parsed = splitPruneArgs(['--once', '--prune-days-raw=3', '--prune-days-jobs=0', '--no-logs']);
  assert.deepEqual(parsed.prune, { enabled: true, daysRaw: 3, daysJobs: 0 });
  assert.deepEqual(parsed.rest, ['--once', '--no-logs']);

  assert.equal(splitPruneArgs(['--no-prune']).prune.enabled, false);
  assert.throws(() => splitPruneArgs(['--prune-days-raw=-1']), /prune-days-raw/);
  assert.throws(() => splitPruneArgs(['--prune-days-jobs=abc']), /prune-days-jobs/);
});

test('scheduler：清理首轮 10 分钟、之后每 24 小时，日志一行 prune ok', async () => {
  assert.equal(TASK_PRUNE, 'prune');
  assert.equal(PRUNE_INITIAL_DELAY_MS, 10 * 60 * 1000);
  assert.equal(DEFAULT_PRUNE_INTERVAL_MS, 24 * 60 * 60 * 1000);

  const timeouts = [];
  const intervals = [];
  const timer = {
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
  const lines = [];
  const runner = createTaskRunner({
    name: TASK_PRUNE,
    run: async () => ({ status: 'ok' }),
    now: () => 0,
    log: (l) => lines.push(l),
    errorLog: (l) => lines.push(l),
  });
  const loop = createLoop({
    delayMs: PRUNE_INITIAL_DELAY_MS,
    intervalMs: DEFAULT_PRUNE_INTERVAL_MS,
    task: runner,
    timer,
  }).start();

  assert.equal(timeouts[0].ms, 600_000);
  timeouts[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(intervals[0].ms, 86_400_000);
  assert.deepEqual(lines, ['[run-scheduler] prune ok 0ms']);
  loop.stop();
  assert.equal(intervals[0].cleared, true);
});
