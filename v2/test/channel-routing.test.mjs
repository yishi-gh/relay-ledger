/**
 * 渠道路由配置快照：源库 channels + abilities → 看板库 → /api/routes。
 *
 * 覆盖：一致读快照、缺 abilities 与从未采集的区别、失败保留旧快照、
 * 空配置合法、无流量渠道保留、停用/未知状态、多分组同名模型、未映射/多归属、
 * model_mapping 只作附注、URL 去敏感信息、HTTP DTO 与 HEAD。
 * 全部临时目录 + 真实 SQLite，不接触生产库。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createApi } from '../lib/api.mjs';
import { createApiCache, createRequestHandler } from '../server.mjs';
import { syncChannelStates } from '../jobs/run-scheduler.mjs';
import {
  readRoutingSnapshot,
  recordRoutingFailure,
  replaceRoutingSnapshot,
} from '../store/channel-routing.mjs';
import { openDashboardDb } from '../store/dashboard.mjs';
import { readChannelStates } from '../store/channel-state.mjs';
import { makeSourceDb, makeTempDir } from './helpers/fixture.mjs';

const BASE_CHANNEL_COLUMNS =
  'id INTEGER PRIMARY KEY, name TEXT, type INTEGER, status INTEGER, base_url TEXT, model_mapping TEXT';

function makeRelayDb(file, { channels = [], abilities = null, narrowChannels = false } = {}) {
  const db = new DatabaseSync(file);
  db.exec(
    narrowChannels
      ? 'CREATE TABLE channels (id INTEGER PRIMARY KEY, name TEXT, status INTEGER, base_url TEXT)'
      : `CREATE TABLE channels (${BASE_CHANNEL_COLUMNS})`,
  );
  if (abilities !== null) {
    db.exec(
      `CREATE TABLE abilities (
         "group" TEXT, model TEXT, channel_id INTEGER, enabled INTEGER,
         priority INTEGER, weight INTEGER
       )`,
    );
    const insAbility = db.prepare(
      'INSERT INTO abilities ("group", model, channel_id, enabled, priority, weight) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const row of abilities) {
      insAbility.run(row.group, row.model, row.channelId, row.enabled ?? 1, row.priority ?? 0, row.weight ?? 1);
    }
  }
  if (narrowChannels) {
    const ins = db.prepare('INSERT INTO channels (id, name, status, base_url) VALUES (?, ?, ?, ?)');
    for (const row of channels) ins.run(row.id, row.name, row.status, row.baseUrl ?? null);
  } else {
    const ins = db.prepare(
      'INSERT INTO channels (id, name, type, status, base_url, model_mapping) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const row of channels) {
      ins.run(
        row.id,
        row.name,
        row.type ?? 1,
        row.status ?? null,
        row.baseUrl ?? null,
        row.modelMapping ?? null,
      );
    }
  }
  db.close();
}

function workspace({ channels = [], abilities = null, narrowChannels = false } = {}) {
  const dir = makeTempDir('v2-routing-');
  const relayFile = path.join(dir, 'one-api.db');
  makeRelayDb(relayFile, { channels, abilities, narrowChannels });
  const dashboard = openDashboardDb(path.join(dir, 'dashboard.db'));
  return {
    dir,
    relayFile,
    dashboard,
    close() {
      dashboard.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const CHANNELS = [
  {
    id: 10,
    name: '主力',
    status: 1,
    baseUrl: 'https://user:pass@up.example.com:9443/v1?x=1#frag',
    modelMapping: '{"gpt-4o":"gpt-4o-mini"}',
  },
  { id: 20, name: '停用', status: 2, baseUrl: 'not a url', modelMapping: '{bad json' },
  { id: 30, name: '未知', status: null, baseUrl: null, modelMapping: null },
  { id: 40, name: '协议不对', status: 3, baseUrl: 'ftp://files.example.com/x', modelMapping: null },
];

const ABILITIES = [
  { group: 'default', model: 'gpt-4o', channelId: 10, enabled: 1, priority: 0, weight: 1 },
  { group: 'vip', model: 'gpt-4o', channelId: 10, enabled: 1, priority: 1, weight: 2 },
  { group: 'default', model: 'gpt-4o', channelId: 20, enabled: 0, priority: 0, weight: 1 },
];

function apiFor(dir, { accounts = [] } = {}) {
  const sourceFile = path.join(dir, 'source.db');
  if (!fs.existsSync(sourceFile)) makeSourceDb(sourceFile);
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  const dashboard = openDashboardDb(path.join(dir, 'dashboard.db'));
  const api = createApi({
    source,
    dashboard,
    config: {
      currency: 'USD',
      quota_per_unit: 500000,
      accounts,
    },
    siteName: 'test',
    sourceLabel: 'source.db',
  });
  return {
    api,
    close() {
      source.close();
      dashboard.close();
    },
  };
}

const ACCOUNTS = [
  {
    id: 'acct-a',
    name: '账户 A',
    base_url: 'https://user:pass@a.example.com:8443/console?tab=1',
    channels: [10, 20, 30],
    enabled: true,
    auth: { token: 'super-secret-token', cookie: 'session=secret-cookie' },
  },
  {
    id: 'acct-b',
    name: '账户 B（停用）',
    base_url: 'https://b.example.com',
    channels: [20],
    enabled: false,
  },
];

// ---------------------------------------------------------------------------
// 快照存储
// ---------------------------------------------------------------------------

test('快照存储：成功覆盖、失败保留旧 payload、空快照是合法可用', () => {
  const dir = makeTempDir('v2-routing-store-');
  const db = openDashboardDb(path.join(dir, 'dashboard.db'));
  try {
    assert.equal(readRoutingSnapshot(db).available, false);

    replaceRoutingSnapshot(db, {
      channels: [{ id: 1 }],
      abilities: [],
      routesAvailable: true,
      now: 1000,
    });
    let snapshot = readRoutingSnapshot(db);
    assert.equal(snapshot.available, true);
    assert.equal(snapshot.synced_at, 1000);
    assert.deepEqual(snapshot.payload.channels, [{ id: 1 }]);

    recordRoutingFailure(db, { error: 'boom', now: 2000 });
    snapshot = readRoutingSnapshot(db);
    assert.equal(snapshot.available, true, '失败不得清空旧快照');
    assert.equal(snapshot.synced_at, 1000);
    assert.equal(snapshot.last_attempt_at, 2000);
    assert.equal(snapshot.error, 'boom');

    // 空 channels / 0 abilities 是「已采集到的空」，不是未采集
    replaceRoutingSnapshot(db, {
      channels: [],
      abilities: [],
      routesAvailable: true,
      now: 3000,
    });
    snapshot = readRoutingSnapshot(db);
    assert.equal(snapshot.available, true);
    assert.deepEqual(snapshot.payload.channels, []);
    assert.equal(snapshot.payload.routes_available, true);
    assert.equal(snapshot.error, null);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 源库同步
// ---------------------------------------------------------------------------

test('同步：channels + abilities 一致写入，channel_state 行为不变', () => {
  const fx = workspace({ channels: CHANNELS, abilities: ABILITIES });
  try {
    assert.equal(syncChannelStates(fx.dashboard, fx.relayFile), 4);

    const states = readChannelStates(fx.dashboard);
    assert.equal(states.size, 4);
    assert.equal(states.get(10).status, 1);

    const snapshot = readRoutingSnapshot(fx.dashboard);
    assert.equal(snapshot.available, true);
    assert.equal(snapshot.error, null);
    assert.equal(snapshot.payload.routes_available, true);
    assert.equal(snapshot.payload.channels.length, 4);
    assert.equal(snapshot.payload.abilities.length, 3);
    assert.equal(snapshot.payload.channels.find((c) => c.id === 10).base_url.includes('user:'), true);
  } finally {
    fx.close();
  }
});

test('同步：缺 abilities 表时渠道仍然同步，路由标记不可用并给原因', () => {
  const fx = workspace({ channels: CHANNELS, abilities: null });
  try {
    assert.equal(syncChannelStates(fx.dashboard, fx.relayFile), 4);
    const snapshot = readRoutingSnapshot(fx.dashboard);
    assert.equal(snapshot.available, true);
    assert.equal(snapshot.payload.routes_available, false);
    assert.match(snapshot.payload.routes_error, /abilities/);
    assert.deepEqual(snapshot.payload.abilities, []);
  } finally {
    fx.close();
  }
});

test('同步：首次缺源可用性为 false 且错误可见', () => {
  const dir = makeTempDir('v2-routing-missing-');
  const dashboard = openDashboardDb(path.join(dir, 'dashboard.db'));
  try {
    assert.throws(
      () => syncChannelStates(dashboard, path.join(dir, 'nope.db')),
      /源库不存在/,
    );
    const snapshot = readRoutingSnapshot(dashboard);
    assert.equal(snapshot.available, false);
    assert.equal(snapshot.synced_at, null);
    assert.equal(typeof snapshot.last_attempt_at, 'number');
    assert.match(snapshot.error, /源库不存在/);
  } finally {
    dashboard.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('同步：后续失败保留旧成功快照，只更新尝试时间与错误', () => {
  const fx = workspace({ channels: CHANNELS, abilities: ABILITIES });
  try {
    assert.equal(syncChannelStates(fx.dashboard, fx.relayFile), 4);
    const before = readRoutingSnapshot(fx.dashboard);

    fs.rmSync(fx.relayFile);
    assert.throws(() => syncChannelStates(fx.dashboard, fx.relayFile), /源库不存在/);

    const after = readRoutingSnapshot(fx.dashboard);
    assert.equal(after.available, true, '旧快照必须保留');
    assert.equal(after.synced_at, before.synced_at);
    assert.ok(after.last_attempt_at >= before.last_attempt_at);
    assert.match(after.error, /源库不存在/);
    assert.equal(after.payload.channels.length, 4);
  } finally {
    fx.close();
  }
});

test('同步：channels 读取失败仍抛错，旧快照保留且错误可见', () => {
  const fx = workspace({ channels: CHANNELS, abilities: ABILITIES });
  try {
    assert.equal(syncChannelStates(fx.dashboard, fx.relayFile), 4);
    const before = readRoutingSnapshot(fx.dashboard);

    const relay = new DatabaseSync(fx.relayFile);
    relay.exec('DROP TABLE channels');
    relay.close();

    assert.throws(() => syncChannelStates(fx.dashboard, fx.relayFile), /channels/);

    const after = readRoutingSnapshot(fx.dashboard);
    assert.equal(after.available, true, '旧 payload 不得被清空');
    assert.equal(after.synced_at, before.synced_at);
    assert.match(after.error, /channels/);
    assert.equal(readChannelStates(fx.dashboard).size, 4, 'channel_state 保持上一次成功结果');
  } finally {
    fx.close();
  }
});

test('同步：空 channels / 0 abilities 与未采集可区分', () => {
  const fx = workspace({ channels: [], abilities: [] });
  try {
    assert.equal(syncChannelStates(fx.dashboard, fx.relayFile), 0);
    const snapshot = readRoutingSnapshot(fx.dashboard);
    assert.equal(snapshot.available, true);
    assert.deepEqual(snapshot.payload.channels, []);
    assert.deepEqual(snapshot.payload.abilities, []);
    assert.equal(snapshot.payload.routes_available, true);
  } finally {
    fx.close();
  }
});

test('同步：老库只有四列 channels 时仍可同步，路由快照补 null', () => {
  const fx = workspace({ channels: CHANNELS, abilities: ABILITIES, narrowChannels: true });
  try {
    assert.equal(syncChannelStates(fx.dashboard, fx.relayFile), 4);
    const snapshot = readRoutingSnapshot(fx.dashboard);
    assert.equal(snapshot.payload.channels.find((c) => c.id === 10).type, null);
    assert.equal(snapshot.payload.channels.find((c) => c.id === 10).model_mapping, null);
  } finally {
    fx.close();
  }
});

// ---------------------------------------------------------------------------
// API DTO
// ---------------------------------------------------------------------------

test('/api/routes：全部渠道保留，状态/归属/映射与 URL 清洗正确', () => {
  const fx = workspace({ channels: CHANNELS, abilities: ABILITIES });
  try {
    syncChannelStates(fx.dashboard, fx.relayFile);
    const { api, close } = apiFor(fx.dir, { accounts: ACCOUNTS });
    try {
      const graph = api.routeGraph();
      assert.equal(graph.available, true);
      assert.equal(graph.routes_available, true);
      assert.equal(graph.channels.length, 4, '无流量、无 ability、未映射的渠道都要保留');

      const byId = new Map(graph.channels.map((c) => [c.id, c]));
      assert.equal(byId.get(10).state, 'enabled');
      assert.equal(byId.get(20).state, 'disabled');
      assert.equal(byId.get(30).state, 'unknown');
      assert.equal(byId.get(40).state, 'disabled');

      // endpoint 只留 origin：去 userinfo/path/query/hash，保留非标准端口
      assert.equal(byId.get(10).endpoint, 'https://up.example.com:9443');
      assert.equal(byId.get(20).endpoint, null);
      assert.equal(byId.get(30).endpoint, null);
      assert.equal(byId.get(40).endpoint, null, '非 http(s) 不给 endpoint');

      // 多账户共享：停用账户也参与归属
      assert.deepEqual(byId.get(10).account_ids, ['acct-a']);
      assert.deepEqual(byId.get(20).account_ids, ['acct-a', 'acct-b']);
      assert.deepEqual(byId.get(30).account_ids, ['acct-a']);
      assert.deepEqual(byId.get(40).account_ids, []);

      // model_mapping 只作附注，不生成路由边
      assert.deepEqual(byId.get(10).model_mapping, { 'gpt-4o': 'gpt-4o-mini' });
      assert.equal(byId.get(10).mapping_error, null);
      assert.equal(byId.get(20).model_mapping, null);
      assert.match(byId.get(20).mapping_error, /不是合法 JSON/);

      const accounts = new Map(graph.accounts.map((a) => [a.id, a]));
      assert.equal(accounts.get('acct-a').website, 'https://a.example.com:8443');
      assert.equal(accounts.get('acct-b').website, 'https://b.example.com');
      assert.deepEqual(accounts.get('acct-a').channel_ids, [10, 20, 30]);
      assert.equal(accounts.has('acct-b'), true, '停用账户仍然出现在归属里');

      // 多分组同名模型隔离：两条独立 ability，不合并
      const duplicates = graph.abilities.filter((a) => a.model === 'gpt-4o' && a.channel_id === 10);
      assert.deepEqual(duplicates.map((a) => a.group).sort(), ['default', 'vip']);
      assert.equal(graph.abilities.find((a) => a.channel_id === 20).enabled, false);

      // 不泄露任何账户凭据/原始配置
      const serialized = JSON.stringify(graph);
      assert.equal(serialized.includes('super-secret-token'), false);
      assert.equal(serialized.includes('session=secret-cookie'), false);
      assert.equal(serialized.includes('user:'), false);
      assert.equal(serialized.includes('{bad json'), false);
    } finally {
      close();
    }
  } finally {
    fx.close();
  }
});

test('/api/routes：缺 abilities 时 available=true 但 routes_available=false', () => {
  const fx = workspace({ channels: CHANNELS, abilities: null });
  try {
    syncChannelStates(fx.dashboard, fx.relayFile);
    const { api, close } = apiFor(fx.dir, { accounts: ACCOUNTS });
    try {
      const graph = api.routeGraph();
      assert.equal(graph.available, true);
      assert.equal(graph.routes_available, false);
      assert.match(graph.routes_error, /abilities/);
      assert.deepEqual(graph.abilities, []);
      assert.equal(graph.channels.length, 4, '渠道配置仍然可用');
    } finally {
      close();
    }
  } finally {
    fx.close();
  }
});

test('/api/routes：从未同步时 available=false，不伪装成空配置成功', () => {
  const fx = workspace({ channels: [], abilities: [] });
  try {
    const { api, close } = apiFor(fx.dir, { accounts: ACCOUNTS });
    try {
      const graph = api.routeGraph();
      assert.equal(graph.available, false);
      assert.equal(graph.synced_at, null);
      assert.equal(graph.routes_available, false);
      assert.deepEqual(graph.channels, []);
      assert.equal(graph.accounts.length, 2, '静态归属不依赖快照');
    } finally {
      close();
    }
  } finally {
    fx.close();
  }
});

// ---------------------------------------------------------------------------
// 异常路径与结构校验
// ---------------------------------------------------------------------------

/** 只让 abilities 的 SELECT 抛错，模拟真实库在读取路由表时损坏（其余语句走真实 sqlite） */
function withFailingAbilities(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql, ...rest) => {
          if (/\bFROM\s+abilities\b/i.test(String(sql))) {
            throw new Error('database disk image is malformed');
          }
          return target.prepare(sql, ...rest);
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

test('同步：abilities 读取出错不阻断 channel_state，路由明确不可用并留痕', () => {
  const fx = workspace({ channels: CHANNELS, abilities: ABILITIES });
  try {
    assert.equal(syncChannelStates(fx.dashboard, fx.relayFile), 4);
    assert.equal(readRoutingSnapshot(fx.dashboard).payload.abilities.length, 3);

    const relay = new DatabaseSync(fx.relayFile);
    relay.prepare('UPDATE channels SET name = ? WHERE id = 10').run('改名后');
    relay.close();

    // abilities 报错不能让已读到的 channels 白读
    assert.equal(
      syncChannelStates(fx.dashboard, fx.relayFile, { openSource: withFailingAbilities }),
      4,
    );
    assert.equal(readChannelStates(fx.dashboard).get(10).name, '改名后');

    const snapshot = readRoutingSnapshot(fx.dashboard);
    assert.equal(snapshot.available, true);
    assert.equal(snapshot.payload.routes_available, false, '不能当成空规则成功');
    assert.match(snapshot.payload.routes_error, /读取源库 abilities 失败.*malformed/);
    assert.deepEqual(snapshot.payload.abilities, []);
    assert.equal(snapshot.payload.channels.find((c) => c.id === 10).name, '改名后');
  } finally {
    fx.close();
  }
});

test('快照读取：缺表按未采集；库关闭等真实错误向上抛', () => {
  const dir = makeTempDir('v2-routing-read-');
  try {
    const rawFile = path.join(dir, 'raw.db');
    const raw = new DatabaseSync(rawFile);
    assert.equal(readRoutingSnapshot(raw).available, false, '缺表 = 未采集');
    raw.close();

    const dashboardFile = path.join(dir, 'dashboard.db');
    const db = openDashboardDb(dashboardFile);
    db.close();
    assert.throws(() => readRoutingSnapshot(db));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('快照读取：payload 结构非法时 available=false 并报损坏', () => {
  const dir = makeTempDir('v2-routing-payload-');
  const db = openDashboardDb(path.join(dir, 'dashboard.db'));
  const writePayload = db.prepare(
    `INSERT INTO channel_routing_snapshot (id, payload, synced_at, last_attempt_at, last_error)
     VALUES (1, ?, ?, ?, NULL)
     ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, synced_at = excluded.synced_at,
       last_attempt_at = excluded.last_attempt_at, last_error = NULL`,
  );
  try {
    for (const bad of [
      '42',
      JSON.stringify({ channels: [], abilities: [] }),
      JSON.stringify({ channels: [{ id: 'x' }], abilities: [], routes_available: true, routes_error: null }),
      JSON.stringify({ channels: [], abilities: [{ group: 'g', model: 1, channel_id: 1 }], routes_available: true, routes_error: null }),
    ]) {
      writePayload.run(bad, 1, 1);
      const snapshot = readRoutingSnapshot(db);
      assert.equal(snapshot.available, false, `坏 payload 不能当作可用: ${bad}`);
      assert.match(snapshot.error, /损坏/);
    }

    writePayload.run(
      JSON.stringify({ channels: [], abilities: [], routes_available: true, routes_error: null }),
      2,
      2,
    );
    const good = readRoutingSnapshot(db);
    assert.equal(good.available, true);
    assert.equal(good.error, null);
    assert.deepEqual(good.payload.channels, []);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('/api/routes：model_mapping 的 __proto__ 键保留且不污染原型', () => {
  const fx = workspace({
    channels: [{ id: 50, name: '映射', status: 1, modelMapping: '{"__proto__":"x","gpt-4o":"m"}' }],
    abilities: [{ group: 'g', model: 'm', channelId: 50 }],
  });
  try {
    syncChannelStates(fx.dashboard, fx.relayFile);
    const { api, close } = apiFor(fx.dir, { accounts: ACCOUNTS });
    try {
      const [channel] = api.routeGraph().channels;
      assert.equal(Object.hasOwn(channel.model_mapping, '__proto__'), true);
      assert.equal(channel.model_mapping.__proto__, 'x');
      assert.equal(Object.getPrototypeOf(channel.model_mapping), Object.prototype);
      assert.equal({}.x, undefined, '不得污染全局原型');
    } finally {
      close();
    }
  } finally {
    fx.close();
  }
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

test('HTTP GET/HEAD /api/routes：DTO 完整、可缓存、无凭据', async (t) => {
  const fx = workspace({ channels: CHANNELS, abilities: ABILITIES });
  syncChannelStates(fx.dashboard, fx.relayFile);
  const { api, close } = apiFor(fx.dir, { accounts: ACCOUNTS });
  const cache = createApiCache({ ttlMs: 60_000 });
  const server = http.createServer(createRequestHandler({ api, cache, settingsStore: null }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    close();
    fx.close();
  });

  const res = await fetch(`${base}/api/routes`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), [
    'abilities', 'accounts', 'available', 'channels', 'error',
    'last_attempt_at', 'routes_available', 'routes_error', 'synced_at',
  ]);
  assert.equal(body.channels.length, 4);
  assert.equal(body.abilities.length, 3);
  assert.equal(body.channels[0].state, 'enabled');
  assert.equal(res.headers.get('x-cache'), 'MISS');
  assert.equal((await fetch(`${base}/api/routes`)).headers.get('x-cache'), 'HIT');

  const head = await fetch(`${base}/api/routes`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');

  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes('super-secret-token'), false);

  // 设置接口不受影响
  assert.equal((await fetch(`${base}/api/healthz`)).status, 200);
});
