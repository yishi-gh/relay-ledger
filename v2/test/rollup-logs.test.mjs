/**
 * rollup-logs 单测：按天聚合进 logs_daily、删除该天明细、覆盖式重算幂等、dry-run 不落盘、
 * 过滤口径（log_type / Model test）、channel_id 为空归 0、SQLITE_BUSY 重试、输出不含日志内容、
 * vacuum 体积回收。全部用临时 sqlite，不碰仓库里的真实库。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  DEFAULT_KEEP_DAYS,
  dayStartMs,
  main,
  parseArgs,
  runRollup,
  SITE,
} from '../jobs/rollup-logs.mjs';
import { INSTANCE } from '../lib/instance.mjs';
import { DAY_MS, beijingDayStart, dayKey } from '../lib/time.mjs';
import { LOGS_SCHEMA } from '../store/site-logs.mjs';
import { makeTempDir } from './helpers/fixture.mjs';

const NOW = Date.UTC(2026, 10, 2, 12, 0, 0); // 北京 2026-11-02 20:00
const OLD_DAY = beijingDayStart(NOW) - 100 * DAY_MS; // 早于保留期
const OLD_DAY_2 = beijingDayStart(NOW) - 95 * DAY_MS; // 早于保留期
const FRESH_DAY = beijingDayStart(NOW) - 10 * DAY_MS; // 保留期内

function makeSiteDb(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(LOGS_SCHEMA);
  const ins = db.prepare(
    `INSERT INTO logs (req_id, site, source_kind, input_format, t_ms, t_local, token_name,
                       channel_id, channel_name, cost, quota_raw, input_total, output, log_type, raw_json)
     VALUES (?, 'relay', 'api', 'openai', ?, '2026-11-02 12:00:00', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    ins.run(
      row.req_id,
      row.t_ms,
      row.token_name ?? 't1',
      row.channel_id === undefined ? 13 : row.channel_id,
      row.channel_name ?? '渠道一',
      row.cost ?? 0,
      row.quota_raw ?? 0,
      row.input_total ?? 0,
      row.output ?? 0,
      row.log_type ?? 2,
      row.raw_json ?? '',
    );
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

function dailyRows(file) {
  return query(
    file,
    `SELECT site, day, channel_id, channel_name, requests, cost, quota_raw, input_total, output, updated_at
       FROM logs_daily ORDER BY day, channel_id`,
  ).map((r) => ({ ...r }));
}

function logIds(file) {
  return query(file, 'SELECT req_id FROM logs ORDER BY req_id').map((r) => r.req_id);
}

function silent() {
  const lines = [];
  return { lines, log: (line) => lines.push(line) };
}

/** 两天的归档样本：old 日 5 行（含 1 条系统日志、1 条 Model test），old2 日 1 行 */
function seedRows() {
  return [
    { req_id: 'o1', t_ms: OLD_DAY + 10 * 3600000, channel_id: 13, cost: 1.5, quota_raw: 100, input_total: 10, output: 5 },
    { req_id: 'o2', t_ms: OLD_DAY + 11 * 3600000, channel_id: 13, cost: 2.5, quota_raw: 200, input_total: 20, output: 10 },
    { req_id: 'o3', t_ms: OLD_DAY + 12 * 3600000, channel_id: 14, channel_name: '渠道二', cost: 3, quota_raw: 300, input_total: 30, output: 15 },
    // 非计费日志与测试 token：不进聚合，但随当天明细一起删除
    { req_id: 'o4', t_ms: OLD_DAY + 13 * 3600000, channel_id: 13, cost: 999, log_type: 1 },
    { req_id: 'o5', t_ms: OLD_DAY + 14 * 3600000, channel_id: 13, token_name: 'Model test', cost: 888 },
    { req_id: 'p1', t_ms: OLD_DAY_2 + 9 * 3600000, channel_id: 13, cost: 5, quota_raw: 500, input_total: 50, output: 25 },
    { req_id: 'f1', t_ms: FRESH_DAY + 9 * 3600000, channel_id: 13, cost: 7, quota_raw: 700, input_total: 70, output: 35 },
  ];
}

test('parseArgs：默认值、参数组合与非法值', () => {
  const opts = parseArgs([]);
  assert.equal(opts.keepDays, DEFAULT_KEEP_DAYS);
  assert.equal(DEFAULT_KEEP_DAYS, 90);
  assert.equal(opts.site, SITE);
  assert.equal(opts.dryRun, false);
  assert.equal(opts.vacuum, false);
  assert.equal(opts.dbFile, INSTANCE.paths.siteDbFile);
  assert.equal(opts.dashboardDbFile, INSTANCE.paths.dashboardFile);

  const parsed = parseArgs([
    '--db=tmp/site.db',
    '--dashboard-db=tmp/dash.db',
    '--keep-days=30',
    '--site=other',
    '--dry-run',
    '--vacuum',
  ]);
  assert.equal(parsed.dbFile, path.resolve('tmp/site.db'));
  assert.equal(parsed.dashboardDbFile, path.resolve('tmp/dash.db'));
  assert.equal(parsed.keepDays, 30);
  assert.equal(parsed.site, 'other');
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.vacuum, true);

  for (const arg of ['--keep-days=-1', '--keep-days=abc', '--bogus', '--db=', '--site=']) {
    assert.throws(() => parseArgs([arg]), /keep-days|未知参数|不能为空/, arg);
  }

  const out = [];
  assert.equal(main(['--help'], { log: (l) => out.push(l) }), 0);
  assert.match(out.join('\n'), /--keep-days/);
  assert.equal(main(['--bogus'], { log: () => {}, errorLog: () => {} }), 1);
});

