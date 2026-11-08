/**
 * 上游认证：JWT 到期判断、换签、单文件凭据原子写回。
 *
 * - Sub2API：POST /api/v1/auth/refresh，body {refresh_token}
 * - NewAPI：POST /api/user/auth/refresh（可用 auth.refresh_path 覆盖），用 Cookie 换 access_token
 *
 * 安全约束：
 * - token / refresh_token / cookie 只出现在请求头或写回文件里，绝不进日志、job_runs、错误信息
 * - 只支持 refresh_token / cookie 换签，不做 email/password 登录回退
 * - 换回来的 access_token 必须是可解析 JWT，否则宁可失败
 * - 写回采用临时文件 + rename，失败时保留原文件
 */

import fs from 'node:fs';

import { authHeaders, toNum } from './common.mjs';
import { toEpochMs } from '../../lib/time.mjs';

export const DEFAULT_REFRESH_THRESHOLD_MS = 2 * 60 * 60 * 1000;
/** NewAPI 的 access_token 寿命通常很短（15 分钟级），不能用 2h 阈值，否则每轮都刷新 */
export const NEWAPI_REFRESH_THRESHOLD_MS = 5 * 60 * 1000;
export const NEWAPI_MIN_REFRESH_THRESHOLD_MS = 60 * 1000;
export const SUB2API_REFRESH_PATH = '/api/v1/auth/refresh';
export const NEWAPI_REFRESH_PATH = '/api/user/auth/refresh';

export class UpstreamAuthError extends Error {
  constructor(reason, { status = null, kind = 'auth_failed' } = {}) {
    super(`upstream auth ${reason}${status ? ` ${status}` : ''}`);
    this.name = 'UpstreamAuthError';
    this.reason = reason;
    this.kind = kind;
    this.status = status;
  }
}

/** 配置文件里的凭据已被其他进程更新，放弃本次写回而不是覆盖 */
export class AuthWriteConflictError extends Error {
  constructor(message = 'credentials changed by another writer') {
    super(message);
    this.name = 'AuthWriteConflictError';
    this.code = 'write_conflict';
  }
}

/** 秒/毫秒时间戳统一成毫秒；无法识别返回 null */
export { toEpochMs };

/** base64url 解析 JWT payload.exp（毫秒）；失败返回 null */
export function jwtExpiresAt(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const exp = Number(payload?.exp);
    if (!Number.isFinite(exp) || exp <= 0) return null;
    return Math.round(exp * 1000);
  } catch {
    return null;
  }
}

/** JWT 的有效期长度（exp - iat，毫秒）；缺失返回 null */
export function jwtLifetimeMs(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const exp = Number(payload?.exp);
    const iat = Number(payload?.iat);
    if (!Number.isFinite(exp) || !Number.isFinite(iat)) return null;
    const ms = Math.round((exp - iat) * 1000);
    return ms > 0 ? ms : null;
  } catch {
    return null;
  }
}

/** 是否是结构可解析的 JWT（三段、payload 为 JSON） */
export function isJwt(token) {
  if (typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload !== null && typeof payload === 'object';
  } catch {
    return false;
  }
}

/** 认证到期时间：显式 expires_at 优先，其次 JWT exp */
export function authExpiresAt(auth) {
  const explicit = toEpochMs(auth?.expires_at);
  if (explicit !== null) return explicit;
  return jwtExpiresAt(auth?.token);
}

/**
 * 是否需要换签（Sub2API 语义：refresh_token + expires_at/JWT exp）。
 * cookie 模式、没有 refresh_token、或无法判断到期时都不主动刷新，
 * NewAPI 的 cookie 换签时机由 newApiRefreshThreshold 单独判断。
 */
export function needsRefresh(auth, nowMs = Date.now(), thresholdMs = DEFAULT_REFRESH_THRESHOLD_MS) {
  if (!auth || auth.mode === 'cookie') return false;
  if (typeof auth.refresh_token !== 'string' || !auth.refresh_token) return false;
  const expiresAt = authExpiresAt(auth);
  if (expiresAt === null) return false;
  return expiresAt - nowMs < thresholdMs;
}

/** token 优先取 auth.token（cookie 模式取 auth.cookie），为空回退 token_env 环境变量 */
export function resolveToken(auth) {
  const direct = auth?.mode === 'cookie' ? auth?.cookie ?? auth?.token : auth?.token;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const envName = auth?.token_env;
  if (typeof envName === 'string' && envName) {
    const fromEnv = process.env[envName];
    if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
  }
  return null;
}

