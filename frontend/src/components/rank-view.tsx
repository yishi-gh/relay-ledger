import * as React from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { AlertCircle, ChevronRight, Inbox } from "lucide-react"
import { formatCurrency, formatPercent } from "@/lib/formatters"
import { fetchStatus, fetchModels, type StatusPayload, type DateRange, type ModelItem, type ProfitSite, type RangeType } from "@/lib/api"
import { useSettings } from "@/lib/settings"
import { type UserRowData } from "@/components/table-utils"
import type { ChannelRowData } from "@/components/channels-rank-view"
import type { GroupRowData } from "@/components/groups-rank-view"
import { SiteLogo } from "@/components/site-logo"
import { cn } from "@/lib/utils"

interface RankViewProps {
  timeRange: RangeType
  channels: ChannelRowData[]
  groups: GroupRowData[]
  users: UserRowData[]
  profitSites?: ProfitSite[]
  dateRange?: DateRange | null
  refreshKey?: number
  onNavigateChannelsDetail: () => void
  onNavigateGroupsDetail: () => void
}

interface RankingItem {
  key: string
  name: string
  value: number
  share?: number
  detail?: string
  logo?: { kind: "channel" | "account"; id: string | number }
}

function RevenueRing({ items }: { items: RankingItem[] }) {
  const ranked = [...items].sort((a, b) => b.value - a.value).slice(0, 5)
  const total = items.reduce((sum, item) => sum + item.value, 0)
  const valid = total > 0 && items.every((item) => item.value >= 0)
  const shares = ranked.map((item) => item.share ?? item.value / total)
  const topShare = valid ? Math.min(1, shares.reduce((sum, share) => sum + share, 0)) : 0
  let offset = 0
  const segments = valid ? ranked.map((item, index) => {
    const share = Math.max(0, Math.min(shares[index], 1 - offset))
    const segment = { item, share, offset, color: `var(--chart-${index + 1})` }
    offset += share
    return segment
  }) : []
  return (
    <div className="relative size-28 shrink-0 self-center sm:max-h-full sm:size-[clamp(120px,calc((100dvh-336px)/3),128px)] xl:size-[clamp(120px,calc((100dvh-336px)/3),144px)]" role="img" aria-label={valid ? `前五售出占比 ${formatPercent(topShare)}，其余 ${formatPercent(1 - topShare)}` : "暂无有效售出份额"}>
      <svg viewBox="0 0 100 100" className="size-full -rotate-90" aria-hidden="true">
        <circle cx="50" cy="50" r="40" fill="none" stroke="var(--muted)" strokeWidth="18" />
        {segments.map(({ item, share, offset: start, color }) => <circle key={item.key} cx="50" cy="50" r="40" pathLength="100" fill="none" stroke={color} strokeWidth="18" strokeDasharray={`${share * 100} ${100 - share * 100}`} strokeDashoffset={-start * 100}><title>{item.name}：{formatCurrency(item.value)}，{formatPercent(share)}</title></circle>)}
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-0.5">
        <span className="text-[16px] font-semibold tabular-nums sm:text-[18px]">{valid ? formatPercent(topShare) : "—"}</span>
        <span className="text-[10px] text-muted-foreground">前5占比</span>
      </div>
    </div>
  )
}

