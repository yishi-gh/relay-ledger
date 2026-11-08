#!/usr/bin/env node
/**
 * 面板登录服务：为 relay-ledger 面板提供登录页、会话 Cookie 与 nginx auth_request 校验端点，
 * 替代 nginx Basic Auth（Basic Auth 在 Edge 里既不弹「保存密码」，也不会保持登录态）。
 *
 * 用法：
 *   node v2/tools/panel-auth.mjs                 # 127.0.0.1:8790
 *   node v2/tools/panel-auth.mjs --port=8791     # 或用 PORT 环境变量
 *
 * 环境变量：
 *   PANEL_PASSWORD_FILE        明文密码文件，默认 /root/relay-ledger-panel-password（读取后 trim）
 *   PANEL_SESSION_SECRET_FILE  HMAC 签名密钥文件，默认 /root/relay-ledger-session-secret
 *                              文件不存在直接报错退出：不自动生成，否则重启后所有会话失效
 *
 * 本文件只依赖 node 内置模块，不 import 项目其它代码；secrets 只在进程内存中使用，
 * 不写日志、不回显。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8790;
const DEFAULT_PASSWORD_FILE = '/root/relay-ledger-panel-password';
const DEFAULT_SESSION_SECRET_FILE = '/root/relay-ledger-session-secret';

const USERNAME = 'admin';
const COOKIE_NAME = 'rl_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
const SESSION_MAX_AGE_S = SESSION_TTL_MS / 1000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 60_000;
const MAX_BODY_BYTES = 4 * 1024;
const RATE_TABLE_SOFT_LIMIT = 1024;

// ---------------------------------------------------------------- 会话令牌

/** HMAC-SHA256(secret, payload)，base64url 编码 */
export function signPayload(secret, payloadB64) {
  return crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

/**
 * 生成会话令牌 `<payload>.<sig>`。
 * payload = base64url({ u: 'admin', exp: <ms> })；exp 可显式传入，便于测试过期分支。
 */
export function createSessionToken(secret, { exp, ttlMs = SESSION_TTL_MS, now = Date.now() } = {}) {
  const expiresAt = Number.isFinite(exp) ? exp : now + ttlMs;
  const payloadB64 = Buffer.from(JSON.stringify({ u: USERNAME, exp: expiresAt }), 'utf8').toString(
    'base64url',
  );
  return `${payloadB64}.${signPayload(secret, payloadB64)}`;
}

/** 校验签名、结构与过期时间；返回 { ok, exp?, reason? } */
export function verifySessionToken(secret, token, nowMs = Date.now()) {
  if (typeof token !== 'string' || !token) return { ok: false, reason: 'missing' };
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return { ok: false, reason: 'malformed' };

  const payloadB64 = token.slice(0, dot);
  const provided = Buffer.from(token.slice(dot + 1), 'utf8');
  const expected = Buffer.from(signPayload(secret, payloadB64), 'utf8');
  // 定长比较：base64url 的签名长度固定，长度不同直接判失败，不进入 timingSafeEqual
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'bad_payload' };
  }
  if (!payload || typeof payload !== 'object' || payload.u !== USERNAME) {
    return { ok: false, reason: 'bad_payload' };
  }
  if (!Number.isFinite(payload.exp) || payload.exp <= nowMs) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, exp: payload.exp };
}

/** 密码比较：先做定长摘要，再用 timingSafeEqual，避免按长度/前缀泄露 */
function samePassword(provided, expected) {
  const left = crypto.createHash('sha256').update(String(provided), 'utf8').digest();
  const right = crypto.createHash('sha256').update(String(expected), 'utf8').digest();
  return crypto.timingSafeEqual(left, right);
}

// ---------------------------------------------------------------- Cookie / 跳转

/**
 * 只接受站内绝对路径：必须以单个 `/` 开头。
 * `//evil.com` 是协议相对地址，`/\evil.com` 会被浏览器归一成 `//evil.com`，
 * `/%2f%2fevil.com`、`/%5cevil.com` 这类编码过的同上，都回落到 `/`。
 */
