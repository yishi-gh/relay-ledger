/**
 * 看板库的打开与读取原语。只读写 v2/db/dashboard.db，不碰站点库。
 *
 * 两条硬规则：
 * 1. credits 的 0 与未知必须区分——只有覆盖区间的 `credit_window(status='complete')` 能给值；
 *    单条 credit_event 只是 partial 证据，「没有事件」不推导为 0。
 * 2. 余额快照只在边界容差内才算期初/期末余额，任意旧值不当边界值用。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { initDashboardDb } from './schema.mjs';

/** 余额快照与边界的最大偏差：超过即视为旧值（默认 10 分钟，兼容旧调用） */
export const BALANCE_FRESH_TOLERANCE_MS = 10 * 60 * 1000;

/** 小时粒度：容忍一小时的采集间隔 + 半小时间隔抖动 */
export const HOUR_BALANCE_TOLERANCE_MS = 90 * 60 * 1000;

/** 日粒度：晚采一小时也不把边界快照判旧 */
export const DAY_BALANCE_TOLERANCE_MS = 26 * 60 * 60 * 1000;

/**
 * 按粒度取余额新鲜度容差。
 * hour → 90 分钟、day → 26 小时，其它/缺省保持 10 分钟。
 */
export function balanceToleranceMs(granularity) {
  if (granularity === 'hour') return HOUR_BALANCE_TOLERANCE_MS;
  if (granularity === 'day') return DAY_BALANCE_TOLERANCE_MS;
  return BALANCE_FRESH_TOLERANCE_MS;
}

/** 打开（必要时创建）看板库并建表 */
export function openDashboardDb(file) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const db = new DatabaseSync(target);
  db.exec('PRAGMA busy_timeout = 3000');
  initDashboardDb(db);
  return db;
}

/** 用配置里的账户覆盖/补充 upstream_account（只同步非敏感字段） */
export function syncAccounts(db, accounts, now = Date.now()) {
  const stmt = db.prepare(
    `INSERT INTO upstream_account (id, name, kind, base_url, unit, enabled, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       kind = excluded.kind,
       base_url = excluded.base_url,
       unit = excluded.unit,
       enabled = excluded.enabled,
       updated_at = excluded.updated_at`,
  );
  for (const a of accounts) {
    stmt.run(a.id, a.name ?? a.id, a.kind ?? null, a.base_url ?? null, a.unit ?? 'USD', a.enabled === false ? 0 : 1, now);
  }
}

/** 写入/更新一条区间入账汇总（采集器核对完一个窗口后调用） */
export function upsertCreditWindow(
  db,
  { accountId, windowStart, windowEnd, credits, status = 'complete', source = null, recordedAt = Date.now() },
) {
  db.prepare(
    `INSERT INTO credit_window (account_id, window_start, window_end, credits, status, source, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, window_start, window_end) DO UPDATE SET
       credits = excluded.credits,
       status = excluded.status,
       source = excluded.source,
       recorded_at = excluded.recorded_at`,
  ).run(accountId, windowStart, windowEnd, credits, status, source, recordedAt);
}

/**
 * 某账户在 tMs（含）之前最后一条余额快照，没有则返回 null。
 * fresh = 快照与边界的偏差不超过 tolerance（默认 10 分钟）；旧值不当边界余额。
 * 粒度场景用 balanceToleranceMs('hour'|'day') 覆盖。
 */
export function readBalanceAt(db, accountId, tMs, tolerance = BALANCE_FRESH_TOLERANCE_MS) {
  const row = db.prepare(
    `SELECT t_ms, balance, currency, raw_balance, raw_unit, total_recharged
       FROM balance_snapshot
      WHERE account_id = ? AND t_ms <= ?
      ORDER BY t_ms DESC
      LIMIT 1`,
  ).get(accountId, tMs);
  if (!row) return null;
  const fresh = Number.isFinite(tolerance) && tMs - row.t_ms <= tolerance;
  return {
    balance: typeof row.balance === 'number' ? row.balance : null,
    t_ms: row.t_ms,
    currency: row.currency ?? null,
    raw_balance: typeof row.raw_balance === 'number' ? row.raw_balance : null,
    raw_unit: row.raw_unit ?? null,
    total_recharged: typeof row.total_recharged === 'number' ? row.total_recharged : null,
    fresh,
  };
}

