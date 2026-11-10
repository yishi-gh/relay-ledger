import { formatTokens } from "@/lib/formatters"
import { getServerSettings } from "@/lib/settings"

export function formatLatency(ms: number | null | undefined): string {
  if (ms == null || isNaN(ms) || ms < 0) return "—"
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

export function formatTps(v: number | null | undefined): string {
  if (v == null || isNaN(v) || v < 0) return "—"
  return v.toFixed(1)
}

export function formatTokenCn(v: number | null | undefined): string {
  return formatTokens(v)
}

/** 缓存率三档色阶：根据配置 good / warn 动态着色 */
export function cacheToneClass(
  rate: number | null | undefined,
  thresholds = getServerSettings().monitoring.cacheRate
): string {
  if (rate == null || isNaN(rate)) return "text-muted-foreground"
  if (rate >= thresholds.good) return "text-emerald-600 dark:text-emerald-400 font-medium"
  if (rate >= thresholds.warn) return "text-amber-600 dark:text-amber-400 font-medium"
  return "text-rose-600 dark:text-rose-400 font-medium"
}

/** P50 延迟三档色阶：根据配置 goodMs / warnMs 动态着色 */
export function latencyP50ToneClass(
  ms: number | null | undefined,
  thresholds = getServerSettings().monitoring.latencyP50
): string {
  if (ms == null || isNaN(ms) || ms < 0) return "text-muted-foreground"
  if (ms <= thresholds.goodMs) return "text-emerald-600 dark:text-emerald-400 font-medium"
  if (ms <= thresholds.warnMs) return "text-amber-600 dark:text-amber-400 font-medium"
  return "text-rose-600 dark:text-rose-400 font-medium"
}

/** P95 延迟三档色阶：根据配置 goodMs / warnMs 动态着色 */
export function latencyP95ToneClass(
  ms: number | null | undefined,
  thresholds = getServerSettings().monitoring.latencyP95
): string {
  if (ms == null || isNaN(ms) || ms < 0) return "text-muted-foreground"
  if (ms <= thresholds.goodMs) return "text-emerald-600 dark:text-emerald-400 font-medium"
  if (ms <= thresholds.warnMs) return "text-amber-600 dark:text-amber-400 font-medium"
  return "text-rose-600 dark:text-rose-400 font-medium"
}

export interface UserRowData {
  user_name: string
  revenue: number
  requests: number
  tokens: number
  share?: number
}

/** 字符串确定性 Hash，用于稳定分配颜色 */
export function stringHash(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash)
}

/**
 * 按 id/名称稳定取色：--chart-1..12
 * 与总览站点配色互不冲突
 */
export function getDeterministicChartColor(key: string | number): string {
  if (typeof key === "number") {
    const idx = ((Math.abs(key * 7 + 3) % 12) + 1)
    return `var(--chart-${idx})`
  }
  const hash = stringHash(key)
  const idx = ((hash % 12) + 1)
  return `var(--chart-${idx})`
}