export function safeNextPath(raw) {
  if (typeof raw !== 'string') return '/';
  const value = raw.trim();
  if (!value.startsWith('/')) return '/';
  if (value.startsWith('//')) return '/';
  if (value.includes('\\')) return '/';
  if (/^\/%2f|^\/%5c/i.test(value)) return '/';
  // 控制字符不进入 Location 头
  if (/[\u0000-\u001f\u007f]/.test(value)) return '/';
  return value;
}

export function readCookie(cookieHeader, name) {
  const raw = Array.isArray(cookieHeader) ? cookieHeader.join(';') : String(cookieHeader ?? '');
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return '';
}

function sessionCookie(token) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_S}`;
}

function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

// ---------------------------------------------------------------- 登录页

function escapeHtml(value) {
  const table = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value).replace(/[&<>"']/g, (ch) => table[ch]);
}

const PAGE_STYLE = `
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
      background: #0e1014; color: #e6e8ee;
      font: 15px/1.55 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    }
    .card {
      width: min(360px, calc(100vw - 32px)); padding: 28px 24px;
      background: #171a21; border: 1px solid #2a2f3a; border-radius: 10px;
    }
    h1 { margin: 0 0 4px; font-size: 18px; font-weight: 600; }
    .sub { margin: 0 0 20px; color: #98a1b0; font-size: 13px; }
    .notice {
      margin: 0 0 16px; padding: 8px 10px; font-size: 13px;
      background: #241416; border: 1px solid #6d2a2a; border-radius: 6px; color: #ff9b9b;
    }
    label { display: block; margin: 0 0 6px; color: #98a1b0; font-size: 13px; }
    input[type="text"], input[type="password"] {
      width: 100%; margin: 0 0 16px; padding: 9px 10px; font-size: 15px;
      color: #e6e8ee; background: #0e1014; border: 1px solid #2f3644; border-radius: 6px;
    }
    input[type="text"]:focus, input[type="password"]:focus { border-color: #4a7cf7; outline: none; }
    button {
      width: 100%; padding: 10px; font-size: 15px; color: #fff; cursor: pointer;
      background: #3b6ef0; border: 0; border-radius: 6px;
    }
    button:hover { background: #4a7cf7; }
`;

/**
 * 登录页：自包含 HTML（内联样式、不引外部资源）。
 * username / password 的 autocomplete 语义是 Edge 弹「保存密码」的前提。
 */
export function renderLoginPage({ next = '/', message = '' } = {}) {
  const notice = message ? `<p class="notice" role="alert">${escapeHtml(message)}</p>` : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>登录 · 中转账本</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main class="card">
  <h1>中转账本</h1>
  <p class="sub">登录后查看余额、消费与站点日志。</p>
  ${notice}
  <form method="post" action="/login" autocomplete="on">
    <input type="hidden" name="next" value="${escapeHtml(safeNextPath(next))}">
    <label for="username">用户名</label>
    <input id="username" name="username" type="text" value="admin" autocomplete="username"
           autocapitalize="none" spellcheck="false" required>
    <label for="password">密码</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
    <button type="submit">登录</button>
  </form>
</main>
</body>
</html>
`;
}

// ---------------------------------------------------------------- 响应

const BASE_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

function htmlResponse(status, html, extra = {}) {
  const body = typeof html === 'string' && !html.startsWith('<') ? `<p>${escapeHtml(html)}</p>` : html;
  return {
    status,
    headers: {
      ...BASE_HEADERS,
      'content-type': 'text/html; charset=utf-8',
      'content-language': 'zh-CN',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
      'x-frame-options': 'DENY',
      ...extra,
    },
    body,
  };
}

function loginPageResponse(status, { next = '/', message = '', extra = {} } = {}) {
  return htmlResponse(status, renderLoginPage({ next, message }), extra);
}

function emptyResponse(status) {
  return { status, headers: { ...BASE_HEADERS }, body: '' };
}

// ---------------------------------------------------------------- 主体

function normalizeHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    out[String(key).toLowerCase()] = value;
  }
  return out;
}

function isLoopback(address) {
  const value = String(address ?? '');
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

/**
 * 限速键：只信任本机反代设置的 X-Real-IP / X-Forwarded-For。
 * 服务只监听 127.0.0.1，远程连接直接用自己的地址。
 */
function clientIp(headers, remoteAddress) {
  if (isLoopback(remoteAddress)) {
    const real = headers['x-real-ip'];
    if (typeof real === 'string' && real.trim()) return real.trim();
    const forwarded = headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  }
  return String(remoteAddress ?? '') || 'unknown';
}

function stamp(nowMs) {
  return new Date(nowMs).toISOString();
}

function createLogger(logger) {
  if (typeof logger === 'function') return { info: logger, error: logger };
  return {
    info: (message) => logger?.info?.(message),
    error: (message) => (logger?.error ?? logger?.info)?.(message),
  };
}

/** 读取并 trim 一个凭据文件；文件缺失/为空时抛错（绝不自动生成） */
function readTrimmedFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`找不到文件: ${file}`);
    throw new Error(`读取失败 ${file}: ${err.code ?? err.message}`);
  }
  return text.trim();
}

