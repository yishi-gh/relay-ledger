/**
 * rollup-logs：明细保留 90 天，更早的按北京自然日聚合进看板库的 `logs_daily`。
 *
 * 用法：
 *   node v2/jobs/rollup-logs.mjs --dry-run          # 只统计：多少天、多少行会被归档/删除
 *   node v2/jobs/rollup-logs.mjs                    # 归档 90 天前的整天，并删除对应明细
 *   node v2/jobs/rollup-logs.mjs --keep-days=180    # 临时放宽保留期
 *   node v2/jobs/rollup-logs.mjs --vacuum           # 归档后 VACUUM 站点库（月度手动跑）
 *
 * 口径：
 *   - 只处理「北京日界早于 今天 − keep-days」且 `logs` 里还有行的天；今天永远不动。
 *   - 每天一个事务：先按 channel_id 覆盖式 UPSERT 进 `logs_daily`（可重复执行，结果不变），
 *     同一事务里删除该天 `logs` 的全部行（含 log_type != 2 的行）。站点库是主库，看板库以
 *     `archive` 附加，两者同事务提交，中途失败整天回滚，下次重跑从头再来。
 *   - 聚合过滤与 API 完全一致（直接复用 `LOCAL_FILTER`）：`log_type = 2` 且排除
 *     `token_name = 'Model test'`；`channel_id` 为空的行归到 0，避免主键非空丢数据。
 *   - `--dry-run` 不创建看板库、不写库、不删除，只统计。
 *   - SQLITE_BUSY / SQLITE_LOCKED 重试 3 次、退避 500/1000/1500ms，仍失败退出码 1。
 *     输出只含天数、行数与耗时，不含日志正文或凭据。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { LOCAL_FILTER } from '../lib/api.mjs';
import { INSTANCE } from '../lib/instance.mjs';
import { DAY_MS, TZ_OFFSET_MS, beijingDayStart } from '../lib/time.mjs';
import { openDashboardDb } from '../store/dashboard.mjs';
import {
  BUSY_BACKOFF_MS,
  BUSY_RETRIES,
  BUSY_TIMEOUT_MS,
  withBusyRetry,
} from './prune-logs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const V2_DIR = path.dirname(HERE);

export const SITE = INSTANCE.site.id;
/** 默认站点库：实例配置解析出的站点库 */
export const DEFAULT_DB_FILE = INSTANCE.paths.siteDbFile;
/** 归档表所在库：与 server / prune-logs 同一个看板库 */
export const DEFAULT_DASHBOARD_DB_FILE = INSTANCE.paths.dashboardFile;
export const DEFAULT_KEEP_DAYS = 90;

export const USAGE = `用法：
  node v2/jobs/rollup-logs.mjs [--db=<path>] [--dashboard-db=<path>] [--keep-days=<n>]
                              [--site=<name>] [--dry-run] [--vacuum] [--help]

  --db=<path>            站点库路径（默认取实例配置的站点库）
  --dashboard-db=<path>  看板库路径（默认 <dataDir>/dashboard.db，logs_daily 在这里）
  --keep-days=<n>        明细保留天数（默认 ${DEFAULT_KEEP_DAYS}；更早的整天归档后删除）
  --site=<name>          写入 logs_daily.site 的站点名（默认 ${SITE}）
  --dry-run              只统计将归档/删除的天数与行数，不建库、不写库、不删除
  --vacuum               归档后在事务外 VACUUM 站点库（需要约一份库大小的空闲磁盘）
  --help                 显示本说明

  归档口径与 API 一致：log_type = 2 且排除 token_name = 'Model test'；
  channel_id 为空的行归到渠道 0。归档按 (site, day, channel_id) 覆盖式重算，可重复执行。`;

export class RollupOptionsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RollupOptionsError';
  }
}

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

