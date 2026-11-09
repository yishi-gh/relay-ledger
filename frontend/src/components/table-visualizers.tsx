import { formatCurrency, formatPercent } from "@/lib/formatters"
import {
  formatLatency,
  cacheToneClass,
  latencyP95ToneClass,
} from "@/components/table-utils"
import { cn } from "@/lib/utils"

/** 1. 售出可视化：数字 + 右侧 2px 细横条，按本表最大值归一（>20% 主色，Top1 更深） */
export interface RevenueCellProps {
  value: number | null | undefined
  maxValue?: number
  isTop1?: boolean
}

export function RevenueCell({ value, maxValue = 0, isTop1 = false }: RevenueCellProps) {
  if (value == null || isNaN(value)) {
    return <span className="text-muted-foreground">—</span>
  }
  const pct = maxValue > 0 ? Math.min(100, Math.max(0, (value / maxValue) * 100)) : 0
  return (
    <div className="inline-flex items-center justify-end gap-2 w-full">
      <span className="font-mono tabular-nums text-[13px] leading-[18px]">
        {formatCurrency(value)}
      </span>
      <div className="w-10 sm:w-12 h-[2px] bg-muted/40 rounded-full shrink-0 overflow-hidden flex items-center justify-start">
        <div
          className={cn(
            "h-full rounded-full transition-all duration-300",
            isTop1
              ? "bg-primary font-semibold"
              : pct >= 20
              ? "bg-primary/80"
              : "bg-primary/35"
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

/** 2. 缓存率可视化：数字 + 下方 3px 细进度条（0–100%），>=80 绿 / >=50 黄 / <50 红 */
export interface CacheRateCellProps {
  value: number | null | undefined
}

export function CacheRateCell({ value }: CacheRateCellProps) {
  if (value == null || isNaN(value)) {
    return <span className="text-muted-foreground">—</span>
  }
  const pct = Math.min(100, Math.max(0, value * 100))
  return (
    <div className="flex flex-col items-end justify-center gap-0.5 w-full">
      <span className={cn("text-[13px] leading-[18px] font-mono tabular-nums", cacheToneClass(value))}>
        {formatPercent(value)}
      </span>
      <div className="w-10 sm:w-12 h-[3px] bg-muted/40 rounded-full shrink-0 overflow-hidden">
        <div
          className={cn(
            "h-full rounded-full transition-all duration-300",
            value >= 0.8
              ? "bg-emerald-500"
              : value >= 0.5
              ? "bg-amber-500"
              : "bg-rose-500"
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

/** 3. P95 可视化：条形按 0–60s 归一，>=60s 顶满变红；保留原数字 */
export interface LatencyP95CellProps {
  value: number | null | undefined
}

export function LatencyP95Cell({ value }: LatencyP95CellProps) {
  if (value == null || isNaN(value) || value < 0) {
    return <span className="text-muted-foreground">—</span>
  }
  const pct = Math.min(100, Math.max(0, (value / 60000) * 100))
  const isOver60s = value >= 60000
  return (
    <div className="flex flex-col items-end justify-center gap-0.5 w-full">
      <span className={cn("text-[13px] leading-[18px] font-mono tabular-nums", latencyP95ToneClass(value))}>
        {formatLatency(value)}
      </span>
      <div className="w-10 sm:w-12 h-[3px] bg-muted/40 rounded-full shrink-0 overflow-hidden">
        <div
          className={cn(
            "h-full rounded-full transition-all duration-300",
            isOver60s
              ? "bg-rose-500"
              : value <= 20000
              ? "bg-emerald-500"
              : "bg-amber-500"
          )}
          style={{ width: `${isOver60s ? 100 : pct}%` }}
        />
      </div>
    </div>
  )
}

/** 4. 毛利率可视化：以 0 为轴的正负细条（正绿向右、负红向左）+ 数字 */
export interface MarginCellProps {
  value: number | null | undefined
}

export function MarginCell({ value }: MarginCellProps) {
  if (value == null || isNaN(value)) {
    return <span className="text-muted-foreground">—</span>
  }
  const absPct = Math.min(50, Math.max(0, Math.abs(value) * 50))
  const isPositive = value > 0
  const isNegative = value < 0
  return (
    <div className="inline-flex items-center justify-end gap-1.5 w-full">
      <div className="w-10 sm:w-12 h-[3px] bg-muted/40 rounded-full relative overflow-hidden shrink-0">
        <div className="absolute left-1/2 top-0 bottom-0 w-[1px] bg-muted-foreground/40 z-10" />
        {isPositive && (
          <div
            className="absolute top-0 bottom-0 left-1/2 bg-emerald-500 rounded-r-full transition-all duration-300"
            style={{ width: `${absPct}%` }}
          />
        )}
        {isNegative && (
          <div
            className="absolute top-0 bottom-0 right-1/2 bg-rose-500 rounded-l-full transition-all duration-300"
            style={{ width: `${absPct}%` }}
          />
        )}
      </div>
      <span
        className={cn(
          "text-[13px] leading-[18px] font-mono tabular-nums",
          isPositive
            ? "text-emerald-600 dark:text-emerald-400 font-medium"
            : isNegative
            ? "text-rose-600 dark:text-rose-400 font-medium"
            : "text-muted-foreground"
        )}
      >
        {formatPercent(value)}
      </span>
    </div>
  )
}