export function loadCredentials({
  passwordFile = DEFAULT_PASSWORD_FILE,
  sessionSecretFile = DEFAULT_SESSION_SECRET_FILE,
} = {}) {
  const password = readTrimmedFile(passwordFile);
  if (!password) throw new Error(`密码文件为空: ${passwordFile}`);
  const secret = readTrimmedFile(sessionSecretFile);
  if (!secret) throw new Error(`签名密钥文件为空: ${sessionSecretFile}`);
  return { password, secret };
}

/**
 * 创建登录处理器（不自动 listen，便于测试直接调用 handleRequest）。
 *
 * handleRequest({ method, url, headers, body, remoteAddress }) → { status, headers, body }
 * 返回的响应头键名统一小写，body 为字符串。
 */
export function createPanelAuth({
  password,
  secret,
  logger = console,
  now = Date.now,
  maxFailures = MAX_FAILURES,
  lockoutMs = LOCKOUT_MS,
  sessionTtlMs = SESSION_TTL_MS,
} = {}) {
  if (typeof password !== 'string' || !password) throw new Error('createPanelAuth 需要非空 password');
  if (typeof secret !== 'string' || !secret) throw new Error('createPanelAuth 需要非空 secret');

  const log = createLogger(logger);
  /** ip -> { count, lockedUntil, lastAt } */
  const rate = new Map();

  function prune(nowMs) {
    if (rate.size <= RATE_TABLE_SOFT_LIMIT) return;
    for (const [key, entry] of rate) {
      if (entry.lockedUntil <= nowMs) rate.delete(key);
    }
  }

  function lockSecondsLeft(ip, nowMs) {
    const entry = rate.get(ip);
    if (!entry) return 0;
    if (entry.lockedUntil <= nowMs) {
      if (entry.lockedUntil > 0) rate.delete(ip);
      return 0;
    }
    return Math.max(1, Math.ceil((entry.lockedUntil - nowMs) / 1000));
  }

  function registerFailure(ip, nowMs) {
    const entry = rate.get(ip) ?? { count: 0, lockedUntil: 0, lastAt: nowMs };
    entry.count += 1;
    entry.lastAt = nowMs;
    if (entry.count >= maxFailures) {
      entry.lockedUntil = nowMs + lockoutMs;
      entry.count = 0;
    }
    rate.set(ip, entry);
    prune(nowMs);
    return entry;
  }

  function lockedResponse(seconds) {
    return loginPageResponse(429, {
      message: `尝试次数过多，请 ${seconds} 秒后再试。`,
      extra: { 'retry-after': String(seconds) },
    });
  }

  function handleLoginPage(parsed, headers, remoteAddress, nowMs) {
    const ip = clientIp(headers, remoteAddress);
    const left = lockSecondsLeft(ip, nowMs);
    if (left > 0) {
      log.info(`[panel-auth] ${stamp(nowMs)} 登录限速`);
      return lockedResponse(left);
    }
    return loginPageResponse(200, { next: safeNextPath(parsed.searchParams.get('next') ?? '/') });
  }

  function handleLoginSubmit(headers, rawBody, remoteAddress, nowMs) {
    const ip = clientIp(headers, remoteAddress);
    const left = lockSecondsLeft(ip, nowMs);
    if (left > 0) {
      log.info(`[panel-auth] ${stamp(nowMs)} 登录限速`);
      return lockedResponse(left);
    }

    const contentType = String(headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (contentType && contentType !== 'application/x-www-form-urlencoded') {
      return loginPageResponse(415, { message: '提交格式不支持。' });
    }

    const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody ?? '');
    if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
      return loginPageResponse(413, { message: '提交内容过大。' });
    }

    const params = new URLSearchParams(text);
    const user = (params.get('username') ?? '').trim();
    const supplied = params.get('password') ?? '';
    const next = safeNextPath(params.get('next'));

    if (user === USERNAME && samePassword(supplied, password)) {
      rate.delete(ip);
      log.info(`[panel-auth] ${stamp(nowMs)} 登录成功`);
      return {
        status: 302,
        headers: {
          ...BASE_HEADERS,
          location: next,
          'set-cookie': sessionCookie(createSessionToken(secret, { now: nowMs, ttlMs: sessionTtlMs })),
        },
        body: '',
      };
    }

    registerFailure(ip, nowMs);
    log.info(`[panel-auth] ${stamp(nowMs)} 登录失败`);
    return loginPageResponse(401, { next, message: '密码不对' });
  }

  async function handleRequest({
    method = 'GET',
    url = '/',
    headers: rawHeaders = {},
    body = '',
    remoteAddress = '',
  } = {}) {
    const headers = normalizeHeaders(rawHeaders);
    const nowMs = now();

    let parsed;
    try {
      parsed = new URL(url, `http://${DEFAULT_HOST}`);
    } catch {
      return htmlResponse(400, '请求无效。');
    }

    if (parsed.pathname === '/login') {
      if (method === 'GET' || method === 'HEAD') {
        return handleLoginPage(parsed, headers, remoteAddress, nowMs);
      }
      if (method === 'POST') return handleLoginSubmit(headers, body, remoteAddress, nowMs);
      return htmlResponse(405, '只支持 GET / POST。', { allow: 'GET, POST' });
    }

    if (parsed.pathname === '/verify') {
      if (method !== 'GET' && method !== 'HEAD') {
        return { status: 405, headers: { ...BASE_HEADERS, allow: 'GET' }, body: '' };
      }
      const token = readCookie(headers.cookie, COOKIE_NAME);
      const result = verifySessionToken(secret, token, nowMs);
      return emptyResponse(result.ok ? 204 : 401);
    }

    if (parsed.pathname === '/logout') {
      if (method !== 'GET') return htmlResponse(405, '只支持 GET。', { allow: 'GET' });
      return {
        status: 302,
        headers: { ...BASE_HEADERS, location: '/login', 'set-cookie': clearSessionCookie() },
        body: '',
      };
    }

    return htmlResponse(404, '页面不存在。');
  }

  // 无法从 cookie 直接判断时，可用它做一次显式校验
  function verify(cookieHeader, nowMs = now()) {
    return verifySessionToken(secret, readCookie(cookieHeader, COOKIE_NAME), nowMs);
  }

  return { handleRequest, verify };
}

