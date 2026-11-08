/**
 * collect-site-logs：把本站（NewAPI 中转站）的渠道日志拉进实例配置的站点库
 * `<dataDir>/db/sites/<site.id>.db` 的 `logs` 表。
 *
 * 用法：
 *   node v2/jobs/collect-site-logs.mjs                 # 增量：直读站点本地 SQLite（默认）
 *   node v2/jobs/collect-site-logs.mjs --source=http   # 走管理员日志导出端点
 *   node v2/jobs/collect-site-logs.mjs --dry-run       # 只读取与统计，不写库
 *   node v2/jobs/collect-site-logs.mjs --since=2026-10-01T00:00:00+08:00   # 回补指定起点（空库时生效）
 *   node v2/jobs/collect-site-logs.mjs --db-file=<NewAPI 源库路径>
 *
 * 两种源（--source）：
 *   - db（默认）：站点与看板同机时直接读 new-api 的本地 SQLite。水位取本地 `logs` 的
 *     MAX(t_ms) 往前 60s 换算出 anchorSec，用「`created_at >= anchorSec` 的最小 id 行」定位起点
 *     （该行早于水位说明已在库里，游标直接跳过；否则退一行把它拉进来），
 *     之后按 id 游标分页（`id > ? AND type = 2`，每页 2000 行），每页立即入库。
 *     库文件不存在或打不开时打一行提示并回退 HTTP（同一轮不混用两种源）；打开成功后的
 *     读库错误（锁、schema 变化）直接失败，退出码 1。
 *   - http：原来的管理员日志导出端点，跨机部署或没有读库权限时使用。
 *
 * HTTP 口径（移植自 v1 `tools/fetch-creds.mjs` 的导出通道，代码在 v2 内自带，不 import v1）：
 *   - PAT 从实例配置的令牌文件读（默认 `<dataDir>/site_token.txt`），支持单行纯 token 与
 *     「名称：token」多行两种格式，多行时取名称等于站点 id 的行；只进请求头，
 *     不进输出、不进错误信息。直读源不需要 PAT。
 *   - 请求 `GET {base}/api/log/export?start_timestamp&end_timestamp&type=2`，响应 NDJSON
 *     一行一条日志，末行是结果对象（丢弃）。旧版没有导出端点（404/405）时回退到
 *     `GET {base}/api/log/?p=N&page_size=100&type=2&start_timestamp=&end_timestamp=` 分页。
 *   - 窗口 `[since, now)` 按 `--chunk-days`（默认 1 天）切成顺序小片，逐片请求并逐片入库；
 *     单片失败时已入库的分片保留，错误里带分段范围与已插入行数。
 *   - 实测量级：1 小时 ≈ 250 行，1 天 ≈ 7,500 行 / 10 MB，3 天 ≈ 17,700 行 / 32 MB；
 *     所以导出请求的默认超时是 300s，首次回补（约 7 天）按天分片。
 *   - 增量窗口：库内 max(t_ms) 往前 30 分钟（服务端按 created_at 倒序分页时窗口边界会漏行，
 *     重叠部分靠 req_id 去重）；空库时取最近 `--days` 天（默认 3 天）；`--since` 直接覆盖起点。
 *   - 只收 type=2（消耗）日志；字段按 `logs` 表 37 列规范化，`ck` 内容指纹与 v1 同算法，
 *     带请求 ID 的行会替换库里同指纹的 `fp:` 行。
 *   - 失败可见：HTTP 状态与接口 `success:false` 的 message（脱敏、截断）写 stderr，退出码 1。
 *   - 不内置代理、不读全局配置、不写 dashboard.db。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { DAY_MS, formatLocal } from '../lib/time.mjs';
import { ensureDataDirs, INSTANCE } from '../lib/instance.mjs';
import { countExistingLogs, insertLogs, openLogsDb, readLastLogTime } from '../store/site-logs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const V2_DIR = path.dirname(HERE);
const LOG_ROOT = path.dirname(V2_DIR);

export const JOB_NAME = 'collect-site-logs';
/** 站点标识与上游地址来自实例配置；测试与 run-scheduler 都用这几个常量 */
export const SITE = INSTANCE.site.id;
export const DEFAULT_BASE_URL = INSTANCE.site.base_url;
export const DEFAULT_LOG_PATH = INSTANCE.site.log_path;

export const SITE_DB_FILE = INSTANCE.paths.siteDbFile;
export const TOKEN_FILE = INSTANCE.paths.tokenFile;

/** 与 v1 相同的配额单位：new-api 的 quota / 500000 = USD */
const QUOTA_PER_UNIT = 500000;
/** 增量重叠：库内最后一条日志时间往前 30 分钟 */
export const OVERLAP_MS = 30 * 60 * 1000;
/** 空库默认窗口：3 天 */
export const DEFAULT_DAYS = 3;
/** 默认分片长度：1 天（导出端点 1 天约 10 MB / 3.5s，冷启动首次更慢） */
export const DEFAULT_CHUNK_DAYS = 1;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 400;
const REQ_GAP_MS = 1000;
/** 实测 3 天导出 31.6 MB、冷启动 72.6s；给 9 天首轮回补留余量 */
const DEFAULT_TIMEOUT_MS = 300_000;
/** 分片数量上限（防止 --chunk-days 误写成很小的正数时产生海量请求） */
const MAX_CHUNKS = 500;
const SRC_FILE = 'v2/jobs/collect-site-logs';

/** 直读源：NewAPI 的本地 SQLite（站点与看板同机时） */
export const DEFAULT_DB_FILE = INSTANCE.paths.relayDb;
/** 直读分页大小：实测 165 MB 库上 2000 行/页约 10 ms */
export const DB_PAGE_SIZE = 2000;
/** 直读水位回看：本地最后一条 t_ms 往前 60s，吸收秒级取整与边界写入 */
export const DB_OVERLAP_MS = 60_000;

