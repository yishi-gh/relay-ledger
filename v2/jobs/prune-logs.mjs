/**
 * prune-logs：日志库保留策略的执行任务（零依赖 CLI，同步执行）。
 *
 * 用法：
 *   node v2/jobs/prune-logs.mjs --dry-run          # 只统计：多少行会被清、多少 job_runs 会被删
 *   node v2/jobs/prune-logs.mjs                    # 清 7 天前的 raw_json、30 天前的 job_runs
 *   node v2/jobs/prune-logs.mjs --vacuum           # 清理后 VACUUM 回收磁盘（月度手动跑）
 *
 * 口径：
 *   - `logs` 明细行不删，只把超过保留期的 `raw_json` 清空（行数与明细字段全部保留）；
 *     原始响应体只用于排障回溯，清空不影响任何查询与聚合。
 *   - `logs.raw_json` 在现存站点库里声明为 NOT NULL，此时写空串 `''`——库里既有的
 *     `fp:` 行本来就用 `''` 表示「无原文」；列可空时写 NULL。两种值等价，
 *     读取层不依赖该列，判断条件用 `length(raw_json) > 0`，重复跑影响 0 行。
 *   - `job_runs` 只保留最近 `--jobs-days` 天；`started_at` 为空的旧记录不删（无法判断时间）。
 *   - `--vacuum` 在事务外执行，只回收站点库；看板库只有几百 KB，不处理。
 *   - 并发写入（SQLITE_BUSY / SQLITE_LOCKED）重试 3 次、退避 500ms 递增；最终仍失败则
 *     以退出码 1 报错。输出只含行数、体积、耗时，不含任何日志内容或凭据。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { DAY_MS } from '../lib/time.mjs';
import { INSTANCE } from '../lib/instance.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const V2_DIR = path.dirname(HERE);

export const SITE = INSTANCE.site.id;
/** 默认站点库：实例配置解析出的站点库 */
export const DEFAULT_DB_FILE = INSTANCE.paths.siteDbFile;
/** 看板库：与 server / collect-spend 同一个文件 */
export const DEFAULT_JOBS_DB_FILE = INSTANCE.paths.dashboardFile;

export const DEFAULT_RAW_DAYS = 7;
export const DEFAULT_JOBS_DAYS = 30;
/** SQLITE_BUSY 重试次数（不含首次尝试）与退避基数 */
export const BUSY_RETRIES = 3;
export const BUSY_BACKOFF_MS = 500;
/** 单条语句等待写锁的时长：正常采集的短事务在这个窗口内就结束，不必进重试 */
export const BUSY_TIMEOUT_MS = 5000;

export const USAGE = `用法：
  node v2/jobs/prune-logs.mjs [--db=<path>] [--raw-days=<n>] [--jobs-days=<n>] [--dry-run] [--vacuum] [--help]

  --db=<path>        站点库路径（默认取实例配置的站点库）
  --raw-days=<n>     保留 raw_json 的天数（默认 ${DEFAULT_RAW_DAYS}；0 = 全部清空）
  --jobs-days=<n>    保留 job_runs 的天数（默认 ${DEFAULT_JOBS_DAYS}；0 = 全部删除）
  --dry-run          只统计影响行数，不写库、不 VACUUM
  --vacuum           清理后在事务外 VACUUM 站点库（需要约一份库大小的空闲磁盘）
  --help             显示本说明

  看板库固定取实例配置的看板库（默认 <dataDir>/dashboard.db）；文件不存在或没有 job_runs 表时跳过该项（计 0 行）。
  logs.raw_json 为 NOT NULL 时写空串 ''，可空时写 NULL；两者都表示「无原始响应体」。`;

export class PruneOptionsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PruneOptionsError';
  }
}

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

