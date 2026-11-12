import { FundingStrip } from "@/components/funding-strip"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "@/lib/recharts-sized"
import {
  DollarSign,
  Activity,
  Cpu,
  Percent,
  HelpCircle,
} from "lucide-react"
import {
  formatCurrency,
  formatNumber,
  formatPercent,
  formatTokens,
  formatQuantity,
  formatRawNumber,
} from "@/lib/formatters"
import { formatTokenCn } from "@/components/table-utils"
import { getPreferences } from "@/lib/settings"
import type { ProfitData, RangeType } from "@/lib/api"
import type { ChannelRowData } from "@/components/channels-rank-view"
import type { QualityData } from "@/components/quality-view"

export interface KpiData {
  revenue: number | null
  tokens: number | null
  requests: number | null
  cacheRate: number | null
  upstreamCost: number | null
  profit: number | null
  margin: number | null
  coveredBuckets: number
  bucketCount: number
  isCache7d: boolean
  accountableRevenue: number | null
}

export interface ActiveSite {
  account_id: string
  name: string
  revenue?: number | null
}

export type TrendChartItem = Record<string, string | number | null | undefined>

export type TrafficChartPoint = {
  label: string
  fullLabel: string
  requests: number | null
  tokens: number | null
  cacheRate: number | null
}

function MetricTrend({ values, label, color }: { values: (number | null)[]; label: string; color: string }) {
  const valid = values.filter((value): value is number => value != null && Number.isFinite(value))
  if (valid.length < 2) return null
  const min = Math.min(...valid)
  const span = Math.max(...valid) - min
  const path = values.map((value, index) => {
    if (value == null || !Number.isFinite(value)) return ""
    const previous = values[index - 1]
    const connected = previous != null && Number.isFinite(previous)
    return `${connected ? "L" : "M"}${index / Math.max(1, values.length - 1) * 200},${span > 0 ? 30 - (value - min) / span * 26 : 17}`
  }).join(" ")
  return <svg viewBox="0 0 200 34" preserveAspectRatio="none" className="mt-auto h-9 w-full" role="img" aria-label={label}><title>{label}</title><path d={path} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" /></svg>
}

interface OverviewViewProps {
  timeRange: RangeType
  kpiData: KpiData
  activeSites: ActiveSite[]
  trendChartData: TrendChartItem[]
  trafficChartData: TrafficChartPoint[]
  getSiteColor: (accountId: string) => string
  capital?: import("@/lib/api").CapitalPayload | null
  accounts?: { name?: string; last_sync?: number | null }[]
  profitData?: ProfitData | null
  quality?: QualityData | null
  channels?: ChannelRowData[]
}

