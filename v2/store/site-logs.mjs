/**
 * 站点日志库 `db/sites/<site>.db` 的 `logs` 表读写原语。
 *
 * - 表结构以现有库为准（37 列，`req_id` 为主键）；这里只读不建、不补列、不 DROP。
 * - 去重键与 v1 `tools/lib/db/ingest.mjs` 一致：`req_id` 主键；无请求 ID 的行用
 *   `fp:<ck>`（内容指纹）兜底。带请求 ID 的行入库后，若库里已有同指纹的 `fp:` 行则删掉它，
 *   避免同一笔消费因来源不同留两行。
 * - `LOGS_SCHEMA` 只是现有表结构的快照，供测试建临时库使用，正式路径不会执行它。
 */

import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/** 现有 `logs` 表的列（顺序即插入顺序） */
export const LOGS_COLUMNS = [
  'req_id',
  'ck',
  'site',
  'source_kind',
  'input_format',
  't_ms',
  't_local',
  'user_name',
  'token_name',
  'group_name',
  'channel_id',
  'channel_name',
  'model',
  'endpoint',
  'is_stream',
  'reasoning_effort',
  'ip',
  'input_total',
  'input_uncached',
  'cache_read',
  'cache_write',
  'output',
  'token_semantic',
  'cost',
  'cost_original',
  'rate_multiplier',
  'billing_mode',
  'currency',
  'quota_raw',
  'latency_ms',
  'first_token_ms',
  'log_type',
  'content',
  'src_file',
  'src_mtime',
  'ingested_at',
  'raw_json',
];

/** 现有表结构快照（37 列），只用于测试建临时库 */
export const LOGS_SCHEMA = `CREATE TABLE logs (
  req_id           TEXT PRIMARY KEY,
  ck               TEXT,
  site             TEXT NOT NULL,
  source_kind      TEXT NOT NULL,
  input_format     TEXT NOT NULL,
  t_ms             INTEGER NOT NULL,
  t_local          TEXT NOT NULL,
  user_name        TEXT,
  token_name       TEXT,
  group_name       TEXT,
  channel_id       INTEGER,
  channel_name     TEXT,
  model            TEXT,
  endpoint         TEXT,
  is_stream        INTEGER,
  reasoning_effort TEXT,
  ip               TEXT,
  input_total      INTEGER,
  input_uncached   INTEGER,
  cache_read       INTEGER,
  cache_write      INTEGER,
  output           INTEGER,
  token_semantic   TEXT,
  cost             REAL,
  cost_original    REAL,
  rate_multiplier  REAL,
  billing_mode     TEXT,
  currency         TEXT DEFAULT 'USD',
  quota_raw        INTEGER,
  latency_ms       INTEGER,
  first_token_ms   INTEGER,
  log_type         INTEGER,
  content          TEXT,
  src_file         TEXT,
  src_mtime        INTEGER,
  ingested_at      INTEGER,
  raw_json         TEXT NOT NULL
)`;

/**
 * 看板聚合用的覆盖索引。堆表每行约 3.2 KB（raw_json 占一半），7 天区间的聚合
 * 若走表扫描，冷缓存下在 7 MB/s 的磁盘上要上百秒；改成 index-only scan 后
 * 冷启 /api/profit 约 0.1 s、/api/overview 约 3 s。索引只加不改表结构。
 *
 * `idx_logs_channels` 供 /api/channels 的三条聚合共用（`v2/lib/api.mjs` 的
 * channels()）：渠道汇总、渠道×模型（top_model）、渠道延迟分位数。三条都只要
 * t_ms/log_type/token_name 做过滤，读 channel_id、cost、quota_raw、input_total、
 * output、cache_read、input_uncached、latency_ms、channel_name、model，
 * 全在这一个索引里，没有回表；GROUP BY / ORDER BY 仍走临时 B 树，只碰内存。
 * 故意不含 group_name：它在旧的站点库里可能不存在（见 api.mjs 的 hasGroupName），
 * 加进索引会让 openLogsDb 在那种库上直接报错。
 */
