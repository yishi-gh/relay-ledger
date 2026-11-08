/**
 * 常驻采集入口：把 collect-spend 与 collect-site-logs 挂到进程内的定时器上。
 *
 * 用法：
 *   node v2/jobs/run-scheduler.mjs                 # 常驻：余额整点 +10s 起，之后每小时
 *   node v2/jobs/run-scheduler.mjs --once          # 各跑一次后退出（首次验证 / cron）
 *   node v2/jobs/run-scheduler.mjs --no-logs       # 只采余额
 *   node v2/jobs/run-scheduler.mjs --spend-interval-ms=1800000
 *   node v2/jobs/run-scheduler.mjs --no-prune      # 不跑每日日志清理
 *
 * 定时链、防重入、退出处理都在本文件，timer 不 unref，进程靠定时器存活。
 * 首轮对齐的是「采集间隔网格 + 偏移」，不是下一个整点，重启不会造成长时间盲窗。
 *
 * 约束：
 *   - 同一任务不重入：上一轮没结束时跳过本轮，只打一行日志，不写 job_runs
 *   - 任务异常只打一行 stderr，不影响另一个任务，也不退出进程
 *   - 输出只含任务名、状态、耗时与脱敏后的错误信息；不含凭据、不含日志原文
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, resolveConfigFile } from '../lib/config.mjs';
import { ensureDataDirs, INSTANCE } from '../lib/instance.mjs';
import { openDashboardDb, syncAccounts } from '../store/dashboard.mjs';
import { openLogsDb } from '../store/site-logs.mjs';
import { runCollectSpend } from './collect-spend.mjs';
import { DEFAULT_JOBS_DAYS, DEFAULT_RAW_DAYS, runPrune } from './prune-logs.mjs';
import { DEFAULT_KEEP_DAYS, runRollup } from './rollup-logs.mjs';
import {
  DEFAULT_DB_FILE,
  JOB_NAME as SITE_LOGS_JOB_NAME,
  SITE_DB_FILE,
  TOKEN_FILE,
  readPat,
  runCollectSiteLogs,
} from './collect-site-logs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const V2_DIR = path.dirname(HERE);

export const TASK_SPEND = 'collect-spend';
export const TASK_LOGS = SITE_LOGS_JOB_NAME;
/** 与 prune-logs 的定时链日志名对齐：输出 `[run-scheduler] prune ok Xms` */
export const TASK_PRUNE = 'prune';
/** 归档任务（rollup-logs）：把超过保留期的明细按天聚合进 logs_daily 后删除。 */
export const TASK_ROLLUP = 'rollup';

/** 余额采集间隔：默认取实例配置，15 分钟 */
export const DEFAULT_SPEND_INTERVAL_MS = INSTANCE.collect.spendIntervalMs;
/** 站点日志采集间隔：默认取实例配置，15 分钟。售出按小时入账，采集慢于整点会让最近几个小时的利润失真 */
export const DEFAULT_LOGS_INTERVAL_MS = INSTANCE.collect.logsIntervalMs;
/**
 * 站点日志在整点后多久开始：余额采集是「整点 + 10 秒」、单轮约 30 秒，
 * 等它落库后再拉日志，这样整点刷新的面板能同时看到成本与完整售出。
 */
export const LOGS_ALIGN_MS = 35 * 1000;
/** 日志清理首轮延迟：启动 10 分钟后（避开采集高峰），之后每 24 小时 */
export const PRUNE_INITIAL_DELAY_MS = 10 * 60 * 1000;
export const DEFAULT_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** 归档排在清理之后，避开同一个时间窗抢写锁。 */
export const ROLLUP_INITIAL_DELAY_MS = PRUNE_INITIAL_DELAY_MS + 5 * 60 * 1000;
export const DEFAULT_ROLLUP_INTERVAL_MS = DEFAULT_PRUNE_INTERVAL_MS;
/** setTimeout 的毫秒上限（超过会被 Node 截断成 1ms） */
const MAX_INTERVAL_MS = 2_147_483_647;

