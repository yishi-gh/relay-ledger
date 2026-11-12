/**
 * 读取单文件账户配置（v2/secrets/accounts.json），不存在时回退 v2/config/upstreams.json。
 *
 * 单文件同时包含站点 base_url 与凭据（auth）；凭据只交给 ensureAuth，
 * 不进 API、日志、job_runs。环境变量名（token_env）可以写在文件里，token 本身优先文件。
 */

import fs from 'node:fs';
import path from 'node:path';

import { INSTANCE } from './instance.mjs';
import { toEpochMs } from './time.mjs';

function positiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeInt(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function normalizeAuth(raw) {
  const auth = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const token = typeof auth.token === 'string' && auth.token ? auth.token : null;
  const cookie = typeof auth.cookie === 'string' && auth.cookie ? auth.cookie : null;
  const refresh = typeof auth.refresh_token === 'string' && auth.refresh_token ? auth.refresh_token : null;
  const userId = auth.user_id === 0 || auth.user_id
    ? auth.user_id
    : null;
  return {
    mode: auth.mode === 'cookie' ? 'cookie' : 'bearer',
    token,
    cookie,
    refresh_token: refresh,
    expires_at: toEpochMs(auth.expires_at),
    user_id: userId,
    // NewAPI 换签后返回的会话标识，存在时作为 X-Auth-Session 发回
    session: typeof auth.session === 'string' && auth.session
      ? auth.session
      : typeof auth.session_id === 'string' && auth.session_id ? auth.session_id : null,
    // NewAPI 刷新端点覆盖，默认 /api/user/auth/refresh
    refresh_path: typeof auth.refresh_path === 'string' && auth.refresh_path ? auth.refresh_path : null,
    token_env: typeof auth.token_env === 'string' && auth.token_env ? auth.token_env : null,
    header: typeof auth.header === 'string' && auth.header ? auth.header : 'Authorization',
    scheme: auth.scheme === null ? '' : typeof auth.scheme === 'string' ? auth.scheme : 'Bearer',
    headers: auth.headers && typeof auth.headers === 'object' && !Array.isArray(auth.headers)
      ? { ...auth.headers }
      : {},
  };
}

function normalizeAccount(raw, index) {
  if (!raw || typeof raw !== 'object') throw new Error(`accounts[${index}] 不是对象`);
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) throw new Error(`accounts[${index}] 缺少 id`);
  const channels = Array.isArray(raw.channels)
    ? [...new Set(raw.channels.filter((c) => Number.isInteger(c)))]
    : [];
  return {
    id,
    name: typeof raw.name === 'string' && raw.name ? raw.name : id,
    kind: typeof raw.kind === 'string' ? raw.kind : 'unknown',
    base_url: typeof raw.base_url === 'string' ? raw.base_url.replace(/\/+$/, '') : null,
    unit: typeof raw.unit === 'string' && raw.unit ? raw.unit : 'USD',
    enabled: raw.enabled !== false,
    // 会话是否可用：sub2api 站只给了永久 API Key、没有可用会话时设为 false，
    // 采集器就只用渠道 key 取余额，不再每轮报 auth_failed。
    session: raw.session !== false,
    channels,
    endpoints: raw.endpoints && typeof raw.endpoints === 'object' ? raw.endpoints : {},
    auth: normalizeAuth(raw.auth),
    balance_field: typeof raw.balance_field === 'string' ? raw.balance_field : null,
    quota_per_unit: Number.isFinite(raw.quota_per_unit) ? raw.quota_per_unit : null,
  };
}

/**
 * 默认配置文件，按实例路径回退：
 *   ① instance.json 的 paths.accounts → ② <dataDir>/accounts.json →
 *   ③ 仓库内 secrets/accounts.json（可写回换签结果）→ ④ config/upstreams.json（只读）。
 * 老部署只有 ③，没有 instance.json 时行为不变。
 */
export function resolveConfigFile(v2Dir, inst = INSTANCE) {
  const candidates = [
    inst?.paths?.accountsFile,
    inst?.paths?.dataDir ? path.join(inst.paths.dataDir, 'accounts.json') : null,
    path.join(v2Dir, 'secrets', 'accounts.json'),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return { file: candidate, writable: true };
  }
  return { file: path.join(v2Dir, 'config', 'upstreams.json'), writable: false };
}

export function loadConfig(file, { writable = false } = {}) {
  const target = path.resolve(file);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (err) {
    throw new Error(`读取配置失败 ${target}: ${err.message}`);
  }
  const accounts = (Array.isArray(parsed.accounts) ? parsed.accounts : []).map(normalizeAccount);
  const seen = new Set();
  for (const a of accounts) {
    if (seen.has(a.id)) throw new Error(`配置里账户 id 重复: ${a.id}`);
    seen.add(a.id);
  }
  const upstream = parsed.upstream && typeof parsed.upstream === 'object' ? parsed.upstream : {};
  return {
    file: target,
    writable,
    currency: typeof parsed.currency === 'string' && parsed.currency ? parsed.currency : 'USD',
    quota_per_unit: Number.isFinite(parsed.quota_per_unit) ? parsed.quota_per_unit : 500000,
    upstream: {
      timeout_ms: positiveInt(upstream.timeout_ms, 20000),
      min_interval_ms: nonNegativeInt(upstream.min_interval_ms, 1200),
      retry_delay_ms: nonNegativeInt(upstream.retry_delay_ms, 500),
      job_stale_ms: positiveInt(upstream.job_stale_ms, 30 * 60 * 1000),
      refresh_threshold_ms: positiveInt(upstream.refresh_threshold_ms, 2 * 60 * 60 * 1000),
    },
    accounts,
  };
}