function joinUrl(baseUrl, path) {
  return `${String(baseUrl).replace(/\/+$/, '')}${path}`;
}

/** 刷新端点：NewAPI 可被 auth.refresh_path 覆盖，默认 /api/user/auth/refresh */
export function refreshPathFor(account) {
  const configured = account?.auth?.refresh_path;
  if (account?.kind === 'newapi') {
    return typeof configured === 'string' && configured ? configured : NEWAPI_REFRESH_PATH;
  }
  return SUB2API_REFRESH_PATH;
}

/**
 * POST JSON 到刷新端点，统一超时与状态映射。
 * @returns {Promise<{json: any, status: number, response: Response}>}
 */
async function postRefreshJson({ url, headers, body, fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Accept: 'application/json', ...headers },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    });
  } catch {
    throw new UpstreamAuthError(controller.signal.aborted ? 'refresh_timeout' : 'refresh_network');
  } finally {
    clearTimeout(timer);
  }

  const status = response?.status ?? 0;
  if (status === 429) {
    throw new UpstreamAuthError('refresh_rate_limited', { status, kind: 'rate_limited' });
  }
  if (status === 401 || status === 403) {
    throw new UpstreamAuthError('refresh_unauthorized', { status });
  }
  if (status < 200 || status >= 300) {
    throw new UpstreamAuthError('refresh_failed', { status });
  }

  let json;
  try {
    json = await response.json();
  } catch {
    throw new UpstreamAuthError('refresh_bad_json', { status });
  }
  return { json, status, response };
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/** NewAPI 的 data.session 可能是字符串，也可能是 {token|id|session} */
function sessionOf(obj) {
  const session = obj?.session;
  if (typeof session === 'string') return session.trim() || null;
  return firstString(session?.token, session?.id, session?.session);
}

function responseSetCookies(response) {
  const headers = response?.headers;
  if (!headers) return [];
  try {
    if (typeof headers.getSetCookie === 'function') {
      const list = headers.getSetCookie();
      if (Array.isArray(list) && list.length > 0) return list;
    }
  } catch {
    // 老运行时没有 getSetCookie，退回单个 header
  }
  const raw = typeof headers.get === 'function' ? headers.get('set-cookie') : null;
  return typeof raw === 'string' && raw ? [raw] : [];
}

/**
 * 把 Set-Cookie 合并进现有 Cookie 头（同名覆盖，其余保留）。
 * 没有可解析的 Set-Cookie 时原样返回旧 cookie，绝不凭空造 cookie。
 */
export function mergeCookieHeader(cookie, setCookies = []) {
  const base = typeof cookie === 'string' ? cookie : '';
  const list = Array.isArray(setCookies) ? setCookies : [];
  if (list.length === 0) return base || null;

  const jar = new Map();
  const put = (pair) => {
    const idx = pair.indexOf('=');
    if (idx <= 0) return;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    // 空值（删除型 Set-Cookie）不覆盖已有 cookie
    if (!name || !value) return;
    jar.set(name, value);
  };

  for (const part of base.split(';')) put(part);
  for (const header of list) {
    const first = String(header ?? '').split(';')[0];
    if (first) put(first);
  }

  const merged = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
  return merged || base || null;
}

/**
 * POST {baseUrl}/api/user/auth/refresh，带 Cookie（等价 credentials: include），body {}。
 * 成功返回 {access_token, expires_at, cookie, session, user_id}；
 * 失败抛 UpstreamAuthError（429 标记 kind='rate_limited'，供 job 停止整轮）。
 */
