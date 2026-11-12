/**
 * nginx 访问日志错误码聚合表的读写原语（看板库 `http_errors_hourly`）。
 *
 * 表以「北京整点 × 状态码 × 路径组」为粒度，写入是累加式 UPSERT：
 * 同一桶被多次读到（例如采集失败后重读）会叠加，调用方负责用增量位点避免重复。
 * 位点复用 `schema_meta`，key = `http_errors_offset`，value 是已处理的字节偏移（字符串）。
 */

export const OFFSET_KEY = 'http_errors_offset';

function hasTable(db, name) {
  return Boolean(
    db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
}

/** 读取已处理的字节偏移；没有记录、非法值或缺少 schema_meta 表时返回 0 */
export function readOffset(db) {
  if (!hasTable(db, 'schema_meta')) return 0;
  const row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(OFFSET_KEY);
  const n = Number.parseInt(String(row?.value ?? ''), 10);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/** 写回字节偏移；值统一存字符串，重复调用只更新最后一行 */
export function writeOffset(db, offset, now = Date.now()) {
  const value = Number.isSafeInteger(Number(offset)) && Number(offset) >= 0 ? Number(offset) : 0;
  db.prepare(
    `INSERT INTO schema_meta (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(OFFSET_KEY, String(value), now);
  return value;
}

/**
 * 累加写入一批桶：`[{ hour_ms, status, path_group, count }]`。
 * 同一主键再次写入时 `count` 相加而不是覆盖；返回写入的桶数。
 */
export function upsertBuckets(db, rows, now = Date.now()) {
  const list = (Array.isArray(rows) ? rows : []).filter(
    (r) =>
      Number.isInteger(r?.hour_ms) &&
      Number.isInteger(r?.status) &&
      typeof r?.path_group === 'string' &&
      Number.isInteger(r?.count) &&
      r.count > 0,
  );
  if (list.length === 0) return 0;

  const stmt = db.prepare(
    `INSERT INTO http_errors_hourly (hour_ms, status, path_group, count, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(hour_ms, status, path_group) DO UPDATE SET
       count = count + excluded.count,
       updated_at = excluded.updated_at`,
  );
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of list) stmt.run(row.hour_ms, row.status, row.path_group, row.count, now);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return list.length;
}

/** `hour_ms` 闭区间内的桶；按时间、状态码、路径组排序 */
export function readErrorBuckets(db, from, to) {
  const rows = db
    .prepare(
      `SELECT hour_ms, status, path_group, count
         FROM http_errors_hourly
        WHERE hour_ms >= ? AND hour_ms <= ?
        ORDER BY hour_ms, status, path_group`,
    )
    .all(Number(from), Number(to));
  return rows.map((r) => ({
    hour_ms: Number(r.hour_ms),
    status: Number(r.status),
    path_group: String(r.path_group),
    count: Number(r.count),
  }));
}

/**
 * 纯函数：把桶列表汇总成总数、按状态码、按路径组、按小时四组。
 * `by_status` 按状态码升序；`by_group` 按次数降序（同次数按名称）；`by_hour` 按时间升序。
 * 只输出出现过的分组，不补 0。
 */
export function summarizeBuckets(rows) {
  const byStatus = new Map();
  const byGroup = new Map();
  const byHour = new Map();
  let total = 0;

  for (const row of Array.isArray(rows) ? rows : []) {
    const count = Number(row?.count);
    if (!Number.isFinite(count) || count <= 0) continue;
    const status = Number(row.status);
    const group = String(row.path_group);
    const hour = Number(row.hour_ms);
    total += count;
    byStatus.set(status, (byStatus.get(status) ?? 0) + count);
    byGroup.set(group, (byGroup.get(group) ?? 0) + count);
    byHour.set(hour, (byHour.get(hour) ?? 0) + count);
  }

  return {
    total,
    by_status: [...byStatus.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([status, count]) => ({ status, count })),
    by_group: [...byGroup.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([path_group, count]) => ({ path_group, count })),
    by_hour: [...byHour.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([hour_ms, count]) => ({ hour_ms, count })),
  };
}
