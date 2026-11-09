/**
 * 渠道启用状态（channel_state）：源库 channels 的只读镜像。
 *
 * 每轮日志采集整表替换：源库删除的渠道下一轮自然消失，状态变化也不会留下旧行。
 * 表缺失或为空时读取返回 null，调用方据此回退到「不过滤」的旧行为。
 */

/** 源库 channels 一行（id → channel_id）统一成入库结构 */
function normalizeRow(row) {
  const id = Number(row?.id ?? row?.channel_id);
  if (!Number.isInteger(id)) return null;
  const status = row?.status == null ? null : Number(row.status);
  return {
    channel_id: id,
    name: row?.name == null ? null : String(row.name),
    status: Number.isFinite(status) ? status : null,
    base_url: row?.base_url == null ? null : String(row.base_url),
  };
}

/**
 * 整表替换渠道状态：单事务内先 DELETE 再批量 INSERT。
 * 返回写入行数；rows 里 id 非整数的行跳过（不允许落进 SQLite 的 rowid）。
 */
export function replaceChannelStates(db, rows, now = Date.now()) {
  const list = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const normalized = normalizeRow(row);
    if (normalized) list.push(normalized);
  }
  const stmt = db.prepare(
    `INSERT INTO channel_state (channel_id, name, status, base_url, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM channel_state');
    for (const row of list) {
      stmt.run(row.channel_id, row.name, row.status, row.base_url, now);
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
  return list.length;
}

/**
 * 全量渠道状态：Map<channel_id, { status, name }>。
 * 表不存在或一行都没有时返回 null（旧库/首轮采集前 → 接口不过滤）。
 */
export function readChannelStates(db) {
  let rows;
  try {
    rows = db.prepare('SELECT channel_id, name, status FROM channel_state').all();
  } catch {
    return null;
  }
  if (!rows.length) return null;
  const states = new Map();
  for (const row of rows) {
    const id = Number(row.channel_id);
    if (!Number.isInteger(id)) continue;
    states.set(id, {
      status: row.status == null ? null : Number(row.status),
      name: row.name == null ? '' : String(row.name),
    });
  }
  return states.size ? states : null;
}

/** 启用（status===1）的渠道 id 集合；表不存在或为空时返回 null */
export function readLiveChannelIds(db) {
  const states = readChannelStates(db);
  if (states === null) return null;
  const live = new Set();
  for (const [id, state] of states) {
    if (state.status === 1) live.add(id);
  }
  return live;
}
