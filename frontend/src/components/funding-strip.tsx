import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { formatCurrency } from "@/lib/formatters"
import { FreshnessCard } from "@/components/freshness-card"
import { getServerSettings } from "@/lib/settings"
import type { CapitalPayload } from "@/lib/api"

interface UpstreamLike {
  name?: string
  last_sync?: number | null
}

interface FundingStripProps {
  capital?: CapitalPayload | null
  accounts?: UpstreamLike[]
  now?: number
  className?: string
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

export function FundingStrip({ capital, accounts = [], now, className }: FundingStripProps) {
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
  const runwayThresholds = getServerSettings().monitoring.runway
  const runwayTone =
    runway != null && runway < runwayThresholds.dangerDays
      ? "bad"
      : runway != null && runway < runwayThresholds.warnDays
      ? "warn"
      : undefined

  return (
    <section className={cn("grid grid-cols-1 xl:grid-cols-[2fr_1fr] gap-4 shrink-0", className)}>
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

      <FreshnessCard accounts={accounts} now={now} />
    </section>
  )
}