function RankingCard({ title, badge, items, formatValue = formatCurrency, summary, footer, empty = "暂无数据", error, loading, onSelect, signed = false, revenueRing = false, rate = false }: {
  title: string
  badge?: string
  items: RankingItem[]
  formatValue?: (value: number) => string
  summary?: string
  footer?: string
  empty?: string
  error?: string | null
  loading?: boolean
  onSelect?: () => void
  signed?: boolean
  revenueRing?: boolean
  rate?: boolean
}) {
  const ranked = [...items].sort((a, b) => b.value - a.value).slice(0, 5)
  const max = Math.max(...ranked.map((item) => Math.abs(item.value)), 0)
  return (
    <Card className="min-h-[196px] min-w-0 gap-1.5 p-3 shadow-xs">
      <CardHeader className="flex shrink-0 flex-row items-center justify-between gap-2 p-0">
        <div className="flex items-center gap-2">
          <CardTitle className="text-[15px] font-medium">{title}</CardTitle>
          {badge && <Badge variant="outline" className="text-[11px] text-muted-foreground">{badge}</Badge>}
        </div>
        {summary && <span className="truncate text-[11px] tabular-nums text-muted-foreground" title={summary}>{summary}</span>}
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col p-0">
        {loading ? <div className="m-auto text-[13px] text-muted-foreground">加载中…</div> : error ? (
          <div role="alert" className="m-auto flex max-w-full items-start gap-2 text-[12px] text-destructive"><AlertCircle className="size-4 shrink-0" /><span className="break-words">{error}</span></div>
        ) : ranked.length === 0 ? (
          <div className="m-auto flex items-center gap-2 text-[13px] text-muted-foreground"><Inbox className="size-4" />{empty}</div>
        ) : <div className="flex min-h-0 flex-1 flex-col gap-3 sm:flex-row">
          {revenueRing && <RevenueRing items={items} />}
          <div className="grid min-h-[120px] min-w-0 flex-1 auto-rows-fr">
          {ranked.map((item, index) => {
          const color = signed ? item.value < 0 ? "var(--chart-5)" : "var(--chart-1)" : rate ? "var(--chart-2)" : `var(--chart-${index + 1})`
          const width = rate ? Math.max(0, Math.min(100, item.value * 100)) : max > 0 ? Math.min(100, Math.abs(item.value) / max * (signed ? 50 : 100)) : 0
          const content = <>
            <span className="w-3 shrink-0 text-left text-[11px] tabular-nums text-muted-foreground">{index + 1}</span>
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="flex min-w-0 items-center gap-1.5">
                {item.logo && <SiteLogo kind={item.logo.kind} id={item.logo.id} label={item.name} size={14} />}
                <span className="truncate text-[12px] leading-4" title={item.name}>{item.name}</span>
              </span>
              <span className="relative h-[3px] w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
                {signed && <span className="absolute inset-y-0 left-1/2 w-px bg-muted-foreground/50" />}
                <span className="absolute inset-y-0 rounded-full" style={{ width: `${width}%`, left: signed ? `${item.value < 0 ? 50 - width : 50}%` : 0, backgroundColor: color }} />
              </span>
            </span>
            <span className={cn("w-[84px] shrink-0 truncate text-right text-[13px] font-semibold tabular-nums", signed && item.value < 0 && "text-rose-600 dark:text-rose-400")} title={`${item.value.toLocaleString("en-US", { maximumSignificantDigits: 15 })}${item.share != null ? ` · ${formatPercent(item.share)}` : ""}`}>{formatValue(item.value)}</span>
            {(item.detail || item.share != null) && <span className={cn("shrink-0 truncate text-right text-[11px] tabular-nums text-muted-foreground", rate ? "w-[68px]" : "w-11")} title={item.detail}>{item.detail ?? formatPercent(item.share)}</span>}
            {onSelect && <ChevronRight className="size-3 shrink-0 text-muted-foreground" />}
          </>
          return onSelect ? <button key={item.key} type="button" onClick={onSelect} className="flex min-h-6 w-full min-w-0 items-center gap-1.5 rounded-md px-0.5 text-left hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring">{content}</button>
            : <div key={item.key} className="flex min-h-6 min-w-0 items-center gap-1.5 px-0.5">{content}</div>
        })}
          </div>
        </div>}
      </CardContent>
      <span className="min-h-4 shrink-0 text-[11px] leading-4 text-muted-foreground">{footer ?? (signed ? "正向盈利 · 负向亏损" : rate ? "观测成功率 · 右侧为样本数" : "")}</span>
    </Card>
  )
}

function withRevenueShares(items: RankingItem[]): RankingItem[] {
  const total = items.reduce((sum, item) => sum + item.value, 0)
  return items.map((item) => ({ ...item, share: item.share ?? (total > 0 ? item.value / total : undefined) }))
}