export const USAGE = `用法：
  node v2/jobs/run-scheduler.mjs [--once] [--spend-interval-ms=<n>] [--logs-interval-ms=<n>] [--no-logs]
                                 [--prune-days-raw=<n>] [--prune-days-jobs=<n>] [--no-prune] [--help]

  --once                     立即各跑一次（collect-spend、collect-site-logs）后退出，退出码 0/1
  --spend-interval-ms=<n>    余额采集间隔毫秒（默认 ${DEFAULT_SPEND_INTERVAL_MS}，取自实例配置）
  --logs-interval-ms=<n>     站点日志采集间隔毫秒（默认 ${DEFAULT_LOGS_INTERVAL_MS}，取自实例配置）
  --no-logs                  不采集站点日志
  --prune-days-raw=<n>       raw_json 保留天数（默认 ${DEFAULT_RAW_DAYS}）
  --prune-days-jobs=<n>      job_runs 保留天数（默认 ${DEFAULT_JOBS_DAYS}）
  --no-prune                 不跑每日日志清理
  --help                     显示本说明

  常驻时：余额首轮对齐「下一个采集间隔槽位 + 10 秒」，站点日志对齐「下一个间隔槽位 + 45 秒」，
  之后按各自间隔循环；日志清理首轮在 ${PRUNE_INITIAL_DELAY_MS}ms 后（每天一次）。--once 不跑清理，
  手动清理用 node v2/jobs/prune-logs.mjs。
  SIGINT / SIGTERM 会清掉定时器并正常退出。`;

export class OptionsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OptionsError';
  }
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

/** 余额采集落在整点后 10 秒：避开边界抖动，又落在 5 分钟快照容差内 */
export const SPEND_ALIGN_MS = 10 * 1000;

/**
 * 首轮对齐到「采集间隔网格」上的下一个槽位，而不是下一个整点。
 * 按整点对齐时，一次重启就要等到下个整点，15 分钟的间隔里最多会丢 45 分钟的数据。
 */
export function nextSlotDelayMs(
  nowMs = Date.now(),
  intervalMs = 15 * 60 * 1000,
  offsetMs = SPEND_ALIGN_MS,
  minMs = 1000,
) {
  const iv = Number(intervalMs) > 0 ? Number(intervalMs) : 15 * 60 * 1000;
  const off = Number.isFinite(Number(offsetMs)) ? Number(offsetMs) : 0;
  const now = Number(nowMs);
  const min = Number.isFinite(Number(minMs)) ? Number(minMs) : 1000;
  let next = Math.floor((now - off) / iv) * iv + off;
  while (next - now < min) next += iv;
  return next - now;
}

/** 余额采集首轮延迟：对齐「间隔网格 + 10 秒」 */
export function computeInitialDelayMs(nowMs = Date.now(), intervalMs = 15 * 60 * 1000) {
  return nextSlotDelayMs(nowMs, intervalMs, SPEND_ALIGN_MS);
}

/** 是否该跑：运行中直接跳过；`dueAtMs` 用于到期判断（常驻模式由 timer 负责，默认立即到期） */
export function shouldRunNow({ running = false, nowMs = 0, dueAtMs = 0 } = {}) {
  if (running) return { run: false, reason: 'already_running' };
  if (Number(nowMs) < Number(dueAtMs)) return { run: false, reason: 'not_due' };
  return { run: true, reason: 'due' };
}

function parseInterval(arg, name) {
  const raw = arg.slice(name.length + 1);
  if (!/^\d+$/.test(raw)) throw new OptionsError(`${name} 必须是正整数：${arg}`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) throw new OptionsError(`${name} 必须是正整数：${arg}`);
  if (n > MAX_INTERVAL_MS) throw new OptionsError(`${name} 不能超过 ${MAX_INTERVAL_MS}：${arg}`);
  return n;
}

