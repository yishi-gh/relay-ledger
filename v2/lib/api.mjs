/**
 * 看板 API 的查询层：只读站点库 + 读看板库账本，所有 SQL 均参数绑定。
 * 口径见 v2/CONTRACT.md；本站统一过滤 log_type = 2 且排除 'Model test'。
 */

import {
  balanceToleranceMs,
  readCreditEventSum,
  readJobRuns,
  readLastRun,
  readLatestCreditWindow,
  readLatestSnapshot,
  readSpendSum,
} from '../store/dashboard.mjs';
import { readChannelStates, readLiveChannelIds } from '../store/channel-state.mjs';
import { readRoutingSnapshot } from '../store/channel-routing.mjs';
import { channelOwners } from './config.mjs';
import {
  computeMargin,
  evaluateLedger,
  round6,
} from './ledger.mjs';
import { SHARED_DEFAULTS } from './runtime-settings.mjs';
import {
  DAY_MS,
  beijingDayStart,
  dayKey,
  formatLocal,
  isWholeDayRange,
  parseRange,
} from './time.mjs';

/** 本站收入口径的唯一过滤条件，所有本站查询都必须带上 */
export const LOCAL_FILTER = "log_type = 2 AND (token_name IS NULL OR token_name <> 'Model test')";

const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;

/** 只保留 http(s) origin：去掉 userinfo / path / query / hash；解析失败或非 http(s) 返回 null */
function safeOrigin(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  // host 自带端口；userinfo/path/query/hash 全部丢弃
  return `${url.protocol}//${url.host}`;
}

/** model_mapping 仅作为渠道附注：必须是 string→string 对象，非法时不回传原文 */
function parseChannelModelMapping(raw) {
  if (raw === null || raw === undefined || raw === '') {
    return { model_mapping: null, mapping_error: null };
  }
  if (typeof raw !== 'string') {
    return { model_mapping: null, mapping_error: 'model_mapping 不是字符串' };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { model_mapping: null, mapping_error: 'model_mapping 不是合法 JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { model_mapping: null, mapping_error: 'model_mapping 必须是对象' };
  }
  // Object.fromEntries 用定义属性写入，__proto__ 这类键不会被原型 setter 吃掉
  const entries = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      return { model_mapping: null, mapping_error: 'model_mapping 含非字符串值' };
    }
    entries.push([key, value]);
  }
  return { model_mapping: Object.fromEntries(entries), mapping_error: null };
}

/** 渠道状态：1 启用；2/3 停用；其它或 null 未知 */
function routingChannelState(status) {
  if (status === 1) return 'enabled';
  if (status === 2 || status === 3) return 'disabled';
  return 'unknown';
}

/** /api/errors 的区间上限：nginx 聚合按小时存，超过 31 天分桶过密且多半没人看 */
const MAX_ERROR_RANGE_MS = 31 * DAY_MS;

const TREND_BUCKET_SQL = {
  day: "strftime('%Y-%m-%d', t_ms / 1000, 'unixepoch', '+8 hours')",
  hour: "strftime('%Y-%m-%d %H:00', t_ms / 1000, 'unixepoch', '+8 hours')",
};

const ROW_COLUMNS = [
  't_ms',
  't_local',
  'channel_name',
  'model',
  'token_name',
  'cost',
  'quota_raw',
  'input_total',
  'output',
  'cache_read',
  'latency_ms',
  'first_token_ms',
];

const REQUIRED_SOURCE_COLUMNS = {
  logs: [
    't_ms',
    't_local',
    'channel_id',
    'channel_name',
    'model',
    'token_name',
    'cost',
    'quota_raw',
    'input_total',
    'input_uncached',
    'cache_read',
    'cache_write',
    'output',
    'latency_ms',
    'first_token_ms',
    'log_type',
  ],
  error_logs: ['t_ms'],
};

/**
 * 区间内延迟分位数（p50/p95）改为 SQL 侧计算：先按 latency_ms 排序（窗口函数），
 * 只保留 (cnt-1)*p 两侧的至多两行，再按原 JS percentile() 的 R-7 线性插值补齐：
 *   v = lo + (hi - lo) * ((cnt-1)*p - floor((cnt-1)*p))
 * 取整用 CAST(FLOOR(v * 10 + 0.5) AS INTEGER) / 10.0，与 Math.round(v*10)/10 等价。
 * 空集返回 null；单样本原样返回（不取整），均与改造前的实现一致。
 *
 * 改造前 overview()/channels() 会把区间内全部 latency_ms 拉进 Node 再排序（7 天约 5 万行）。
 * partitionBy 用于渠道维度：每个渠道单独排序计数。
 */
function latencyPercentileSql({ partitionBy = null, keyAlias = null } = {}) {
  const keyColumn = partitionBy ? (keyAlias ?? partitionBy) : '';
  // ranked 直接读 logs，必须用原表达式；后续 CTE 只引用别名
  const rankedKey = partitionBy
    ? (keyAlias ? `${partitionBy} AS ${keyAlias}` : partitionBy)
    : '';
  const partition = partitionBy ? `PARTITION BY ${partitionBy} ` : '';
  const groupColumn = partitionBy ? `${keyColumn}, ` : '';
  const groupBy = partitionBy ? `\n       GROUP BY ${keyColumn}` : '';
  const orderBy = partitionBy ? `\n      ORDER BY ${keyColumn}` : '';
  return `
    WITH ranked AS (
      SELECT ${rankedKey ? `${rankedKey}, ` : ''}latency_ms,
             ROW_NUMBER() OVER (${partition}ORDER BY latency_ms) - 1 AS rn,
             COUNT(*) OVER (${partition}) AS cnt
        FROM logs
       WHERE ${LOCAL_FILTER} AND t_ms BETWEEN ? AND ? AND latency_ms IS NOT NULL
    ),
    bounds AS (
      SELECT ${groupColumn}cnt, rn, latency_ms,
             CAST((cnt - 1) * 0.5 AS INTEGER) AS i50,
             CAST((cnt - 1) * 0.95 AS INTEGER) AS i95
        FROM ranked
    ),
    picked AS (
      SELECT ${groupColumn}MAX(cnt) AS cnt,
             MAX(CASE WHEN rn = i50 THEN latency_ms END) AS lo50,
             MAX(CASE WHEN rn = i50 + 1 THEN latency_ms END) AS hi50,
             MAX(CASE WHEN rn = i95 THEN latency_ms END) AS lo95,
             MAX(CASE WHEN rn = i95 + 1 THEN latency_ms END) AS hi95,
             MAX(i50) AS i50,
             MAX(i95) AS i95
        FROM bounds
       WHERE rn IN (i50, i50 + 1, i95, i95 + 1)${groupBy}
    )
    SELECT ${groupColumn}cnt,
           CASE WHEN cnt IS NULL OR cnt = 0 THEN NULL
                WHEN hi50 IS NULL THEN lo50
                ELSE CAST(FLOOR((lo50 + (hi50 - lo50) * ((cnt - 1) * 0.5 - i50)) * 10 + 0.5) AS INTEGER) / 10.0
           END AS p50,
           CASE WHEN cnt IS NULL OR cnt = 0 THEN NULL
                WHEN hi95 IS NULL THEN lo95
                ELSE CAST(FLOOR((lo95 + (hi95 - lo95) * ((cnt - 1) * 0.95 - i95)) * 10 + 0.5) AS INTEGER) / 10.0
           END AS p95
      FROM picked${orderBy}`;
}

const OVERVIEW_LATENCY_SQL = latencyPercentileSql();
const CHANNEL_LATENCY_SQL = latencyPercentileSql({ partitionBy: 'channel_id' });

const UNNAMED_MODEL = '(未标记)';

/** 模型名为 NULL / 空串时统一成一个可展示的名字 */
function normalizeModelName(model) {
  const name = model == null ? '' : String(model);
  return name === '' ? UNNAMED_MODEL : name;
}

/**
 * 每个 key（渠道或分组）取区间内 SUM(cost) 最高的模型。
 *
 * models 行需按「key + model」聚合；NULL 与空串模型在这里合并成 (未标记)。
 * 同额时按归一后的模型名升序，保证结果稳定。
 */
function pickTopModels(rows) {
  const modelsByKey = new Map();
  for (const r of rows) {
    const key = String(r.group_key ?? '');
    const model = normalizeModelName(r.model);
    let models = modelsByKey.get(key);
    if (!models) {
      models = new Map();
      modelsByKey.set(key, models);
    }
    const hit = models.get(model) ?? { model, revenue: 0, tokens: 0 };
    hit.revenue += Number(r.revenue ?? 0);
    hit.tokens += Number(r.input_total ?? 0) + Number(r.output ?? 0);
    models.set(model, hit);
  }

  const topByKey = new Map();
  for (const [key, models] of modelsByKey) {
    let best = null;
    for (const candidate of models.values()) {
      if (best === null
        || candidate.revenue > best.revenue
        || (candidate.revenue === best.revenue && candidate.model < best.model)) {
        best = candidate;
      }
    }
    if (!best) {
      topByKey.set(key, null);
      continue;
    }
    topByKey.set(key, {
      model: best.model,
      revenue: round6(best.revenue),
      tokens: best.tokens,
      per_1e8: best.tokens > 0 ? round6(best.revenue / (best.tokens / 1e8)) : null,
    });
  }
  return topByKey;
}

/**
 * 账户配置的渠道在 channel_state 里的统计：配置总数与其中启用的数量。
 * 只在 channel_state 有数据时调用；渠道 id 去重后计数。
 */
function channelCounts(account, states) {
  const ids = new Set(
    (Array.isArray(account.channels) ? account.channels : [])
      .map(Number)
      .filter((n) => Number.isFinite(n)),
  );
  let live = 0;
  for (const id of ids) {
    if (states.get(id)?.status === 1) live += 1;
  }
  return { channels_total: ids.size, channels_live: live };
}

function intParam(searchParams, name, fallback, { min = 1, max = null, clamp = false } = {}) {
  const raw = searchParams.get(name);
  if (raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new RangeError(`${name} 必须是整数`);
  if (n < min) throw new RangeError(`${name} 不能小于 ${min}`);
  if (max !== null && n > max) {
    // 上界按「最大 200」处理：超限收敛到上界，不报错
    if (clamp) return max;
    throw new RangeError(`${name} 不能大于 ${max}`);
  }
  return n;
}

function tableColumns(db, table) {
  if (!Object.hasOwn(REQUIRED_SOURCE_COLUMNS, table)) return null;
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  } catch {
    return null;
  }
}

const BUCKET_STEP_MS = { day: DAY_MS, hour: 3600000, '15m': 15 * 60 * 1000 };

/**
 * 北京时间分桶（纯函数）：日桶用当日 00:00，小时桶用整点，15m 桶对齐 0/15/30/45 分。
 * UTC+8 是 15 分钟的整数倍，直接按 UTC 毫秒取整即可对齐北京整刻。
 * 只生成与 [from, to] 有交集的桶，覆盖整个区间。
 */