/** 帮助与日志里的路径：仓库内显示相对路径，仓库外显示绝对路径 */
function displayPath(file) {
  const abs = path.resolve(file);
  const rel = path.relative(LOG_ROOT, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return abs;
  return rel.split(path.sep).join('/');
}

const USAGE = `用法：
  node v2/jobs/collect-site-logs.mjs [--source=db|http] [--db-file=<path>] [--base-url=<url>] [--site-id=<id>] [--days=<n>] [--chunk-days=<n>] [--timeout-ms=<n>] [--since=<time>] [--dry-run]

  --source=<db|http> 采集源（默认 db）：db = 直读站点本地 SQLite，http = 管理员日志导出端点
  --db-file=<path>   直读的站点库文件（默认 ${displayPath(DEFAULT_DB_FILE)}）；不存在或打不开时回退 http
  --base-url=<url>   站点地址（默认取实例配置 site.base_url，仅 http 源需要）
  --site-id=<id>     站点标识（默认取实例配置 site.id，写入 logs.site 与令牌行匹配）
  --days=<n>         空库时的回看天数（默认 ${DEFAULT_DAYS}）；库内已有日志时按最后一条时间往前 60s
  --chunk-days=<n>   HTTP 分片长度（天，默认 ${DEFAULT_CHUNK_DAYS}，支持小数）；0 或负数 = 不分片、单请求
  --timeout-ms=<n>   HTTP 单次请求超时毫秒（默认 ${DEFAULT_TIMEOUT_MS}）
  --since=<time>     覆盖窗口起点（回补）：ISO8601（无时区按北京时间，如 2026-10-01T00:00:00）
                     或 13 位毫秒时间戳；必须早于当前时间。直读时仅空库生效
  --dry-run          真实读取与统计，但不写站点库
  --help             显示本说明

  PAT：${displayPath(TOKEN_FILE)}（仅 http 源需要；支持单行纯 token，或「名称：token」多行取站点 id 那行）
  站点库：${displayPath(SITE_DB_FILE)}`;

export class SiteLogsError extends Error {
  constructor(message, { kind = 'error', status = null } = {}) {
    super(message);
    this.name = 'SiteLogsError';
    this.kind = kind;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// 纯函数：令牌、NDJSON、窗口、字段归一（测试用）
// ---------------------------------------------------------------------------

/**
 * 令牌文件两种格式：单行纯 token；或「名称：值」多行，优先取名称等于 hint 的行，
 * 找不到再取第一行（大小写不敏感）。分隔符优先中文全角冒号，兼容半角冒号；
 * 值不打印、不落盘。
 */
export function pickToken(text, hint = SITE) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  // 单行且没有分隔冒号：整份文件就是一个 PAT
  if (lines.length === 1 && !/[：:]/.test(lines[0])) return lines[0];

  const want = String(hint).trim().toLowerCase();
  const pairs = [];
  for (const line of lines) {
    let idx = line.indexOf('：');
    if (idx < 0) idx = line.indexOf(':');
    if (idx <= 0) continue;
    const value = line.slice(idx + 1).trim();
    if (value) pairs.push({ name: line.slice(0, idx).trim().toLowerCase(), value });
  }
  const exact = pairs.find((pair) => pair.name === want);
  if (exact) return exact.value;
  return pairs.length > 0 ? pairs[0].value : null;
}

/**
 * 导出端点的 NDJSON：一行一条日志，末行是结果对象
 * （`{"success":true,"data":{"count":N},"message":""}`，没有 id 字段）——单独返回，调用方校验 success。
 * 坏行计数返回，不静默丢。
 * @returns {{items: object[], badLines: number, result: object|null}}
 */
export function parseExportNdjson(text) {
  const items = [];
  let badLines = 0;
  let result = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    let obj;
    try {
      obj = JSON.parse(s);
    } catch {
      badLines++;
      continue;
    }
    if (Array.isArray(obj)) {
      for (const one of obj) if (one && typeof one === 'object') items.push(one);
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;
    // 结果对象两道判断：有 success 键，或没有 id（日志行必有 id）
    if (Object.prototype.hasOwnProperty.call(obj, 'success') || obj.id == null) {
      result = obj;
      continue;
    }
    items.push(obj);
  }
  return { items, badLines, result };
}

/**
 * 窗口起点：库内有最后一条日志时间时往前 {@link OVERLAP_MS}；空库时取最近 days 天。
 * @returns {number} epoch ms
 */
export function resolveSinceMs({ lastTMs = null, days = DEFAULT_DAYS, nowMs = Date.now() } = {}) {
  const last = Number(lastTMs);
  if (lastTMs != null && Number.isFinite(last) && last > 0) return Math.max(0, last - OVERLAP_MS);
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) throw new SiteLogsError(`--days 不合法：${days}`, { kind: 'config' });
  return Math.max(0, Number(nowMs) - n * DAY_MS);
}

/**
 * `--since`：13 位毫秒时间戳，或 ISO8601。无时区的写法按北京时间（UTC+8）解释，
 * 与仓库其余时间口径一致；带 Z / +08:00 的按原偏移解析。
 * @returns {number} epoch ms
 */
export function parseSinceArg(value) {
  const s = String(value ?? '').trim();
  if (!s) throw new SiteLogsError('--since 不能为空', { kind: 'config' });
  if (/^\d{13}$/.test(s)) return Number(s);

  const naive = s.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(?::(\d{2}))?)?$/);
  if (naive) {
    const iso = `${naive[1]}T${naive[2] ?? '00:00'}:${naive[3] ?? '00'}+08:00`;
    const ms = Date.parse(iso);
    if (Number.isFinite(ms)) return ms;
  } else if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const ms = Date.parse(s);
    if (Number.isFinite(ms)) return ms;
  }
  throw new SiteLogsError(
    `--since 只支持 ISO8601（如 2026-10-01T00:00:00 或 2026-10-01T00:00:00+08:00）或 13 位毫秒时间戳，当前是：${s}`,
    { kind: 'config' },
  );
}

/**
 * 把 `[sinceMs, untilMs)` 切成首尾相接、互不重叠的顺序分片；chunkMs <= 0 时不分片。
 * 分片边界是毫秒，请求 URL 会向下取整到秒。
 * @returns {Array<{startMs: number, endMs: number}>}
 */
export function buildChunks({ sinceMs, untilMs, chunkMs = DAY_MS } = {}) {
  const start = Number(sinceMs);
  const end = Number(untilMs);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new SiteLogsError('采集窗口不合法（起点必须早于终点）', { kind: 'config' });
  }
  const width = Number(chunkMs);
  if (!Number.isFinite(width) || width <= 0) return [{ startMs: start, endMs: end }];

  const chunks = [];
  let cursor = start;
  while (cursor < end) {
    const chunkEnd = Math.min(cursor + width, end);
    chunks.push({ startMs: cursor, endMs: chunkEnd });
    cursor = chunkEnd;
    if (chunks.length > MAX_CHUNKS) {
      throw new SiteLogsError(
        `分片过多（>${MAX_CHUNKS}），请调大 --chunk-days 或缩小窗口`,
        { kind: 'config' },
      );
    }
  }
  return chunks;
}

const pick = (obj, keys) => {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
};

