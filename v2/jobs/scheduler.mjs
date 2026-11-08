/**
 * 整点对齐延迟（纯函数）。
 *
 * 常驻定时链由 run-scheduler.mjs 的 createLoop 负责，这里只提供首轮延迟计算。
 */

const HOUR_MS = 60 * 60 * 1000;
/** 整点后留 10 秒，避开对端整点抖动 */
const HOUR_SETTLE_MS = 10 * 1000;
const MIN_DELAY_MS = 1000;

/**
 * 距「下一个整点 + 10 秒」的毫秒数，最小 1000ms。
 * 跨日、跨月由时间戳自然处理，不做特殊分支。
 */
export function nextHourDelayMs(nowMs) {
  const t = Number.isFinite(nowMs) ? nowMs : Date.now();
  const nextBoundary = Math.floor(t / HOUR_MS) * HOUR_MS + HOUR_MS;
  return Math.max(nextBoundary + HOUR_SETTLE_MS - t, MIN_DELAY_MS);
}
