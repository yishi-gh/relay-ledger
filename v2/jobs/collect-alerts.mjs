/**
 * collect-alerts：把“长时间没数据 / 未归属收入 / 渠道状态同步失败”变成可投递的告警。
 *
 * - 只读看板库、站点日志副本；不访问上游，不改中转站库
 * - 告警先去重落 alert_state，再由 RELAY_ALERT_WEBHOOK 发送；未配置时仍在面板可见
 * - payload 只含渠道/账户标识、金额、时间和原因，不含 token、cookie、key
 */

import { DatabaseSync } from 'node:sqlite';

import { LOCAL_FILTER } from '../lib/api.mjs';
import { buildChannelAssociations } from '../lib/channel-associations.mjs';
import { formatLocal } from '../lib/time.mjs';
import { readRoutingSnapshot } from '../store/channel-routing.mjs';
import { markAlertsSent, syncAlertState } from '../store/alerts.mjs';

export const DEFAULT_UNMATCHED_MIN_USD = 1;
export const DEFAULT_BALANCE_STALE_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_PARTIAL_STREAK = 4;
export const DEFAULT_REPEAT_MS = 24 * 60 * 60 * 1000;
export const ALERT_WEBHOOK_ENV = 'RELAY_ALERT_WEBHOOK';

const FAILED_STATUSES = new Set(['partial', 'rate_limited', 'error']);
const WINDOW_MS = 24 * 60 * 60 * 1000;
const WEBHOOK_TIMEOUT_MS = 10_000;

function latestJobRun(dashboard, job) {
  try {
    return dashboard.prepare(
      `SELECT started_at, finished_at, status, detail
         FROM job_runs
        WHERE job = ?
        ORDER BY COALESCE(finished_at, started_at, 0) DESC, id DESC
        LIMIT 1`,
    ).get(job) ?? null;
  } catch {
    return null;
  }
}