// ---------------------------------------------------------------- HTTP 服务

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve({ tooLarge, buffer: Buffer.concat(chunks) }));
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('request aborted')));
  });
}

export function createPanelAuthServer({
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  password,
  secret,
  logger = console,
} = {}) {
  const log = createLogger(logger);
  const auth = createPanelAuth({ password, secret, logger });

  const server = http.createServer((req, res) => {
    readBody(req, MAX_BODY_BYTES)
      .then(({ tooLarge, buffer }) => {
        if (tooLarge) {
          if (res.headersSent || res.writableEnded) return;
          res.writeHead(413, {
            'content-type': 'text/plain; charset=utf-8',
            'cache-control': 'no-store',
            connection: 'close',
          });
          res.end('提交内容过大');
          return undefined;
        }
        return auth
          .handleRequest({
            method: req.method,
            url: req.url,
            headers: req.headers,
            body: buffer,
            remoteAddress: req.socket?.remoteAddress ?? '',
          })
          .then((result) => {
            if (res.headersSent || res.writableEnded) return;
            res.writeHead(result.status, result.headers);
            res.end(result.body || undefined);
          });
      })
      .catch((err) => {
        log.error(`[panel-auth] 请求处理失败 ${err.code ?? err.message}`);
        if (res.headersSent || res.writableEnded) return;
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end('服务器内部错误');
      });
  });

  async function start() {
    if (server.listening) return server.address();
    await new Promise((resolve, reject) => {
      const onError = (err) => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
    const address = server.address();
    log.info(`[panel-auth] 已启动 http://${host}:${address.port}`);
    return address;
  }

  async function close() {
    if (!server.listening) return;
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    log.info('[panel-auth] 已停止');
  }

  return { server, start, close, handleRequest: auth.handleRequest };
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const opts = {
    port: Number.parseInt(process.env.PORT ?? '', 10) || DEFAULT_PORT,
    passwordFile: process.env.PANEL_PASSWORD_FILE?.trim() || DEFAULT_PASSWORD_FILE,
    sessionSecretFile: process.env.PANEL_SESSION_SECRET_FILE?.trim() || DEFAULT_SESSION_SECRET_FILE,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--port' || arg === '-p') {
      opts.port = Number.parseInt(argv[++i] ?? '', 10);
    } else if (arg.startsWith('--port=')) {
      opts.port = Number.parseInt(arg.slice('--port='.length), 10);
    } else if (arg === '--password-file') {
      opts.passwordFile = argv[++i] ?? '';
    } else if (arg.startsWith('--password-file=')) {
      opts.passwordFile = arg.slice('--password-file='.length);
    } else if (arg === '--secret-file') {
      opts.sessionSecretFile = argv[++i] ?? '';
    } else if (arg.startsWith('--secret-file=')) {
      opts.sessionSecretFile = arg.slice('--secret-file='.length);
    } else {
      throw new Error(`未知参数: ${arg}（用 --help 查看用法）`);
    }
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
    throw new Error('端口必须是 1..65535 的整数');
  }
  return opts;
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  if (process.platform === 'win32') {
    return path.resolve(entry).toLowerCase() === self.toLowerCase();
  }
  return path.resolve(entry) === self;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 2;
    return;
  }

  if (opts.help) {
    console.log(`用法: node v2/tools/panel-auth.mjs [选项]

  --port, -p <端口>        监听端口，默认 ${DEFAULT_PORT}（仅 127.0.0.1）
  --password-file <路径>   密码文件，默认 ${DEFAULT_PASSWORD_FILE}
  --secret-file <路径>     签名密钥文件，默认 ${DEFAULT_SESSION_SECRET_FILE}
  --help, -h               显示本帮助

环境变量：PANEL_PASSWORD_FILE、PANEL_SESSION_SECRET_FILE、PORT。
签名密钥文件不会自动生成，缺失时直接退出。`);
    return;
  }

  let credentials;
  try {
    credentials = loadCredentials(opts);
  } catch (err) {
    console.error(`[panel-auth] 启动失败: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const service = createPanelAuthServer({
    port: opts.port,
    password: credentials.password,
    secret: credentials.secret,
    logger: { info: (line) => console.log(line), error: (line) => console.error(line) },
  });

  try {
    await service.start();
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      console.error(`[panel-auth] 端口 ${opts.port} 已被占用，换一个 --port 或先停掉旧进程`);
    } else {
      console.error(`[panel-auth] 启动失败: ${err.code ?? err.message}`);
    }
    process.exitCode = 1;
    return;
  }

  const shutdown = () => {
    service
      .close()
      .catch(() => {})
      .finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (isMainModule()) {
  await main();
}
