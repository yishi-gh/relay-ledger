/**
 * 服务状态（/api/services）的只读聚合。
 *
 * 数据只来自 job_runs 的 allowlist 字段（job / started_at / finished_at / status），
 * 不读取 detail，因此不会带出账户余额、错误原文或任何凭据。
 *
 * 契约：
 * - 24h = 96 个 15 分钟桶；7d = 168 个 1 小时桶；桶按 epoch 整点对齐（与北京 15 分钟/整点一致）。
 * - 桶内没有运行记录 → none，不当作失败；错误 → fail；partial/rate_limited → warn；成功 → ok。
 * - 最新状态结合该 job 的实际间隔：超过 2 个周期 + 5 分钟 grace 视为过期（warn）。
 * - 从未运行 → unknown；日志采集明确关闭 → disabled；其它 job 没有可靠启停证据时 enabled=null。
 */

export const SERVICE_RANGES = {
  '24h': { count: 96, bucketMs: 15 * 60 * 1000 },
  '7d': { count: 168, bucketMs: 60 * 60 * 1000 },
};

/** 固定调度的 job 间隔（分钟）；spend/logs 由运行时设置或采集器实际值决定 */
export const FIXED_INTERVALS = {
  'http-errors': 15,
  'upstream-errors': 15,
  prune: 24 * 60,
  rollup: 24 * 60,
};

export const SERVICE_DEFINITIONS = [
  { id: 'collect-spend', label: '余额采集', collection: 'spend' },
  { id: 'collect-site-logs', label: '本站日志', collection: 'logs' },
  { id: 'http-errors', label: '入口错误' },
  { id: 'upstream-errors', label: '上游错误' },
  { id: 'prune', label: '数据清理' },
  { id: 'rollup', label: '历史归档' },
];

const JOB_IDS = SERVICE_DEFINITIONS.map((service) => service.id);
const GRACE_MS = 5 * 60 * 1000;
/** 允许的时钟偏移：超过该范围的「未来完成时间」视为异常，不能一直算 ok */
const FUTURE_SKEW_MS = 2 * 60 * 1000;
const PARTIAL_STATUSES = new Set(['partial', 'rate_limited']);

function missingJobRunsTable(err) {
  return /no such table/i.test(String(err?.message ?? ''));
}

function latestRuns(db) {
  const placeholders = JOB_IDS.map(() => '?').join(', ');
  try {
    const rows = db.prepare(
      `SELECT job, started_at, finished_at, status FROM (
         SELECT job, started_at, finished_at, status,
                ROW_NUMBER() OVER (
                  PARTITION BY job
                  ORDER BY COALESCE(finished_at, started_at, 0) DESC, id DESC
                ) AS rn
           FROM job_runs
          WHERE job IN (${placeholders})
       ) WHERE rn = 1`,
    ).all(...JOB_IDS);
    return new Map(rows.map((row) => [row.job, row]));
  } catch (err) {
    // 只有「还没有 job_runs 表」能当未采集；库关闭/损坏必须向上抛，不能伪装成 unknown
    if (missingJobRunsTable(err)) return new Map();
    throw err;
  }
}

function bucketCounts(db, from, to, bucketMs) {
  const placeholders = JOB_IDS.map(() => '?').join(', ');
  try {
    const rows = db.prepare(
      `SELECT job, COALESCE(started_at, finished_at, 0) AS ts, status, finished_at
         FROM job_runs
        WHERE job IN (${placeholders})
          AND COALESCE(started_at, finished_at, 0) >= ?
          AND COALESCE(started_at, finished_at, 0) < ?`,
    ).all(...JOB_IDS, from, to);
    const map = new Map();
    for (const row of rows) {
      const bucket = Math.floor(Number(row.ts) / bucketMs) * bucketMs;
      const key = `${row.job}:${bucket}`;
      const entry = map.get(key) ?? { runs: 0, failures: 0, partial: 0, unknown: 0 };
      entry.runs += 1;
      if (row.status === 'error') entry.failures += 1;
      else if (PARTIAL_STATUSES.has(row.status)) entry.partial += 1;
      else if (row.status !== 'ok' || typeof row.finished_at !== 'number') entry.unknown += 1;
      map.set(key, entry);
    }
    return map;
  } catch (err) {
    if (missingJobRunsTable(err)) return new Map();
    throw err;
  }
}

function collectionMinutes(settings, collector, kind) {
  const key = `${kind}Minutes`;
  const effective = collector?.effective?.[key];
  if (typeof effective === 'number' && Number.isFinite(effective) && effective > 0) return effective;
  const configured = settings?.collection?.[key];
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) return configured;
  return null;
}

function logsEnabled(collector) {
  return typeof collector?.logsEnabled === 'boolean' ? collector.logsEnabled : null;
}

function intervalFor(service, settings, collector) {
  if (service.collection === 'spend') return collectionMinutes(settings, collector, 'spend');
  if (service.collection === 'logs') return collectionMinutes(settings, collector, 'logs');
  return FIXED_INTERVALS[service.id] ?? null;
}

