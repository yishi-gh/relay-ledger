/**
 * 渠道归属派生：显式优先、origin 归一、直接/别名唯一、冲突歧义、只读不学习，
 * 以及各 API 使用同一份 effective 归属（售出合计一致、缓存随快照失效）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createApi, readRoutingSnapshotVersion } from '../lib/api.mjs';
import { buildChannelAssociations, normalizeChannelOrigin } from '../lib/channel-associations.mjs';
import { createApiCache, respondApi } from '../server.mjs';
import { replaceRoutingSnapshot, recordRoutingFailure, readRoutingSnapshot } from '../store/channel-routing.mjs';
import { openDashboardDb } from '../store/dashboard.mjs';
import { makeSourceDb, makeTempDir } from './helpers/fixture.mjs';

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const HOUR = 3_600_000;

function channel(id, baseUrl, extra = {}) {
  return { id, name: `c${id}`, status: 1, type: 1, base_url: baseUrl, model_mapping: null, ...extra };
}

function account(id, baseUrl, channels = [], extra = {}) {
  return { id, name: id, base_url: baseUrl, channels, enabled: true, ...extra };
}

// ---------------------------------------------------------------------------
// origin 归一
// ---------------------------------------------------------------------------

test('origin：协议/端口/大小写归一，路径忽略，userinfo 与非 http(s) 拒绝', () => {
  assert.equal(normalizeChannelOrigin('https://Example.COM:443/a?b=1#c'), 'https://example.com');
  assert.equal(normalizeChannelOrigin('http://Example.com:80/x'), 'http://example.com');
  assert.equal(normalizeChannelOrigin('https://x.example.com:8443/v1'), 'https://x.example.com:8443');
  assert.equal(normalizeChannelOrigin('https://user:pass@x.example.com/a'), null);
  assert.equal(normalizeChannelOrigin('ftp://x.example.com/a'), null);
  assert.equal(normalizeChannelOrigin('not a url'), null);
  assert.equal(normalizeChannelOrigin(null), null);
});

// ---------------------------------------------------------------------------
// 派生规则
// ---------------------------------------------------------------------------

test('显式 owner 绝对优先并保留多 owner，即使 base_url 也匹配', () => {
  const result = buildChannelAssociations({
    accounts: [account('a', 'https://a.example.com', [10]), account('b', null, [10])],
    channels: [channel(10, 'https://a.example.com/x')],
  });
  assert.deepEqual(result.owners.get(10), ['a', 'b']);
  assert.deepEqual(result.sources.get(10), { source: 'explicit', candidates: [] });
  assert.deepEqual(result.accounts.map((a) => a.auto_channels), [[], []]);
});

test('直接 origin 唯一 → auto；路径/端口/大小写不影响', () => {
  const result = buildChannelAssociations({
    accounts: [account('a', 'https://A.Example.com:443/console?x=1')],
    channels: [channel(10, 'https://a.example.com:443/v1/models')],
  });
  assert.deepEqual(result.owners.get(10), ['a']);
  assert.equal(result.sources.get(10).source, 'auto');
  assert.deepEqual(result.accounts[0].auto_channels, [10]);
  assert.deepEqual(result.accounts[0].channels, [10]);
});

test('显式别名 origin 唯一 → auto（无需 base_url 相同）', () => {
  const result = buildChannelAssociations({
    accounts: [account('a', null, [20])],
    channels: [
      channel(20, 'https://alias.example.com/one'),
      channel(30, 'https://alias.example.com/two'),
    ],
  });
  assert.deepEqual(result.owners.get(20), ['a'], '显式仍然优先');
  assert.deepEqual(result.owners.get(30), ['a']);
  assert.equal(result.sources.get(30).source, 'auto');
  assert.deepEqual(result.accounts[0].auto_channels, [30]);
});

test('两个来源合并后多候选 → ambiguous，不自动也不新增多 owner', () => {
  const result = buildChannelAssociations({
    accounts: [
      account('a', 'https://same.example.com'),
      account('b', null, [20]),
    ],
    channels: [
      channel(10, 'https://same.example.com/v1'),
      channel(20, 'https://same.example.com/v2'),
    ],
  });
  assert.deepEqual(result.owners.get(10), [], '歧义不允许自动多 owner');
  assert.equal(result.sources.get(10).source, 'ambiguous');
  assert.deepEqual(result.sources.get(10).candidates, ['a', 'b']);
  assert.deepEqual(result.accounts.map((a) => a.auto_channels), [[], []]);
});

test('零候选 → unmatched；停用账户与渠道仍参与', () => {
  const result = buildChannelAssociations({
    accounts: [
      account('off', 'https://off.example.com', [], { enabled: false }),
    ],
    channels: [channel(40, 'https://off.example.com/x', { status: 2 }), channel(50, 'https://none.example.com')],
  });
  assert.deepEqual(result.owners.get(40), ['off'], '停用账户仍归属');
  assert.equal(result.sources.get(50).source, 'unmatched');
  assert.deepEqual(result.owners.get(50), []);
});

test('纯派生：不修改 config，重复调用结果稳定（不二次学习）', () => {
  const accounts = [account('a', 'https://a.example.com')];
  const snapshot = JSON.stringify(accounts);
  const channels = [channel(10, 'https://a.example.com/x')];

  const first = buildChannelAssociations({ accounts, channels });
  const second = buildChannelAssociations({ accounts, channels });
  assert.equal(JSON.stringify(accounts), snapshot, 'accounts 不得被写入');
  assert.deepEqual(first.accounts[0].auto_channels, [10]);
  assert.deepEqual(second.accounts[0].auto_channels, [10]);
  assert.deepEqual(accounts[0].channels, [], '原配置 channels 不变');

  // 没有快照时只保留显式
  const empty = buildChannelAssociations({ accounts, channels: [] });
  assert.deepEqual(empty.accounts[0].channels, []);
  assert.deepEqual([...empty.owners.keys()], []);
});

test('API：同一实例在快照更新后自动换归属，无需重启', () => {
  const dir = makeTempDir('v2-assoc-live-');
  const sourceFile = path.join(dir, 'source.db');
  makeSourceDb(sourceFile);
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  const dashboard = openDashboardDb(path.join(dir, 'dashboard.db'));
  replaceRoutingSnapshot(dashboard, {
    channels: [channel(10, 'https://a.example.com/x')],
    abilities: [],
    routesAvailable: true,
    now: 1,
  });
  const api = createApi({
    source,
    dashboard,
    config: { accounts: [account('a', 'https://a.example.com')] },
    siteName: 't',
    sourceLabel: 's',
    now: () => NOW,
  });
  try {
    let graph = api.routeGraph();
    assert.equal(graph.channels[0].owner_source, 'auto');
    assert.deepEqual(graph.channels[0].account_ids, ['a']);
    assert.deepEqual(graph.accounts[0].auto_channels, [10]);
    assert.deepEqual(graph.accounts[0].channel_ids, [10]);

    replaceRoutingSnapshot(dashboard, {
      channels: [channel(10, 'https://other.example.com/x')],
      abilities: [],
      routesAvailable: true,
      now: 2,
    });
    graph = api.routeGraph();
    assert.equal(graph.channels[0].owner_source, 'unmatched');
    assert.deepEqual(graph.channels[0].account_ids, []);
    assert.deepEqual(graph.accounts[0].auto_channels, []);
  } finally {
    source.close();
    dashboard.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('缓存：快照身份变化后旧 HIT 失效', () => {
  const dir = makeTempDir('v2-assoc-cache-');
  const sourceFile = path.join(dir, 'source.db');
  makeSourceDb(sourceFile);
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  const dashboard = openDashboardDb(path.join(dir, 'dashboard.db'));
  replaceRoutingSnapshot(dashboard, {
    channels: [channel(10, 'https://a.example.com/x')],
    abilities: [],
    routesAvailable: true,
    now: 111,
  });
  const api = createApi({
    source,
    dashboard,
    config: { accounts: [account('a', 'https://a.example.com')] },
    siteName: 't',
    sourceLabel: 's',
  });
  const cache = createApiCache({ ttlMs: 60_000 });
  const url = new URL('http://x/api/routes');
  try {
    const first = respondApi({ api, cache, pathname: '/api/routes', url });
    assert.equal(first.cache, 'MISS');
    assert.equal(respondApi({ api, cache, pathname: '/api/routes', url }).cache, 'HIT');

    replaceRoutingSnapshot(dashboard, {
      channels: [channel(10, 'https://other.example.com/x')],
      abilities: [],
      routesAvailable: true,
      now: 111,
    });
    const third = respondApi({ api, cache, pathname: '/api/routes', url });
    assert.equal(third.cache, 'MISS', '快照更新后不得复用旧 HIT');
    assert.equal(JSON.parse(third.payload).channels[0].owner_source, 'unmatched');
  } finally {
    source.close();
    dashboard.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('缓存：同一 synced_at 下 payload 变化 / 失败记录都会换版本', () => {
  const dir = makeTempDir('v2-assoc-cache2-');
  const sourceFile = path.join(dir, 'source.db');
  makeSourceDb(sourceFile);
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  const dashboard = openDashboardDb(path.join(dir, 'dashboard.db'));
  replaceRoutingSnapshot(dashboard, {
    channels: [channel(10, 'https://a.example.com/x')],
    abilities: [],
    routesAvailable: true,
    now: 500,
  });
  const api = createApi({
    source,
    dashboard,
    config: { accounts: [account('a', 'https://a.example.com')] },
    siteName: 't',
    sourceLabel: 's',
  });
  const cache = createApiCache({ ttlMs: 60_000 });
  const url = new URL('http://x/api/routes');
  try {
    assert.equal(respondApi({ api, cache, pathname: '/api/routes', url }).cache, 'MISS');
    assert.equal(respondApi({ api, cache, pathname: '/api/routes', url }).cache, 'HIT');

    // synced_at 不变，只换 payload → 必须失效
    replaceRoutingSnapshot(dashboard, {
      channels: [channel(10, 'https://other.example.com/x')],
      abilities: [],
      routesAvailable: true,
      now: 500,
    });
    const changed = respondApi({ api, cache, pathname: '/api/routes', url });
    assert.equal(changed.cache, 'MISS', '同一 synced_at 的 payload 变化也要失效');
    assert.equal(JSON.parse(changed.payload).channels[0].owner_source, 'unmatched');

    // 恢复成功快照，再记录一次失败（payload 不变，last_error/last_attempt 变）
    replaceRoutingSnapshot(dashboard, {
      channels: [channel(10, 'https://a.example.com/x')],
      abilities: [],
      routesAvailable: true,
      now: 600,
    });
    assert.equal(respondApi({ api, cache, pathname: '/api/routes', url }).cache, 'MISS');
    assert.equal(respondApi({ api, cache, pathname: '/api/routes', url }).cache, 'HIT');

    recordRoutingFailure(dashboard, { error: 'boom', now: 600 });
    const failed = respondApi({ api, cache, pathname: '/api/routes', url });
    assert.equal(failed.cache, 'MISS', '同步失败记录必须让旧 HIT 失效');
    const body = JSON.parse(failed.payload);
    assert.equal(body.error, 'boom');
    assert.equal(body.channels[0].owner_source, 'auto');
  } finally {
    source.close();
    dashboard.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('缓存版本：坏 payload 不做 JSON parse；缺表为 none', () => {
  const dir = makeTempDir('v2-assoc-version-');
  try {
    const dashboard = openDashboardDb(path.join(dir, 'dashboard.db'));
    dashboard.prepare(
      `INSERT INTO channel_routing_snapshot (id, payload, synced_at, last_attempt_at, last_error)
       VALUES (1, '42', 7, 7, NULL)`,
    ).run();
    const version = readRoutingSnapshotVersion(dashboard);
    assert.equal(typeof version, 'string');
    assert.notEqual(version, 'none');
    assert.equal(readRoutingSnapshot(dashboard).available, false, '坏 payload 仍按损坏标记');
    dashboard.close();

    const raw = new DatabaseSync(path.join(dir, 'raw.db'));
    try {
      assert.equal(readRoutingSnapshotVersion(raw), 'none', '缺表按未采集');
    } finally {
      raw.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 各 API 归属一致
// ---------------------------------------------------------------------------

function revenueFixture() {
  const dir = makeTempDir('v2-assoc-revenue-');
  const sourceFile = path.join(dir, 'source.db');
  makeSourceDb(sourceFile, {
    rows: [
      { req_id: 'r1', t_ms: NOW - HOUR, channel_id: 10, cost: 10 },
      { req_id: 'r2', t_ms: NOW - HOUR, channel_id: 99, cost: 2 },
    ],
  });
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  const dashboard = openDashboardDb(path.join(dir, 'dashboard.db'));
  replaceRoutingSnapshot(dashboard, {
    channels: [channel(10, 'https://a.example.com/x')],
    abilities: [],
    routesAvailable: true,
    now: 1,
  });
  const api = createApi({
    source,
    dashboard,
    config: { accounts: [account('a', 'https://a.example.com')] },
    siteName: 't',
    sourceLabel: 's',
    now: () => NOW,
  });
  const params = new URLSearchParams({ from: String(NOW - 2 * HOUR), to: String(NOW) });
  return {
    api,
    params,
    close() {
      source.close();
      dashboard.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('售出归属一致：overview = profit 各账户 + unmapped，channels/models 同步识别', () => {
  const fx = revenueFixture();
  try {
    const overview = fx.api.overview(fx.params);
    const profit = fx.api.profit(new URLSearchParams(fx.params));
    const siteRevenue = profit.sites.reduce((sum, site) => sum + site.revenue, 0);
    assert.equal(overview.revenue, 12);
    assert.equal(overview.revenue, siteRevenue + profit.unmapped.revenue);
    assert.equal(profit.sites[0].revenue, 10, '自动归属渠道的售出记到唯一账户');
    assert.equal(profit.unmapped.revenue, 2, '无归属渠道进 unmapped');

    const channels = fx.api.channels(fx.params);
    const auto = channels.rows.find((row) => row.channel_id === 10);
    assert.equal(auto.upstream_account, 'a');
    assert.notEqual(auto.margin_status, 'unconfigured', '自动归属不能显示未配置');

    const models = fx.api.models(fx.params);
    const model = models.models[0];
    assert.deepEqual(model.upstream_accounts, ['a']);

    const upstreams = fx.api.upstreams(fx.params);
    const acc = upstreams.accounts.find((row) => row.id === 'a');
    assert.deepEqual(acc.channels, [10]);
    assert.deepEqual(acc.auto_channels, [10]);
    assert.equal(acc.local_revenue, 10);
    assert.equal(acc.opening_balance, null, '未采余额仍为 null，不被自动归属伪造');
    assert.equal(acc.consumption, null);
  } finally {
    fx.close();
  }
});

test('坏快照：显式归属保留，自动为空，路由错误可见', () => {
  const dir = makeTempDir('v2-assoc-bad-');
  const sourceFile = path.join(dir, 'source.db');
  makeSourceDb(sourceFile);
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  const dashboard = openDashboardDb(path.join(dir, 'dashboard.db'));
  dashboard.prepare(
    `INSERT INTO channel_routing_snapshot (id, payload, synced_at, last_attempt_at, last_error)
     VALUES (1, '42', 1, 1, NULL)`,
  ).run();
  const api = createApi({
    source,
    dashboard,
    config: { accounts: [account('a', 'https://a.example.com', [10])] },
    siteName: 't',
    sourceLabel: 's',
    now: () => NOW,
  });
  try {
    const graph = api.routeGraph();
    assert.equal(graph.available, false);
    assert.deepEqual(graph.channels, []);
    assert.deepEqual(graph.accounts[0].channel_ids, [10], '显式归属不因坏快照丢失');
    assert.deepEqual(graph.accounts[0].auto_channels, []);
  } finally {
    source.close();
    dashboard.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
