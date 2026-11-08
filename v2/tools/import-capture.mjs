#!/usr/bin/env node
/**
 * 把浏览器采集文件 accounts.capture.json 导入/合并到 v2/secrets/accounts.json。
 *
 * - 只读采集文件，不访问网络、不读站点库、不碰 dashboard.db
 * - 采集文件是通用 schema（schema_version=1），本工具负责映射 v2 的 kind/base_url/id/endpoints
 * - 合并时保留已有 channels，不删除、不覆盖其他账户
 * - 防降级：现有长效 token（非 JWT）不会被新的短命 JWT（无 refresh_token）覆盖
 * - 原子写回（临时文件 + rename，0600），失败不破坏旧文件
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { toEpochMs } from '../lib/time.mjs';
import { isJwt } from '../sources/upstream/auth.mjs';

const V2_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_CONFIG_FILE = path.join(V2_DIR, 'secrets', 'accounts.json');

export class ImportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
  }
}

const KIND_DEFAULTS = {
  sub2api: {
    endpoints: {
      balance: '/api/v1/auth/me',
      usage: '/api/v1/usage/stats?period=today',
    },
    balance_field: 'balance',
    quota_per_unit: null,
  },
  newapi: {
    endpoints: {
      balance: '/api/user/self',
      credits: '/api/log/self',
      usage: '/api/log/self/stat',
    },
    balance_field: 'quota',
    quota_per_unit: 500000,
  },
};

const DEFAULT_CONFIG = () => ({
  version: 2,
  currency: 'USD',
  quota_per_unit: 500000,
  upstream: {
    timeout_ms: 20000,
    min_interval_ms: 1200,
    retry_delay_ms: 500,
    job_stale_ms: 1800000,
    refresh_threshold_ms: 7200000,
  },
  accounts: [],
});

export function slug(value) {
  const out = String(value ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return out.slice(0, 48) || 'site';
}

function stringOrEmpty(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 去尾斜杠、丢 query/hash；非法 URL 抛错 */
export function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new ImportError('invalid_site_url', `site_url 不是合法 URL: ${String(value)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ImportError('invalid_site_url', `site_url 必须是 http/https: ${String(value)}`);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function normalizeMaybeUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return normalizeBaseUrl(value);
  } catch {
    return value.trim().replace(/\/+$/, '');
  }
}

function accountField(account, field) {
  const value = account?.[field];
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** 账号标识：id > name > email（与采集端去重口径一致） */
function accountKey(account) {
  return accountField(account, 'id') ?? accountField(account, 'name') ?? accountField(account, 'email');
}

function normalizeAuth(raw, where) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ImportError('invalid_auth', `${where}.auth 缺失`);
  }
  if (raw.mode !== 'bearer' && raw.mode !== 'cookie') {
    throw new ImportError('invalid_auth', `${where}.auth.mode 必须是 bearer 或 cookie`);
  }
  const token = stringOrEmpty(raw.token);
  const cookie = stringOrEmpty(raw.cookie);
  const refreshToken = stringOrEmpty(raw.refresh_token);

  if (raw.mode === 'bearer' && !token && !refreshToken && !cookie) {
    throw new ImportError('invalid_auth', `${where}.auth 是 bearer 模式，但 token / refresh_token / cookie 都为空`);
  }
  if (raw.mode === 'cookie' && !cookie) {
    throw new ImportError('invalid_auth', `${where}.auth 是 cookie 模式，但 cookie 为空`);
  }

  return {
    mode: raw.mode,
    token: raw.mode === 'bearer' ? token : '',
    // bearer 模式也保留完整 Cookie：access token 过期后服务端要靠它重新登录续期
    cookie,
    refresh_token: refreshToken,
    expires_at: toEpochMs(raw.expires_at),
    user_id: raw.user_id === undefined || raw.user_id === '' ? null : raw.user_id,
  };
}

/** access token 已过期且没有 refresh_token / cookie 时，导入后必定无法使用 */
function isExpiredWithoutRenewal(auth, now) {
  if (!auth || auth.mode !== 'bearer' || !auth.token) return false;
  if (auth.expires_at === null || auth.expires_at > now) return false;
  return !auth.refresh_token && !auth.cookie;
}

function validateEntry(entry, index) {
  const where = `accounts[${index}]`;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new ImportError('invalid_entry', `${where} 不是对象`);
  }
  if (typeof entry.site_url !== 'string' || !entry.site_url.trim()) {
    throw new ImportError('invalid_entry', `${where}.site_url 缺失`);
  }
  if (entry.site_type !== 'newapi' && entry.site_type !== 'sub2api') {
    throw new ImportError('invalid_entry', `${where}.site_type 必须是 newapi 或 sub2api`);
  }
  if (!entry.account || typeof entry.account !== 'object' || Array.isArray(entry.account)) {
    throw new ImportError('invalid_entry', `${where}.account 缺失`);
  }
  if (!accountKey(entry.account)) {
    throw new ImportError('invalid_entry', `${where}.account 缺少 id/name/email，无法生成唯一 id`);
  }
  normalizeAuth(entry.auth, where);
}

export function readCaptureFile(file) {
  const target = path.resolve(file);
  let text;
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch (err) {
    throw new ImportError('capture_read_failed', `读取采集文件失败 ${target}: ${err.code ?? err.message}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ImportError('capture_parse_failed', `采集文件不是合法 JSON: ${target}`);
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new ImportError('capture_invalid', '采集文件顶层必须是对象');
  }
  if (json.schema_version !== 1) {
    throw new ImportError('capture_schema_unsupported', `采集文件 schema_version 必须是 1，实际 ${String(json.schema_version)}`);
  }
  if (!Array.isArray(json.accounts)) {
    throw new ImportError('capture_invalid', '采集文件缺少 accounts 数组');
  }
  json.accounts.forEach(validateEntry);
  return json;
}

