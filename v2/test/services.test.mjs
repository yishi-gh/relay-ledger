/**
 * /api/services 服务状态：桶契约、最新状态、间隔过期、enabled 语义与 HTTP 输出。
 * job_runs 只读 allowlist 字段，不读 detail；不触碰真实库。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createApiCache, createRequestHandler } from '../server.mjs';
import { createRuntimeSettingsStore } from '../lib/runtime-settings.mjs';
import { buildServiceHealth, SERVICE_RANGES } from '../lib/service-health.mjs';
import { openDashboardDb } from '../store/dashboard.mjs';
import { makeTempDir } from './helpers/fixture.mjs';

const NOW = Date.UTC(2026, 10, 10, 12, 7, 30);
const MINUTE = 60_000;
const HOUR = 3_600_000;

const SETTINGS = { collection: { logsMinutes: 15, spendMinutes: 15 }, monitoring: {}, health: {} };
const COLLECTOR = {
  state: 'active',
  observedRevision: 'x',
  updatedAt: NOW,
  effective: { logsMinutes: 15, spendMinutes: 15 },
  overrides: { logs: false, spend: false },
  logsEnabled: true,
};

function dashboardWithRuns(runs = []) {
  const dir = makeTempDir('v2-services-');
  const db = openDashboardDb(path.join(dir, 'dashboard.db'));
  const ins = db.prepare(
    'INSERT INTO job_runs (job, started_at, finished_at, status, detail) VALUES (?, ?, ?, ?, NULL)',
  );
  for (const run of runs) {
    ins.run(
      run.job,
      run.startedAt,
      run.finishedAt === undefined ? run.startedAt + 1000 : run.finishedAt,
      run.status ?? 'ok',
    );
  }
  return {
    db,
    close() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function serviceOf(payload, id) {
  return payload.services.find((service) => service.id === id);
}

test('services：24h 为 96 个 15 分钟整桶，DTO 字段固定', () => {
  const fx = dashboardWithRuns();
  try {
    const payload = buildServiceHealth({
      dashboard: fx.db,
      settings: SETTINGS,
      collector: COLLECTOR,
      now: NOW,
      range: '24h',
    });
    assert.equal(payload.generated_at, NOW);
    assert.equal(payload.bucket_ms, 900_000);
    assert.equal(payload.to % 900_000, 0, 'to 对齐整桶');
    assert.equal(payload.to - payload.from, 96 * 900_000);
    assert.deepEqual(payload.services.map((s) => s.id), [
      'collect-spend', 'collect-site-logs', 'http-errors', 'upstream-errors', 'prune', 'rollup',
    ]);
    for (const service of payload.services) {
      assert.deepEqual(Object.keys(service).sort(), [
        'buckets', 'enabled', 'id', 'interval_minutes', 'label', 'last_finished_at',
        'last_started_at', 'last_status', 'reason', 'state',
      ]);
      assert.equal(service.buckets.length, 96);
      assert.deepEqual(Object.keys(service.buckets[0]).sort(), [
        'failures', 'from', 'partial', 'runs', 'state', 'to',
      ]);
    }
    // 无运行记录：unknown，不当作失败
    assert.equal(serviceOf(payload, 'collect-spend').state, 'unknown');
    assert.equal(serviceOf(payload, 'collect-spend').state !== 'fail', true);
    assert.equal(serviceOf(payload, 'collect-spend').buckets[0].state, 'none');
  } finally {
    fx.close();
  }
});

test('services：7d 为 168 个 1 小时桶', () => {
  const fx = dashboardWithRuns();
  try {
    const payload = buildServiceHealth({
      dashboard: fx.db,
      settings: SETTINGS,
      collector: COLLECTOR,
      now: NOW,
      range: '7d',
    });
    assert.equal(payload.bucket_ms, 3_600_000);
    assert.equal(payload.to - payload.from, 168 * HOUR);
    assert.equal(payload.services[0].buckets.length, 168);
  } finally {
    fx.close();
  }
});

test('services：桶内 runs/failures/partial 分状态；按 job 隔离不串组', () => {
  const bucket = Math.floor((NOW - 2 * HOUR) / 900_000) * 900_000;
  const fx = dashboardWithRuns([
    { job: 'collect-spend', startedAt: bucket + 1000, status: 'ok' },
    { job: 'collect-spend', startedAt: bucket + 2000, status: 'error' },
    { job: 'collect-spend', startedAt: bucket + 3000, status: 'partial' },
    { job: 'collect-spend', startedAt: bucket + 4000, status: 'rate_limited' },
    { job: 'collect-site-logs', startedAt: bucket + 1000, status: 'ok' },
  ]);
  try {
    const payload = buildServiceHealth({
      dashboard: fx.db, settings: SETTINGS, collector: COLLECTOR, now: NOW, range: '24h',
    });
    const spend = serviceOf(payload, 'collect-spend');
    const idx = Math.floor((bucket - payload.from) / 900_000);
    const entry = spend.buckets[idx];
    assert.equal(entry.runs, 4);
    assert.equal(entry.failures, 1);
    assert.equal(entry.partial, 2);
    assert.equal(entry.state, 'fail', '有 error 桶判 fail');

    const logs = serviceOf(payload, 'collect-site-logs');
    assert.equal(logs.buckets[idx].runs, 1, '不同 job 不混入同一桶');
    assert.equal(logs.buckets[idx].state, 'ok');
    assert.equal(logs.buckets[idx + 1].state, 'none');
  } finally {
    fx.close();
  }
});

test('services：最新状态按 status 与 2 个周期+grace 判过期', () => {
  const recentOk = NOW - 5 * MINUTE;
  const staleOk = NOW - (15 * 2 + 6) * MINUTE;
  const fx = dashboardWithRuns([
    { job: 'collect-spend', startedAt: staleOk - 1000, finishedAt: staleOk, status: 'ok' },
    { job: 'http-errors', startedAt: recentOk - 1000, finishedAt: recentOk, status: 'ok' },
    { job: 'upstream-errors', startedAt: NOW - MINUTE, finishedAt: NOW - 1000, status: 'error' },
    { job: 'prune', startedAt: NOW - MINUTE, finishedAt: NOW - 1000, status: 'rate_limited' },
  ]);
  try {
    const payload = buildServiceHealth({
      dashboard: fx.db, settings: SETTINGS, collector: COLLECTOR, now: NOW, range: '24h',
    });
    assert.equal(serviceOf(payload, 'collect-spend').state, 'warn', '超过 2 周期+5m');
    assert.match(serviceOf(payload, 'collect-spend').reason, /周期/);
    assert.equal(serviceOf(payload, 'http-errors').state, 'ok');
    assert.equal(serviceOf(payload, 'upstream-errors').state, 'fail');
    assert.equal(serviceOf(payload, 'prune').state, 'warn');
    assert.equal(serviceOf(payload, 'rollup').state, 'unknown', '无记录');
  } finally {
    fx.close();
  }
});

test('services：日志关闭为 disabled，其它 job 不编造 enabled', () => {
  const fx = dashboardWithRuns([{ job: 'collect-site-logs', startedAt: NOW - MINUTE, status: 'ok' }]);
  try {
    const payload = buildServiceHealth({
      dashboard: fx.db,
      settings: SETTINGS,
      collector: { ...COLLECTOR, logsEnabled: false },
      now: NOW,
      range: '24h',
    });
    assert.equal(serviceOf(payload, 'collect-site-logs').enabled, false);
    assert.equal(serviceOf(payload, 'collect-site-logs').state, 'disabled');
    assert.equal(serviceOf(payload, 'collect-spend').enabled, true);
    for (const id of ['http-errors', 'upstream-errors', 'prune', 'rollup']) {
      assert.equal(serviceOf(payload, id).enabled, null);
    }
  } finally {
    fx.close();
  }
});

test('services：采集器实际间隔优先于设置（CLI 覆盖）', () => {
  const fx = dashboardWithRuns();
  try {
    const payload = buildServiceHealth({
      dashboard: fx.db,
      settings: SETTINGS,
      collector: {
        ...COLLECTOR,
        effective: { logsMinutes: 1.5, spendMinutes: 0.5 },
        overrides: { logs: true, spend: true },
      },
      now: NOW,
      range: '24h',
    });
    assert.equal(serviceOf(payload, 'collect-spend').interval_minutes, 0.5);
    assert.equal(serviceOf(payload, 'collect-site-logs').interval_minutes, 1.5);
    assert.equal(serviceOf(payload, 'upstream-errors').interval_minutes, 15);
  } finally {
    fx.close();
  }
});

test('services：job_runs 表缺失按未采集，库关闭/结构损坏必须抛错', () => {
  const dir = makeTempDir('v2-services-errors-');
  const emptyFile = path.join(dir, 'empty.db');
  const db = new DatabaseSync(emptyFile);
  try {
    const payload = buildServiceHealth({
      dashboard: db, settings: SETTINGS, collector: COLLECTOR, now: NOW, range: '24h',
    });
    assert.equal(payload.services.every((service) => service.state === 'unknown'), true);
    assert.equal(payload.services.every((service) => service.buckets.every((b) => b.state === 'none')), true);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const closedDir = makeTempDir('v2-services-closed-');
  const closed = openDashboardDb(path.join(closedDir, 'dashboard.db'));
  closed.close();
  assert.throws(() => buildServiceHealth({
    dashboard: closed, settings: SETTINGS, collector: COLLECTOR, now: NOW, range: '24h',
  }));
  fs.rmSync(closedDir, { recursive: true, force: true });

  const badDir = makeTempDir('v2-services-bad-');
  const bad = new DatabaseSync(path.join(badDir, 'bad.db'));
  bad.exec('CREATE TABLE job_runs (job TEXT, started_at INTEGER, finished_at INTEGER)');
  try {
    assert.throws(() => buildServiceHealth({
      dashboard: bad, settings: SETTINGS, collector: COLLECTOR, now: NOW, range: '24h',
    }));
  } finally {
    bad.close();
    fs.rmSync(badDir, { recursive: true, force: true });
  }
});

test('services：未知状态、ok 缺完成时间不判绿；mixed 桶按 fail>warn>unknown>ok', () => {
  const bucket = Math.floor((NOW - HOUR) / 900_000) * 900_000;
  const fx = dashboardWithRuns([
    { job: 'collect-spend', startedAt: bucket + 1000, finishedAt: null, status: 'ok' },
    { job: 'collect-spend', startedAt: bucket + 2000, finishedAt: bucket + 3000, status: 'running' },
    { job: 'collect-site-logs', startedAt: bucket + 1000, finishedAt: bucket + 2000, status: 'ok' },
    { job: 'rollup', startedAt: bucket + 1000, finishedAt: bucket + 2000, status: 'partial' },
    { job: 'rollup', startedAt: bucket + 2000, finishedAt: bucket + 3000, status: 'mystery' },
  ]);
  try {
    const payload = buildServiceHealth({
      dashboard: fx.db, settings: SETTINGS, collector: COLLECTOR, now: NOW, range: '24h',
    });
    const spend = serviceOf(payload, 'collect-spend');
    const logs = serviceOf(payload, 'collect-site-logs');
    const idx = Math.floor((bucket - payload.from) / 900_000);
    assert.equal(spend.buckets[idx].state, 'unknown', '未知状态与缺完成时间不能算 ok');
    assert.equal(spend.buckets[idx].runs, 2);
    assert.equal(spend.state, 'unknown', '最新一条 running → unknown');
    assert.equal(logs.buckets[idx].state, 'ok', '全部明确 ok 才 ok');
    assert.equal(serviceOf(payload, 'rollup').buckets[idx].state, 'warn', 'partial+unknown → warn');

    // 最新 ok 但缺 finish → unknown
    const noFinish = dashboardWithRuns([
      { job: 'http-errors', startedAt: NOW - MINUTE, finishedAt: null, status: 'ok' },
    ]);
    try {
      const p2 = buildServiceHealth({
        dashboard: noFinish.db, settings: SETTINGS, collector: COLLECTOR, now: NOW, range: '24h',
      });
      assert.equal(serviceOf(p2, 'http-errors').state, 'unknown');
    } finally {
      noFinish.close();
    }

    // 未来完成时间异常 → unknown；小 skew 容忍
    const future = dashboardWithRuns([
      { job: 'upstream-errors', startedAt: NOW - MINUTE, finishedAt: NOW + 10 * MINUTE, status: 'ok' },
      { job: 'prune', startedAt: NOW - MINUTE, finishedAt: NOW + 30_000, status: 'ok' },
    ]);
    try {
      const p3 = buildServiceHealth({
        dashboard: future.db, settings: SETTINGS, collector: COLLECTOR, now: NOW, range: '24h',
      });
      assert.equal(serviceOf(p3, 'upstream-errors').state, 'unknown');
      assert.equal(serviceOf(p3, 'prune').state, 'ok');
    } finally {
      future.close();
    }
  } finally {
    fx.close();
  }
});

async function startServer(t, { corruptHeartbeat = false } = {}) {
  const dir = makeTempDir('v2-services-http-');
  const dashboard = openDashboardDb(path.join(dir, 'dashboard.db'));
  const ins = dashboard.prepare(
    'INSERT INTO job_runs (job, started_at, finished_at, status, detail) VALUES (?, ?, ?, ?, NULL)',
  );
  ins.run('collect-spend', NOW - 5 * MINUTE, NOW - 4 * MINUTE, 'ok');
  ins.run('upstream-errors', NOW - 3 * MINUTE, NOW - 2 * MINUTE, 'ok');

  const settingsStore = createRuntimeSettingsStore({
    dataDir: path.join(dir, 'data'),
    collectionDefaults: { logsMinutes: 15, spendMinutes: 15 },
  });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  if (corruptHeartbeat) {
    fs.writeFileSync(settingsStore.statusPath, '{broken', 'utf8');
  } else {
    settingsStore.writeCollectorStatus({
      observedRevision: settingsStore.read().revision,
      updatedAt: Date.now(),
      effective: { logsMinutes: 15, spendMinutes: 15 },
      overrides: { logs: false, spend: false },
      logsEnabled: true,
    });
  }

  const handler = createRequestHandler({
    api: null,
    cache: createApiCache({ ttlMs: 0 }),
    settingsStore,
    dashboard,
    now: () => NOW,
  });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    dashboard.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { base };
}

test('HTTP GET/HEAD /api/services：DTO、range 校验与真实 collector', async (t) => {
  const { base } = await startServer(t);
  const res = await fetch(base + '/api/services');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ['bucket_ms', 'collector', 'from', 'generated_at', 'services', 'to']);
  assert.equal(body.collector.state, 'active');
  assert.equal(body.services.length, 6);
  assert.equal(body.services.every((s) => s.buckets.length === 96), true);
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes('"detail"'), false);
  assert.equal(serialized.includes('boom'), false);

  const head = await fetch(base + '/api/services', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');

  const week = await (await fetch(base + '/api/services?range=7d')).json();
  assert.equal(week.bucket_ms, 3_600_000);
  assert.equal(week.services[0].buckets.length, 168);

  const bad = await fetch(base + '/api/services?range=30d');
  assert.equal(bad.status, 400);

  const patch = await fetch(base + '/api/services', { method: 'PATCH', body: '{}' });
  assert.equal(patch.status, 405);
});

test('HTTP /api/services：心跳损坏返回 200 + collector.error，不 500', async (t) => {
  const { base } = await startServer(t, { corruptHeartbeat: true });
  const res = await fetch(base + '/api/services');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.collector.state, 'unconfirmed');
  assert.equal(typeof body.collector.error, 'string');
});