export async function refreshNewApi({
  baseUrl,
  cookie,
  session = null,
  userId = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
  nowMs = Date.now(),
  refreshPath = NEWAPI_REFRESH_PATH,
} = {}) {
  if (!baseUrl) throw new UpstreamAuthError('missing_base_url');
  if (!cookie) throw new UpstreamAuthError('missing_cookie');

  const headers = { Cookie: cookie };
  const origin = new URL(baseUrl).origin;
  // NewAPI 的刷新端点会校验请求来源；缺 Origin 时返回 403 request origin is not allowed。
  headers.Origin = origin;
  headers.Referer = `${origin}/`;
  if (typeof session === 'string' && session) headers['X-Auth-Session'] = session;
  if (userId !== null && userId !== undefined && userId !== '') headers['New-Api-User'] = String(userId);

  const { json, status, response } = await postRefreshJson({
    url: joinUrl(baseUrl, refreshPath),
    headers,
    body: {},
    fetchImpl,
    timeoutMs,
  });

  // NewAPI 鉴权失败也可能返回 200 + success:false（"无效的令牌"），不能当成功
  if (json?.success === false) throw new UpstreamAuthError('refresh_rejected', { status });

  // 兼容 {success, data:{...}} 与直接返回 data、以及顶层字段
  const data = json?.data && typeof json.data === 'object' ? json.data : json;
  const accessToken = firstString(
    data?.access_token,
    data?.accessToken,
    json?.access_token,
    json?.accessToken,
  );
  if (!isJwt(accessToken)) throw new UpstreamAuthError('refresh_invalid_token', { status });

  const expiresRaw = data?.access_expires_at
    ?? data?.accessExpiresAt
    ?? json?.access_expires_at
    ?? json?.accessExpiresAt;
  const expiresAt = toEpochMs(expiresRaw) ?? jwtExpiresAt(accessToken);
  const user = data?.user ?? json?.user ?? null;
  const userId2 = toNum(user?.id ?? data?.user_id ?? json?.user_id);

  return {
    access_token: accessToken,
    // 拿不到 Set-Cookie 时保留旧 cookie，由调用方决定是否继续用旧 cookie 重试
    cookie: mergeCookieHeader(cookie, responseSetCookies(response)),
    expires_at: expiresAt,
    session: firstString(sessionOf(data), sessionOf(json)),
    user_id: userId2,
  };
}

/**
 * POST {baseUrl}/api/v1/auth/refresh，body {refresh_token}。
 * 成功返回 {access_token, refresh_token, expires_at, expires_in}；
 * 失败抛 UpstreamAuthError（429 标记 kind='rate_limited'，供 job 停止整轮）。
 */
export async function refreshSub2Api({
  baseUrl,
  refreshToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
  nowMs = Date.now(),
} = {}) {
  if (!baseUrl) throw new UpstreamAuthError('missing_base_url');
  if (!refreshToken) throw new UpstreamAuthError('missing_refresh_token');

  const { json, status } = await postRefreshJson({
    url: joinUrl(baseUrl, SUB2API_REFRESH_PATH),
    headers: {},
    body: { refresh_token: refreshToken },
    fetchImpl,
    timeoutMs,
  });
  const data = json?.data ?? json;
  const accessToken = data?.access_token ?? data?.accessToken;
  const nextRefresh = data?.refresh_token ?? data?.refreshToken;
  const expiresIn = Number(data?.expires_in ?? data?.expiresIn);

  // 换回来的必须是可解析 JWT；否则宁可失败，也不把不明字符串当 token
  if (!isJwt(accessToken)) throw new UpstreamAuthError('refresh_invalid_token', { status });

  const jwtExp = jwtExpiresAt(accessToken);
  const expiresAt = jwtExp ?? (Number.isFinite(expiresIn) && expiresIn > 0
    ? nowMs + Math.round(expiresIn * 1000)
    : null);

  return {
    access_token: accessToken,
    refresh_token: typeof nextRefresh === 'string' && nextRefresh ? nextRefresh : null,
    expires_at: expiresAt,
    expires_in: Number.isFinite(expiresIn) ? expiresIn : null,
  };
}

/** 只改指定账户的 auth 凭据字段，其他账户与字段原样保留 */
export function writeBackAuth(
  configPath,
  accountId,
  { token, refresh_token, expires_at, cookie, session } = {},
  { expected = null } = {},
) {
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.accounts)) throw new Error('配置文件缺少 accounts 数组');
  const account = parsed.accounts.find((a) => a && a.id === accountId);
  if (!account) throw new Error(`配置文件里找不到账户 ${accountId}`);
  // 换签要发网络请求，期间别的进程可能已经写过；凭据变了就放弃，避免覆盖更新的值
  if (expected && !sameCredentials(account.auth, expected)) {
    throw new AuthWriteConflictError();
  }
  account.auth = {
    ...(account.auth ?? {}),
    token,
    ...(refresh_token ? { refresh_token } : {}),
    ...(cookie ? { cookie } : {}),
    ...(session ? { session } : {}),
    expires_at: expires_at ?? account.auth?.expires_at ?? null,
  };

  const tmp = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {
      // Windows 上 chmod 可能无意义，忽略
    }
    // rename 前再比一次，缩小覆盖窗口
    const latest = fs.readFileSync(configPath, 'utf8');
    if (expected && latest !== raw) throw new AuthWriteConflictError();
    fs.renameSync(tmp, configPath);
    try {
      fs.chmodSync(configPath, 0o600);
    } catch {
      // 同上
    }
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 临时文件可能没写出来
    }
    throw err;
  }
  return true;
}