/** 采集条目 -> v2 账户结构（不含 channels，由合并阶段决定） */
export function mapCaptureEntry(entry, index, fallbackCapturedAt = null) {
  const where = `accounts[${index}]`;
  const siteUrl = normalizeBaseUrl(entry.site_url);
  const host = new URL(siteUrl).host;
  const siteName = typeof entry.site_name === 'string' && entry.site_name.trim()
    ? entry.site_name.trim()
    : host;
  const key = accountKey(entry.account);
  const kind = entry.site_type;
  const defaults = KIND_DEFAULTS[kind];
  const label = accountField(entry.account, 'name') ?? key;

  return {
    id: `${slug(siteName)}:${key}`,
    name: siteName === label ? siteName : `${siteName} · ${label}`,
    site_name: siteName,
    site_url: siteUrl,
    kind,
    base_url: siteUrl,
    unit: 'USD',
    enabled: true,
    account: {
      id: accountField(entry.account, 'id'),
      name: accountField(entry.account, 'name') ?? key,
      email: accountField(entry.account, 'email'),
    },
    auth: normalizeAuth(entry.auth, where),
    endpoints: { ...defaults.endpoints },
    balance_field: defaults.balance_field,
    quota_per_unit: defaults.quota_per_unit,
    // 采集时间（毫秒）：下次导入用来判断哪边的凭据更新
    captured_at: toEpochMs(entry.captured_at) ?? toEpochMs(fallbackCapturedAt),
  };
}

