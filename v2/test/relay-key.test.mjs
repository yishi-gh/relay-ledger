/**
 * 渠道 key 取余额：/v1/usage 命中、base_url 规整、HTTP/网络失败，
 * 以及全失败或 relay db 不存在时静默退回会话采集。全部注入 fetch 与临时库。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { runCollectSpend } from '../jobs/collect-spend.mjs';
import {
  fetchUsageByKey,
  getChannelCredential,
  openRelayDb,
} from '../sources/upstream/relay-key.mjs';
import {
  createMockFetch,
  jsonResponse,
  makeConfig,
  makeTempDir,
  openTempDashboard,
  sub2ApiAccount,
} from './helpers/fixture.mjs';

const KEY = 'relay-key-secret-abc123';

function makeRelayDb(dir, rows) {
  const file = path.join(dir, 'one-api.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE channels (id INTEGER PRIMARY KEY, key TEXT, base_url TEXT)');
  const insert = db.prepare('INSERT INTO channels (id, key, base_url) VALUES (?, ?, ?)');
  for (const row of rows) insert.run(row.id, row.key, row.base_url ?? null);
  db.close();
  return file;
}

function relayHandler({ relayStatus = 200, balance = 42.5 } = {}) {
  return (url) => {
    if (url.hostname === 'relay.test' && url.pathname === '/v1/usage') {
      if (relayStatus !== 200) return jsonResponse({}, relayStatus);
      return jsonResponse({ balance });
    }
    throw new Error(`未预期的请求 ${url.hostname}${url.pathname}`);
  };
}

function sessionHandler(balance = 7.5) {
  return (url) => {
    if (url.hostname === 'sub2api.test' && url.pathname === '/api/v1/auth/me') {
      return jsonResponse({ data: { balanceUsd: balance } });
    }
    if (url.hostname === 'sub2api.test' && url.pathname === '/api/v1/usage/stats') {
      return jsonResponse({ data: { total_actual_cost: 1.25 } });
    }
    throw new Error(`未预期的请求 ${url.hostname}${url.pathname}`);
  };
}

test('渠道 key 命中 /v1/usage：返回余额且不含 key 明文', async () => {
  const { fetchImpl, calls } = createMockFetch(relayHandler({ balance: 12.34 }));
  const res = await fetchUsageByKey('https://relay.test', KEY, { fetchImpl });

  assert.deepEqual(res, {
    ok: true,
    balance: 12.34,
    unit: 'USD',
    raw: { balance: 12.34 },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].path, '/v1/usage');
  assert.equal(calls[0].headers.Authorization, `Bearer ${KEY}`);
  assert.ok(!JSON.stringify(res).includes(KEY));
});

test('base_url 无 scheme 时补 https，并去掉尾部 / 与 /v1', async () => {
  const seen = [];
  const { fetchImpl } = createMockFetch((url) => {
    seen.push({ protocol: url.protocol, host: url.host, path: url.pathname });
    return jsonResponse({ data: { balance: 5 } });
  });

  const res = await fetchUsageByKey('relay.test/v1/', KEY, { fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.balance, 5);
  assert.deepEqual(seen, [{ protocol: 'https:', host: 'relay.test', path: '/v1/usage' }]);
  assert.ok(!JSON.stringify(res).includes(KEY));
});

test('401 返回 http_401，网络异常返回 network_error，且都不泄露 key', async () => {
  const unauthorized = createMockFetch(() => jsonResponse({}, 401));
  const res401 = await fetchUsageByKey('https://relay.test', KEY, { fetchImpl: unauthorized.fetchImpl });
  assert.deepEqual(res401, { ok: false, reason: 'http_401' });

  const broken = async () => {
    throw new Error(`connect failed with ${KEY}`);
  };
  const resNetwork = await fetchUsageByKey('https://relay.test', KEY, { fetchImpl: broken });
  assert.deepEqual(resNetwork, { ok: false, reason: 'network_error' });
  assert.ok(!JSON.stringify([res401, resNetwork]).includes(KEY));
});

test('openRelayDb 对不存在的文件返回 null；getChannelCredential 读 key/base_url', () => {
  const dir = makeTempDir('v2-relay-db-');
  try {
    assert.equal(openRelayDb(path.join(dir, 'missing.db')), null);

    const file = makeRelayDb(dir, [
      { id: 13, key: KEY, base_url: 'relay.test' },
      { id: 14, key: '', base_url: 'https://empty.test' },
    ]);
    const db = openRelayDb(file);
    assert.ok(db);
    try {
      assert.deepEqual(getChannelCredential(db, 13), { key: KEY, base_url: 'relay.test' });
      assert.equal(getChannelCredential(db, 14), null);
      assert.equal(getChannelCredential(db, 99), null);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sub2api 渠道 key 命中：余额来自 channel_key，写入快照与 job_runs.detail', async () => {
  const dir = makeTempDir('v2-relay-hit-');
  const dashboard = openTempDashboard(dir);
  const relayFile = makeRelayDb(dir, [{ id: 13, key: KEY, base_url: 'relay.test' }]);
  const account = sub2ApiAccount({ channels: [13] });
  const { fetchImpl } = createMockFetch((url) => {
    if (url.hostname === 'relay.test') return relayHandler({ balance: 42.5 })(url);
    return sessionHandler()(url);
  });

  try {
    const summary = await runCollectSpend({
      config: makeConfig({ accounts: [account] }),
      db: dashboard,
      fetchImpl,
      now: Date.now(),
      relayDbFile: relayFile,
    });

    assert.equal(summary.status, 'ok');
    assert.equal(summary.accounts[0].balance_source, 'channel_key');
    assert.equal(summary.accounts[0].balance.value, 42.5);
    assert.equal(summary.accounts[0].status, 'ok');

    const snapshot = dashboard.prepare(
      'SELECT balance FROM balance_snapshot WHERE account_id = ?',
    ).get(account.id);
    assert.equal(snapshot.balance, 42.5);

    const detail = dashboard.prepare('SELECT detail FROM job_runs').get().detail;
    const parsed = JSON.parse(detail);
    assert.equal(parsed.accounts[0].balance_source, 'channel_key');
    assert.ok(!detail.includes(KEY));
    assert.ok(!JSON.stringify(summary).includes(KEY));
  } finally {
    dashboard.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('channels 全部失败：退回会话采集，balance_source=session', async () => {
  const dir = makeTempDir('v2-relay-fallback-');
  const dashboard = openTempDashboard(dir);
  const relayFile = makeRelayDb(dir, [
    { id: 13, key: 'dead-key-1', base_url: 'relay.test' },
    { id: 14, key: 'dead-key-2', base_url: 'relay.test' },
  ]);
  const account = sub2ApiAccount({ channels: [13, 14] });
  const { fetchImpl, calls } = createMockFetch((url) => {
    if (url.hostname === 'relay.test') return jsonResponse({}, 401);
    return sessionHandler(7.5)(url);
  });

  try {
    const summary = await runCollectSpend({
      config: makeConfig({ accounts: [account] }),
      db: dashboard,
      fetchImpl,
      now: Date.now(),
      relayDbFile: relayFile,
    });

    assert.equal(summary.accounts[0].balance_source, 'session');
    assert.equal(summary.accounts[0].balance.value, 7.5);
    assert.deepEqual(
      calls.map((c) => c.path),
      ['/v1/usage', '/v1/usage', '/api/v1/auth/me', '/api/v1/usage/stats'],
    );
    assert.ok(!JSON.stringify(summary).includes('dead-key-1'));
    assert.ok(!JSON.stringify(summary).includes('dead-key-2'));
  } finally {
    dashboard.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('relay db 不存在：不报错，直接走会话采集', async () => {
  const dir = makeTempDir('v2-relay-missing-');
  const dashboard = openTempDashboard(dir);
  const account = sub2ApiAccount({ channels: [13] });
  const { fetchImpl, calls } = createMockFetch(sessionHandler(3.25));

  try {
    const summary = await runCollectSpend({
      config: makeConfig({ accounts: [account] }),
      db: dashboard,
      fetchImpl,
      now: Date.now(),
      relayDbFile: path.join(dir, 'no-such-one-api.db'),
    });

    assert.equal(summary.status, 'ok');
    assert.equal(summary.accounts[0].balance_source, 'session');
    assert.equal(summary.accounts[0].balance.value, 3.25);
    assert.equal(calls[0].path, '/api/v1/auth/me');
  } finally {
    dashboard.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});