/**
 * 区间 (from, to] 的入账，返回
 * `{ credits, status, source, events, event_total }`。
 * - 有覆盖区间的 complete 窗口：credits 为该窗口的确定值（可以是 0），status='complete'；
 * - 否则 credits=null（未知），status='partial'，事件汇总只作证据放在 events/event_total。
 * 不把「没有 credit_event」推导成 0。
 */
export function readCreditsBetween(db, accountId, from, to) {
  const window = db.prepare(
    `SELECT credits, source
       FROM credit_window
      WHERE account_id = ? AND status = 'complete'
        AND window_start <= ? AND window_end >= ?
      ORDER BY (window_end - window_start) ASC, window_end DESC
      LIMIT 1`,
  ).get(accountId, from, to);
  if (window) {
    return {
      credits: typeof window.credits === 'number' ? window.credits : null,
      status: 'complete',
      source: window.source ?? 'window',
      events: null,
      event_total: null,
    };
  }

  const events = db.prepare(
    `SELECT COUNT(*) AS n, SUM(amount) AS total
       FROM credit_event
      WHERE account_id = ? AND t_ms > ? AND t_ms <= ?`,
  ).get(accountId, from, to);
  return {
    credits: null,
    status: 'partial',
    source: null,
    events: events?.n ?? 0,
    event_total: typeof events?.total === 'number' ? events.total : null,
  };
}

/**
 * 区间 (from, to] 的入账事件合计，返回 `{ total, count }`。
 *
 * 与站点盈利面板同口径：直接汇总 `credit_event`（含采集器按余额上涨推断的
 * `source='balance_delta'` 事件），不再要求存在覆盖整个区间的 complete 窗口。
 * 采集器每轮都会拉「昨天 00:00 至本次采集」的充值明细并推断区间内上涨，
 * 因此只要区间两端都有快照，事件流就是完整的；没有事件即 0。
 */
export function readCreditEventSum(db, accountId, from, to) {
  const row = db.prepare(
    `SELECT COUNT(*) AS n, SUM(amount) AS total
       FROM credit_event
      WHERE account_id = ? AND t_ms > ? AND t_ms <= ?`,
  ).get(accountId, from, to);
  return {
    total: typeof row?.total === 'number' ? row.total : 0,
    count: row?.n ?? 0,
  };
}

/** 最近的任务运行记录 */
export function readJobRuns(db, limit = 20) {
  return db.prepare(
    `SELECT job, started_at, finished_at, status, detail
       FROM job_runs
      ORDER BY COALESCE(finished_at, started_at, 0) DESC, id DESC
      LIMIT ?`,
  ).all(limit);
}

/** 某任务最近一条运行记录 */
export function readLastRun(db, job) {
  return db.prepare(
    `SELECT job, started_at, finished_at, status, detail
       FROM job_runs
      WHERE job = ?
      ORDER BY COALESCE(finished_at, started_at, 0) DESC, id DESC
      LIMIT 1`,
  ).get(job) ?? null;
}

/** 某账户最新一条余额快照（不限时间，用于「最后同步」） */
export function readLatestSnapshot(db, accountId) {
  return db.prepare(
    `SELECT t_ms, balance, currency, raw_balance, raw_unit, total_recharged
       FROM balance_snapshot
      WHERE account_id = ?
      ORDER BY t_ms DESC
      LIMIT 1`,
  ).get(accountId) ?? null;
}

/** 按北京自然日 key 汇总上报消费；完全没有记录返回 null（区别于 0） */
export function readSpendSum(db, accountId, fromDay, toDay) {
  const row = db.prepare(
    `SELECT COUNT(*) AS n, SUM(spend) AS total
       FROM upstream_spend_daily
      WHERE account_id = ? AND day >= ? AND day <= ?`,
  ).get(accountId, fromDay, toDay);
  if (!row || !row.n) return null;
  return typeof row.total === 'number' ? row.total : null;
}

/**
 * 某自然日已确认的最新入账窗口（今日进行中的窗口随采集不断推进）。
 * 返回值只来自 status='complete' 的窗口，credits 可以是 0；没有窗口返回 null。
 */
export function readLatestCreditWindow(db, accountId, windowStart) {
  return db.prepare(
    `SELECT window_start, window_end, credits, status, source
       FROM credit_window
      WHERE account_id = ? AND window_start = ? AND status = 'complete'
      ORDER BY window_end DESC
      LIMIT 1`,
  ).get(accountId, windowStart) ?? null;
}
