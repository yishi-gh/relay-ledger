/**
 * GET /api/* 的进程内缓存（v2/server.mjs 的 createApiCache / respondApi）。
 *
 * 覆盖：命中不重复查库、TTL 边界、只缓存 200、TTL=0 关闭、条目上限淘汰、
 * key 区分 query string、healthz 不缓存、API_CACHE_TTL_MS 解析。
 * 全部走注入的假 api，不建库、不监听端口。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createApiCache, respondApi } from '../server.mjs';

function urlOf(pathAndQuery) {
  return new URL(pathAndQuery, 'http://localhost');
}

/** 计数的假 api：只有 channels 会被这些用例打到 */
function makeApi(impl) {
  const calls = { channels: 0 };
  const api = {
    channels: (params) => {
      calls.channels += 1;
      return impl ? impl(params, calls.channels) : { rows: [], call: calls.channels };
    },
  };
  return { api, calls };
}

test('命中：相同 path+query 第二次直接返回缓存体，不再查库', () => {
  const { api, calls } = makeApi();
  const cache = createApiCache({ now: () => 1_000 });
  const url = urlOf('/api/channels?range=7d');

  const first = respondApi({ api, cache, pathname: '/api/channels', url });
  const second = respondApi({ api, cache, pathname: '/api/channels', url });

  assert.equal(first.cache, 'MISS');
  assert.equal(second.cache, 'HIT');
  assert.equal(calls.channels, 1);
  assert.equal(first.payload, second.payload);
  assert.deepEqual(JSON.parse(second.payload), { rows: [], call: 1 });
});

test('key 区分 query string：不同区间各占一条', () => {
  const { api, calls } = makeApi();
  const cache = createApiCache({ now: () => 1_000 });

  respondApi({ api, cache, pathname: '/api/channels', url: urlOf('/api/channels?range=7d') });
  const other = respondApi({ api, cache, pathname: '/api/channels', url: urlOf('/api/channels?range=30d') });
  const again = respondApi({ api, cache, pathname: '/api/channels', url: urlOf('/api/channels?range=7d') });

  assert.equal(other.cache, 'MISS');
  assert.equal(again.cache, 'HIT');
  assert.equal(calls.channels, 2);
});

test('过期：TTL 到点前命中，到点后重新查库', () => {
  let clock = 1_000;
  const { api, calls } = makeApi();
  const cache = createApiCache({ ttlMs: 60_000, now: () => clock });
  const url = urlOf('/api/channels');

  respondApi({ api, cache, pathname: '/api/channels', url });
  clock += 59_999;
  assert.equal(respondApi({ api, cache, pathname: '/api/channels', url }).cache, 'HIT');
  assert.equal(calls.channels, 1);

  clock += 1;
  const expired = respondApi({ api, cache, pathname: '/api/channels', url });
  assert.equal(expired.cache, 'MISS');
  assert.equal(calls.channels, 2, 'TTL 到点必须重新查库');
});

test('命中不续期：持续访问不会把过期时间往后推', () => {
  let clock = 0;
  const { api, calls } = makeApi();
  const cache = createApiCache({ ttlMs: 60_000, now: () => clock });
  const url = urlOf('/api/channels');

  respondApi({ api, cache, pathname: '/api/channels', url });
  clock += 30_000;
  assert.equal(respondApi({ api, cache, pathname: '/api/channels', url }).cache, 'HIT');
  clock += 30_000;
  assert.equal(respondApi({ api, cache, pathname: '/api/channels', url }).cache, 'MISS');
  assert.equal(calls.channels, 2);
});

test('非 200 不缓存：查询抛错时不写缓存，下次请求重新执行', () => {
  let clock = 0;
  const { api, calls } = makeApi((_params, n) => {
    if (n === 1) throw new RangeError('bad range');
    return { rows: [], call: n };
  });
  const cache = createApiCache({ now: () => clock });
  const url = urlOf('/api/channels');

  assert.throws(
    () => respondApi({ api, cache, pathname: '/api/channels', url }),
    /bad range/,
  );
  assert.equal(cache.size, 0, '抛错的请求不能进缓存');

  clock += 1;
  const ok = respondApi({ api, cache, pathname: '/api/channels', url });
  assert.equal(ok.cache, 'MISS');
  assert.equal(calls.channels, 2);
});

