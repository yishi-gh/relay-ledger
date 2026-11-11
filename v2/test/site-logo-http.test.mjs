/**
 * /api/site-logo：来源解析只认渠道快照/账户配置，HTTP 层注入 logoService，纯 fixture 无网络。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createApi } from '../lib/api.mjs';
import { createApiCache, createRequestHandler } from '../server.mjs';
import { replaceRoutingSnapshot } from '../store/channel-routing.mjs';
import { openDashboardDb } from '../store/dashboard.mjs';
import { makeSourceDb, makeTempDir } from './helpers/fixture.mjs';

const ACCOUNTS = [
  {
    id: 'acct-a',
    name: 'A',
    base_url: 'https://user:pass@a.example.com:8443/console?x=1',
    channels: [10, 20],
  },
  {
    id: 'acct-b',
    name: 'B',
    base_url: 'https://b.example.com',
    channels: [20],
  },
  {
    id: 'acct-c',
    name: 'C',
    base_url: 'not a url',
    channels: [30],
  },
];

const CHANNELS = [
  { id: 10, name: '有入口', status: 1, type: 1, base_url: 'https://user:pass@up.example.com:9443/v1?q=1', model_mapping: null },
  { id: 20, name: '无入口', status: 1, type: 1, base_url: null, model_mapping: null },
  { id: 30, name: '无入口且账户网站非法', status: 1, type: 1, base_url: null, model_mapping: null },
  { id: 40, name: '无归属', status: 1, type: 1, base_url: null, model_mapping: null },
];

function apiFixture() {
  const dir = makeTempDir('v2-site-logo-');
  const sourceFile = path.join(dir, 'source.db');
  makeSourceDb(sourceFile);
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  const dashboard = openDashboardDb(path.join(dir, 'dashboard.db'));
  replaceRoutingSnapshot(dashboard, {
    channels: CHANNELS,
    abilities: [],
    routesAvailable: true,
    now: 1,
  });
  const api = createApi({
    source,
    dashboard,
    config: { currency: 'USD', quota_per_unit: 500000, accounts: ACCOUNTS },
    siteName: 'test',
    sourceLabel: 'source.db',
  });
  return {
    api,
    close() {
      source.close();
      dashboard.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// 纯 metadata 来源
// ---------------------------------------------------------------------------

test('siteLogoSource：channel 优先快照 endpoint，只留 http(s) origin', () => {
  const fx = apiFixture();
  try {
    assert.equal(fx.api.siteLogoSource({ kind: 'channel', id: '10' }), 'https://up.example.com:9443');
    assert.equal(fx.api.siteLogoSource({ kind: 'channel', id: 10 }), 'https://up.example.com:9443');
  } finally {
    fx.close();
  }
});

test('siteLogoSource：channel 无 endpoint 时只在唯一账户网站时回退', () => {
  const fx = apiFixture();
  try {
    // 渠道 20 归属 A、B 两个账户，网站不同 → 不猜
    assert.equal(fx.api.siteLogoSource({ kind: 'channel', id: '20' }), null);
    // 渠道 40 无归属 → null
    assert.equal(fx.api.siteLogoSource({ kind: 'channel', id: '40' }), null);
    // 渠道 30 唯一归属 C，但 C 的网站不是 http(s) → null
    assert.equal(fx.api.siteLogoSource({ kind: 'channel', id: '30' }), null);
  } finally {
    fx.close();
  }
});

test('siteLogoSource：account 用配置 origin，未知 kind/id 返回 null', () => {
  const fx = apiFixture();
  try {
    assert.equal(fx.api.siteLogoSource({ kind: 'account', id: 'acct-a' }), 'https://a.example.com:8443');
    assert.equal(fx.api.siteLogoSource({ kind: 'account', id: 'acct-b' }), 'https://b.example.com');
    assert.equal(fx.api.siteLogoSource({ kind: 'account', id: 'acct-c' }), null);
    assert.equal(fx.api.siteLogoSource({ kind: 'account', id: 'missing' }), null);
    assert.equal(fx.api.siteLogoSource({ kind: 'other', id: '10' }), null);
    assert.equal(fx.api.siteLogoSource({ kind: 'channel', id: 'abc' }), null);
  } finally {
    fx.close();
  }
});

test('siteLogoSource：单账户单网站回退生效', () => {
  const dir = makeTempDir('v2-site-logo-single-');
  const sourceFile = path.join(dir, 'source.db');
  makeSourceDb(sourceFile);
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  const dashboard = openDashboardDb(path.join(dir, 'dashboard.db'));
  try {
    replaceRoutingSnapshot(dashboard, {
      channels: [{ id: 50, name: 'x', status: 1, type: 1, base_url: null, model_mapping: null }],
      abilities: [],
      routesAvailable: true,
      now: 1,
    });
    const api = createApi({
      source,
      dashboard,
      config: { accounts: [{ id: 'only', base_url: 'https://only.example.com/x', channels: [50] }] },
      siteName: 't',
      sourceLabel: 's',
    });
    assert.equal(api.siteLogoSource({ kind: 'channel', id: '50' }), 'https://only.example.com');
  } finally {
    source.close();
    dashboard.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('siteLogoSource：多 owner 同一网站去重后唯一仍可回退', () => {
  const dir = makeTempDir('v2-site-logo-shared-');
  const sourceFile = path.join(dir, 'source.db');
  makeSourceDb(sourceFile);
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  const dashboard = openDashboardDb(path.join(dir, 'dashboard.db'));
  try {
    replaceRoutingSnapshot(dashboard, {
      channels: [{ id: 60, name: 'x', status: 1, type: 1, base_url: null, model_mapping: null }],
      abilities: [],
      routesAvailable: true,
      now: 1,
    });
    const api = createApi({
      source,
      dashboard,
      config: {
        accounts: [
          { id: 'a', base_url: 'https://shared.example.com/one', channels: [60] },
          { id: 'b', base_url: 'https://shared.example.com/two', channels: [60] },
        ],
      },
      siteName: 't',
      sourceLabel: 's',
    });
    assert.equal(api.siteLogoSource({ kind: 'channel', id: '60' }), 'https://shared.example.com');
  } finally {
    source.close();
    dashboard.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('siteLogoSource：site/current 只来自注入的 siteBaseUrl，不读 dashboard', () => {
  const dir = makeTempDir('v2-site-logo-site-');
  const sourceFile = path.join(dir, 'source.db');
  makeSourceDb(sourceFile);
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  // 空 dashboard（无任何表）：证明 site 图标不依赖快照/看板库
  const emptyDashboard = new DatabaseSync(path.join(dir, 'empty.db'));
  try {
    const api = createApi({
      source,
      dashboard: emptyDashboard,
      config: { accounts: [] },
      siteName: 't',
      sourceLabel: 's',
      siteBaseUrl: 'https://newapi.example.com/console?x=1#frag',
    });
    assert.equal(api.siteLogoSource({ kind: 'site', id: 'current' }), 'https://newapi.example.com');
    assert.equal(api.siteLogoSource({ kind: 'site', id: 'other' }), null);
    assert.equal(api.siteLogoSource({ kind: 'site' }), null);

    const noSite = createApi({
      source,
      dashboard: emptyDashboard,
      config: { accounts: [] },
      siteName: 't',
      sourceLabel: 's',
    });
    assert.equal(noSite.siteLogoSource({ kind: 'site', id: 'current' }), null);
  } finally {
    source.close();
    emptyDashboard.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

async function startServer(t, getLogo) {
  const handler = createRequestHandler({
    api: null,
    cache: createApiCache({ ttlMs: 0 }),
    settingsStore: null,
    dashboard: null,
    logoService: { getLogo },
  });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('HTTP /api/site-logo：成功返回二进制、缓存 86400、安全头齐全', async (t) => {
  const base = await startServer(t, async ({ kind, id }) => (
    kind === 'channel' && id === '10' ? { body: PNG, contentType: 'image/png' } : null
  ));
  const res = await fetch(`${base}/api/site-logo?kind=channel&id=10`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('cache-control'), 'private, max-age=86400');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-security-policy'), /sandbox.*default-src 'none'/);
  const body = Buffer.from(await res.arrayBuffer());
  assert.deepEqual(body, PNG);

  const head = await fetch(`${base}/api/site-logo?kind=channel&id=10`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-type'), 'image/png');
  assert.equal(head.headers.get('cache-control'), 'private, max-age=86400');
  assert.equal(await head.text(), '');
});

test('HTTP /api/site-logo：site/current 使用注入服务，严格 id 与额外参数', async (t) => {
  const calls = [];
  const base = await startServer(t, async (input) => {
    calls.push(input);
    return input.kind === 'site' && input.id === 'current'
      ? { body: PNG, contentType: 'image/png' }
      : null;
  });
  const res = await fetch(`${base}/api/site-logo?kind=site&id=current`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('cache-control'), 'private, max-age=86400');
  assert.deepEqual(calls, [{ kind: 'site', id: 'current' }]);

  const head = await fetch(`${base}/api/site-logo?kind=site&id=current`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');

  assert.equal((await fetch(`${base}/api/site-logo?kind=site&id=other`)).status, 400);
  assert.equal((await fetch(`${base}/api/site-logo?kind=site&id=current&url=https://evil.test`)).status, 400);
  assert.equal((await fetch(`${base}/api/site-logo?kind=site`)).status, 400);
});

test('HTTP /api/site-logo：site 未找到同样 404 + 6 小时缓存', async (t) => {
  const base = await startServer(t, async () => null);
  const res = await fetch(`${base}/api/site-logo?kind=site&id=current`);
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('cache-control'), 'private, max-age=21600');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-security-policy'), /sandbox/);
});

test('HTTP /api/site-logo：v=2 与旧 URL 兼容，非法 v/额外参数拒绝', async (t) => {
  const calls = [];
  const base = await startServer(t, async (input) => {
    calls.push(input);
    return { body: PNG, contentType: 'image/png' };
  });

  const v2 = await fetch(`${base}/api/site-logo?kind=channel&id=10&v=2`);
  assert.equal(v2.status, 200);
  assert.equal(v2.headers.get('content-type'), 'image/png');
  assert.deepEqual(calls[0], { kind: 'channel', id: '10' });

  const legacy = await fetch(`${base}/api/site-logo?kind=channel&id=10`);
  assert.equal(legacy.status, 200, '无 v 的旧 URL 仍兼容');

  const site = await fetch(`${base}/api/site-logo?kind=site&id=current&v=2`);
  assert.equal(site.status, 200);

  const head = await fetch(`${base}/api/site-logo?kind=channel&id=10&v=2`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');

  for (const suffix of ['v=1', 'v=', 'v=2&v=3']) {
    const res = await fetch(`${base}/api/site-logo?kind=channel&id=10&${suffix}`);
    assert.equal(res.status, 400, suffix);
  }
  const extra = await fetch(`${base}/api/site-logo?kind=channel&id=10&v=2&url=https://evil.test`);
  assert.equal(extra.status, 400, '任意 URL 入口仍然没有');
});

test('HTTP /api/site-logo：未找到 404 + 6 小时失败缓存 + 安全头', async (t) => {
  const base = await startServer(t, async () => null);
  const res = await fetch(`${base}/api/site-logo?kind=account&id=acct-a`);
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('cache-control'), 'private, max-age=21600');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-security-policy'), /sandbox/);
  const body = await res.json();
  assert.equal(body.error.code, 'not_found');

  const head = await fetch(`${base}/api/site-logo?kind=account&id=acct-a`, { method: 'HEAD' });
  assert.equal(head.status, 404);
  assert.equal(await head.text(), '');
});

test('HTTP /api/site-logo：kind/id/额外参数非法一律 400，PATCH 405', async (t) => {
  const base = await startServer(t, async () => ({ body: PNG, contentType: 'image/png' }));
  for (const query of [
    'kind=logo&id=10',
    'kind=channel&id=abc',
    'kind=channel',
    'kind=channel&id=10&url=https://evil.test',
    'kind=account&id=../etc',
  ]) {
    const res = await fetch(`${base}/api/site-logo?${query}`);
    assert.equal(res.status, 400, query);
  }
  const patch = await fetch(`${base}/api/site-logo?kind=channel&id=10`, { method: 'PATCH', body: '{}' });
  assert.equal(patch.status, 405);
});