function numOf(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[,\s$]/g, ''));
  return Number.isFinite(n) ? n : null;
}

const num0 = (v) => numOf(v) ?? 0;
const strOrNull = (v) => (v == null || v === '' ? null : String(v));
const round8 = (v) => (Number.isFinite(v) ? Number(v.toFixed(8)) : null);

/** new-api 的 other 字段是 JSON 字符串 */
function parseOther(item) {
  const v = item?.other;
  if (v && typeof v === 'object') return v;
  if (typeof v !== 'string' || !v) return {};
  try {
    const j = JSON.parse(v);
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

/** 流标记：布尔 is_stream 优先，其次 type/stream_type/request_type 文本 */
export function streamFlag(item) {
  const flag = pick(item, ['is_stream', 'isStream', 'stream']);
  if (typeof flag === 'boolean') return flag ? 1 : 0;
  const text = pick(item, ['type', 'stream_type', 'request_type']);
  if (typeof text === 'string' && text) {
    const t = text.toLowerCase();
    if (t === 'stream' || t === '流式') return 1;
    if (t === 'sync' || t === '非流式') return 0;
  }
  return null;
}

/** 记录时间（秒或毫秒）→ 毫秒；无法识别返回 null */
export function timeMs(item) {
  const raw = pick(item, ['created_at', 'createdAt', 'time', 'timestamp']);
  const n = numOf(raw);
  if (n == null || n <= 0) return null;
  return n > 1e12 ? Math.round(n) : Math.round(n * 1000);
}

function firstTokenMs(item, other) {
  const candidates = [
    item?.first_token_ms,
    item?.first_token,
    item?.ttft_ms,
    item?.firstTokenMs,
    other?.frt,
  ];
  for (const v of candidates) {
    const n = numOf(v);
    if (n != null) return Math.round(n);
  }
  return null;
}

// ---------------------------------------------------------------------------
// 内容指纹（与 v1 tools/lib/parse-input.mjs 同字段、同算法）
// ---------------------------------------------------------------------------

const FP_FIELDS = [
  't_ms',
  'model',
  'input_uncached',
  'output',
  'cache_read',
  'cache_write',
  'cost',
  'token_name',
  'endpoint',
  'ip',
  'is_stream',
  'rate_multiplier',
  'cost_original',
  'latency_ms',
];

const FP_MONEY = new Set(['cost', 'cost_original']);

const fpNum = (v, digits) =>
  v == null || v === '' || !Number.isFinite(Number(v))
    ? ''
    : digits == null
      ? String(Number(v))
      : Number(v).toFixed(digits);
const fpStr = (v) => (v == null || v === '' || v === '-' ? '' : String(v));

export function fingerprint(row) {
  const parts = FP_FIELDS.map((f) => {
    const v = row[f];
    if (f === 'is_stream') return v == null || v === '' ? '' : String(Number(v));
    if (FP_MONEY.has(f)) return fpNum(v, 8);
    if (f === 'model' || f === 'token_name' || f === 'endpoint' || f === 'ip') return fpStr(v);
    return fpNum(v);
  });
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex');
}

// ---------------------------------------------------------------------------
// 脱敏：raw_json 与错误信息
// ---------------------------------------------------------------------------

const SECRET_MIN_LEN = 12;

function maskSecret(s) {
  const v = String(s);
  if (v.length < SECRET_MIN_LEN) return '***';
  return `${v.slice(0, 6)}***${v.slice(-4)}`;
}

/** 递归脱敏：属性名为 key 的字符串与 sk- 开头的字符串掩码，其余原样 */
export function sanitizeSecrets(value, keyName) {
  if (typeof value === 'string') {
    return keyName === 'key' || /^sk-/i.test(value) ? maskSecret(value) : value;
  }
  if (Array.isArray(value)) return value.map((v) => sanitizeSecrets(v));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeSecrets(v, k);
    return out;
  }
  return value;
}

/** 错误/日志文本脱敏：抹掉已知 PAT 与 sk- 串，并截断长度 */
export function redact(text, secrets = []) {
  let s = String(text ?? '');
  for (const secret of secrets) {
    const v = String(secret ?? '');
    if (v) s = s.split(v).join('***');
  }
  s = s.replace(/sk-[A-Za-z0-9_-]{8,}/gi, 'sk-***');
  return s.slice(0, 300);
}

function apiMessage(json, ctx) {
  const text = [json?.message, json?.msg, json?.error?.message, json?.error]
    .filter((v) => typeof v === 'string' && v)
    .join('；');
  return redact(text || '（无消息）', [ctx.pat]);
}

// ---------------------------------------------------------------------------
// 字段归一：new-api 导出项 → logs 表行
// ---------------------------------------------------------------------------

/**
 * 一条导出日志 → `logs` 表行；非消耗日志（type != 2）或时间无法解析返回 null。
 * 字段口径与 v1 `normalizeNewApi` + `canonicalToSiteRow` 一致：
 * prompt_tokens 含缓存，cost = quota / 500000，raw_json 入库前脱敏。
 */
export function normalizeLogItem(item, { site = SITE, now = Date.now() } = {}) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const type = numOf(item.type);
  if (type !== 2) return null;
  const t = timeMs(item);
  if (t == null) return null;

  const other = parseOther(item);
  const prompt = numOf(pick(item, ['prompt_tokens', 'promptTokens']));
  const cacheRead = num0(
    pick(item, ['cache_tokens', 'cached_tokens', 'cache_read_tokens']) ??
      pick(other, ['cache_tokens', 'cached_tokens', 'cache_read_tokens']),
  );
  const cacheWrite = num0(
    pick(item, ['cache_creation_tokens', 'cache_write_tokens']) ??
      pick(other, ['cache_creation_tokens', 'cache_write_tokens']),
  );

  // 本站口径：prompt_tokens 含缓存；缓存数大于 prompt 说明该来源按不含缓存上报
  let semantic = 'includes_cache';
  let inputTotal = prompt;
  let inputUncached = prompt;
  if (prompt != null) {
    if (cacheRead > prompt) {
      semantic = 'excludes_cache';
      inputTotal = prompt + cacheRead + cacheWrite;
    } else {
      inputUncached = Math.max(0, prompt - cacheRead);
    }
  }

  const quota = numOf(item.quota);
  const channelId = numOf(item.channel);
  const duration = numOf(pick(item, ['duration_ms']));
  const useTime = numOf(pick(item, ['use_time', 'useTime']));
  const latency = duration != null ? Math.round(duration) : useTime != null ? Math.round(useTime * 1000) : null;

  const row = {
    req_id: '',
    ck: '',
    site,
    source_kind: 'newapi',
    input_format: 'api_ndjson',
    t_ms: t,
    t_local: formatLocal(t),
    user_name: strOrNull(pick(item, ['username', 'user_name'])),
    token_name: strOrNull(pick(item, ['token_name', 'key_name'])),
    group_name: strOrNull(pick(item, ['group', 'group_name'])),
    channel_id: channelId == null ? null : Math.round(channelId),
    channel_name: strOrNull(item.channel_name),
    model: strOrNull(pick(item, ['model_name', 'model'])),
    endpoint: strOrNull(
      pick(item, ['endpoint', 'request_url', 'request_path']) ?? pick(other, ['endpoint', 'request_url']),
    ),
    is_stream: streamFlag(item),
    reasoning_effort: strOrNull(pick(item, ['reasoning_effort']) ?? pick(other, ['reasoning_effort'])),
    ip: strOrNull(pick(item, ['ip', 'ip_address'])),
    input_total: inputTotal,
    input_uncached: inputUncached,
    cache_read: cacheRead,
    cache_write: cacheWrite,
    output: numOf(pick(item, ['completion_tokens', 'output_tokens', 'completionTokens'])),
    token_semantic: semantic,
    cost: quota == null ? null : round8(quota / QUOTA_PER_UNIT),
    cost_original: numOf(pick(item, ['original_cost']) ?? pick(other, ['original_cost'])),
    rate_multiplier: numOf(pick(item, ['rate_multiplier']) ?? pick(other, ['rate_multiplier', 'group_ratio'])),
    billing_mode: strOrNull(pick(item, ['billing_mode']) ?? pick(other, ['billing_mode'])),
    currency: 'USD',
    quota_raw: quota == null ? null : Math.round(quota),
    latency_ms: latency,
    first_token_ms: firstTokenMs(item, other),
    log_type: Math.round(type),
    content: strOrNull(item.content),
    src_file: SRC_FILE,
    src_mtime: now,
    ingested_at: now,
    raw_json: '',
  };

  row.ck = fingerprint(row);
  const rid = strOrNull(pick(item, ['request_id', 'req_id', 'id']));
  row.req_id = rid || `fp:${row.ck}`;
  row.raw_json = JSON.stringify(sanitizeSecrets(item));
  return row;
}