test('未知接口不进缓存：respondApi 返回 null，由调用方回 404', () => {
  const { api } = makeApi();
  const cache = createApiCache({ now: () => 0 });

  const result = respondApi({ api, cache, pathname: '/api/nope', url: urlOf('/api/nope') });
  assert.equal(result, null);
  assert.equal(cache.size, 0);
});

test('healthz 不缓存：每次都重新执行，且不带 X-Cache 需要的标记', () => {
  const cache = createApiCache({ now: () => 0 });
  const first = respondApi({ api: {}, cache, pathname: '/api/healthz', url: urlOf('/api/healthz') });
  const second = respondApi({ api: {}, cache, pathname: '/api/healthz', url: urlOf('/api/healthz') });

  assert.equal(first.cache, null);
  assert.equal(second.cache, null);
  assert.equal(cache.size, 0);
  assert.deepEqual(JSON.parse(first.payload), { ok: true });
});

test('TTL=0 关闭缓存：每次都查库，不写条目', () => {
  const { api, calls } = makeApi();
  const cache = createApiCache({ ttlMs: 0, now: () => 0 });
  const url = urlOf('/api/channels');

  const first = respondApi({ api, cache, pathname: '/api/channels', url });
  const second = respondApi({ api, cache, pathname: '/api/channels', url });

  assert.equal(cache.enabled, false);
  assert.equal(cache.size, 0);
  assert.equal(first.cache, null);
  assert.equal(second.cache, null);
  assert.equal(calls.channels, 2);
});

test('条目上限：超过 maxEntries 按最旧淘汰', () => {
  const { api, calls } = makeApi();
  const cache = createApiCache({ maxEntries: 2, now: () => 0 });

  respondApi({ api, cache, pathname: '/api/channels', url: urlOf('/api/channels?a=1') });
  respondApi({ api, cache, pathname: '/api/channels', url: urlOf('/api/channels?a=2') });
  respondApi({ api, cache, pathname: '/api/channels', url: urlOf('/api/channels?a=3') });

  assert.equal(cache.size, 2);
  assert.equal(cache.get('/api/channels?a=1'), null, '最旧的一条应被淘汰');
  assert.notEqual(cache.get('/api/channels?a=2'), null);
  assert.notEqual(cache.get('/api/channels?a=3'), null);
  assert.equal(calls.channels, 3);
});

test('API_CACHE_TTL_MS：默认 60 s，0 关闭，非法值退回默认', () => {
  const saved = process.env.API_CACHE_TTL_MS;
  try {
    delete process.env.API_CACHE_TTL_MS;
    assert.equal(createApiCache().enabled, true);
    assert.equal(createApiCache().ttlMs, 60_000);
    // 默认 TTL 用行为验证：第 59 秒命中、第 60 秒失效
    let clock = 0;
    const { api } = makeApi();
    const def = createApiCache({ now: () => clock });
    const url = urlOf('/api/channels');
    respondApi({ api, cache: def, pathname: '/api/channels', url });
    clock += 59_999;
    assert.equal(respondApi({ api, cache: def, pathname: '/api/channels', url }).cache, 'HIT');
    clock += 1;
    assert.equal(respondApi({ api, cache: def, pathname: '/api/channels', url }).cache, 'MISS');

    process.env.API_CACHE_TTL_MS = '0';
    assert.equal(createApiCache().enabled, false);

    process.env.API_CACHE_TTL_MS = 'abc';
    assert.equal(createApiCache().enabled, true, '非法值不能把缓存关掉或变成永久');

    process.env.API_CACHE_TTL_MS = '500';
    let t = 0;
    const short = createApiCache({ now: () => t });
    const fake = makeApi();
    respondApi({ api: fake.api, cache: short, pathname: '/api/channels', url });
    t += 500;
    assert.equal(respondApi({ api: fake.api, cache: short, pathname: '/api/channels', url }).cache, 'MISS');
  } finally {
    if (saved === undefined) delete process.env.API_CACHE_TTL_MS;
    else process.env.API_CACHE_TTL_MS = saved;
  }
});
