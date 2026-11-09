/**
 * collect-http-errors：从 nginx 访问日志增量聚合 4xx/5xx 到看板库 `http_errors_hourly`。
 *
 * 用法：
 *   node v2/jobs/collect-http-errors.mjs --file=/var/log/nginx/access.log
 *   node v2/jobs/collect-http-errors.mjs --file=./access.log --db=./dashboard.db
 *   node v2/jobs/collect-http-errors.mjs --dry-run      # 只解析与统计，不写库、不写位点
 *   node v2/jobs/collect-http-errors.mjs --from-start   # 忽略位点从头读（仅调试）
 *
 * 口径：
 *   - 只统计状态码 400..599；其余行照常解析但不入桶。
 *   - 位点 `http_errors_offset`（schema_meta）记录已处理的字节偏移；只消费以换行结尾的完整行，
 *     文件末尾被写入方截断的半行留到下一轮。
 *   - 文件变小（轮转/截断）时位点归零重读，不报错。
 *   - 解析失败的行跳过并计数，单行失败不影响其它行；输出不含日志原文（可能有 IP / UA）。
 *   - 时间取 nginx `$time_local` 自带的时区偏移，换算成北京时间整点毫秒。
 *   - `path_group`：路径（去掉 query）为 `/v1` 或以 `/v1/` 开头 → `/v1`；`/api`、`/api/` → `/api`；
 *     其余（含请求行 `-`）→ `other`。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { INSTANCE } from '../lib/instance.mjs';
import { TZ_OFFSET_MS } from '../lib/time.mjs';
import { openDashboardDb } from '../store/dashboard.mjs';
import { readOffset, upsertBuckets, writeOffset } from '../store/http-errors.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const V2_DIR = path.dirname(HERE);

export const DEFAULT_LOG_FILE = '/var/log/nginx/access.log';
export const DEFAULT_DB_FILE = INSTANCE.paths.dashboardFile;

const HOUR_MS = 3_600_000;

export const USAGE = `用法：
  node v2/jobs/collect-http-errors.mjs [--file=<path>] [--db=<path>] [--dry-run] [--from-start] [--help]

  --file=<path>     nginx 访问日志（默认 ${DEFAULT_LOG_FILE}；也接受 --file <path>）
  --db=<path>       看板库（默认取实例配置的看板库；也接受 --db <path>）
  --dry-run         只解析与统计，不写库、不写位点
  --from-start      忽略已有位点从头读（仅调试；正常增量不需要）
  --help            显示本说明

  增量位点存在 schema_meta.http_errors_offset；文件变小（轮转/截断）时自动从 0 重读。
  只统计状态码 400..599，按「北京整点 × 状态码 × 路径组」累加。`;

export class HttpErrorsOptionsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HttpErrorsOptionsError';
  }
}

// ---------------------------------------------------------------------------
// 解析（纯函数）
// ---------------------------------------------------------------------------

const MONTHS = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/** nginx combined 格式；末尾允许追加字段（例如 $request_time） */
const ACCESS_RE =
  /^(\S+) \S+ \S+ \[([^\]]+)\] "([^"]*)" (\d{3}) (?:\d+|-) "[^"]*" "[^"]*"(?:\s.*)?$/;