function findAccount(rawJson, accountId) {
  try {
    const parsed = JSON.parse(rawJson);
    if (!Array.isArray(parsed?.accounts)) return null;
    return parsed.accounts.find((a) => a && a.id === accountId) ?? null;
  } catch {
    return null;
  }
}

const COMPARED_AUTH_FIELDS = ['token', 'cookie', 'session', 'refresh_token', 'expires_at'];

function sameCredentials(current, expected) {
  for (const key of COMPARED_AUTH_FIELDS) {
    const a = current?.[key] ?? null;
    const b = expected?.[key] ?? null;
    if (JSON.stringify(a) !== JSON.stringify(b)) return false;
  }
  return true;
}

/** 读取配置文件里该账户的原始 auth（写回前的基线快照，用于并发比对） */
export function readAuthSnapshot(configPath, accountId) {
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    return findAccount(raw, accountId)?.auth ?? null;
  } catch {
    return null;
  }
}

/** 是否有可用于换签的凭据：Sub2API 的 refresh_token，或 NewAPI 的 cookie */
export function authCanRefresh(account, auth = account?.auth) {
  if (!auth || typeof auth !== 'object') return false;
  if (typeof auth.refresh_token === 'string' && auth.refresh_token) return true;
  return account?.kind === 'newapi' && typeof auth.cookie === 'string' && Boolean(auth.cookie);
}

/** 显式 expires_at 或 JWT exp 是否已进入刷新窗口 */
function expiringSoon(auth, nowMs, thresholdMs) {
  const expiresAt = authExpiresAt(auth);
  if (expiresAt === null) return false;
  return expiresAt - nowMs < thresholdMs;
}

/**
 * NewAPI 的刷新阈值：token 寿命短（常见 15 分钟），固定 2h 阈值会变成每轮都刷。
 * 取寿命的 1/4，限制在 [1 分钟, min(配置阈值, 5 分钟)]；拿不到寿命时用 5 分钟。
 */
export function newApiRefreshThreshold(auth, thresholdMs = DEFAULT_REFRESH_THRESHOLD_MS) {
  const cap = Math.min(thresholdMs, NEWAPI_REFRESH_THRESHOLD_MS);
  const lifetime = jwtLifetimeMs(auth?.token);
  if (lifetime === null) return cap;
  return Math.max(NEWAPI_MIN_REFRESH_THRESHOLD_MS, Math.min(cap, Math.round(lifetime / 4)));
}

/**
 * 是否该在发出业务请求前换签。
 * NewAPI 只有「已有 token 且临近到期」才主动换；纯 cookie 配置等 401 再换，
 * 避免每轮白打一次刷新接口。
 */
function shouldRefresh(account, auth, nowMs, thresholdMs) {
  if (account?.kind === 'newapi') {
    if (!authCanRefresh(account, auth)) return false;
    if (typeof auth.token !== 'string' || !auth.token) return false;
    return expiringSoon(auth, nowMs, newApiRefreshThreshold(auth, thresholdMs));
  }
  return needsRefresh(auth, nowMs, thresholdMs);
}

/** 连换取签的凭据都没有时的原因 */
function missingReason(account, auth, { force = false } = {}) {
  if (account?.kind === 'newapi' && (auth.mode === 'cookie' || force)) return 'missing_cookie';
  return 'missing_token';
}

