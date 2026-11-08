/**
 * 北京时间（UTC+8，无夏令时）分桶与时间格式化。
 * 固定偏移计算，不依赖运行机器的时区设置。
 */

export const DAY_MS = 86400000;
export const TZ_OFFSET_MS = 8 * 3600000;

/** 毫秒时间戳所在北京自然日的 00:00 对应时间戳 */
export function beijingDayStart(ms) {
  return Math.floor((ms + TZ_OFFSET_MS) / DAY_MS) * DAY_MS - TZ_OFFSET_MS;
}

/**
 * 区间是否是已结束的「完整北京自然日」（可跨多天）。
 * 要求 from 正好是自然日 00:00、to 正好是该自然日 23:59:59.999，且整段已过去。
 * 默认范围 to = MAX(t_ms) 落在日中，因此永远不是完整日。
 */
export function isWholeDayRange(from, to, now = Date.now()) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return false;
  const start = beijingDayStart(from);
  const end = beijingDayStart(to) + DAY_MS - 1;
  return from === start && to === end && to < now;
}

/** "YYYY-MM-DD HH:mm:ss"（北京时间） */
export function formatLocal(ms) {
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');
}

/** "YYYY-MM-DD"（北京时间） */
export function dayKey(ms) {
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 10);
}

/** 秒/毫秒时间戳统一成毫秒；无法识别或非正数返回 null */
export function toEpochMs(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

/**
 * 默认范围：以站点库 MAX(t_ms) 为终点，向前 7 个自然日（含终点当天）。
 * 源库为空时退回「当前时刻往前 7 个自然日」。
 */
export function defaultRange(maxT) {
  if (!Number.isFinite(maxT)) {
    const now = Date.now();
    return { from: beijingDayStart(now) - 6 * DAY_MS, to: now };
  }
  return { from: beijingDayStart(maxT) - 6 * DAY_MS, to: maxT };
}

function parseMs(value, name) {
  if (value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new TypeError(`${name} 必须是整数毫秒时间戳`);
  return n;
}

/** 从 query string 解析 from/to，缺省用默认范围；from > to 视为参数错误 */
export function parseRange(searchParams, maxT) {
  const fallback = defaultRange(maxT);
  const from = parseMs(searchParams.get('from'), 'from');
  const to = parseMs(searchParams.get('to'), 'to');
  const range = { from: from ?? fallback.from, to: to ?? fallback.to };
  if (range.from > range.to) throw new RangeError('from 不能大于 to');
  return range;
}
