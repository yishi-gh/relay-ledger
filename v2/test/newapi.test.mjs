/**
 * New API 适配器单测：余额换算、分页充值/赠额、零充值 vs 未知、429/401/5xx、缺字段。
 * 全部走 mock fetch。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createUpstreamClient } from '../sources/upstream/http.mjs';
import { authHeaders } from '../sources/upstream/common.mjs';
import { createNewApiSource } from '../sources/upstream/newapi.mjs';
import { createMockFetch, jsonResponse, newApiAccount } from './helpers/fixture.mjs';

const NOW = Date.UTC(2026, 9, 30, 4, 0, 0); // 2026-10-30 12:00 +08

function clientFor(fetchImpl) {
  return createUpstreamClient({ fetchImpl, minIntervalMs: 0, retryDelayMs: 0 });
}

function sourceFor(fetchImpl, { account = newApiAccount(), headers = { Authorization: 'Bearer test-token' } } = {}) {
  return createNewApiSource({ account, client: clientFor(fetchImpl), headers });
}

function logItems(count, { quota = 1000, t = NOW - 3600000, idBase = 0, omitQuota = false } = {}) {
  return Array.from({ length: count }, (_, i) => {
    const item = { id: idBase + i, created_at: Math.floor(t / 1000), content: '充值' };
    if (!omitQuota) item.quota = quota;
    return item;
  });
}

test('余额：quota 按 quota_per_unit 折算 USD，原始值保留', async () => {
  const { fetchImpl, calls } = createMockFetch(() =>
    jsonResponse({ success: true, data: { quota: 500000, used_quota: 100 } }),
  );
  const res = await sourceFor(fetchImpl).fetchBalance();
  assert.equal(res.status, 'ok');
  assert.equal(res.value, 1);
  assert.equal(res.unit, 'USD');
  assert.equal(res.raw.value, 500000);
  assert.equal(res.raw.unit, 'quota');
  assert.equal(calls[0].path, '/api/user/self');
  assert.equal(calls[0].headers.Authorization, 'Bearer test-token');
  assert.ok(!JSON.stringify(res).includes('test-token'));
});

test('累计充值：quota + used_quota 折算，用于替代余额上涨推断', async () => {
  const { fetchImpl } = createMockFetch(() =>
    jsonResponse({ success: true, data: { quota: 4180885, used_quota: 20819115 } }),
  );
  const res = await sourceFor(fetchImpl).fetchBalance();
  assert.equal(res.status, 'ok');
  assert.equal(res.value, 4180885 / 500000);
  assert.equal(res.recharged, 50);
});

test('累计充值：缺 used_quota 时为 null，不用剩余额度冒充满值总额', async () => {
  const { fetchImpl } = createMockFetch(() =>
    jsonResponse({ success: true, data: { quota: 500000 } }),
  );
  const res = await sourceFor(fetchImpl).fetchBalance();
  assert.equal(res.status, 'ok');
  assert.equal(res.recharged, null);
});

test('余额缺 quota：unavailable，不写 0', async () => {
  const { fetchImpl } = createMockFetch(() => jsonResponse({ success: true, data: { balance: 10 } }));
  const res = await sourceFor(fetchImpl).fetchBalance();
  assert.equal(res.status, 'unavailable');
  assert.equal(res.reason, 'missing_field:quota');
  assert.equal(res.value, null);
});

test('余额缺 quota_per_unit：不把 quota 当 USD', async () => {
  const { fetchImpl } = createMockFetch(() =>
    jsonResponse({ success: true, data: { quota: 500000 } }),
  );
  const account = newApiAccount({ quota_per_unit: null });
  const res = await sourceFor(fetchImpl, { account }).fetchBalance();
  assert.equal(res.status, 'unavailable');
  assert.equal(res.reason, 'missing_quota_per_unit');
  assert.equal(res.value, null);
});

test('充值/赠额：type=1 与 type=4 分页求和，全部取完为 complete', async () => {
  const { fetchImpl, calls } = createMockFetch((u) => {
    const type = u.searchParams.get('type');
    const page = Number(u.searchParams.get('p'));
    if (type === '1' && page === 1) {
      return jsonResponse({ success: true, data: { items: logItems(100, { quota: 2000 }), total: 150 } });
    }
    if (type === '1' && page === 2) {
      return jsonResponse({ success: true, data: { items: logItems(50, { quota: 2000, idBase: 100 }), total: 150 } });
    }
    if (type === '4' && page === 1) {
      return jsonResponse({ success: true, data: { items: logItems(1, { quota: 500000, idBase: 500 }), total: 1 } });
    }
    return jsonResponse({ success: true, data: { items: [], total: 0 } });
  });
  const res = await sourceFor(fetchImpl).fetchCredits({ from: NOW - 7200000, to: NOW });
  assert.equal(res.status, 'ok');
  assert.equal(res.complete, true);
  // 150 * 2000 + 1 * 500000 = 800000 quota = 1.6 USD
  assert.equal(res.raw.value, 800000);
  assert.equal(res.value, 1.6);
  assert.equal(res.events.length, 151);
  assert.deepEqual(new Set(res.events.map((e) => e.kind)), new Set(['topup', 'gift']));
  assert.ok(calls.length >= 3);
});

test('零充值：空列表给出明确 0', async () => {
  const { fetchImpl } = createMockFetch(() =>
    jsonResponse({ success: true, data: { items: [], total: 0 } }),
  );
  const res = await sourceFor(fetchImpl).fetchCredits({ from: NOW - 7200000, to: NOW });
  assert.equal(res.status, 'ok');
  assert.equal(res.value, 0);
  assert.equal(res.complete, true);
  assert.deepEqual(res.events, []);
});

test('分页里有缺 quota 的条目：partial，不把未知当 0', async () => {
  const { fetchImpl } = createMockFetch((u) => {
    const type = u.searchParams.get('type');
    if (type === '1') {
      return jsonResponse({
        success: true,
        data: { items: logItems(1, { omitQuota: true }), total: 1 },
      });
    }
    return jsonResponse({ success: true, data: { items: [], total: 0 } });
  });
  const res = await sourceFor(fetchImpl).fetchCredits({ from: NOW - 7200000, to: NOW });
  assert.equal(res.status, 'partial');
  assert.equal(res.reason, 'credits_incomplete');
  assert.equal(res.complete, false);
  assert.equal(res.events.length, 0);
});

test('401：unavailable/auth_failed', async () => {
  const { fetchImpl } = createMockFetch(() => jsonResponse({}, 401));
  const res = await sourceFor(fetchImpl).fetchBalance();
  assert.equal(res.status, 'unavailable');
  assert.equal(res.reason, 'auth_failed');
});

test('429：向上抛 rate_limited，供 job 停止整轮', async () => {
  const { fetchImpl } = createMockFetch(() => jsonResponse({}, 429));
  await assert.rejects(
    () => sourceFor(fetchImpl).fetchBalance(),
    (err) => err.kind === 'rate_limited',
  );
});

test('5xx：重试一次后 unavailable/upstream_error', async () => {
  let calls = 0;
  const { fetchImpl } = createMockFetch(() => {
    calls += 1;
    return jsonResponse({}, 502);
  });
  const res = await sourceFor(fetchImpl).fetchBalance();
  assert.equal(res.status, 'unavailable');
  assert.equal(res.reason, 'upstream_error');
  assert.equal(calls, 2);
});

test('上报消费：/api/log/self/stat 的 quota 折算 USD', async () => {
  const { fetchImpl, calls } = createMockFetch(() =>
    jsonResponse({ success: true, data: { quota: 250000 } }),
  );
  const res = await sourceFor(fetchImpl).fetchReportedSpend({ from: NOW - 3600000, to: NOW });
  assert.equal(res.status, 'ok');
  assert.equal(res.value, 0.5);
  assert.equal(res.raw.value, 250000);
  assert.equal(calls[0].path, '/api/log/self/stat');
  assert.equal(calls[0].search.get('type'), '2');
  assert.equal(calls[0].search.get('start_timestamp'), String(Math.floor((NOW - 3600000) / 1000)));
});

test('上报消费缺 quota：unavailable', async () => {
  const { fetchImpl } = createMockFetch(() => jsonResponse({ success: true, data: {} }));
  const res = await sourceFor(fetchImpl).fetchReportedSpend({ from: NOW - 3600000, to: NOW });
  assert.equal(res.status, 'unavailable');
  assert.equal(res.reason, 'missing_field:quota');
  assert.equal(res.value, null);
});

test('200 + success:false「无效的令牌」：auth_failed，不落到缺字段', async () => {
  const { fetchImpl } = createMockFetch(() => jsonResponse({ success: false, message: '无效的令牌' }));
  const source = sourceFor(fetchImpl);
  const balance = await source.fetchBalance();
  assert.equal(balance.status, 'unavailable');
  assert.equal(balance.reason, 'auth_failed');
  assert.equal(balance.value, null);
  const spend = await source.fetchReportedSpend({ from: NOW - 3600000, to: NOW });
  assert.equal(spend.reason, 'auth_failed');
});

test('success:false 但不是鉴权原因：仍按缺字段处理', async () => {
  const { fetchImpl } = createMockFetch(() => jsonResponse({ success: false, message: '数据库错误' }));
  const res = await sourceFor(fetchImpl).fetchBalance();
  assert.equal(res.reason, 'missing_field:quota');
});

test('余额返回的 user.id 与配置不一致：cookie_account_mismatch，不给数值', async () => {
  const { fetchImpl } = createMockFetch(() =>
    jsonResponse({ success: true, data: { id: 8, quota: 500000 } }),
  );
  const account = newApiAccount({ auth: { ...newApiAccount().auth, user_id: 7 } });
  const res = await sourceFor(fetchImpl, { account }).fetchBalance();
  assert.equal(res.status, 'unavailable');
  assert.equal(res.reason, 'cookie_account_mismatch');
  assert.equal(res.value, null);
});

test('余额返回的 user.id 与配置一致：正常折算', async () => {
  const { fetchImpl } = createMockFetch(() =>
    jsonResponse({ success: true, data: { id: '7', quota: 1000000 } }),
  );
  const account = newApiAccount({ auth: { ...newApiAccount().auth, user_id: 7 } });
  const res = await sourceFor(fetchImpl, { account }).fetchBalance();
  assert.equal(res.status, 'ok');
  assert.equal(res.value, 2);
});

test('cookie 模式：请求带 Cookie / New-Api-User / X-Auth-Session', async () => {
  const { fetchImpl, calls } = createMockFetch(() =>
    jsonResponse({ success: true, data: { id: 7, quota: 500000 } }),
  );
  const account = newApiAccount({ auth: { ...newApiAccount().auth, mode: 'cookie', user_id: 7, session: 'sess-1' } });
  const headers = authHeaders(account, 'session=abc');
  const res = await createNewApiSource({
    account,
    client: clientFor(fetchImpl),
    headers,
    expectedUserId: 7,
  }).fetchBalance();
  assert.equal(res.status, 'ok');
  assert.equal(calls[0].headers.Cookie, 'session=abc');
  assert.equal(calls[0].headers['New-Api-User'], '7');
  assert.equal(calls[0].headers['X-Auth-Session'], 'sess-1');
});