/** 期望的 NewAPI user id：auth.user_id 优先，其次纯数字的 account.id */
export function expectedUserId(account, auth = account?.auth) {
  const explicit = toNum(auth?.user_id);
  if (explicit !== null) return explicit;
  const raw = String(account?.id ?? '');
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

/** 按账户类型换签，返回新的 auth 与需要写回文件的最小字段 */
async function performRefresh(account, auth, { fetchImpl, timeoutMs, nowMs }) {
  if (account?.kind === 'newapi' && typeof auth.cookie === 'string' && auth.cookie) {
    const refreshed = await refreshNewApi({
      baseUrl: account.base_url,
      cookie: auth.cookie,
      session: auth.session ?? null,
      userId: auth.user_id ?? null,
      fetchImpl,
      timeoutMs,
      nowMs,
      refreshPath: refreshPathFor(account),
    });
    // cookie 可能属于同站另一个账号：换回来的 user 与预期不一致时绝不采用
    const expectId = expectedUserId(account, auth);
    if (refreshed.user_id !== null && expectId !== null && refreshed.user_id !== expectId) {
      throw new UpstreamAuthError('cookie_account_mismatch');
    }
    const cookie = refreshed.cookie ?? auth.cookie;
    return {
      auth: {
        ...auth,
        token: refreshed.access_token,
        cookie,
        expires_at: refreshed.expires_at,
        ...(refreshed.session ? { session: refreshed.session } : {}),
        ...(refreshed.user_id !== null && (auth.user_id === null || auth.user_id === undefined)
          ? { user_id: refreshed.user_id }
          : {}),
      },
      write: {
        token: refreshed.access_token,
        cookie,
        expires_at: refreshed.expires_at,
        session: refreshed.session ?? auth.session ?? null,
      },
      // 没拿到新的 Set-Cookie 时旧 cookie 仍是失效的会话，改用换回来的 access_token
      token_only: account.auth?.mode === 'cookie' && cookie === auth.cookie,
    };
  }

  if (typeof auth.refresh_token === 'string' && auth.refresh_token) {
    const refreshed = await refreshSub2Api({
      baseUrl: account.base_url,
      refreshToken: auth.refresh_token,
      fetchImpl,
      timeoutMs,
      nowMs,
    });
    return {
      auth: {
        ...auth,
        token: refreshed.access_token,
        refresh_token: refreshed.refresh_token ?? auth.refresh_token,
        expires_at: refreshed.expires_at,
      },
      write: {
        token: refreshed.access_token,
        refresh_token: refreshed.refresh_token ?? auth.refresh_token,
        expires_at: refreshed.expires_at,
      },
      token_only: false,
    };
  }

  throw new UpstreamAuthError(missingReason(account, auth, { force: true }));
}

/** cookie 配置在只拿到 access_token 时临时改走 Bearer，避免继续发失效的 session cookie */
function sessionHeaders(account, auth, token, tokenOnly = false) {
  const effective = tokenOnly && auth.mode === 'cookie'
    ? { ...auth, mode: 'bearer', header: auth.header || 'Authorization', scheme: 'Bearer' }
    : auth;
  return authHeaders({ ...account, auth: effective }, token);
}

/**
 * 准备一次可用的认证。
 *
 * @returns {{headers: object, token: string|null, auth: object, refreshed: boolean, wrote: boolean, write_error: string|null}}
 * @throws {UpstreamAuthError} 缺少 token/cookie、换签失败、429（kind='rate_limited'）
 */
export async function ensureAuth(
  account,
  {
    nowMs = Date.now(),
    fetchImpl = globalThis.fetch,
    configPath = null,
    writable = false,
    thresholdMs = DEFAULT_REFRESH_THRESHOLD_MS,
    force = false,
    timeoutMs = 15000,
  } = {},
) {
  const auth = { ...(account?.auth ?? {}) };
  const token = resolveToken(auth);

  const unchanged = () => ({
    headers: authHeaders({ ...account, auth }, token),
    token,
    auth: { ...auth, token },
    refreshed: false,
    wrote: false,
    write_error: null,
    refresh_error: null,
  });

  if (!force && !shouldRefresh(account, auth, nowMs, thresholdMs)) {
    if (!token) throw new UpstreamAuthError(missingReason(account, auth));
    return unchanged();
  }

  if (!authCanRefresh(account, auth)) {
    if (!token) throw new UpstreamAuthError(missingReason(account, auth, { force }));
    // 到期或无法换签：沿用旧凭据，由上游 401 决定
    return unchanged();
  }

  // 写回前比对基线：换签要等网络，期间别的进程可能已写过凭据
  const baseline = writable && configPath ? readAuthSnapshot(configPath, account.id) : null;

  let refreshed;
  try {
    refreshed = await performRefresh(account, auth, { fetchImpl, timeoutMs, nowMs });
  } catch (err) {
    if (err?.kind === 'rate_limited') throw err;
    // 主动换签失败但旧 token 可能仍然有效：软失败，本轮继续用旧凭据
    if (!force && token) return { ...unchanged(), refresh_error: 'refresh_failed' };
    throw err;
  }
  const nextAuth = refreshed.auth;
  let wrote = false;
  let writeError = null;
  if (writable && configPath) {
    try {
      writeBackAuth(configPath, account.id, refreshed.write, { expected: baseline });
      wrote = true;
    } catch (err) {
      // 写回失败/冲突不影响本轮使用新凭据，也不破坏旧文件
      writeError = err?.code === 'write_conflict' ? 'write_conflict' : 'write_failed';
    }
  }

  return {
    headers: sessionHeaders(account, nextAuth, nextAuth.token, refreshed.token_only),
    token: nextAuth.token,
    auth: nextAuth,
    refreshed: true,
    wrote,
    write_error: writeError,
    refresh_error: null,
  };
}