// ---------------------------------------------------------------------------
// 直读站点库：new-api 本地 SQLite → 与导出 NDJSON 同形的对象
// ---------------------------------------------------------------------------

/** created_at（秒）→ 毫秒；已经是毫秒的按原值（历史数据口径不一致时不至于放大 1000 倍） */
function secToMs(v) {
  const n = numOf(v);
  if (n == null || n <= 0) return null;
  return n > 1e12 ? Math.round(n) : Math.round(n * 1000);
}

/**
 * new-api `logs` 表一行 → 导出 NDJSON 同形对象，交给 {@link normalizeLogItem} 复用同一套归一化。
 * 唯一的字段改名是 `channel_id → channel`（导出端点就叫 channel）。
 */
export function sourceRowToItem(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    id: row.id,
    user_id: row.user_id,
    created_at: secToMs(row.created_at),
    type: row.type,
    content: row.content,
    username: row.username,
    token_name: row.token_name,
    model_name: row.model_name,
    quota: row.quota,
    prompt_tokens: row.prompt_tokens,
    completion_tokens: row.completion_tokens,
    use_time: row.use_time,
    is_stream: row.is_stream == null ? null : Boolean(Number(row.is_stream)),
    channel: row.channel_id,
    channel_name: row.channel_name,
    token_id: row.token_id,
    group: row.group,
    ip: row.ip,
    request_id: row.request_id,
    other: row.other,
  };
}

/**
 * 只读打开源库。文件不存在、不是 SQLite、没有 logs 表都算「打不开」（kind = db-open），
 * 由调用方决定回退 HTTP；打开成功后的读错误不会走到这里。
 */
function openSourceDb(dbFile) {
  if (!fs.existsSync(dbFile)) throw new SiteLogsError(`库文件不存在：${dbFile}`, { kind: 'db-open' });
  let src = null;
  try {
    src = new DatabaseSync(dbFile, { readOnly: true });
    src.exec('PRAGMA busy_timeout = 3000');
    const table = src.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'logs'").get();
    if (!table) throw new Error('没有 logs 表');
    return src;
  } catch (err) {
    try {
      src?.close();
    } catch {
      // 打不开时 close 也可能抛，忽略
    }
    throw new SiteLogsError(`打开 ${dbFile} 失败：${redact(err?.message ?? err)}`, { kind: 'db-open' });
  }
}

/**
 * 源库 channels 表的 id → name 映射。
 * 新版 new-api 的 logs.channel_name 长期写 NULL（只在 HTTP 导出的响应里现算），
 * 直读源库时渠道名只能从 channels.name 补，否则看板全部退化成「未命名渠道」。
 * 缺表或缺列时返回空表，调用方保持原值。
 */
export function loadChannelNames(src) {
  const map = new Map();
  try {
    const hasTable = src
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'channels'")
      .get();
    if (!hasTable) return map;
    for (const r of src.prepare('SELECT id, name FROM channels').all()) {
      const id = numOf(r?.id);
      const name = strOrNull(r?.name);
      if (id != null && name) map.set(Math.round(id), name);
    }
  } catch {
    // 源库结构变化时宁可不补名，也不要让整轮采集失败
  }
  return map;
}

/**
 * 直读一轮：水位定位起点 → 按 id 游标分页（type=2）→ 每页立即幂等入库。
 * 不把整表读进内存；dry-run 只统计不写。
 */
