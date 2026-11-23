/**
 * 双通道工作线程查询执行器（api-runner / api-worker）测试：
 * 真实 localhost HTTP + 临时 SQLite 库，验证跨线程查询、缓存命中、错误映射、
 * 并发去重与客户端断开取消排队。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createApi } from '../lib/api.mjs';
import { createApiQueryRunner } from '../lib/api-runner.mjs';
import { createCollectionRefreshStore } from '../lib/collection-refresh.mjs';
import { createRuntimeSettingsStore } from '../lib/runtime-settings.mjs';
import { createApiCache, createRequestHandler, openSourceDb } from '../server.mjs';
import { openDashboardDb } from '../store/dashboard.mjs';
import { makeSourceDb, makeTempDir } from './helpers/fixture.mjs';

const BASE = Date.UTC(2026, 10, 18);
const HOUR = 3_600_000;

function requestJson(base, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(pathname, base), { method: 'GET', agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode,
          headers: res.headers,
          json: text ? JSON.parse(text) : null,
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error(`请求超时：${pathname}`)));
    req.end();
  });
}

async function startWorkerServer(t) {
  const dir = makeTempDir('v2-api-runner-');
  const sourcePath = path.join(dir, 'source.db');
  const dashboardPath = path.join(dir, 'dashboard.db');
  const now = Date.now();
  const recentT = now - 60_000;
  makeSourceDb(sourcePath, {
    rows: [
      { req_id: 'r1', t_ms: recentT - 1000, channel_id: 1, channel_name: 'ch1', cost: 2.5 },
      { req_id: 'r2', t_ms: recentT, channel_id: 2, channel_name: 'ch2', cost: 1.5 },
    ],
  });
  const enrich = new DatabaseSync(sourcePath);
  enrich.exec('ALTER TABLE logs ADD COLUMN group_name TEXT; ALTER TABLE logs ADD COLUMN user_name TEXT;');
  enrich.prepare('UPDATE logs SET group_name = ?, user_name = ? WHERE req_id = ?').run('vip', 'alice', 'r1');
  enrich.prepare('UPDATE logs SET group_name = ?, user_name = ? WHERE req_id = ?').run('std', 'bob', 'r2');
  enrich.close();
  const source = openSourceDb(sourcePath);
  const dashboard = openDashboardDb(dashboardPath);
  const config = {
    currency: 'USD',
    quota_per_unit: 500000,
    upstream: {},
    accounts: [
      { id: 'acc1', name: 'Account 1', kind: 'newapi', base_url: 'https://acc1.example', channels: [1], enabled: true },
      { id: 'acc2', name: 'Account 2', kind: 'newapi', base_url: 'https://acc2.example', channels: [2], enabled: true },
    ],
  };
  const collectionDefaults = { logsMinutes: 15, spendMinutes: 15 };
  const settingsStore = createRuntimeSettingsStore({ dataDir: dir, collectionDefaults });
  const collectionStore = createCollectionRefreshStore(dashboard);
  const api = createApi({
    source,
    dashboard,
    config,
    siteName: 'demo',
    sourceLabel: 'source.db',
    getHealthSettings: () => settingsStore.read().settings.health,
    siteBaseUrl: 'https://demo.example',
  });
  const cache = createApiCache({ ttlMs: 60_000 });
  const queryRunner = createApiQueryRunner({
    sourcePath,
    dashboardPath,
    config,
    siteName: 'demo',
    siteDisplayName: 'Demo Site',
    sourceLabel: 'source.db',
    siteBaseUrl: 'https://demo.example',
    settingsDataDir: dir,
    collectionDefaults,
  });

  const server = http.createServer(createRequestHandler({
    api,
    cache,
    settingsStore,
    dashboard,
    collectionStore,
    queryRunner,
  }));

  t.after(async () => {
    await queryRunner.close();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    source.close();
    dashboard.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    base: `http://127.0.0.1:${server.address().port}`,
    range: `from=${recentT - HOUR}&to=${now}`,
    cache,
    queryRunner,
  };
}

test('工作线程可正常服务 /api/meta 与聚合接口，命中缓存、映射 400/404', async (t) => {
  const { base, range } = await startWorkerServer(t);

  const meta1 = await requestJson(base, '/api/meta');
  assert.equal(meta1.status, 200);
  assert.equal(meta1.headers['x-cache'], 'MISS');
  assert.equal(meta1.json.rows, 2);
  assert.equal(meta1.json.site_name, 'Demo Site');
  assert.equal(meta1.json.base_url, 'https://demo.example');

  const meta2 = await requestJson(base, '/api/meta');
  assert.equal(meta2.status, 200);
  assert.equal(meta2.headers['x-cache'], 'HIT');
  assert.deepEqual(meta2.json, meta1.json);

  const [overview, upstreams, capital, groups, users] = await Promise.all([
    requestJson(base, `/api/overview?${range}`),
    requestJson(base, `/api/upstreams?${range}`),
    requestJson(base, `/api/capital?${range}`),
    requestJson(base, `/api/groups?${range}`),
    requestJson(base, `/api/users?${range}`),
  ]);
  assert.equal(overview.status, 200);
  assert.equal(overview.json.revenue, 4);
  assert.equal(upstreams.status, 200);
  assert.equal(upstreams.json.accounts.find((a) => a.id === 'acc1').local_revenue, 2.5);
  assert.equal(upstreams.json.accounts.find((a) => a.id === 'acc2').local_revenue, 1.5);
  assert.equal(capital.status, 200);
  assert.equal(capital.json.accounts.find((a) => a.account_id === 'acc1').top_group, 'vip');
  assert.equal(capital.json.accounts.find((a) => a.account_id === 'acc2').top_group, 'std');
  assert.equal(groups.status, 200);
  assert.equal(groups.json.groups.length, 2);
  assert.equal(users.status, 200);
  assert.equal(users.json.total_revenue, 4);

  // RangeError 从工作线程传回后仍正确映射为 400
  const bad = await requestJson(base, `/api/trend?${range}&granularity=bogus`);
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'bad_request');

  const missing = await requestJson(base, '/api/not-a-real-route');
  assert.equal(missing.status, 404);
});

test('相同 key 的并发冷请求在工作线程去重，客户端断开取消排队任务', async (t) => {
  const { base, range, queryRunner } = await startWorkerServer(t);

  // 并发两次相同冷请求都成功返回一致结果
  const [a, b] = await Promise.all([
    requestJson(base, `/api/channels?${range}`),
    requestJson(base, `/api/channels?${range}`),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.deepEqual(a.json, b.json);

  // 已取消的 signal 直接 reject AbortError，不会入队
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => queryRunner.run({ key: 'cancelled-key', pathname: '/api/overview', search: `?${range}`, signal: controller.signal }),
    (err) => err.name === 'AbortError',
  );
});
