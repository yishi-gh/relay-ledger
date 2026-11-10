/**
 * /api/settings 的真实 HTTP 测试：listen(0) + 临时库 + 临时 dataDir。
 *
 * 覆盖：GET 不写盘不缓存、默认值五组、HEAD、PATCH 同源/CSRF/JSON/大小限制、
 * revision 409、错误可见、写后缓存失效带来 /api/status 分类立即变化。
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
import { makeSourceDb, makeTempDir } from './helpers/fixture.mjs';

const HOUR = 3_600_000;
const BASE = Date.UTC(2026, 10, 8, 15, 0, 0);
const COLLECTION_DEFAULTS = { logsMinutes: 7.5, spendMinutes: 9.5 };

function stateOfBucket(payload) {
  return payload.components[0].buckets.find((bucket) => bucket.total + bucket.errors > 0);
}

/** 起一个真实服务：4 条成功 + 1 条错误（尝试 5 次，错误率 0.2） */
async function startServer(t, { rows = 4, errors = 1, corruptSettings = false, corruptHeartbeat = false } = {}) {
  const dir = makeTempDir('v2-settings-http-');
  const sourceFile = path.join(dir, 'source.db');
  makeSourceDb(sourceFile, {
    rows: Array.from({ length: rows }, (_, i) => ({
      req_id: `r${i}`,
      t_ms: BASE + i * 1000,
      channel_id: 13,
      channel_name: '渠道一',
    })),
  });

  const source = new DatabaseSync(sourceFile, { readOnly: true });
  const dashboard = openDashboardDb(path.join(dir, 'dashboard.db'));
  const insertError = dashboard.prepare(
    `INSERT INTO upstream_error
       (id, t_ms, channel_id, channel_name, model, group_name, status_code, message, request_id, recorded_at)
     VALUES (?, ?, 13, '渠道一', 'm', 'default', 500, 'boom', NULL, 0)`,
  );
  for (let i = 0; i < errors; i += 1) insertError.run(i + 1, BASE + 5000 + i);

  const dataDir = path.join(dir, 'data');
  const settingsStore = createRuntimeSettingsStore({
    dataDir,
    collectionDefaults: COLLECTION_DEFAULTS,
  });
  if (corruptSettings) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(settingsStore.path, '{broken', 'utf8');
  }
  if (corruptHeartbeat) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(settingsStore.statusPath, '{broken heartbeat', 'utf8');
  }

  const api = createApi({
    source,
    dashboard,
    config: { currency: 'USD', quota_per_unit: 500000, accounts: [] },
    siteName: 'test',
    sourceLabel: 'source.db',
    getHealthSettings: () => settingsStore.read().settings.health,
  });
  const cache = createApiCache({ ttlMs: 60_000 });
  const server = http.createServer(createRequestHandler({ api, cache, settingsStore }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    source.close();
    dashboard.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  return {
    base: `http://127.0.0.1:${port}`,
    port,
    dir,
    dataDir,
    store: settingsStore,
    api,
  };
}

async function call(base, pathname, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(base + pathname, { method, headers, body });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 响应保持 null */ }
  return { status: res.status, headers: res.headers, text, json };
}

function patchHeaders(base, extra = {}) {
  return {
    'content-type': 'application/json',
    origin: base,
    ...extra,
  };
}

function serverSettings(overrides = {}) {
  return {
    monitoring: {
      cacheRate: { good: 0.8, warn: 0.5 },
      latencyP50: { goodMs: 5000, warnMs: 15000 },
      latencyP95: { goodMs: 20000, warnMs: 60000 },
      runway: { dangerDays: 3, warnDays: 7 },
      freshness: { warnMinutes: 30, dangerMinutes: 120 },
      ...overrides.monitoring,
    },
    collection: overrides.collection ?? { ...COLLECTION_DEFAULTS },
    health: { minSamples: 3, failErrorRate: 0.02, ...overrides.health },
  };
}

// ---------------------------------------------------------------------------
// GET / HEAD
// ---------------------------------------------------------------------------