async function collectFromSourceDb({
  db,
  dbFile = DEFAULT_DB_FILE,
  site = SITE,
  days = DEFAULT_DAYS,
  dryRun = false,
  sinceMs: sinceOverride = null,
  nowMs = Date.now(),
  log = () => {},
} = {}) {
  if (!db) throw new SiteLogsError('缺少站点库连接', { kind: 'config' });

  const src = openSourceDb(dbFile);
  try {
    const channelNames = loadChannelNames(src);
    const lastTMs = readLastLogTime(db);
    const hasWatermark = lastTMs != null && Number.isFinite(Number(lastTMs)) && Number(lastTMs) > 0;
    let anchorSec;
    if (hasWatermark) {
      anchorSec = Math.floor((Number(lastTMs) - DB_OVERLAP_MS) / 1000);
    } else {
      const startMs = sinceOverride == null ? resolveSinceMs({ lastTMs: null, days, nowMs }) : Number(sinceOverride);
      if (!Number.isFinite(startMs) || startMs < 0) {
        throw new SiteLogsError(`窗口起点不合法：${sinceOverride}`, { kind: 'config' });
      }
      if (startMs >= nowMs) {
        throw new SiteLogsError('窗口起点必须早于当前时间（检查 --since 或库内 t_ms）', { kind: 'config' });
      }
      anchorSec = Math.floor(startMs / 1000);
    }

    let cursor = 0;
    let selectPage;
    try {
      const first = src
        .prepare('SELECT id, created_at FROM logs WHERE created_at >= ? ORDER BY id LIMIT 1')
        .get(anchorSec);
      const firstId = numOf(first?.id);
      if (firstId != null && firstId > 0) {
        const firstMs = secToMs(first.created_at);
        // 落在回看窗口里的第一行若已早于本地水位，说明它就是水位那一行（已在库里），
        // 用 `id > cursor` 跳过；否则（流量空档后的第一条新行）游标退一行把它拉进来。
        const skipFirst = hasWatermark && firstMs != null && firstMs <= Number(lastTMs);
        cursor = Math.floor(firstId) - (skipFirst ? 0 : 1);
      }
      selectPage = src.prepare('SELECT * FROM logs WHERE id > ? AND type = 2 ORDER BY id LIMIT ?');
    } catch (err) {
      throw new SiteLogsError(`读取源库失败（schema 变化？）：${redact(err?.message ?? err)}`, { kind: 'db' });
    }

    let rows = 0;
    let normalized = 0;
    let inserted = 0;
    let wouldInsert = 0;
    let skipped = 0;
    let replaced = 0;
    let invalid = 0;
    let pages = 0;
    let idMin = null;
    let idMax = null;
    const planned = new Set();

    for (;;) {
      let page;
      try {
        page = selectPage.all(cursor, DB_PAGE_SIZE);
      } catch (err) {
        throw new SiteLogsError(
          `读取源库失败（第 ${pages + 1} 页，已插入 ${inserted} 行）：${redact(err?.message ?? err)}`,
          { kind: 'db' },
        );
      }
      if (page.length === 0) break;
      pages++;

      const seen = new Set();
      const batch = [];
      let pageInvalid = 0;
      let pageDuplicate = 0;
      for (const srcRow of page) {
        const item = sourceRowToItem(srcRow);
        // 源库 channel_name 为 NULL 时用 channels.name 补齐（见 loadChannelNames 的说明）
        if (item && !item.channel_name && item.channel != null) {
          item.channel_name = channelNames.get(Math.round(Number(item.channel))) ?? null;
        }
        const row = normalizeLogItem(item, { site, now: nowMs });
        if (!row) {
          pageInvalid++;
          continue;
        }
        if (seen.has(row.req_id)) {
          pageDuplicate++;
          continue;
        }
        seen.add(row.req_id);
        batch.push(row);
      }

      let pageInserted = 0;
      let pageReplaced = 0;
      let pageSkipped = pageDuplicate;
      let pageWould = 0;
      try {
        if (dryRun) {
          const existing = countExistingLogs(db, batch.map((r) => r.req_id));
          let plannedDup = 0;
          for (const r of batch) {
            if (planned.has(r.req_id)) plannedDup++;
            else planned.add(r.req_id);
          }
          pageWould = batch.length - existing - plannedDup;
          pageSkipped += existing + plannedDup;
          wouldInsert += pageWould;
        } else {
          const res = insertLogs(db, batch);
          pageInserted = res.inserted;
          pageReplaced = res.replaced;
          pageSkipped += res.skipped;
        }
      } catch (err) {
        throw new SiteLogsError(
          `写入站点库失败（第 ${pages} 页，已插入 ${inserted} 行）：${redact(err?.message ?? err)}`,
          { kind: 'db' },
        );
      }

      const pageFirstId = Number(page[0].id);
      const pageLastId = Number(page[page.length - 1].id);
      cursor = pageLastId;
      if (idMin == null || pageFirstId < idMin) idMin = pageFirstId;
      if (idMax == null || pageLastId > idMax) idMax = pageLastId;

      rows += page.length;
      normalized += batch.length;
      inserted += pageInserted;
      replaced += pageReplaced;
      skipped += pageSkipped;
      invalid += pageInvalid;

      log(
        `直读 ${pages} 页 id ${pageFirstId}~${pageLastId} 行数 ${page.length} ` +
          `插入 ${pageInserted} 跳过 ${pageSkipped}` +
          (dryRun ? `（可插入 ${pageWould}）` : ''),
      );

      if (page.length < DB_PAGE_SIZE) break;
    }

    const summary = {
      site,
      source: 'db',
      transport: 'db',
      chunks: 0,
      pages,
      rows,
      normalized,
      inserted,
      wouldInsert,
      skipped,
      replaced,
      skippedType: 0,
      invalid,
      badLines: 0,
      truncated: false,
      outOfWindow: 0,
      // 本次扫描的起点（水位换回毫秒）；实际还受「窗口内最小 id 行」定位约束
      sinceMs: anchorSec * 1000,
      untilMs: nowMs,
      lastTMs,
      id_range: idMin == null ? null : { min: idMin, max: idMax },
      dryRun,
    };
    summary.report = formatReport(summary);
    return summary;
  } finally {
    try {
      src.close();
    } catch {
      // 关闭失败不影响已入库的数据
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function makePacer(minIntervalMs) {
  let lastAt = 0;
  return async () => {
    const gap = Number(minIntervalMs);
    const wait = lastAt && gap > 0 ? gap - (Date.now() - lastAt) : 0;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastAt = Date.now();
  };
}

export function exportUrl(baseUrl, { sinceMs, untilMs, logPath = DEFAULT_LOG_PATH }) {
  const u = new URL(baseUrl);
  const base = u.pathname.replace(/\/+$/, '');
  u.pathname = `${base}${logPath.replace(/\/+$/, '')}/export` || '/';
  u.searchParams.set('start_timestamp', String(Math.floor(sinceMs / 1000)));
  u.searchParams.set('end_timestamp', String(Math.floor(untilMs / 1000)));
  u.searchParams.set('type', '2');
  return u.toString();
}

export function pageUrl(
  baseUrl,
  page,
  { sinceMs, untilMs = null, logPath = DEFAULT_LOG_PATH, pageSize = DEFAULT_PAGE_SIZE } = {},
) {
  const u = new URL(baseUrl);
  const base = u.pathname.replace(/\/+$/, '');
  u.pathname = `${base}${logPath.replace(/\/+$/, '')}` || '/';
  u.searchParams.set('p', String(page));
  u.searchParams.set('page_size', String(pageSize));
  u.searchParams.set('type', '2');
  u.searchParams.set('start_timestamp', String(Math.floor(sinceMs / 1000)));
  if (untilMs != null) u.searchParams.set('end_timestamp', String(Math.floor(untilMs / 1000)));
  return u.toString();
}

async function httpGet(url, headers, ctx) {
  await ctx.pace();
  ctx.requests++;
  let res;
  try {
    res = await ctx.fetchImpl(url, { headers, signal: AbortSignal.timeout(ctx.timeoutMs) });
  } catch (err) {
    throw new SiteLogsError(`网络错误：${redact(err?.message ?? err, [ctx.pat])}`, { kind: 'network' });
  }
  let text;
  try {
    text = await res.text();
  } catch (err) {
    throw new SiteLogsError(`读取响应失败：${redact(err?.message ?? err, [ctx.pat])}`, { kind: 'network' });
  }
  return { status: Number(res.status) || 0, text };
}

/** HTTP 状态分类；404/405 在 allowNotFound 时返回 false，交给分页回退 */
function assertHttpOk(status, { allowNotFound = false } = {}) {
  if (status === 401 || status === 403) {
    throw new SiteLogsError(`auth 失败（HTTP ${status}）`, { kind: 'auth', status });
  }
  if (status === 429) throw new SiteLogsError('限流（HTTP 429）', { kind: 'rate_limited', status });
  if (status >= 500) throw new SiteLogsError(`服务端错误（HTTP ${status}）`, { kind: 'server', status });
  if (allowNotFound && (status === 404 || status === 405)) return false;
  if (status < 200 || status >= 300) throw new SiteLogsError(`HTTP ${status}`, { kind: 'http', status });
  return true;
}

/** 导出通道：单请求拿整个窗口的 NDJSON；端点不存在返回 null */
async function fetchByExport(url, headers, ctx) {
  const { status, text } = await httpGet(url, headers, ctx);
  if (!assertHttpOk(status, { allowNotFound: true })) return null;

  const parsed = parseExportNdjson(text);
  if (parsed.result && parsed.result.success === false) {
    throw new SiteLogsError(`接口返回失败（HTTP ${status}）：${apiMessage(parsed.result, ctx)}`, {
      kind: 'api',
      status,
    });
  }
  let items = parsed.items;
  // 少数版本导出端点也回分页 JSON：单行 {success,data:{items}} 直接取用
  if (items.length === 0 && Array.isArray(parsed.result?.data?.items)) items = parsed.result.data.items;
  if (items.length === 0 && parsed.badLines > 0) {
    throw new SiteLogsError('响应既不是 NDJSON 也不是 JSON', { kind: 'shape', status });
  }
  return { items, pages: 1, badLines: parsed.badLines, truncated: false, transport: 'export' };
}

/** 分页通道（旧版没有导出端点时）：翻到末页为止，窗口按分片传入 */
async function fetchByPages({ baseUrl, logPath, sinceMs, untilMs, headers, ctx, pageSize, maxPages }) {
  const items = [];
  let pages = 0;
  let truncated = false;

  for (let page = 1; page <= maxPages; page++) {
    const url = pageUrl(baseUrl, page, { sinceMs, untilMs, logPath, pageSize });
    const { status, text } = await httpGet(url, headers, ctx);
    assertHttpOk(status);

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new SiteLogsError(`分页响应不是 JSON（HTTP ${status}）`, { kind: 'shape', status });
    }
    if (json && typeof json === 'object' && json.success === false) {
      throw new SiteLogsError(`接口返回失败（HTTP ${status}）：${apiMessage(json, ctx)}`, { kind: 'api', status });
    }
    const data = json && typeof json === 'object' && 'data' in json ? json.data : json;
    const list = Array.isArray(data)
      ? data
      : Array.isArray(data?.items)
        ? data.items
        : Array.isArray(data?.data)
          ? data.data
          : Array.isArray(data?.logs)
            ? data.logs
            : null;
    if (!list) throw new SiteLogsError(`分页响应缺少日志数组（第 ${page} 页）`, { kind: 'shape', status });

    items.push(...list);
    pages++;

    if (list.length < pageSize) break;
    const total = numOf(data?.total ?? json?.total);
    if (total != null && page * pageSize >= total) break;
    if (page === maxPages) truncated = true;
  }

  return { items, pages, badLines: 0, truncated, transport: 'paged' };
}

// ---------------------------------------------------------------------------
// 报告与主流程
// ---------------------------------------------------------------------------

/** 一行报告：只含计数与 id/时间范围，不含 PAT、日志原文 */
export function formatReport(summary) {
  const parts = [`[${JOB_NAME}] ${summary.site}`];
  if (summary.source === 'db') {
    parts.push('直读 db', `读取 ${summary.pages} 页`);
  } else {
    parts.push(summary.transport === 'paged' ? '分页' : '导出');
    parts.push(summary.chunks > 1 ? `${summary.chunks} 段` : '单段', `请求 ${summary.pages} 页`);
  }
  parts.push(
    `拿到 ${summary.rows} 行`,
    summary.dryRun ? `[dry-run] 未写库，可插入 ${summary.wouldInsert} 行` : `插入 ${summary.inserted} 行`,
    `跳过重复 ${summary.skipped} 行`,
    `时间范围 ${formatLocal(summary.sinceMs)} ~ ${formatLocal(summary.untilMs)}`,
  );
  if (summary.id_range) parts.push(`id 范围 ${summary.id_range.min}~${summary.id_range.max}`);
  if (summary.skippedType > 0) parts.push(`非消耗日志跳过 ${summary.skippedType} 行`);
  if (summary.invalid > 0) parts.push(`无效行 ${summary.invalid}`);
  if (summary.badLines > 0) parts.push(`坏行 ${summary.badLines}`);
  if (summary.replaced > 0) parts.push(`替换指纹行 ${summary.replaced}`);
  if (summary.truncated) parts.push('达到翻页上限，已截断');
  return parts.join(' · ');
}

/** 把分片内的失败包成「第 N/M 段 + 范围 + 已插入行数」，保留原始错误类型与状态 */
function chunkFailure(err, { index, total, startMs, endMs, inserted }) {
  const detail = err instanceof SiteLogsError ? err.message : `内部错误：${err?.message ?? err}`;
  return new SiteLogsError(
    `第 ${index + 1}/${total} 段 ${formatLocal(startMs)} ~ ${formatLocal(endMs)} 失败：${detail}（已插入 ${inserted} 行）`,
    { kind: err?.kind ?? 'error', status: err?.status ?? null },
  );
}

/**
 * HTTP 通道：按分片请求导出端点，每片拉完立刻入库（幂等）。
 *
 * @param {object} options
 * @param {import('node:sqlite').DatabaseSync} options.db 站点库连接（readOnly 也可，dry-run 用它）
 * @param {string} options.pat 管理员 PAT（只进请求头）
 * @param {string} [options.baseUrl]
 * @param {string} [options.logPath]
 * @param {number} [options.days] 空库回看天数
 * @param {number} [options.chunkDays] 分片长度（天，支持小数）；<=0 不分片
 * @param {boolean} [options.dryRun] 不写库
 * @param {number|null} [options.sinceMs] 覆盖窗口起点（毫秒）
 * @param {number} [options.nowMs]
 * @param {Function} [options.fetchImpl]
 * @param {Function} [options.log] 每片进度输出（默认不输出）
 */
async function collectViaHttp({
  db,
  pat,
  baseUrl = DEFAULT_BASE_URL,
  logPath = DEFAULT_LOG_PATH,
  site = SITE,
  days = DEFAULT_DAYS,
  chunkDays = DEFAULT_CHUNK_DAYS,
  dryRun = false,
  sinceMs: sinceOverride = null,
  nowMs = Date.now(),
  fetchImpl = globalThis.fetch,
  pageSize = DEFAULT_PAGE_SIZE,
  maxPages = DEFAULT_MAX_PAGES,
  minIntervalMs = REQ_GAP_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  log = () => {},
} = {}) {
  if (!db) throw new SiteLogsError('缺少站点库连接', { kind: 'config' });
  if (!pat) throw new SiteLogsError('缺少管理员 PAT', { kind: 'auth' });
  if (typeof fetchImpl !== 'function') throw new SiteLogsError('缺少可用的 fetch', { kind: 'config' });
  if (!baseUrl) {
    throw new SiteLogsError(
      '缺少站点地址：请在 instance.json 里配置 site.base_url，或用 --base-url=',
      { kind: 'config' },
    );
  }
  const chunkDayCount = Number(chunkDays);
  if (!Number.isFinite(chunkDayCount)) {
    throw new SiteLogsError(`--chunk-days 不合法：${chunkDays}`, { kind: 'config' });
  }
  const timeout = Number(timeoutMs);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new SiteLogsError(`--timeout-ms 不合法：${timeoutMs}`, { kind: 'config' });
  }

  const lastTMs = readLastLogTime(db);
  const sinceMs = sinceOverride == null ? resolveSinceMs({ lastTMs, days, nowMs }) : Number(sinceOverride);
  if (!Number.isFinite(sinceMs) || sinceMs < 0) {
    throw new SiteLogsError(`窗口起点不合法：${sinceOverride}`, { kind: 'config' });
  }
  if (sinceMs >= nowMs) {
    throw new SiteLogsError('窗口起点必须早于当前时间（检查 --since 或库内 t_ms）', { kind: 'config' });
  }

  const chunks = buildChunks({ sinceMs, untilMs: nowMs, chunkMs: chunkDayCount * DAY_MS });
  const headers = { Authorization: `Bearer ${pat}`, Accept: 'application/json' };
  const ctx = { fetchImpl, pat, timeoutMs: timeout, requests: 0, pace: makePacer(minIntervalMs) };

  // 首次遇到导出端点 404/405 后整轮改走分页，后续分片不再试探导出
  let mode = 'export';
  const planned = new Set();
  let rows = 0;
  let normalized = 0;
  let inserted = 0;
  let wouldInsert = 0;
  let skipped = 0;
  let replaced = 0;
  let skippedType = 0;
  let badLines = 0;
  let truncated = false;
  let outOfWindow = 0;

  for (let i = 0; i < chunks.length; i++) {
    const { startMs, endMs } = chunks[i];

    let fetched = null;
    try {
      if (mode === 'export') {
        fetched = await fetchByExport(
          exportUrl(baseUrl, { sinceMs: startMs, untilMs: endMs, logPath }),
          headers,
          ctx,
        );
        if (!fetched) mode = 'paged';
      }
      if (!fetched) {
        fetched = await fetchByPages({
          baseUrl,
          logPath,
          sinceMs: startMs,
          untilMs: endMs,
          headers,
          ctx,
          pageSize,
          maxPages,
        });
        mode = 'paged';
      }
    } catch (err) {
      throw chunkFailure(err, { index: i, total: chunks.length, startMs, endMs, inserted });
    }

    const seen = new Set();
    const batchRows = [];
    let chunkSkippedType = 0;
    let chunkDuplicate = 0;
    for (const item of fetched.items) {
      const row = normalizeLogItem(item, { site, now: nowMs });
      if (!row) {
        chunkSkippedType++;
        continue;
      }
      // 分页端点若忽略 end_timestamp，用行时间兜底裁回本片窗口
      if (row.t_ms < startMs || row.t_ms >= endMs) {
        outOfWindow++;
        continue;
      }
      if (seen.has(row.req_id)) {
        chunkDuplicate++;
        continue;
      }
      seen.add(row.req_id);
      batchRows.push(row);
    }

    let chunkInserted = 0;
    let chunkReplaced = 0;
    let chunkSkipped = chunkDuplicate;
    let chunkWouldInsert = 0;
    try {
      if (dryRun) {
        const existing = countExistingLogs(db, batchRows.map((r) => r.req_id));
        let plannedDup = 0;
        for (const r of batchRows) {
          if (planned.has(r.req_id)) plannedDup++;
          else planned.add(r.req_id);
        }
        chunkWouldInsert = batchRows.length - existing - plannedDup;
        chunkSkipped += existing + plannedDup;
        wouldInsert += chunkWouldInsert;
      } else {
        const res = insertLogs(db, batchRows);
        chunkInserted = res.inserted;
        chunkReplaced = res.replaced;
        chunkSkipped += res.skipped;
      }
    } catch (err) {
      throw chunkFailure(err, { index: i, total: chunks.length, startMs, endMs, inserted });
    }

    rows += fetched.items.length;
    normalized += batchRows.length;
    inserted += chunkInserted;
    replaced += chunkReplaced;
    skipped += chunkSkipped;
    skippedType += chunkSkippedType;
    badLines += fetched.badLines;
    truncated = truncated || fetched.truncated;

    log(
      `分片 ${i + 1}/${chunks.length} ${formatLocal(startMs)} ~ ${formatLocal(endMs)} ` +
        `行数 ${fetched.items.length} 插入 ${chunkInserted} 跳过 ${chunkSkipped}` +
        (dryRun ? `（可插入 ${chunkWouldInsert}）` : ''),
    );
  }

  const summary = {
    site,
    source: 'http',
    transport: mode === 'paged' ? 'paged' : 'export',
    chunks: chunks.length,
    pages: ctx.requests,
    rows,
    normalized,
    inserted,
    wouldInsert,
    skipped,
    replaced,
    skippedType,
    badLines,
    truncated,
    outOfWindow,
    sinceMs,
    untilMs: nowMs,
    lastTMs,
    chunkDays: chunkDayCount,
    dryRun,
  };
  summary.report = formatReport(summary);
  return summary;
}

/**
 * 跑一轮采集，按 `source` 选通道。
 *
 * `db`（默认）直读站点本地 SQLite；只有「打不开源库」（kind = db-open）才回退 HTTP，
 * 并打一行提示。打开成功后的读错误（锁、schema 变化）直接抛出，避免同一轮混用两种源。
 *
 * @param {object} options 见 {@link collectViaHttp}；另加：
 * @param {'db'|'http'} [options.source]
 * @param {string} [options.dbFile] 直读的源库文件
 */
export async function runCollectSiteLogs(options = {}) {
  const { source = INSTANCE.collect.source, dbFile = DEFAULT_DB_FILE, log = () => {} } = options;
  if (source === 'http') return collectViaHttp(options);
  if (source !== 'db') {
    throw new SiteLogsError(`--source 只支持 db 或 http：${source}`, { kind: 'config' });
  }
  try {
    return await collectFromSourceDb({ ...options, dbFile });
  } catch (err) {
    if (err?.kind !== 'db-open') throw err;
    log(`[${JOB_NAME}] 直读失败，回退 HTTP 导出：${redact(err?.message ?? err)}`);
    return collectViaHttp(options);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const opts = {
    source: INSTANCE.collect.source,
    dbFile: DEFAULT_DB_FILE,
    baseUrl: DEFAULT_BASE_URL,
    siteId: SITE,
    days: DEFAULT_DAYS,
    chunkDays: DEFAULT_CHUNK_DAYS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    sinceMs: null,
    dryRun: false,
    help: false,
  };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg.startsWith('--source=')) {
      const v = arg.slice('--source='.length);
      if (v !== 'db' && v !== 'http') throw new SiteLogsError(`--source 只支持 db 或 http：${v}`, { kind: 'config' });
      opts.source = v;
    } else if (arg.startsWith('--db-file=')) {
      const v = arg.slice('--db-file='.length);
      if (!v) throw new SiteLogsError('--db-file 不能为空', { kind: 'config' });
      opts.dbFile = v;
    } else if (arg.startsWith('--base-url=')) {
      const v = arg.slice('--base-url='.length).trim();
      if (!v) throw new SiteLogsError('--base-url 不能为空', { kind: 'config' });
      opts.baseUrl = v;
    } else if (arg.startsWith('--site-id=')) {
      const v = arg.slice('--site-id='.length).trim();
      if (!v) throw new SiteLogsError('--site-id 不能为空', { kind: 'config' });
      opts.siteId = v;
    } else if (arg.startsWith('--config=')) {
      // 配置文件在 lib/instance.mjs 初始化时读取，这里只吞掉参数
    } else if (arg.startsWith('--days=')) {
      const n = Number(arg.slice('--days='.length));
      if (!Number.isFinite(n) || n <= 0) throw new SiteLogsError(`--days 不合法：${arg}`, { kind: 'config' });
      opts.days = n;
    } else if (arg.startsWith('--chunk-days=')) {
      const n = Number(arg.slice('--chunk-days='.length));
      if (!Number.isFinite(n)) throw new SiteLogsError(`--chunk-days 不合法：${arg}`, { kind: 'config' });
      opts.chunkDays = n;
    } else if (arg.startsWith('--timeout-ms=')) {
      const raw = arg.slice('--timeout-ms='.length);
      const n = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isInteger(n) || n <= 0) {
        throw new SiteLogsError(`--timeout-ms 必须是正整数：${arg}`, { kind: 'config' });
      }
      opts.timeoutMs = n;
    } else if (arg.startsWith('--since=')) {
      opts.sinceMs = parseSinceArg(arg.slice('--since='.length));
    } else throw new SiteLogsError(`未知参数：${arg}\n\n${USAGE}`, { kind: 'config' });
  }
  return opts;
}

