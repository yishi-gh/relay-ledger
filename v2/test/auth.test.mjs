/**
 * 认证单测：JWT 到期、换签、401 后强制刷新、cookie 头、原子写回、token 不泄漏。
 * 全部 mock fetch，不访问网络、不碰真实凭据文件。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_REFRESH_THRESHOLD_MS,
  NEWAPI_REFRESH_THRESHOLD_MS,
  UpstreamAuthError,
  authCanRefresh,
  ensureAuth,
  jwtExpiresAt,
  jwtLifetimeMs,
  mergeCookieHeader,
  needsRefresh,
  newApiRefreshThreshold,
  refreshNewApi,
  refreshPathFor,
  refreshSub2Api,
  toEpochMs,
} from '../sources/upstream/auth.mjs';
import { authHeaders } from '../sources/upstream/common.mjs';
import { loadConfig } from '../lib/config.mjs';
import {
  createMockFetch,
  jsonResponse,
  makeTempDir,
  newApiAccount,
  sub2ApiAccount,
} from './helpers/fixture.mjs';

const HOUR = 3600 * 1000;

function makeJwt(payload) {
  const part = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part(payload)}.signature`;
}

function writeAccountsFile(dir, accounts) {
  const file = path.join(dir, 'accounts.json');
  fs.writeFileSync(file, `${JSON.stringify({ accounts }, null, 2)}\n`, { mode: 0o600 });
  return file;
}

test('JWT exp：解析 payload.exp，秒转毫秒；坏 token 返回 null', () => {
  assert.equal(jwtExpiresAt(makeJwt({ exp: 1760000000 })), 1760000000000);
  assert.equal(jwtExpiresAt(makeJwt({ sub: 'no-exp' })), null);
  assert.equal(jwtExpiresAt('not-a-jwt'), null);
  assert.equal(jwtExpiresAt('a.b.c'), null);
  assert.equal(jwtExpiresAt(null), null);
});

test('toEpochMs：秒/毫秒/字符串都归一', () => {
  assert.equal(toEpochMs(1760000000), 1760000000000);
  assert.equal(toEpochMs(1760000000000), 1760000000000);
  assert.equal(toEpochMs('1760000000'), 1760000000000);
  assert.equal(toEpochMs(0), null);
  assert.equal(toEpochMs(''), null);
  assert.equal(toEpochMs(undefined), null);
});

test('needsRefresh：2 小时内到期才刷新，cookie/无 refresh_token/无 exp 不主动刷新', () => {
  const now = 1760000000000;
  const base = { mode: 'bearer', refresh_token: 'rt' };
  assert.equal(needsRefresh({ ...base, expires_at: now + HOUR }, now), true);
  assert.equal(needsRefresh({ ...base, expires_at: now + 3 * HOUR }, now), false);
  assert.equal(needsRefresh({ ...base, expires_at: now - HOUR }, now), true);
  assert.equal(needsRefresh({ ...base, expires_at: now + HOUR, mode: 'cookie' }, now), false);
  assert.equal(needsRefresh({ mode: 'bearer', expires_at: now + HOUR }, now), false);
  assert.equal(needsRefresh({ ...base }, now), false);
  assert.equal(needsRefresh({ ...base, expires_at: now + HOUR }, now, DEFAULT_REFRESH_THRESHOLD_MS), true);
  // JWT exp 兜底
  assert.equal(
    needsRefresh({ ...base, token: makeJwt({ exp: Math.floor((now + HOUR) / 1000) }) }, now),
    true,
  );
});

test('refreshSub2Api：成功换签，expires_in 兜底', async () => {
  const now = 1760000000000;
  const newToken = makeJwt({ sub: 'new' });
  const { fetchImpl, calls } = createMockFetch((u, init) => {
    assert.equal(u.pathname, '/api/v1/auth/refresh');
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(init.body), { refresh_token: 'refresh-old' });
    return jsonResponse({
      data: { access_token: newToken, refresh_token: 'refresh-new', expires_in: 3600 },
    });
  });
  const res = await refreshSub2Api({
    baseUrl: 'https://sub.test/',
    refreshToken: 'refresh-old',
    fetchImpl,
    nowMs: now,
  });
  assert.equal(res.access_token, newToken);
  assert.equal(res.refresh_token, 'refresh-new');
  assert.equal(res.expires_at, now + HOUR);
  assert.equal(calls.length, 1);
});

test('refreshSub2Api：401 / 429 / 非 JWT 都失败，错误里没有 token', async () => {
  const failing = async (status) =>
    refreshSub2Api({
      baseUrl: 'https://sub.test',
      refreshToken: 'refresh-secret',
      fetchImpl: async () => jsonResponse({}, status),
    });

  await assert.rejects(() => failing(401), (err) => {
    assert.ok(err instanceof UpstreamAuthError);
    assert.equal(err.reason, 'refresh_unauthorized');
    assert.ok(!err.message.includes('refresh-secret'));
    return true;
  });
  await assert.rejects(() => failing(429), (err) => err.kind === 'rate_limited');

  const { fetchImpl } = createMockFetch(() =>
    jsonResponse({ data: { access_token: 'not-a-jwt', refresh_token: 'r2' } }),
  );
  await assert.rejects(
    () => refreshSub2Api({ baseUrl: 'https://sub.test', refreshToken: 'rt', fetchImpl }),
    (err) => {
      assert.equal(err.reason, 'refresh_invalid_token');
      assert.ok(!err.message.includes('refresh-secret'));
      return true;
    },
  );
});

test('ensureAuth：未到期直接返回认证头，不发请求', async () => {
  const now = 1760000000000;
  const account = sub2ApiAccount({
    auth: {
      mode: 'bearer',
      token: 'access-token',
      refresh_token: 'rt',
      expires_at: now + 3 * HOUR,
      header: 'Authorization',
      scheme: 'Bearer',
    },
  });
  const { fetchImpl, calls } = createMockFetch(() => {
    throw new Error('不应请求');
  });
  const session = await ensureAuth(account, { nowMs: now, fetchImpl });
  assert.equal(session.refreshed, false);
  assert.equal(session.headers.Authorization, 'Bearer access-token');
  assert.equal(calls.length, 0);
});

test('ensureAuth：到期前刷新并原子写回，保留其他账户与字段', async () => {
  const now = 1760000000000;
  const dir = makeTempDir('v2-auth-');
  const newToken = makeJwt({ exp: Math.floor((now + 2 * HOUR) / 1000) });
  const file = writeAccountsFile(dir, [
    {
      id: 'a1',
      name: 'a1',
      base_url: 'https://sub.test',
      auth: {
        mode: 'bearer',
        token: 'old-token',
        refresh_token: 'refresh-old',
        expires_at: now + HOUR,
        token_env: 'A1_TOKEN',
        header: 'Authorization',
        scheme: 'Bearer',
        headers: { 'X-Custom': 'keep' },
      },
    },
    {
      id: 'a2',
      name: 'a2',
      base_url: 'https://other.test',
      auth: { mode: 'bearer', token: 'untouched', refresh_token: 'rt2' },
      extra_field: 'keep-me',
    },
  ]);

  const { fetchImpl } = createMockFetch(() =>
    jsonResponse({ data: { access_token: newToken, refresh_token: 'refresh-new', expires_in: 7200 } }),
  );

  try {
    const account = {
      id: 'a1',
      base_url: 'https://sub.test',
      auth: {
        mode: 'bearer',
        token: 'old-token',
        refresh_token: 'refresh-old',
        expires_at: now + HOUR,
        header: 'Authorization',
        scheme: 'Bearer',
        headers: { 'X-Custom': 'keep' },
      },
    };
    const session = await ensureAuth(account, {
      nowMs: now,
      fetchImpl,
      configPath: file,
      writable: true,
    });
    assert.equal(session.refreshed, true);
    assert.equal(session.wrote, true);
    assert.equal(session.headers.Authorization, `Bearer ${newToken}`);

    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const a1 = saved.accounts.find((a) => a.id === 'a1');
    const a2 = saved.accounts.find((a) => a.id === 'a2');
    assert.equal(a1.auth.token, newToken);
    assert.equal(a1.auth.refresh_token, 'refresh-new');
    assert.equal(a1.auth.expires_at, now + 2 * HOUR);
    assert.equal(a1.auth.headers['X-Custom'], 'keep');
    assert.equal(a2.auth.token, 'untouched');
    assert.equal(a2.extra_field, 'keep-me');
    assert.ok(!fs.readFileSync(file, 'utf8').includes('old-token'));

    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureAuth：写回失败不破坏旧文件，仍可用新 token', async () => {
  const now = 1760000000000;
  const newToken = makeJwt({ exp: Math.floor((now + 2 * HOUR) / 1000) });
  const dir = makeTempDir('v2-auth-');
  const { fetchImpl } = createMockFetch(() =>
    jsonResponse({ data: { access_token: newToken, refresh_token: 'r2', expires_in: 7200 } }),
  );
  try {
    const account = sub2ApiAccount({
      auth: {
        mode: 'bearer',
        token: 'old',
        refresh_token: 'rt',
        expires_at: now + 60000,
      },
    });
    // 指向不存在的文件：写回失败，但不抛、不影响本轮使用
    const missing = path.join(dir, 'missing', 'accounts.json');
    const session = await ensureAuth(account, {
      nowMs: now,
      fetchImpl,
      configPath: missing,
      writable: true,
    });
    assert.equal(session.refreshed, true);
    assert.equal(session.wrote, false);
    assert.equal(session.write_error, 'write_failed');
    assert.equal(session.headers.Authorization, `Bearer ${newToken}`);
    assert.equal(fs.existsSync(missing), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureAuth：缺 token 且无 refresh_token 抛 missing_token', async () => {
  const account = newApiAccount({
    auth: { mode: 'bearer', token: '', refresh_token: '', token_env: null },
  });
  await assert.rejects(
    () => ensureAuth(account, { fetchImpl: async () => jsonResponse({}) }),
    (err) => err instanceof UpstreamAuthError && err.reason === 'missing_token',
  );
});

test('cookie 模式：发 Cookie 与 New-Api-User，不主动换签', async () => {
  const now = 1760000000000;
  const account = newApiAccount({
    auth: {
      mode: 'cookie',
      token: '',
      cookie: 'session=abc',
      refresh_token: 'rt',
      expires_at: now + 60000,
      user_id: 42,
    },
  });
  const session = await ensureAuth(account, {
    nowMs: now,
    fetchImpl: async () => {
      throw new Error('不应请求');
    },
  });
  assert.equal(session.refreshed, false);
  assert.equal(session.headers.Cookie, 'session=abc');
  assert.equal(session.headers['New-Api-User'], '42');
  assert.equal(session.headers.Authorization, undefined);

  const plain = authHeaders({ auth: { mode: 'cookie', cookie: 'c=1' } }, 'c=1');
  assert.equal(plain.Cookie, 'c=1');
  assert.equal(plain['New-Api-User'], undefined);
});

function newApiCookieResponse(body, setCookies = []) {
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const value of setCookies) headers.append('set-cookie', value);
  return new Response(JSON.stringify(body), { status: 200, headers });
}

test('authHeaders：cookie 模式带 X-Auth-Session（session 或 session_id）', () => {
  const headers = authHeaders({ auth: { mode: 'cookie', cookie: 'c=1', session: 'sess' } }, 'c=1');
  assert.equal(headers['X-Auth-Session'], 'sess');
  assert.equal(authHeaders({ auth: { mode: 'cookie', cookie: 'c=1', session_id: 'sid' } }, 'c=1')['X-Auth-Session'], 'sid');
  assert.equal(authHeaders({ auth: { mode: 'bearer', session: 'sess' } }, 'tok')['X-Auth-Session'], 'sess');
  assert.equal(authHeaders({ auth: { mode: 'bearer' } }, 'tok')['X-Auth-Session'], undefined);
});

test('mergeCookieHeader：同名覆盖、其余保留、空值不覆盖、无 Set-Cookie 原样返回', () => {
  assert.equal(mergeCookieHeader('a=1; b=2', []), 'a=1; b=2');
  assert.equal(mergeCookieHeader('a=1; b=2', ['b=3; Path=/; HttpOnly']), 'a=1; b=3');
  assert.equal(mergeCookieHeader('a=1', ['c=4']), 'a=1; c=4');
  assert.equal(mergeCookieHeader('a=1', ['a=; Max-Age=0']), 'a=1');
  assert.equal(mergeCookieHeader(null, []), null);
});

test('refreshPathFor：NewAPI 默认 /api/user/auth/refresh，auth.refresh_path 可覆盖', () => {
  assert.equal(refreshPathFor({ kind: 'newapi' }), '/api/user/auth/refresh');
  assert.equal(refreshPathFor({ kind: 'newapi', auth: {} }), '/api/user/auth/refresh');
  assert.equal(refreshPathFor({ kind: 'newapi', auth: { refresh_path: '/api/x/refresh' } }), '/api/x/refresh');
  assert.equal(refreshPathFor({ kind: 'sub2api', auth: { refresh_path: '/api/x/refresh' } }), '/api/v1/auth/refresh');
});

test('refreshNewApi：Cookie 换签，解析 token/user/session/expires 并合并 Set-Cookie', async () => {
  const now = 1760000000000;
  const accessToken = makeJwt({ iat: Math.floor(now / 1000), exp: Math.floor((now + 900_000) / 1000) });
  const { fetchImpl, calls } = createMockFetch((u, init) => {
    assert.equal(u.pathname, '/api/user/auth/refresh');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Cookie, 'session=old; refresh=r1');
    assert.equal(init.headers.Origin, 'https://newapi.test');
    assert.equal(init.headers.Referer, 'https://newapi.test/');
    assert.equal(init.headers['X-Auth-Session'], 'sess-old');
    assert.equal(init.headers['New-Api-User'], '7');
    assert.deepEqual(JSON.parse(init.body), {});
    return newApiCookieResponse(
      {
        success: true,
        data: {
          access_token: accessToken,
          user: { id: 7 },
          session: 'sess-new',
          access_expires_at: Math.floor((now + 900_000) / 1000),
        },
      },
      ['session=newcookie; Path=/; HttpOnly', 'refresh=r2; Path=/; HttpOnly'],
    );
  });
  const res = await refreshNewApi({
    baseUrl: 'https://newapi.test/',
    cookie: 'session=old; refresh=r1',
    session: 'sess-old',
    userId: 7,
    fetchImpl,
    nowMs: now,
  });
  assert.equal(calls.length, 1);
  assert.equal(res.access_token, accessToken);
  assert.equal(res.expires_at, now + 900_000);
  assert.equal(res.session, 'sess-new');
  assert.equal(res.user_id, 7);
  assert.equal(res.cookie, 'session=newcookie; refresh=r2');
});

test('refreshNewApi：没有 Set-Cookie 时保留旧 cookie，只用 access_expires_at 兜底', async () => {
  const now = 1760000000000;
  const accessToken = makeJwt({ sub: 'no-exp' });
  const { fetchImpl } = createMockFetch(() =>
    newApiCookieResponse({ success: true, data: { access_token: accessToken, access_expires_at: now + 600_000 } }),
  );
  const res = await refreshNewApi({ baseUrl: 'https://newapi.test', cookie: 'session=keep', fetchImpl, nowMs: now });
  assert.equal(res.cookie, 'session=keep');
  assert.equal(res.expires_at, now + 600_000);
});

test('refreshNewApi：401 / 429 / success:false / 非 JWT / 缺 cookie 都失败，错误里不含凭据', async () => {
  const cookie = 'session=secret; refresh=secret-refresh';
  const failing = (fetchImpl) => refreshNewApi({ baseUrl: 'https://newapi.test', cookie, fetchImpl });

  await assert.rejects(() => failing(async () => jsonResponse({}, 401)), (err) => {
    assert.ok(err instanceof UpstreamAuthError);
    assert.equal(err.reason, 'refresh_unauthorized');
    assert.ok(!err.message.includes('secret'));
    return true;
  });
  await assert.rejects(() => failing(async () => jsonResponse({}, 429)), (err) => err.kind === 'rate_limited');
  await assert.rejects(
    () => failing(async () => jsonResponse({ success: false, message: '无效的令牌' })),
    (err) => err.reason === 'refresh_rejected',
  );
  await assert.rejects(
    () => failing(async () => jsonResponse({ success: true, data: { access_token: 'not-a-jwt' } })),
    (err) => {
      assert.equal(err.reason, 'refresh_invalid_token');
      assert.ok(!err.message.includes('secret-refresh'));
      return true;
    },
  );
  await assert.rejects(
    () => refreshNewApi({ baseUrl: 'https://newapi.test', cookie: '', fetchImpl: async () => jsonResponse({}) }),
    (err) => err.reason === 'missing_cookie',
  );
});

test('newApiRefreshThreshold：15 分钟 token 按寿命 1/4 取阈值，不会每轮都刷', () => {
  const now = 1760000000000;
  const shortToken = makeJwt({ iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 900 });
  assert.equal(jwtLifetimeMs(shortToken), 900_000);
  assert.equal(newApiRefreshThreshold({ token: shortToken }), Math.round(900_000 / 4));
  const longToken = makeJwt({ iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 30 * 86400 });
  assert.equal(newApiRefreshThreshold({ token: longToken }), NEWAPI_REFRESH_THRESHOLD_MS);
  assert.equal(newApiRefreshThreshold({ token: 'not-a-jwt' }), NEWAPI_REFRESH_THRESHOLD_MS);
  assert.equal(newApiRefreshThreshold({ token: longToken }, 120_000), 120_000);
});

test('ensureAuth：NewAPI 15 分钟 token 剩 10 分钟不主动换签，剩 2 分钟才换', async () => {
  const now = 1760000000000;
  const mk = (remainingSec) =>
    newApiAccount({
      auth: {
        mode: 'cookie',
        cookie: 'session=abc; refresh=r1',
        token: makeJwt({
          iat: Math.floor(now / 1000) - (900 - remainingSec),
          exp: Math.floor(now / 1000) + remainingSec,
        }),
        token_env: null,
      },
    });

  const cold = createMockFetch(() => {
    throw new Error('剩 10 分钟不应刷新');
  });
  const session = await ensureAuth(mk(600), { nowMs: now, fetchImpl: cold.fetchImpl });
  assert.equal(session.refreshed, false);
  assert.equal(cold.calls.length, 0);

  const newToken = makeJwt({ iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 900 });
  const hot = createMockFetch(() =>
    newApiCookieResponse({ success: true, data: { access_token: newToken } }, ['session=fresh; Path=/']),
  );
  const refreshed = await ensureAuth(mk(120), { nowMs: now, fetchImpl: hot.fetchImpl });
  assert.equal(refreshed.refreshed, true);
  assert.equal(hot.calls[0].path, '/api/user/auth/refresh');
});

test('ensureAuth：NewAPI cookie 换签后写回 token/cookie/expires_at/session，其他账户不动', async () => {
  const now = 1760000000000;
  const dir = makeTempDir('v2-auth-');
  const newToken = makeJwt({ iat: Math.floor(now / 1000), exp: Math.floor((now + 900_000) / 1000) });
  const file = writeAccountsFile(dir, [
    {
      id: 'eula',
      name: 'eula',
      kind: 'newapi',
      base_url: 'https://newapi.test',
      auth: {
        mode: 'cookie',
        cookie: 'session=old; refresh=r1',
        token: makeJwt({ iat: Math.floor((now - 900_000) / 1000), exp: Math.floor((now + 30_000) / 1000) }),
        expires_at: now + 30_000,
        user_id: 7,
        session: 'sess-old',
        token_env: null,
      },
    },
    { id: 'other', name: 'other', kind: 'sub2api', base_url: 'https://other.test', auth: { mode: 'bearer', token: 'untouched' }, extra_field: 'keep-me' },
  ]);

  const { fetchImpl, calls } = createMockFetch((u, init) => {
    assert.equal(u.pathname, '/api/user/auth/refresh');
    assert.equal(init.headers.Cookie, 'session=old; refresh=r1');
    assert.equal(init.headers['X-Auth-Session'], 'sess-old');
    return newApiCookieResponse(
      {
        success: true,
        data: {
          access_token: newToken,
          user: { id: 7 },
          session: 'sess-new',
          access_expires_at: Math.floor((now + 900_000) / 1000),
        },
      },
      ['session=newcookie; Path=/; HttpOnly'],
    );
  });

  try {
    const config = loadConfig(file, { writable: true });
    const account = config.accounts.find((a) => a.id === 'eula');
    const session = await ensureAuth(account, {
      nowMs: now,
      fetchImpl,
      configPath: file,
      writable: true,
    });
    assert.equal(calls.length, 1);
    assert.equal(session.refreshed, true);
    assert.equal(session.wrote, true);
    assert.equal(session.token, newToken);
    assert.equal(session.headers.Cookie, 'session=newcookie; refresh=r1');
    assert.equal(session.headers['X-Auth-Session'], 'sess-new');
    assert.equal(session.headers['New-Api-User'], '7');
    assert.ok(!JSON.stringify({ headers: session.headers, token: session.token }).includes('session=old'));

    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const savedEula = saved.accounts.find((a) => a.id === 'eula');
    assert.equal(savedEula.auth.token, newToken);
    assert.equal(savedEula.auth.cookie, 'session=newcookie; refresh=r1');
    assert.equal(savedEula.auth.expires_at, now + 900_000);
    assert.equal(savedEula.auth.session, 'sess-new');
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(!raw.includes('session=old'));
    assert.ok(!raw.includes('sess-old'));
    const other = saved.accounts.find((a) => a.id === 'other');
    assert.equal(other.auth.token, 'untouched');
    assert.equal(other.extra_field, 'keep-me');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureAuth：NewAPI 纯 cookie 配置不主动换签，等 401 再换', async () => {
  const now = 1760000000000;
  const account = newApiAccount({
    auth: { mode: 'cookie', cookie: 'session=abc', token: '', expires_at: now + 60_000, user_id: 42, token_env: null },
  });
  const { fetchImpl, calls } = createMockFetch(() => {
    throw new Error('不应主动请求');
  });
  const session = await ensureAuth(account, { nowMs: now, fetchImpl });
  assert.equal(session.refreshed, false);
  assert.equal(calls.length, 0);
  assert.equal(authCanRefresh(account, account.auth), true);
});

test('ensureAuth：NewAPI 没有 cookie 也没有 token 抛 missing_cookie', async () => {
  const account = newApiAccount({
    auth: { mode: 'cookie', cookie: null, token: '', refresh_token: null, token_env: null },
  });
  await assert.rejects(
    () => ensureAuth(account, { fetchImpl: async () => jsonResponse({}) }),
    (err) => err instanceof UpstreamAuthError && err.reason === 'missing_cookie',
  );
  await assert.rejects(
    () => ensureAuth(account, { fetchImpl: async () => jsonResponse({}), force: true }),
    (err) => err.reason === 'missing_cookie',
  );
});

test('ensureAuth：主动换签失败但旧 token 仍可用时软失败，继续用旧凭据', async () => {
  const now = 1760000000000;
  const account = newApiAccount({
    auth: {
      mode: 'cookie',
      cookie: 'session=abc; refresh=r1',
      token: 'old-token',
      expires_at: now + 60_000,
      token_env: null,
    },
  });
  const { fetchImpl, calls } = createMockFetch(() => jsonResponse({}, 401));
  const session = await ensureAuth(account, { nowMs: now, fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(session.refreshed, false);
  assert.equal(session.refresh_error, 'refresh_failed');
  assert.equal(session.auth.cookie, 'session=abc; refresh=r1');
  assert.equal(session.headers.Cookie, 'session=abc; refresh=r1');
});

test('ensureAuth：强制换签失败仍抛错（旧 token 已确认失效）', async () => {
  const now = 1760000000000;
  const account = newApiAccount({
    auth: { mode: 'cookie', cookie: 'session=abc', token: 'old-token', token_env: null },
  });
  const { fetchImpl } = createMockFetch(() => jsonResponse({}, 401));
  await assert.rejects(
    () => ensureAuth(account, { nowMs: now, fetchImpl, force: true }),
    (err) => err instanceof UpstreamAuthError && err.reason === 'refresh_unauthorized',
  );
});

test('写回并发保护：换签期间凭据被其他进程改过则放弃写回，不覆盖', async () => {  const now = 1760000000000;
  const dir = makeTempDir('v2-auth-');
  const file = writeAccountsFile(dir, [
    {
      id: 'eula',
      name: 'eula',
      kind: 'newapi',
      base_url: 'https://newapi.test',
      auth: { mode: 'cookie', cookie: 'session=old; refresh=r1', token: 'old-token', expires_at: now + 60_000, token_env: null },
    },
  ]);
  const newToken = makeJwt({ iat: Math.floor(now / 1000), exp: Math.floor((now + 900_000) / 1000) });
  const { fetchImpl } = createMockFetch(() => {
    // 模拟另一个进程在本次换签期间写入了更新的凭据
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    saved.accounts[0].auth.token = 'other-process-token';
    saved.accounts[0].auth.cookie = 'session=other';
    fs.writeFileSync(file, `${JSON.stringify(saved, null, 2)}\n`);
    return newApiCookieResponse({ success: true, data: { access_token: newToken } }, ['session=fresh; Path=/']);
  });
  try {
    const config = loadConfig(file, { writable: true });
    const session = await ensureAuth(config.accounts[0], {
      nowMs: now,
      fetchImpl,
      configPath: file,
      writable: true,
    });
    assert.equal(session.refreshed, true);
    assert.equal(session.wrote, false);
    assert.equal(session.write_error, 'write_conflict');
    assert.equal(session.token, newToken);
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(raw.includes('other-process-token'));
    assert.ok(!raw.includes(newToken));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureAuth：换签返回的 user.id 与配置不一致 → cookie_account_mismatch，不采用新 token', async () => {
  const now = 1760000000000;
  const account = newApiAccount({
    auth: {
      mode: 'cookie',
      cookie: 'session=other-account',
      token: 'old-token',
      expires_at: now + 60_000,
      user_id: 7,
      token_env: null,
    },
  });
  const foreignToken = makeJwt({ iat: Math.floor(now / 1000), exp: Math.floor((now + 900_000) / 1000) });
  const { fetchImpl } = createMockFetch(() =>
    newApiCookieResponse({ success: true, data: { access_token: foreignToken, user: { id: 8 } } }),
  );

  // 强制换签时明确失败，不返回别人的 token
  await assert.rejects(
    () => ensureAuth(account, { nowMs: now, fetchImpl, force: true }),
    (err) => err instanceof UpstreamAuthError && err.reason === 'cookie_account_mismatch',
  );

  // 主动换签（临近到期）属软失败：继续用旧 token，且不写回
  const session = await ensureAuth(account, { nowMs: now, fetchImpl });
  assert.equal(session.refreshed, false);
  assert.equal(session.refresh_error, 'refresh_failed');
  assert.notEqual(session.token, foreignToken);
});

