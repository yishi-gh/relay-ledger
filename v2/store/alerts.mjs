/**
 * 主动告警状态：当前活动告警、去重与恢复。
 *
 * 只读写看板库的 alert_state；告警内容由调用方构造，不能包含 token、cookie 或 key。
 */

const DEFAULT_REPEAT_MS = 24 * 60 * 60 * 1000;

function missingTable(err) {
  return /no such table/i.test(String(err?.message ?? ''));
}

/** 当前活动告警，error 在前、warn 在后。 */
export function listActiveAlerts(db) {
  try {
    return db.prepare(
      `SELECT alert_key, severity, title, detail, first_seen_at, last_seen_at, last_sent_at
         FROM alert_state
        WHERE resolved_at IS NULL
        ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END,
                 last_seen_at DESC,
                 alert_key`,
    ).all();
  } catch (err) {
    if (missingTable(err)) return [];
    throw err;
  }
}

/**
 * 同步当前活动告警，返回本轮应发送的告警。
 * 新告警立即发送；同一告警在 repeatMs 内不重复发送；消失的告警标记 resolved。
 */
export function syncAlertState(
  db,
  alerts,
  { now = Date.now(), repeatMs = DEFAULT_REPEAT_MS } = {},
) {
  const list = Array.isArray(alerts) ? alerts : [];
  const activeKeys = new Set(list.map((alert) => alert.key));
  const existingRows = db.prepare(
    'SELECT alert_key, resolved_at, last_sent_at FROM alert_state',
  ).all();
  const existing = new Map(existingRows.map((row) => [row.alert_key, row]));

  db.exec('BEGIN');
  try {
    const upsert = db.prepare(
      `INSERT INTO alert_state
         (alert_key, severity, title, detail, first_seen_at, last_seen_at, last_sent_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(alert_key) DO UPDATE SET
         severity = excluded.severity,
         title = excluded.title,
         detail = excluded.detail,
         last_seen_at = excluded.last_seen_at,
         resolved_at = NULL`,
    );
    const remove = db.prepare('DELETE FROM alert_state WHERE alert_key = ?');
    const resolve = db.prepare(
      'UPDATE alert_state SET resolved_at = ? WHERE alert_key = ? AND resolved_at IS NULL',
    );

    for (const alert of list) {
      const key = String(alert?.key ?? '');
      if (!key) continue;
      const previous = existing.get(key);
      // 已恢复的旧告警再次出现时重新开始，避免沿用上一轮的 last_sent_at。
      if (previous && previous.resolved_at != null) remove.run(key);
      upsert.run(
        key,
        alert.severity === 'error' ? 'error' : 'warn',
        String(alert.title ?? key),
        alert.detail == null ? null : String(alert.detail),
        now,
        now,
      );
    }

    for (const key of existing.keys()) {
      if (!activeKeys.has(key)) resolve.run(now, key);
    }
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 回滚失败不覆盖原始错误
    }
    throw err;
  }

  return listActiveAlerts(db).filter(
    (row) => row.last_sent_at == null || now - row.last_sent_at >= repeatMs,
  );
}

/** 只在成功投递后调用；失败时保留 last_sent_at，下一轮重试。 */
export function markAlertsSent(db, keys, now = Date.now()) {
  const list = Array.isArray(keys) ? [...new Set(keys)] : [];
  if (list.length === 0) return 0;
  const stmt = db.prepare('UPDATE alert_state SET last_sent_at = ? WHERE alert_key = ?');
  let updated = 0;
  for (const key of list) updated += stmt.run(now, key).changes;
  return updated;
}