function parseDays(arg, name) {
  const raw = arg.slice(name.length + 1);
  if (!/^\d+$/.test(raw)) throw new RollupOptionsError(`${name} 必须是非负整数：${arg}`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw new RollupOptionsError(`${name} 超出范围：${arg}`);
  return n;
}

function parsePath(arg, name) {
  const raw = arg.slice(name.length + 1).trim();
  if (!raw) throw new RollupOptionsError(`${name} 不能为空：${arg}`);
  return path.resolve(raw);
}

function parseSite(arg) {
  const raw = arg.slice('--site='.length).trim();
  if (!raw) throw new RollupOptionsError(`--site 不能为空：${arg}`);
  return raw;
}

/** 解析 CLI 参数；非法参数抛 RollupOptionsError */
export function parseArgs(argv = []) {
  const options = {
    help: false,
    dbFile: DEFAULT_DB_FILE,
    dashboardDbFile: DEFAULT_DASHBOARD_DB_FILE,
    keepDays: DEFAULT_KEEP_DAYS,
    site: SITE,
    dryRun: false,
    vacuum: false,
  };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--vacuum') options.vacuum = true;
    else if (arg.startsWith('--db=')) options.dbFile = parsePath(arg, '--db');
    else if (arg.startsWith('--dashboard-db=')) {
      options.dashboardDbFile = parsePath(arg, '--dashboard-db');
    } else if (arg.startsWith('--keep-days=')) options.keepDays = parseDays(arg, '--keep-days');
    else if (arg.startsWith('--site=')) options.site = parseSite(arg);
    else if (arg.startsWith('--config=')) {
      // 配置文件在 lib/instance.mjs 初始化时读取，这里只吞掉参数
    } else throw new RollupOptionsError(`未知参数：${arg}`);
  }
  return options;
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/** 北京自然日的日界：`YYYY-MM-DD` → 当日 00:00 的毫秒时间戳 */
export function dayStartMs(day) {
  const [y, m, d] = String(day).split('-').map(Number);
  return Date.UTC(y, m - 1, d) - TZ_OFFSET_MS;
}

/** 还有明细、且整日早于保留期的天；按日升序 */
const DAYS_SQL = `
  SELECT strftime('%Y-%m-%d', t_ms / 1000, 'unixepoch', '+8 hours') AS day,
         COUNT(*) AS rows
    FROM logs
   WHERE t_ms < ?
   GROUP BY day
   ORDER BY day`;

/** 单日按渠道聚合的列（与 API 同口径） */
const AGGREGATE_COLUMNS = `COALESCE(channel_id, 0) AS channel_id,
         MAX(channel_name) AS channel_name,
         COUNT(*) AS requests,
         COALESCE(SUM(cost), 0) AS cost,
         COALESCE(SUM(quota_raw), 0) AS quota_raw,
         COALESCE(SUM(input_total), 0) AS input_total,
         COALESCE(SUM(output), 0) AS output`;

/** 覆盖式重算：同一 (site, day, channel_id) 重复跑结果不变 */
const ARCHIVE_UPSERT_SQL = `
  INSERT INTO archive.logs_daily
    (site, day, channel_id, channel_name, requests, cost, quota_raw, input_total, output, updated_at)
  SELECT ?, ?, ${AGGREGATE_COLUMNS}, ?
    FROM logs
   WHERE t_ms BETWEEN ? AND ? AND ${LOCAL_FILTER}
   GROUP BY COALESCE(channel_id, 0)
  ON CONFLICT(site, day, channel_id) DO UPDATE SET
    channel_name = excluded.channel_name,
    requests = excluded.requests,
    cost = excluded.cost,
    quota_raw = excluded.quota_raw,
    input_total = excluded.input_total,
    output = excluded.output,
    updated_at = excluded.updated_at`;

const COUNT_GROUPS_SQL = `
  SELECT COUNT(*) AS n FROM (
    SELECT 1 AS x
      FROM logs
     WHERE t_ms BETWEEN ? AND ? AND ${LOCAL_FILTER}
     GROUP BY COALESCE(channel_id, 0)
  )`;

const DELETE_DAY_SQL = 'DELETE FROM logs WHERE t_ms BETWEEN ? AND ?';

// ---------------------------------------------------------------------------
// 库操作
// ---------------------------------------------------------------------------

function hasTable(db, table) {
  return Boolean(
    db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
  );
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function mb(bytes) {
  return (Number(bytes) / (1024 * 1024)).toFixed(1);
}

/** 打开站点库；只读表结构，不改表、不建索引 */
function openSiteDb(file, busyTimeoutMs) {
  if (!fs.existsSync(file)) throw new Error(`站点库不存在：${file}`);
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs)}`);
    if (!hasTable(db, 'logs')) throw new Error(`站点库里没有 logs 表：${file}`);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

function vacuumSiteDb(db, file, { retryBackoffMs, log }) {
  const before = fileSize(file);
  const startedAt = Date.now();
  // VACUUM 不能在事务里跑；先把 WAL 收回去，否则文件大小要等 checkpoint 才变
  withBusyRetry(() => db.exec('PRAGMA wal_checkpoint(TRUNCATE)'), { backoffMs: retryBackoffMs });
  withBusyRetry(() => db.exec('VACUUM'), { backoffMs: retryBackoffMs });
  withBusyRetry(() => db.exec('PRAGMA wal_checkpoint(TRUNCATE)'), { backoffMs: retryBackoffMs });
  const elapsedMs = Math.max(0, Date.now() - startedAt);
  const after = fileSize(file);
  log(`[rollup-logs] vacuum ${elapsedMs}ms，站点库 ${mb(before)} MB → ${mb(after)} MB`);
  return { elapsedMs, sizeBefore: before, sizeAfter: after };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * 归档一个北京自然日：聚合 UPSERT + 删除明细，同一事务。
 * @returns {{archived:number, deleted:number}}
 */
function archiveDay(db, { site, day, fromMs, toMs, updatedAt, retry }) {
  return withBusyRetry(
    () => {
      db.exec('BEGIN IMMEDIATE');
      let committed = false;
      try {
        const archived = Number(
          db.prepare(ARCHIVE_UPSERT_SQL).run(site, day, updatedAt, fromMs, toMs).changes,
        );
        const deleted = Number(db.prepare(DELETE_DAY_SQL).run(fromMs, toMs).changes);
        db.exec('COMMIT');
        committed = true;
        return { archived, deleted };
      } catch (err) {
        if (!committed) {
          try {
            db.exec('ROLLBACK');
          } catch {
            // 事务可能已被 SQLite 自动回滚，原始错误更重要
          }
        }
        throw err;
      }
    },
    retry,
  );
}

/**
 * 执行一次归档。dryRun 只统计，不建库、不写库、不删除；vacuum 在 dryRun 时忽略。
 * @returns {{days:number, archivedRows:number, deletedRows:number, dryRun:boolean,
 *            elapsedMs:number, vacuum:object|null}}
 */
export function runRollup({
  dbFile = DEFAULT_DB_FILE,
  dashboardDbFile = DEFAULT_DASHBOARD_DB_FILE,
  keepDays = DEFAULT_KEEP_DAYS,
  site = SITE,
  dryRun = false,
  vacuum = false,
  now = Date.now,
  log = console.log,
  errorLog = console.error,
  busyTimeoutMs = BUSY_TIMEOUT_MS,
  retryBackoffMs = BUSY_BACKOFF_MS,
} = {}) {
  const startedAt = Date.now();
  const nowMs = typeof now === 'function' ? now() : Number(now);
  if (!Number.isInteger(Number(keepDays)) || Number(keepDays) < 0) {
    throw new RangeError(`keepDays 必须是非负整数：${keepDays}`);
  }
  // 早于这一天 00:00 的整天才归档：day < 今天 − keepDays
  const cutoffStart = beijingDayStart(nowMs) - Number(keepDays) * DAY_MS;
  const retry = {
    backoffMs: retryBackoffMs,
    onRetry: (attempt, err) =>
      errorLog(`[rollup-logs] 数据库忙，第 ${attempt}/${BUSY_RETRIES} 次重试：${err?.message ?? err}`),
  };

  // dry-run 不落盘：看板库不存在时也不创建
  const db = openSiteDb(dbFile, busyTimeoutMs);
  let attached = false;
  let vacuumResult = null;
  let days = 0;
  let archivedRows = 0;
  let deletedRows = 0;

  try {
    if (!dryRun) {
      // 先让 schema 模块建好看板库与 logs_daily，再附加；dry-run 连文件都不创建
      const bootstrap = openDashboardDb(dashboardDbFile);
      bootstrap.close();
      db.prepare('ATTACH DATABASE ? AS archive').run(dashboardDbFile);
      attached = true;
    }

    const targets = db.prepare(DAYS_SQL).all(cutoffStart);
    for (const row of targets) {
      const day = String(row.day);
      const fromMs = dayStartMs(day);
      const toMs = fromMs + DAY_MS - 1;
      if (dryRun) {
        // 归档行数按「渠道×日」计，删除行数是该天全部明细行
        archivedRows += Number(db.prepare(COUNT_GROUPS_SQL).get(fromMs, toMs)?.n ?? 0);
        deletedRows += Number(row.rows ?? 0);
        days += 1;
        continue;
      }
      const result = archiveDay(db, { site, day, fromMs, toMs, updatedAt: nowMs, retry });
      archivedRows += result.archived;
      deletedRows += result.deleted;
      days += 1;
    }

    if (vacuum && !dryRun) {
      if (attached) {
        db.exec('DETACH DATABASE archive');
        attached = false;
      }
      vacuumResult = vacuumSiteDb(db, dbFile, { retryBackoffMs, log });
    }
  } finally {
    if (attached) {
      try {
        db.exec('DETACH DATABASE archive');
      } catch {
        // 连接即将关闭，附加库会随之释放
      }
    }
    db.close();
  }

  const elapsedMs = Math.max(0, Date.now() - startedAt);
  log(
    dryRun
      ? `[rollup-logs] dry-run：将归档 ${days} 天 / ${archivedRows} 行（渠道×日），` +
          `将删除明细 ${deletedRows} 行，耗时 ${elapsedMs} ms`
      : `[rollup-logs] 归档 ${days} 天 / ${archivedRows} 行（渠道×日），` +
          `删除明细 ${deletedRows} 行，耗时 ${elapsedMs} ms`,
  );

  return { days, archivedRows, deletedRows, dryRun, elapsedMs, vacuum: vacuumResult };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** 返回退出码：0 成功、1 参数/执行错误 */
export function main(
  argv = [],
  { log = console.log, errorLog = console.error, now = Date.now, busyTimeoutMs, retryBackoffMs } = {},
) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    errorLog(`[rollup-logs] ${err?.message ?? err}`);
    errorLog(USAGE);
    return 1;
  }
  if (options.help) {
    log(USAGE);
    return 0;
  }
  try {
    runRollup({ ...options, now, log, errorLog, busyTimeoutMs, retryBackoffMs });
    return 0;
  } catch (err) {
    errorLog(`[rollup-logs] 失败：${err?.message ?? err}`);
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
