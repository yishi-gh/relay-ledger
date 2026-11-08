/**
 * API 集成单测：默认范围终点只看 log_type=2、账本完整性（零窗口/无数据/余额异常/旧快照/非完整日）。
 * 源库与看板库都建在临时目录，测完删除。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createApi } from '../lib/api.mjs';
import { beijingDayStart, DAY_MS, dayKey } from '../lib/time.mjs';
import { runRollup } from '../jobs/rollup-logs.mjs';
import { openDashboardDb, upsertCreditWindow } from '../store/dashboard.mjs';
import { LOGS_SCHEMA } from '../store/site-logs.mjs';
import { makeSourceDb, makeTempDir, openTempDashboard } from './helpers/fixture.mjs';

function params(obj) {
  return new URLSearchParams(Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, String(v)])));
}

function insertBalance(db, accountId, tMs, balance, { rawBalance = null, rawUnit = null } = {}) {
  db.prepare(
    `INSERT INTO balance_snapshot (account_id, t_ms, day, balance, currency, raw_balance, raw_unit, source, recorded_at)
     VALUES (?, ?, ?, ?, 'USD', ?, ?, 'test', ?)
     ON CONFLICT(account_id, t_ms) DO UPDATE SET
       balance = excluded.balance, raw_balance = excluded.raw_balance, raw_unit = excluded.raw_unit`,
  ).run(accountId, tMs, 'test', balance, rawBalance, rawUnit, Date.now());
}

test('默认范围、账本完整性与异常原因', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-api-'));
  const sourceFile = path.join(dir, 'source.db');
  const dashboardFile = path.join(dir, 'dashboard.db');

  const now = Date.now();
  const dayStart = beijingDayStart(now - 3 * DAY_MS); // 3 天前的北京自然日
  const dayEnd = dayStart + DAY_MS - 1;
  const t0 = dayStart + 12 * 3600000;
  const defaultFrom = beijingDayStart(t0) - 6 * DAY_MS;

  const source = new DatabaseSync(sourceFile);
  source.exec(`
    CREATE TABLE logs (
      req_id TEXT PRIMARY KEY, t_ms INTEGER NOT NULL, t_local TEXT NOT NULL,
      channel_id INTEGER, channel_name TEXT, model TEXT, token_name TEXT,
      cost REAL, quota_raw INTEGER, input_total INTEGER, input_uncached INTEGER,
      cache_read INTEGER, cache_write INTEGER, output INTEGER,
      latency_ms INTEGER, first_token_ms INTEGER, log_type INTEGER
    );
    CREATE TABLE error_logs (t_ms INTEGER, status_code INTEGER);
  `);
  const ins = source.prepare(
    `INSERT INTO logs (req_id, t_ms, t_local, channel_id, channel_name, model, token_name, cost,
                       quota_raw, input_total, input_uncached, cache_read, cache_write, output,
                       latency_ms, first_token_ms, log_type)
     VALUES (?, ?, ?, 13, '渠道一', 'm', ?, ?, 0, 10, 10, 0, 0, 5, 1000, 1000, ?)`,
  );
  ins.run('a', t0, 'test', 't1', 1.5, 2);
  ins.run('b', t0 + 1000, 'test', 't1', 2.5, 2);
  ins.run('d', t0 + 500, 'test', 'Model test', 999, 2); // 必须排除
  ins.run('sys', t0 + 2 * DAY_MS, 'test', 't1', 0, 1); // 更晚，但不是计费日志
  source.close();

  const sourceDb = new DatabaseSync(sourceFile, { readOnly: true });
  const dashboard = openDashboardDb(dashboardFile);
  const config = {
    currency: 'USD',
    quota_per_unit: 500000,
    accounts: [
      {
        id: 'acc',
        name: 'acc',
        kind: 'newapi',
        base_url: 'https://example.test',
        unit: 'USD',
        enabled: true,
        channels: [13],
        endpoints: {},
      },
    ],
  };
  const api = createApi({
    source: sourceDb,
    dashboard,
    config,
    siteName: 'test',
    sourceLabel: 'db/sites/test.db',
  });

  t.after(() => {
    sourceDb.close();
    dashboard.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test('默认范围终点取 log_type=2 的最大 t_ms，且排除 Model test 行', () => {
    const overview = api.overview(new URLSearchParams());
    assert.equal(overview.range.to, t0 + 1000);
    assert.equal(overview.requests, 2);
    assert.equal(overview.revenue, 4);
    assert.equal(overview.tokens.total, 30);
  });

  await t.test('无账本数据：null / unavailable', () => {
    const { accounts } = api.upstreams(params({ from: dayStart, to: dayEnd }));
    const [a] = accounts;
    assert.equal(a.status, 'unavailable');
    assert.equal(a.reason, 'missing_balance');
    assert.equal(a.opening_balance, null);
    assert.equal(a.closing_balance, null);
    // 充值按 credit_event 汇总：没有事件即 0（余额缺失时 consumption 仍为 null）
    assert.equal(a.credits, 0);
    assert.equal(a.consumption, null);
    assert.equal(a.margin, null);
    assert.equal(a.margin_pct, null);
    assert.equal(a.local_revenue, 4);
    assert.equal(a.unit, 'USD');
  });

  await t.test('零充值完整窗口：complete，credits=0，consumption=30', () => {
    insertBalance(dashboard, 'acc', dayStart, 100, { rawBalance: 50000000, rawUnit: 'quota' });
    insertBalance(dashboard, 'acc', dayEnd, 70, { rawBalance: 35000000, rawUnit: 'quota' });
    upsertCreditWindow(dashboard, {
      accountId: 'acc',
      windowStart: dayStart,
      windowEnd: dayEnd,
      credits: 0,
      source: 'test',
    });
    const [a] = api.upstreams(params({ from: dayStart, to: dayEnd })).accounts;
    assert.equal(a.status, 'complete');
    assert.equal(a.reason, null);
    assert.equal(a.credits, 0);
    assert.equal(a.balance_delta, 30);
    assert.equal(a.consumption, 30);
    assert.equal(a.opening_raw.balance, 50000000);
    assert.equal(a.opening_raw.unit, 'quota');
    assert.equal(a.margin, 4 - 30);
    assert.equal(a.margin_pct, (4 - 30) / 4);
  });

  await t.test('余额上升但无入账：partial，consumption 为 null，不给正毛利', () => {
    insertBalance(dashboard, 'acc', dayEnd, 120);
    const [a] = api.upstreams(params({ from: dayStart, to: dayEnd })).accounts;
    assert.equal(a.status, 'partial');
    assert.equal(a.reason, 'balance_increased_without_credits');
    assert.equal(a.balance_delta, -20);
    assert.equal(a.consumption, null);
    assert.equal(a.margin, null);
    assert.equal(a.margin_pct, null);
  });

  await t.test('期初快照早于边界一小时：不再借用，判缺快照', () => {
    dashboard.exec('DELETE FROM balance_snapshot');
    // 边界口径为 ±5 分钟：一小时前的余额不能当本期期初，
    // 否则会把上一期的消费算进来。
    insertBalance(dashboard, 'acc', dayStart - 3600000, 100);
    insertBalance(dashboard, 'acc', dayEnd, 70);
    const [a] = api.upstreams(params({ from: dayStart, to: dayEnd })).accounts;
    assert.equal(a.opening_balance, null);
    assert.equal(a.consumption, null);
    assert.equal(a.status, 'unavailable');
    assert.equal(a.reason, 'missing_balance');
  });

  await t.test('边界容差内（整点 +10 秒）的快照仍可核算', () => {
    dashboard.exec('DELETE FROM balance_snapshot');
    // 采集在整点后 10 秒落库，必须被认作该整点桶的期初
    insertBalance(dashboard, 'acc', dayStart + 10000, 100);
    insertBalance(dashboard, 'acc', dayEnd, 70);
    const [a] = api.upstreams(params({ from: dayStart, to: dayEnd })).accounts;
    assert.equal(a.opening_balance, 100);
    assert.equal(a.consumption, 30);
    assert.equal(a.status, 'complete');
  });

  await t.test('充值走 credit_event：无窗口覆盖也计入，不再恒为 null', () => {
    dashboard.exec('DELETE FROM balance_snapshot');
    dashboard.exec('DELETE FROM credit_window');
    dashboard.exec('DELETE FROM credit_event');
    insertBalance(dashboard, 'acc', dayStart, 100);
    insertBalance(dashboard, 'acc', dayEnd, 60);
    // 只写事件、不写 credit_window：模拟「以现在为终点的区间没有完整窗口」
    dashboard.prepare(
      `INSERT INTO credit_event (account_id, t_ms, amount, kind, note, source, recorded_at)
       VALUES ('acc', ?, 10, 'topup', 'test', 'test', ?)`,
    ).run(dayStart + 3600000, Date.now());
    const [a] = api.upstreams(params({ from: dayStart, to: dayEnd })).accounts;
    assert.equal(a.credits, 10);
    assert.equal(a.credit_events, 1);
    assert.equal(a.balance_delta, 50); // 100 + 10 - 60
    assert.equal(a.consumption, 50);
    assert.equal(a.status, 'complete');
  });

  await t.test('默认范围（to=max_t）非完整日：partial / incomplete_day', () => {
    dashboard.exec('DELETE FROM balance_snapshot');
    dashboard.exec('DELETE FROM credit_window');
    dashboard.exec('DELETE FROM credit_event');
    insertBalance(dashboard, 'acc', defaultFrom, 100);
    insertBalance(dashboard, 'acc', t0 + 1000 - 60000, 80);
    upsertCreditWindow(dashboard, {
      accountId: 'acc',
      windowStart: defaultFrom,
      windowEnd: t0 + 1000,
      credits: 0,
      source: 'test',
    });
    const [a] = api.upstreams(new URLSearchParams()).accounts;
    assert.equal(a.status, 'partial');
    assert.equal(a.reason, 'incomplete_day');
    assert.equal(a.consumption, 20);
    const overview = api.overview(new URLSearchParams());
    assert.equal(overview.margin_status, 'partial');
    assert.equal(overview.upstream_cost, 20);
  });
});

// ---------------------------------------------------------------------------
// 归档（logs_daily）：90 天前的明细按日聚合，跨归档边界的日粒度查询仍要有数
// ---------------------------------------------------------------------------

function makeArchiveSourceDb(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(LOGS_SCHEMA);
  const ins = db.prepare(
    `INSERT INTO logs (req_id, site, source_kind, input_format, t_ms, t_local, token_name,
                       channel_id, channel_name, cost, quota_raw, input_total, input_uncached,
                       cache_read, cache_write, output, latency_ms, log_type, raw_json)
     VALUES (?, 'relay', 'api', 'openai', ?, '2026-11-02 12:00:00', 't1',
             ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, 2, '')`,
  );
  for (const r of rows) {
    ins.run(
      r.req_id,
      r.t_ms,
      r.channel_id,
      r.channel_name,
      r.cost,
      r.quota_raw,
      r.input_total,
      r.output,
      r.latency_ms,
    );
  }
  db.close();
}

test('归档：overview/trend/channels/profit 跨边界仍正确，hour 粒度不变', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-api-archive-'));
  const sourceFile = path.join(dir, 'source.db');
  const dashboardFile = path.join(dir, 'dashboard.db');

  const now = Date.now();
  const todayStart = beijingDayStart(now);
  const oldDay = todayStart - 100 * DAY_MS; // 归档
  const midDay = todayStart - 95 * DAY_MS; // 归档
  const detailDay = todayStart - 1 * DAY_MS; // 保留在明细里

  makeArchiveSourceDb(sourceFile, [
    { req_id: 'o1', t_ms: oldDay + 10 * 3600000, channel_id: 13, channel_name: '渠道一', cost: 1.5, quota_raw: 150, input_total: 100, output: 40, latency_ms: 1000 },
    { req_id: 'o2', t_ms: oldDay + 11 * 3600000, channel_id: 13, channel_name: '渠道一', cost: 2.5, quota_raw: 250, input_total: 200, output: 60, latency_ms: 2000 },
    { req_id: 'o3', t_ms: oldDay + 12 * 3600000, channel_id: 14, channel_name: '渠道二', cost: 3, quota_raw: 300, input_total: 300, output: 90, latency_ms: 3000 },
    // 只在归档窗口里出现的渠道：整段没有明细
    { req_id: 'o4', t_ms: oldDay + 13 * 3600000, channel_id: 15, channel_name: '渠道三', cost: 4, quota_raw: 400, input_total: 400, output: 120, latency_ms: 3500 },
    { req_id: 'm1', t_ms: midDay + 9 * 3600000, channel_id: 13, channel_name: '渠道一', cost: 5, quota_raw: 500, input_total: 500, output: 150, latency_ms: 2500 },
    { req_id: 'n1', t_ms: detailDay + 9 * 3600000, channel_id: 13, channel_name: '渠道一', cost: 6, quota_raw: 600, input_total: 600, output: 180, latency_ms: 4000 },
    { req_id: 'n2', t_ms: detailDay + 10 * 3600000, channel_id: 14, channel_name: '渠道二', cost: 7, quota_raw: 700, input_total: 700, output: 210, latency_ms: 5000 },
  ]);

  // 保留 30 天：oldDay / midDay 归档，detailDay 留在明细
  const siteId = 'relay';
  const rolled = runRollup({
    dbFile: sourceFile,
    dashboardDbFile: dashboardFile,
    keepDays: 30,
    site: siteId,
    now,
    log: () => {},
  });
  assert.equal(rolled.days, 2);

  const source = new DatabaseSync(sourceFile, { readOnly: true });
  const dashboard = openDashboardDb(dashboardFile);
  const api = createApi({
    source,
    dashboard,
    config: {
      currency: 'USD',
      quota_per_unit: 500000,
      accounts: [
        {
          id: 'acc',
          name: 'acc',
          kind: 'newapi',
          base_url: 'https://example.test',
          unit: 'USD',
          enabled: true,
          channels: [13, 14],
          endpoints: {},
        },
      ],
    },
    siteName: siteId,
    sourceLabel: `db/sites/${siteId}.db`,
  });

  t.after(() => {
    source.close();
    dashboard.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const fullRange = params({ from: oldDay, to: detailDay + 12 * 3600000 });

  await t.test('overview：总额含归档，tokens 只按 input_total/output 折算', () => {
    const data = api.overview(fullRange);
    assert.equal(data.revenue, 29);
    assert.equal(data.requests, 7);
    assert.equal(data.quota, 2900);
    assert.equal(data.tokens.input_total, 2800);
    assert.equal(data.tokens.output, 850);
    assert.equal(data.tokens.total, 3650);
    // 归档没有 cache 列：缓存率仍是明细窗口的值，并在 partial_fields 里标注
    assert.equal(data.tokens.cache_read, 0);
    assert.equal(data.cache_rate, null);
    assert.deepEqual(data.archive, {
      from_day: dayKey(oldDay),
      to_day: dayKey(midDay),
      days: 2,
      available: true,
      partial_fields: [
        'tokens.input_uncached',
        'tokens.cache_read',
        'tokens.cache_write',
        'cache_rate',
        'latency',
      ],
    });
  });

  await t.test('trend(day)：归档日直接给日汇总，hour 粒度只覆盖明细', () => {
    const day = api.trend(params({ from: oldDay, to: detailDay + 12 * 3600000, granularity: 'day' }));
    assert.deepEqual(day.points, [
      { bucket: dayKey(oldDay), revenue: 11, quota: 1100, requests: 4 },
      { bucket: dayKey(midDay), revenue: 5, quota: 500, requests: 1 },
      { bucket: dayKey(detailDay), revenue: 13, quota: 1300, requests: 2 },
    ]);
    assert.equal(day.archive.available, true);
    assert.equal(day.archive.days, 2);

    const hour = api.trend(params({ from: oldDay, to: detailDay + 12 * 3600000, granularity: 'hour' }));
    assert.equal(hour.points.length, 2, '小时粒度没有归档，只剩明细那天');
    assert.equal(hour.archive.available, false);
    assert.deepEqual(hour.archive.from_day, null);
    assert.deepEqual(hour.points.map((p) => p.revenue), [6, 7]);
  });

  await t.test('channels：归档并入同渠道，只有归档的渠道标 archive_only', () => {
    const { rows, archive } = api.channels(fullRange);
    assert.equal(archive.available, true);
    assert.deepEqual(
      rows.map((r) => [r.channel_id, r.revenue, r.requests, r.archive_only]),
      [
        [13, 15, 4, false],
        [14, 10, 2, false],
        [15, 4, 1, true],
      ],
    );
    const ch15 = rows.find((r) => r.channel_id === 15);
    assert.equal(ch15.cache_rate, null);
    assert.equal(ch15.latency_p50, null);
    assert.equal(ch15.last_t, null);
    assert.equal(ch15.margin_status, 'unconfigured');
    // 明细窗口里还有数的渠道，分位数只来自明细
    const ch13 = rows.find((r) => r.channel_id === 13);
    assert.equal(ch13.latency_p50, 4000);
    assert.equal(ch13.last_t, detailDay + 9 * 3600000);
  });

  await t.test('profit(day)：售出按日并入渠道与账户，未映射渠道也算', () => {
    const data = api.profit(params({ from: oldDay, to: detailDay + 12 * 3600000, granularity: 'day' }));
    const sum = (points) => points.reduce((s, v) => s + (v ?? 0), 0);
    const byChannel = Object.fromEntries(
      data.series.revenue_by_channel.map((c) => [c.channel_id, sum(c.points)]),
    );
    assert.equal(byChannel[13], 15);
    assert.equal(byChannel[14], 10);
    assert.equal(byChannel[15], 4);
    assert.equal(sum(data.series.revenue_by_site.acc), 25);
    assert.equal(data.unmapped.revenue, 4);
    assert.equal(data.archive.available, true);

    const hour = api.profit(params({ from: oldDay, to: detailDay + 12 * 3600000, granularity: 'hour' }));
    const hourByChannel = Object.fromEntries(
      hour.series.revenue_by_channel.map((c) => [c.channel_id, sum(c.points)]),
    );
    assert.deepEqual(hourByChannel, { 13: 6, 14: 7 });
    assert.equal(hour.archive.available, false);
  });

  await t.test('upstreams：账户本地售出含归档', () => {
    const { accounts, archive } = api.upstreams(fullRange);
    assert.equal(accounts[0].local_revenue, 25);
    assert.equal(archive.available, true);
  });

  await t.test('明细窗口内不并入归档：available=false，数值不变', () => {
    const range = params({ from: detailDay, to: detailDay + DAY_MS - 1 });
    const data = api.overview(range);
    assert.equal(data.revenue, 13);
    assert.equal(data.archive.available, false);
    assert.equal(data.archive.days, 0);
    assert.equal(data.archive.from_day, null);
    assert.deepEqual(data.archive.partial_fields, []);
  });

  await t.test('归档边界日不完整落在区间内时宁可少算，不重复计数', () => {
    // 起点落在 oldDay 中午：oldDay 无法按日折算，只并入 midDay
    const data = api.overview(params({ from: oldDay + 6 * 3600000, to: detailDay + 12 * 3600000 }));
    assert.equal(data.revenue, 18, 'oldDay 的 11 被排除');
    assert.equal(data.archive.days, 1);
    assert.equal(data.archive.from_day, dayKey(midDay));
  });
});

// ---------------------------------------------------------------------------
// 主力模型（额度/亿Token）与分组聚合
// ---------------------------------------------------------------------------

function makeGroupSourceDb(file, rows) {
  const db = new DatabaseSync(file);
  db.exec(LOGS_SCHEMA);
  const ins = db.prepare(
    `INSERT INTO logs (req_id, site, source_kind, input_format, t_ms, t_local, token_name,
                       group_name, channel_id, channel_name, model, cost, quota_raw,
                       input_total, input_uncached, cache_read, output, latency_ms, log_type, raw_json)
     VALUES (?, 'test', 'api', 'openai', ?, '2026-11-02 12:00:00', 't1',
             ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 2, '')`,
  );
  for (const r of rows) {
    ins.run(
      r.req_id,
      r.t_ms,
      r.group_name ?? null,
      r.channel_id,
      r.channel_name,
      r.model ?? null,
      r.cost,
      r.input_total,
      r.input_uncached ?? 0,
      r.cache_read ?? 0,
      r.output ?? 0,
      r.latency_ms,
    );
  }
  db.close();
}

test('主力模型与分组聚合：top_model、归档与未分组', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-api-groups-'));
  const sourceFile = path.join(dir, 'source.db');
  const dashboardFile = path.join(dir, 'dashboard.db');

  const now = Date.now();
  const todayStart = beijingDayStart(now);
  const detailDay = todayStart - DAY_MS;
  const archiveDay = todayStart - 10 * DAY_MS;
  const baseT = detailDay + 3600000;

  makeGroupSourceDb(sourceFile, [
    // 渠道 21 / 分组 g1：model-a 卖得更多，是主力模型，每亿 token 10 美元
    { req_id: 'a1', t_ms: baseT, group_name: 'g1', channel_id: 21, channel_name: '渠道A', model: 'model-a', cost: 10, input_total: 100000000, cache_read: 80, input_uncached: 20, latency_ms: 1000 },
    { req_id: 'a2', t_ms: baseT + 1000, group_name: 'g1', channel_id: 21, channel_name: '渠道A', model: 'model-b', cost: 5, input_total: 500000000, latency_ms: 3000 },
    // 渠道 22 / 分组 g2：模型 tokens 为 0，per_1e8 必须是 null
    { req_id: 'b1', t_ms: baseT + 2000, group_name: 'g2', channel_id: 22, channel_name: '渠道C', model: 'model-c', cost: 4, input_total: 0, latency_ms: 2000 },
    // 渠道 23：group_name 为 NULL，模型名也为 NULL
    { req_id: 'c1', t_ms: baseT + 3000, group_name: null, channel_id: 23, channel_name: '渠道B', model: null, cost: 9, input_total: 900000000, input_uncached: 100, latency_ms: 4000 },
    // 渠道 24：group_name 空串、模型名空串，应与 NULL 一起归入未分组
    { req_id: 'd1', t_ms: baseT + 4000, group_name: '', channel_id: 24, channel_name: '渠道D', model: '', cost: 2, input_total: 100000000, input_uncached: 100, latency_ms: 6000 },
  ]);

  const source = new DatabaseSync(sourceFile, { readOnly: true });
  const dashboard = openDashboardDb(dashboardFile);
  dashboard.prepare(
    `INSERT INTO logs_daily
       (site, day, channel_id, channel_name, requests, cost, quota_raw, input_total, output, updated_at)
     VALUES ('test', ?, 99, '归档渠道', 5, 100, 0, 1000000000, 0, ?)`,
  ).run(dayKey(archiveDay), Date.now());

  const api = createApi({
    source,
    dashboard,
    config: { currency: 'USD', quota_per_unit: 500000, accounts: [] },
    siteName: 'test',
    sourceLabel: 'db/sites/test.db',
  });

  t.after(() => {
    source.close();
    dashboard.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const detailRange = params({ from: detailDay, to: detailDay + DAY_MS - 1 });
  const fullRange = params({ from: archiveDay, to: detailDay + DAY_MS - 1 });

  await t.test('channels：取售出最高的模型，tokens=0 时 per_1e8 为 null', () => {
    const rows = api.channels(detailRange).rows;
    const byId = Object.fromEntries(rows.map((r) => [r.channel_id, r]));

    assert.deepEqual(byId[21].top_model, {
      model: 'model-a',
      revenue: 10,
      tokens: 100000000,
      per_1e8: 10,
    });
    assert.equal(byId[22].top_model.model, 'model-c');
    assert.equal(byId[22].top_model.tokens, 0);
    assert.equal(byId[22].top_model.per_1e8, null);
    // NULL / 空串模型名统一成 (未标记)
    assert.equal(byId[23].top_model.model, '(未标记)');
    assert.equal(byId[24].top_model.model, '(未标记)');
  });

  await t.test('channels：归档渠道没有模型维度，top_model 为 null', () => {
    const { rows, archive } = api.channels(fullRange);
    const byId = Object.fromEntries(rows.map((r) => [r.channel_id, r]));
    assert.equal(byId[99].archive_only, true);
    assert.equal(byId[99].top_model, null);
    assert.ok(archive.partial_fields.includes('top_model'));
    // 明细里出现过的渠道仍保留明细模型
    assert.equal(byId[21].top_model.model, 'model-a');
  });

  await t.test('groups：按 group 聚合、按售出降序，NULL/空串归入未分组', () => {
    const { groups } = api.groups(detailRange);
    assert.deepEqual(groups.map((g) => [g.group_name, g.revenue]), [
      ['g1', 15],
      ['', 11],
      ['g2', 4],
    ]);

    const g1 = groups.find((g) => g.group_name === 'g1');
    assert.equal(g1.channels, 1);
    assert.deepEqual(g1.channel_names, ['渠道A']);
    assert.equal(g1.tokens, 600000000);
    assert.equal(g1.requests, 2);
    assert.equal(g1.cache_rate, 0.8);
    assert.equal(g1.p50, 2000);
    assert.equal(g1.p95, 2900);
    assert.equal(g1.tps, 0);
    assert.equal(g1.top_model.model, 'model-a');
    assert.equal(g1.top_model.per_1e8, 10);

    const ungrouped = groups.find((g) => g.group_name === '');
    assert.equal(ungrouped.channels, 2);
    assert.deepEqual(ungrouped.channel_names, ['渠道B', '渠道D']);
    assert.equal(ungrouped.tokens, 1000000000);
    assert.equal(ungrouped.top_model.model, '(未标记)');
    assert.equal(ungrouped.top_model.revenue, 11);
    assert.equal(ungrouped.top_model.per_1e8, 1.1);
  });

  await t.test('groups：归档并入未分组，只有归档时 p50/p95/tps/top_model 为 null', () => {
    const full = api.groups(fullRange).groups;
    assert.deepEqual(full.map((g) => [g.group_name, g.revenue]), [
      ['', 111],
      ['g1', 15],
      ['g2', 4],
    ]);
    const ungrouped = full.find((g) => g.group_name === '');
    assert.equal(ungrouped.channels, 3);
    assert.ok(ungrouped.channel_names.includes('归档渠道'));
    // 归档没有分位/模型维度，这些字段仍来自明细
    assert.equal(ungrouped.top_model.model, '(未标记)');
    assert.equal(ungrouped.p50, 5000);

    const archiveOnly = api.groups(params({ from: archiveDay, to: archiveDay + DAY_MS - 1 })).groups;
    assert.deepEqual(archiveOnly, [{
      group_name: '',
      channels: 1,
      channel_names: ['归档渠道'],
      revenue: 100,
      tokens: 1000000000,
      requests: 5,
      cache_rate: null,
      p50: null,
      p95: null,
      tps: null,
      last_t: null,
      top_model: null,
    }]);
  });
});

// ---------------------------------------------------------------------------
// /api/quality：collect_errors
// ---------------------------------------------------------------------------

test('/api/quality 的 collect_errors：取最新一轮失败账户，无失败或 detail 非法时为空', async (t) => {
  const dir = makeTempDir('v2-api-quality-');
  const sourceFile = path.join(dir, 'source.db');
  makeSourceDb(sourceFile);
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  const dashboard = openTempDashboard(dir);
  const api = createApi({
    source,
    dashboard,
    config: { currency: 'USD', quota_per_unit: 500000, accounts: [] },
    siteName: 'test',
    sourceLabel: 'db/sites/test.db',
  });
  t.after(() => {
    source.close();
    dashboard.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const insert = dashboard.prepare(
    `INSERT INTO job_runs (job, started_at, finished_at, status, detail)
     VALUES (?, ?, ?, ?, ?)`,
  );

  insert.run('collect-spend', 1000, 1100, 'partial', JSON.stringify({
    accounts: [{ id: 'old', name: '旧记录', status: 'unavailable', reason: 'auth_failed' }],
  }));

  await t.test('有失败账户：返回 account_id / name / reason / at', () => {
    insert.run('collect-spend', 2000, 2100, 'partial', JSON.stringify({
      accounts: [
        { id: 'eula', name: 'eula', status: 'ok' },
        { id: '123api', name: '123api', status: 'unavailable', reason: 'http_401' },
        { id: 'upstream-c', name: 'upstream-c', status: 'partial', reason: 'credits_incomplete' },
      ],
    }));

    assert.deepEqual(api.quality().collect_errors, [
      { account_id: '123api', name: '123api', reason: 'http_401', at: 2000 },
      { account_id: 'upstream-c', name: 'upstream-c', reason: 'credits_incomplete', at: 2000 },
    ]);
  });

  await t.test('最新一轮全部成功：返回空数组', () => {
    insert.run('collect-spend', 3000, 3100, 'ok', JSON.stringify({
      accounts: [{ id: 'eula', name: 'eula', status: 'ok' }],
    }));

    assert.deepEqual(api.quality().collect_errors, []);
  });

  await t.test('detail 不是合法 JSON：返回空数组且不抛错', () => {
    insert.run('collect-spend', 4000, 4100, 'partial', '{not-json');

    assert.deepEqual(api.quality().collect_errors, []);
  });
});
