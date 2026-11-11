/**
 * 自定义时间范围回归：今日 0 值、非整点精确过滤、北京跨日、部分日归档、尾桶快照、
 * services from/to 与 status 错误覆盖。临时 SQLite，不读生产。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createApi } from '../lib/api.mjs';
import { createApiCache, createRequestHandler } from '../server.mjs';
import { createRuntimeSettingsStore } from '../lib/runtime-settings.mjs';
import { openDashboardDb } from '../store/dashboard.mjs';
import { beijingDayStart, DAY_MS } from '../lib/time.mjs';
import { makeSourceDb, makeTempDir } from './helpers/fixture.mjs';

const HOUR = 3_600_000;
const MINUTE = 60_000;

function setup({ rows = [], accounts = [], daily = [] } = {}) {
  const dir = makeTempDir('v2-range-');
  const sourceFile = path.join(dir, 'source.db');
  makeSourceDb(sourceFile, {
    rows: rows.map((row, i) => ({
      req_id: `r${i}`,
      t_ms: row.tMs,
      channel_id: row.channelId ?? 1,
      channel_name: 'c1',
      cost: row.cost ?? 0,
    })),
  });
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  const dashboard = openDashboardDb(path.join(dir, 'dashboard.db'));
  const insDaily = dashboard.prepare(
    'INSERT INTO logs_daily (site, day, channel_id, channel_name, requests, cost, quota_raw, input_total, output, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0)',
  );
  for (const row of daily) {
    insDaily.run('test', row.day, row.channelId ?? 1, 'c1', row.requests ?? 1, row.cost ?? 0);
  }
  const api = createApi({
    source,
    dashboard,
    config: { currency: 'USD', quota_per_unit: 500000, accounts },
    siteName: 'test',
    sourceLabel: 'source.db',
  });
  return {
    dir,
    api,
    source,
    dashboard,
    close() {
      source.close();
      dashboard.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function params(from, to) {
  return new URLSearchParams({ from: String(from), to: String(to) });
}

test('今日（北京 00:00→now）无新日志时返回 0，不把昨天算进来', () => {
  const now = Date.now();
  const today = beijingDayStart(now);
  const fx = setup({
    rows: [
      { tMs: today - HOUR, cost: 50 },
      { tMs: today - DAY_MS + HOUR, cost: 20 },
    ],
  });
  try {
    const range = params(today, now);
    assert.equal(fx.api.overview(range).revenue, 0);
    const trend = fx.api.trend(new URLSearchParams({ ...Object.fromEntries(range), granularity: 'hour' }));
    assert.equal(trend.points.reduce((sum, p) => sum + p.revenue, 0), 0);
    const profit = fx.api.profit(new URLSearchParams({ ...Object.fromEntries(range), granularity: 'day' }));
    assert.equal(profit.sites.reduce((sum, s) => sum + s.revenue, 0), 0);
  } finally {
    fx.close();
  }
});

test('非整点自定义区间：overview/trend/profit/channels/upstreams 只统计 [from,to] 内', () => {
  const from = beijingDayStart(Date.now()) + 10 * HOUR + 7 * MINUTE + 123;
  const to = from + 2 * HOUR + 23 * MINUTE;
  const fx = setup({
    rows: [
      { tMs: from - 1, cost: 1 },
      { tMs: from, cost: 2 },
      { tMs: to - 1, cost: 3 },
      { tMs: to, cost: 4 },
      { tMs: to + 1, cost: 8 },
    ],
    accounts: [{ id: 'a', name: 'a', base_url: 'https://a.test', channels: [1], enabled: true }],
  });
  try {
    const q = params(from, to);
    assert.equal(fx.api.overview(q).revenue, 9);
    const trend = fx.api.trend(new URLSearchParams({ from: String(from), to: String(to), granularity: 'hour' }));
    assert.equal(trend.points.reduce((sum, p) => sum + p.revenue, 0), 9);
    const profit = fx.api.profit(new URLSearchParams({ from: String(from), to: String(to), granularity: 'day' }));
    assert.equal(profit.sites.reduce((sum, s) => sum + s.revenue, 0), 9);
    assert.equal(profit.unmapped.revenue, 0);
    assert.equal(fx.api.channels(q).rows.reduce((sum, row) => sum + row.revenue, 0), 9);
    assert.equal(fx.api.upstreams(q).accounts[0].local_revenue, 9);
  } finally {
    fx.close();
  }
});

test('北京跨日：23:30→00:30 的 day/hour 桶不串日', () => {
  const today = beijingDayStart(Date.now());
  const from = today - 30 * MINUTE;
  const to = today + 30 * MINUTE;
  const fx = setup({
    rows: [
      { tMs: today - 15 * MINUTE, cost: 2 },
      { tMs: today + 15 * MINUTE, cost: 3 },
    ],
    accounts: [{ id: 'a', name: 'a', base_url: 'https://a.test', channels: [1], enabled: true }],
  });
  try {
    const trend = fx.api.trend(new URLSearchParams({ from: String(from), to: String(to), granularity: 'day' }));
    assert.deepEqual(trend.points.map((p) => [p.bucket, p.revenue]), [
      [new Date(today - DAY_MS + 8 * HOUR).toISOString().slice(0, 10), 2],
      [new Date(today + 8 * HOUR).toISOString().slice(0, 10), 3],
    ]);
    const profit = fx.api.profit(new URLSearchParams({ from: String(from), to: String(to), granularity: 'day' }));
    assert.equal(profit.sites.reduce((sum, s) => sum + s.revenue, 0), 5);
    assert.equal(profit.unmapped.revenue, 0);
  } finally {
    fx.close();
  }
});

test('归档：只整日并入，半日不从 logs_daily 捏造', () => {
  const today = beijingDayStart(Date.now());
  const day1 = new Date(today - 3 * DAY_MS + 8 * HOUR).toISOString().slice(0, 10);
  const day2 = new Date(today - 2 * DAY_MS + 8 * HOUR).toISOString().slice(0, 10);
  const day3 = new Date(today - DAY_MS + 8 * HOUR).toISOString().slice(0, 10);
  const fx = setup({
    rows: [{ tMs: today + HOUR, cost: 1 }],
    daily: [
      { day: day1, requests: 10, cost: 100 },
      { day: day2, requests: 10, cost: 100 },
    ],
  });
  try {
    // 半日区间：day2 12:00 → day3 12:00，归档不得补 day2/day3
    const halfFrom = today - 2 * DAY_MS + 12 * HOUR;
    const halfTo = today - DAY_MS + 12 * HOUR;
    const half = fx.api.overview(params(halfFrom, halfTo));
    assert.equal(half.revenue, 0, '半日区间不能用归档整日');
    assert.equal(half.archive.available, false);

    // 完整 day2：只有 day2 的归档 100 可以并入
    const full = fx.api.overview(params(today - 2 * DAY_MS, today - DAY_MS - 1));
    assert.equal(full.revenue, 100);
    assert.equal(full.archive.available, true);
    assert.equal(full.archive.from_day, day2);
  } finally {
    fx.close();
  }
});

test('status.coverage：只认最新 upstream-errors 成功且 30 分钟内', () => {
  const now = Date.now();
  const fx = setup({ rows: [{ tMs: now - HOUR, cost: 1 }] });
  try {
    const insRun = fx.dashboard.prepare(
      'INSERT INTO job_runs (job, started_at, finished_at, status, detail) VALUES (?, ?, ?, ?, NULL)',
    );
    const insErr = fx.dashboard.prepare(
      'INSERT INTO upstream_error (id, t_ms, channel_id, channel_name, model, group_name, status_code, message, request_id, recorded_at) VALUES (?, ?, 1, \'c\', \'m\', \'g\', 500, \'x\', NULL, 0)',
    );
    insErr.run(1, now - 2 * HOUR);

    let coverage = fx.api.status(params(now - HOUR, now)).coverage;
    assert.equal(coverage.errors_available, false);
    assert.equal(coverage.errors_last_collected_at, null);
    assert.equal(coverage.errors_since, now - 2 * HOUR);

    insRun.run('upstream-errors', now - 6 * MINUTE, now - 5 * MINUTE, 'ok');
    coverage = fx.api.status(params(now - HOUR, now)).coverage;
    assert.equal(coverage.errors_available, true);
    assert.equal(coverage.errors_last_collected_at, now - 5 * MINUTE);

    insRun.run('upstream-errors', now - 2 * MINUTE, now - MINUTE, 'error');
    coverage = fx.api.status(params(now - HOUR, now)).coverage;
    assert.equal(coverage.errors_available, false);
    assert.equal(coverage.errors_last_collected_at, now - 5 * MINUTE);
  } finally {
    fx.close();
  }
});

// ---------------------------------------------------------------------------
// services 自定义范围 + HTTP
// ---------------------------------------------------------------------------

function servicesFixture() {
  const dir = makeTempDir('v2-range-services-');
  const dashboard = openDashboardDb(path.join(dir, 'dashboard.db'));
  const now = Date.UTC(2026, 10, 10, 12, 0, 0);
  const ins = dashboard.prepare(
    'INSERT INTO job_runs (job, started_at, finished_at, status, detail) VALUES (?, ?, ?, ?, NULL)',
  );
  ins.run('collect-spend', now - 25 * MINUTE, now - 24 * MINUTE, 'ok');
  const settingsStore = createRuntimeSettingsStore({
    dataDir: path.join(dir, 'data'),
    collectionDefaults: { logsMinutes: 15, spendMinutes: 15 },
  });
  const handler = createRequestHandler({
    api: null,
    cache: createApiCache({ ttlMs: 0 }),
    settingsStore,
    dashboard,
    now: () => now,
  });
  return { dir, dashboard, handler, now, close() { dashboard.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('services：显式 from/to 使用精确区间，span≤36h 15m、>36h 1h', async (t) => {
  const fx = servicesFixture();
  const server = http.createServer(fx.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fx.close();
  });

  const from = fx.now - 2 * HOUR;
  const to = fx.now;
  const res = await fetch(`${base}/api/services?from=${from}&to=${to}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.from, from);
  assert.equal(body.to, to);
  assert.equal(body.bucket_ms, 900_000);
  const expected = Math.ceil((to - Math.floor(from / 900_000) * 900_000) / 900_000);
  assert.equal(body.services[0].buckets.length, expected);

  const wide = await (await fetch(`${base}/api/services?from=${fx.now - 48 * HOUR}&to=${fx.now}`)).json();
  assert.equal(wide.bucket_ms, 3_600_000);

  const legacy = await (await fetch(`${base}/api/services?range=24h`)).json();
  assert.equal(legacy.bucket_ms, 900_000);
  assert.equal(legacy.services[0].buckets.length, 96);
  const week = await (await fetch(`${base}/api/services?range=7d`)).json();
  assert.equal(week.services[0].buckets.length, 168);

  for (const query of [
    `from=${from}`,
    `from=${from}&to=${to}&range=24h`,
    `from=${to}&to=${from}`,
    `from=${fx.now - 32 * DAY_MS}&to=${fx.now}`,
    `from=${from}&to=${to}&x=1`,
    'range=30d',
  ]) {
    assert.equal((await fetch(`${base}/api/services?${query}`)).status, 400, query);
  }
  const head = await fetch(`${base}/api/services?from=${from}&to=${to}`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});
