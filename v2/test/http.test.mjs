/**
 * HTTP 客户端单测：认证/限流不重试、5xx 与网络重试一次、超时、同站串行与最小间隔。
 * 全部用注入的 fetch，不访问网络。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { UpstreamHttpError, createUpstreamClient } from '../sources/upstream/http.mjs';
import { jsonResponse } from './helpers/fixture.mjs';

const URL_OK = 'https://upstream.test/api/x';

test('401/403：不重试，错误不含 Authorization', async () => {
  let calls = 0;
  const client = createUpstreamClient({
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ error: 'bad token' }, 401);
    },
    minIntervalMs: 0,
    retryDelayMs: 0,
  });
  await assert.rejects(
    () => client.getJson(URL_OK, { headers: { Authorization: 'Bearer secret-token' } }),
    (err) => {
      assert.ok(err instanceof UpstreamHttpError);
      assert.equal(err.kind, 'auth');
      assert.equal(err.status, 401);
      assert.ok(!err.message.includes('secret-token'));
      assert.ok(!err.message.includes('Authorization'));
      return true;
    },
  );
  assert.equal(calls, 1);
});

test('429：直接抛出 rate_limited，不重试', async () => {
  let calls = 0;
  const client = createUpstreamClient({
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({}, 429);
    },
    minIntervalMs: 0,
    retryDelayMs: 0,
  });
  await assert.rejects(
    () => client.getJson(URL_OK),
    (err) => err.kind === 'rate_limited' && err.status === 429,
  );
  assert.equal(calls, 1);
});

test('5xx：重试一次后仍失败', async () => {
  let calls = 0;
  const client = createUpstreamClient({
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({}, 500);
    },
    minIntervalMs: 0,
    retryDelayMs: 0,
  });
  await assert.rejects(() => client.getJson(URL_OK), (err) => err.kind === 'server');
  assert.equal(calls, 2);
});

test('5xx 后恢复：第二次成功', async () => {
  let calls = 0;
  const client = createUpstreamClient({
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? jsonResponse({}, 503) : jsonResponse({ ok: true });
    },
    minIntervalMs: 0,
    retryDelayMs: 0,
  });
  assert.deepEqual(await client.getJson(URL_OK), { ok: true });
  assert.equal(calls, 2);
});

test('网络错误：重试一次', async () => {
  let calls = 0;
  const client = createUpstreamClient({
    fetchImpl: async () => {
      calls += 1;
      throw new TypeError('fetch failed');
    },
    minIntervalMs: 0,
    retryDelayMs: 0,
  });
  await assert.rejects(() => client.getJson(URL_OK), (err) => err.kind === 'network');
  assert.equal(calls, 2);
});

test('超时：abort 后抛 timeout，不重试', async () => {
  let calls = 0;
  const client = createUpstreamClient({
    fetchImpl: (url, init) =>
      new Promise((resolve, reject) => {
        calls += 1;
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    timeoutMs: 10,
    minIntervalMs: 0,
    retryDelayMs: 0,
  });
  await assert.rejects(() => client.getJson(URL_OK), (err) => err.kind === 'timeout');
  assert.equal(calls, 1);
});

test('非 JSON 响应：bad_json', async () => {
  const client = createUpstreamClient({
    fetchImpl: async () => new Response('not json', { status: 200 }),
    minIntervalMs: 0,
    retryDelayMs: 0,
  });
  await assert.rejects(() => client.getJson(URL_OK), (err) => err.kind === 'bad_json');
});

test('同站串行 + 最小间隔', async () => {
  let clock = 1000000;
  const sleeps = [];
  let active = 0;
  let maxActive = 0;
  const client = createUpstreamClient({
    fetchImpl: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      await Promise.resolve();
      active -= 1;
      return jsonResponse({ ok: true });
    },
    minIntervalMs: 1000,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    retryDelayMs: 0,
  });

  const [a, b] = await Promise.all([client.getJson(URL_OK), client.getJson(URL_OK)]);
  assert.deepEqual(a, { ok: true });
  assert.deepEqual(b, { ok: true });
  assert.equal(maxActive, 1);
  assert.ok(sleeps.includes(1000), `应等待最小间隔，实际 ${JSON.stringify(sleeps)}`);
});
