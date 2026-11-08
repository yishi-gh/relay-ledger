/**
 * 面板登录服务单测：不监听端口，直接调 createPanelAuth(...).handleRequest。
 * 密码/密钥文件用临时目录现造，不读写真实 /root 下的凭据。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createPanelAuth,
  createSessionToken,
  loadCredentials,
  readCookie,
  renderLoginPage,
  safeNextPath,
  verifySessionToken,
} from '../tools/panel-auth.mjs';

const PASSWORD = 'test-password-9f2c';

/** 临时目录造密码/密钥文件 → loadCredentials → createPanelAuth */
function makeAuth(t, { password = PASSWORD, secret = 'test-secret-8a1d4e' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-auth-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const passwordFile = path.join(dir, 'panel-password');
  const secretFile = path.join(dir, 'session-secret');
  fs.writeFileSync(passwordFile, `${password}\n`, 'utf8');
  fs.writeFileSync(secretFile, `${secret}\n`, 'utf8');

  const credentials = loadCredentials({ passwordFile, sessionSecretFile: secretFile });
  assert.equal(credentials.password, password, '密码文件读取后应 trim');
  assert.equal(credentials.secret, secret, '密钥文件读取后应 trim');

  const lines = [];
  const auth = createPanelAuth({
    password: credentials.password,
    secret: credentials.secret,
    logger: { info: (line) => lines.push(line), error: (line) => lines.push(line) },
  });
  return { auth, lines, password, secret, dir, passwordFile, secretFile };
}

function formBody(fields) {
  return new URLSearchParams(fields).toString();
}

function post(auth, fields, { ip = '203.0.113.7' } = {}) {
  return auth.handleRequest({
    method: 'POST',
    url: '/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: formBody(fields),
    remoteAddress: ip,
  });
}

function verify(auth, cookie, { ip = '203.0.113.7' } = {}) {
  return auth.handleRequest({
    method: 'GET',
    url: '/verify',
    headers: { cookie },
    remoteAddress: ip,
  });
}

function setCookieOf(response) {
  return response.headers['set-cookie'] ?? '';
}

test('密码正确：302 + 带 rl_session 的 Set-Cookie，next 保留', async (t) => {
  const { auth, secret } = makeAuth(t);
  const next = '/api/profit?granularity=day';
  const res = await post(auth, { username: 'admin', password: PASSWORD, next });

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, next);

  const cookie = setCookieOf(res);
  assert.match(cookie, /^rl_session=[^;]+;/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Max-Age=2592000/);

  const token = cookie.slice('rl_session='.length, cookie.indexOf(';'));
  assert.equal((token.match(/\./g) ?? []).length, 1, '令牌是 <payload>.<sig>');
  assert.equal(verifySessionToken(secret, token).ok, true);

  const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
  assert.equal(payload.u, 'admin');
  assert.ok(payload.exp > Date.now() + 29 * 24 * 3600 * 1000, '有效期约 30 天');

  const ok = await verify(auth, `rl_session=${token}`);
  assert.equal(ok.status, 204);
  assert.equal(ok.body, '');
});

test('密码错误：401、无 Set-Cookie、页面提示「密码不对」', async (t) => {
  const { auth } = makeAuth(t);
  const res = await post(auth, { username: 'admin', password: 'wrong-password', next: '/' });

  assert.equal(res.status, 401);
  assert.equal(res.headers['set-cookie'], undefined);
  assert.match(res.body, /密码不对/);
});

test('next 是站外地址时回落到 /', async (t) => {
  const { auth } = makeAuth(t);

  for (const next of ['https://evil.com/x', '//evil.com/x', '/\\evil.com', 'evil.com']) {
    const res = await post(auth, { username: 'admin', password: PASSWORD, next });
    assert.equal(res.status, 302, `next=${next} 应登录成功`);
    assert.equal(res.headers.location, '/', `next=${next} 应回落到 /`);
    assert.notEqual(res.headers['set-cookie'], undefined);
  }
});

test('safeNextPath 只放行站内路径', () => {
  assert.equal(safeNextPath('/api/profit?granularity=day'), '/api/profit?granularity=day');
  assert.equal(safeNextPath('/'), '/');
  assert.equal(safeNextPath('https://evil.com'), '/');
  assert.equal(safeNextPath('//evil.com'), '/');
  assert.equal(safeNextPath('/\\evil.com'), '/');
  assert.equal(safeNextPath('/%2f%2fevil.com'), '/');
  assert.equal(safeNextPath('/%5Cevil.com'), '/');
  assert.equal(safeNextPath('/a\r\nSet-Cookie: x=1'), '/');
  assert.equal(safeNextPath(undefined), '/');
  assert.equal(safeNextPath(''), '/');
});