test('按天归档：logs_daily 金额正确，明细只剩保留期内的天', () => {
  const dir = makeTempDir('rollup-test-');
  const dbFile = makeSiteDb(path.join(dir, 'sites', 'relay.db'), seedRows());
  const dashboardFile = path.join(dir, 'dashboard.db');
  const out = silent();

  const result = runRollup({ dbFile, dashboardDbFile: dashboardFile, now: NOW, log: out.log });

  assert.equal(result.days, 2);
  assert.equal(result.archivedRows, 3, '两天共 3 个渠道×日');
  assert.equal(result.deletedRows, 6, 'old 日 5 行 + old2 日 1 行，含被过滤的行');
  assert.equal(result.dryRun, false);

  const rows = dailyRows(dashboardFile);
  assert.deepEqual(
    rows.map((r) => [r.site, r.day, r.channel_id, r.requests, r.cost, r.quota_raw, r.input_total, r.output]),
    [
      [SITE, dayKey(OLD_DAY), 13, 2, 4, 300, 30, 15],
      [SITE, dayKey(OLD_DAY), 14, 1, 3, 300, 30, 15],
      [SITE, dayKey(OLD_DAY_2), 13, 1, 5, 500, 50, 25],
    ],
  );
  assert.equal(rows[0].channel_name, '渠道一');
  assert.equal(rows[1].channel_name, '渠道二');
  assert.ok(rows.every((r) => r.updated_at === NOW), 'updated_at 取本次运行时刻');

  assert.deepEqual(logIds(dbFile), ['f1'], '归档日的全部明细（含系统日志与 Model test）都删掉');
  assert.match(out.lines[0], /^\[rollup-logs\] 归档 2 天 \/ 3 行（渠道×日），删除明细 6 行，耗时 \d+ ms$/);
});

test('覆盖式重算：重复跑不重复计数，第二次删除 0 行', () => {
  const dir = makeTempDir('rollup-test-');
  const dbFile = makeSiteDb(path.join(dir, 'sites', 'relay.db'), seedRows());
  const dashboardFile = path.join(dir, 'dashboard.db');

  runRollup({ dbFile, dashboardDbFile: dashboardFile, now: NOW, log: () => {} });
  const before = dailyRows(dashboardFile);

  const second = runRollup({ dbFile, dashboardDbFile: dashboardFile, now: NOW, log: () => {} });

  assert.equal(second.days, 0);
  assert.equal(second.archivedRows, 0);
  assert.equal(second.deletedRows, 0);
  assert.deepEqual(dailyRows(dashboardFile), before);
});