export function profitBuckets(from, to, granularity) {
  const step = BUCKET_STEP_MS[granularity];
  if (!step) throw new RangeError('granularity 只能是 day、hour 或 15m');
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return [];
  const first = granularity === 'day'
    ? beijingDayStart(from)
    : Math.floor(from / step) * step;
  const out = [];
  for (let t = first; t <= to; t += step) {
    // 区间正好结束在边界上时，不生成零宽的空桶（否则末列永远没有成本）
    if (t === to && t !== first) break;
    out.push({
      t_ms: t,
      label: granularity === 'day'
        ? dayKey(t)
        : granularity === '15m'
          ? formatLocal(t).slice(0, 16)
          : `${formatLocal(t).slice(0, 13)}:00`,
    });
  }
  return out;
}

/**
 * 快照允许偏离桶边界的距离。
 *
 * 整点采集在 HH:00:10 左右落库，若按「t_ms ≤ 边界」取期初，整点桶会整体错位一小时。
 * 因此边界取「距边界最近且在容差内」的快照（可在边界之后）；容差要远小于一个桶，
 * 这样缺采的桶不会拿相邻快照顶替，而是返回 null。
 */
export const SNAPSHOT_BOUNDARY_TOLERANCE_MS = 5 * 60 * 1000;

function firstIndexAtOrAfter(snapshots, ms) {
  let lo = 0;
  let hi = snapshots.length - 1;
  let ans = snapshots.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (snapshots[mid].t_ms >= ms) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans;
}

/** 快照数组（t_ms 升序）中距 boundaryMs 最近、偏差不超过 tolerance 的那条快照；否则 null */
function snapshotObjectNear(snapshots, boundaryMs, tolerance) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) return null;
  const after = firstIndexAtOrAfter(snapshots, boundaryMs);
  const candidates = [after - 1, after].filter((i) => i >= 0 && i < snapshots.length);
  let best = null;
  let bestDiff = Infinity;
  for (const i of candidates) {
    const diff = Math.abs(snapshots[i].t_ms - boundaryMs);
    if (diff < bestDiff) {
      best = snapshots[i];
      bestDiff = diff;
    }
  }
  if (best === null || bestDiff > tolerance) return null;
  if (typeof best.balance !== 'number' || !Number.isFinite(best.balance)) return null;
  return best;
}

/** 快照数组（t_ms 升序）中距 boundaryMs 最近、偏差不超过 tolerance 的余额；否则 null */
function snapshotNear(snapshots, boundaryMs, tolerance) {
  const snap = snapshotObjectNear(snapshots, boundaryMs, tolerance);
  return snap ? snap.balance : null;
}

/** boundaryMs 之前最近一条快照（整条）；超出容差或无快照返回 null */
function latestSnapshotObject(snapshots, boundaryMs, tolerance) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) return null;
  const idx = firstIndexAtOrAfter(snapshots, boundaryMs + 1) - 1;
  if (idx < 0) return null;
  const row = snapshots[idx];
  if (typeof row.balance !== 'number' || !Number.isFinite(row.balance)) return null;
  if (boundaryMs - row.t_ms > tolerance) return null;
  return row;
}

/** 快照数组（t_ms 升序）中 boundaryMs 之前最近一条的余额；超出容差或无快照返回 null */
function latestSnapshotBalance(snapshots, boundaryMs, tolerance) {
  const snap = latestSnapshotObject(snapshots, boundaryMs, tolerance);
  return snap ? snap.balance : null;
}

/**
 * 两端快照都带累计充值总额（sub2api 的 total_recharged）时，差值就是真实充值额。
 * 这样同一小时内的充值与消费不会互相抵消；没有该字段的上游返回 null，交给事件流。
 */
function rechargeDeltaBetween(openingSnapshot, closingSnapshot) {
  const from = openingSnapshot?.total_recharged;
  const to = closingSnapshot?.total_recharged;
  if (typeof from !== 'number' || typeof to !== 'number') return null;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  const delta = to - from;
  return delta >= 0 ? delta : null;
}

/** 区间 [fromInclusive, toExclusive) 的入账合计；没有事件即 0 */
function sumAmountsInWindow(events, fromInclusive, toExclusive) {
  if (!Array.isArray(events) || events.length === 0) return 0;
  let sum = 0;
  for (const e of events) {
    if (e.t_ms >= fromInclusive && e.t_ms < toExclusive
      && typeof e.amount === 'number' && Number.isFinite(e.amount)) {
      sum += e.amount;
    }
  }
  return sum;
}

/**
 * 站点盈利核算（纯函数，无 IO）。
 *
 * revenueRows：已按「桶标签 + channel_id」聚合的售出金额；
 * snapshotsByAccount / creditEventsByAccount：按账户分组、按 t_ms 升序的快照与充值事件。
 *
 * 成本 = 期初 + credits − 期末；期初/期末取桶边界附近（±5 分钟）的快照，
 * 缺任一端或结果为负时该桶 cost 为 null，不用 0 或相邻桶插值。
 * 最后一个未走完的桶用「不晚于 now 的最近快照」做期末，最多容忍 90 分钟。区间合计只在所有桶均可计算时给值，保证与序列一致。
 */
export function buildProfit({
  granularity,
  from,
  to,
  accounts = [],
  buckets = [],
  revenueRows = [],
  snapshotsByAccount = {},
  creditEventsByAccount = {},
} = {}) {
  const step = BUCKET_STEP_MS[granularity] ?? DAY_MS;
  const liveTolerance = balanceToleranceMs('hour');
  const length = buckets.length;
  const indexByLabel = new Map(buckets.map((b, i) => [b.label, i]));

  // 渠道归属：一个渠道只记到第一个账户，避免重复计算；停用账户只作兜底归属，
  // 否则它名下的渠道会被算成「未映射」，把停用站点的售出从站点盈利里抹掉
  const ordered = [...accounts].sort(
    (a, b) => Number(b.enabled !== false) - Number(a.enabled !== false),
  );
  const ownerOf = new Map();
  for (const account of ordered) {
    for (const channelId of account.channels ?? []) {
      if (!ownerOf.has(channelId)) ownerOf.set(channelId, account.id);
    }
  }

  const channelSeries = new Map();
  const siteRevenue = Object.fromEntries(accounts.map((a) => [a.id, new Array(length).fill(0)]));
  const unmappedPoints = new Array(length).fill(0);

  for (const row of revenueRows) {
    const idx = indexByLabel.get(row.bucket);
    if (idx === undefined) continue;
    const revenue = round6(row.revenue ?? 0) ?? 0;
    const channelId = row.channel_id;
    let series = channelSeries.get(channelId);
    if (!series) {
      series = {
        channel_id: channelId,
        channel_name: row.channel_name ?? '',
        points: new Array(length).fill(0),
      };
      channelSeries.set(channelId, series);
    } else if (row.channel_name) {
      series.channel_name = row.channel_name;
    }
    series.points[idx] = round6(series.points[idx] + revenue) ?? series.points[idx];

    const owner = ownerOf.get(channelId);
    if (owner === undefined) {
      unmappedPoints[idx] = round6(unmappedPoints[idx] + revenue) ?? unmappedPoints[idx];
    } else {
      siteRevenue[owner][idx] = round6(siteRevenue[owner][idx] + revenue) ?? siteRevenue[owner][idx];
    }
  }

  const revenueBySite = {};
  const costBySite = {};
  const profitBySite = {};
  const marginBySite = {};
  const sites = [];

  for (const account of ordered) {
    const revenuePoints = siteRevenue[account.id];
    const snapshots = snapshotsByAccount[account.id] ?? [];
    const events = creditEventsByAccount[account.id] ?? [];
    const costPoints = new Array(length).fill(null);
    const profitPoints = new Array(length).fill(null);
    const marginPoints = new Array(length).fill(null);
    let hasMissing = false;
    let hasNegative = false;
    let creditsTotal = 0;
    let coveredBuckets = 0;
    // 没有上游账户的渠道（如 opencode go）：只统计售出，成本恒为 null，不参与毛利率
    const external = account.kind === 'external';

    for (let i = 0; i < length && !external; i += 1) {
      const bucketStart = buckets[i].t_ms;
      const start = Math.max(bucketStart, from);
      const naturalEnd = bucketStart + step;
      const endExclusive = Math.min(naturalEnd, to + 1);
      // 最后一个桶还没走完：期末取不晚于 now 的最近快照，最多容忍一个采集周期
      const isLive = endExclusive < naturalEnd;
      const openingSnap = snapshotObjectNear(snapshots, start, SNAPSHOT_BOUNDARY_TOLERANCE_MS);
      const closingSnap = isLive
        ? latestSnapshotObject(snapshots, endExclusive, liveTolerance)
        : snapshotObjectNear(snapshots, endExclusive, SNAPSHOT_BOUNDARY_TOLERANCE_MS);
      // 有累计充值总额就用它的差值，否则退回事件流（newapi 的 topup/gift）
      const rechargeDelta = rechargeDeltaBetween(openingSnap, closingSnap);
      const credits = rechargeDelta ?? sumAmountsInWindow(events, start, endExclusive);
      creditsTotal += credits;

      if (openingSnap === null || closingSnap === null) {
        hasMissing = true;
        continue;
      }
      const opening = openingSnap.balance;
      const closing = closingSnap.balance;
      const cost = opening + credits - closing;
      if (cost < 0) {
        hasNegative = true;
        continue;
      }
      costPoints[i] = round6(cost);
      coveredBuckets += 1;
      const profit = round6(revenuePoints[i] - costPoints[i]);
      profitPoints[i] = profit;
      marginPoints[i] = revenuePoints[i] > 0 ? round6(profit / revenuePoints[i]) : null;
    }

    const revenue = round6(revenuePoints.reduce((s, v) => s + (v ?? 0), 0)) ?? 0;
    const cost = external || hasMissing || hasNegative
      ? null
      : round6(costPoints.reduce((s, v) => s + (v ?? 0), 0));
    const profit = cost === null ? null : round6(revenue - cost);
    const margin = cost === null || revenue === 0 ? null : round6((revenue - cost) / revenue);
    let status;
    if (external) status = 'no_cost';
    else if (hasMissing) status = 'missing_balance';
    else if (hasNegative) status = 'partial';
    else if (revenue === 0) status = 'no_revenue';
    else status = 'complete';

    sites.push({
      account_id: account.id,
      name: account.name ?? account.id,
      channels: [...(account.channels ?? [])],
      kind: account.kind ?? null,
      enabled: account.enabled !== false,
      revenue,
      credits: round6(creditsTotal) ?? 0,
      cost,
      profit,
      margin,
      status,
      // 区间内能算出成本的桶数：合计为 null 时前端据此说明「缺多少」
      covered_buckets: coveredBuckets,
      bucket_count: length,
    });
    revenueBySite[account.id] = revenuePoints;
    costBySite[account.id] = costPoints;
    profitBySite[account.id] = profitPoints;
    marginBySite[account.id] = marginPoints;
  }

  const revenueByChannel = [...channelSeries.values()]
    .map((s) => ({
      channel_id: s.channel_id,
      channel_name: s.channel_name,
      account_id: ownerOf.get(s.channel_id) ?? null,
      points: s.points,
    }))
    .sort((a, b) => {
      const sum = (p) => p.points.reduce((s, v) => s + (v ?? 0), 0);
      return sum(b) - sum(a) || (a.channel_id ?? 0) - (b.channel_id ?? 0);
    });

  const unmappedChannels = [...channelSeries.values()]
    .filter((s) => !ownerOf.has(s.channel_id))
    .map((s) => ({
      channel_id: s.channel_id,
      channel_name: s.channel_name,
      revenue: round6(s.points.reduce((sum, v) => sum + (v ?? 0), 0)) ?? 0,
    }))
    .sort((a, b) => b.revenue - a.revenue || (a.channel_id ?? 0) - (b.channel_id ?? 0));

  // 缺快照的小时数按小时粒度统计，与所选粒度无关
  const hourBuckets = profitBuckets(from, to, 'hour');
  const hourTolerance = balanceToleranceMs('hour');
  let hoursWithoutSnapshot = 0;
  for (const account of accounts) {
    if (account.enabled === false) continue;
    const snapshots = snapshotsByAccount[account.id] ?? [];
    for (const bucket of hourBuckets) {
      const start = Math.max(bucket.t_ms, from);
      const end = Math.min(bucket.t_ms + BUCKET_STEP_MS.hour - 1, to);
      if (latestSnapshotBalance(snapshots, start, hourTolerance) === null
        || latestSnapshotBalance(snapshots, end, hourTolerance) === null) {
        hoursWithoutSnapshot += 1;
      }
    }
  }

  return {
    granularity,
    from,
    to,
    buckets,
    sites,
    series: {
      revenue_by_channel: revenueByChannel,
      revenue_by_site: revenueBySite,
      cost_by_site: costBySite,
      profit_by_site: profitBySite,
      margin_by_site: marginBySite,
    },
    unmapped: {
      revenue: round6(unmappedPoints.reduce((s, v) => s + (v ?? 0), 0)) ?? 0,
      points: unmappedPoints,
      channels: unmappedChannels,
    },
    quality: {
      accounts_missing_balance: sites
        // 停用账户本来就不会有快照，混进来会把「缺余额」的质量告警淹没
        .filter((s) => s.enabled !== false && s.status === 'missing_balance')
        .map((s) => s.account_id),
      hours_without_snapshot: hoursWithoutSnapshot,
    },
  };
}

