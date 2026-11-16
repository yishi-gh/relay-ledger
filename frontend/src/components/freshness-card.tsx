import * as React from "react"
import { Card, CardContent } from "@/components/ui/card"
import { CheckCircle2, ChevronDown, Radio } from "lucide-react"
import { cn } from "@/lib/utils"
import { formatBeijingClock, formatTimestampShort } from "@/lib/formatters"
import { getServerSettings } from "@/lib/settings"
import {
  QualityBadge,
  QualityEmptyState,
  QualityPanelHeader,
  QualityStatusRow,
} from "@/components/quality-kit"

export interface UpstreamLike {
  id?: string
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
  const [expanded, setExpanded] = React.useState(false)
  const clock = now ?? clockFallback
  const thresholds = getServerSettings().monitoring.freshness

  const stale = accounts
    .map((a) => {
      const last = typeof a.last_sync === "number" ? a.last_sync : null
      const diffMs = last ? clock - last : null
      const minutes = diffMs != null ? Math.max(0, Math.floor(diffMs / 60000)) : null
      return { id: a.id, name: a.name || a.id || "未知账户", last, minutes }
    })
    .filter((a) => a.last == null || (a.minutes != null && a.minutes > thresholds.warnMinutes))
    .sort((a, b) => {
      if (a.last == null && b.last == null) return 0
      if (a.last == null) return -1
      if (b.last == null) return 1
      return (b.minutes ?? 0) - (a.minutes ?? 0)
    })

  const visible = expanded ? stale : stale.slice(0, 3)

  const latest = accounts.reduce<number | null>((acc, a) => {
    const last = typeof a.last_sync === "number" ? a.last_sync : null
    return last != null && (acc == null || last > acc) ? last : acc
  }, null)

  return (
    <Card className={cn("dashboard-panel shadow-xs overflow-hidden flex flex-col gap-0 p-4", className)}>
      <QualityPanelHeader title="数据新鲜度" icon={Radio}>
        <QualityBadge tone={stale.length === 0 ? "good" : "bad"}>
          {stale.length === 0 ? "正常" : `${stale.length} 个陈旧`}
        </QualityBadge>
      </QualityPanelHeader>

      <CardContent className="p-0 flex-1 min-h-0 flex flex-col gap-2">
        {stale.length === 0 ? (
          <QualityEmptyState
            icon={CheckCircle2}
            title="全部账户同步正常"
            detail={`最近同步：${latest ? formatBeijingClock(latest) : "—"}`}
          />
        ) : (
          <>
            <ul id="freshness-stale-list" className="flex max-h-[260px] min-w-0 flex-col gap-1.5 overflow-y-auto pr-0.5 md:max-h-[300px]">
              {visible.map((a) => (
                <li key={a.id ?? a.name}>
                  <QualityStatusRow
                    tone={
                      freshnessTone(a.minutes, thresholds) === "bad"
                        ? "bad"
                        : freshnessTone(a.minutes, thresholds) === "warn"
                          ? "warn"
                          : "neutral"
                    }
                    title={a.name}
                    detail={formatFreshnessText(a.minutes)}
                    meta={a.last != null ? formatTimestampShort(a.last) : "—"}
                  />
                </li>
              ))}
            </ul>
            {stale.length > 3 ? (
              <button
                type="button"
                aria-expanded={expanded}
                aria-controls="freshness-stale-list"
                onClick={() => setExpanded((value) => !value)}
                className="inline-flex w-full shrink-0 items-center justify-center gap-1 rounded-md border border-border/60 bg-muted/20 px-2 py-1 text-[12px] leading-[16px] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
              >
                {expanded ? "收起" : `另有 ${stale.length - 3} 个`}
                <ChevronDown
                  className={cn("size-3.5 transition-transform", expanded && "rotate-180")}
                />
              </button>
            ) : null}
          </>
        )}

        <div className="mt-auto text-[12px] leading-[16px] text-muted-foreground border-t border-border/60 pt-2 shrink-0">
          上游账户共 {accounts.length} 个 · 阈值 {thresholds.warnMinutes} 分钟
        </div>
      </CardContent>
    </Card>
  )
}
