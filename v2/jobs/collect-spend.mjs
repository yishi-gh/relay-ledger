/**
 * collect-spend：拉取上游余额与充值/赠额，写入看板库。
 *
 * - 只写实例配置的看板库（默认 `<dataDir>/dashboard.db`），不碰站点库、不连真实上游（fetch 可注入）
 * - 时间统一北京时间自然日：余额快照 t_ms 为采集时刻，credit_window 按北京自然日切分
 * - auth / unsupported / 缺字段一律 unavailable 或 partial，绝不写 0
 * - 429 立即停止整轮，不继续打其他上游
 * - job_runs.detail 只记状态与原因，不含 token
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, resolveConfigFile } from '../lib/config.mjs';
import { ensureDataDirs, INSTANCE } from '../lib/instance.mjs';
import { evaluateLedger, round6 } from '../lib/ledger.mjs';
import { beijingDayStart, DAY_MS, dayKey } from '../lib/time.mjs';
import { authCanRefresh, ensureAuth, expectedUserId } from '../sources/upstream/auth.mjs';
import { createUpstreamClient } from '../sources/upstream/http.mjs';
import { createNewApiSource } from '../sources/upstream/newapi.mjs';
import { fetchBalanceByKey, createSub2ApiSource } from '../sources/upstream/sub2api.mjs';
import { getChannelCredential, openRelayDb } from '../sources/upstream/relay-key.mjs';
import {
  balanceToleranceMs,
  readBalanceAt,
  readCreditEventSum,
  readLatestSnapshot,
  openDashboardDb,
  syncAccounts,
} from '../store/dashboard.mjs';

export const JOB_NAME = 'collect-spend';

/** 认证类失败里要原样透出的原因，其余统一 auth_failed */
const AUTH_REASONS = new Set(['missing_token', 'missing_cookie', 'cookie_account_mismatch', 'auth_failed']);

function authReason(err) {
  return AUTH_REASONS.has(err?.reason) ? err.reason : 'auth_failed';
}

/** 认证不可用时不再继续请求其他接口 */
function isAuthBlocked(reason) {
  return AUTH_REASONS.has(reason);
}

const V2_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DASHBOARD_FILE = INSTANCE.paths.dashboardFile;
const DEFAULT_RELAY_DB = INSTANCE.paths.relayDb;

function accountSource(account, client, headers, config) {
  if (account.kind === 'newapi') {
    return createNewApiSource({
      account,
      client,
      headers,
      quotaPerUnit: account.quota_per_unit ?? config.quota_per_unit,
      // cookie 是站点级的：用配置的 user id（或数字账户 id）核对 /api/user/self 的返回值
      expectedUserId: expectedUserId(account),
    });
  }
  if (account.kind === 'sub2api') return createSub2ApiSource({ account, client, headers });
  return null;
}

/**
 * 账户级状态与短原因：只把真正的采集失败算进去。
 * 账本日常的 incomplete_day / stale_balance / missing_balance 不算失败：
 * 当天第一条快照之前的期初本来就取不到，不能把每轮都报成采集失败。
 */
function summarizeAccount(record) {
  // 余额已经拿到时，入账/上报消费缺失只说明「少了一个数据源」（例如会话过期、
  // sub2api 本来就没有充值接口），不能据此把账户判成采集失败——否则面板上每天
  // 都会出现假的「采集失败」。
  if (record.balance?.status === 'ok' && record.ledger?.reason !== 'exception') {
    return { status: 'ok', reason: null };
  }
  const parts = [record.balance, record.credits, record.spend];
  const hard = parts.find((part) => part?.status === 'unavailable')
    ?? (record.ledger?.reason === 'exception' ? record.ledger : null);
  if (hard) return { status: 'unavailable', reason: hard.reason ?? null };
  const soft = parts.find((part) => part?.status === 'partial');
  if (soft) return { status: 'partial', reason: soft.reason ?? null };
  if (record.balance?.status === 'ok') return { status: 'ok', reason: null };
  return { status: 'unavailable', reason: record.balance?.reason ?? null };
}

/**
 * 按 account.channels 顺序试渠道 key，第一个成功即用；全部失败返回 null。
 * relay db 不存在时 relayDb 为 null，直接返回 null（调用方退回会话）。
 */