function parseDays(arg, name) {
  const raw = arg.slice(name.length + 1);
  if (!/^\d+$/.test(raw)) throw new PruneOptionsError(`${name} 必须是非负整数：${arg}`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw new PruneOptionsError(`${name} 超出范围：${arg}`);
  return n;
}

function parsePath(arg, name) {
  const raw = arg.slice(name.length + 1).trim();
  if (!raw) throw new PruneOptionsError(`${name} 不能为空：${arg}`);
  return path.resolve(raw);
}

/** 解析 CLI 参数；非法参数抛 PruneOptionsError */
export function parseArgs(argv = []) {
  const options = {
    help: false,
    dbFile: DEFAULT_DB_FILE,
    jobsDbFile: DEFAULT_JOBS_DB_FILE,
    rawDays: DEFAULT_RAW_DAYS,
    jobsDays: DEFAULT_JOBS_DAYS,
    dryRun: false,
    vacuum: false,
  };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--vacuum') options.vacuum = true;
    else if (arg.startsWith('--db=')) options.dbFile = parsePath(arg, '--db');
    else if (arg.startsWith('--raw-days=')) options.rawDays = parseDays(arg, '--raw-days');
    else if (arg.startsWith('--jobs-days=')) options.jobsDays = parseDays(arg, '--jobs-days');
    else if (arg.startsWith('--config=')) {
      // 配置文件在 lib/instance.mjs 初始化时读取，这里只吞掉参数
    } else throw new PruneOptionsError(`未知参数：${arg}`);
  }
  return options;
}

// ---------------------------------------------------------------------------
// 并发重试
// ---------------------------------------------------------------------------

