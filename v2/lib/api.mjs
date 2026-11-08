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
import { channelOwners } from './config.mjs';
import {
  computeMargin,
  evaluateLedger,
  round6,
} from './ledger.mjs';
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

const BUCKET_STEP_MS = { day: DAY_MS, hour: 3600000 };

/** 北京时间小时桶起点；UTC+8 为整小时偏移，小时边界与 UTC 对齐 */
function beijingHourStart(ms) {
  return Math.floor(ms / BUCKET_STEP_MS.hour) * BUCKET_STEP_MS.hour;
}

/**
 * 北京时间分桶（纯函数）：日桶用当日 00:00，小时桶用整点。
 * 只生成与 [from, to] 有交集的桶，覆盖整个区间。
 */
export function profitBuckets(from, to, granularity) {
  const step = BUCKET_STEP_MS[granularity];
  if (!step) throw new RangeError('granularity 只能是 day 或 hour');
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return [];
  const first = granularity === 'day' ? beijingDayStart(from) : beijingHourStart(from);
  const out = [];
  for (let t = first; t <= to; t += step) {
    // 区间正好结束在边界上时，不生成零宽的空桶（否则末列永远没有成本）
    if (t === to && t !== first) break;
    out.push({
      t_ms: t,
      label: granularity === 'day' ? dayKey(t) : `${formatLocal(t).slice(0, 13)}:00`,
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

export function createApi({ source, dashboard, config, siteName, sourceLabel }) {
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
                COALESCE(SUM(requests), 0) AS requests
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
      preview: true,
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
              COUNT(*) AS requests
         FROM logs
        WHERE ${LOCAL_FILTER} AND t_ms BETWEEN ? AND ?
        GROUP BY bucket
        ORDER BY bucket`,
    ).all(range.from, range.to);

    // 归档只有日粒度：day 桶直接并入 logs_daily 的日汇总，hour 桶保持只覆盖明细窗口
    const archive = granularity === 'day' ? archiveByDay(range) : null;
    const byBucket = new Map(
      rows.map((r) => [
        r.bucket,
        {
          bucket: r.bucket,
          revenue: round6(r.revenue ?? 0),
          quota: r.quota ?? 0,
          requests: r.requests ?? 0,
        },
      ]),
    );
    for (const r of archive?.rows ?? []) {
      const hit = byBucket.get(r.bucket);
      if (hit) {
        hit.revenue = round6(hit.revenue + (r.revenue ?? 0));
        hit.quota += r.quota ?? 0;
        hit.requests += r.requests ?? 0;
      } else {
        byBucket.set(r.bucket, {
          bucket: r.bucket,
          revenue: round6(r.revenue ?? 0),
          quota: r.quota ?? 0,
          requests: r.requests ?? 0,
        });
      }
    }
    const points = [...byBucket.values()].sort((a, b) => (a.bucket < b.bucket ? -1 : 1));

    return {
      granularity,
      points,
      archive: archiveInfo(archive),
    };
  }

  function profit(searchParams) {
    const granularity = searchParams.get('granularity') ?? 'day';
    if (!Object.hasOwn(TREND_BUCKET_SQL, granularity)) {
      throw new RangeError('granularity 只能是 day 或 hour');
    }
    const range = resolveRange(searchParams);
    const buckets = profitBuckets(range.from, range.to, granularity);
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
        .all(account.id, range.from - preloadTolerance, range.to + SNAPSHOT_BOUNDARY_TOLERANCE_MS)
        .filter((r) => typeof r.balance === 'number' && Number.isFinite(r.balance))
        .map((r) => ({
          t_ms: r.t_ms,
          balance: r.balance,
          total_recharged: typeof r.total_recharged === 'number' ? r.total_recharged : null,
        }));
      creditEventsByAccount[account.id] = creditStmt
        .all(account.id, range.from, range.to + 1)
        .filter((r) => typeof r.amount === 'number' && Number.isFinite(r.amount))
        .map((r) => ({ t_ms: r.t_ms, amount: r.amount }));
    }

    return {
      ...buildProfit({
        granularity,
        from: range.from,
        to: range.to,
        accounts,
        buckets,
        revenueRows: allRevenueRows,
        snapshotsByAccount,
        creditEventsByAccount,
      }),
      archive: archiveInfo(archive),
    };
  }

  function channels(searchParams) {
    const range = resolveRange(searchParams);
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
        archive_only: true,
      });
    }

    const ordered = [...byChannel.values()].sort(
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

  function upstreams(searchParams) {
    const range = resolveRange(searchParams);
    return {
      accounts: buildAccounts(range),
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

  return { meta, overview, trend, profit, channels, groups, upstreams, quality, rows };
}