async function channelKeyBalance(account, relayDb, { fetchImpl, timeoutMs } = {}) {
  if (account.kind !== 'sub2api') return null;
  const channels = Array.isArray(account.channels) ? account.channels : [];
  if (!relayDb || channels.length === 0) return null;
  for (const channelId of channels) {
    const credential = getChannelCredential(relayDb, channelId);
    if (!credential) continue;
    const res = await fetchBalanceByKey({
      baseUrl: credential.base_url ?? account.base_url,
      key: credential.key,
      timeoutMs,
      fetchImpl,
    });
    if (res.status === 'ok' && typeof res.value === 'number') return res;
  }
  return null;
}

function writeBalance(db, account, at, res) {
  if (res.status !== 'ok' || typeof res.value !== 'number') return false;
  db.prepare(
    `INSERT INTO balance_snapshot
       (account_id, t_ms, day, balance, currency, raw_balance, raw_unit, total_recharged, source, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'collect-spend', ?)
     ON CONFLICT(account_id, t_ms) DO UPDATE SET
       balance = excluded.balance,
       currency = excluded.currency,
       raw_balance = excluded.raw_balance,
       raw_unit = excluded.raw_unit,
       total_recharged = excluded.total_recharged,
       source = excluded.source,
       recorded_at = excluded.recorded_at`,
  ).run(
    account.id,
    at,
    dayKey(at),
    res.value,
    account.unit ?? 'USD',
    res.raw?.value ?? null,
    res.raw?.unit ?? null,
    typeof res.recharged === 'number' && Number.isFinite(res.recharged) ? res.recharged : null,
    at,
  );
  return true;
}

function writeCreditEvents(db, accountId, events, at) {
  let written = 0;
  const stmt = db.prepare(
    `INSERT INTO credit_event (account_id, t_ms, amount, kind, note, source, recorded_at)
     SELECT ?, ?, ?, ?, ?, 'collect-spend', ?
      WHERE NOT EXISTS (
        SELECT 1 FROM credit_event WHERE account_id = ? AND t_ms = ? AND kind = ? AND amount = ?
      )`,
  );
  for (const event of events) {
    const amount = round6(event.amount);
    const changes = stmt.run(
      accountId,
      event.t_ms,
      amount,
      event.kind,
      event.note ?? null,
      at,
      accountId,
      event.t_ms,
      event.kind,
      amount,
    ).changes;
    written += changes;
  }
  return written;
}

/**
 * 余额上升推断充值：在 (上一条快照, 本次快照] 区间内，
 * 先用余额涨幅减去已记录的 credit_event（NewAPI 的 topup/gift 等），
 * 剩余部分补一条 source='balance_delta' 的 topup 事件。
 *
 * - 余额下降或不变不记（不记负充值）
 * - 同一 (account_id, source='balance_delta', t_ms) 只插一次
 * - 金额取整后为 0 不插
 * @returns {{ inserted: boolean, amount: number }}
 */
