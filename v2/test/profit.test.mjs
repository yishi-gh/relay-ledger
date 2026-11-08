/**
 * 站点盈利接口单测：日/小时分桶（北京时间跨日）、渠道→账户映射与 unmapped、
 * 成本 = 期初 + 充值 − 期末、缺快照/负成本返回 null、毛利率除零、区间合计与序列一致。
 * 源库与看板库都建在临时目录，不连接真实站点，测完删除。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createApi } from '../lib/api.mjs';
import { beijingDayStart } from '../lib/time.mjs';
import { openDashboardDb } from '../store/dashboard.mjs';

const HOUR_MS = 3600000;
const DAY_MS = 86400000;

// 北京时间 2026-01-10 00:00（UTC 2026-01-09 16:00）
const D0 = Date.UTC(2026, 0, 9, 16, 0, 0);
const FROM = D0 - 2 * HOUR_MS; // 北京 2026-01-09 22:00
const TO = D0 + 2 * HOUR_MS - 1; // 北京 2026-01-10 01:59:59.999

function params(obj) {
  return new URLSearchParams(Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [k, String(v)]),
  ));
}

function insertBalance(db, accountId, tMs, balance) {
  db.prepare(
    `INSERT INTO balance_snapshot (account_id, t_ms, day, balance, currency, source, recorded_at)
     VALUES (?, ?, ?, ?, 'USD', 'test', ?)`,
  ).run(accountId, tMs, 'test', balance, Date.now());
}

function insertCredit(db, accountId, tMs, amount) {
  db.prepare(
    `INSERT INTO credit_event (account_id, t_ms, amount, kind, source, recorded_at)
     VALUES (?, ?, ?, 'recharge', 'test', ?)`,
  ).run(accountId, tMs, amount, Date.now());
}

function createSchema(db) {
  db.exec(`
    CREATE TABLE logs (
      req_id TEXT PRIMARY KEY, t_ms INTEGER NOT NULL, t_local TEXT NOT NULL,
      channel_id INTEGER, channel_name TEXT, model TEXT, token_name TEXT,
      cost REAL, quota_raw INTEGER, input_total INTEGER, input_uncached INTEGER,
      cache_read INTEGER, cache_write INTEGER, output INTEGER,
      latency_ms INTEGER, first_token_ms INTEGER, log_type INTEGER
    );
    CREATE TABLE error_logs (t_ms INTEGER, status_code INTEGER);
  `);
}

test('站点盈利：分桶、映射、成本与 null 口径', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-profit-'));
  const sourceFile = path.join(dir, 'source.db');
  const dashboardFile = path.join(dir, 'dashboard.db');

  const source = new DatabaseSync(sourceFile);
  createSchema(source);
  const insLog = source.prepare(
    `INSERT INTO logs (req_id, t_ms, t_local, channel_id, channel_name, model, token_name, cost,
                       quota_raw, input_total, input_uncached, cache_read, cache_write, output,
                       latency_ms, first_token_ms, log_type)
     VALUES (?, ?, 'test', ?, ?, 'm', ?, ?, 0, 10, 10, 0, 0, 5, 1000, 1000, ?)`,
  );
  insLog.run('l1', D0 + 30 * 60000, 10, '渠道十', 't1', 4, 2); // 北京 01-10 00:30
  insLog.run('l2', D0 + 90 * 60000, 10, '渠道十', 't1', 6, 2); // 北京 01-10 01:30
  insLog.run('l3', D0 - 30 * 60000, 20, '渠道二十', 't1', 12, 2); // 北京 01-09 23:30
  insLog.run('l4', D0 + 45 * 60000, 30, '未映射渠道', 't1', 3, 2); // 北京 01-10 00:45
  insLog.run('l5', D0 + 60 * 60000, 10, '渠道十', 'Model test', 999, 2); // 必须排除
  insLog.run('l6', D0 + 30000, 10, '渠道十', 't1', 500, 1); // 非计费日志，必须排除
  source.close();

  const sourceDb = new DatabaseSync(sourceFile, { readOnly: true });
  const dashboard = openDashboardDb(dashboardFile);

  const config = {
    currency: 'USD',
    quota_per_unit: 500000,
    accounts: [
      {
        id: 'acc1',
        name: '账户一',
        kind: 'newapi',
        base_url: 'https://example.test',
        unit: 'USD',
        enabled: true,
        channels: [10],
        endpoints: {},
      },
      {
        id: 'acc2',
        name: '账户二',
        kind: 'sub2api',
        base_url: 'https://example.test',
        unit: 'USD',
        enabled: true,
        channels: [20],
        endpoints: {},
      },
      {
        id: 'acc3',
        name: '账户三',
        kind: 'newapi',
        base_url: 'https://example.test',
        unit: 'USD',
        enabled: true,
        channels: [],
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

  function resetLedger() {
    dashboard.exec('DELETE FROM balance_snapshot');
    dashboard.exec('DELETE FROM credit_event');
    // acc1：期初 100，期间充值 5，期末 85 → 成本 20
    insertBalance(dashboard, 'acc1', FROM, 100);
    insertBalance(dashboard, 'acc1', FROM + HOUR_MS - 1, 96);
    insertBalance(dashboard, 'acc1', D0 - 1, 93);
    insertBalance(dashboard, 'acc1', D0 + HOUR_MS - 1, 89);
    insertBalance(dashboard, 'acc1', TO, 85);
    insertCredit(dashboard, 'acc1', D0 - 30 * 60000, 5);
    // acc2：期初 50，期末 42 → 成本 8
    insertBalance(dashboard, 'acc2', FROM, 50);
    insertBalance(dashboard, 'acc2', FROM + HOUR_MS - 1, 48);
    insertBalance(dashboard, 'acc2', D0 - 1, 47);
    insertBalance(dashboard, 'acc2', D0 + HOUR_MS - 1, 45);
    insertBalance(dashboard, 'acc2', TO, 42);
    // acc3：无售出，但账本可算 → 成本 1，毛利率无定义
    insertBalance(dashboard, 'acc3', FROM, 30);
    insertBalance(dashboard, 'acc3', FROM + HOUR_MS - 1, 29.75);
    insertBalance(dashboard, 'acc3', D0 - 1, 29.5);
    insertBalance(dashboard, 'acc3', D0 + HOUR_MS - 1, 29.25);
    insertBalance(dashboard, 'acc3', TO, 29);
  }

  resetLedger();

  await t.test('日/小时分桶使用北京时间，跨日正确', () => {
    const day = api.profit(params({ from: FROM, to: TO, granularity: 'day' }));
    assert.deepEqual(day.buckets, [
      { t_ms: beijingDayStart(FROM), label: '2026-01-09' },
      { t_ms: beijingDayStart(D0), label: '2026-01-10' },
    ]);
    assert.equal(day.buckets[0].t_ms, Date.UTC(2026, 0, 8, 16));
    assert.equal(day.buckets[1].t_ms, D0);

    const hour = api.profit(params({ from: FROM, to: TO, granularity: 'hour' }));
    assert.deepEqual(hour.buckets.map((b) => b.label), [
      '2026-01-09 22:00',
      '2026-01-09 23:00',
      '2026-01-10 00:00',
      '2026-01-10 01:00',
    ]);
    assert.deepEqual(hour.buckets.map((b) => b.t_ms), [
      FROM,
      FROM + HOUR_MS,
      D0,
      D0 + HOUR_MS,
    ]);
    assert.equal(hour.granularity, 'hour');
    assert.equal(hour.from, FROM);
    assert.equal(hour.to, TO);
  });

  await t.test('渠道→账户映射、unmapped 汇总与排除规则', () => {
    const hour = api.profit(params({ from: FROM, to: TO, granularity: 'hour' }));
    const byChannel = Object.fromEntries(
      hour.series.revenue_by_channel.map((c) => [c.channel_id, c]),
    );
    assert.deepEqual(byChannel[10].points, [0, 0, 4, 6]);
    assert.equal(byChannel[10].account_id, 'acc1');
    assert.deepEqual(byChannel[20].points, [0, 12, 0, 0]);
    assert.equal(byChannel[20].account_id, 'acc2');
    assert.deepEqual(byChannel[30].points, [0, 0, 3, 0]);
    assert.equal(byChannel[30].account_id, null);
    assert.equal(byChannel[10].channel_name, '渠道十');

    assert.equal(hour.unmapped.revenue, 3);
    assert.deepEqual(hour.unmapped.points, [0, 0, 3, 0]);
    assert.deepEqual(hour.unmapped.channels, [
      { channel_id: 30, channel_name: '未映射渠道', revenue: 3 },
    ]);

    const acc1 = hour.sites.find((s) => s.account_id === 'acc1');
    const acc2 = hour.sites.find((s) => s.account_id === 'acc2');
    assert.equal(acc1.revenue, 10);
    assert.equal(acc2.revenue, 12);
    assert.deepEqual(acc1.channels, [10]);
    assert.equal(acc1.kind, 'newapi');
  });

  await t.test('成本 = 期初 + 充值 − 期末，小时桶不插值', () => {
    const hour = api.profit(params({ from: FROM, to: TO, granularity: 'hour' }));
    const acc1 = hour.sites.find((s) => s.account_id === 'acc1');
    assert.equal(acc1.credits, 5);
    assert.equal(acc1.cost, 20);
    assert.equal(acc1.profit, -10);
    assert.equal(acc1.margin, -1);
    assert.equal(acc1.status, 'complete');
    assert.deepEqual(hour.series.cost_by_site.acc1, [4, 8, 4, 4]);
    assert.deepEqual(hour.series.profit_by_site.acc1, [-4, -8, 0, 2]);
    // 桶内无售出时毛利率无定义，返回 null 而不是 0 或 Infinity
    assert.deepEqual(hour.series.margin_by_site.acc1, [null, null, 0, 0.333333]);

    const acc2 = hour.sites.find((s) => s.account_id === 'acc2');
    assert.equal(acc2.cost, 8);
    assert.equal(acc2.profit, 4);
    assert.equal(acc2.margin, 0.333333);
    assert.equal(acc2.status, 'complete');
  });

  await t.test('毛利率分母为 0 返回 null，状态 no_revenue', () => {
    const day = api.profit(params({ from: FROM, to: TO, granularity: 'day' }));
    const acc3 = day.sites.find((s) => s.account_id === 'acc3');
    assert.equal(acc3.revenue, 0);
    assert.equal(acc3.cost, 1);
    assert.equal(acc3.profit, -1);
    assert.equal(acc3.margin, null);
    assert.equal(acc3.status, 'no_revenue');
    assert.deepEqual(day.series.revenue_by_site.acc3, [0, 0]);
  });

  await t.test('区间合计与序列一致（日、小时）', () => {
    for (const granularity of ['day', 'hour']) {
      const data = api.profit(params({ from: FROM, to: TO, granularity }));
      for (const site of data.sites) {
        const id = site.account_id;
        const revPoints = data.series.revenue_by_site[id];
        const costPoints = data.series.cost_by_site[id];
        const profitPoints = data.series.profit_by_site[id];
        assert.equal(revPoints.length, data.buckets.length);
        assert.equal(costPoints.length, data.buckets.length);
        assert.equal(profitPoints.length, data.buckets.length);
        const revSum = revPoints.reduce((s, v) => s + (v ?? 0), 0);
        assert.equal(site.revenue, Math.round(revSum * 1e6) / 1e6);
        if (site.cost !== null) {
          const costSum = costPoints.reduce((s, v) => s + (v ?? 0), 0);
          assert.equal(site.cost, Math.round(costSum * 1e6) / 1e6);
          assert.equal(site.profit, Math.round((site.revenue - site.cost) * 1e6) / 1e6);
          if (site.revenue > 0) {
            assert.equal(site.margin, Math.round((site.profit / site.revenue) * 1e6) / 1e6);
          } else {
            assert.equal(site.margin, null);
          }
        }
      }
    }
    const day = api.profit(params({ from: FROM, to: TO, granularity: 'day' }));
    const acc1 = day.sites.find((s) => s.account_id === 'acc1');
    assert.deepEqual(day.series.cost_by_site.acc1, [12, 8]);
    assert.equal(acc1.cost, 20);
    assert.deepEqual(day.series.revenue_by_site.acc1, [0, 10]);
  });

  await t.test('缺期初/期末快照 → cost 为 null，status missing_balance', () => {
    dashboard.exec("DELETE FROM balance_snapshot WHERE account_id = 'acc2'");
    const data = api.profit(params({ from: FROM, to: TO, granularity: 'hour' }));
    const acc2 = data.sites.find((s) => s.account_id === 'acc2');
    assert.equal(acc2.revenue, 12);
    assert.equal(acc2.cost, null);
    assert.equal(acc2.profit, null);
    assert.equal(acc2.margin, null);
    assert.equal(acc2.status, 'missing_balance');
    assert.deepEqual(data.series.cost_by_site.acc2, [null, null, null, null]);
    assert.deepEqual(data.series.profit_by_site.acc2, [null, null, null, null]);
    assert.deepEqual(data.quality.accounts_missing_balance, ['acc2']);
    assert.equal(data.quality.hours_without_snapshot, 4);
  });

  await t.test('成本计算结果为负 → cost 为 null，status partial', () => {
    dashboard.exec("DELETE FROM balance_snapshot WHERE account_id = 'acc2'");
    insertBalance(dashboard, 'acc2', FROM, 50);
    insertBalance(dashboard, 'acc2', FROM + HOUR_MS - 1, 52);
    insertBalance(dashboard, 'acc2', D0 - 1, 54);
    insertBalance(dashboard, 'acc2', D0 + HOUR_MS - 1, 56);
    insertBalance(dashboard, 'acc2', TO, 58);

    const data = api.profit(params({ from: FROM, to: TO, granularity: 'hour' }));
    const acc2 = data.sites.find((s) => s.account_id === 'acc2');
    assert.equal(acc2.cost, null);
    assert.equal(acc2.profit, null);
    assert.equal(acc2.margin, null);
    assert.equal(acc2.status, 'partial');
    assert.deepEqual(data.series.cost_by_site.acc2, [null, null, null, null]);
    assert.deepEqual(data.quality.accounts_missing_balance, []);
  });

  await t.test('响应不包含凭据字段', () => {
    const data = api.profit(params({ from: FROM, to: TO, granularity: 'day' }));
    const text = JSON.stringify(data);
    assert.doesNotMatch(text, /token|cookie|base_url|authorization/i);
  });

  await t.test('日期范围之外的日志不计入', () => {
    const after = api.profit(params({
      from: D0,
      to: TO,
      granularity: 'hour',
    }));
    // 北京 23:30 的 12 元在区间外
    const acc2 = after.sites.find((s) => s.account_id === 'acc2');
    assert.equal(acc2.revenue, 0);
    assert.equal(after.unmapped.revenue, 3);
  });
});

test('站点盈利：整点采集偏移不导致桶错位，缺边界快照不借相邻值', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-profit-boundary-'));
  const sourceFile = path.join(dir, 'source.db');
  const dashboardFile = path.join(dir, 'dashboard.db');

  const source = new DatabaseSync(sourceFile);
  createSchema(source);
  const insLog = source.prepare(
    `INSERT INTO logs (req_id, t_ms, t_local, channel_id, channel_name, model, token_name, cost,
                       quota_raw, input_total, input_uncached, cache_read, cache_write, output,
                       latency_ms, first_token_ms, log_type)
     VALUES (?, ?, 'test', 10, '渠道十', 'm', 't1', ?, 0, 10, 10, 0, 0, 5, 1000, 1000, 2)`,
  );
  // 北京 02:00、03:00、04:00、05:00 各一笔售出
  const FROM2 = D0 + 2 * HOUR_MS;
  const TO2 = D0 + 6 * HOUR_MS - 1;
  insLog.run('b1', FROM2 + 30 * 60000, 2);
  insLog.run('b2', FROM2 + 90 * 60000, 3);
  insLog.run('b3', FROM2 + 150 * 60000, 4);
  insLog.run('b4', FROM2 + 210 * 60000, 5);
  source.close();

  const sourceDb = new DatabaseSync(sourceFile, { readOnly: true });
  const dashboard = openDashboardDb(dashboardFile);
  const api = createApi({
    source: sourceDb,
    dashboard,
    config: {
      currency: 'USD',
      quota_per_unit: 500000,
      accounts: [{
        id: 'acc1',
        name: '账户一',
        kind: 'newapi',
        base_url: 'https://example.test',
        unit: 'USD',
        enabled: true,
        channels: [10],
        endpoints: {},
      }],
    },
    siteName: 'test',
    sourceLabel: 'db/sites/test.db',
  });

  // 采集器在整点 +10s 落库；末条落在 to 之后 10s，仍要作为最后一个桶的期末
  const at = (hourOffset, seconds, balance) => insertBalance(
    dashboard,
    'acc1',
    D0 + hourOffset * HOUR_MS + seconds * 1000,
    balance,
  );
  at(2, 10, 100);
  at(3, 10, 96);
  at(4, 10, 92);
  at(5, 10, 88);
  at(6, 10, 84);

  try {
    const data = api.profit(params({ from: FROM2, to: TO2, granularity: 'hour' }));
    assert.deepEqual(data.buckets.map((b) => b.label), [
      '2026-01-10 02:00',
      '2026-01-10 03:00',
      '2026-01-10 04:00',
      '2026-01-10 05:00',
    ]);
    // 每个桶都是「本小时整点 → 下个整点」，不能整体错位一小时
    assert.deepEqual(data.series.cost_by_site.acc1, [4, 4, 4, 4]);
    assert.deepEqual(data.series.profit_by_site.acc1, [-2, -1, 0, 1]);
    assert.equal(data.sites[0].cost, 16);
    assert.equal(data.sites[0].margin, -0.142857);
    assert.equal(data.sites[0].status, 'complete');

    // 缺 04:00 的边界快照：03 的期末与 04 的期初都缺失，不拿相邻小时顶替
    dashboard.prepare("DELETE FROM balance_snapshot WHERE account_id = 'acc1' AND t_ms = ?")
      .run(D0 + 4 * HOUR_MS + 10000);
    const gap = api.profit(params({ from: FROM2, to: TO2, granularity: 'hour' }));
    assert.deepEqual(gap.series.cost_by_site.acc1, [4, null, null, 4]);
    assert.equal(gap.sites[0].cost, null);
    assert.equal(gap.sites[0].status, 'missing_balance');

    // 进行中的桶：期末取不晚于 now 的最近快照
    at(4, 10, 92);
    at(4, 20 * 60, 90);
    const live = api.profit(params({ from: FROM2, to: D0 + 4 * HOUR_MS + 30 * 60000, granularity: 'hour' }));
    assert.deepEqual(live.buckets.map((b) => b.label), [
      '2026-01-10 02:00',
      '2026-01-10 03:00',
      '2026-01-10 04:00',
    ]);
    assert.deepEqual(live.series.cost_by_site.acc1, [4, 4, 2]);
  } finally {
    sourceDb.close();
    dashboard.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('站点盈利：区间参数校验', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-profit-bad-'));
  const sourceFile = path.join(dir, 'source.db');
  const dashboardFile = path.join(dir, 'dashboard.db');
  const source = new DatabaseSync(sourceFile);
  createSchema(source);
  source.close();

  const sourceDb = new DatabaseSync(sourceFile, { readOnly: true });
  const dashboard = openDashboardDb(dashboardFile);
  const api = createApi({
    source: sourceDb,
    dashboard,
    config: { currency: 'USD', quota_per_unit: 500000, accounts: [] },
    siteName: 'test',
    sourceLabel: 'db/sites/test.db',
  });

  try {
    assert.throws(
      () => api.profit(params({ granularity: 'week' })),
      /granularity/,
    );
    assert.throws(
      () => api.profit(params({ from: 10, to: 5 })),
      /from 不能大于 to/,
    );
    const empty = api.profit(params({ granularity: 'day' }));
    assert.deepEqual(empty.sites, []);
    assert.deepEqual(empty.series.revenue_by_channel, []);
    assert.equal(empty.unmapped.revenue, 0);
    assert.deepEqual(empty.quality.accounts_missing_balance, []);
  } finally {
    sourceDb.close();
    dashboard.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('站点盈利：停用账户的渠道仍归属该站点，不算未映射', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-profit-disabled-'));
  const sourceFile = path.join(dir, 'source.db');
  const dashboardFile = path.join(dir, 'dashboard.db');

  const source = new DatabaseSync(sourceFile);
  createSchema(source);
  source.prepare(
    `INSERT INTO logs (req_id, t_ms, t_local, channel_id, channel_name, model, token_name, cost,
                       quota_raw, input_total, input_uncached, cache_read, cache_write, output,
                       latency_ms, first_token_ms, log_type)
     VALUES ('d1', ?, 'test', 20, '停用账户的渠道', 'm', 't1', 10, 0, 10, 10, 0, 0, 5, 1000, 1000, 2)`,
  ).run(D0 + 30 * 60000);
  source.prepare(
    `INSERT INTO logs (req_id, t_ms, t_local, channel_id, channel_name, model, token_name, cost,
                       quota_raw, input_total, input_uncached, cache_read, cache_write, output,
                       latency_ms, first_token_ms, log_type)
     VALUES ('d2', ?, 'test', 30, '真正的未映射渠道', 'm', 't1', 2, 0, 10, 10, 0, 0, 5, 1000, 1000, 2)`,
  ).run(D0 + 40 * 60000);
  source.close();

  const sourceDb = new DatabaseSync(sourceFile, { readOnly: true });
  const dashboard = openDashboardDb(dashboardFile);
  const api = createApi({
    source: sourceDb,
    dashboard,
    config: {
      currency: 'USD',
      quota_per_unit: 500000,
      accounts: [
        {
          id: 'live',
          name: '在采账户',
          kind: 'newapi',
          base_url: 'https://example.test',
          unit: 'USD',
          enabled: true,
          channels: [10],
          endpoints: {},
        },
        {
          id: 'off',
          name: '停用账户',
          kind: 'newapi',
          base_url: 'https://example.test',
          unit: 'USD',
          enabled: false,
          channels: [20],
          endpoints: {},
        },
      ],
    },
    siteName: 'test',
    sourceLabel: 'db/sites/test.db',
  });

  try {
    const data = api.profit(params({ from: FROM, to: TO, granularity: 'day' }));
    const off = data.sites.find((s) => s.account_id === 'off');
    assert.ok(off, '停用账户仍应出现在站点列表');
    assert.equal(off.enabled, false);
    assert.equal(off.revenue, 10);
    assert.equal(off.cost, null);
    assert.equal(data.unmapped.revenue, 2, '只有真正无归属的渠道进未映射');
    assert.deepEqual(data.unmapped.channels.map((c) => c.channel_id), [30]);
    assert.deepEqual(data.quality.accounts_missing_balance, ['live']);
  } finally {
    sourceDb.close();
    dashboard.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function insertBalanceRecharged(db, accountId, tMs, balance, totalRecharged) {
  db.prepare(
    `INSERT INTO balance_snapshot (account_id, t_ms, day, balance, currency, total_recharged, source, recorded_at)
     VALUES (?, ?, ?, ?, 'USD', ?, 'test', ?)`,
  ).run(accountId, tMs, 'test', balance, totalRecharged, Date.now());
}

test('站点盈利：sub2api 用累计充值总额算充值，同小时充值与消费不再互相抵消', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-profit-recharge-'));
  const sourceFile = path.join(dir, 'source.db');
  const dashboardFile = path.join(dir, 'dashboard.db');

  const source = new DatabaseSync(sourceFile);
  createSchema(source);
  source.prepare(
    `INSERT INTO logs (req_id, t_ms, t_local, channel_id, channel_name, model, token_name, cost,
                       quota_raw, input_total, input_uncached, cache_read, cache_write, output,
                       latency_ms, first_token_ms, log_type)
     VALUES ('r1', ?, 'test', 10, '渠道十', 'm', 't1', 4, 0, 10, 10, 0, 0, 5, 1000, 1000, 2)`,
  ).run(D0 + 30 * 60000);
  source.close();

  const sourceDb = new DatabaseSync(sourceFile, { readOnly: true });
  const dashboard = openDashboardDb(dashboardFile);

  // 整点采集在边界后 10 秒落库；余额没变，但累计充值从 0 涨到 10：
  // 说明这一小时充了 10、又花掉 10，成本应当是 10 而不是 0。
  insertBalanceRecharged(dashboard, 'sub', D0 + 10000, 100, 0);
  insertBalanceRecharged(dashboard, 'sub', D0 + HOUR_MS + 10000, 100, 10);

  const config = {
    currency: 'USD',
    quota_per_unit: 500000,
    accounts: [
      {
        id: 'sub',
        name: '订阅账户',
        kind: 'sub2api',
        base_url: 'https://example.test',
        unit: 'USD',
        enabled: true,
        channels: [10],
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

  try {
    const data = api.profit(params({ from: D0, to: D0 + HOUR_MS - 1, granularity: 'hour' }));
    const site = data.sites.find((s) => s.account_id === 'sub');
    assert.equal(site.revenue, 4);
    assert.equal(site.credits, 10, '充值取 total_recharged 差值');
    assert.equal(site.cost, 10, '成本 = 期初 100 + 充值 10 - 期末 100');
    assert.equal(site.profit, -6);
    assert.equal(site.status, 'complete');
    assert.deepEqual(data.series.cost_by_site.sub, [10]);
  } finally {
    sourceDb.close();
    dashboard.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('站点盈利：无上游账户的渠道只算售出，成本为 null、状态 no_cost', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-profit-ext-'));
  const sourceFile = path.join(dir, 'source.db');
  const dashboardFile = path.join(dir, 'dashboard.db');

  const source = new DatabaseSync(sourceFile);
  createSchema(source);
  source.prepare(
    `INSERT INTO logs (req_id, t_ms, t_local, channel_id, channel_name, model, token_name, cost,
                       quota_raw, input_total, input_uncached, cache_read, cache_write, output,
                       latency_ms, first_token_ms, log_type)
     VALUES (?, ?, 'test', 42, 'opencode go', 'm', 't1', ?, 0, 10, 10, 0, 0, 5, 1000, 1000, 2)`,
  ).run('e1', D0 + 30 * 60000, 5);
  source.close();

  const sourceDb = new DatabaseSync(sourceFile, { readOnly: true });
  const dashboard = openDashboardDb(dashboardFile);
  const config = {
    currency: 'USD',
    quota_per_unit: 500000,
    accounts: [
      {
        id: 'opencode-go',
        name: 'opencode go',
        kind: 'external',
        base_url: null,
        unit: 'USD',
        enabled: true,
        channels: [42],
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

  try {
    const data = api.profit(params({ from: D0, to: D0 + HOUR_MS - 1, granularity: 'hour' }));
    const site = data.sites.find((s) => s.account_id === 'opencode-go');
    assert.ok(site, '无上游账户的渠道要作为站点出现');
    assert.equal(site.revenue, 5, '售出照常计入');
    assert.equal(site.cost, null, '没有上游账户就没有成本');
    assert.equal(site.profit, null);
    assert.equal(site.margin, null, '不参与毛利率');
    assert.equal(site.status, 'no_cost');
    assert.equal(data.unmapped.revenue, 0, '不应再落到未映射');
    assert.deepEqual(
      data.quality.accounts_missing_balance.filter((id) => id === 'opencode-go'),
      [],
      '无成本源不算缺快照告警',
    );
  } finally {
    sourceDb.close();
    dashboard.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