export function RankView({ channels, groups, users, profitSites, dateRange, refreshKey = 0, onNavigateChannelsDetail, onNavigateGroupsDetail }: RankViewProps) {
  const { server, revision } = useSettings()
  const requestKey = `${dateRange?.from ?? ""}:${dateRange?.to ?? ""}:${refreshKey}:${revision ?? ""}`
  const [modelResult, setModelResult] = React.useState<{ key: string; models: ModelItem[]; error: string | null } | null>(null)
  const [statusResult, setStatusResult] = React.useState<{ key: string; data: (StatusPayload & { health_rules?: { minSamples: number; failErrorRate: number } }) | null; error: string | null } | null>(null)
  const from = dateRange?.from
  const to = dateRange?.to

  React.useEffect(() => {
    if (from == null || to == null) return
    let cancelled = false
    void fetchModels({ from, to }).then((data) => {
      if (!cancelled) setModelResult({ key: requestKey, models: data.models, error: null })
    }).catch((error) => {
      if (!cancelled) setModelResult({ key: requestKey, models: [], error: error instanceof Error ? error.message : String(error) })
    })
    void fetchStatus({ from, to }, "channel", to - from > 36 * 3600000 ? "1h" : "15m").then((data) => {
      if (!cancelled) setStatusResult({ key: requestKey, data, error: null })
    }).catch((error) => {
      if (!cancelled) setStatusResult({ key: requestKey, data: null, error: error instanceof Error ? error.message : String(error) })
    })
    return () => { cancelled = true }
  }, [from, to, requestKey])

  const channelItems = withRevenueShares(channels.filter((item) => item.revenue != null && Number.isFinite(item.revenue)).map((item) => ({ key: String(item.channel_id), name: item.channel_name || `渠道 #${item.channel_id}`, value: item.revenue!, logo: { kind: "channel" as const, id: item.channel_id } })))
  const groupItems = withRevenueShares(groups.filter((item) => item.revenue != null && Number.isFinite(item.revenue)).map((item) => ({ key: item.group_name || "未分组", name: item.group_name || "未分组", value: item.revenue! })))
  const userItems = withRevenueShares(users.filter((item) => Number.isFinite(item.revenue)).map((item) => ({ key: item.user_name, name: item.user_name || "匿名用户", value: item.revenue, share: item.share })))
  const models = modelResult?.key === requestKey ? modelResult.models : []
  const modelItems = models.filter((item) => Number.isFinite(item.revenue)).map((item) => ({ key: item.model, name: item.model, value: item.revenue, share: item.share }))
  const profitItems = (profitSites ?? []).filter((item) => item.kind !== "external" && item.profit != null && Number.isFinite(item.profit)).map((item) => ({ key: item.account_id, name: item.name || item.account_id, value: item.profit!, logo: { kind: "account" as const, id: item.account_id } }))
  const pendingProfit = (profitSites ?? []).filter((item) => item.kind !== "external" && (item.profit == null || !Number.isFinite(item.profit))).length

  const statusData = statusResult?.key === requestKey ? statusResult.data : null
  const fresh = statusData?.coverage.errors_available === true
  const healthRules = statusData?.health_rules ?? server.health
  const stableChannels = fresh && statusData ? statusData.components.filter((item) => item.requests + item.errors >= healthRules.minSamples && item.uptime != null && Number.isFinite(item.uptime)).sort((a, b) => b.uptime! - a.uptime! || (b.requests + b.errors) - (a.requests + a.errors)) : []
  const stabilityItems = stableChannels.map((item) => ({ key: item.key, name: item.name || `渠道 #${item.key}`, value: item.uptime!, detail: `${item.requests + item.errors} 次`, logo: { kind: "channel" as const, id: item.key } }))
  const excluded = (statusData?.components.length ?? 0) - stabilityItems.length
  const revenueSummary = (items: RankingItem[], unit: string) => `${formatCurrency(items.reduce((sum, item) => sum + item.value, 0))} · ${items.length} ${unit}`
  const remaining = (count: number) => count > 5 ? `另有 ${count - 5} 项` : undefined

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto pr-1">
      <div className="grid shrink-0 grid-cols-1 gap-3 lg:min-h-[612px] lg:flex-1 lg:shrink lg:grid-cols-2 lg:grid-rows-[repeat(3,minmax(196px,1fr))]">
        <RankingCard title="渠道售出" items={channelItems} revenueRing summary={revenueSummary(channelItems, "个渠道")} footer={remaining(channelItems.length)} onSelect={onNavigateChannelsDetail} />
        <RankingCard title="分组售出" items={groupItems} revenueRing summary={revenueSummary(groupItems, "个分组")} footer={remaining(groupItems.length)} onSelect={onNavigateGroupsDetail} />
        <RankingCard title="用户售出" items={userItems} revenueRing summary={revenueSummary(userItems, "个用户")} footer={remaining(userItems.length)} />
        <RankingCard title="模型售出" items={modelItems} revenueRing summary={modelResult?.key === requestKey ? revenueSummary(modelItems, "个模型") : undefined} footer={remaining(modelItems.length)} loading={Boolean(dateRange) && modelResult?.key !== requestKey} error={modelResult?.key === requestKey ? modelResult.error : null} />
        <RankingCard title="上游利润" items={profitItems} signed summary={`${profitItems.length} 个账户`} footer={[remaining(profitItems.length), pendingProfit > 0 ? `${pendingProfit} 项待核算` : null].filter(Boolean).join(" · ") || undefined} />
        <RankingCard title="渠道稳定" items={stabilityItems} rate formatValue={(value) => `${(value * 100).toFixed(2)}%`} summary={fresh ? `${stabilityItems.length} 个有效渠道` : undefined} loading={Boolean(dateRange) && statusResult?.key !== requestKey} error={statusResult?.key === requestKey ? statusResult.error : null} empty={!fresh ? "错误采集未就绪" : "样本不足"} footer={fresh ? [remaining(stabilityItems.length), excluded > 0 ? `${excluded} 个渠道样本不足` : null].filter(Boolean).join(" · ") || undefined : undefined} />
      </div>
    </div>
  )
}