export function recordInferredCredits(db, accountId, prevSnapshot, currentSnapshot, nowMs) {
  const prev = typeof prevSnapshot?.balance === 'number' ? prevSnapshot.balance : null;
  const curr = typeof currentSnapshot?.balance === 'number' ? currentSnapshot.balance : null;
  if (prev === null || curr === null || curr <= prev) return { inserted: false, amount: 0 };

  // 两端都有累计充值总额时，充值额由它算差值，不再用余额上涨推断（否则同一笔会算两遍）
  const prevRecharged = typeof prevSnapshot?.total_recharged === 'number' ? prevSnapshot.total_recharged : null;
  const currRecharged = typeof currentSnapshot?.total_recharged === 'number' ? currentSnapshot.total_recharged : null;
  if (prevRecharged !== null && currRecharged !== null) return { inserted: false, amount: 0 };

  const at = Number.isFinite(nowMs) ? nowMs : currentSnapshot?.t_ms;
  const from = prevSnapshot?.t_ms;
  // 推断金额落在「本次涨幅所属区间」内：记在期初快照之后，不能记在期末（会掉进下一个小时桶）
  const stampAt = Number.isFinite(from) ? from + 1 : null;
  if (!Number.isFinite(at) || stampAt === null) return { inserted: false, amount: 0 };

  const recorded = Number.isFinite(from)
    ? db.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total
         FROM credit_event
        WHERE account_id = ? AND t_ms > ? AND t_ms <= ?`,
    ).get(accountId, from, at).total
    : 0;

  const remaining = round6(curr - prev - (typeof recorded === 'number' ? recorded : 0));
  if (remaining === null || remaining <= 0) return { inserted: false, amount: 0 };

  const changes = db.prepare(
    `INSERT INTO credit_event (account_id, t_ms, amount, kind, note, source, recorded_at)
     SELECT ?, ?, ?, 'topup', 'inferred from balance rise', 'balance_delta', ?
      WHERE NOT EXISTS (
        SELECT 1 FROM credit_event
         WHERE account_id = ? AND source = 'balance_delta' AND t_ms = ?
      )`,
  ).run(accountId, stampAt, remaining, at, accountId, stampAt).changes;

  return changes > 0 ? { inserted: true, amount: remaining } : { inserted: false, amount: 0 };
}

function writeCreditWindow(db, { accountId, start, end, credits, complete, at }) {  // 同一自然日的旧窗口（含进行中的短窗口）被新窗口取代，避免每轮累积
  db.prepare(
    `DELETE FROM credit_window
      WHERE account_id = ? AND window_start = ? AND window_end < ? AND source = 'collect-spend'`,
  ).run(accountId, start, end);
  db.prepare(
    `INSERT INTO credit_window (account_id, window_start, window_end, credits, status, source, recorded_at)
     VALUES (?, ?, ?, ?, ?, 'collect-spend', ?)
     ON CONFLICT(account_id, window_start, window_end) DO UPDATE SET
       credits = excluded.credits,
       status = excluded.status,
       source = excluded.source,
       recorded_at = excluded.recorded_at`,
  ).run(accountId, start, end, round6(credits), complete ? 'complete' : 'partial', at);
}

function writeSpend(db, account, day, res, at) {
  if (res.status !== 'ok' || typeof res.value !== 'number') return false;
  db.prepare(
    `INSERT INTO upstream_spend_daily (account_id, day, spend, currency, source, recorded_at)
     VALUES (?, ?, ?, ?, 'collect-spend', ?)
     ON CONFLICT(account_id, day) DO UPDATE SET
       spend = excluded.spend,
       currency = excluded.currency,
       source = excluded.source,
       recorded_at = excluded.recorded_at`,
  ).run(account.id, day, round6(res.value), account.unit ?? 'USD', at);
  return true;
}

function writeJobRun(db, { startedAt, finishedAt, status, detail }) {
  db.prepare(
    `INSERT INTO job_runs (job, started_at, finished_at, status, detail)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(JOB_NAME, startedAt, finishedAt, status, JSON.stringify(detail));
}

/**
 * 跑一轮采集。
 * @param {object} options
 * @param {object} options.config 已解析的配置（loadConfig 的结果，含 file/writable）
 * @param {import('node:sqlite').DatabaseSync} options.db 看板库
 * @param {Function} [options.fetchImpl] 可注入 fetch，测试用
 * @param {number} [options.now] 采集时刻
 */