export function OverviewView({
  timeRange,
  kpiData,
  activeSites,
  trendChartData,
  trafficChartData,
  getSiteColor,
  capital,
  accounts,
  profitData,
  quality,
  channels,
}: OverviewViewProps) {
  // 判断是否需要显示可核算售出差异说明
  const showRevenueClarification =
    kpiData.accountableRevenue != null &&
    kpiData.revenue != null &&
    kpiData.accountableRevenue < kpiData.revenue

  const isRawUnit = getPreferences().display.unitSystem === "raw"
  // 为数字和单位预留完整刻度宽度，避免中文单位折行。
  const tokenAxisWidth = isRawUnit ? 108 : 76
  const ledgerAccounts = profitData?.sites.filter((site) => site.kind !== "external")
  const coveredAccounts = ledgerAccounts?.filter((site) => site.status === "complete").length
  const missingAccounts = profitData ? profitData.quality?.accounts_missing_balance?.length ?? 0 : undefined
  const collectionErrors = quality?.collect_errors?.filter((error) => error.reason !== "not_configured")
  const rankedChannels = channels?.filter((channel) => channel.revenue != null && Number.isFinite(channel.revenue) && channel.revenue > 0).sort((a, b) => b.revenue! - a.revenue!)
  const channelRevenue = rankedChannels?.reduce((sum, channel) => sum + channel.revenue!, 0) ?? 0
  const leadingChannel = rankedChannels?.[0]
  const leadingShare = leadingChannel && channelRevenue > 0 ? leadingChannel.revenue! / channelRevenue : null

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-4 overflow-y-auto pr-1">
      {/* 1. KPI 分层：主卡 + 3 张辅卡 (紧凑行, shrink-0) */}
      <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4 items-stretch shrink-0">
        {/* 主卡：本站售出 */}
        <Card className="col-span-1 sm:col-span-2 xl:col-span-2 h-auto xl:h-full gap-0 py-0 shadow-xs flex flex-col">
          <CardHeader className="px-3.5 pt-3.5 pb-0 flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-[14px] leading-[20px] font-normal text-muted-foreground">
              本站售出
            </CardTitle>
            <DollarSign className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="px-3.5 pb-3.5 pt-2 flex-1 flex flex-col">
            <div>
              <div className="text-[24px] leading-[36px] font-semibold font-mono tracking-tight text-foreground tabular-nums whitespace-nowrap">
                {formatCurrency(kpiData.revenue)}
              </div>
            </div>

            {/* 下方一行 3 个次级指标 */}
            <div className="pt-2 mt-2 border-t border-border/60">
              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-0.5 min-w-0">
                  <div className="text-[12px] leading-[16px] text-muted-foreground truncate">上游成本</div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[16px] leading-[24px] font-semibold font-mono tabular-nums text-foreground whitespace-nowrap">
                      {formatCurrency(kpiData.upstreamCost)}
                    </span>
                    {kpiData.upstreamCost == null && (
                      <Badge
                        variant="outline"
                        className="text-[12px] leading-[16px] h-5 px-1.5 py-0 font-medium text-muted-foreground inline-flex items-center shrink-0"
                      >
                        缺快照
                      </Badge>
                    )}
                  </div>
                </div>

                <div className="space-y-0.5 min-w-0">
                  <div className="text-[12px] leading-[16px] text-muted-foreground truncate">经营利润</div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[16px] leading-[24px] font-semibold font-mono tabular-nums text-foreground whitespace-nowrap">
                      {formatCurrency(kpiData.profit)}
                    </span>
                    {kpiData.profit == null && (
                      <Badge
                        variant="outline"
                        className="text-[12px] leading-[16px] h-5 px-1.5 py-0 font-medium text-muted-foreground inline-flex items-center shrink-0"
                      >
                        缺快照
                      </Badge>
                    )}
                  </div>
                </div>

                <div className="space-y-0.5 min-w-0">
                  <div
                    className="text-[12px] leading-[16px] text-muted-foreground truncate cursor-help"
                    title="按可核算售出计算，不含缺快照或外部账户"
                  >
                    毛利率
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span
                      className="text-[16px] leading-[24px] font-semibold font-mono tabular-nums text-foreground cursor-help whitespace-nowrap"
                      title="按可核算售出计算，不含缺快照或外部账户"
                    >
                      {formatPercent(kpiData.margin)}
                    </span>
                    {kpiData.margin == null && (
                      <Badge
                        variant="outline"
                        className="text-[12px] leading-[16px] h-5 px-1.5 py-0 font-medium text-muted-foreground inline-flex items-center shrink-0"
                      >
                        缺快照
                      </Badge>
                    )}
                  </div>
                </div>
              </div>

              {/* 口径差异说明小字 */}
              {showRevenueClarification && (
                <div className="text-[12px] leading-[16px] text-muted-foreground mt-2 pt-1.5 border-t border-border/50">
                  成本/利润按可核算售出 {formatCurrency(kpiData.accountableRevenue)} 计算，不含外部账户与缺快照时段
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* 辅卡 1: 请求数 */}
        <Card data-slot="kpi-aux-card" className="col-span-1 sm:col-span-1 xl:col-span-1 h-auto xl:h-full gap-0 py-0 shadow-xs flex flex-col">
          <CardHeader className="px-3.5 pt-3.5 pb-0 flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-[14px] leading-[20px] font-normal text-muted-foreground">
              请求数
            </CardTitle>
            <Activity className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="px-3.5 pb-3.5 pt-2 flex-1 flex flex-col gap-2">
            <div>
              <div className="text-[24px] leading-[36px] font-semibold font-mono tracking-tight text-foreground tabular-nums whitespace-nowrap">
                {formatNumber(kpiData.requests)}
              </div>
            </div>
            <MetricTrend values={trafficChartData.map((point) => point.requests)} label="区间请求走势" color="var(--chart-1)" />
          </CardContent>
        </Card>

        {/* 辅卡 2: Token */}
        <Card data-slot="kpi-aux-card" className="col-span-1 sm:col-span-1 xl:col-span-1 h-auto xl:h-full gap-0 py-0 shadow-xs flex flex-col">
          <CardHeader className="px-3.5 pt-3.5 pb-0 flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-[14px] leading-[20px] font-normal text-muted-foreground">
              Token 消耗
            </CardTitle>
            <Cpu className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="px-3.5 pb-3.5 pt-2 flex-1 flex flex-col gap-2">
            <div>
              <div className="text-[24px] leading-[36px] font-semibold font-mono tracking-tight text-foreground tabular-nums whitespace-nowrap">
                {formatTokens(kpiData.tokens)}
              </div>
            </div>
            <MetricTrend values={trafficChartData.map((point) => point.tokens)} label="区间 Token 走势" color="var(--chart-2)" />
          </CardContent>
        </Card>

        {/* 辅卡 3: 缓存率 */}
        <Card data-slot="kpi-aux-card" className="col-span-1 sm:col-span-2 xl:col-span-1 h-auto xl:h-full gap-0 py-0 shadow-xs flex flex-col">
          <CardHeader className="px-3.5 pt-3.5 pb-0 flex flex-row items-center justify-between space-y-0">
            <div className="flex items-center gap-1">
              <CardTitle className="text-[14px] leading-[20px] font-normal text-muted-foreground">
                缓存率
              </CardTitle>
              {kpiData.isCache7d && (
                <Tooltip>
                  <TooltipTrigger render={<HelpCircle className="size-3.5 text-muted-foreground cursor-pointer" />} />
                  <TooltipContent>24 小时窗口暂无独立缓存统计，当前引用近 7 天整体缓存率</TooltipContent>
                </Tooltip>
              )}
            </div>
            <Percent className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="px-3.5 pb-3.5 pt-2 flex-1 flex flex-col gap-2">
            <div>
              <div className="text-[24px] leading-[36px] font-semibold font-mono tracking-tight text-foreground tabular-nums whitespace-nowrap">
                {formatPercent(kpiData.cacheRate)}
              </div>
            </div>
            <MetricTrend values={trafficChartData.map((point) => point.cacheRate)} label="区间缓存率走势" color="var(--chart-3)" />
            {kpiData.isCache7d && <span className="text-[12px] text-muted-foreground">近7天缓存率</span>}
          </CardContent>
        </Card>
      </section>

      {/* 2. 趋势双卡：桌面 xl 并排保留售出图更宽 (1.6 : 1)，小屏与窄视口自适应上下堆叠 */}
      <section className="grid grid-cols-1 xl:grid-cols-[1.6fr_1fr] gap-4 items-stretch flex-1 min-h-max">
        {/* 左卡：售出结构 (1.6fr) */}
        <Card className="col-span-1 shadow-xs overflow-hidden flex flex-col min-w-0 p-4 gap-0 min-h-[350px]">
          <CardHeader className="p-0 pb-2 shrink-0">
            <CardTitle className="text-[16px] leading-[24px] font-medium text-foreground">
              售出结构
            </CardTitle>
          </CardHeader>

          <CardContent className="p-0 pb-2 flex-1 min-h-[220px] flex flex-col w-full">
            <div className="w-full min-w-0 h-[220px] sm:h-[240px] xl:h-[250px] flex-1 min-h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                  data={trendChartData}
                  margin={{ top: 10, right: 10, left: 4, bottom: 0 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    vertical={false}
                    stroke="var(--border)"
                    strokeOpacity={0.6}
                  />
                  <XAxis
                    dataKey="label"
                    tickLine={false}
                    axisLine={{ stroke: "var(--border)" }}
                    tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
                  />
                  <YAxis
                    yAxisId="left"
                    tickLine={false}
                    axisLine={false}
                    width={44}
                    tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
                    tickFormatter={(val) => `$${val}`}
                  />
                  <RechartsTooltip
                    content={({ active, payload }) => {
                      if (!active || !payload || !payload.length) return null
                      const point = payload[0].payload
                      const siteItems = payload
                        .filter((p) => p.dataKey !== "requests" && typeof p.value === "number" && p.value > 0)
                        .sort((a, b) => Number(b.value) - Number(a.value))
                      const totalRev = siteItems.reduce(
                        (sum, item) => sum + (typeof item.value === "number" ? item.value : 0),
                        0
                      )

                      return (
                        <div className="rounded-lg border border-border bg-card p-2.5 text-[12px] leading-[16px] shadow-md space-y-1.5 min-w-[200px]">
                          <div className="font-medium text-foreground border-b border-border pb-1">
                            {point.fullLabel}
                          </div>
                          <div className="space-y-1 max-h-[160px] overflow-y-auto">
                            {siteItems.map((item) => {
                              const siteId = item.dataKey as string
                              return (
                                <div
                                    key={siteId}
                                    className="flex items-center justify-between gap-3 text-muted-foreground text-[12px]"
                                  >
                                    <div className="flex items-center gap-2 truncate max-w-[140px]">
                                      <span
                                        className="size-2 rounded-full shrink-0"
                                        style={{ backgroundColor: getSiteColor(siteId) }}
                                      />
                                      <span className="truncate">{item.name}</span>
                                    </div>
                                    <span className="font-mono text-foreground tabular-nums font-semibold">
                                      {formatCurrency(Number(item.value))}
                                    </span>
                                  </div>
                                )
                              })}
                            </div>
                            <div className="border-t border-border pt-1.5 flex justify-between font-medium text-[12px]">
                              <span className="text-muted-foreground">时段总额:</span>
                              <span className="font-mono tabular-nums text-foreground font-semibold">
                                {formatCurrency(totalRev)}
                              </span>
                            </div>
                          </div>
                        )
                      }}
                    />
                    {activeSites.map((site) => (
                      <Bar
                        key={site.account_id}
                        yAxisId="left"
                        dataKey={site.account_id}
                        name={site.name}
                        stackId="revenue"
                        fill={getSiteColor(site.account_id)}
                        stroke="none"
                        maxBarSize={timeRange === "24h" ? 20 : 42}
                        isAnimationActive={false}
                      />
                    ))}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </CardContent>

          {/* 图例在卡底：形如「● 站名  $12.34」并按金额降序 */}
          <div className="pt-2.5 mt-auto border-t border-border/60 shrink-0">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] leading-[16px] text-muted-foreground">
              {activeSites.map((site) => (
                <div key={site.account_id} className="flex items-center gap-2">
                  <span
                    className="size-2.5 rounded-xs shrink-0"
                    style={{ backgroundColor: getSiteColor(site.account_id) }}
                  />
                  <span className="max-w-[110px] sm:max-w-[130px] line-clamp-2" title={site.name}>
                    {site.name}
                  </span>
                  <span className="font-mono tabular-nums text-foreground/90 font-semibold text-[14px] whitespace-nowrap">
                    {formatCurrency(site.revenue)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </Card>

        {/* 右卡：调用流量 (1fr) */}
        <Card className="col-span-1 shadow-xs overflow-hidden flex flex-col min-w-0 p-4 gap-0 min-h-[350px]">
          <CardHeader className="p-0 pb-2 shrink-0">
            <CardTitle className="text-[16px] leading-[24px] font-medium text-foreground">
              调用流量
            </CardTitle>
          </CardHeader>

          <CardContent className="p-0 pb-2 flex-1 min-h-[220px] flex flex-col w-full">
            <div className="w-full min-w-0 h-[220px] sm:h-[240px] xl:h-[250px] flex-1 min-h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                  data={trafficChartData}
                  margin={{ top: 10, right: 6, left: 0, bottom: 0 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    vertical={false}
                    stroke="var(--border)"
                    strokeOpacity={0.6}
                  />
                  <XAxis
                    dataKey="label"
                    tickLine={false}
                    axisLine={{ stroke: "var(--border)" }}
                    tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
                  />
                  {/* 左轴：Token 消耗量（遵循统一单位，留足宽度与 0 左边距） */}
                  <YAxis
                    yAxisId="tokens"
                    orientation="left"
                    tickLine={false}
                    axisLine={false}
                    width={tokenAxisWidth}
                    tick={{ fill: "var(--chart-2)", fontSize: 12 }}
                    tickFormatter={(val) => formatQuantity(val)}
                  />
                  {/* 右轴：缓存命中率 (0–100%) */}
                  <YAxis
                    yAxisId="cacheRate"
                    orientation="right"
                    domain={[0, 1]}
                    ticks={[0, 0.5, 1]}
                    tickLine={false}
                    axisLine={false}
                    width={34}
                    tick={{ fill: "var(--chart-3)", fontSize: 12 }}
                    tickFormatter={(val) => `${Math.round(val * 100)}%`}
                  />
                  <RechartsTooltip
                    content={({ active, payload }) => {
                      if (!active || !payload || !payload.length) return null
                      const point = payload[0].payload as Record<string, unknown>
                      const tokens = typeof point.tokens === "number" ? point.tokens : null
                      const cache = typeof point.cacheRate === "number" ? point.cacheRate : null

                      return (
                        <div className="rounded-lg border border-border bg-card p-2.5 text-[12px] leading-[16px] shadow-md space-y-1.5 min-w-[190px]">
                          <div className="font-medium text-foreground border-b border-border pb-1">
                            {typeof point.fullLabel === "string" ? point.fullLabel : typeof point.label === "string" ? point.label : ""}
                          </div>
                          <div className="space-y-1">
                            <div className="flex items-center justify-between gap-3 text-muted-foreground">
                              <span className="inline-flex items-center gap-1.5">
                                <span className="size-2 rounded-xs bg-[var(--chart-2)] shrink-0" />
                                <span>Token:</span>
                              </span>
                              <span
                                className="font-mono tabular-nums text-foreground font-semibold"
                                title={tokens != null ? `${formatRawNumber(tokens)} Tokens` : undefined}
                              >
                                {tokens != null ? formatTokenCn(tokens) : "—"}
                              </span>
                            </div>
                            <div className="flex items-center justify-between gap-3 text-muted-foreground">
                              <span className="inline-flex items-center gap-1.5">
                                <span className="w-2 border-t-2 border-dashed border-[var(--chart-3)] shrink-0" />
                                <span>缓存率:</span>
                              </span>
                              <span className="font-mono tabular-nums text-foreground font-semibold">
                                {cache != null ? formatPercent(cache) : "—"}
                              </span>
                            </div>
                          </div>
                        </div>
                      )
                    }}
                  />
                  {/* Token 消耗折线 */}
                  <Line
                    yAxisId="tokens"
                    type="monotone"
                    dataKey="tokens"
                    name="Token 消耗"
                    stroke="var(--chart-2)"
                    strokeWidth={2}
                    dot={{ r: 2, fill: "var(--chart-2)" }}
                    activeDot={{ r: 4 }}
                    isAnimationActive={false}
                    connectNulls={false}
                  />
                  {/* 缓存命中率折线 (虚线区分) */}
                  <Line
                    yAxisId="cacheRate"
                    type="monotone"
                    dataKey="cacheRate"
                    name="缓存命中率"
                    stroke="var(--chart-3)"
                    strokeWidth={2}
                    strokeDasharray="3 3"
                    dot={{ r: 2, fill: "var(--chart-3)" }}
                    activeDot={{ r: 4 }}
                    isAnimationActive={false}
                    connectNulls={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </CardContent>

          {/* 卡底指标说明与窗口汇总：仅保留 Token 消耗与缓存命中率两项 */}
          <div className="pt-2.5 mt-auto border-t border-border/60 shrink-0">
            <div className="flex items-center justify-between text-[12px] leading-[16px] text-muted-foreground flex-wrap gap-x-4 gap-y-1.5">
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-0.5 bg-[var(--chart-2)] rounded-full shrink-0" />
                <span>Token:</span>
                <span
                  className="font-mono tabular-nums font-semibold text-foreground text-[13px]"
                  title={kpiData.tokens != null ? `${formatRawNumber(kpiData.tokens)} Tokens` : undefined}
                >
                  {formatTokens(kpiData.tokens)}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-0.5 border-t-2 border-dashed border-[var(--chart-3)] shrink-0" />
                <span className="inline-flex items-center gap-1">
                  <span>缓存率:</span>
                  {kpiData.isCache7d && (
                    <span className="text-[12px] text-muted-foreground" title="24 小时窗口暂无独立缓存统计，当前引用近 7 天整体缓存率">(7d)</span>
                  )}
                </span>
                <span className="font-mono tabular-nums font-semibold text-foreground text-[13px]">
                  {formatPercent(kpiData.cacheRate)}
                </span>
              </div>
            </div>
          </div>
        </Card>
      </section>

      <FundingStrip capital={capital} accounts={accounts} />
      <section className="grid shrink-0 grid-cols-1 gap-4 md:grid-cols-2">
        <Card className="min-w-0 gap-2 p-4 shadow-xs">
          <CardHeader className="flex flex-row items-center justify-between p-0">
            <CardTitle className="text-[14px] font-medium">核算覆盖</CardTitle>
            <span className="text-[12px] text-muted-foreground">当前区间</span>
          </CardHeader>
          <CardContent className="flex flex-wrap items-baseline gap-x-5 gap-y-1 p-0 text-[12px] text-muted-foreground">
            <span>已核算 <strong className="text-[20px] font-semibold tabular-nums text-foreground">{coveredAccounts ?? "—"}<span className="text-[13px] font-normal text-muted-foreground"> / {ledgerAccounts?.length ?? "—"}</span></strong></span>
            <span>缺快照 <strong className="tabular-nums text-foreground">{missingAccounts ?? "—"}</strong></span>
            <span title={collectionErrors?.map((error) => error.reason).join("；")}>采集异常 <strong className={collectionErrors?.length ? "text-destructive" : "text-foreground"}>{quality ? collectionErrors?.length ?? 0 : "—"}</strong></span>
          </CardContent>
        </Card>
        <Card className="min-w-0 gap-2 p-4 shadow-xs">
          <CardHeader className="flex flex-row items-center justify-between p-0">
            <CardTitle className="text-[14px] font-medium">渠道集中</CardTitle>
            <span className="text-[12px] text-muted-foreground">在售渠道</span>
          </CardHeader>
          <CardContent className="flex min-w-0 items-center gap-3 p-0">
            <span className="min-w-0 flex-1 truncate text-[13px]" title={leadingChannel?.channel_name}>{leadingChannel?.channel_name || (leadingChannel ? `渠道 #${leadingChannel.channel_id}` : "暂无售出")}</span>
            <span className="h-1 w-24 shrink-0 overflow-hidden rounded-full bg-muted" aria-hidden="true"><span className="block h-full rounded-full bg-primary/60" style={{ width: `${(leadingShare ?? 0) * 100}%` }} /></span>
            <span className="text-[20px] font-semibold tabular-nums">{formatPercent(leadingShare)}</span>
          </CardContent>
        </Card>
      </section>
    </div>
  )
}