const AGG_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_logs_agg
     ON logs(t_ms, log_type, token_name, channel_id, cost, channel_name)`,
  `CREATE INDEX IF NOT EXISTS idx_logs_overview
     ON logs(t_ms, log_type, token_name, cost, quota_raw, input_total,
              input_uncached, cache_read, cache_write, output, latency_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_logs_channels
     ON logs(t_ms, log_type, token_name, channel_id, cost, quota_raw,
              input_total, output, cache_read, input_uncached, latency_ms,
              channel_name, model)`,
];

export function ensureAggIndexes(db) {
  for (const sql of AGG_INDEXES) db.exec(sql);
}

/**
 * 打开站点库。库文件不存在或没有 `logs` 表时直接报错，不建库、不改表。
 * 写入模式下顺带补齐聚合覆盖索引（IF NOT EXISTS，已存在时无开销）。
 * @param {string} file
 * @param {{readOnly?: boolean}} [options]
 */
export function openLogsDb(file, { readOnly = false } = {}) {
  if (!fs.existsSync(file)) throw new Error(`站点库不存在：${file}`);
  const db = new DatabaseSync(file, readOnly ? { readOnly: true } : {});
  try {
    db.exec('PRAGMA busy_timeout = 3000');
    const table = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'logs'").get();
    if (!table) throw new Error(`站点库里没有 logs 表：${file}`);
    if (!readOnly) ensureAggIndexes(db);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

/** 库里最后一条日志的时间（毫秒），空库返回 null */
export function readLastLogTime(db) {
  const row = db.prepare('SELECT MAX(t_ms) AS t FROM logs').get();
  const t = row?.t;
  return typeof t === 'number' && Number.isFinite(t) ? t : t == null ? null : Number(t);
}

/** `logs` 总行数 */
export function countLogs(db) {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM logs').get().n);
}

/** 给定 req_id 里已存在的数量（dry-run 统计「会跳过多少行」用） */
export function countExistingLogs(db, reqIds) {
  const ids = [...new Set((reqIds ?? []).map((v) => String(v ?? '')).filter(Boolean))];
  if (ids.length === 0) return 0;
  const stmt = db.prepare('SELECT 1 AS ok FROM logs WHERE req_id = ?');
  let found = 0;
  for (const id of ids) if (stmt.get(id)) found++;
  return found;
}

function insertSql() {
  const cols = LOGS_COLUMNS.join(', ');
  const marks = LOGS_COLUMNS.map(() => '?').join(', ');
  return `INSERT INTO logs (${cols}) VALUES (${marks}) ON CONFLICT(req_id) DO NOTHING`;
}

/**
 * 幂等写入一批行（同一批跑两次，第二次插入 0）。
 *
 * @returns {{inserted: number, replaced: number, skipped: number}}
 *   inserted = 成功 INSERT 的行数（含替换指纹行的行）；replaced = 其中替换掉旧 `fp:` 行的行数；
 *   skipped  = 因 req_id 已存在而跳过的行数。净新增行数 = inserted - replaced。
 */
export function insertLogs(db, rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return { inserted: 0, replaced: 0, skipped: 0 };

  const ins = db.prepare(insertSql());
  const delFp = db.prepare('DELETE FROM logs WHERE req_id = ?');
  let inserted = 0;
  let replaced = 0;
  let skipped = 0;

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of list) {
      const values = LOGS_COLUMNS.map((c) => (row[c] === undefined ? null : row[c]));
      const changes = Number(ins.run(...values).changes);
      if (changes === 0) {
        skipped++;
        continue;
      }
      inserted++;
      const reqId = String(row.req_id ?? '');
      const ck = row.ck == null ? '' : String(row.ck);
      // 带请求 ID 的行取代先落库的同内容指纹行（v1 ingest 的同一行为）
      if (ck && reqId && !reqId.startsWith('fp:')) {
        const removed = Number(delFp.run(`fp:${ck}`).changes);
        if (removed > 0) replaced++;
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { inserted, replaced, skipped };
}
