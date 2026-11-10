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
  if (!ms) return "—"
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, "0")
  const year = d.getFullYear()
  const month = pad(d.getMonth() + 1)
  const day = pad(d.getDate())
  const hour = pad(d.getHours())
  const min = pad(d.getMinutes())
  return `${year}-${month}-${day} ${hour}:${min}`
}

// 表格里列宽紧张：年份对「最近请求」没有信息量，省掉可少 5 个字符。
export function formatTimestampShort(ms: number | null | undefined): string {
  if (!ms) return "—"
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
