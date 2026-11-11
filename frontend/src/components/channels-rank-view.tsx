import * as React from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { DollarSign, Radio, TrendingUp, ChevronRight, Inbox } from "lucide-react"
import { formatCurrency, formatPercent } from "@/lib/formatters"
import { getDeterministicChartColor } from "@/components/table-utils"
import { cn } from "@/lib/utils"
import type { RangeType } from "@/lib/api"

export interface ChannelRowData {
  channel_id: number
  channel_name: string
  revenue: number
  quota?: number
  tokens?: number
  tokens_total?: number
  requests?: number
  cache_rate?: number
  latency_p50?: number
  p50?: number
  latency_p95?: number
  p95?: number
  tps?: number
  last_t?: number | null
  top_model?: {
    model: string
    revenue: number
    tokens: number
    per_1e8: number
  } | null
  upstream_account?: string | null
  margin_status?: string
  archive_only?: boolean
  margin?: number | null
  margin_pct?: number | null
  status?: string
}

interface ChannelsRankViewProps {
  timeRange: RangeType
  rows: ChannelRowData[]
  onNavigateDetail: () => void
}

export function ChannelsRankView({
  timeRange,
  rows,
  onNavigateDetail,
}: ChannelsRankViewProps) {
  // 按售出降序排序
  const sortedRows = React.useMemo(() => {
    return [...rows].sort((a, b) => (b.revenue ?? 0) - (a.revenue ?? 0))
  }, [rows])

  const totalRevenue = React.useMemo(() => {
    return sortedRows.reduce((sum, r) => sum + (r.revenue ?? 0), 0)
  }, [sortedRows])

  const top1 = sortedRows[0] || null
  const top1Revenue = top1?.revenue ?? 0
  const top1Share = totalRevenue > 0 ? top1Revenue / totalRevenue : null

  // 前 10 名单列，其余合并为「其它」
  const displayItems = React.useMemo(() => {
    if (sortedRows.length <= 10) {
      return sortedRows.map((r, index) => ({
        key: `ch-${r.channel_id}`,
        rank: index + 1,
        id: r.channel_id,
        name: r.channel_name || `渠道 #${r.channel_id}`,
        revenue: r.revenue ?? 0,
        isOther: false,
      }))
    }

    const top10 = sortedRows.slice(0, 10).map((r, index) => ({
      key: `ch-${r.channel_id}`,
      rank: index + 1,
      id: r.channel_id,
      name: r.channel_name || `渠道 #${r.channel_id}`,
      revenue: r.revenue ?? 0,
      isOther: false,
    }))

    const otherRows = sortedRows.slice(10)
    const otherRevenue = otherRows.reduce((sum, r) => sum + (r.revenue ?? 0), 0)

    top10.push({
      key: "ch-other",
      rank: 11,
      id: -1,
      name: `其它渠道 (${otherRows.length} 个)`,
      revenue: otherRevenue,
      isOther: true,
    })

    return top10
  }, [sortedRows])

  const maxRevenue = Math.max(...displayItems.map((i) => i.revenue), 0.0001)

  return (
    <div className="flex-1 min-h-0 flex flex-col space-y-4">
      {/* 桌面端一屏双栏布局 */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch flex-1 min-h-0">
        {/* 左栏：横向条形榜 (8 列) */}
        <Card className="col-span-1 lg:col-span-8 h-full shadow-xs overflow-hidden flex flex-col p-4 md:p-5">
          <CardHeader className="p-0 pb-3 flex flex-row items-center justify-between space-y-0 shrink-0">
            <div>
              <div className="flex items-center gap-2">
                <CardTitle className="text-[16px] font-semibold text-foreground">
                  渠道售出排行
                </CardTitle>
                <Badge variant="secondary" className="text-[12px] h-5 px-1.5 font-normal">
                  TOP 10
                </Badge>
              </div>
              <CardDescription className="text-[13px] text-muted-foreground mt-0.5">
                点击渠道查看明细
              </CardDescription>
            </div>
            <Badge variant="outline" className="tabular-nums text-xs text-muted-foreground">
              {timeRange === "today" ? "今日" : timeRange === "24h" ? "近 24 小时" : timeRange === "7d" ? "近 7 天" : "自定义"}
            </Badge>
          </CardHeader>

          <CardContent className="p-0 flex flex-col min-h-0 py-1">
            {displayItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-2">
                <Inbox className="size-8 opacity-40" />
                <span className="text-sm">当前时间窗口暂无渠道数据</span>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5 min-h-0">
                {displayItems.map((item) => {
                  const barColor = item.isOther
                    ? "var(--muted-foreground)"
                    : getDeterministicChartColor(item.id)
                  const pct = Math.max(2, Math.min(100, (item.revenue / maxRevenue) * 100))
                  const sharePct = totalRevenue > 0 ? item.revenue / totalRevenue : 0

                  return (
                    <div
                      key={item.key}
                      onClick={onNavigateDetail}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          onNavigateDetail()
                        }
                      }}
                      className={cn(
                        "group h-11 flex items-center gap-3 px-3 rounded-lg transition-colors cursor-pointer outline-none",
                        "hover:bg-accent/50 focus-visible:ring-1 focus-visible:ring-ring"
                      )}
                    >
                      {/* 统一形态的圆点排名徽标 (同一种形态，只换颜色) */}
                      <span
                        className={cn(
                          "size-5 rounded-full font-mono text-xs font-semibold flex items-center justify-center shrink-0",
                          item.isOther
                            ? "bg-muted/60 text-muted-foreground/60"
                            : item.rank === 1
                            ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                            : item.rank === 2
                            ? "bg-slate-400/20 text-slate-600 dark:text-slate-300"
                            : item.rank === 3
                            ? "bg-orange-500/15 text-orange-600 dark:text-orange-400"
                            : "bg-muted text-muted-foreground"
                        )}
                      >
                        {item.isOther ? "—" : item.rank}
                      </span>

                      {/* 渠道名称与 ID */}
                      <div className="w-40 sm:w-48 shrink-0 truncate flex items-center gap-1.5">
                        {!item.isOther && (
                          <span className="font-mono text-xs text-muted-foreground shrink-0">
                            #{item.id}
                          </span>
                        )}
                        <span
                          className={cn(
                            "text-sm truncate text-foreground",
                            item.isOther ? "text-muted-foreground italic font-normal" : "font-medium"
                          )}
                          title={item.name}
                        >
                          {item.name}
                        </span>
                      </div>

                      {/* 横向条形图 */}
                      <div className="flex-1 min-w-0 flex items-center">
                        <div className="h-2 w-full rounded-full bg-muted/60 overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all duration-300"
                            style={{
                              width: `${pct}%`,
                              backgroundColor: barColor,
                              opacity: item.isOther ? 0.45 : 0.85,
                            }}
                          />
                        </div>
                      </div>

                      {/* 金额与占比 */}
                      <div className="shrink-0 flex items-center gap-2 text-right">
                        <span className="font-mono tabular-nums text-sm font-semibold text-foreground w-20">
                          {formatCurrency(item.revenue)}
                        </span>
                        <span className="font-mono tabular-nums text-xs text-muted-foreground w-12 hidden sm:inline-block">
                          {formatPercent(sharePct)}
                        </span>
                        <ChevronRight className="size-4 text-muted-foreground/40 group-hover:text-foreground group-hover:translate-x-0.5 transition-all" />
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>

          <div className="mt-auto pt-3 border-t border-border/50 flex items-center justify-between text-xs text-muted-foreground shrink-0">
            <span>点击任意行可深入查看该渠道指标明细</span>
            <span className="tabular-nums">共计 {sortedRows.length} 个渠道</span>
          </div>
        </Card>

        {/* 右栏：3 个摘要数字卡片 (4 列，垂直等分，标签→数字→贴底说明) */}
        <div className="col-span-1 lg:col-span-4 h-full grid grid-rows-3 gap-4">
          {/* 指标 1：全站售出 */}
          <Card className="h-full shadow-xs flex flex-col p-5">
            <div className="flex flex-row items-center justify-between space-y-0 shrink-0">
              <span className="text-[14px] font-medium text-muted-foreground">
                全站售出 (Total Revenue)
              </span>
              <div className="size-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
                <DollarSign className="size-4" />
              </div>
            </div>
            <div className="mt-2 text-3xl font-bold font-mono tracking-tight text-foreground tabular-nums leading-tight">
              {formatCurrency(totalRevenue)}
            </div>
            <p className="mt-auto pt-2 text-[13px] text-muted-foreground leading-normal">
              区间渠道售出
            </p>
          </Card>

          {/* 指标 2：在售渠道数 */}
          <Card className="h-full shadow-xs flex flex-col p-5">
            <div className="flex flex-row items-center justify-between space-y-0 shrink-0">
              <span className="text-[14px] font-medium text-muted-foreground">
                在售渠道数 (Active Channels)
              </span>
              <div className="size-8 rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
                <Radio className="size-4" />
              </div>
            </div>
            <div className="mt-2 text-3xl font-bold font-mono tracking-tight text-foreground tabular-nums leading-tight">
              {sortedRows.length} <span className="text-base font-normal font-sans text-muted-foreground">个</span>
            </div>
            <p className="mt-auto pt-2 text-[13px] text-muted-foreground leading-normal">
              产生真实调用与销售计费的渠道实体
            </p>
          </Card>

          {/* 指标 3：Top1 占比 */}
          <Card className="h-full shadow-xs flex flex-col p-5">
            <div className="flex flex-row items-center justify-between space-y-0 shrink-0">
              <span className="text-[14px] font-medium text-muted-foreground">
                Top1 售出占比
              </span>
              <div className="size-8 rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
                <TrendingUp className="size-4" />
              </div>
            </div>
            <div className="mt-2 text-3xl font-bold font-mono tracking-tight text-foreground tabular-nums leading-tight">
              {formatPercent(top1Share)}
            </div>
            <p className="mt-auto pt-2 text-[13px] text-muted-foreground leading-normal truncate" title={top1 ? `${top1.channel_name} (${formatCurrency(top1.revenue)})` : "无数据"}>
              {top1 ? `${top1.channel_name} (${formatCurrency(top1.revenue)})` : "暂无排行数据"}
            </p>
          </Card>
        </div>
      </div>
    </div>
  )
}
