/**
 * /api/routes 的 near_1h：滑动 1 小时、共享 health 阈值、全渠道保留、错误采集覆盖度。
 * 固定 now、真实临时库，不调用 status，不做 7d。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createApi } from '../lib/api.mjs';
import { replaceRoutingSnapshot } from '../store/channel-routing.mjs';
import { openDashboardDb } from '../store/dashboard.mjs';
import { makeSourceDb, makeTempDir } from './helpers/fixture.mjs';

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const HOUR = 3_600_000;
const MINUTE = 60_000;

function setup({ logs = [], errors = [], channels = [], rules = null, jobRuns = [] } = {}) {
  const dir = makeTempDir('v2-near-');
  const sourceFile = path.join(dir, 'source.db');
  makeSourceDb(sourceFile, {
    rows: logs.map((row, i) => ({
      req_id: `r${i}`,
      t_ms: row.tMs,
      channel_id: row.channelId ?? 10,
      channel_name: row.channelName ?? '渠道',
      log_type: 2,
    })),
  });
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  const dashboard = openDashboardDb(path.join(dir, 'dashboard.db'));

  if (channels.length) {
    replaceRoutingSnapshot(dashboard, {
      channels,
      abilities: [],
      routesAvailable: true,
      now: NOW - HOUR,
    });
  }
  const insError = dashboard.prepare(
    `INSERT INTO upstream_error
       (id, t_ms, channel_id, channel_name, model, group_name, status_code, message, request_id, recorded_at)
     VALUES (?, ?, ?, '渠道', 'm', 'g', 500, 'boom', NULL, 0)`,
  );
  errors.forEach((row, i) => insError.run(i + 1, row.tMs, row.channelId ?? 10));
  const insRun = dashboard.prepare(
    'INSERT INTO job_runs (job, started_at, finished_at, status, detail) VALUES (?, ?, ?, ?, NULL)',
  );
  for (const run of jobRuns) insRun.run(run.job ?? 'upstream-errors', run.startedAt, run.finishedAt, run.status);

  const api = createApi({
    source,
    dashboard,
    config: { currency: 'USD', quota_per_unit: 500000, accounts: [] },
    siteName: 'test',
    sourceLabel: 'source.db',
    getHealthSettings: rules ? () => rules : undefined,
    now: () => NOW,
  });

  return {
    api,
    dashboard,
    close() {
      source.close();
      dashboard.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const CHANNELS = [
  { id: 10, name: '启用', status: 1, type: 1, base_url: 'https://a.test', model_mapping: null },
  { id: 20, name: '停用', status: 2, type: 1, base_url: null, model_mapping: null },
  { id: 30, name: '未知', status: null, type: 1, base_url: null, model_mapping: null },
  { id: 40, name: '无流量', status: 1, type: 1, base_url: null, model_mapping: null },
];

test('near_1h：滑动 1 小时窗口，边界内计数、边界外忽略', () => {
  const fx = setup({
    channels: CHANNELS,
    logs: [
      { tMs: NOW - HOUR + 1, channelId: 10 },
      { tMs: NOW - 1, channelId: 10 },
      { tMs: NOW - HOUR - 1, channelId: 10 },
      { tMs: NOW, channelId: 10 },
    ],
  });
  try {
    const { near_1h: near } = fx.api.routeGraph();
    assert.equal(near.as_of, NOW);
    assert.equal(near.from, NOW - HOUR);
    assert.equal(near.to, NOW);
    const c10 = near.channels.find((c) => c.channel_id === 10);
    assert.equal(c10.requests, 2, '窗口内两条，边界外/当前后一条不计');
    assert.equal(c10.errors, 0);
    assert.equal(c10.attempts, 2);
    assert.equal(c10.uptime, 1);
    assert.equal(c10.state, 'unknown', '默认 minSamples=3，2 次样本不足以结论');
  } finally {
    fx.close();
  }
});

test('near_1h：共享 health 阈值决定状态，health_rules 回显', () => {
  const logs = Array.from({ length: 10 }, (_, i) => ({ tMs: NOW - 10 * MINUTE + i, channelId: 10 }));
  const fx = setup({
    channels: CHANNELS,
    logs,
    errors: [{ tMs: NOW - 9 * MINUTE, channelId: 10 }],
    rules: { minSamples: 5, failErrorRate: 0.2 },
  });
  try {
    const { near_1h: near } = fx.api.routeGraph();
    assert.deepEqual(near.health_rules, { minSamples: 5, failErrorRate: 0.2 });
    const c10 = near.channels.find((c) => c.channel_id === 10);
    assert.equal(c10.attempts, 11);
    assert.equal(c10.state, 'warn', '1/11=0.0909 < 0.2 → warn');
  } finally {
    fx.close();
  }
});

test('near_1h：全渠道保留（停用/未知/无流量），无调用 state=none', () => {
  const fx = setup({ channels: CHANNELS, logs: [{ tMs: NOW - MINUTE, channelId: 10 }] });
  try {
    const { near_1h: near } = fx.api.routeGraph();
    assert.deepEqual(near.channels.map((c) => c.channel_id), [10, 20, 30, 40]);
    const byId = new Map(near.channels.map((c) => [c.channel_id, c]));
    assert.equal(byId.get(20).attempts, 0);
    assert.equal(byId.get(20).state, 'none');
    assert.equal(byId.get(30).state, 'none');
    assert.equal(byId.get(40).state, 'none');
  } finally {
    fx.close();
  }
});

test('near_1h：错误覆盖度只信 upstream-errors 的最新成功，且不超过 30 分钟', () => {
  const channels = [{ id: 10, name: 'a', status: 1, type: 1, base_url: null, model_mapping: null }];

  const fresh = setup({
    channels,
    jobRuns: [{ startedAt: NOW - 10 * MINUTE, finishedAt: NOW - 9 * MINUTE, status: 'ok' }],
  });
  try {
    const near = fresh.api.routeGraph().near_1h;
    assert.equal(near.errors_available, true);
    assert.equal(near.errors_last_collected_at, NOW - 9 * MINUTE);
  } finally {
    fresh.close();
  }

  const stale = setup({
    channels,
    jobRuns: [{ startedAt: NOW - 40 * MINUTE, finishedAt: NOW - 39 * MINUTE, status: 'ok' }],
  });
  try {
    const near = stale.api.routeGraph().near_1h;
    assert.equal(near.errors_available, false, '超过 30 分钟不可用');
    assert.equal(near.errors_last_collected_at, NOW - 39 * MINUTE);
  } finally {
    stale.close();
  }

  const failed = setup({
    channels,
    jobRuns: [
      { startedAt: NOW - 20 * MINUTE, finishedAt: NOW - 19 * MINUTE, status: 'ok' },
      { startedAt: NOW - 2 * MINUTE, finishedAt: NOW - MINUTE, status: 'error' },
    ],
  });
  try {
    const near = failed.api.routeGraph().near_1h;
    assert.equal(near.errors_available, false, '最新一次失败 → 不可用');
    assert.equal(near.errors_last_collected_at, NOW - 19 * MINUTE, '最近成功时间仍可见');
  } finally {
    failed.close();
  }

  const none = setup({ channels });
  try {
    const near = none.api.routeGraph().near_1h;
    assert.equal(near.errors_available, false);
    assert.equal(near.errors_last_collected_at, null);
  } finally {
    none.close();
  }
});

test('near_1h：有错误但无成功调用时 uptime=0，样本不足仍 unknown', () => {
  const channels = [{ id: 10, name: 'a', status: 1, type: 1, base_url: null, model_mapping: null }];
  const fx = setup({ channels, errors: [{ tMs: NOW - MINUTE, channelId: 10 }] });
  try {
    const c10 = fx.api.routeGraph().near_1h.channels.find((c) => c.channel_id === 10);
    assert.equal(c10.requests, 0);
    assert.equal(c10.errors, 1);
    assert.equal(c10.uptime, 0);
    assert.equal(c10.state, 'unknown');
  } finally {
    fx.close();
  }
});

test('near_1h：缺 logs 表降级为 unknown，库关闭/损坏必须抛错', () => {
  const dir = makeTempDir('v2-near-missing-');
  const sourceFile = path.join(dir, 'empty-source.db');
  const rawSource = new DatabaseSync(sourceFile);
  rawSource.close();
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  const dashboard = openDashboardDb(path.join(dir, 'dashboard.db'));
  replaceRoutingSnapshot(dashboard, {
    channels: [{ id: 10, name: 'a', status: 1, type: 1, base_url: null, model_mapping: null }],
    abilities: [],
    routesAvailable: true,
    now: 1,
  });
  const api = createApi({
    source,
    dashboard,
    config: { accounts: [] },
    siteName: 't',
    sourceLabel: 's',
    now: () => NOW,
  });
  try {
    const near = api.routeGraph().near_1h;
    assert.equal(near.channels[0].state, 'unknown', '请求覆盖缺失时不能判绿/判空');
    assert.equal(near.errors_available, false);
  } finally {
    // 关闭后查询属于真实错误：不允许吞成全 0
    source.close();
    assert.throws(() => api.routeGraph(), /not open|closed|database/i);
    dashboard.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('near_1h：dashboard 缺 job_runs/upstream_error 时按未采集降级', () => {
  const dir = makeTempDir('v2-near-raw-dash-');
  const sourceFile = path.join(dir, 'source.db');
  makeSourceDb(sourceFile);
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  const dashboard = new DatabaseSync(path.join(dir, 'empty-dashboard.db'));
  const api = createApi({
    source,
    dashboard,
    config: { accounts: [] },
    siteName: 't',
    sourceLabel: 's',
    now: () => NOW,
  });
  try {
    const near = api.routeGraph().near_1h;
    assert.deepEqual(near.channels, []);
    assert.equal(near.errors_available, false);
    assert.equal(near.errors_last_collected_at, null);
  } finally {
    source.close();
    dashboard.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('near_1h：窗口查询走已有索引，未新增/删除索引', () => {
  const fx = setup({ channels: CHANNELS });
  try {
    const plan = fx.dashboard.prepare(
      `EXPLAIN QUERY PLAN
       SELECT COALESCE(channel_id, 0), COUNT(*)
         FROM upstream_error
        WHERE t_ms BETWEEN ? AND ?
        GROUP BY channel_id`,
    ).all(NOW - HOUR, NOW);
    const text = plan.map((row) => row.detail).join(' | ');
    assert.match(text, /INDEX/i, '应按 t_ms 索引扫描，而不是全表回退：' + text);

    const indexes = fx.dashboard
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='upstream_error'")
      .all()
      .map((row) => row.name);
    assert.ok(indexes.includes('idx_upstream_error_t'));
    assert.ok(indexes.includes('idx_upstream_error_ch'));
  } finally {
    fx.close();
  }
});
