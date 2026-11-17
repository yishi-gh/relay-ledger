/** 按需采集 HTTP 协议：真实 localhost 服务、临时库、注入任务，禁止真实上游请求。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createApi } from '../lib/api.mjs';
import { createCollectionRefreshStore, createOnDemandCollector } from '../lib/collection-refresh.mjs';
import { createApiCache, createRequestHandler } from '../server.mjs';
import { openDashboardDb } from '../store/dashboard.mjs';
import { makeSourceDb, makeTempDir } from './helpers/fixture.mjs';

const BASE = Date.UTC(2026, 10, 18);
const HOUR = 3_600_000;
const RANGE = `?from=${BASE}&to=${BASE + HOUR - 1}`;
const ALL_RESOURCES = ['logs', 'errors', 'httpErrors', 'spend', 'routes'];
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function startServer(t, { enabled = ALL_RESOURCES, unavailable = false } = {}) {
  const dir = makeTempDir('v2-collection-refresh-http-');
  const sourceFile = path.join(dir, 'source.db');
  makeSourceDb(sourceFile, { rows: [{ req_id: 'initial', t_ms: BASE + 1000, cost: 1 }] });
  const sourceWriter = new DatabaseSync(sourceFile);
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  const db = openDashboardDb(path.join(dir, 'dashboard.db'));
  const webDb = openDashboardDb(path.join(dir, 'dashboard.db'));
  let time = BASE;
  const now = () => time;
  const alive = new Set([111, 222]);
  const workerStore = createCollectionRefreshStore(db, { now, pid: 111, isAlive: (pid) => alive.has(pid) });
  const webStore = createCollectionRefreshStore(webDb, { now, pid: 222, isAlive: (pid) => alive.has(pid) });
  if (enabled !== null) workerStore.register(enabled);
  const cache = createApiCache({ ttlMs: HOUR, now });
  const api = createApi({
    source, dashboard: webDb,
    config: { currency: 'USD', quota_per_unit: 500000, accounts: [] },
    siteName: 'test', sourceLabel: 'source.db',
  });
  const server = http.createServer(createRequestHandler({
    api, cache, dashboard: webDb, now,
    collectionStore: unavailable ? null : webStore,
  }));
  const collectors = [];
  const gates = [];
  const intervals = new Set();
  const timer = {
    setInterval(fn, ms) { const handle = { fn, ms }; intervals.add(handle); return handle; },
    clearInterval(handle) { intervals.delete(handle); },
  };
  const errors = [];
  t.after(async () => {
    for (const gate of gates) gate.resolve({ status: 'ok' });
    await Promise.all(collectors.map((collector) => collector.stop()));
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    source.close();
    sourceWriter.close();
    webDb.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    db, sourceWriter, workerStore, webStore, cache, alive, errors,
    now,
    setTime(value) { time = value; },
    heartbeatAt(value) { time = value; workerStore.heartbeat(ALL_RESOURCES); },
    snapshot() {
      return {
        rows: db.prepare('SELECT * FROM collection_refresh ORDER BY resource').all(),
        workerChanges: db.prepare('SELECT total_changes() AS n').get().n,
        webChanges: webDb.prepare('SELECT total_changes() AS n').get().n,
      };
    },
    hold() { const gate = deferred(); gates.push(gate); return gate; },
    collector(tasks) {
      const collector = createOnDemandCollector({
        store: workerStore, tasks, resources: Object.keys(tasks), timer,
        logError: (error) => errors.push(error),
      });
      collectors.push(collector);
      return collector;
    },
  };
}

function call(base, pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(pathname, base), { method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ status: res.statusCode, headers: res.headers, text, json: text ? JSON.parse(text) : null });
        } catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error(`本地 HTTP 请求超时：${method} ${pathname}`)));
    if (Array.isArray(body)) {
      for (const chunk of body) req.write(chunk);
      req.end();
    } else req.end(body);
  });
}

function post(fx, value, { headers = {}, body = JSON.stringify(value) } = {}) {
  return call(fx.base, '/api/refresh', {
    method: 'POST',
    headers: { origin: fx.base, 'content-type': 'application/json', ...headers },
    body,
  });
}

function assertError(response, status, code) {
  assert.equal(response.status, status, response.text);
  assert.equal(response.json.error.code, code);
  assert.ok(response.json.error.message);
  assert.equal(response.headers['cache-control'], 'no-store');
}

test('GET/HEAD 只读且不缓存：空库不建状态，死 PID 不被查询恢复', async (t) => {
  const fx = await startServer(t, { enabled: null });
  const empty = fx.snapshot();
  const first = await call(fx.base, '/api/refresh?view=models');
  assert.equal(first.status, 200);
  assert.deepEqual(Object.keys(first.json).sort(), ['groups', 'revision']);
  assert.equal(first.json.groups[0].resource, 'logs');
  assert.equal(first.json.groups[0].state, 'disabled');
  assert.equal(typeof first.json.revision, 'string');
  assert.equal(first.headers['cache-control'], 'no-store');
  assert.equal(first.headers['x-cache'], undefined);
  assert.deepEqual(fx.snapshot(), empty);

  fx.workerStore.register(['logs']);
  fx.workerStore.request(['logs']);
  fx.workerStore.claim('logs');
  fx.alive.delete(111);
  const running = fx.snapshot();
  const get = await call(fx.base, '/api/refresh?view=models');
  const head = await call(fx.base, '/api/refresh?view=models', { method: 'HEAD' });
  assert.equal(get.status, 202);
  assert.equal(get.json.groups[0].state, 'running');
  assert.equal(head.status, 202);
  assert.equal(head.text, '');
  assert.ok(Number(head.headers['content-length']) > 0);
  assert.deepEqual(fx.snapshot(), running);
});

test('POST 仅入队页面资源，并发请求、运行中强制请求合并，完成后 GET 返回 200', async (t) => {
  const fx = await startServer(t);
  const gate = fx.hold();
  let calls = 0;
  const collector = fx.collector({ logs: async () => { calls += 1; return gate.promise; } });
  const initial = await call(fx.base, '/api/refresh?view=models');
  const requests = await Promise.all(Array.from({ length: 6 }, () => post(fx, { view: 'models', force: false })));
  for (const response of requests) {
    assert.equal(response.status, 202, response.text);
    assert.deepEqual(response.json.groups.map((group) => group.resource), ['logs']);
    assert.equal(response.json.groups[0].state, 'queued');
    assert.equal(response.json.groups[0].request_id, 1);
    assert.equal(response.json.revision, initial.json.revision);
  }
  assert.equal(calls, 0, 'HTTP 进程不能执行上游任务');
  assert.ok(fx.snapshot().rows.filter((row) => row.resource !== 'logs').every((row) => row.request_id === 0));
  collector.drain();
  const completion = collector.run('logs');
  await nextTurn();
  assert.equal(calls, 1);
  const running = await call(fx.base, '/api/refresh?view=models');
  assert.equal(running.status, 202);
  assert.equal(running.json.groups[0].state, 'running');
  const repeated = await post(fx, { view: 'models', force: true });
  assert.equal(repeated.status, 202);
  assert.equal(repeated.json.groups[0].request_id, 1);
  gate.resolve({ status: 'ok', inserted: 0 });
  await completion;
  const done = await call(fx.base, '/api/refresh?view=models');
  assert.equal(done.status, 200);
  assert.equal(done.json.groups[0].completed_id, 1);
  assert.equal(done.json.groups[0].last_success_at, BASE);
  assert.equal(done.json.groups[0].error, null);
  assert.notEqual(done.json.revision, initial.json.revision);
});

test('页面分组按白名单返回，设置页 POST 是无采集的 200', async (t) => {
  const fx = await startServer(t);
  const overview = await call(fx.base, '/api/refresh?view=overview');
  assert.equal(overview.status, 200);
  assert.deepEqual(overview.json.groups.map((group) => group.resource).sort(), ['logs', 'routes', 'spend']);
  const before = fx.snapshot();
  const settings = await post(fx, { view: 'settings', force: true });
  assert.equal(settings.status, 200);
  assert.deepEqual(settings.json.groups, []);
  assert.equal(typeof settings.json.revision, 'string');
  assert.deepEqual(fx.snapshot(), before);
});

test('成功冷却、新鲜数据、失败退避、禁用和失联均返回 200，只有实际排队才为 202', async (t) => {
  const fx = await startServer(t, { enabled: ['logs'] });
  const collector = fx.collector({ logs: async () => ({ inserted: 0 }) });
  await post(fx, { view: 'models', force: false });
  await collector.run('logs');
  const cooling = await post(fx, { view: 'models', force: true });
  assert.equal(cooling.status, 200);
  assert.equal(cooling.json.groups[0].state, 'cooldown');
  fx.heartbeatAt(BASE + 10_000);
  assert.equal((await post(fx, { view: 'models', force: false })).status, 200);
  assert.equal((await post(fx, { view: 'models', force: true })).status, 202);
  const failed = fx.workerStore.claim('logs');
  fx.workerStore.finish('logs', failed, '上游暂不可用');
  const error = await post(fx, { view: 'models', force: true });
  assert.equal(error.status, 200);
  assert.equal(error.json.groups[0].last_success_at, BASE);
  assert.match(error.json.groups[0].error, /上游暂不可用/);
  const disabled = await post(fx, { view: 'system', force: true });
  assert.equal(disabled.status, 200);
  assert.ok(disabled.json.groups.every((group) => group.state === 'disabled' && group.error));
  fx.setTime(BASE + 100_001);
  const lost = await post(fx, { view: 'models', force: true });
  assert.equal(lost.status, 200);
  assert.equal(lost.json.groups[0].state, 'disabled');
  assert.equal(lost.json.groups[0].request_id, error.json.groups[0].request_id);
  fx.heartbeatAt(BASE + 100_001);
  assert.equal((await post(fx, { view: 'models', force: true })).status, 202);
  fx.workerStore.register([]);
  const stopped = await post(fx, { view: 'models', force: true });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.json.groups[0].state, 'disabled');
});

test('POST 同源保护拒绝缺失、空、非法、跨主机、跨端口和协议不同的 Origin，且不写库', async (t) => {
  const fx = await startServer(t);
  const body = JSON.stringify({ view: 'models', force: false });
  const before = fx.snapshot();
  const url = new URL(fx.base);
  const otherPort = Number(url.port) === 65535 ? 1 : Number(url.port) + 1;
  const origins = [undefined, '', 'null', 'not-an-origin', 'https://evil.test',
    `http://localhost:${url.port}`, `http://127.0.0.1:${otherPort}`, fx.base.replace('http:', 'https:')];
  for (const origin of origins) {
    const headers = { 'content-type': 'application/json' };
    if (origin !== undefined) headers.origin = origin;
    const response = await call(fx.base, '/api/refresh', { method: 'POST', headers, body });
    assertError(response, 403, 'forbidden_origin');
    assert.deepEqual(fx.snapshot(), before, String(origin));
  }
});

test('同源 JSON 带 charset 可用，本机反代的 HTTPS Origin 与协议一致时可用', async (t) => {
  const fx = await startServer(t);
  const charset = await post(fx, { view: 'models', force: false }, {
    headers: { 'content-type': 'Application/JSON; charset=utf-8' },
  });
  assert.equal(charset.status, 202);
  const proxied = await post(fx, { view: 'models', force: true }, {
    headers: { origin: fx.base.replace('http:', 'https:'), 'x-forwarded-proto': 'https' },
  });
  assert.equal(proxied.status, 202);
  assert.equal(proxied.json.groups[0].request_id, charset.json.groups[0].request_id);
});

test('POST 拒绝缺少或错误的 Content-Type，拒绝后不入队', async (t) => {
  const fx = await startServer(t);
  const before = fx.snapshot();
  for (const contentType of [undefined, '', 'text/plain', 'application/jsonp', 'application/problem+json', 'application/x-www-form-urlencoded']) {
    const headers = { origin: fx.base };
    if (contentType !== undefined) headers['content-type'] = contentType;
    const response = await call(fx.base, '/api/refresh', {
      method: 'POST', headers, body: JSON.stringify({ view: 'models', force: false }),
    });
    assertError(response, 415, 'unsupported_media_type');
    assert.deepEqual(fx.snapshot(), before);
  }
});

test('POST 以字节限制一 KiB：恰好上限可用，超限及分块、UTF-8 超限均 413', async (t) => {
  const fx = await startServer(t);
  const value = { view: 'models', force: false };
  const json = JSON.stringify(value);
  const boundary = json + ' '.repeat(1024 - Buffer.byteLength(json));
  assert.equal(Buffer.byteLength(boundary), 1024);
  const accepted = await post(fx, value, { body: [boundary.slice(0, 500), boundary.slice(500)] });
  assert.equal(accepted.status, 202, accepted.text);
  const before = fx.snapshot();
  const multibyte = JSON.stringify({ view: '模'.repeat(400), force: false });
  assert.ok(multibyte.length < 1024 && Buffer.byteLength(multibyte) > 1024);
  for (const body of [boundary + ' ', [boundary.slice(0, 500), boundary.slice(500), ' '], multibyte]) {
    assertError(await post(fx, value, { body }), 413, 'payload_too_large');
    assert.deepEqual(fx.snapshot(), before);
  }
  assert.equal((await call(fx.base, '/api/healthz')).status, 200);
});

test('POST 严格检查对象字段和类型，坏 JSON 与空请求体可见报错且不写库', async (t) => {
  const fx = await startServer(t);
  const before = fx.snapshot();
  const invalid = [
    null, [], ['models', false], 'models', 1, false, {},
    { view: 'models' }, { force: false },
    { view: null, force: false }, { view: 1, force: false },
    { view: [], force: false }, { view: {}, force: false },
    ...[null, 0, 1, 'true', 'false', [], {}].map((force) => ({ view: 'models', force })),
    { view: 'models', force: false, resources: ['spend'] },
    { view: 'models', force: false, extra: true },
    JSON.parse('{"view":"models","force":false,"__proto__":{}}'),
  ];
  for (const body of invalid) {
    assertError(await post(fx, body), 400, 'invalid_refresh');
    assert.deepEqual(fx.snapshot(), before, JSON.stringify(body));
  }
  for (const body of ['', '{broken', '{"view":"models","force":false,}']) {
    assertError(await post(fx, null, { body }), 400, 'bad_json');
    assert.deepEqual(fx.snapshot(), before);
  }
});

test('GET/POST 拒绝未知页面和原型属性，HTTP 不允许任意指定采集资源', async (t) => {
  const fx = await startServer(t);
  const before = fx.snapshot();
  for (const view of ['', 'missing', 'logs', '__proto__', 'constructor', 'toString']) {
    assertError(await call(fx.base, `/api/refresh?view=${encodeURIComponent(view)}`), 400, 'bad_request');
    assertError(await post(fx, { view, force: false }), 400, 'bad_request');
    assert.deepEqual(fx.snapshot(), before);
  }
  assertError(await call(fx.base, '/api/refresh'), 400, 'bad_request');
  assert.deepEqual(fx.snapshot(), before);
});

test('不支持的方法返回 405，未注入采集状态返回明确的 503，均不写库', async (t) => {
  const fx = await startServer(t);
  const before = fx.snapshot();
  for (const method of ['PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    assertError(await call(fx.base, '/api/refresh?view=models', { method }), 405, 'method_not_allowed');
    assert.deepEqual(fx.snapshot(), before);
  }
  const missing = await startServer(t, { unavailable: true });
  const unavailableBefore = missing.snapshot();
  assertError(await call(missing.base, '/api/refresh?view=models'), 503, 'collector_unavailable');
  assertError(await post(missing, { view: 'models', force: false }), 503, 'collector_unavailable');
  assert.deepEqual(missing.snapshot(), unavailableBefore);
});

const ranged = (name) => `/api/${name}${RANGE}`;
for (const { resource, view, related, unrelated } of [
  {
    resource: 'logs', view: 'models',
    related: ['/api/meta', ranged('models'), ranged('overview'), ranged('status'), '/api/routes'],
    unrelated: [ranged('errors')],
  },
  {
    resource: 'spend', view: 'overview',
    related: ['capital', 'overview', 'profit', 'upstreams'].map(ranged),
    unrelated: ['models', 'errors', 'channels', 'groups'].map(ranged),
  },
  {
    resource: 'routes', view: 'routes',
    related: ['/api/routes', ranged('status'), ranged('channels'), ranged('groups')],
    unrelated: [ranged('models'), ranged('errors')],
  },
  {
    resource: 'errors', view: 'system', related: [ranged('status'), '/api/routes'],
    unrelated: [ranged('models'), ranged('errors')],
  },
  {
    resource: 'httpErrors', view: 'system', related: [ranged('errors')],
    unrelated: [ranged('models'), ranged('status'), '/api/routes'],
  },
]) {
  test(`${resource} 完成后相关业务 API 立即 MISS，无关 API 仍 HIT，排队和运行阶段不提前失效`, async (t) => {
    const fx = await startServer(t, { enabled: [resource] });
    const gate = fx.hold();
    const collector = fx.collector({ [resource]: () => gate.promise });
    const oldBodies = new Map();
    for (const pathname of [...related, ...unrelated]) {
      const first = await call(fx.base, pathname);
      assert.equal(first.status, 200, `${pathname}: ${first.text}`);
      assert.equal(first.headers['x-cache'], 'MISS', pathname);
      oldBodies.set(pathname, first.text);
      assert.equal((await call(fx.base, pathname)).headers['x-cache'], 'HIT', pathname);
    }
    const queued = await post(fx, { view, force: false });
    assert.equal(queued.status, 202);
    for (const pathname of related) {
      assert.equal((await call(fx.base, pathname)).headers['x-cache'], 'HIT', `${pathname} 只入队未完成`);
    }
    collector.drain();
    const completion = collector.run(resource);
    await nextTurn();
    for (const pathname of related) {
      assert.equal((await call(fx.base, pathname)).headers['x-cache'], 'HIT', `${pathname} 仍在执行`);
    }
    gate.resolve({ status: 'ok', inserted: 0 });
    await completion;
    for (const pathname of related) {
      const updated = await call(fx.base, pathname);
      assert.equal(updated.status, 200, updated.text);
      assert.equal(updated.headers['x-cache'], 'MISS', `${pathname} 完成后立即重查`);
      assert.equal((await call(fx.base, pathname)).headers['x-cache'], 'HIT', pathname);
    }
    for (const pathname of unrelated) {
      const unchanged = await call(fx.base, pathname);
      assert.equal(unchanged.headers['x-cache'], 'HIT', `${pathname} 不应被无关采集清空`);
      assert.equal(unchanged.text, oldBodies.get(pathname));
    }
  });
}

test('真实采集任务写入隔离日志后，下一次模型查询读到新增数据，无关入口错误仍 HIT', async (t) => {
  const fx = await startServer(t, { enabled: ['logs'] });
  const models = ranged('models');
  const errors = ranged('errors');
  const before = await call(fx.base, models);
  assert.equal(before.json.models[0].requests, 1);
  assert.equal(before.json.total_revenue, 1);
  await call(fx.base, errors);
  assert.equal((await call(fx.base, models)).headers['x-cache'], 'HIT');
  const collector = fx.collector({
    logs: async () => {
      fx.sourceWriter.prepare(`INSERT INTO logs
        SELECT 'collected', t_ms + 1000, t_local, channel_id, channel_name, model, token_name,
          2, quota_raw, input_total, input_uncached, cache_read, cache_write, output,
          latency_ms, first_token_ms, log_type FROM logs WHERE req_id = 'initial'`).run();
      return { inserted: 1, missing: false };
    },
  });
  assert.equal((await post(fx, { view: 'models', force: false })).status, 202);
  collector.drain();
  await collector.run('logs');
  const after = await call(fx.base, models);
  assert.equal(after.headers['x-cache'], 'MISS');
  assert.equal(after.json.models[0].requests, 2);
  assert.equal(after.json.total_revenue, 3);
  assert.equal((await call(fx.base, errors)).headers['x-cache'], 'HIT');
});

test('部分采集后保留旧成功时间，完成使相关查询重查，HTTP 状态保留失败原因', async (t) => {
  const fx = await startServer(t, { enabled: ['logs'] });
  const initial = fx.workerStore.claim('logs');
  fx.workerStore.finish('logs', initial);
  fx.heartbeatAt(BASE + 60_000);
  const models = ranged('models');
  await call(fx.base, models);
  assert.equal((await call(fx.base, models)).headers['x-cache'], 'HIT');
  const collector = fx.collector({ logs: async () => ({ status: 'partial' }) });
  const queued = await post(fx, { view: 'models', force: false });
  assert.equal(queued.status, 202);
  collector.drain();
  await collector.run('logs');
  const state = await call(fx.base, '/api/refresh?view=models');
  assert.equal(state.status, 200);
  assert.equal(state.json.groups[0].last_success_at, BASE);
  assert.ok(state.json.groups[0].error);
  assert.notEqual(state.json.revision, queued.json.revision);
  assert.equal((await call(fx.base, models)).headers['x-cache'], 'MISS');
});