function readExistingConfig(file) {
  if (!fs.existsSync(file)) return DEFAULT_CONFIG();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new ImportError('config_read_failed', `读取配置失败 ${file}: ${err.code ?? err.message}`);
  }
  if (!text.trim()) {
    throw new ImportError('config_invalid', `配置文件为空，拒绝覆盖: ${file}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ImportError('config_parse_failed', `配置文件不是合法 JSON，未做修改: ${file}`);
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new ImportError('config_invalid', '配置文件顶层必须是对象');
  }
  if (!Array.isArray(json.accounts)) {
    throw new ImportError('config_invalid', '配置文件缺少 accounts 数组');
  }
  const seen = new Set();
  for (const account of json.accounts) {
    if (!account || typeof account !== 'object' || !account.id) {
      throw new ImportError('config_invalid', '配置文件里有账户缺少 id，未做修改');
    }
    if (seen.has(account.id)) {
      throw new ImportError('duplicate_id', `配置文件里账户 id 重复: ${account.id}`);
    }
    seen.add(account.id);
  }
  return json;
}

function siteAccountKey(account) {
  const site = normalizeMaybeUrl(account?.site_url ?? account?.base_url ?? null);
  const key = accountKey(account?.account);
  if (!site || !key) return null;
  return `${site}|${key.toLowerCase()}`;
}

function mergeInto(existing, mapped, { keepExistingToken = false } = {}) {
  const auth = {
    ...(existing.auth ?? {}),
    ...mapped.auth,
    // 新采集拿不到 user_id 时保留旧值：NewAPI cookie 模式要靠它发 New-Api-User
    user_id: mapped.auth.user_id ?? existing.auth?.user_id ?? null,
  };
  if (keepExistingToken) {
    // 新条目是短命 JWT 且无法续期：保留长效 token 与其到期时间，不能接受 15 分钟后失效的凭据
    auth.token = existing.auth.token;
    auth.expires_at = existing.auth.expires_at ?? null;
    // 仍然接收新采集的 Cookie / session（有就更新，没有就保留旧值）
    if (!mapped.auth.cookie) auth.cookie = existing.auth.cookie ?? auth.cookie;
  }

  return {
    ...existing,
    ...mapped,
    // 沿用既有 id：dashboard 的 balance_snapshot / job_runs 都以它为准
    id: existing.id,
    // 保留用户已经配置好的字段，只更新站点与凭据
    name: existing.name || mapped.name,
    unit: existing.unit || mapped.unit,
    enabled: existing.enabled !== false,
    channels: Array.isArray(existing.channels) ? existing.channels : [],
    endpoints: existing.endpoints && Object.keys(existing.endpoints).length
      ? existing.endpoints
      : mapped.endpoints,
    balance_field: existing.balance_field || mapped.balance_field,
    quota_per_unit: existing.quota_per_unit ?? mapped.quota_per_unit,
    auth,
    // 新鲜度已在合并前判定；这里记录本次采集时间，供下次导入比较
    captured_at: mapped.captured_at ?? existing.captured_at ?? null,
  };
}

/** 非空且不是可解析 JWT：长效 API key（无 exp，不会自然过期） */
export function isLongLivedToken(token) {
  const value = stringOrEmpty(token);
  return Boolean(value) && !isJwt(value);
}

/**
 * 是否要拒绝新 token 覆盖：现有是长效 key、新条目是短命 JWT（有 expires_at）、
 * 且新条目没有 refresh_token（导入后过期就再也换不了签）。
 */
function shouldKeepLongLivedToken(existingAuth, mappedAuth) {
  if (!isLongLivedToken(existingAuth?.token)) return false;
  if (!isJwt(stringOrEmpty(mappedAuth?.token))) return false;
  if (mappedAuth?.expires_at === null || mappedAuth?.expires_at === undefined) return false;
  return !stringOrEmpty(mappedAuth?.refresh_token);
}

function writeConfigAtomic(file, config) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(temp, 0o600);
    } catch {
      // Windows 上 chmod 可能无意义
    }
    fs.renameSync(temp, file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // 同上
    }
  } catch (err) {
    try {
      fs.unlinkSync(temp);
    } catch {
      // 临时文件可能没写出来
    }
    throw new ImportError('write_failed', `写入配置失败 ${file}: ${err.code ?? err.message}`);
  }
}

/**
 * @param {object} options
 * @param {string} options.inputFile 采集文件
 * @param {string} [options.configFile] 目标配置，默认 v2/secrets/accounts.json
 * @param {boolean} [options.write] false 时只计算报告，不落盘
 * @param {number} [options.now] 判断 token 是否过期的当前时间（毫秒），默认 Date.now()
 * @returns {{configFile:string, added:Array, updated:Array, skipped:Array, lines:string[], config:object}}
 */
export function importCapture({
  inputFile,
  configFile = DEFAULT_CONFIG_FILE,
  write = true,
  now = Date.now(),
} = {}) {
  if (!inputFile) throw new ImportError('missing_input', '缺少 --input');
  const capture = readCaptureFile(inputFile);
  const target = path.resolve(configFile);
  const config = readExistingConfig(target);

  const byId = new Map(config.accounts.map((account) => [account.id, account]));
  const bySiteKey = new Map();
  const bySiteUrl = new Map();
  for (const account of config.accounts) {
    const key = siteAccountKey(account);
    if (key && !bySiteKey.has(key)) bySiteKey.set(key, account);
    const site = normalizeMaybeUrl(account?.site_url ?? account?.base_url ?? null);
    if (site) {
      const list = bySiteUrl.get(site) ?? [];
      list.push(account);
      bySiteUrl.set(site, list);
    }
  }

  const added = [];
  const updated = [];
  const skipped = [];
  const seenNewIds = new Set();

  capture.accounts.forEach((entry, index) => {
    const mapped = mapCaptureEntry(entry, index, capture.captured_at);
    if (seenNewIds.has(mapped.id)) {
      throw new ImportError('duplicate_id', `采集文件里生成了重复 id: ${mapped.id}`);
    }
    seenNewIds.add(mapped.id);

    const siteKey = `${mapped.site_url}|${accountKey(mapped.account).toLowerCase()}`;
    let existing = byId.get(mapped.id) ?? bySiteKey.get(siteKey) ?? null;
    if (!existing) {
      // 兼容早期只按站点配置、没有 account 元数据的账户：
      // 同站点只有一个这样的账户时，按 site_url/base_url 唯一匹配，避免重复建号。
      const candidates = bySiteUrl.get(mapped.site_url) ?? [];
      const placeholders = candidates.filter((account) => !accountKey(account?.account));
      if (placeholders.length === 1) existing = placeholders[0];
    }

    // 1) 过期且无法续期：拒绝该条，保留目标文件里现有的可用凭据
    if (isExpiredWithoutRenewal(mapped.auth, now)) {
      skipped.push(skipOf(mapped, 'expired_without_renewal'));
      return;
    }

    // 2) 目标文件里的条目采集时间更新：旧 capture 不覆盖新凭据
    const incomingAt = mapped.captured_at;
    const existingAt = toEpochMs(existing?.captured_at);
    if (existing && existingAt && incomingAt && existingAt > incomingAt) {
      skipped.push(skipOf(mapped, 'stale_capture'));
      return;
    }

    if (existing) {
      const keepToken = shouldKeepLongLivedToken(existing.auth, mapped.auth);
      const merged = mergeInto(existing, mapped, { keepExistingToken: keepToken });
      const at = config.accounts.indexOf(existing);
      config.accounts[at] = merged;
      byId.set(merged.id, merged);
      if (siteKey) bySiteKey.set(siteKey, merged);
      const site = normalizeMaybeUrl(merged.site_url ?? merged.base_url ?? null);
      if (site) {
        const list = bySiteUrl.get(site) ?? [];
        const index = list.indexOf(existing);
        if (index >= 0) list[index] = merged;
        else list.push(merged);
        bySiteUrl.set(site, list);
      }
      updated.push(summaryOf(merged, keepToken ? 'not_overwriting_long_lived_token' : null));
    } else {
      const fresh = { ...mapped, channels: [] };
      config.accounts.push(fresh);
      byId.set(fresh.id, fresh);
      if (siteKey) bySiteKey.set(siteKey, fresh);
      const site = normalizeMaybeUrl(fresh.site_url ?? fresh.base_url ?? null);
      if (site) {
        const list = bySiteUrl.get(site) ?? [];
        list.push(fresh);
        bySiteUrl.set(site, list);
      }
      added.push(summaryOf(fresh));
    }
  });

  // 合并后仍不允许重复 id
  const seen = new Set();
  for (const account of config.accounts) {
    if (seen.has(account.id)) {
      throw new ImportError('duplicate_id', `配置里账户 id 重复: ${account.id}`);
    }
    seen.add(account.id);
  }

  if (write) writeConfigAtomic(target, config);

  const skippedLine = skipped.length ? `，跳过 ${skipped.length} 个` : '';
  const lines = [
    `新增 ${added.length} 个，更新 ${updated.length} 个${skippedLine} → ${target}`,
    ...added.map((a) => `+ ${a.id}  ${a.site_url}  ${a.kind}  channels=${a.channels}`),
    ...updated.map((a) => (a.reason
      ? `! ${a.id}  ${a.site_url}  ${a.kind}  跳过覆盖：${a.reason}`
      : `~ ${a.id}  ${a.site_url}  ${a.kind}  channels=${a.channels}`)),
    ...skipped.map((s) => `! ${s.id}  ${s.site_url}  ${s.kind}  跳过：${s.reason}`),
  ];

  return { configFile: target, added, updated, skipped, lines, config };
}

function skipOf(account, reason) {
  return {
    id: account.id,
    site_url: account.site_url,
    kind: account.kind,
    reason,
  };
}

function summaryOf(account, reason = null) {
  return {
    id: account.id,
    site_url: account.site_url,
    kind: account.kind,
    channels: Array.isArray(account.channels) ? account.channels.length : 0,
    reason,
  };
}

function parseArgs(argv) {
  const options = { input: null, config: DEFAULT_CONFIG_FILE, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--input' || arg === '-i') {
      options.input = argv[++i] ?? null;
    } else if (arg.startsWith('--input=')) {
      options.input = arg.slice('--input='.length);
    } else if (arg === '--config' || arg === '-c') {
      options.config = argv[++i] ?? options.config;
    } else if (arg.startsWith('--config=')) {
      options.config = arg.slice('--config='.length);
    } else {
      throw new ImportError('bad_args', `未知参数: ${arg}`);
    }
  }
  return options;
}

function usage() {
  return [
    '用法: node v2/tools/import-capture.mjs --input <accounts.capture.json> [--config <accounts.json>] [--dry-run]',
    '',
    '  --input, -i   浏览器采集文件（必填）',
    '  --config, -c  目标配置，默认 v2/secrets/accounts.json',
    '  --dry-run     只打印报告，不写文件',
  ].join('\n');
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`导入失败：${err.message}`);
    console.error(usage());
    process.exit(2);
  }
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.input) {
    console.error('导入失败：缺少 --input');
    console.error(usage());
    process.exit(2);
  }

  try {
    const report = importCapture({
      inputFile: options.input,
      configFile: options.config,
      write: !options.dryRun,
    });
    for (const line of report.lines) console.log(line);
    if (options.dryRun) console.log('（dry-run：未写入文件）');
  } catch (err) {
    if (err instanceof ImportError) {
      console.error(`导入失败：${err.message}`);
    } else {
      console.error(`导入失败：${err?.name ?? 'UnknownError'}`);
    }
    process.exitCode = 1;
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