/** node:sqlite 的忙错误：errcode 5 = SQLITE_BUSY、6 = SQLITE_LOCKED，旧版只在 message 里体现 */
export function isBusyError(err) {
  const code = err?.errcode ?? err?.code;
  if (code === 5 || code === 6 || code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return true;
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/i.test(
    String(err?.message ?? ''),
  );
}

/** 同步等待：Node 主线程允许 Atomics.wait，避免为退避引入异步链路 */
function sleepSync(ms) {
  if (!(ms > 0)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 执行 fn；遇到忙错误最多重试 retries 次，退避 backoffMs × 第几次（500/1000/1500）。
 * 非忙错误立即抛出，不吞错。
 */
export function withBusyRetry(
  fn,
  { retries = BUSY_RETRIES, backoffMs = BUSY_BACKOFF_MS, sleep = sleepSync, onRetry = null } = {},
) {
  let attempt = 0;
  for (;;) {
    try {
      return fn();
    } catch (err) {
      if (!isBusyError(err) || attempt >= retries) throw err;
      attempt += 1;
      onRetry?.(attempt, err);
      sleep(backoffMs * attempt);
    }
  }
}

// ---------------------------------------------------------------------------
// 库操作
// ---------------------------------------------------------------------------

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all();
}

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

/** 打开站点库并确认可清理；不改表结构、不建索引 */
function openSiteDb(file, busyTimeoutMs) {
  if (!fs.existsSync(file)) throw new Error(`站点库不存在：${file}`);
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs)}`);
  if (!hasTable(db, 'logs')) {
    db.close();
    throw new Error(`站点库里没有 logs 表：${file}`);
  }
  return db;
}

/**
 * 清 raw_json 的 SQL。`raw_json <> ''` 是幂等条件：`fp:` 行的 raw_json 入库时就是空串，
 * 重复跑不会把它们再算成「清理了 N 行」。
 */
function rawJsonClearSql(columnNullable) {
  const blank = columnNullable ? 'NULL' : "''";
  return `UPDATE logs SET raw_json = ${blank}
           WHERE t_ms < ? AND raw_json IS NOT NULL AND raw_json <> ''`;
}

const RAW_JSON_PLAN_SQL = `SELECT COUNT(*) AS n, COALESCE(SUM(length(raw_json)), 0) AS b
                             FROM logs
                            WHERE t_ms < ? AND raw_json IS NOT NULL AND raw_json <> ''`;

function vacuumSiteDb(db, file, { retryBackoffMs, log }) {
  const before = fileSize(file);
  const startedAt = Date.now();
  // VACUUM 不能在事务里跑；先把 WAL 收回去，否则文件大小要等 checkpoint 才变
  withBusyRetry(() => db.exec('PRAGMA wal_checkpoint(TRUNCATE)'), {
    backoffMs: retryBackoffMs,
  });
  withBusyRetry(() => db.exec('VACUUM'), { backoffMs: retryBackoffMs });
  withBusyRetry(() => db.exec('PRAGMA wal_checkpoint(TRUNCATE)'), {
    backoffMs: retryBackoffMs,
  });
  const elapsedMs = Math.max(0, Date.now() - startedAt);
  const after = fileSize(file);
  log(`[prune-logs] vacuum ${elapsedMs}ms，站点库 ${mb(before)} MB → ${mb(after)} MB`);
  return { elapsedMs, sizeBefore: before, sizeAfter: after };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * 执行一次清理。dryRun 只统计；vacuum 在 dryRun 时忽略。
 * @returns {{rawRows:number, rawBytes:number, rawTarget:'NULL'|"''", jobRows:number,
 *            dryRun:boolean, elapsedMs:number, vacuum:object|null}}
 */
export function runPrune({
  dbFile = DEFAULT_DB_FILE,
  jobsDbFile = DEFAULT_JOBS_DB_FILE,
  rawDays = DEFAULT_RAW_DAYS,
  jobsDays = DEFAULT_JOBS_DAYS,
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
  const rawCutoff = nowMs - Number(rawDays) * DAY_MS;
  const jobsCutoff = nowMs - Number(jobsDays) * DAY_MS;
  const retry = {
    backoffMs: retryBackoffMs,
    onRetry: (attempt, err) =>
      errorLog(`[prune-logs] 数据库忙，第 ${attempt}/${BUSY_RETRIES} 次重试：${err?.message ?? err}`),
  };

  let rawRows = 0;
  let rawBytes = 0;
  let rawTarget = 'NULL';
  let vacuumResult = null;

  const site = openSiteDb(dbFile, busyTimeoutMs);
  try {
    const column = tableColumns(site, 'logs').find((c) => c.name === 'raw_json');
    if (!column) throw new Error('logs 表没有 raw_json 列');
    const nullable = Number(column.notnull) === 0;
    rawTarget = nullable ? 'NULL' : "''";

    const plan = site.prepare(RAW_JSON_PLAN_SQL).get(rawCutoff);
    rawRows = Number(plan?.n ?? 0);
    rawBytes = Number(plan?.b ?? 0);

    if (!dryRun && rawRows > 0) {
      const result = withBusyRetry(
        () => site.prepare(rawJsonClearSql(nullable)).run(rawCutoff),
        retry,
      );
      rawRows = Number(result.changes);
    }

    if (vacuum && !dryRun) {
      vacuumResult = vacuumSiteDb(site, dbFile, {
        retryBackoffMs,
        log,
      });
    }
  } finally {
    site.close();
  }

  // 看板库：不存在就跳过（不新建），只删有明确开始时间的旧记录
  let jobRows = 0;
  if (fs.existsSync(jobsDbFile)) {
    const jobs = new DatabaseSync(jobsDbFile);
    try {
      jobs.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs)}`);
      if (hasTable(jobs, 'job_runs')) {
        jobRows = Number(
          jobs.prepare('SELECT COUNT(*) AS n FROM job_runs WHERE started_at < ?').get(jobsCutoff).n,
        );
        if (!dryRun && jobRows > 0) {
          const result = withBusyRetry(
            () => jobs.prepare('DELETE FROM job_runs WHERE started_at < ?').run(jobsCutoff),
            retry,
          );
          jobRows = Number(result.changes);
        }
      }
    } finally {
      jobs.close();
    }
  }

  const elapsedMs = Math.max(0, Date.now() - startedAt);
  log(
    dryRun
      ? `[prune-logs] dry-run：raw_json 将清空 ${rawRows} 行（预计释放约 ${mb(rawBytes)} MB），` +
          `job_runs 将删除 ${jobRows} 行，耗时 ${elapsedMs} ms`
      : `[prune-logs] raw_json 清空 ${rawRows} 行（释放约 ${mb(rawBytes)} MB），` +
          `job_runs 删除 ${jobRows} 行，耗时 ${elapsedMs} ms`,
  );

  return { rawRows, rawBytes, rawTarget, jobRows, dryRun, elapsedMs, vacuum: vacuumResult };
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
    errorLog(`[prune-logs] ${err?.message ?? err}`);
    errorLog(USAGE);
    return 1;
  }
  if (options.help) {
    log(USAGE);
    return 0;
  }
  try {
    runPrune({ ...options, now, log, errorLog, busyTimeoutMs, retryBackoffMs });
    return 0;
  } catch (err) {
    errorLog(`[prune-logs] 失败：${err?.message ?? err}`);
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
