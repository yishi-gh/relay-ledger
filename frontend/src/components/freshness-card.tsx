import * as React from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Radio } from "lucide-react"
import { cn } from "@/lib/utils"
import { getServerSettings } from "@/lib/settings"

export interface UpstreamLike {
  name?: string
  last_sync?: number | null
}

export interface FreshnessCardProps {
  accounts?: UpstreamLike[]
  now?: number
  className?: string
}

/** 分钟后按陈旧程度分档：warnMinutes 内正常，dangerMinutes 内告警，超过或缺失即失效/未同步 */
export function freshnessTone(
  minutes: number | null | undefined,
  thresholds = getServerSettings().monitoring.freshness
): "muted" | "warn" | "bad" {
  if (minutes == null || !Number.isFinite(minutes)) return "bad"
  if (minutes <= thresholds.warnMinutes) return "muted"
  if (minutes <= thresholds.dangerMinutes) return "warn"
  return "bad"
}

function formatFreshnessText(minutes: number | null): string {
  if (minutes == null) return "未同步"
  if (minutes < 60) return `陈旧 ${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  if (mins === 0) return `陈旧 ${hours} 小时`
  return `陈旧 ${hours}小时 ${mins}分`
}

export function FreshnessCard({ accounts = [], now, className }: FreshnessCardProps) {
  const [clockFallback] = React.useState(() => Date.now())
  const clock = now ?? clockFallback
  const thresholds = getServerSettings().monitoring.freshness

  const stale = accounts
    .map((a) => {
      const last = typeof a.last_sync === "number" ? a.last_sync : null
      const diffMs = last ? clock - last : null
      const minutes = diffMs != null ? Math.max(0, Math.floor(diffMs / 60000)) : null
      return { name: a.name || "未知账户", last, minutes }
    })
    .filter((a) => a.last == null || (a.minutes != null && a.minutes > thresholds.warnMinutes))
    .sort((a, b) => {
      if (a.last == null && b.last == null) return 0
      if (a.last == null) return -1
      if (b.last == null) return 1
      return (b.minutes ?? 0) - (a.minutes ?? 0)
    })

  const latest = accounts.reduce<number | null>((acc, a) => {
    const last = typeof a.last_sync === "number" ? a.last_sync : null
    return last != null && (acc == null || last > acc) ? last : acc
  }, null)

  return (
    <Card className={cn("shadow-xs overflow-hidden flex flex-col gap-0 p-3.5", className)}>
      <CardHeader className="p-0 pb-2.5 shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CardTitle className="text-[16px] leading-[24px] font-medium text-foreground">
              数据新鲜度
            </CardTitle>
            {stale.length === 0 ? (
              <Badge
                variant="outline"
                className="text-[12px] leading-[16px] h-5 px-1.5 font-medium text-emerald-600 dark:text-emerald-400 border-emerald-500/30 bg-emerald-500/10"
              >
                正常
              </Badge>
            ) : (
              <Badge variant="destructive" className="text-[12px] leading-[16px] h-5 px-1.5 font-medium tabular-nums">
                {stale.length} 个陈旧
              </Badge>
            )}
          </div>
          <Radio className="size-4 text-muted-foreground" />
        </div>
      </CardHeader>

      <CardContent className="p-0 flex-1 min-h-0 flex flex-col justify-between gap-1.5">
        {stale.length === 0 ? (
          <div className="flex flex-col justify-center flex-1 min-h-0 py-1">
            <span className="text-[14px] leading-[20px] text-foreground font-medium">
              全部账户同步正常
            </span>
            <span className="text-[12px] leading-[16px] text-muted-foreground mt-0.5">
              最近同步：
              {latest
                ? new Date(latest).toLocaleTimeString("zh-CN", {
                    hour: "2-digit",
                    minute: "2-digit",
                    hour12: false,
                  })
                : "—"}
            </span>
          </div>
        ) : (
          <ul className="flex flex-col gap-1 min-w-0 flex-1 overflow-y-auto">
            {stale.slice(0, 3).map((a) => (
              <li
                key={a.name}
                className="flex items-center justify-between gap-2 text-[12px] leading-[16px] min-w-0"
              >
                <span className="truncate text-muted-foreground" title={a.name}>
                  {a.name}
                </span>
                <span
                  className={cn(
                    "font-mono tabular-nums shrink-0",
                    freshnessTone(a.minutes, thresholds) === "bad"
                      ? "text-destructive font-semibold"
                      : freshnessTone(a.minutes, thresholds) === "warn"
                        ? "text-[var(--chart-3)]"
                        : "text-muted-foreground"
                  )}
                >
                  {formatFreshnessText(a.minutes)}
                </span>
              </li>
            ))}
            {stale.length > 3 ? (
              <li className="text-[12px] leading-[16px] text-muted-foreground">
                另有 {stale.length - 3} 个
              </li>
            ) : null}
          </ul>
        )}

        <div className="text-[12px] leading-[16px] text-muted-foreground border-t border-border/50 pt-1.5 shrink-0">
          上游账户共 {accounts.length} 个 · 阈值 {thresholds.warnMinutes} 分钟
        </div>
      </CardContent>
    </Card>
  )
}
