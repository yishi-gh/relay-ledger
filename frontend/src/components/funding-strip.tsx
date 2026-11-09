import * as React from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { formatCurrency, formatNumber } from "@/lib/formatters"
import type { CapitalPayload } from "@/lib/api"

interface UpstreamLike {
  name?: string
  last_sync?: number | null
}

interface FundingStripProps {
  capital?: CapitalPayload | null
  accounts?: UpstreamLike[]
  now?: number
}

/** 小时后按陈旧程度分档：30 分钟内正常，2 小时内告警，超过即失效 */
function freshnessTone(hours: number): "muted" | "warn" | "bad" {
  if (hours <= 0.5) return "muted"
  if (hours <= 2) return "warn"
  return "bad"
}

function Metric({
  label,
  value,
  hint,
  hintTitle,
  tone,
}: {
  label: string
  value: string
  hint?: string
  hintTitle?: string
  tone?: "warn" | "bad"
}) {
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <span className="text-[12px] leading-[16px] text-muted-foreground truncate">
        {label}
      </span>
      <span
        className={cn(
          "text-[20px] leading-[24px] font-semibold font-mono tabular-nums whitespace-nowrap",
          tone === "bad"
            ? "text-destructive"
            : tone === "warn"
              ? "text-[var(--chart-3)]"
              : "text-foreground"
        )}
      >
        {value}
      </span>
      {hint ? (
        <span
          className="text-[12px] leading-[16px] text-muted-foreground truncate"
          title={hintTitle ?? hint}
        >
          {hint}
        </span>
      ) : null}
    </div>
  )
}

export function FundingStrip({ capital, accounts = [], now }: FundingStripProps) {
  const total = capital?.total
  // 续航看最短：哪个上游账户最先耗尽，就报它——平均值会掩盖单点风险。
  // 防御性过滤：channels_live === 0 的账户不参与最短续航计算。
  const shortest = (capital?.accounts ?? []).reduce<{
    name: string
    group: string | null
    days: number
  } | null>((acc, a) => {
    if (a.channels_live === 0) return acc
    if (a.runway_days == null || !Number.isFinite(a.runway_days)) return acc
    if (acc && a.runway_days >= acc.days) return acc
    return { name: a.name, group: a.top_group ?? null, days: a.runway_days }
  }, null)
  const runway = shortest?.days ?? null
  const runwayTone =
    runway != null && runway < 3 ? "bad" : runway != null && runway < 7 ? "warn" : undefined

  const [clockFallback] = React.useState(() => Date.now())
  const clock = now ?? clockFallback
  const stale = accounts
    .map((a) => {
      const last = typeof a.last_sync === "number" ? a.last_sync : null
      const hours = last ? (clock - last) / 36e5 : null
      return { name: a.name || "未知账户", hours }
    })
    .filter((a) => a.hours != null && a.hours > 0.5)
    .sort((a, b) => (b.hours ?? 0) - (a.hours ?? 0))

  const latest = accounts.reduce<number | null>((acc, a) => {
    const last = typeof a.last_sync === "number" ? a.last_sync : null
    return last != null && (acc == null || last > acc) ? last : acc
  }, null)

  return (
    <section className="grid grid-cols-1 xl:grid-cols-[2fr_1fr] gap-4 shrink-0">
      <Card className="shadow-xs">
        <CardContent className="p-4 grid grid-cols-2 xl:grid-cols-4 gap-3 items-start">
          <Metric
            label="上游总余额"
            value={formatCurrency(total?.balance ?? null)}
            hint={`${total?.accounts_counted ?? accounts.length} 个账户`}
          />
          <Metric
            label="7 日日均成本"
            value={formatCurrency(total?.daily_avg_7d ?? null)}
            hint="按自然日摊分"
          />
          <Metric
            label="最短续航"
            value={runway == null ? "—" : `${runway.toFixed(1)} 天`}
            hint={
              shortest
                ? `${shortest.group ?? "未分组"} · ${shortest.name}`
                : runway == null
                  ? "缺余额或成本"
                  : "余额 ÷ 日均成本"
            }
            hintTitle={
              shortest
                ? `${shortest.group ?? "未分组"} / ${shortest.name}：最先耗尽的账户，余额 ÷ 日均成本`
                : undefined
            }
            tone={runwayTone}
          />
          <Metric
            label="7 日充值"
            value={formatCurrency(total?.credits ?? null)}
            hint="含赠额"
          />
        </CardContent>
      </Card>

      <Card className="shadow-xs">
        <CardContent className="p-4 flex flex-col gap-1.5 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12px] leading-[16px] text-muted-foreground">
              数据新鲜度
            </span>
            {stale.length === 0 ? (
              <Badge variant="outline" className="text-[12px] leading-[16px]">
                正常
              </Badge>
            ) : (
              <Badge variant="destructive" className="text-[12px] leading-[16px]">
                {stale.length} 个陈旧
              </Badge>
            )}
          </div>
          {stale.length === 0 ? (
            <span className="text-[14px] leading-[20px] text-foreground">
              全部账户同步正常
              <span className="text-muted-foreground">
                {" "}
                · 最近{" "}
                {latest
                  ? new Date(latest).toLocaleTimeString("zh-CN", {
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                    })
                  : "—"}
              </span>
            </span>
          ) : (
            <ul className="flex flex-col gap-1 min-w-0">
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
                      freshnessTone(a.hours ?? 0) === "bad"
                        ? "text-destructive font-semibold"
                        : freshnessTone(a.hours ?? 0) === "warn"
                          ? "text-[var(--chart-3)]"
                          : "text-muted-foreground"
                    )}
                  >
                    陈旧 {formatNumber(Math.round(a.hours ?? 0))} 小时
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
        </CardContent>
      </Card>
    </section>
  )
}
