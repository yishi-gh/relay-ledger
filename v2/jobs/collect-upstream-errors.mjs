/**
 * collect-upstream-errors：把源库 `logs` 里 type=5（上游错误）增量同步到看板库 `upstream_error`。
 *
 * 用法：
 *   node v2/jobs/collect-upstream-errors.mjs
 *   node v2/jobs/collect-upstream-errors.mjs --relay-db=/home/newapi/one-api.db --db=./dashboard.db
 *   node v2/jobs/collect-upstream-errors.mjs --dry-run      # 只统计，不写库、不写水位
 *
 * 口径：
 *   - 源库只读（readOnly + busy_timeout 5000），不改源库、不连上游 HTTP。
 *   - 主键用源库 logs.id，INSERT OR IGNORE；水位 `schema_meta.upstream_error_offset`
 *     与数据在同一事务里前移，写失败不会越过未落库的行。
 *   - created_at 为秒级时间戳，统一换算成毫秒。
 *   - status_code 从 content 的 `status_code=NNN` 提取，取不到存 NULL；
 *     原文截断 500 字存 message（可能含上游报错细节，不含凭据）。
 *   - 源库不存在只打一行提示、退出码 0：面板照常工作，只是没有错误数据。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { INSTANCE } from '../lib/instance.mjs';
import { toEpochMs } from '../lib/time.mjs';
import { openDashboardDb } from '../store/dashboard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const V2_DIR = path.dirname(HERE);

/** schema_meta 里的增量水位：已处理到的源库 logs.id */
export const OFFSET_KEY = 'upstream_error_offset';
export const DEFAULT_DB_FILE = INSTANCE.paths.dashboardFile;
export const DEFAULT_RELAY_DB = INSTANCE.paths.relayDb;
/** 单批读取行数：2000 行一批，避免一次把源库日志全拉进内存 */
export const BATCH_SIZE = 2000;
/** message 最多保留的字符数：足够定位上游报错，又不会把整段响应体灌进面板 */
export const MESSAGE_MAX = 500;

const STATUS_RE = /status_code=(\d{3})/;
// `group` 是 SQLite 关键字，必须加引号
const SELECT_SQL = `SELECT id, created_at, channel_id, channel_name, model_name,
                           "group" AS group_name, content, request_id
                      FROM logs
                     WHERE id > ? AND type = 5
                     ORDER BY id
                     LIMIT ?`;

export const USAGE = `用法：
  node v2/jobs/collect-upstream-errors.mjs [--relay-db=<path>] [--db=<path>] [--dry-run] [--help]

  --relay-db=<path>  源库路径（默认取实例配置 ${DEFAULT_RELAY_DB}；也接受 --relay-db <path>）
  --db=<path>        看板库路径（默认取实例配置的看板库；也接受 --db <path>）
  --dry-run          只读取与统计，不写库、不写水位
  --help             显示本说明

  增量水位存在 schema_meta.${OFFSET_KEY}；源库不存在时打一行提示并正常退出（退出码 0）。`;

export class UpstreamErrorsOptionsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UpstreamErrorsOptionsError';
  }
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

/** 从错误日志正文取 HTTP 状态码；取不到返回 null */
export function parseStatusCode(content) {
  const match = STATUS_RE.exec(String(content ?? ''));
  return match ? Number(match[1]) : null;
}

/** 源库日志原文 → 只保留截断后的 message（500 字） */
export function truncateMessage(content) {
  const text = content == null ? '' : String(content);
  return text === '' ? null : text.slice(0, MESSAGE_MAX);
}

/**
 * 源库一行 → upstream_error 的列；created_at 无法解析时返回 null（跳过该行）。
 * @returns {null | { id:number, t_ms:number, channel_id:number|null, channel_name:string|null,
 *   model:string|null, group_name:string|null, status_code:number|null, message:string|null,
 *   request_id:string|null, recorded_at:number }}
 */
export function parseUpstreamErrorRow(row, recordedAt = Date.now()) {
  const id = Number(row?.id);
  if (!Number.isSafeInteger(id)) return null;
  const tMs = toEpochMs(row.created_at);
  if (tMs === null) return null;
  const asText = (value) => (value == null ? null : String(value));
  const channelId = row.channel_id == null ? null : Number(row.channel_id);
  return {
    id,
    t_ms: tMs,
    channel_id: Number.isSafeInteger(channelId) ? channelId : null,
    channel_name: asText(row.channel_name),
    model: asText(row.model_name),
    group_name: asText(row.group_name),
    status_code: parseStatusCode(row.content),
    message: truncateMessage(row.content),
    request_id: asText(row.request_id),
    recorded_at: recordedAt,
  };
}

function hasTable(db, name) {
  if (!db) return false;
  try {
    return Boolean(
      db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
    );
  } catch {
    return false;
  }
}