test('dry-run：只统计，不建看板库、不写库、不删行', () => {
  const dir = makeTempDir('rollup-test-');
  const dbFile = makeSiteDb(path.join(dir, 'sites', 'relay.db'), seedRows());
  const dashboardFile = path.join(dir, 'dashboard.db');
  const out = silent();

  const result = runRollup({
    dbFile,
    dashboardDbFile: dashboardFile,
    dryRun: true,
    vacuum: true,
    now: NOW,
    log: out.log,
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.days, 2);
  assert.equal(result.archivedRows, 3);
  assert.equal(result.deletedRows, 6);
  assert.equal(result.vacuum, null);
  assert.equal(fs.existsSync(dashboardFile), false, 'dry-run 不创建看板库');
  assert.deepEqual(logIds(dbFile), ['f1', 'o1', 'o2', 'o3', 'o4', 'o5', 'p1']);
  assert.match(
    out.lines[0],
    /^\[rollup-logs\] dry-run：将归档 2 天 \/ 3 行（渠道×日），将删除明细 6 行，耗时 \d+ ms$/,
  );
});

test('过滤口径：type=1 与 Model test 不进聚合，channel_id 为空归 0', () => {
  const dir = makeTempDir('rollup-test-');
  const dbFile = makeSiteDb(path.join(dir, 'sites', 'relay.db'), [
    { req_id: 'a', t_ms: OLD_DAY + 3600000, channel_id: 13, cost: 1, quota_raw: 10 },
    { req_id: 'b', t_ms: OLD_DAY + 7200000, channel_id: null, channel_name: null, cost: 2, quota_raw: 20 },
    { req_id: 'c', t_ms: OLD_DAY + 10800000, channel_id: 13, cost: 100, log_type: 1 },
    { req_id: 'd', t_ms: OLD_DAY + 14400000, channel_id: 13, token_name: 'Model test', cost: 200 },
  ]);
  const dashboardFile = path.join(dir, 'dashboard.db');

  const result = runRollup({ dbFile, dashboardDbFile: dashboardFile, now: NOW, log: () => {} });

  assert.equal(result.archivedRows, 2);
  assert.equal(result.deletedRows, 4);
  assert.deepEqual(
    dailyRows(dashboardFile).map((r) => [r.channel_id, r.requests, r.cost, r.quota_raw]),
    [[0, 1, 2, 20], [13, 1, 1, 10]],
  );
  assert.deepEqual(logIds(dbFile), []);
});

test('保留期：今天的明细永远不动（--keep-days=0 也不动今天）', () => {
  const dir = makeTempDir('rollup-test-');
  const todayRow = beijingDayStart(NOW) + 3600000;
  const dbFile = makeSiteDb(path.join(dir, 'sites', 'relay.db'), [
    { req_id: 'yesterday', t_ms: beijingDayStart(NOW) - 3600000, cost: 1 },
    { req_id: 'today', t_ms: todayRow, cost: 2 },
  ]);
  const dashboardFile = path.join(dir, 'dashboard.db');

  const result = runRollup({ dbFile, dashboardDbFile: dashboardFile, keepDays: 0, now: NOW, log: () => {} });

  assert.equal(result.days, 1);
  assert.deepEqual(logIds(dbFile), ['today']);
  assert.deepEqual(
    dailyRows(dashboardFile).map((r) => [r.day, r.requests]),
    [[dayKey(beijingDayStart(NOW) - 3600000), 1]],
  );
});

test('site 可覆盖：写入 logs_daily.site', () => {
  const dir = makeTempDir('rollup-test-');
  const dbFile = makeSiteDb(path.join(dir, 'sites', 'other.db'), seedRows());
  const dashboardFile = path.join(dir, 'dashboard.db');

  runRollup({ dbFile, dashboardDbFile: dashboardFile, site: 'other', now: NOW, log: () => {} });

  assert.ok(dailyRows(dashboardFile).every((r) => r.site === 'other'));
});

test('输出不含日志正文与凭据', () => {
  const dir = makeTempDir('rollup-test-');
  const secret = 'SECRET-LOG-CONTENT sk-live1234567890abcdef';
  const dbFile = makeSiteDb(path.join(dir, 'sites', 'relay.db'), [
    { req_id: 'old', t_ms: OLD_DAY + 3600000, cost: 1, raw_json: secret },
  ]);
  const out = silent();

  runRollup({
    dbFile,
    dashboardDbFile: path.join(dir, 'dashboard.db'),
    now: NOW,
    log: out.log,
    errorLog: out.log,
  });

  const text = out.lines.join('\n');
  assert.equal(out.lines.length, 1);
  assert.ok(!text.includes('SECRET-LOG-CONTENT'), '不能输出日志原文');
  assert.ok(!text.includes('sk-live'), '不能输出凭据');
});

test('真实写锁冲突：重试后退出码 1，归档与明细都不变', () => {
  const dir = makeTempDir('rollup-test-');
  const dbFile = makeSiteDb(path.join(dir, 'sites', 'relay.db'), seedRows());
  const dashboardFile = path.join(dir, 'dashboard.db');
  const holder = new DatabaseSync(dbFile);
  holder.exec('BEGIN IMMEDIATE');
  const lines = [];
  try {
    const code = main(['--db=' + dbFile, '--dashboard-db=' + dashboardFile], {
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
  assert.match(lines.join('\n'), /\[rollup-logs\] 失败：/);
  assert.deepEqual(dailyRows(dashboardFile), []);
  assert.equal(logIds(dbFile).length, 7);
});

test('--vacuum：报告体积前后并回收空间', () => {
  const dir = makeTempDir('rollup-test-');
  const pad = 'x'.repeat(8 * 1024);
  const rows = [];
  for (let i = 0; i < 200; i++) {
    rows.push({ req_id: `old-${i}`, t_ms: OLD_DAY + i * 1000, cost: 0.01, raw_json: pad });
  }
  const dbFile = makeSiteDb(path.join(dir, 'sites', 'relay.db'), rows);
  const sizeBefore = fs.statSync(dbFile).size;
  const out = silent();

  const result = runRollup({
    dbFile,
    dashboardDbFile: path.join(dir, 'dashboard.db'),
    vacuum: true,
    now: NOW,
    log: out.log,
  });

  assert.equal(result.archivedRows, 1);
  assert.equal(result.deletedRows, 200);
  assert.ok(result.vacuum);
  assert.ok(result.vacuum.sizeAfter < sizeBefore, `VACUUM 后应变小：${result.vacuum.sizeAfter} < ${sizeBefore}`);
  assert.match(out.lines.join('\n'), /vacuum \d+ms，站点库 [\d.]+ MB → [\d.]+ MB/);
});

test('dayStartMs：北京日界与 dayKey 互逆', () => {
  for (const day of ['2026-07-25', '2026-01-01', '2026-12-31']) {
    assert.equal(dayKey(dayStartMs(day)), day);
  }
});
