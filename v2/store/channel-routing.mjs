/**
 * 渠道路由配置快照：源库 channels + abilities 的一致读结果，存在看板库单行表里。
 *
 * 与 channel_state 的分工：
 * - channel_state 只服务日志过滤（启用/停用），每轮整表替换；
 * - 本快照服务「渠道路由」页，保留渠道配置与 abilities，不改任何上游配置。
 *
 * 语义：
 * - payload 存在 = 至少成功同步过一次（available）；
 * - 同步失败只更新 last_attempt_at / last_error，保留旧 payload，绝不把旧数据当最新；
 * - 已采到空 channels 或 abilities 表存在但 0 行，属于「合法的空」，与「从未采集」不同。
 */

const EMPTY = Object.freeze({
  available: false,
  synced_at: null,
  last_attempt_at: null,
  error: null,
  payload: null,
});

function rowOf(db) {
  try {
    return db
      .prepare(
        'SELECT payload, synced_at, last_attempt_at, last_error FROM channel_routing_snapshot WHERE id = 1',
      )
      .get() ?? null;
  } catch (err) {
    // 只容忍「表还不存在」（老库未迁移）；库关闭/损坏等错误必须向上抛，不能吞成未采集
    if (/no such table/i.test(String(err?.message ?? ''))) return null;
    throw err;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** 校验落库 payload 的基本结构；坏数据返回 null，由调用方标记不可用 */
function normalizeStoredPayload(value) {
  if (!isPlainObject(value)) return null;
  if (!Array.isArray(value.channels) || !Array.isArray(value.abilities)) return null;
  if (typeof value.routes_available !== 'boolean') return null;
  if (value.routes_error !== null && typeof value.routes_error !== 'string') return null;

  const channels = [];
  for (const item of value.channels) {
    if (!isPlainObject(item) || !Number.isInteger(item.id)) return null;
    if (item.name != null && typeof item.name !== 'string') return null;
    if (item.type != null && !Number.isInteger(item.type)) return null;
    if (item.status != null && !Number.isFinite(item.status)) return null;
    if (item.base_url != null && typeof item.base_url !== 'string') return null;
    if (item.model_mapping != null && typeof item.model_mapping !== 'string') return null;
    channels.push(item);
  }

  const abilities = [];
  for (const item of value.abilities) {
    if (!isPlainObject(item)) return null;
    if (typeof item.group !== 'string' || typeof item.model !== 'string') return null;
    if (!Number.isInteger(item.channel_id)) return null;
    abilities.push(item);
  }

  return {
    channels,
    abilities,
    routes_available: value.routes_available,
    routes_error: value.routes_error,
  };
}

/** 读取最近一次快照；损坏的 payload 视为不可用并带错误，不抛断整个接口 */
export function readRoutingSnapshot(db) {
  const row = rowOf(db);
  if (!row) return { ...EMPTY };
  let payload = null;
  let error = row.last_error == null ? null : String(row.last_error);
  if (row.payload != null) {
    try {
      payload = normalizeStoredPayload(JSON.parse(String(row.payload)));
    } catch {
      payload = null;
    }
    if (payload === null) error = '路由快照内容损坏';
  }
  return {
    available: payload !== null,
    synced_at: row.synced_at == null ? null : Number(row.synced_at),
    last_attempt_at: row.last_attempt_at == null ? null : Number(row.last_attempt_at),
    error,
    payload,
  };
}

/** 成功同步：整行覆盖 payload/synced_at，同时清掉上一次错误 */
export function replaceRoutingSnapshot(
  db,
  { channels, abilities, routesAvailable, routesError = null, now = Date.now() },
) {
  const payload = {
    channels: Array.isArray(channels) ? channels : [],
    abilities: Array.isArray(abilities) ? abilities : [],
    routes_available: routesAvailable !== false,
    routes_error: routesError == null ? null : String(routesError),
  };
  const body = JSON.stringify(payload);
  db.prepare(
    `INSERT INTO channel_routing_snapshot (id, payload, synced_at, last_attempt_at, last_error)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       payload = excluded.payload,
       synced_at = excluded.synced_at,
       last_attempt_at = excluded.last_attempt_at,
       last_error = NULL`,
  ).run(body, now, now, routesError == null ? null : String(routesError));
  return payload;
}

/** 同步失败：保留旧 payload 与 synced_at，只记录尝试时间与错误 */
export function recordRoutingFailure(db, { error, now = Date.now() }) {
  const message = error == null ? '未知错误' : String(error);
  db.prepare(
    `INSERT INTO channel_routing_snapshot (id, payload, synced_at, last_attempt_at, last_error)
     VALUES (1, NULL, NULL, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       last_attempt_at = excluded.last_attempt_at,
       last_error = excluded.last_error`,
  ).run(now, message);
  return message;
}