test('GET /api/settings：三组设置 + 五组默认值 + revision + 采集器状态，不写盘不缓存', async (t) => {
  const fx = await startServer(t);
  const res = await call(`${fx.base}`, '/api/settings');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');

  const body = res.json;
  assert.deepEqual(Object.keys(body).sort(), ['collector', 'defaults', 'revision', 'settings']);
  assert.deepEqual(body.settings.collection, COLLECTION_DEFAULTS, '默认采集间隔取部署值');
  assert.deepEqual(body.defaults.collection, COLLECTION_DEFAULTS);
  assert.deepEqual(Object.keys(body.defaults).sort(), [
    'collection', 'display', 'health', 'monitoring', 'refresh',
  ]);
  assert.equal(body.defaults.display.unitSystem, 'zh');
  assert.equal(body.defaults.refresh.intervalMinutes, 15);
  assert.equal(body.revision.length, 64);
  assert.deepEqual(body.collector, {
    state: 'unconfirmed',
    observedRevision: null,
    updatedAt: null,
    effective: { logsMinutes: null, spendMinutes: null },
    overrides: { logs: false, spend: false },
    logsEnabled: null,
  });

  const files = fs.existsSync(fx.dataDir) ? fs.readdirSync(fx.dataDir) : [];
  assert.deepEqual(files, [], 'GET 不得创建任何文件');
});