function parseDetail(value) {
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

function channelRows(dashboard) {
  let stateRows = [];
  try {
    stateRows = dashboard.prepare(
      'SELECT channel_id, name, status, base_url FROM channel_state',
    ).all();
  } catch {
    stateRows = [];
  }
  const states = stateRows.length
    ? new Map(stateRows.map((row) => [Number(row.channel_id), {
      name: row.name == null ? '' : String(row.name),
      status: row.status == null ? null : Number(row.status),
      base_url: row.base_url == null ? null : String(row.base_url),
    }]))
    : null;

  const snapshot = readRoutingSnapshot(dashboard);
  const snapshotChannels = snapshot.payload?.channels;
  const channels = Array.isArray(snapshotChannels) && snapshotChannels.length > 0
    ? snapshotChannels
    : stateRows.map((row) => ({
      id: Number(row.channel_id),
      name: row.name,
      status: row.status,
      base_url: row.base_url,
    }));
  return { states, channels };
}

function channelName(states, channelId, fallback) {
  return states?.get(Number(channelId))?.name || fallback || '';
}

function spendAlert(dashboard, threshold) {
  if (threshold <= 0) return null;
  let runs = [];
  try {
    runs = dashboard.prepare(
      `SELECT status, detail
         FROM job_runs
        WHERE job = 'collect-spend'
        ORDER BY COALESCE(finished_at, started_at, 0) DESC, id DESC
        LIMIT ?`,
    ).all(threshold);
  } catch {
    return null;
  }
  let streak = 0;
  for (const run of runs) {
    if (!FAILED_STATUSES.has(run.status)) break;
    streak += 1;
  }
  if (streak < threshold) return null;

  const detail = parseDetail(runs[0]?.detail);
  const failedAccounts = Array.isArray(detail?.accounts)
    ? detail.accounts
      .filter((account) => account && account.status !== 'ok')
      .map((account) => `${account.name ?? account.id ?? 'unknown'}: ${account.reason ?? account.status ?? 'unknown'}`)
    : [];
  return {
    key: 'collect-spend-partial',
    severity: 'warn',
    title: `余额采集连续 ${streak} 轮未完全成功`,
    detail: (failedAccounts.join('; ') || '最近一轮没有成功').slice(0, 500),
  };
}

function channelStateAlert(dashboard) {
  const run = latestJobRun(dashboard, 'channel-state');
  if (!run || run.status !== 'error') return null;
  const detail = parseDetail(run.detail);
  return {
    key: 'channel-state-error',
    severity: 'error',
    title: '渠道状态同步失败',
    detail: String(detail?.message ?? 'channel-state 最近一次运行失败').slice(0, 500),
  };
}

function staleBalanceAlerts(dashboard, config, associations, states, now, staleMs) {
  if (!Number.isFinite(staleMs) || staleMs <= 0) return [];
  const latest = new Map();
  try {
    for (const row of dashboard.prepare(
      'SELECT account_id, MAX(t_ms) AS last_t FROM balance_snapshot GROUP BY account_id',
    ).all()) latest.set(String(row.account_id), Number(row.last_t));
  } catch {
    return [];
  }

  const effectiveById = new Map(associations.accounts.map((account) => [String(account.id), account]));
  const alerts = [];
  for (const account of config?.accounts ?? []) {
    if (!account || account.enabled === false || account.kind === 'external') continue;
    const effective = effectiveById.get(String(account.id));
    const channels = Array.isArray(effective?.channels) ? effective.channels : account.channels ?? [];
    const live = states
      ? channels.filter((id) => states.get(Number(id))?.status === 1).length
      : channels.length;
    if (live === 0) continue;

    const last = latest.get(String(account.id));
    const age = typeof last === 'number' ? Math.max(0, now - last) : Infinity;
    if (age <= staleMs) continue;
    const hours = Number.isFinite(age) ? (age / 3_600_000).toFixed(1) : '从未';
    alerts.push({
      key: `balance-stale:${account.id}`,
      severity: 'warn',
      title: `${account.name ?? account.id} ${Number.isFinite(age) ? `余额已 ${hours} 小时未更新` : '从未成功采集余额'}`,
      detail: `账户 ${account.id}；最后快照 ${last ? formatLocal(last) : '无'}；阈值 ${(staleMs / 3_600_000).toFixed(1)} 小时`,
    });
  }
  return alerts;
}

function unmappedRevenueAlerts(source, config, associations, states, now, minUsd) {
  if (!source || !Number.isFinite(minUsd) || minUsd <= 0) return [];
  let rows;
  try {
    rows = source.prepare(
      `SELECT channel_id, MAX(channel_name) AS channel_name, COALESCE(SUM(cost), 0) AS revenue
         FROM logs
        WHERE ${LOCAL_FILTER} AND t_ms >= ? AND t_ms < ?
        GROUP BY channel_id`,
    ).all(now - WINDOW_MS, now);
  } catch {
    return [];
  }

  const alerts = [];
  for (const row of rows) {
    const channelId = Number(row.channel_id);
    if (!Number.isInteger(channelId)) continue;
    if ((associations.owners.get(channelId) ?? []).length > 0) continue;
    if (states && states.get(channelId)?.status !== 1) continue;
    const revenue = Number(row.revenue) || 0;
    if (revenue < minUsd) continue;
    const name = channelName(states, channelId, row.channel_name) || `渠道 #${channelId}`;
    alerts.push({
      key: `unmapped-channel:${channelId}`,
      severity: 'warn',
      title: `未归属渠道 ${name} 24h 售出 ${revenue.toFixed(2)} USD`,
      detail: `channel_id=${channelId}；检查账户 base_url / 名称是否变化，或渠道 key 是否可用`,
    });
  }
  return alerts;
}

function webhookConfigured(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

function alertPayload(site, alerts) {
  return {
    source: 'relay-ledger',
    ...(site ? { site } : {}),
    alerts: alerts.map((alert) => ({
      key: alert.alert_key,
      severity: alert.severity,
      title: alert.title,
      detail: alert.detail,
      first_seen_at: alert.first_seen_at,
      last_seen_at: alert.last_seen_at,
    })),
  };
}

/**
 * @param {object} options
 * @param {import('node:sqlite').DatabaseSync} options.dashboard 看板库
 * @param {import('node:sqlite').DatabaseSync|null} options.source 站点日志副本（只读）
 * @param {object} options.config 已解析账户配置
 */
export async function runCollectAlerts({
  dashboard,
  source = null,
  config,
  now = Date.now(),
  fetchImpl = globalThis.fetch,
  webhookUrl = process.env[ALERT_WEBHOOK_ENV],
  unmatchedMinUsd = DEFAULT_UNMATCHED_MIN_USD,
  balanceStaleMs = DEFAULT_BALANCE_STALE_MS,
  partialStreak = DEFAULT_PARTIAL_STREAK,
  repeatMs = DEFAULT_REPEAT_MS,
  site = null,
} = {}) {
  if (!dashboard) throw new Error('缺少看板库');

  const { states, channels } = channelRows(dashboard);
  const associations = buildChannelAssociations({
    accounts: config?.accounts ?? [],
    channels,
  });

  const alerts = [
    spendAlert(dashboard, partialStreak),
    channelStateAlert(dashboard),
    ...staleBalanceAlerts(dashboard, config, associations, states, now, balanceStaleMs),
    ...unmappedRevenueAlerts(source, config, associations, states, now, unmatchedMinUsd),
  ].filter(Boolean);

  const pending = syncAlertState(dashboard, alerts, { now, repeatMs });
  const url = webhookConfigured(webhookUrl);
  let sent = 0;
  let sendFailed = false;
  if (url && pending.length > 0) {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(alertPayload(site, pending)),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`webhook HTTP ${response.status}`);
      sent = markAlertsSent(dashboard, pending.map((alert) => alert.alert_key), now);
    } catch {
      sendFailed = true;
    }
  }

  return {
    status: sendFailed ? 'partial' : 'ok',
    active: alerts.length,
    pending: pending.length,
    sent,
    webhook_configured: Boolean(url),
    send_failed: sendFailed,
  };
}

export function openReadOnlySource(file) {
  if (typeof file !== 'string' || !file) return null;
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 3000');
    return db;
  } catch {
    return null;
  }
}