test('Cookie 被篡改（改签名）→ /verify 401', async (t) => {
  const { auth, secret } = makeAuth(t);
  const token = createSessionToken(secret);
  const [payload, sig] = token.split('.');
  const flipped = `${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`;

  const res = await verify(auth, `rl_session=${payload}.${flipped}`);
  assert.equal(res.status, 401);
  assert.equal(res.body, '');
});

test('Cookie 过期（签名正确）→ /verify 401', async (t) => {
  const { auth, secret } = makeAuth(t);
  const expired = createSessionToken(secret, { exp: Date.now() - 60_000 });

  const res = await verify(auth, `rl_session=${expired}`);
  assert.equal(res.status, 401);
});

test('合法 Cookie → /verify 204 且无 body', async (t) => {
  const { auth, secret } = makeAuth(t);
  const token = createSessionToken(secret);

  const res = await verify(auth, `other=1; rl_session=${token}; trailing=2`);
  assert.equal(res.status, 204);
  assert.equal(res.body, '');
  assert.equal(auth.verify(`rl_session=${token}`).ok, true);
});

test('连续 5 次失败后，第 6 次即使密码正确也 429', async (t) => {
  const { auth } = makeAuth(t);
  const ip = '198.51.100.23';

  for (let i = 1; i <= 5; i += 1) {
    const res = await post(auth, { username: 'admin', password: `bad-${i}` }, { ip });
    assert.equal(res.status, 401, `第 ${i} 次失败应为 401`);
    assert.equal(res.headers['set-cookie'], undefined);
  }

  const blocked = await post(auth, { username: 'admin', password: PASSWORD }, { ip });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers['set-cookie'], undefined);
  assert.match(blocked.headers['retry-after'], /^\d+$/);
  assert.match(blocked.body, /尝试次数过多/);

  // 其他 IP 不受影响
  const other = await post(auth, { username: 'admin', password: PASSWORD }, { ip: '198.51.100.24' });
  assert.equal(other.status, 302);
});

test('登录页 HTML 含浏览器保存密码所需的 autocomplete 与 password 类型', async (t) => {
  const { auth } = makeAuth(t);
  const res = await auth.handleRequest({
    method: 'GET',
    url: '/login?next=%2Fapi%2Fquality',
    headers: {},
    remoteAddress: '203.0.113.9',
  });

  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.ok(res.body.includes('autocomplete="username"'));
  assert.ok(res.body.includes('autocomplete="current-password"'));
  assert.ok(res.body.includes('type="password"'));
  assert.ok(res.body.includes('name="password"'));
  assert.ok(res.body.includes('method="post"'));
  assert.ok(res.body.includes('action="/login"'));
  assert.ok(res.body.includes('value="/api/quality"'), 'next 应进入隐藏字段');
  assert.ok(!/<link |<script /.test(res.body), '不引外部资源');
});

test('页面与日志文本不含密码原文', async (t) => {
  const { auth, lines } = makeAuth(t);

  const okPage = await auth.handleRequest({ method: 'GET', url: '/login', headers: {} });
  assert.ok(!okPage.body.includes(PASSWORD));

  const bad = await post(auth, { username: 'admin', password: PASSWORD });
  assert.equal(bad.status, 302);
  assert.ok(!bad.body.includes(PASSWORD));
  assert.ok(!setCookieOf(bad).includes(PASSWORD));

  const failed = await post(auth, { username: 'admin', password: `${PASSWORD}-x` });
  assert.equal(failed.status, 401);

  const all = [renderLoginPage({ next: '/' }), ...lines].join('\n');
  assert.ok(!all.includes(PASSWORD), '页面与日志不得出现密码');
  assert.ok(!all.includes('test-secret-8a1d4e'), '页面与日志不得出现密钥');
  assert.ok(lines.some((line) => line.includes('登录成功')));
  assert.ok(lines.some((line) => line.includes('登录失败')));
});

test('logout：清 Cookie 并 302 到 /login', async (t) => {
  const { auth } = makeAuth(t);
  const res = await auth.handleRequest({ method: 'GET', url: '/logout', headers: {} });

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login');
  assert.match(setCookieOf(res), /Max-Age=0/);
});

test('缺密钥文件时 loadCredentials 报错，不自动生成', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-auth-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const passwordFile = path.join(dir, 'panel-password');
  fs.writeFileSync(passwordFile, `${PASSWORD}\n`, 'utf8');
  const sessionSecretFile = path.join(dir, 'missing-secret');

  assert.throws(
    () => loadCredentials({ passwordFile, sessionSecretFile }),
    /找不到文件/,
  );
  assert.equal(fs.existsSync(sessionSecretFile), false, '不应创建密钥文件');
});

test('readCookie 只取同名项', () => {
  assert.equal(readCookie('a=1; rl_session=abc.def; b=2', 'rl_session'), 'abc.def');
  assert.equal(readCookie('rl_session_x=1', 'rl_session'), '');
  assert.equal(readCookie(undefined, 'rl_session'), '');
});