export function createApi({
  source,
  dashboard,
  config,
  siteName,
  sourceLabel,
  getHealthSettings = () => SHARED_DEFAULTS.health,
}) {
  const owners = channelOwners(config);
  const columns = Object.fromEntries(
    Object.keys(REQUIRED_SOURCE_COLUMNS).map((t) => [t, tableColumns(source, t)]),
  );
  // 老库可能没有 group_name（不在 REQUIRED_SOURCE_COLUMNS 里）：整段归入未分组
  const hasGroupName = Boolean(columns.logs?.has('group_name'));
  const GROUP_KEY_SQL = hasGroupName ? "COALESCE(group_name, '')" : "''";
  const GROUP_LATENCY_SQL = hasGroupName
    ? latencyPercentileSql({ partitionBy: "COALESCE(group_name, '')", keyAlias: 'group_key' })
    : null;
  // user_name 同样不在 REQUIRED_SOURCE_COLUMNS 里：缺列时整段归入未命名用户
  const USER_KEY_SQL = columns.logs?.has('user_name') ? "COALESCE(user_name, '')" : "''";

  function sourceMaxT() {
    // 只取本站计费日志的终点：最新的充值/系统日志不该把默认范围往前推
    const row = source.prepare('SELECT MAX(t_ms) AS max_t FROM logs WHERE log_type = 2').get();
    return row && typeof row.max_t === 'number' ? row.max_t : null;
  }

  function resolveRange(searchParams) {
    return parseRange(searchParams, sourceMaxT());
  }

  function schemaOkay() {
    for (const [table, required] of Object.entries(REQUIRED_SOURCE_COLUMNS)) {
      const actual = columns[table];
      if (!actual) return false;
      if (required.some((c) => !actual.has(c))) return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // 归档（logs_daily）：日粒度历史只补总量与日桶，不改变明细查询的 SQL 语义
  // -------------------------------------------------------------------------

  /** 归档表在看板库里；老库可能没有这张表（只缓存「存在」，建表后无需重启） */
  let archiveTableSeen = false;
  function archiveTableExists() {
    if (archiveTableSeen) return true;
    if (!siteName) return false;
    try {
      archiveTableSeen = Boolean(
        dashboard
          .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'logs_daily'")
          .get(),
      );
    } catch {
      archiveTableSeen = false;
    }
    return archiveTableSeen;
  }

  /** 明细里最早一条的北京日界；没有明细时返回 null（归档可覆盖整段区间） */
  function detailFloorMs() {
    const row = source.prepare('SELECT MIN(t_ms) AS min_t FROM logs').get();
    return typeof row?.min_t === 'number' && Number.isFinite(row.min_t)
      ? beijingDayStart(row.min_t)
      : null;
  }

  /**
   * 归档并入的日区间：只取「完整落在 [from, to] 内」且「早于明细最早一天」的北京自然日。
   * 归档只有日粒度，边界日无法折算成小时；宁可少算也不与明细重复计数。
   * 没有可用归档时返回 null。
   */
  function archiveDays(range) {
    if (!archiveTableExists()) return null;
    const fromStart = beijingDayStart(range.from);
    const firstStart = range.from === fromStart ? fromStart : fromStart + DAY_MS;
    const toStart = beijingDayStart(range.to);
    let lastStart = range.to >= toStart + DAY_MS - 1 ? toStart : toStart - DAY_MS;
    const floor = detailFloorMs();
    if (floor !== null) lastStart = Math.min(lastStart, floor - DAY_MS);
    if (firstStart > lastStart) return null;

    const fromDay = dayKey(firstStart);
    const toDay = dayKey(lastStart);
    // 有归档行的天可能不连续（无流量的天没有行）：from/to 取实际并入的首末天
    const row = dashboard.prepare(
      `SELECT COUNT(DISTINCT day) AS days, MIN(day) AS from_day, MAX(day) AS to_day
         FROM logs_daily
        WHERE site = ? AND day >= ? AND day <= ?`,
    ).get(siteName, fromDay, toDay);
    const days = Number(row?.days ?? 0);
    return days > 0 ? { fromDay: row.from_day, toDay: row.to_day, days } : null;
  }

  /** 各接口顶层的 archive 标注：可用性、覆盖日区间、以及归档给不出的字段 */
  function archiveInfo(archive, partialFields = []) {
    return {
      from_day: archive ? archive.fromDay : null,
      to_day: archive ? archive.toDay : null,
      days: archive ? archive.days : 0,
      available: Boolean(archive),
      partial_fields: archive ? [...partialFields] : [],
    };
  }

  /** 归档区间的标量汇总（overview / upstreams 用） */
  function archiveTotals(range) {
    const span = archiveDays(range);
    if (!span) return null;
    const row = dashboard.prepare(
      `SELECT COALESCE(SUM(requests), 0) AS requests,
              COALESCE(SUM(cost), 0) AS cost,
              COALESCE(SUM(quota_raw), 0) AS quota,
              COALESCE(SUM(input_total), 0) AS input_total,
              COALESCE(SUM(output), 0) AS output
         FROM logs_daily
        WHERE site = ? AND day >= ? AND day <= ?`,
    ).get(siteName, span.fromDay, span.toDay);
    return {
      ...span,
      requests: Number(row?.requests ?? 0),
      cost: Number(row?.cost ?? 0),
      quota: Number(row?.quota ?? 0),
      input_total: Number(row?.input_total ?? 0),
      output: Number(row?.output ?? 0),
    };
  }

  /** 归档区间的按日汇总（trend / profit 的 day 粒度用） */
  function archiveByDay(range, { withChannel = false } = {}) {
    const span = archiveDays(range);
    if (!span) return null;
    const rows = withChannel
      ? dashboard.prepare(
        `SELECT day AS bucket, channel_id, MAX(channel_name) AS channel_name,
                COALESCE(SUM(cost), 0) AS revenue
           FROM logs_daily
          WHERE site = ? AND day >= ? AND day <= ?
          GROUP BY day, channel_id
          ORDER BY day, channel_id`,
      ).all(siteName, span.fromDay, span.toDay)
      : dashboard.prepare(
        `SELECT day AS bucket,
                COALESCE(SUM(cost), 0) AS revenue,
                COALESCE(SUM(quota_raw), 0) AS quota,
                COALESCE(SUM(requests), 0) AS requests,
                COALESCE(SUM(input_total), 0) AS input_total,
                COALESCE(SUM(output), 0) AS output
           FROM logs_daily
          WHERE site = ? AND day >= ? AND day <= ?
          GROUP BY day
          ORDER BY day`,
      ).all(siteName, span.fromDay, span.toDay);
    return rows.length > 0 ? { ...span, rows } : null;
  }

  /** 归档区间的按渠道汇总（channels 用） */
  function archiveByChannel(range) {
    const span = archiveDays(range);
    if (!span) return null;
    const rows = dashboard.prepare(
      `SELECT channel_id,
              MAX(channel_name) AS channel_name,
              COALESCE(SUM(requests), 0) AS requests,
              COALESCE(SUM(cost), 0) AS revenue,
              COALESCE(SUM(quota_raw), 0) AS quota,
              COALESCE(SUM(input_total), 0) AS input_total,
              COALESCE(SUM(output), 0) AS output
         FROM logs_daily
        WHERE site = ? AND day >= ? AND day <= ?
        GROUP BY channel_id
        ORDER BY revenue DESC, requests DESC, channel_id ASC`,
    ).all(siteName, span.fromDay, span.toDay);
    return rows.length > 0 ? { ...span, rows } : null;
  }

  /** 归档里指定渠道的售出合计（overview / upstreams 的账户口径） */
  function archiveChannelCost(channels, range) {
    if (!channels.length) return 0;
    const span = archiveDays(range);
    if (!span) return 0;
    const placeholders = channels.map(() => '?').join(', ');
    const row = dashboard.prepare(
      `SELECT COALESCE(SUM(cost), 0) AS revenue
         FROM logs_daily
        WHERE site = ? AND day >= ? AND day <= ? AND channel_id IN (${placeholders})`,
    ).get(siteName, span.fromDay, span.toDay, ...channels);
    return Number(row?.revenue ?? 0);
  }

  function meta() {
    const row = source.prepare(
      'SELECT COUNT(*) AS rows, MIN(t_ms) AS min_t, MAX(t_ms) AS max_t FROM logs',
    ).get();
    return {
      site: siteName,
      source: sourceLabel,
      min_t: row?.min_t ?? null,
      max_t: row?.max_t ?? null,
      rows: row?.rows ?? 0,
      currency: config.currency,
      quota_per_unit: config.quota_per_unit,
    };
  }

  function accountRevenue(channels, range) {
    if (!channels.length) return 0;
    const placeholders = channels.map(() => '?').join(', ');
    const row = source.prepare(
      `SELECT COALESCE(SUM(cost), 0) AS revenue
         FROM logs
        WHERE ${LOCAL_FILTER} AND t_ms BETWEEN ? AND ? AND channel_id IN (${placeholders})`,
    ).get(range.from, range.to, ...channels);
    // 明细窗口之外的日聚合也记在账户名下，否则 overview 的总额与账户明细对不上
    return (row?.revenue ?? 0) + archiveChannelCost(channels, range);
  }

  function buildAccounts(range) {
    const completeDay = isWholeDayRange(range.from, range.to);
    const now = Date.now();
    // 边界口径与盈利面板一致：期初/期末必须是贴着边界的快照（±5 分钟）。
    // 用 26 小时容差会把前一天的余额当成本期期初，等于把两天的消费算进一天，
    // 成本偏大甚至为负；宁可返回 null，由前端显示「待接快照」。
    // 唯一例外是区间终点就在此刻：此时期末只能取不晚于终点的最近一条（最多 90 分钟）。
    const liveEnd = Math.abs(now - range.to) <= SNAPSHOT_BOUNDARY_TOLERANCE_MS;
    const snapshotStmt = dashboard.prepare(
      `SELECT t_ms, balance, currency, raw_balance, raw_unit, total_recharged
         FROM balance_snapshot
        WHERE account_id = ? AND t_ms >= ? AND t_ms <= ?
        ORDER BY t_ms ASC`,
    );
    const boundarySnapshot = (snapshots, boundaryMs, live = false) => {
      const hit = snapshotObjectNear(snapshots, boundaryMs, SNAPSHOT_BOUNDARY_TOLERANCE_MS)
        ?? (live ? latestSnapshotObject(snapshots, boundaryMs, balanceToleranceMs('hour')) : null);
      if (!hit) return null;
      return {
        balance: hit.balance,
        t_ms: hit.t_ms,
        currency: hit.currency ?? null,
        raw_balance: typeof hit.raw_balance === 'number' ? hit.raw_balance : null,
        raw_unit: hit.raw_unit ?? null,
        total_recharged: typeof hit.total_recharged === 'number' ? hit.total_recharged : null,
        fresh: true,
      };
    };
    const todayStart = beijingDayStart(now);
    const today = dayKey(now);
    const rangeFromDay = dayKey(range.from);
    const rangeToDay = dayKey(range.to);
    const lastCollect = readLastRun(dashboard, 'collect-spend');

    // 不再过滤停用账户：面板要显示它们的「已禁用」状态并排在末尾。
    // 停用账户没有快照，账本自然是 unavailable，不影响别的账户。
    return config.accounts
      .map((a) => {
        const snapshots = snapshotStmt
          .all(
            a.id,
            range.from - SNAPSHOT_BOUNDARY_TOLERANCE_MS,
            range.to + balanceToleranceMs('hour'),
          )
          .filter((r) => typeof r.balance === 'number' && Number.isFinite(r.balance));
        const opening = boundarySnapshot(snapshots, range.from);
        const closing = boundarySnapshot(snapshots, range.to, liveEnd);
        // 充值按 credit_event 汇总（与盈利面板同口径），不再依赖 credit_window 覆盖整个区间：
        // 采集器只写「昨天整日」和「今天 00:00~本次采集」两个窗口，以「现在」为终点的区间
        // 永远没有窗口覆盖，会导致成本恒为 null。
        // 充值：sub2api 用累计充值总额的差值（真实值），其余上游退回 credit_event 汇总
        const rechargeDelta = rechargeDeltaBetween(opening, closing);
        const creditSum = rechargeDelta === null
          ? readCreditEventSum(dashboard, a.id, range.from, range.to)
          : { total: rechargeDelta, count: 0 };
        const creditsInfo = { credits: creditSum.total, events: creditSum.count };
        const verdict = evaluateLedger({
          opening: opening ? opening.balance : null,
          closing: closing ? closing.balance : null,
          credits: creditsInfo.credits,
          completeDay,
          openingFresh: opening ? opening.fresh : false,
          closingFresh: closing ? closing.fresh : false,
          configured: Boolean(a.base_url),
        });
        const revenue = accountRevenue(a.channels, range);
        const margin = computeMargin({ revenue, consumption: verdict.consumption });
        const latest = readLatestSnapshot(dashboard, a.id);
        const todayWindow = readLatestCreditWindow(dashboard, a.id, todayStart);
        const spendToday = readSpendSum(dashboard, a.id, today, today);
        const spendRange = readSpendSum(dashboard, a.id, rangeFromDay, rangeToDay);
        return {
          id: a.id,
          name: a.name,
          kind: a.kind,
          base_url: a.base_url,
          status: verdict.status,
          reason: verdict.reason,
          opening_balance: opening ? opening.balance : null,
          closing_balance: closing ? closing.balance : null,
          // 原始值与原始单位（未归一，如 newapi 的 quota），仅供核对，不参与计算
          opening_raw: opening ? { balance: opening.raw_balance, unit: opening.raw_unit } : null,
          closing_raw: closing ? { balance: closing.raw_balance, unit: closing.raw_unit } : null,
          credits: typeof creditsInfo.credits === 'number' ? round6(creditsInfo.credits) : null,
          credit_events: creditsInfo.events,
          balance_delta: verdict.balance_delta,
          consumption: verdict.consumption,
          // 今日（北京自然日）入账：只取已确认窗口，未知为 null
          credits_today: todayWindow ? round6(todayWindow.credits) : null,
          credits_today_at: todayWindow ? todayWindow.window_end : null,
          // 上游自报消费（USD）：今日与所选区间，按已写入的按日数据求和；
          // reported_consumption 与前端约定字段同名，等价于今日值
          reported_consumption: spendToday === null ? null : round6(spendToday),
          reported_spend_today: spendToday === null ? null : round6(spendToday),
          reported_spend_range: spendRange === null ? null : round6(spendRange),
          // 最后同步：最新余额快照时间（毫秒），前端按时间格式化
          last_sync: latest ? latest.t_ms : null,
          last_sync_balance: latest ? { balance: latest.balance, currency: latest.currency } : null,
          last_job: lastCollect
            ? {
                job: lastCollect.job,
                finished_at: lastCollect.finished_at,
                status: lastCollect.status,
              }
            : null,
          unit: a.unit || config.currency,
          local_revenue: round6(revenue),
          margin: margin.margin,
          margin_pct: margin.marginPct,
          channels: a.channels,
          // 前端要区分「已禁用」和「没有上游账户」（external），两者都显式下发。
          enabled: a.enabled !== false,
          external: a.kind === 'external',
        };
      });
  }

  function upstreamSummary(accounts, revenue) {
    if (!accounts.length) {
      return { upstream_cost: null, margin: null, margin_status: 'unconfigured' };
    }
    const known = accounts.filter((a) => a.consumption !== null);
    if (!known.length) {
      const statuses = new Set(accounts.map((a) => a.status));
      return {
        upstream_cost: null,
        margin: null,
        margin_status: statuses.has('partial') ? 'partial' : 'unavailable',
      };
    }
    const cost = round6(known.reduce((sum, a) => sum + a.consumption, 0));
    const margin = computeMargin({ revenue, consumption: cost });
    const marginStatus = accounts.every((a) => a.status === 'complete') ? 'complete' : 'partial';
    return { upstream_cost: cost, margin: margin.margin, margin_status: marginStatus };
  }

  /**
   * 预载账户快照与充值事件并交给 buildProfit：profit 与 capital 共用同一套账本口径
   * （边界容差、credits 事件流、缺快照为 null），避免两处各写一遍。
   */
  function ledgerSeries(accounts, { from, to, granularity, revenueRows = [] }) {
    // 快照需覆盖「区间起点 − 最大容差」到「区间终点 + 桶边界容差」：
    // 更旧的值一律视为缺失，末桶的期末快照可能落在 to 之后几秒
    const preloadTolerance = balanceToleranceMs('day');
    const snapshotStmt = dashboard.prepare(
      `SELECT t_ms, balance, total_recharged
         FROM balance_snapshot
        WHERE account_id = ? AND t_ms >= ? AND t_ms <= ?
        ORDER BY t_ms ASC`,
    );
    const creditStmt = dashboard.prepare(
      `SELECT t_ms, amount
         FROM credit_event
        WHERE account_id = ? AND t_ms >= ? AND t_ms <= ?
        ORDER BY t_ms ASC`,
    );

    const snapshotsByAccount = {};
    const creditEventsByAccount = {};
    for (const account of accounts) {
      snapshotsByAccount[account.id] = snapshotStmt
        .all(account.id, from - preloadTolerance, to + SNAPSHOT_BOUNDARY_TOLERANCE_MS)
        .filter((r) => typeof r.balance === 'number' && Number.isFinite(r.balance))
        .map((r) => ({
          t_ms: r.t_ms,
          balance: r.balance,
          total_recharged: typeof r.total_recharged === 'number' ? r.total_recharged : null,
        }));
      creditEventsByAccount[account.id] = creditStmt
        .all(account.id, from, to + 1)
        .filter((r) => typeof r.amount === 'number' && Number.isFinite(r.amount))
        .map((r) => ({ t_ms: r.t_ms, amount: r.amount }));
    }

    return buildProfit({
      granularity,
      from,
      to,
      accounts,
      buckets: profitBuckets(from, to, granularity),
      revenueRows,
      snapshotsByAccount,
      creditEventsByAccount,
    });
  }

  function overview(searchParams) {
    const range = resolveRange(searchParams);
    const agg = source.prepare(
      `SELECT COUNT(*) AS requests,
              COALESCE(SUM(cost), 0) AS revenue,
              COALESCE(SUM(quota_raw), 0) AS quota,
              COALESCE(SUM(input_total), 0) AS input_total,
              COALESCE(SUM(input_uncached), 0) AS input_uncached,
              COALESCE(SUM(cache_read), 0) AS cache_read,
              COALESCE(SUM(cache_write), 0) AS cache_write,
              COALESCE(SUM(output), 0) AS output
         FROM logs
        WHERE ${LOCAL_FILTER} AND t_ms BETWEEN ? AND ?`,
    ).get(range.from, range.to);

    const latency = source.prepare(OVERVIEW_LATENCY_SQL).get(range.from, range.to);

    const archive = archiveTotals(range);
    const cacheDenominator = (agg.cache_read ?? 0) + (agg.input_uncached ?? 0);
    const inputTotal = (agg.input_total ?? 0) + (archive?.input_total ?? 0);
    const output = (agg.output ?? 0) + (archive?.output ?? 0);
    const revenue = round6((agg.revenue ?? 0) + (archive?.cost ?? 0));
    // KPI 只统计真正参与成本核算的账户：停用账户和没有上游账户的（external）
    // 永远不可能有余额，放进去会把 margin_status 拉成 unavailable。
    const costAccounts = buildAccounts(range).filter((a) => a.enabled && !a.external);
    const upstream = upstreamSummary(costAccounts, revenue);

    return {
      range,
      revenue,
      quota: (agg.quota ?? 0) + (archive?.quota ?? 0),
      requests: (agg.requests ?? 0) + (archive?.requests ?? 0),
      tokens: {
        // 归档只有 input_total / output 两列，合计口径与明细一致；
        // input_uncached / cache_* 不在归档里，仍是明细窗口的值（见 archive.partial_fields）
        total: inputTotal + output,
        input_total: inputTotal,
        input_uncached: agg.input_uncached ?? 0,
        cache_read: agg.cache_read ?? 0,
        cache_write: agg.cache_write ?? 0,
        output,
      },
      cache_rate: cacheDenominator > 0 ? round6((agg.cache_read ?? 0) / cacheDenominator) : null,
      latency: {
        p50: latency?.p50 ?? null,
        p95: latency?.p95 ?? null,
        count: latency?.cnt ?? 0,
      },
      archive: archiveInfo(archive, [
        'tokens.input_uncached',
        'tokens.cache_read',
        'tokens.cache_write',
        'cache_rate',
        'latency',
      ]),
      upstream_cost: upstream.upstream_cost,
      margin: upstream.margin,
      margin_status: upstream.margin_status,
    };
  }

  function trend(searchParams) {
    const granularity = searchParams.get('granularity') ?? 'day';
    if (!Object.hasOwn(TREND_BUCKET_SQL, granularity)) {
      throw new RangeError('granularity 只能是 day 或 hour');
    }
    const range = resolveRange(searchParams);
    const rows = source.prepare(
      `SELECT ${TREND_BUCKET_SQL[granularity]} AS bucket,
              COALESCE(SUM(cost), 0) AS revenue,
              COALESCE(SUM(quota_raw), 0) AS quota,
              COUNT(*) AS requests,
              COALESCE(SUM(input_total), 0) AS input_total,
              COALESCE(SUM(output), 0) AS output,
              COALESCE(SUM(cache_read), 0) AS cache_read,
              COALESCE(SUM(input_uncached), 0) AS input_uncached
         FROM logs
        WHERE ${LOCAL_FILTER} AND t_ms BETWEEN ? AND ?
        GROUP BY bucket
        ORDER BY bucket`,
    ).all(range.from, range.to);

    // 归档只有日粒度：day 桶直接并入 logs_daily 的日汇总，hour 桶保持只覆盖明细窗口
    const archive = granularity === 'day' ? archiveByDay(range) : null;
    const byBucket = new Map(
      rows.map((r) => {
        const cacheRead = r.cache_read ?? 0;
        const cacheDenominator = cacheRead + (r.input_uncached ?? 0);
        return [
          r.bucket,
          {
            bucket: r.bucket,
            revenue: round6(r.revenue ?? 0),
            quota: r.quota ?? 0,
            requests: r.requests ?? 0,
            tokens: (r.input_total ?? 0) + (r.output ?? 0),
            cache_rate: cacheDenominator > 0 ? round6(cacheRead / cacheDenominator) : null,
          },
        ];
      }),
    );
    for (const r of archive?.rows ?? []) {
      const hit = byBucket.get(r.bucket);
      const tokens = (r.input_total ?? 0) + (r.output ?? 0);
      if (hit) {
        hit.revenue = round6(hit.revenue + (r.revenue ?? 0));
        hit.quota += r.quota ?? 0;
        hit.requests += r.requests ?? 0;
        hit.tokens += tokens;
        // 归档没有 cache 字段：同桶只要混入归档，就不能把明细的不完整率当全量
        hit.cache_rate = null;
      } else {
        byBucket.set(r.bucket, {
          bucket: r.bucket,
          revenue: round6(r.revenue ?? 0),
          quota: r.quota ?? 0,
          requests: r.requests ?? 0,
          tokens,
          cache_rate: null,
        });
      }
    }
    const points = [...byBucket.values()].sort((a, b) => (a.bucket < b.bucket ? -1 : 1));

    return {
      granularity,
      points,
      archive: archiveInfo(archive, ['cache_rate']),
    };
  }

  function profit(searchParams) {
    const granularity = searchParams.get('granularity') ?? 'day';
    if (!Object.hasOwn(TREND_BUCKET_SQL, granularity)) {
      throw new RangeError('granularity 只能是 day 或 hour');
    }
    const range = resolveRange(searchParams);
    const accounts = config.accounts
      .map((a) => ({
        id: a.id,
        name: a.name,
        kind: a.kind,
        channels: a.channels,
        // 停用账户仍参与渠道归属：它的渠道在卖，售出要记到它名下而不是「未映射」
        enabled: a.enabled !== false,
      }));

    const revenueRows = source.prepare(
      `SELECT ${TREND_BUCKET_SQL[granularity]} AS bucket,
              channel_id,
              MAX(channel_name) AS channel_name,
              COALESCE(SUM(cost), 0) AS revenue
         FROM logs
        WHERE ${LOCAL_FILTER} AND t_ms BETWEEN ? AND ?
        GROUP BY bucket, channel_id`,
    ).all(range.from, range.to);

    // 售出按日归档：day 粒度把归档日并入对应渠道/账户的日桶，hour 粒度不变
    const archive = granularity === 'day' ? archiveByDay(range, { withChannel: true }) : null;
    const allRevenueRows = archive ? [...revenueRows, ...archive.rows] : revenueRows;

    return {
      ...ledgerSeries(accounts, {
        from: range.from,
        to: range.to,
        granularity,
        revenueRows: allRevenueRows,
      }),
      archive: archiveInfo(archive),
    };
  }

  function channels(searchParams) {
    const range = resolveRange(searchParams);
    // channel_state 为空（旧库/首轮采集前）时返回 null：不过滤，保持旧行为
    const liveIds = readLiveChannelIds(dashboard);
    const agg = source.prepare(
      `SELECT channel_id,
              MAX(channel_name) AS channel_name,
              COUNT(*) AS requests,
              COALESCE(SUM(cost), 0) AS revenue,
              COALESCE(SUM(quota_raw), 0) AS quota,
              COALESCE(SUM(input_total), 0) AS input_total,
              COALESCE(SUM(output), 0) AS output,
              COALESCE(SUM(cache_read), 0) AS cache_read,
              COALESCE(SUM(input_uncached), 0) AS input_uncached,
              COALESCE(SUM(latency_ms), 0) AS latency_sum,
              MAX(t_ms) AS last_t
         FROM logs
        WHERE ${LOCAL_FILTER} AND t_ms BETWEEN ? AND ?
        GROUP BY channel_id
        ORDER BY revenue DESC, requests DESC, channel_id ASC`,
    ).all(range.from, range.to);

    const latencyByChannel = new Map();
    for (const row of source.prepare(CHANNEL_LATENCY_SQL).all(range.from, range.to)) {
      latencyByChannel.set(String(row.channel_id), row);
    }

    // 主力模型：按渠道内各模型售出额取最高，tokens 与渠道口径一致（input_total + output）
    const topModelByChannel = pickTopModels(source.prepare(
      `SELECT channel_id AS group_key, model,
              COALESCE(SUM(cost), 0) AS revenue,
              COALESCE(SUM(input_total), 0) AS input_total,
              COALESCE(SUM(output), 0) AS output
         FROM logs
        WHERE ${LOCAL_FILTER} AND t_ms BETWEEN ? AND ?
        GROUP BY channel_id, model`,
    ).all(range.from, range.to));

    const accountRows = buildAccounts(range);
    const accountStatus = new Map(accountRows.map((a) => [a.id, a.status]));
    const accountNames = new Map(config.accounts.map((a) => [a.id, a.name]));
    const enabledIds = new Set(config.accounts.filter((a) => a.enabled).map((a) => a.id));

    const channelMeta = (channelId) => {
      const accountIds = owners.get(channelId) ?? [];
      const shared = accountIds.length > 1;
      let marginStatus;
      if (!accountIds.length) marginStatus = 'unconfigured';
      else if (shared) marginStatus = 'unallocated';
      else if (!enabledIds.has(accountIds[0])) marginStatus = 'disabled_account';
      else marginStatus = accountStatus.get(accountIds[0]) ?? 'unavailable';
      return {
        upstream_account: accountNames.get(accountIds[0]) ?? accountIds[0] ?? null,
        margin_status: marginStatus,
      };
    };

    const rows = agg.map((r) => {
      const key = String(r.channel_id);
      const latency = latencyByChannel.get(key);
      return {
        channel_id: r.channel_id,
        channel_name: r.channel_name ?? '',
        revenue: round6(r.revenue ?? 0),
        quota: r.quota ?? 0,
        tokens_total: (r.input_total ?? 0) + (r.output ?? 0),
        requests: r.requests ?? 0,
        cache_rate: (r.cache_read + r.input_uncached) > 0
          ? round6(r.cache_read / (r.cache_read + r.input_uncached))
          : null,
        latency_p50: latency?.p50 ?? null,
        latency_p95: latency?.p95 ?? null,
        // 吞吐：区间内输出 token 总量 ÷ 累计请求耗时（秒）。含排队时间，是渠道整体速率而非单请求生成速度。
        tps: r.latency_sum > 0 ? round6((r.output ?? 0) / (r.latency_sum / 1000)) : null,
        last_t: r.last_t ?? null,
        top_model: topModelByChannel.get(key) ?? null,
        ...channelMeta(r.channel_id),
        ...(liveIds ? { channel_status: 1 } : {}),
        archive_only: false,
      };
    });

    // 归档按渠道并入同一 channel_id：售出/请求/额度/Token 可加，
    // 分位数与缓存率只有明细有，整段只剩归档的渠道标 archive_only
    const archive = archiveByChannel(range);
    const byChannel = new Map(rows.map((r) => [String(r.channel_id), r]));
    for (const r of archive?.rows ?? []) {
      const key = String(r.channel_id);
      const hit = byChannel.get(key);
      if (hit) {
        hit.revenue = round6(hit.revenue + (r.revenue ?? 0));
        hit.quota += r.quota ?? 0;
        hit.tokens_total += (r.input_total ?? 0) + (r.output ?? 0);
        hit.requests += r.requests ?? 0;
        continue;
      }
      byChannel.set(key, {
        channel_id: r.channel_id,
        channel_name: r.channel_name ?? '',
        revenue: round6(r.revenue ?? 0),
        quota: r.quota ?? 0,
        tokens_total: (r.input_total ?? 0) + (r.output ?? 0),
        requests: r.requests ?? 0,
        cache_rate: null,
        latency_p50: null,
        latency_p95: null,
        tps: null,
        last_t: null,
        top_model: null,
        ...channelMeta(r.channel_id),
        ...(liveIds ? { channel_status: 1 } : {}),
        archive_only: true,
      });
    }

    // 已删除/停用（status !== 1）的渠道整行剔除；归档渠道同口径
    const ordered = [...byChannel.values()]
      .filter((row) => liveIds === null || liveIds.has(Number(row.channel_id)))
      .sort(
        (a, b) => (b.revenue - a.revenue)
          || (b.requests - a.requests)
          || ((a.channel_id ?? 0) - (b.channel_id ?? 0)),
      );

    return {
      rows: ordered,
      archive: archiveInfo(archive, ['cache_rate', 'latency_p50', 'latency_p95', 'last_t', 'top_model']),
    };
  }

  /**
   * 按 group_name 聚合（NULL / 空串统一为 ''）。归档只有渠道维度：
   * 先按明细窗口建立 channel → group 归属，归档渠道沿用；找不到归属的归入未分组。
   */
  function groups(searchParams) {
    const range = resolveRange(searchParams);
    const agg = source.prepare(
      `SELECT ${GROUP_KEY_SQL} AS group_name,
              channel_id,
              MAX(channel_name) AS channel_name,
              COUNT(*) AS requests,
              COALESCE(SUM(cost), 0) AS revenue,
              COALESCE(SUM(quota_raw), 0) AS quota,
              COALESCE(SUM(input_total), 0) AS input_total,
              COALESCE(SUM(output), 0) AS output,
              COALESCE(SUM(cache_read), 0) AS cache_read,
              COALESCE(SUM(input_uncached), 0) AS input_uncached,
              COALESCE(SUM(latency_ms), 0) AS latency_sum,
              MAX(t_ms) AS last_t
         FROM logs
        WHERE ${LOCAL_FILTER} AND t_ms BETWEEN ? AND ?
        GROUP BY ${GROUP_KEY_SQL}, channel_id`,
    ).all(range.from, range.to);

    const groupOfChannel = new Map();
    const byGroup = new Map();
    const ensureGroup = (name) => {
      const key = name ?? '';
      let group = byGroup.get(key);
      if (!group) {
        group = {
          group_name: key,
          revenue: 0,
          quota: 0,
          tokens: 0,
          requests: 0,
          cache_read: 0,
          input_uncached: 0,
          detail_output: 0,
          latency_sum: 0,
          last_t: null,
          channels: new Map(),
        };
        byGroup.set(key, group);
      }
      return group;
    };
    const addChannel = (group, channelId, channelName, revenue) => {
      if (channelId == null) return;
      const key = String(channelId);
      const hit = group.channels.get(key);
      if (hit) {
        hit.revenue += Number(revenue ?? 0);
        if (!hit.name && channelName) hit.name = channelName;
      } else {
        group.channels.set(key, { name: channelName || '', revenue: Number(revenue ?? 0) });
      }
    };

    for (const r of agg) {
      const group = ensureGroup(r.group_name);
      group.revenue += Number(r.revenue ?? 0);
      group.quota += Number(r.quota ?? 0);
      group.tokens += Number(r.input_total ?? 0) + Number(r.output ?? 0);
      group.requests += Number(r.requests ?? 0);
      group.cache_read += Number(r.cache_read ?? 0);
      group.input_uncached += Number(r.input_uncached ?? 0);
      group.detail_output += Number(r.output ?? 0);
      group.latency_sum += Number(r.latency_sum ?? 0);
      if (typeof r.last_t === 'number') group.last_t = Math.max(group.last_t ?? 0, r.last_t);
      if (r.channel_id != null && !groupOfChannel.has(String(r.channel_id))) {
        groupOfChannel.set(String(r.channel_id), group.group_name);
      }
      addChannel(group, r.channel_id, r.channel_name, r.revenue);
    }

    // 归档没有 group_name，也没有分位/缓存/TPS/模型维度
    const archive = archiveByChannel(range);
    for (const r of archive?.rows ?? []) {
      const known = r.channel_id != null ? groupOfChannel.get(String(r.channel_id)) : undefined;
      const group = ensureGroup(known ?? '');
      group.revenue += Number(r.revenue ?? 0);
      group.quota += Number(r.quota ?? 0);
      group.tokens += Number(r.input_total ?? 0) + Number(r.output ?? 0);
      group.requests += Number(r.requests ?? 0);
      addChannel(group, r.channel_id, r.channel_name, r.revenue);
    }

    const latencyByGroup = new Map();
    if (GROUP_LATENCY_SQL) {
      for (const row of source.prepare(GROUP_LATENCY_SQL).all(range.from, range.to)) {
        latencyByGroup.set(String(row.group_key ?? ''), row);
      }
    } else {
      // 没有 group_name 列时整表就是一个未分组
      const row = source.prepare(OVERVIEW_LATENCY_SQL).get(range.from, range.to);
      latencyByGroup.set('', { ...row, group_key: '' });
    }

    const topByGroup = pickTopModels(source.prepare(
      `SELECT ${GROUP_KEY_SQL} AS group_key, model,
              COALESCE(SUM(cost), 0) AS revenue,
              COALESCE(SUM(input_total), 0) AS input_total,
              COALESCE(SUM(output), 0) AS output
         FROM logs
        WHERE ${LOCAL_FILTER} AND t_ms BETWEEN ? AND ?
        GROUP BY ${GROUP_KEY_SQL}, model`,
    ).all(range.from, range.to));

    const rows = [...byGroup.values()].map((g) => {
      const latency = latencyByGroup.get(g.group_name);
      const cacheDenominator = g.cache_read + g.input_uncached;
      const names = [...g.channels.values()]
        .filter((c) => c.name)
        .sort((a, b) => (b.revenue - a.revenue) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((c) => c.name);
      return {
        group_name: g.group_name,
        channels: g.channels.size,
        channel_names: [...new Set(names)].slice(0, 8),
        revenue: round6(g.revenue) ?? 0,
        tokens: g.tokens,
        requests: g.requests,
        cache_rate: cacheDenominator > 0 ? round6(g.cache_read / cacheDenominator) : null,
        p50: latency?.p50 ?? null,
        p95: latency?.p95 ?? null,
        // TPS 只用明细窗口：归档没有请求耗时，混进来会虚高
        tps: g.latency_sum > 0 ? round6(g.detail_output / (g.latency_sum / 1000)) : null,
        last_t: g.last_t,
        top_model: topByGroup.get(g.group_name) ?? null,
      };
    });

    rows.sort((a, b) => (b.revenue - a.revenue)
      || (a.group_name < b.group_name ? -1 : a.group_name > b.group_name ? 1 : 0));
    return { groups: rows };
  }

  /**
   * 按 user_name 聚合（NULL / 空串统一为 ''，前端显示「未命名用户」）。
   * 归档 logs_daily 只有渠道维度、没有 user 维度，金额无法归属到用户：
   * 不并入归档，archive 固定不可用，避免用户合计与站点总额出现无法解释的差额。
   */
  function users(searchParams) {
    const range = resolveRange(searchParams);
    const agg = source.prepare(
      `SELECT ${USER_KEY_SQL} AS user_name,
              COUNT(*) AS requests,
              COALESCE(SUM(cost), 0) AS revenue,
              COALESCE(SUM(input_total), 0) AS input_total,
              COALESCE(SUM(output), 0) AS output
         FROM logs
        WHERE ${LOCAL_FILTER} AND t_ms BETWEEN ? AND ?
        GROUP BY ${USER_KEY_SQL}`,
    ).all(range.from, range.to);

    const rows = agg.map((r) => ({
      user_name: r.user_name ?? '',
      revenue: round6(r.revenue ?? 0) ?? 0,
      requests: Number(r.requests ?? 0),
      tokens: Number(r.input_total ?? 0) + Number(r.output ?? 0),
    }));
    // 先取整再求和：total 与逐行 revenue 展示一致
    const totalRevenue = round6(rows.reduce((sum, r) => sum + r.revenue, 0)) ?? 0;

    rows.sort((a, b) => (b.revenue - a.revenue)
      || (a.user_name < b.user_name ? -1 : a.user_name > b.user_name ? 1 : 0));

    return {
      users: rows.map((r) => ({
        ...r,
        share: totalRevenue > 0 ? round6(r.revenue / totalRevenue) ?? 0 : 0,
      })),
      total_revenue: totalRevenue,
      // 与前端约定：归档不可用时日期为空串（其余接口沿用 null）
      archive: { from_day: '', to_day: '', days: 0, available: false, partial_fields: [] },
    };
  }

  /**
   * 按 model 聚合（NULL / 空串统一为 `(未知模型)`）。归档 logs_daily 只有渠道维度、
   * 没有 model 维度，金额无法按模型归属：不并入归档，archive 固定不可用。
   * 上游账户由渠道反查配置得到：一个模型可跨多个渠道，渠道已删（无归属）忽略。
   */
  function models(searchParams) {
    const range = resolveRange(searchParams);
    const agg = source.prepare(
      `SELECT model,
              channel_id,
              COUNT(*) AS requests,
              COALESCE(SUM(cost), 0) AS revenue,
              COALESCE(SUM(input_total), 0) AS input_total,
              COALESCE(SUM(output), 0) AS output
         FROM logs
        WHERE ${LOCAL_FILTER} AND t_ms BETWEEN ? AND ?
        GROUP BY model, channel_id`,
    ).all(range.from, range.to);

    const byModel = new Map();
    for (const r of agg) {
      const name = r.model == null || String(r.model) === '' ? '(未知模型)' : String(r.model);
      let hit = byModel.get(name);
      if (!hit) {
        hit = { model: name, revenue: 0, requests: 0, tokens: 0, channels: new Set() };
        byModel.set(name, hit);
      }
      hit.revenue += Number(r.revenue ?? 0);
      hit.requests += Number(r.requests ?? 0);
      hit.tokens += Number(r.input_total ?? 0) + Number(r.output ?? 0);
      if (r.channel_id != null) hit.channels.add(r.channel_id);
    }

    const rows = [...byModel.values()].map((m) => {
      const revenue = round6(m.revenue) ?? 0;
      // 配置的渠道 → 账户 id；一条渠道可能被多个账户配置，去重后排序
      const accountIds = new Set();
      for (const channelId of m.channels) {
        for (const accountId of owners.get(channelId) ?? []) accountIds.add(accountId);
      }
      return {
        model: m.model,
        revenue,
        requests: m.requests,
        tokens: m.tokens,
        share: 0,
        // 与 pickTopModels 同口径：用未取整的 SUM(cost) 计算，避免先舍入再放大
        per_1e8: m.tokens > 0 ? round6(m.revenue / (m.tokens / 1e8)) : null,
        upstream_accounts: [...accountIds].sort(),
      };
    });

    // 先取整再求和：total 与逐行 revenue 展示一致（与 /api/users 同口径）
    const totalRevenue = round6(rows.reduce((sum, r) => sum + r.revenue, 0)) ?? 0;
    for (const r of rows) {
      r.share = totalRevenue > 0 ? round6(r.revenue / totalRevenue) ?? 0 : 0;
    }

    rows.sort((a, b) => (b.revenue - a.revenue)
      || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));

    return {
      models: rows,
      total_revenue: totalRevenue,
      archive: {
        from_day: '',
        to_day: '',
        days: 0,
        available: false,
        partial_fields: [],
        reason: 'logs_daily has no model dimension',
      },
    };
  }

  /**
   * 财务视角：每个上游账户的最新余额、区间成本/充值、最近 7 天日均与续航。
   * 只统计启用且非 external 的账户；停用/无上游账户既没有余额也不该参与续航。
   */
  function capital(searchParams) {
    const range = resolveRange(searchParams);
    const now = Date.now();
    const channelStates = readChannelStates(dashboard);
    const countsById = new Map();
    const eligible = config.accounts
      .filter((a) => a.enabled !== false && a.kind !== 'external')
      .filter((a) => {
        // 回退：channel_state 为空时与改动前一致，不筛账户
        if (channelStates === null) return true;
        const counts = channelCounts(a, channelStates);
        // 配置里的渠道全部停用或已从源库删除：账户不进 accounts，也不进 total
        if (counts.channels_live === 0) return false;
        countsById.set(a.id, counts);
        return true;
      });
    const ledgerById = new Map(buildAccounts(range).map((a) => [a.id, a]));

    // 日均固定看最近 7 个北京自然日（含当天），与 /api/profit 同一账本函数按日桶算；
    // 区间合计（cost_range）仍按请求的 from/to 给值，两者互不影响。
    const avgFrom = beijingDayStart(now) - 6 * DAY_MS;
    const accountList = eligible.map((a) => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      channels: a.channels,
      enabled: a.enabled !== false,
    }));
    const costByAccount = ledgerSeries(accountList, {
      from: avgFrom,
      to: now,
      granularity: 'day',
    }).series.cost_by_site;
    // 请求区间内的日桶成本：账本口径（consumption）取不到时的退路
    const rangeCostByAccount = ledgerSeries(accountList, {
      from: range.from,
      to: range.to,
      granularity: 'day',
    }).series.cost_by_site;

    // 每个上游账户最主要的分组（按最近 7 天售出额），用于「最短续航」标注到组
    const topGroupOf = (account) => {
      if (!hasGroupName) return null;
      const ids = Array.isArray(account.channels)
        ? account.channels.map(Number).filter((n) => Number.isFinite(n))
        : [];
      if (!ids.length) return null;
      const marks = ids.map(() => '?').join(',');
      const row = source
        .prepare(
          `SELECT COALESCE(NULLIF(group_name, ''), '(未分组)') AS g, SUM(cost) AS rev
             FROM logs
            WHERE ${LOCAL_FILTER} AND t_ms BETWEEN ? AND ? AND channel_id IN (${marks})
            GROUP BY g ORDER BY rev DESC LIMIT 1`,
        )
        .get(avgFrom, now, ...ids);
      return row?.g ?? null;
    };

    const rows = eligible.map((a) => {
      const ledger = ledgerById.get(a.id) ?? null;
      const latest = readLatestSnapshot(dashboard, a.id);
      const balance = latest
        && typeof latest.balance === 'number' && Number.isFinite(latest.balance)
        ? latest.balance
        : null;
      const creditsRange = ledger ? ledger.credits : null;

      const dailyCosts = costByAccount[a.id] ?? [];
      // 只有区间终点落在当天日中时，最后一个桶才是未走完的当天（profitBuckets
      // 在整点边界上不生成零宽空桶）；它之前的「完整日」才能证明账本有数据。
      const liveBucket = dailyCosts.length === 7 && now < avgFrom + 7 * DAY_MS;
      const countedDays = liveBucket ? dailyCosts.slice(0, -1) : dailyCosts;
      const hasCost = countedDays.some((v) => typeof v === 'number');
      // 区间成本优先用账本口径；账本要求区间首尾都有边界快照，长窗口期初必然缺失，
      // 这时退回到请求区间内的日桶求和（只累加算得出来的桶），既不编零也不整列 null。
      const rangeBuckets = rangeCostByAccount[a.id] ?? [];
      const bucketSum = rangeBuckets.some((v) => typeof v === 'number')
        ? round6(rangeBuckets.reduce((sum, v) => sum + (v ?? 0), 0))
        : null;
      const costRange = ledger?.consumption ?? bucketSum;
      const dailyAvg = hasCost
        ? round6(dailyCosts.reduce((sum, v) => sum + (v ?? 0), 0) / 7)
        : null;

      const runway = dailyAvg !== null && dailyAvg > 0 && balance !== null
        ? Math.round((balance / dailyAvg) * 10) / 10
        : null;

      return {
        account_id: a.id,
        name: a.name ?? a.id,
        balance,
        ...(countsById.get(a.id) ?? {}),
        cost_range: costRange,
        credits_range: creditsRange,
        daily_avg_7d: dailyAvg,
        runway_days: runway,
        top_group: topGroupOf(a),
        status: balance === null ? 'missing_balance' : costRange === null ? 'partial' : 'ok',
      };
    });

    /** 可算值求和：跳过 null，一个可算值都没有时返回 null（不填 0） */
    const sumOrNull = (values) => {
      const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
      return nums.length ? round6(nums.reduce((sum, v) => sum + v, 0)) : null;
    };

    // 续航只计入「余额与日均都有值」的账户：有余额无消耗的账户会把续航拉成无穷
    const counted = rows.filter((r) => r.balance !== null && r.daily_avg_7d !== null);
    const countedBalance = sumOrNull(counted.map((r) => r.balance));
    const countedAvg = sumOrNull(counted.map((r) => r.daily_avg_7d));
    const total = {
      balance: sumOrNull(rows.map((r) => r.balance)),
      cost_range: sumOrNull(rows.map((r) => r.cost_range)),
      credits_range: sumOrNull(rows.map((r) => r.credits_range)),
      daily_avg_7d: sumOrNull(rows.map((r) => r.daily_avg_7d)),
      runway_days: countedAvg !== null && countedAvg > 0 && countedBalance !== null
        ? Math.round((countedBalance / countedAvg) * 10) / 10
        : null,
    };
    // 有账户缺少余额/成本/日均时，total 是部分账户之和：显式给出参与续航计算的账户数
    if (rows.some((r) => r.balance === null || r.cost_range === null || r.daily_avg_7d === null)) {
      total.accounts_counted = counted.length;
    }

    return { accounts: rows, total, range, generated_at: now };
  }

  function upstreams(searchParams) {
    const range = resolveRange(searchParams);
    const channelStates = readChannelStates(dashboard);
    const accounts = buildAccounts(range);
    // 不排除 0 live 的账户（前端自己标）；channel_state 为空时保持旧响应
    if (channelStates !== null) {
      for (const account of accounts) {
        Object.assign(account, channelCounts(account, channelStates));
      }
    }
    return {
      accounts,
      archive: archiveInfo(archiveTotals(range)),
    };
  }

  /**
   * 最近一轮 collect-spend 的失败账户：解析 job_runs.detail 里 accounts 中 status !== 'ok' 的项。
   * detail 缺失或非法时返回空数组，不影响 /api/quality 的其它字段。
   */
  function collectErrors() {
    try {
      const run = readLastRun(dashboard, 'collect-spend');
      if (!run || typeof run.detail !== 'string' || run.detail === '') return [];
      const detail = JSON.parse(run.detail);
      if (!detail || !Array.isArray(detail.accounts)) return [];
      return detail.accounts
        .filter((a) => {
          if (!a || typeof a !== 'object') return false;
          const status = a.status ?? a.balance?.status ?? null;
          return status !== null && status !== 'ok';
        })
        .map((a) => ({
          account_id: a.id ?? a.account_id ?? null,
          name: a.name ?? a.id ?? a.account_id ?? null,
          reason: a.reason ?? a.balance?.reason ?? null,
          at: run.started_at ?? null,
        }));
    } catch {
      return [];
    }
  }

  function quality() {
    const sourceAgg = source.prepare(
      'SELECT COUNT(*) AS rows, MAX(t_ms) AS last_t FROM logs',
    ).get();
    const errorRows = columns.error_logs
      ? source.prepare('SELECT COUNT(*) AS n FROM error_logs').get()?.n ?? 0
      : null;
    const jobs = readJobRuns(dashboard, 20).map((j) => ({
      job: j.job,
      started_at: j.started_at,
      finished_at: j.finished_at,
      status: j.status,
      detail: j.detail,
    }));
    const lastCollect = readLastRun(dashboard, 'collect-spend');
    const threshold = config.upstream?.job_stale_ms ?? 30 * 60 * 1000;
    const lastAt = lastCollect ? lastCollect.finished_at ?? lastCollect.started_at : null;
    const age = typeof lastAt === 'number' ? Math.max(0, Date.now() - lastAt) : null;
    return {
      source_last_t: sourceAgg?.last_t ?? null,
      source_rows: sourceAgg?.rows ?? 0,
      error_rows: errorRows,
      job_runs: jobs,
      collect_errors: collectErrors(),
      jobs: {
        job: 'collect-spend',
        last_run_at: lastAt,
        last_status: lastCollect?.status ?? null,
        age_ms: age,
        threshold_ms: threshold,
        stalled: lastAt === null ? true : age > threshold,
        never_run: lastAt === null,
      },
      schema_ok: schemaOkay(),
      checked_at: Date.now(),
    };
  }

  /**
   * nginx 4xx/5xx 聚合（看板库 http_errors_hourly）：按北京整点补齐空桶。
   * 表里 hour_ms 已是整点毫秒，直接复用 profitBuckets 生成桶，不再做时区换算。
   * 读取范围取首末桶的起点：区间从半小时开始时，该整点桶仍整体计入（聚合表无法拆小时）。
   */
  function errors(searchParams) {
    const range = resolveRange(searchParams);
    if (range.to - range.from > MAX_ERROR_RANGE_MS) {
      throw new RangeError('区间不能超过 31 天');
    }
    const buckets = profitBuckets(range.from, range.to, 'hour').map((b) => ({
      t_ms: b.t_ms,
      label: b.label,
      total: 0,
      s4xx: 0,
      s5xx: 0,
    }));
    const bucketByStart = new Map(buckets.map((b, i) => [b.t_ms, i]));
    const rows = buckets.length === 0
      ? []
      : dashboard.prepare(
        `SELECT hour_ms, status, path_group, count
           FROM http_errors_hourly
          WHERE hour_ms BETWEEN ? AND ?`,
      ).all(buckets[0].t_ms, buckets[buckets.length - 1].t_ms);

    let total = 0;
    const byStatus = new Map();
    const byGroup = new Map();
    for (const row of rows) {
      const count = Number(row.count);
      if (!Number.isFinite(count) || count <= 0) continue;
      const status = Number(row.status);
      const group = String(row.path_group);
      total += count;
      byStatus.set(status, (byStatus.get(status) ?? 0) + count);
      byGroup.set(group, (byGroup.get(group) ?? 0) + count);

      const idx = bucketByStart.get(Number(row.hour_ms));
      if (idx !== undefined) {
        const bucket = buckets[idx];
        bucket.total += count;
        if (status >= 400 && status <= 499) bucket.s4xx += count;
        else if (status >= 500 && status <= 599) bucket.s5xx += count;
      }
    }

    const share = (count) => (total > 0 ? round6(count / total) ?? 0 : 0);
    const topStatus = [...byStatus.entries()]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, 8)
      .map(([status, count]) => ({ status, count, share: share(count) }));
    const byPathGroup = [...byGroup.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, 6)
      .map(([path_group, count]) => ({ path_group, count, share: share(count) }));

    return {
      from: range.from,
      to: range.to,
      available: rows.length > 0,
      total,
      buckets,
      top_status: topStatus,
      by_path_group: byPathGroup,
    };
  }

  /** 看板库的 upstream_error 表可能还没建（旧库/首轮采集前）：缓存一次存在性，缺表按 0 错误处理 */
  let upstreamErrorTableSeen = false;
  function upstreamErrorTableExists() {
    if (upstreamErrorTableSeen) return true;
    try {
      upstreamErrorTableSeen = Boolean(
        dashboard
          .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'upstream_error'")
          .get(),
      );
    } catch {
      upstreamErrorTableSeen = false;
    }
    return upstreamErrorTableSeen;
  }

  /**
   * 渠道/分组健康：成功请求来自站点库 logs（LOCAL_FILTER），错误来自看板库 upstream_error。
   *
   * 两边按同一粒度分桶：bucket=15m（900000ms，对齐北京整点 0/15/30/45 分）或
   * bucket=1h（整点）；缺省按区间跨度选：≤ 36 小时用 15m，否则 1h。
   * 错误是独立的 type=5 事件，不在 logs 里，两者按「同渠道/分组 + 同桶」并列展示。
   * uptime 分母用尝试数（成功 + 错误）：分母为 0 返回 null，不返回 1——没流量不等于全健康。
   * state：0 次尝试 → none；< 3 次 → unknown（样本不足）；0 错误 → ok；
   * 错误率 < 2% → warn；否则 fail。
   * channel_state 有数据时只保留启用（status=1）的渠道；level=group 只保留含启用渠道的分组。
   */
  function status(searchParams) {
    const range = resolveRange(searchParams);
    const level = searchParams.get('level') ?? 'channel';
    if (level !== 'channel' && level !== 'group') {
      throw new RangeError('level 只能是 channel 或 group');
    }
    const isChannel = level === 'channel';
    const keySql = isChannel ? 'COALESCE(channel_id, 0)' : GROUP_KEY_SQL;

    const requestedBucket = searchParams.get('bucket');
    let bucket;
    if (requestedBucket === null || requestedBucket === '') {
      // 24 小时的 15m 序列是 96 个点，再长的区间退回整点桶
      bucket = range.to - range.from <= 36 * 3600000 ? '15m' : '1h';
    } else if (requestedBucket === '15m' || requestedBucket === '1h') {
      bucket = requestedBucket;
    } else {
      throw new RangeError('bucket 只能是 15m 或 1h');
    }
    const bucketStep = bucket === '15m' ? 15 * 60 * 1000 : 3600000;
    const bucketExpr = `(t_ms / ${bucketStep}) * ${bucketStep}`;
    const buckets = profitBuckets(range.from, range.to, bucket === '15m' ? '15m' : 'hour');
    const bucketIndex = new Map(buckets.map((b, i) => [b.t_ms, i]));

    // channel_state 为空（旧库/首轮采集前）返回 null：不过滤，保持旧行为
    const liveIds = readLiveChannelIds(dashboard);
    const liveGroupKeys = new Set();
    if (liveIds !== null && !isChannel) {
      // 分组没有独立状态：区间内出现过启用渠道即视为该分组存活
      const groupMaps = source.prepare(
        `SELECT DISTINCT COALESCE(channel_id, 0) AS channel_id, ${GROUP_KEY_SQL} AS key
           FROM logs
          WHERE ${LOCAL_FILTER} AND t_ms BETWEEN ? AND ?`,
      ).all(range.from, range.to);
      for (const row of groupMaps) {
        if (liveIds.has(Number(row.channel_id))) liveGroupKeys.add(String(row.key));
      }
      if (upstreamErrorTableExists()) {
        const errorMaps = dashboard.prepare(
          `SELECT DISTINCT COALESCE(channel_id, 0) AS channel_id,
                  COALESCE(group_name, '') AS key
             FROM upstream_error
            WHERE t_ms BETWEEN ? AND ?`,
        ).all(range.from, range.to);
        for (const row of errorMaps) {
          if (liveIds.has(Number(row.channel_id))) liveGroupKeys.add(String(row.key));
        }
      }
    }

    const emptyBuckets = () => buckets.map((b) => ({
      t_ms: b.t_ms,
      label: b.label,
      total: 0,
      errors: 0,
      state: 'none',
      top_errors: [],
    }));

    const components = new Map();
    const ensureComponent = (key, name) => {
      const id = String(key ?? '');
      let component = components.get(id);
      if (!component) {
        component = {
          key: id,
          name: '',
          requests: 0,
          errors: 0,
          buckets: emptyBuckets(),
          // 每个桶的状态码计数，最终按次数降序取前 5
          codes: buckets.map(() => new Map()),
          top: new Map(),
        };
        components.set(id, component);
      }
      if (!component.name && name) component.name = String(name);
      return component;
    };

    // 请求（成功消费）：站点库按「桶起点 × 渠道/分组」计数
    const requestRows = source.prepare(
      `SELECT ${bucketExpr} AS bucket_ms,
              ${keySql} AS key,
              ${isChannel ? 'MAX(channel_name)' : 'NULL'} AS name,
              COUNT(*) AS requests
         FROM logs
        WHERE ${LOCAL_FILTER} AND t_ms BETWEEN ? AND ?
        GROUP BY bucket_ms, key`,
    ).all(range.from, range.to);

    for (const row of requestRows) {
      const count = Number(row.requests ?? 0);
      const component = ensureComponent(row.key, isChannel ? row.name : null);
      component.requests += count;
      const idx = bucketIndex.get(Number(row.bucket_ms));
      if (idx !== undefined) component.buckets[idx].total += count;
    }

    // 错误：看板库 upstream_error（源库 logs.type=5 的镜像），同样的桶与维度
    const errorRows = upstreamErrorTableExists()
      ? dashboard.prepare(
        `SELECT ${bucketExpr} AS bucket_ms,
                ${isChannel ? 'COALESCE(channel_id, 0)' : "COALESCE(group_name, '')"} AS key,
                ${isChannel ? 'MAX(channel_name)' : 'NULL'} AS name,
                status_code,
                COUNT(*) AS errors
           FROM upstream_error
          WHERE t_ms BETWEEN ? AND ?
          GROUP BY bucket_ms, key, status_code`,
      ).all(range.from, range.to)
      : [];

    for (const row of errorRows) {
      const count = Number(row.errors ?? 0);
      if (!(count > 0)) continue;
      const component = ensureComponent(row.key, isChannel ? row.name : null);
      component.errors += count;
      const idx = bucketIndex.get(Number(row.bucket_ms));
      if (idx !== undefined) {
        component.buckets[idx].errors += count;
        if (row.status_code != null) {
          const code = Number(row.status_code);
          const codes = component.codes[idx];
          codes.set(code, (codes.get(code) ?? 0) + count);
        }
      }
      if (row.status_code != null) {
        const code = Number(row.status_code);
        component.top.set(code, (component.top.get(code) ?? 0) + count);
      }
    }

    // 一次「尝试」= 一条成功消费日志 + 一条错误日志，两者互不包含。
    // 只用成功数当分母时，某一小时失败多于成功会把成功率算成负数。
    // 阈值来自运行时设置（health.minSamples / failErrorRate），面板改完立刻生效。
    const healthRules = getHealthSettings();
    const stateOf = (successes, errors) => {
      const attempts = successes + errors;
      if (attempts <= 0) return 'none';
      // 样本太少时不给结论：1 次失败也判 fail 会让刚上线的渠道整屏飘红
      if (attempts < healthRules.minSamples) return 'unknown';
      if (errors <= 0) return 'ok';
      if (errors / attempts < healthRules.failErrorRate) return 'warn';
      return 'fail';
    };

    const topCodes = (map, limit) => [...map.entries()]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, limit)
      .map(([status, count]) => ({ status, count }));

    let list = [...components.values()];
    if (liveIds !== null) {
      list = isChannel
        ? list.filter((component) => liveIds.has(Number(component.key)))
        : list.filter((component) => liveGroupKeys.has(component.key));
    }

    list = list.map((component) => {
      component.buckets.forEach((bucket, idx) => {
        bucket.state = stateOf(bucket.total, bucket.errors);
        bucket.top_errors = topCodes(component.codes[idx], 5);
      });
      return {
        key: component.key,
        name: component.name
          || (isChannel ? `渠道 #${component.key}` : component.key || '未分组'),
        requests: component.requests,
        errors: component.errors,
        uptime: component.requests + component.errors > 0
          ? round6(component.requests / (component.requests + component.errors))
          : null,
        buckets: component.buckets,
        top_errors: topCodes(component.top, 3),
      };
    });

    // 有错误的排前面，同错误数按流量降序，最后按名称稳定排序
    list.sort(
      (a, b) => (b.errors - a.errors)
        || (b.requests - a.requests)
        || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );

    let totalRequests = 0;
    let totalErrors = 0;
    for (const component of list) {
      totalRequests += component.requests;
      totalErrors += component.errors;
    }

    const since = upstreamErrorTableExists()
      ? dashboard.prepare('SELECT MIN(t_ms) AS min_t FROM upstream_error').get()?.min_t ?? null
      : null;

    return {
      from: range.from,
      to: range.to,
      level,
      bucket,
      components: list,
      overall: {
        requests: totalRequests,
        errors: totalErrors,
        uptime: totalRequests + totalErrors > 0
          ? round6(totalRequests / (totalRequests + totalErrors))
          : null,
      },
      coverage: { errors_since: typeof since === 'number' ? since : null },
      health_rules: {
        minSamples: healthRules.minSamples,
        failErrorRate: healthRules.failErrorRate,
      },
    };
  }

  function rows(searchParams) {
    const range = resolveRange(searchParams);
    const page = intParam(searchParams, 'page', 1, { min: 1 });
    const pageSize = intParam(searchParams, 'page_size', DEFAULT_PAGE_SIZE, {
      min: 1,
      max: MAX_PAGE_SIZE,
      clamp: true,
    });
    const total = source.prepare(
      `SELECT COUNT(*) AS n FROM logs WHERE ${LOCAL_FILTER} AND t_ms BETWEEN ? AND ?`,
    ).get(range.from, range.to)?.n ?? 0;
    const list = source.prepare(
      `SELECT ${ROW_COLUMNS.join(', ')}
         FROM logs
        WHERE ${LOCAL_FILTER} AND t_ms BETWEEN ? AND ?
        ORDER BY t_ms DESC, req_id
        LIMIT ? OFFSET ?`,
    ).all(range.from, range.to, pageSize, (page - 1) * pageSize);
    return {
      total,
      page,
      page_size: pageSize,
      rows: list.map((r) => {
        const out = {};
        for (const col of ROW_COLUMNS) out[col] = r[col] ?? null;
        return out;
      }),
    };
  }

  /**
   * 渠道路由页：只读看板库的配置快照 + 静态账户归属。
   * 不读日志、不补边、不猜归属：渠道全部保留（含无流量/无 ability/未映射），
   * abilities 只来自源库 abilities 表，model_mapping 仅作附注。
   */
  function routeGraph() {
    const snapshot = readRoutingSnapshot(dashboard);
    const payload = snapshot.payload ?? null;
    const ownersByChannel = new Map();
    const sourceAccounts = Array.isArray(config?.accounts) ? config.accounts : [];
    const accounts = sourceAccounts.map((account) => {
      const id = String(account?.id ?? '');
      const channelIds = [];
      for (const value of Array.isArray(account?.channels) ? account.channels : []) {
        const channelId = Number(value);
        if (!Number.isInteger(channelId) || channelIds.includes(channelId)) continue;
        channelIds.push(channelId);
        const owners = ownersByChannel.get(channelId) ?? [];
        if (!owners.includes(id)) owners.push(id);
        ownersByChannel.set(channelId, owners);
      }
      return {
        id,
        name: account?.name == null ? id : String(account.name),
        // 静态配置里的 base_url 只取 origin，避免把接口路径当财务网站
        website: safeOrigin(account?.base_url),
        channel_ids: channelIds,
      };
    });

    const channels = (Array.isArray(payload?.channels) ? payload.channels : []).map((channel) => {
      const id = Number(channel?.id);
      const status = typeof channel?.status === 'number' && Number.isFinite(channel.status)
        ? channel.status
        : null;
      const mapping = parseChannelModelMapping(channel?.model_mapping);
      return {
        id,
        name: channel?.name == null ? `渠道 #${id}` : String(channel.name),
        status,
        state: routingChannelState(status),
        endpoint: safeOrigin(channel?.base_url),
        account_ids: ownersByChannel.get(id) ?? [],
        model_mapping: mapping.model_mapping,
        mapping_error: mapping.mapping_error,
      };
    });

    return {
      available: snapshot.available,
      synced_at: snapshot.synced_at,
      last_attempt_at: snapshot.last_attempt_at,
      error: snapshot.error,
      routes_available: payload ? payload.routes_available !== false : false,
      routes_error: payload && typeof payload.routes_error === 'string' ? payload.routes_error : null,
      channels,
      accounts,
      abilities: Array.isArray(payload?.abilities) ? payload.abilities : [],
    };
  }

  return {
    meta,
    overview,
    trend,
    profit,
    channels,
    groups,
    users,
    models,
    capital,
    upstreams,
    quality,
    errors,
    status,
    rows,
    routeGraph,
  };
}