test('HEAD /api/settings：200 且无响应体', async (t) => {
  const fx = await startServer(t);
  const res = await call(fx.base, '/api/settings', { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.equal(res.text, '');
});

// ---------------------------------------------------------------------------
// PATCH 成功路径
// ---------------------------------------------------------------------------

test('PATCH：同源成功、revision 更新、持久化可重建、未改动的小数采集默认值放行', async (t) => {
  const fx = await startServer(t);
  const first = await call(fx.base, '/api/settings');
  const body = {
    settings: serverSettings({ health: { minSamples: 9 } }),
    revision: first.json.revision,
  };
  const res = await call(fx.base, '/api/settings', {
    method: 'PATCH',
    headers: patchHeaders(fx.base),
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.settings.health.minSamples, 9);
  assert.deepEqual(res.json.settings.collection, COLLECTION_DEFAULTS, '未改动的部署默认值原样保留');
  assert.notEqual(res.json.revision, first.json.revision);

  const reopened = createRuntimeSettingsStore({
    dataDir: fx.dataDir,
    collectionDefaults: COLLECTION_DEFAULTS,
  });
  assert.equal(reopened.read().settings.health.minSamples, 9);
  assert.equal(reopened.read().revision, res.json.revision);

  const again = await call(fx.base, '/api/settings');
  assert.equal(again.json.settings.health.minSamples, 9);
  assert.equal(again.json.revision, res.json.revision);
});

test('PATCH：修改 collection 必须是 1..1440 的整数分钟', async (t) => {
  const fx = await startServer(t);
  const { json } = await call(fx.base, '/api/settings');

  const fractional = await call(fx.base, '/api/settings', {
    method: 'PATCH',
    headers: patchHeaders(fx.base),
    body: JSON.stringify({
      settings: serverSettings({ collection: { logsMinutes: 7.5, spendMinutes: 9.5 } }),
      revision: json.revision,
    }),
  });
  // 与当前值相同 → 未修改，放行
  assert.equal(fractional.status, 200, fractional.text);

  const changedFractional = await call(fx.base, '/api/settings', {
    method: 'PATCH',
    headers: patchHeaders(fx.base),
    body: JSON.stringify({
      settings: serverSettings({ collection: { logsMinutes: 5.5, spendMinutes: 9.5 } }),
      revision: fractional.json.revision,
    }),
  });
  assert.equal(changedFractional.status, 400);
  assert.match(changedFractional.json.error.message, /collection\.logsMinutes 必须是整数分钟/);

  const tooLarge = await call(fx.base, '/api/settings', {
    method: 'PATCH',
    headers: patchHeaders(fx.base),
    body: JSON.stringify({
      settings: serverSettings({ collection: { logsMinutes: 1441, spendMinutes: 9.5 } }),
      revision: fractional.json.revision,
    }),
  });
  assert.equal(tooLarge.status, 400);
  assert.match(tooLarge.json.error.message, /collection\.logsMinutes/);
});

// ---------------------------------------------------------------------------
// PATCH 拒绝路径
// ---------------------------------------------------------------------------

test('PATCH：revision 过期返回 409，且不改动文件', async (t) => {
  const fx = await startServer(t);
  const { json } = await call(fx.base, '/api/settings');
  const res = await call(fx.base, '/api/settings', {
    method: 'PATCH',
    headers: patchHeaders(fx.base),
    body: JSON.stringify({ settings: serverSettings(), revision: 'stale' }),
  });
  assert.equal(res.status, 409);
  assert.equal(res.json.error.code, 'revision_conflict');
  assert.equal(fs.existsSync(fx.store.path), false);
  assert.equal((await call(fx.base, '/api/settings')).json.revision, json.revision);
});

test('PATCH：缺 Origin / 跨源返回 403，不读 body 不写盘', async (t) => {
  const fx = await startServer(t);
  const { json } = await call(fx.base, '/api/settings');
  const payload = JSON.stringify({ settings: serverSettings(), revision: json.revision });

  const missing = await call(fx.base, '/api/settings', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: payload,
  });
  assert.equal(missing.status, 403);
  assert.equal(missing.json.error.code, 'forbidden_origin');

  const cross = await call(fx.base, '/api/settings', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: payload,
  });
  assert.equal(cross.status, 403);

  assert.equal(fs.existsSync(fx.store.path), false);
});

test('PATCH：非 application/json 返回 415，超大请求体返回 413', async (t) => {
  const fx = await startServer(t);
  const { json } = await call(fx.base, '/api/settings');
  const payload = JSON.stringify({ settings: serverSettings(), revision: json.revision });

  const wrongType = await call(fx.base, '/api/settings', {
    method: 'PATCH',
    headers: patchHeaders(fx.base, { 'content-type': 'text/plain' }),
    body: payload,
  });
  assert.equal(wrongType.status, 415);
  assert.equal(wrongType.json.error.code, 'unsupported_media_type');

  const huge = JSON.stringify({ settings: serverSettings(), revision: json.revision, pad: 'x'.repeat(17 * 1024) });
  const tooBig = await call(fx.base, '/api/settings', {
    method: 'PATCH',
    headers: patchHeaders(fx.base),
    body: huge,
  });
  assert.equal(tooBig.status, 413);
  assert.equal(tooBig.json.error.code, 'payload_too_large');
});

test('PATCH：非法设置、未知字段、坏 JSON 均 400 且错误信息可见', async (t) => {
  const fx = await startServer(t);
  const { json } = await call(fx.base, '/api/settings');

  const invalid = await call(fx.base, '/api/settings', {
    method: 'PATCH',
    headers: patchHeaders(fx.base),
    body: JSON.stringify({
      settings: serverSettings({ monitoring: { cacheRate: { good: 0.5, warn: 0.8 } } }),
      revision: json.revision,
    }),
  });
  assert.equal(invalid.status, 400);
  assert.match(invalid.json.error.message, /cacheRate\.warn 必须小于 good/);

  const unknown = await call(fx.base, '/api/settings', {
    method: 'PATCH',
    headers: patchHeaders(fx.base),
    body: JSON.stringify({ settings: serverSettings(), revision: json.revision, extra: 1 }),
  });
  assert.equal(unknown.status, 400);
  assert.match(unknown.json.error.message, /未知字段 extra/);

  const broken = await call(fx.base, '/api/settings', {
    method: 'PATCH',
    headers: patchHeaders(fx.base),
    body: '{oops',
  });
  assert.equal(broken.status, 400);
  assert.equal(broken.json.error.code, 'bad_json');

  const localGroups = await call(fx.base, '/api/settings', {
    method: 'PATCH',
    headers: patchHeaders(fx.base),
    body: JSON.stringify({
      settings: { ...serverSettings(), display: { unitSystem: 'zh' } },
      revision: json.revision,
    }),
  });
  assert.equal(localGroups.status, 400);
  assert.match(localGroups.json.error.message, /未知字段 display/);
});

test('方法：POST /api/settings 与 PATCH 其它接口均为 405，其它路由不受影响', async (t) => {
  const fx = await startServer(t);
  assert.equal((await call(fx.base, '/api/settings', { method: 'POST', body: '{}' })).status, 405);
  assert.equal((await call(fx.base, '/api/meta', { method: 'PATCH', body: '{}' })).status, 405);
  assert.equal((await call(fx.base, '/api/meta')).status, 200);
  assert.equal((await call(fx.base, '/api/healthz')).status, 200);
  assert.equal((await call(fx.base, '/api/nope')).status, 404);
});

// ---------------------------------------------------------------------------
// 写后缓存失效：/api/status 立即按新规则分类
// ---------------------------------------------------------------------------

test('PATCH 后缓存清空：health 规则立即影响 /api/status 分类', async (t) => {
  const fx = await startServer(t);
  const range = `?from=${BASE - 1}&to=${BASE + HOUR}`;

  const first = await call(fx.base, `/api/status${range}`);
  assert.equal(first.status, 200);
  assert.deepEqual(first.json.health_rules, { minSamples: 3, failErrorRate: 0.02 });
  assert.equal(stateOfBucket(first.json).state, 'fail', '5 次尝试 1 次错误（20%）判 fail');
  assert.equal(first.headers.get('x-cache'), 'MISS');

  const cached = await call(fx.base, `/api/status${range}`);
  assert.equal(cached.headers.get('x-cache'), 'HIT');

  const snapshot = await call(fx.base, '/api/settings');
  const patched = await call(fx.base, '/api/settings', {
    method: 'PATCH',
    headers: patchHeaders(fx.base),
    body: JSON.stringify({
      settings: serverSettings({ health: { minSamples: 10 } }),
      revision: snapshot.json.revision,
    }),
  });
  assert.equal(patched.status, 200, patched.text);

  const after = await call(fx.base, `/api/status${range}`);
  assert.equal(after.headers.get('x-cache'), 'MISS', 'PATCH 必须让旧缓存失效');
  assert.deepEqual(after.json.health_rules, { minSamples: 10, failErrorRate: 0.02 });
  assert.equal(stateOfBucket(after.json).state, 'unknown', '样本 5 < 10 判 unknown');
});

// ---------------------------------------------------------------------------
// 读错误可见
// ---------------------------------------------------------------------------

test('设置文件损坏时 GET /api/settings 返回 500，不伪装默认值', async (t) => {
  const fx = await startServer(t, { corruptSettings: true });
  const res = await call(fx.base, '/api/settings');
  assert.equal(res.status, 500);
  assert.equal(res.json.error.code, 'internal_error');
});

test('心跳文件损坏：GET 200 且 collector.error 可见，state 为 unconfirmed', async (t) => {
  const fx = await startServer(t, { corruptHeartbeat: true });
  const res = await call(fx.base, '/api/settings');
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.collector.state, 'unconfirmed');
  assert.equal(res.json.collector.observedRevision, null);
  assert.deepEqual(res.json.collector.effective, { logsMinutes: null, spendMinutes: null });
  assert.equal(typeof res.json.collector.error, 'string');
  assert.ok(res.json.collector.error.length > 0, '错误必须可见，不能吞掉');
  // 设置本体仍然可读
  assert.equal(typeof res.json.revision, 'string');
  assert.equal(res.json.settings.health.minSamples, 3);
});

test('心跳文件损坏时 PATCH 仍成功：配置真实落盘，响应中心跳错误可见', async (t) => {
  const fx = await startServer(t, { corruptHeartbeat: true });
  const first = await call(fx.base, '/api/settings');
  assert.equal(first.status, 200);

  const res = await call(fx.base, '/api/settings', {
    method: 'PATCH',
    headers: patchHeaders(fx.base),
    body: JSON.stringify({
      settings: serverSettings({ health: { minSamples: 11 } }),
      revision: first.json.revision,
    }),
  });
  assert.equal(res.status, 200, '写盘成功不能因为心跳损坏被报成 500');
  assert.equal(res.json.settings.health.minSamples, 11);
  assert.match(res.json.collector.error, /采集器状态文件不可读/);

  const reopened = createRuntimeSettingsStore({
    dataDir: fx.dataDir,
    collectionDefaults: COLLECTION_DEFAULTS,
  });
  assert.equal(reopened.read().settings.health.minSamples, 11, '配置必须真实持久化');
  assert.equal(reopened.read().revision, res.json.revision);
});