const TIME_RE = /^(\d{2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/;

/** `08/Nov/2026:13:22:33 +0000` → UTC 毫秒时间戳；无法解析返回 null */
export function parseNginxTime(text) {
  const m = TIME_RE.exec(String(text ?? '').trim());
  if (!m) return null;
  const month = MONTHS[m[2].toLowerCase()];
  if (month === undefined) return null;
  const utcMs = Date.UTC(
    Number(m[3]),
    month,
    Number(m[1]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
  );
  if (!Number.isFinite(utcMs)) return null;
  const sign = m[7] === '-' ? -1 : 1;
  const offsetMs = sign * (Number(m[8]) * 3600 + Number(m[9]) * 60) * 1000;
  return utcMs - offsetMs;
}

/** 毫秒时间戳所在北京整点（UTC+8，无夏令时） */
export function beijingHourStart(ms) {
  return Math.floor((Number(ms) + TZ_OFFSET_MS) / HOUR_MS) * HOUR_MS - TZ_OFFSET_MS;
}

/** 请求行 `GET /path?q HTTP/1.1` 或 `-` → 路径组 */
export function classifyRequest(request) {
  const line = String(request ?? '').trim();
  if (!line || line === '-') return 'other';
  const parts = line.split(/\s+/);
  const target = parts.length >= 2 ? parts[1] : parts[0];
  const pathname = String(target ?? '').split('?')[0];
  if (pathname === '/v1' || pathname.startsWith('/v1/')) return '/v1';
  if (pathname === '/api' || pathname.startsWith('/api/')) return '/api';
  return 'other';
}

/**
 * 解析一行 nginx combined 日志。
 * @returns {null | { hour_ms:number, status:number, path_group:string, isError:boolean }}
 *   null 表示坏行；`isError` 为 false 的行解析成功但不入桶。
 */
export function parseAccessLine(line) {
  const m = ACCESS_RE.exec(String(line ?? '').trim());
  if (!m) return null;
  const timeMs = parseNginxTime(m[2]);
  if (timeMs === null) return null;
  const status = Number(m[4]);
  if (!Number.isInteger(status) || status < 100 || status > 599) return null;
  return {
    hour_ms: beijingHourStart(timeMs),
    status,
    path_group: classifyRequest(m[3]),
    isError: status >= 400,
  };
}

// ---------------------------------------------------------------------------
// 增量读文件
// ---------------------------------------------------------------------------

/** 从 offset 读到文件末尾；返回实际读到的字节与新的完整行边界 */
function readFromOffset(file, offset, size) {
  const length = size - offset;
  if (!(length > 0)) return { buffer: Buffer.alloc(0), consumed: 0 };

  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    let filled = 0;
    while (filled < length) {
      const n = fs.readSync(fd, buffer, filled, length - filled, offset + filled);
      if (n <= 0) break;
      filled += n;
    }
    return { buffer: buffer.subarray(0, filled), consumed: filled };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 处理一个字节块：只消费最后一个换行之前的完整行，返回行列表与已消费字节。
 * 末尾半行（写入方还没写完）不解析，下一轮再读。
 */
function splitCompleteLines(buffer) {
  const lastNewline = buffer.lastIndexOf(0x0a);
  if (lastNewline < 0) return { lines: [], consumed: 0 };
  const text = buffer.subarray(0, lastNewline).toString('utf8');
  return {
    lines: text.split('\n').map((line) => line.replace(/\r$/, '')),
    consumed: lastNewline + 1,
  };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * 执行一轮采集。文件不存在只打一行 warn 并返回 `{ missing: true }`，不抛错。
 * @returns {{missing?:boolean, lines:number, errors:number, bad:number, buckets:number, offset:number, dryRun:boolean}}
 */
export function runCollectHttpErrors({
  file = DEFAULT_LOG_FILE,
  dbFile = DEFAULT_DB_FILE,
  dryRun = false,
  fromStart = false,
  now = Date.now,
  log = console.log,
  errorLog = console.error,
} = {}) {
  const source = path.resolve(file);

  if (!fs.existsSync(source)) {
    errorLog(`[collect-http-errors] warn: 日志文件不存在，跳过本轮：${source}`);
    return { missing: true, lines: 0, errors: 0, bad: 0, buckets: 0, offset: 0, dryRun };
  }

  const size = fs.statSync(source).size;
  let db = null;
  try {
    // dry-run 不建库、不建表；只看已有库里的位点
    if (dryRun) {
      if (fs.existsSync(dbFile)) db = new DatabaseSync(dbFile, { readOnly: true });
    } else {
      db = openDashboardDb(dbFile);
    }

    let offset = fromStart ? 0 : db ? readOffset(db) : 0;
    // 轮转/截断：位点超过当前文件大小，从头重读
    if (size < offset) offset = 0;

    const { buffer } = readFromOffset(source, offset, size);
    const { lines, consumed } = splitCompleteLines(buffer);
    const nextOffset = offset + consumed;

    const buckets = new Map();
    let parsed = 0;
    let bad = 0;
    let errorLines = 0;

    for (const line of lines) {
      if (line.trim() === '') continue;
      parsed += 1;
      const row = parseAccessLine(line);
      if (!row) {
        bad += 1;
        continue;
      }
      if (!row.isError) continue;
      errorLines += 1;
      const key = `${row.hour_ms}|${row.status}|${row.path_group}`;
      const current = buckets.get(key);
      if (current) current.count += 1;
      else buckets.set(key, { hour_ms: row.hour_ms, status: row.status, path_group: row.path_group, count: 1 });
    }

    const rows = [...buckets.values()].sort(
      (a, b) =>
        a.hour_ms - b.hour_ms ||
        a.status - b.status ||
        a.path_group.localeCompare(b.path_group),
    );

    if (!dryRun && db) {
      upsertBuckets(db, rows, typeof now === 'function' ? now() : now);
      writeOffset(db, nextOffset, typeof now === 'function' ? now() : now);
    }

    log(
      (dryRun ? '[collect-http-errors] dry-run：' : '[collect-http-errors] ') +
        `读取 ${parsed} 行 · 4xx/5xx ${errorLines} 行 · 写入 ${rows.length} 桶` +
        (bad > 0 ? ` · 坏行 ${bad}` : '') +
        ` · offset→${nextOffset}` +
        (dryRun ? '（dry-run 未落库、未写回）' : ''),
    );

    return {
      missing: false,
      lines: parsed,
      errors: errorLines,
      bad,
      buckets: rows.length,
      offset: nextOffset,
      dryRun,
    };
  } finally {
    db?.close();
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parsePath(raw, flag, arg = flag) {
  const value = String(raw ?? '').trim();
  if (!value) throw new HttpErrorsOptionsError(`${flag} 不能为空：${arg}`);
  return path.resolve(value);
}

/** 解析 CLI 参数；非法参数抛 HttpErrorsOptionsError。路径参数同时接受 `--file=<path>` 与 `--file <path>` */
export function parseArgs(argv = []) {
  const options = {
    help: false,
    file: DEFAULT_LOG_FILE,
    dbFile: DEFAULT_DB_FILE,
    dryRun: false,
    fromStart: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--from-start') options.fromStart = true;
    else if (arg === '--file') options.file = parsePath(argv[++i], '--file');
    else if (arg.startsWith('--file=')) options.file = parsePath(arg.slice('--file='.length), '--file', arg);
    else if (arg === '--db') options.dbFile = parsePath(argv[++i], '--db');
    else if (arg.startsWith('--db=')) options.dbFile = parsePath(arg.slice('--db='.length), '--db', arg);
    else if (arg === '--config') {
      // 配置文件在 lib/instance.mjs 初始化时读取，这里只吞掉参数
      i += 1;
    } else if (arg.startsWith('--config=')) {
      // 同上
    } else throw new HttpErrorsOptionsError(`未知参数：${arg}`);
  }
  return options;
}

/** 返回退出码：0 成功或日志文件缺失，1 参数/执行错误 */
export function main(argv = [], { log = console.log, errorLog = console.error } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    errorLog(`[collect-http-errors] ${err?.message ?? err}`);
    errorLog(USAGE);
    return 1;
  }
  if (options.help) {
    log(USAGE);
    return 0;
  }
  try {
    runCollectHttpErrors({ ...options, log, errorLog });
    return 0;
  } catch (err) {
    errorLog(`[collect-http-errors] 失败：${err?.message ?? err}`);
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
