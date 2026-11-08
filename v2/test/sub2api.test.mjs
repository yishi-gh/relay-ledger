/**
 * sub2api 适配器单测：余额 USD、上报消费、充值 unsupported、401/缺字段。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createUpstreamClient } from '../sources/upstream/http.mjs';
import { createSub2ApiSource } from '../sources/upstream/sub2api.mjs';
import { createMockFetch, jsonResponse, sub2ApiAccount } from './helpers/fixture.mjs';

const NOW = Date.UTC(2026, 9, 30, 4, 0, 0);

function sourceFor(fetchImpl, { account = sub2ApiAccount(), headers = { Authorization: 'Bearer test-token' } } = {}) {
  const client = createUpstreamClient({ fetchImpl, minIntervalMs: 0, retryDelayMs: 0 });
  return createSub2ApiSource({ account, client, headers });
}

test('余额：优先 balanceUsd，原始值保留，token 不进结果', async () => {
  const { fetchImpl, calls } = createMockFetch(() =>
    jsonResponse({ code: 0, data: { balanceUsd: 12.5, quota: 99 } }),
  );
  const res = await sourceFor(fetchImpl).fetchBalance();
  assert.equal(res.status, 'ok');
  assert.equal(res.value, 12.5);
  assert.equal(res.unit, 'USD');
  assert.equal(res.raw.value, 12.5);
  assert.equal(calls[0].path, '/api/v1/auth/me');
  assert.equal(calls[0].headers.Authorization, 'Bearer test-token');
  assert.ok(!JSON.stringify(res).includes('test-token'));
});

test('余额：没有 balanceUsd 时退回 quota（sub2api 的 quota 即 USD）', async () => {
  const { fetchImpl } = createMockFetch(() => jsonResponse({ data: { quota: 7.25 } }));
  const res = await sourceFor(fetchImpl).fetchBalance();
  assert.equal(res.status, 'ok');
  assert.equal(res.value, 7.25);
});

test('余额缺字段：unavailable，不写 0', async () => {
  const { fetchImpl } = createMockFetch(() => jsonResponse({ data: { username: 'x' } }));
  const res = await sourceFor(fetchImpl).fetchBalance();
  assert.equal(res.status, 'unavailable');
  assert.equal(res.reason, 'missing_field:balance');
  assert.equal(res.value, null);
});

test('上报消费：total_actual_cost', async () => {
  const { fetchImpl, calls } = createMockFetch(() =>
    jsonResponse({ data: { total_actual_cost: 3.2 } }),
  );
  const source = sourceFor(fetchImpl);
  const res = await source.fetchReportedSpend();
  assert.equal(res.status, 'ok');
  assert.equal(res.value, 3.2);
  assert.equal(calls[0].path, '/api/v1/usage/stats');
  assert.equal(calls[0].search.get('period'), 'today');

  // 显式区间时改成 start_date/end_date，不再带 period=today
  await source.fetchReportedSpend({ from: NOW - 3600000, to: NOW });
  assert.equal(calls[1].search.get('period'), null);
  assert.equal(calls[1].search.get('start_date'), '2026-10-30');
  assert.equal(calls[1].search.get('end_date'), '2026-10-30');
});

test('上报消费缺字段：unavailable', async () => {
  const { fetchImpl } = createMockFetch(() => jsonResponse({ data: {} }));
  const res = await sourceFor(fetchImpl).fetchReportedSpend({ from: NOW - 3600000, to: NOW });
  assert.equal(res.status, 'unavailable');
  assert.equal(res.reason, 'missing_field:total_actual_cost');
});

test('充值：unsupported，不伪造 0', async () => {
  const res = await sourceFor(async () => jsonResponse({})).fetchCredits({ from: NOW - 1, to: NOW });
  assert.equal(res.status, 'unsupported');
  assert.equal(res.reason, 'credits_unsupported');
  assert.equal(res.value, null);
});

test('401：unavailable/auth_failed', async () => {
  const { fetchImpl } = createMockFetch(() => jsonResponse({}, 401));
  const res = await sourceFor(fetchImpl).fetchBalance();
  assert.equal(res.status, 'unavailable');
  assert.equal(res.reason, 'auth_failed');
});

test('429：向上抛 rate_limited', async () => {
  const { fetchImpl } = createMockFetch(() => jsonResponse({}, 429));
  await assert.rejects(
    () => sourceFor(fetchImpl).fetchBalance(),
    (err) => err.kind === 'rate_limited',
  );
});