/** 解析 CLI 参数；非法参数抛 OptionsError（由 CLI 转成一行错误 + 退出码 1） */
export function resolveOptions(argv = []) {
  const options = {
    once: false,
    noLogs: false,
    help: false,
    spendIntervalMs: DEFAULT_SPEND_INTERVAL_MS,
    logsIntervalMs: DEFAULT_LOGS_INTERVAL_MS,
  };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--once') options.once = true;
    else if (arg === '--no-logs') options.noLogs = true;
    else if (arg.startsWith('--spend-interval-ms=')) {
      options.spendIntervalMs = parseInterval(arg, '--spend-interval-ms');
    } else if (arg.startsWith('--logs-interval-ms=')) {
      options.logsIntervalMs = parseInterval(arg, '--logs-interval-ms');
    } else if (arg.startsWith('--config=')) {
      // 配置文件在 lib/instance.mjs 初始化时读取，这里只吞掉参数
    } else throw new OptionsError(`未知参数：${arg}`);
  }
  return options;
}

/** 天数参数：非负整数（0 表示全部清理） */
function parseDayCount(arg, name) {
  const raw = arg.slice(name.length + 1);
  if (!/^\d+$/.test(raw)) throw new OptionsError(`${name} 必须是非负整数：${arg}`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw new OptionsError(`${name} 超出范围：${arg}`);
  return n;
}

/**
 * 先摘出清理相关参数再交给 resolveOptions：保持 resolveOptions 的返回形状不变
 * （现有调用与测试依赖它只有采集相关的字段）。
 */
export function splitPruneArgs(argv = []) {
  const prune = {
    enabled: true,
    daysRaw: DEFAULT_RAW_DAYS,
    daysJobs: DEFAULT_JOBS_DAYS,
  };
  const rest = [];
  for (const arg of argv) {
    if (arg === '--no-prune') prune.enabled = false;
    else if (arg.startsWith('--prune-days-raw=')) {
      prune.daysRaw = parseDayCount(arg, '--prune-days-raw');
    } else if (arg.startsWith('--prune-days-jobs=')) {
      prune.daysJobs = parseDayCount(arg, '--prune-days-jobs');
    } else rest.push(arg);
  }
  return { prune, rest };
}

/** 错误信息脱敏 + 截断：凭据类字段一律替换，绝不透出原文 */
export function redactMessage(value) {
  return String(value ?? '')
    .replace(/sk-[A-Za-z0-9_-]{8,}/gi, 'sk-***')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '***')
    .replace(/\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***')
    .replace(/(cookie|authorization|refresh_token|token|pat)\s*[=:]\s*\S+/gi, '$1=***')
    .slice(0, 300);
}

/** --once 要跑的任务；--no-logs 只跑余额 */
export function pickTasks({ options, tasks }) {
  const list = [{ name: TASK_SPEND, run: tasks.spend }];
  if (!options.noLogs) list.push({ name: TASK_LOGS, run: tasks.logs });
  return list;
}

// ---------------------------------------------------------------------------
// 防重入 + 计时
// ---------------------------------------------------------------------------

/**
 * 包一层单飞与计时：execute 永不 reject，异常只走 errorLog。
 * @param {{ name: string, run: Function, now?: Function, log?: Function, errorLog?: Function, redact?: Function }} options
 */
export function createTaskRunner({
  name,
  run,
  now = Date.now,
  log = console.log,
  errorLog = console.error,
  redact = redactMessage,
} = {}) {
  if (typeof run !== 'function') throw new Error('run 必须是函数');
  let running = false;

  return {
    name,
    get running() {
      return running;
    },
    async execute() {
      const decision = shouldRunNow({ running });
      if (!decision.run) {
        log(`[run-scheduler] ${name} skipped ${decision.reason}`);
        return { ran: false, skipped: true, reason: decision.reason };
      }
      running = true;
      const startedAt = now();
      try {
        const result = await run();
        const elapsedMs = Math.max(0, now() - startedAt);
        const status = typeof result?.status === 'string' && result.status ? result.status : 'ok';
        log(`[run-scheduler] ${name} ${status} ${elapsedMs}ms`);
        return { ran: true, status, elapsedMs };
      } catch (err) {
        const elapsedMs = Math.max(0, now() - startedAt);
        errorLog(`[run-scheduler] ${name} failed ${elapsedMs}ms: ${redact(err?.message ?? err)}`);
        return { ran: true, failed: true, elapsedMs };
      } finally {
        running = false;
      }
    },
  };
}

/** --once：按顺序各跑一次，汇总是否失败（不抛出） */
export async function runOnce({
  tasks,
  now = Date.now,
  log = console.log,
  errorLog = console.error,
  redact = redactMessage,
} = {}) {
  const results = [];
  let failed = 0;
  for (const { name, run } of tasks) {
    const runner = createTaskRunner({ name, run, now, log, errorLog, redact });
    const result = await runner.execute();
    if (result.failed) failed += 1;
    results.push({ name, ...result });
  }
  return { failed, results };
}

const realTimer = { setTimeout, clearTimeout, setInterval, clearInterval };

/**
 * 一条「首轮延迟 + 固定间隔」的定时链。timer 可注入，测试不必真等。
 * 不调用 unref：常驻模式下进程由它保持存活。
 *
 * 传 nextDelayMs 时改为「每轮结束后重算下一次延迟」的自校正链：setInterval 的相位
 * 一旦被主机挂起（VM 冻结/迁移）或系统时钟跳变打断，就永远回不到整点网格上，
 * 快照会一直偏离桶边界。自校正版本每轮按墙钟重算下一个槽位，最多丢一轮。
 */
export function createLoop({ delayMs, intervalMs, task, timer = realTimer, nextDelayMs = null } = {}) {
  let timeout = null;
  let interval = null;
  let stopped = false;

  const chain = (delay) => {
    if (stopped) return;
    timeout = timer.setTimeout(async () => {
      timeout = null;
      try {
        await task.execute();
      } finally {
        if (stopped) return;
        const next = Number(nextDelayMs());
        chain(Number.isFinite(next) && next >= 1000 ? next : intervalMs);
      }
    }, delay);
  };

  return {
    start() {
      if (timeout !== null || interval !== null) return this;
      stopped = false;
      if (typeof nextDelayMs === 'function') {
        chain(delayMs);
        return this;
      }
      timeout = timer.setTimeout(() => {
        timeout = null;
        void task.execute();
        interval = timer.setInterval(() => {
          void task.execute();
        }, intervalMs);
      }, delayMs);
      return this;
    },
    stop() {
      stopped = true;
      if (timeout !== null) {
        timer.clearTimeout(timeout);
        timeout = null;
      }
      if (interval !== null) {
        timer.clearInterval(interval);
        interval = null;
      }
      return this;
    },
    get scheduled() {
      return timeout !== null || interval !== null;
    },
  };
}

// ---------------------------------------------------------------------------
// 默认任务：每轮重新读配置、开关库，凭据换签写回后下一轮立即生效
// ---------------------------------------------------------------------------

async function runSpendRound({ v2Dir = V2_DIR } = {}) {
  const { file, writable } = resolveConfigFile(v2Dir);
  const config = loadConfig(file, { writable });
  ensureDataDirs(INSTANCE);
  const db = openDashboardDb(INSTANCE.paths.dashboardFile);
  try {
    syncAccounts(db, config.accounts.filter((a) => a.enabled));
    return await runCollectSpend({ config, db });
  } finally {
    db.close();
  }
}

/** 站点日志采集的 job_runs 记录：只写计数与时间范围，不含 PAT、不含日志原文 */
function recordLogsJob(db, { startedAt, finishedAt, status, detail }) {
  db.prepare(
    `INSERT INTO job_runs (job, started_at, finished_at, status, detail)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(TASK_LOGS, startedAt, finishedAt, status, JSON.stringify(detail));
}

async function runLogsRound() {
  const startedAt = Date.now();
  let jobDb = null;
  let db = null;
  try {
    ensureDataDirs(INSTANCE);
    jobDb = openDashboardDb(INSTANCE.paths.dashboardFile);
    // 直读源不需要 PAT：没有令牌文件时留空（与 CLI 一致），回退 HTTP 时再报「缺少管理员 PAT」
    let pat = null;
    try {
      pat = readPat(TOKEN_FILE);
    } catch {
      pat = null;
    }
    db = openLogsDb(SITE_DB_FILE);
    const summary = await runCollectSiteLogs({ db, pat, source: 'db', dbFile: DEFAULT_DB_FILE });
    recordLogsJob(jobDb, {
      startedAt,
      finishedAt: Date.now(),
      status: 'ok',
      detail: {
        transport: summary.transport,
        chunks: summary.chunks,
        pages: summary.pages,
        rows: summary.rows,
        inserted: summary.inserted,
        skipped: summary.skipped,
        since_ms: summary.sinceMs,
        until_ms: summary.untilMs,
      },
    });
    return summary;
  } catch (err) {
    if (jobDb) {
      recordLogsJob(jobDb, {
        startedAt,
        finishedAt: Date.now(),
        status: 'error',
        detail: { message: redactMessage(err?.message ?? err) },
      });
    }
    throw err;
  } finally {
    db?.close();
    jobDb?.close();
  }
}

export function createDefaultTasks({
  v2Dir = V2_DIR,
  pruneDaysRaw = DEFAULT_RAW_DAYS,
  pruneDaysJobs = DEFAULT_JOBS_DAYS,
} = {}) {
  return {
    spend: () => runSpendRound({ v2Dir }),
    logs: () => runLogsRound(),
    // 清理自己会打一行汇总；常驻日志只保留 [run-scheduler] prune ok Xms
    prune: () =>
      runPrune({
        dbFile: SITE_DB_FILE,
        jobsDbFile: INSTANCE.paths.dashboardFile,
        rawDays: pruneDaysRaw,
        jobsDays: pruneDaysJobs,
        log: () => {},
      }),
    // 90 天以前的明细聚合成「站点×日×渠道」后删除，避免日志表无限增长
    rollup: () =>
      runRollup({
        dbFile: SITE_DB_FILE,
        dashboardDbFile: INSTANCE.paths.dashboardFile,
        keepDays: DEFAULT_KEEP_DAYS,
        log: () => {},
      }),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(argv, { tasks, now = Date.now, log = console.log, errorLog = console.error } = {}) {
  let options;
  let prune;
  try {
    const split = splitPruneArgs(argv);
    prune = split.prune;
    options = resolveOptions(split.rest);
  } catch (err) {
    errorLog(`[run-scheduler] ${redactMessage(err?.message ?? err)}`);
    errorLog(USAGE);
    return 1;
  }
  if (options.help) {
    log(USAGE);
    return 0;
  }

  // 新部署少配一步就会“安静地”什么都不采：启动时提醒一次，不要每轮刷屏。
  try {
    const { file, writable } = resolveConfigFile(V2_DIR);
    const startupConfig = loadConfig(file, { writable });
    if (startupConfig.accounts.length === 0) {
      errorLog(
        `[run-scheduler] 未配置任何上游账户（${file} 为空），余额采集不会产生数据。` +
          `账户字段见 v2/secrets/accounts.example.json，写到 ${INSTANCE.paths.accountsFile}。`,
      );
    }
  } catch (err) {
    errorLog(`[run-scheduler] 读取账户配置失败：${redactMessage(err?.message ?? err)}`);
  }

  const jobTasks =
    tasks ?? createDefaultTasks({ pruneDaysRaw: prune.daysRaw, pruneDaysJobs: prune.daysJobs });

  if (options.once) {
    const result = await runOnce({
      tasks: pickTasks({ options, tasks: jobTasks }),
      now,
      log,
      errorLog,
    });
    return result.failed > 0 ? 1 : 0;
  }

  const spendRunner = createTaskRunner({ name: TASK_SPEND, run: jobTasks.spend, now, log, errorLog });
  const logsRunner = createTaskRunner({ name: TASK_LOGS, run: jobTasks.logs, now, log, errorLog });
  const spendDelayMs = computeInitialDelayMs(now(), options.spendIntervalMs);
  // 日志对齐槽位 +45 秒：等余额快照落库，刷新时成本与售出才是同一段区间
  const logsDelayMs = nextSlotDelayMs(
    now(),
    options.logsIntervalMs,
    SPEND_ALIGN_MS + LOGS_ALIGN_MS,
  );

  const spendLoop = createLoop({
    delayMs: spendDelayMs,
    intervalMs: options.spendIntervalMs,
    task: spendRunner,
    // 每轮重算下一个槽位：主机挂起或时钟跳变后能自动回到整点网格
    nextDelayMs: () => nextSlotDelayMs(now(), options.spendIntervalMs, SPEND_ALIGN_MS),
  }).start();

  let logsLoop = null;
  if (!options.noLogs) {
    logsLoop = createLoop({
      delayMs: logsDelayMs,
      intervalMs: options.logsIntervalMs,
      task: logsRunner,
      nextDelayMs: () =>
        nextSlotDelayMs(now(), options.logsIntervalMs, SPEND_ALIGN_MS + LOGS_ALIGN_MS),
    }).start();
  }

  let pruneLoop = null;
  if (prune.enabled && typeof jobTasks.prune === 'function') {
    const pruneRunner = createTaskRunner({
      name: TASK_PRUNE,
      run: jobTasks.prune,
      now,
      log,
      errorLog,
    });
    pruneLoop = createLoop({
      delayMs: PRUNE_INITIAL_DELAY_MS,
      intervalMs: DEFAULT_PRUNE_INTERVAL_MS,
      task: pruneRunner,
    }).start();
  }

  let rollupLoop = null;
  if (prune.enabled && typeof jobTasks.rollup === 'function') {
    const rollupRunner = createTaskRunner({
      name: TASK_ROLLUP,
      run: jobTasks.rollup,
      now,
      log,
      errorLog,
    });
    rollupLoop = createLoop({
      delayMs: ROLLUP_INITIAL_DELAY_MS,
      intervalMs: DEFAULT_ROLLUP_INTERVAL_MS,
      task: rollupRunner,
    }).start();
  }

  log(
    `[run-scheduler] 常驻启动：${TASK_SPEND} 首轮 ${spendDelayMs}ms 后，之后每 ${options.spendIntervalMs}ms；` +
      (logsLoop
        ? `${TASK_LOGS} 首轮 ${logsDelayMs}ms 后，之后每 ${options.logsIntervalMs}ms`
        : `${TASK_LOGS} 已关闭`) +
      '；' +
      (pruneLoop
        ? `${TASK_PRUNE} 首轮 ${PRUNE_INITIAL_DELAY_MS}ms 后，之后每 ${DEFAULT_PRUNE_INTERVAL_MS}ms`
        : `${TASK_PRUNE} 已关闭`) +
      '；' +
      (rollupLoop
        ? `${TASK_ROLLUP} 首轮 ${ROLLUP_INITIAL_DELAY_MS}ms 后，之后每 ${DEFAULT_ROLLUP_INTERVAL_MS}ms`
        : `${TASK_ROLLUP} 已关闭`),
  );

  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    spendLoop.stop();
    logsLoop?.stop();
    pruneLoop?.stop();
    rollupLoop?.stop();
    log(`[run-scheduler] 收到 ${signal}，定时器已清理，退出`);
    process.exitCode = 0;
    // 先让 stdout/stderr 刷出去；若还有在跑的请求，最多再等 1 秒强制退出
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  return undefined;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      if (typeof code === 'number') process.exitCode = code;
    })
    .catch((err) => {
      console.error(`[run-scheduler] 启动失败: ${redactMessage(err?.message ?? err)}`);
      process.exitCode = 1;
    });
}
