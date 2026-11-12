import { getPreferences } from "./settings"

export function formatCurrency(value: number | null | undefined, fallback = "—"): string {
  if (value == null || !Number.isFinite(value)) return fallback
  const decimals = getPreferences().display.currencyDecimals
  const prefix = value < 0 ? "-$" : "$"
  return `${prefix}${Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`
}

export function formatPercent(value: number | null | undefined, fallback = "—"): string {
  if (value == null || !Number.isFinite(value)) return fallback
  return `${(value * 100).toFixed(getPreferences().display.percentDecimals)}%`
}

/** 完整数值用于悬停与配置基准，不受紧凑单位和显示小数位影响。 */
export function formatRawNumber(value: number | null | undefined, fallback = "—"): string {
  if (value == null || !Number.isFinite(value)) return fallback
  return value.toLocaleString("en-US", { maximumSignificantDigits: 21 })
}

export function formatQuantity(value: number | null | undefined, fallback = "—"): string {
  if (value == null || !Number.isFinite(value)) return fallback
  const { unitSystem, tokenDecimals } = getPreferences().display
  const units: [number, string][] = unitSystem === "zh"
    ? [[1e12, "万亿"], [1e8, "亿"], [1e4, "万"]]
    : unitSystem === "en" ? [[1e9, "B"], [1e6, "M"], [1e3, "k"]] : []
  const unit = units.find(([threshold]) => Math.abs(value) >= threshold)
  const amount = unit ? value / unit[0] : value
  return `${amount.toLocaleString("en-US", { maximumFractionDigits: tokenDecimals })}${unit ? ` ${unit[1]}` : ""}`
}

export function formatNumber(value: number | null | undefined, fallback = "—"): string {
  return formatQuantity(value, fallback)
}

export function formatTokens(value: number | null | undefined, fallback = "—"): string {
  return formatQuantity(value, fallback)
}

export function formatTimestamp(ms: number | null | undefined): string {
  return formatBeijingTime(ms)
}

// 表格里列宽紧张：年份对「最近请求」没有信息量，省掉可少 5 个字符。
export function formatTimestampShort(ms: number | null | undefined): string {
  if (!ms) return "—"
  return formatBeijingShort(ms)
}

// 中国无夏令时，统一按固定 +08:00 读取，避免依赖浏览器或 Node 的本地时区。
const BEIJING_OFFSET_MS = 8 * 3600_000

function beijingDate(ms: number): Date {
  return new Date(ms + BEIJING_OFFSET_MS)
}

function pad2(value: number): string {
  return String(value).padStart(2, "0")
}

/** 北京时间 YYYY-MM-DD HH:mm，空值保持 —。 */
export function formatBeijingTime(ms: number | null | undefined): string {
  if (!ms) return "—"
  const d = beijingDate(ms)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
}

/** 北京时间 MM-DD HH:mm，用于紧凑说明。 */
export function formatBeijingShort(ms: number): string {
  const d = beijingDate(ms)
  return `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
}

/** 北京时间 MM-DD，供两行紧凑布局的日期行复用。 */
export function formatBeijingDate(ms: number): string {
  const d = beijingDate(ms)
  return `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

/** 北京时间 HH:mm，可选 HH:mm:ss；showSeconds 默认 false，保持既有调用输出。 */
export function formatBeijingClock(ms: number, showSeconds = false): string {
  const d = beijingDate(ms)
  const clock = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
  return showSeconds ? `${clock}:${pad2(d.getUTCSeconds())}` : clock
}
