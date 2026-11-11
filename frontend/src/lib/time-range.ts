import type { DateRange, RangeType } from "./api"

export const HOUR_MS = 3600000
export const DAY_MS = 24 * HOUR_MS
const BEIJING_OFFSET_MS = 8 * HOUR_MS
const CLOCK_TOLERANCE_MS = 60000

export function beijingDayStart(ms: number): number {
  return Math.floor((ms + BEIJING_OFFSET_MS) / DAY_MS) * DAY_MS - BEIJING_OFFSET_MS
}

/** datetime-local 的输入始终解释为北京时间，不使用浏览器所在时区。 */
export function parseBeijingDateTime(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value)
  if (!match) throw new RangeError("请输入完整的北京时间")
  const [year, month, day, hour, minute, second] = match.slice(1).map((part) => Number(part ?? 0))
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, second, 0)
  if (
    date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day || date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second
  ) {
    throw new RangeError("北京时间的日期或时间无效")
  }
  return date.getTime() - BEIJING_OFFSET_MS
}

function pad2(value: number): string {
  return String(value).padStart(2, "0")
}

export function formatBeijingDateTimeInput(ms: number): string {
  const date = new Date(ms + BEIJING_OFFSET_MS)
  if (!Number.isFinite(ms) || !Number.isFinite(date.getTime())) throw new RangeError("时间戳无效")
  return `${String(date.getUTCFullYear()).padStart(4, "0")}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}T${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`
}

export function validateCustomRange(range: DateRange | null | undefined, now = Date.now()): DateRange {
  if (!range || !Number.isFinite(range.from) || !Number.isFinite(range.to) ||
    !Number.isFinite(new Date(range.from).getTime()) || !Number.isFinite(new Date(range.to).getTime())) {
    throw new RangeError("请选择完整有效的自定义时间范围")
  }
  if (range.from >= range.to) throw new RangeError("开始时间必须早于结束时间")
  if (range.to - range.from > 31 * DAY_MS) throw new RangeError("自定义时间范围不能超过 31 天")
  if (!Number.isFinite(now) || range.to > now + CLOCK_TOLERANCE_MS) throw new RangeError("结束时间不能晚于当前时间")
  return { from: range.from, to: range.to }
}

export function getRangeGranularity(rangeType: RangeType, range: DateRange): "hour" | "day" {
  if (rangeType === "7d") return "day"
  if (rangeType === "custom" && range.to - range.from > 36 * HOUR_MS) return "day"
  return "hour"
}

export function getTimeRangeKey(rangeType: RangeType, range?: DateRange | null): string {
  return rangeType === "custom" ? `${rangeType}:${range?.from}:${range?.to}` : rangeType
}

export function beijingTrendBucket(ms: number, granularity: "hour" | "day"): string {
  const input = formatBeijingDateTimeInput(ms)
  return granularity === "hour" ? `${input.slice(0, 10)} ${input.slice(11, 13)}:00` : input.slice(0, 10)
}

export function bucketLabel(bucket: string, granularity: "hour" | "day"): string {
  return granularity === "hour" ? bucket.split(" ")[1] ?? bucket : bucket.slice(5)
}