export async function runCollectSpend({
  config,
  db,
  fetchImpl,
  now = Date.now(),
  client,
  relayDbFile = DEFAULT_RELAY_DB,
} = {}) {
  if (!config) throw new Error('缺少 config');
  if (!db) throw new Error('缺少看板库 db');

  const startedAt = now;
  const upstream = config.upstream ?? {};
  const httpClient = client ?? createUpstreamClient({
    fetchImpl,
    timeoutMs: upstream.timeout_ms ?? 20000,
    minIntervalMs: upstream.min_interval_ms ?? 1200,
    retryDelayMs: upstream.retry_delay_ms ?? 500,
  });

  const dayStart = beijingDayStart(now);
  const yesterdayStart = dayStart - DAY_MS;
  const yesterdayEnd = dayStart - 1;
  const today = dayKey(now);

  const accounts = [];
  let rateLimited = false;

  for (const account of config.accounts) {
    if (account.enabled === false) continue;
    // 没有上游账户的渠道（如 opencode go）：只统计售出，不采余额，也不计入失败
    if (account.kind === 'external') continue;
    const record = {
      id: account.id,
      name: account.name ?? account.id,
      kind: account.kind,
      balance_source: null,
      balance: { status: 'unavailable', reason: null },
      credits: { status: 'unavailable', reason: null },
      spend: { status: 'unavailable', reason: null },
      ledger: { status: 'unavailable', reason: null },
      written: { balance: false, credit_events: 0, windows: [], spend: false, inferred_credit: 0 },
    };
    const pushRecord = () => {
      const summary = summarizeAccount(record);
      record.status = summary.status;
      record.reason = summary.reason;
      accounts.push(record);
    };

    try {
      // sub2api 先试中转站渠道 key：relay db 不存在时 openRelayDb 返回 null，静默退回会话
      let channelBalance = null;
      if (account.kind === 'sub2api' && Array.isArray(account.channels) && account.channels.length > 0) {
        const relayDb = openRelayDb(relayDbFile);
        if (relayDb) {
          try {
            channelBalance = await channelKeyBalance(account, relayDb, {
              fetchImpl,
              timeoutMs: upstream.timeout_ms,
            });
          } finally {
            relayDb.close();
          }
        }
      }

      // session === false：账户只有永久 API Key、没有可用会话（例如只发长期 PAT 的上游），
      // 走与「无 base_url」相同的分支——只用渠道 key 写余额。
      if (!account.base_url || account.session === false) {
        if (channelBalance) {
          // 没有会话时仍可落渠道余额；入账与上报消费没有数据源
          record.balance = {
            status: 'ok',
            reason: null,
            value: channelBalance.value,
            unit: channelBalance.unit,
          };
          record.balance_source = 'channel_key';
          record.written.balance = writeBalance(db, account, now, channelBalance);
          // unconfigured 而不是 unavailable：没有数据源不是采集失败，不该让整轮变 partial
          Object.assign(record.credits, { status: 'unconfigured', reason: 'not_configured' });
          Object.assign(record.spend, { status: 'unconfigured', reason: 'not_configured' });
          Object.assign(record.ledger, { status: 'unconfigured', reason: 'not_configured' });
          pushRecord();
          continue;
        }
        Object.assign(record.balance, { status: 'unconfigured', reason: 'not_configured' });
        Object.assign(record.credits, { status: 'unconfigured', reason: 'not_configured' });
        Object.assign(record.spend, { status: 'unconfigured', reason: 'not_configured' });
        Object.assign(record.ledger, { status: 'unconfigured', reason: 'not_configured' });
        pushRecord();
        continue;
      }

      let session;
      try {
        session = await ensureAuth(account, {
          nowMs: now,
          fetchImpl,
          configPath: config.file ?? null,
          writable: config.writable === true,
          thresholdMs: upstream.refresh_threshold_ms,
          timeoutMs: upstream.timeout_ms,
        });
      } catch (err) {
        if (err?.kind === 'rate_limited') {
          rateLimited = true;
          Object.assign(record.balance, { reason: 'rate_limited' });
          Object.assign(record.credits, { reason: 'rate_limited' });
          Object.assign(record.spend, { reason: 'rate_limited' });
          Object.assign(record.ledger, { reason: 'rate_limited' });
          pushRecord();
          break;
        }
        const reason = authReason(err);
        if (channelBalance) {
          record.balance = {
            status: 'ok',
            reason: null,
            value: channelBalance.value,
            unit: channelBalance.unit,
          };
          record.balance_source = 'channel_key';
          record.written.balance = writeBalance(db, account, now, channelBalance);
        } else {
          Object.assign(record.balance, { reason });
        }
        Object.assign(record.credits, { reason });
        Object.assign(record.spend, { reason });
        Object.assign(record.ledger, { reason });
        pushRecord();
        continue;
      }
      record.refresh = {
        refreshed: session.refreshed,
        wrote: session.wrote,
        write_error: session.write_error,
        ...(session.refresh_error ? { refresh_error: session.refresh_error } : {}),
      };

      let source = accountSource(account, httpClient, session.headers, config);
      if (!source) {
        Object.assign(record.balance, { reason: 'unsupported_kind' });
        Object.assign(record.credits, { reason: 'unsupported_kind' });
        Object.assign(record.spend, { reason: 'unsupported_kind' });
        Object.assign(record.ledger, { reason: 'unsupported_kind' });
        pushRecord();
        continue;
      }

      let balance;
      if (channelBalance) {
        balance = channelBalance;
        record.balance_source = 'channel_key';
      } else {
        record.balance_source = 'session';
        balance = await source.fetchBalance();
        // 令牌可能在采集前被上游吊销：强制换签一次并重试一次，仍失败才判 auth_failed
        // NewAPI 用 cookie 换签，Sub2API 用 refresh_token；两者都没有时不发刷新请求
        if (balance.reason === 'auth_failed' && authCanRefresh(account, session.auth)) {
          try {
            session = await ensureAuth(account, {
              force: true,
              nowMs: now,
              fetchImpl,
              configPath: config.file ?? null,
              writable: config.writable === true,
              thresholdMs: upstream.refresh_threshold_ms,
              timeoutMs: upstream.timeout_ms,
            });
            record.refresh = {
              refreshed: true,
              forced: true,
              wrote: session.wrote,
              write_error: session.write_error,
            };
            source = accountSource(account, httpClient, session.headers, config);
            balance = await source.fetchBalance();
          } catch (err) {
            if (err?.kind === 'rate_limited') {
              rateLimited = true;
              Object.assign(record.balance, { reason: 'rate_limited' });
              Object.assign(record.credits, { reason: 'rate_limited' });
              Object.assign(record.spend, { reason: 'rate_limited' });
              Object.assign(record.ledger, { reason: 'rate_limited' });
              pushRecord();
              break;
            }
            record.refresh = { refreshed: false, forced: true, failed: true };
            balance = {
              status: 'unavailable',
              reason: authReason(err),
              value: null,
              unit: 'USD',
            };
          }
        }
      }
      record.balance = { status: balance.status, reason: balance.reason, value: balance.value, unit: balance.unit };
      // 推断充值要对比「上一条快照」，必须在写入本次快照之前取
      const previousSnapshot = readLatestSnapshot(db, account.id);
      record.written.balance = writeBalance(db, account, now, balance);

      // 认证失败/账号不匹配时不再消耗后续请求，直接标不可用
      if (isAuthBlocked(balance.reason)) {
        record.credits = { status: 'unavailable', reason: balance.reason };
        record.spend = { status: 'unavailable', reason: balance.reason };
        record.ledger = { status: 'unavailable', reason: balance.reason };
        pushRecord();
        continue;
      }

      // 一次取 [昨日 00:00, 现在]，按北京自然日切成昨天完整日与今日进行中两个窗口
      const credits = await source.fetchCredits({ from: yesterdayStart, to: now });
      record.credits = {
        status: credits.status,
        reason: credits.reason,
        value: credits.value,
        complete: credits.complete,
      };
      if ((credits.status === 'ok' || credits.status === 'partial') && Array.isArray(credits.events)) {
        record.written.credit_events = writeCreditEvents(db, account.id, credits.events, now);
        const yesterdayEvents = credits.events.filter((e) => e.t_ms < dayStart);
        const todayEvents = credits.events.filter((e) => e.t_ms >= dayStart);
        const sum = (list) => list.reduce((s, e) => s + e.amount, 0);
        writeCreditWindow(db, {
          accountId: account.id,
          start: yesterdayStart,
          end: yesterdayEnd,
          credits: sum(yesterdayEvents),
          complete: credits.complete === true,
          at: now,
        });
        writeCreditWindow(db, {
          accountId: account.id,
          start: dayStart,
          end: now,
          credits: sum(todayEvents),
          complete: credits.complete === true,
          at: now,
        });
        record.written.windows = [yesterdayStart, dayStart];
      }

      // 余额上升且上游入账不足以解释时，补一条 balance_delta 推断充值
      if (record.written.balance) {
        const inferred = recordInferredCredits(
          db,
          account.id,
          previousSnapshot,
          { t_ms: now, balance: balance.value },
          now,
        );
        record.written.inferred_credit = inferred.inserted ? inferred.amount : 0;
      }

      const spend = await source.fetchReportedSpend({ from: dayStart, to: now });
      record.spend = { status: spend.status, reason: spend.reason, value: spend.value, unit: spend.unit };
      record.written.spend = writeSpend(db, account, today, spend, now);

      // 用刚写入的数据跑一次账本判定：今日不是完整自然日，最多只能是 partial
      // 按小时采集时，日边界附近的快照最多差一小时，日账本用日粒度容差
      const dayTolerance = balanceToleranceMs('day');
      const opening = readBalanceAt(db, account.id, dayStart, dayTolerance);
      const closing = readBalanceAt(db, account.id, now, dayTolerance);
      // 与 API / 盈利面板同口径：入账统一取 credit_event 合计（含本轮写入的上游明细
      // 与刚推断的 balance_delta），不再依赖 credit_window 是否覆盖整个区间
      const creditsToday = readCreditEventSum(db, account.id, dayStart, now);
      const verdict = evaluateLedger({
        opening: opening ? opening.balance : null,
        closing: closing ? closing.balance : null,
        credits: creditsToday.total,
        completeDay: false,
        openingFresh: opening ? opening.fresh : false,
        closingFresh: closing ? closing.fresh : false,
      });
      record.ledger = {
        status: verdict.status,
        reason: verdict.reason,
        consumption: verdict.consumption,
        balance_delta: verdict.balance_delta,
      };
    } catch (err) {
      if (err?.kind === 'rate_limited') {
        rateLimited = true;
        record.balance = { status: 'unavailable', reason: 'rate_limited' };
        record.credits = { status: 'unavailable', reason: 'rate_limited' };
        record.spend = { status: 'unavailable', reason: 'rate_limited' };
        record.ledger = { status: 'unavailable', reason: 'rate_limited' };
        pushRecord();
        break;
      }
      record.ledger = { status: 'unavailable', reason: 'exception' };
      if (!record.balance.reason) record.balance.reason = 'exception';
      if (!record.credits.reason) record.credits.reason = 'exception';
      if (!record.spend.reason) record.spend.reason = 'exception';
    }

    pushRecord();
  }

  const degraded = accounts.some(
    (a) =>
      a.balance.status !== 'ok' ||
      a.ledger.reason === 'exception' ||
      // 走会话的账户：入账/上报消费缺失仍算降级（NewAPI 的充值流水是真数据源）。
      // 走渠道 key 的账户：会话本来就可有可无，不算。
      (a.balance_source === 'session' &&
        (a.credits.status === 'unavailable' || a.credits.status === 'partial')),
  );
  const status = rateLimited ? 'rate_limited' : degraded ? 'partial' : 'ok';
  const finishedAt = Date.now();
  writeJobRun(db, {
    startedAt,
    finishedAt,
    status,
    detail: { rate_limited: rateLimited, accounts },
  });

  return { status, startedAt, finishedAt, rateLimited, accounts };
}