/** 读取水位；没有记录、非法值或缺表时返回 0 */
export function readWatermark(db) {
  if (!hasTable(db, 'schema_meta')) return 0;
  const row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(OFFSET_KEY);
  const n = Number.parseInt(String(row?.value ?? ''), 10);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/** 写回水位；值统一存字符串 */
export function writeWatermark(db, offset, now = Date.now()) {
  const value = Number.isSafeInteger(Number(offset)) && Number(offset) >= 0 ? Number(offset) : 0;
  db.prepare(
    `INSERT INTO schema_meta (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(OFFSET_KEY, String(value), now);
  return value;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * 执行一轮增量同步。源库不存在只打一行 warn 并返回 `{ missing: true }`，不抛错。
 * @returns {{missing?:boolean, scanned:number, inserted:number, skipped:number, offset:number, dryRun:boolean}}
 */
export function runCollectUpstreamErrors({
  relayDbFile = DEFAULT_RELAY_DB,
  dbFile = DEFAULT_DB_FILE,
  dryRun = false,
  now = Date.now,
  log = console.log,
  errorLog = console.error,
} = {}) {
  const source = path.resolve(relayDbFile);

  if (!fs.existsSync(source)) {
    errorLog(`[collect-upstream-errors] warn: 源库不存在，跳过本轮：${source}`);
    return { missing: true, scanned: 0, inserted: 0, skipped: 0, offset: 0, dryRun };
  }

  const recordedAt = typeof now === 'function' ? now() : now;
  let relay = null;
  let db = null;
  try {
    relay = new DatabaseSync(source, { readOnly: true });
    relay.exec('PRAGMA busy_timeout = 5000');

    // dry-run 不建库、不建表；只看已有库里的水位
    if (dryRun) {
      if (fs.existsSync(dbFile)) db = new DatabaseSync(dbFile, { readOnly: true });
    } else {
      db = openDashboardDb(dbFile);
    }

    let offset = readWatermark(db);
    const insertStmt = db && !dryRun
      ? db.prepare(
        `INSERT OR IGNORE INTO upstream_error
           (id, t_ms, channel_id, channel_name, model, group_name, status_code, message, request_id, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      : null;
    const existsStmt = db && dryRun && hasTable(db, 'upstream_error')
      ? db.prepare('SELECT 1 AS ok FROM upstream_error WHERE id = ?')
      : null;

    let scanned = 0;
    let inserted = 0;
    let skipped = 0;

    for (;;) {
      const rows = relay.prepare(SELECT_SQL).all(offset, BATCH_SIZE);
      if (rows.length === 0) break;

      const parsed = [];
      for (const row of rows) {
        const item = parseUpstreamErrorRow(row, recordedAt);
        if (item) parsed.push(item);
        else skipped += 1;
      }

      const lastId = Number(rows[rows.length - 1].id);
      if (!Number.isSafeInteger(lastId)) throw new Error('源库 logs.id 不是整数，无法推进水位');

      if (dryRun) {
        for (const item of parsed) {
          if (!existsStmt || !existsStmt.get(item.id)) inserted += 1;
        }
      } else if (db) {
        // 数据与水位同一事务：插入失败时水位不前移，下一轮会重读同一批
        db.exec('BEGIN IMMEDIATE');
        try {
          for (const item of parsed) {
            const result = insertStmt.run(
              item.id,
              item.t_ms,
              item.channel_id,
              item.channel_name,
              item.model,
              item.group_name,
              item.status_code,
              item.message,
              item.request_id,
              item.recorded_at,
            );
            inserted += Number(result?.changes ?? 0);
          }
          writeWatermark(db, lastId, recordedAt);
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
      }

      scanned += rows.length;
      offset = lastId;
      if (rows.length < BATCH_SIZE) break;
    }

    log(
      (dryRun ? '[collect-upstream-errors] dry-run：' : '[collect-upstream-errors] ') +
        `读取 ${scanned} 行 · 写入 ${inserted} 行` +
        (skipped > 0 ? ` · 跳过 ${skipped}` : '') +
        ` · offset→${offset}` +
        (dryRun ? '（dry-run 未落库、未写回）' : ''),
    );

    return { missing: false, scanned, inserted, skipped, offset, dryRun };
  } finally {
    db?.close();
    relay?.close();
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parsePath(raw, flag, arg = flag) {
  const value = String(raw ?? '').trim();
  if (!value) throw new UpstreamErrorsOptionsError(`${flag} 不能为空：${arg}`);
  return path.resolve(value);
}

/** 解析 CLI 参数；非法参数抛 UpstreamErrorsOptionsError。路径同时接受 `--x=<path>` 与 `--x <path>` */
export function parseArgs(argv = []) {
  const options = {
    help: false,
    relayDbFile: DEFAULT_RELAY_DB,
    dbFile: DEFAULT_DB_FILE,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--relay-db') {
      options.relayDbFile = parsePath(argv[++i], '--relay-db');
    } else if (arg.startsWith('--relay-db=')) {
      options.relayDbFile = parsePath(arg.slice('--relay-db='.length), '--relay-db', arg);
    } else if (arg === '--db') {
      options.dbFile = parsePath(argv[++i], '--db');
    } else if (arg.startsWith('--db=')) {
      options.dbFile = parsePath(arg.slice('--db='.length), '--db', arg);
    } else if (arg === '--config') {
      // 配置文件在 lib/instance.mjs 初始化时读取，这里只吞掉参数
      i += 1;
    } else if (arg.startsWith('--config=')) {
      // 同上
    } else throw new UpstreamErrorsOptionsError(`未知参数：${arg}`);
  }
  return options;
}

/** 返回退出码：0 成功或源库缺失，1 参数/执行错误 */
export function main(argv = [], { log = console.log, errorLog = console.error } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    errorLog(`[collect-upstream-errors] ${err?.message ?? err}`);
    errorLog(USAGE);
    return 1;
  }
  if (options.help) {
    log(USAGE);
    return 0;
  }
  try {
    runCollectUpstreamErrors({ ...options, log, errorLog });
    return 0;
  } catch (err) {
    errorLog(`[collect-upstream-errors] 失败：${err?.message ?? err}`);
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