/** 读 PAT；错误信息里只有路径与行名提示，不含文件内容 */
export function readPat(file = TOKEN_FILE, site = SITE) {
  if (!fs.existsSync(file)) throw new SiteLogsError(`缺少令牌文件：${file}`, { kind: 'auth' });
  const pat = pickToken(fs.readFileSync(file, 'utf8'), site);
  if (!pat) {
    throw new SiteLogsError(
      `令牌文件里没有可用的令牌（名称等于「${site}」的行，或单行纯 token）：${file}`,
      { kind: 'auth' },
    );
  }
  return pat;
}

/** 直读源不需要 PAT：令牌文件缺失/没有对应行时留空，回退 HTTP 时再按 HTTP 路径报错 */
function readPatOrNull(file = TOKEN_FILE, site = SITE) {
  try {
    return readPat(file, site);
  } catch {
    return null;
  }
}

async function main(argv) {
  let pat = null;
  try {
    const opts = parseArgs(argv);
    if (opts.help) {
      console.log(USAGE);
      return 0;
    }
    pat = opts.source === 'http'
      ? readPat(TOKEN_FILE, opts.siteId)
      : readPatOrNull(TOKEN_FILE, opts.siteId);
    ensureDataDirs(INSTANCE);
    const db = openLogsDb(SITE_DB_FILE, { readOnly: opts.dryRun });
    try {
      const summary = await runCollectSiteLogs({
        db,
        pat,
        source: opts.source,
        dbFile: opts.dbFile,
        baseUrl: opts.baseUrl,
        site: opts.siteId,
        days: opts.days,
        chunkDays: opts.chunkDays,
        timeoutMs: opts.timeoutMs,
        sinceMs: opts.sinceMs,
        dryRun: opts.dryRun,
        log: (line) => console.log(line),
      });
      console.log(summary.report);
    } finally {
      db.close();
    }
    return 0;
  } catch (err) {
    console.error(`[${JOB_NAME}] 失败：${redact(err?.message ?? err, pat ? [pat] : [])}`);
    return 1;
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code ?? 0;
  });
}