function enabledFor(service, collector) {
  if (service.id === 'collect-spend') return true;
  if (service.id === 'collect-site-logs') return logsEnabled(collector);
  // 其它 job 没有可靠启停证据（CLI 开关、调度配置不在本接口读取范围）→ 不编造
  return null;
}

function latestState({ enabled, intervalMinutes, run, now, disabledReason }) {
  if (enabled === false) return { state: 'disabled', reason: disabledReason };
  if (!run) return { state: 'unknown', reason: '无运行记录' };
  const status = typeof run.status === 'string' ? run.status : null;
  const finishedAt = typeof run.finished_at === 'number' ? run.finished_at : null;
  if (status === 'error') return { state: 'fail', reason: '最近一次运行失败' };
  if (PARTIAL_STATUSES.has(status)) {
    return { state: 'warn', reason: status === 'rate_limited' ? '最近一次运行被限流' : '最近一次运行部分失败' };
  }
  if (status !== 'ok') return { state: 'unknown', reason: '最近一次运行状态未知' };
  if (finishedAt === null) return { state: 'unknown', reason: '最近一次运行缺少完成时间' };
  if (finishedAt > now + FUTURE_SKEW_MS) {
    return { state: 'unknown', reason: '最近一次完成时间异常（晚于当前时间）' };
  }
  if (
    intervalMinutes != null
    && now - finishedAt > intervalMinutes * 60_000 * 2 + GRACE_MS
  ) {
    return { state: 'warn', reason: '超过 2 个周期未成功' };
  }
  return { state: 'ok', reason: '' };
}

function bucketState(counts) {
  if (!counts || counts.runs === 0) return 'none';
  if (counts.failures > 0) return 'fail';
  if (counts.partial > 0) return 'warn';
  if (counts.unknown > 0) return 'unknown';
  return 'ok';
}

/**
 * @param {{dashboard: object, settings: object, collector: object|null, now?: number,
 *   range?: string, from?: number|null, to?: number|null}} input
 */
export function buildServiceHealth({
  dashboard,
  settings,
  collector,
  now = Date.now(),
  range = '24h',
  from = null,
  to = null,
}) {
  let spec;
  let rangeFrom;
  let rangeTo;
  let start;
  let bucketMs;
  let count;
  if (from != null || to != null) {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || from >= to) {
      throw new RangeError('from 必须是小于 to 的毫秒时间戳');
    }
    if (to - from > 31 * 24 * 60 * 60 * 1000) {
      throw new RangeError('自定义区间不能超过 31 天');
    }
    bucketMs = to - from <= 36 * 60 * 60 * 1000 ? 15 * 60 * 1000 : 60 * 60 * 1000;
    start = Math.floor(from / bucketMs) * bucketMs;
    count = Math.ceil((to - start) / bucketMs);
    rangeFrom = from;
    rangeTo = to;
  } else {
    spec = SERVICE_RANGES[range] ?? SERVICE_RANGES['24h'];
    bucketMs = spec.bucketMs;
    count = spec.count;
    const end = Math.floor(now / bucketMs) * bucketMs + bucketMs;
    start = end - count * bucketMs;
    rangeFrom = start;
    rangeTo = end;
  }

  const latest = latestRuns(dashboard);
  const counts = bucketCounts(dashboard, rangeFrom, rangeTo, bucketMs);

  const services = SERVICE_DEFINITIONS.map((service) => {
    const intervalMinutes = intervalFor(service, settings, collector);
    const enabled = enabledFor(service, collector);
    const run = latest.get(service.id) ?? null;
    const { state, reason } = latestState({
      enabled,
      intervalMinutes,
      run,
      now,
      disabledReason: '日志采集已关闭',
    });

    const buckets = [];
    for (let i = 0; i < count; i += 1) {
      const bucketFrom = start + i * bucketMs;
      const bucketTo = bucketFrom + bucketMs;
      const entry = counts.get(`${service.id}:${bucketFrom}`) ?? null;
      buckets.push({
        from: bucketFrom,
        to: bucketTo,
        state: bucketState(entry),
        runs: entry ? entry.runs : 0,
        failures: entry ? entry.failures : 0,
        partial: entry ? entry.partial : 0,
      });
    }

    return {
      id: service.id,
      label: service.label,
      enabled,
      interval_minutes: intervalMinutes,
      state,
      reason,
      last_started_at: run && typeof run.started_at === 'number' ? run.started_at : null,
      last_finished_at: run && typeof run.finished_at === 'number' ? run.finished_at : null,
      last_status: run && typeof run.status === 'string' ? run.status : null,
      buckets,
    };
  });

  return {
    generated_at: now,
    from: rangeFrom,
    to: rangeTo,
    bucket_ms: bucketMs,
    collector: collector ?? null,
    services,
  };
}
