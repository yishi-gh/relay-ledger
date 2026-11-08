export function formatCurrency(value: number | null | undefined, fallback = "—"): string {
  if (value == null || isNaN(value)) return fallback
  const prefix = value < 0 ? "-$" : "$"
  return `${prefix}${Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

export function formatPercent(value: number | null | undefined, fallback = "—"): string {
  if (value == null || isNaN(value)) return fallback
  return `${(value * 100).toFixed(1)}%`
}

export function formatNumber(value: number | null | undefined, fallback = "—"): string {
  if (value == null || isNaN(value)) return fallback
  return value.toLocaleString("en-US")
}

export function formatTokens(value: number | null | undefined, fallback = "—"): string {
  if (value == null || isNaN(value)) return fallback
  // 以“亿”为单位格式化
  const yi = value / 1e8
  return `${yi.toFixed(2)} 亿`
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