function relayDbFileFromArgs(argv = process.argv.slice(2)) {
  const arg = argv.find((value) => value.startsWith('--relay-db='));
  const fromArg = arg ? arg.slice('--relay-db='.length).trim() : '';
  if (fromArg) return fromArg;
  const fromEnv = typeof process.env.RELAY_DB_FILE === 'string' ? process.env.RELAY_DB_FILE.trim() : '';
  return fromEnv || DEFAULT_RELAY_DB;
}

async function main() {
  const { file, writable } = resolveConfigFile(V2_DIR);
  const config = loadConfig(file, { writable });
  if (config.accounts.length === 0) {
    // 新部署最常见的一步漏掉：账户清单还没建，采集会“成功”地什么都不做。
    console.error(
      `[collect-spend] 未配置任何上游账户（${file} 为空）。` +
        `把账户写进 ${INSTANCE.paths.accountsFile}，字段见 v2/secrets/accounts.example.json。`,
    );
  }
  ensureDataDirs(INSTANCE);
  const db = openDashboardDb(DASHBOARD_FILE);
  syncAccounts(db, config.accounts.filter((a) => a.enabled));
  try {
    const summary = await runCollectSpend({
      config,
      db,
      relayDbFile: relayDbFileFromArgs(),
    });
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    db.close();
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[${JOB_NAME}] 失败: ${err?.message ?? err}`);
    process.exitCode = 1;
  });
}
