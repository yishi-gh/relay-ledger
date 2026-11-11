import { FundingStrip } from "@/components/funding-strip"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
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

interface OverviewViewProps {
  timeRange: "24h" | "7d"
  kpiData: KpiData
  activeSites: ActiveSite[]
  trendChartData: TrendChartItem[]
  trafficChartData: TrafficChartPoint[]
  getSiteColor: (accountId: string) => string
  capital?: import("@/lib/api").CapitalPayload | null
  accounts?: { name?: string; last_sync?: number | null }[]
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
}: OverviewViewProps) {
  // 判断是否需要显示可核算售出差异说明
  const showRevenueClarification =
    kpiData.accountableRevenue != null &&
    kpiData.revenue != null &&
    kpiData.accountableRevenue < kpiData.revenue

  const isRawUnit = getPreferences().display.unitSystem === "raw"
  // raw 模式大数（如 1,400,000,000）留足 >=104px 宽度，避免左侧截断；非 raw 保持 54px
  const tokenAxisWidth = isRawUnit ? 108 : 54

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-4 overflow-y-auto pr-1">
      {/* 1. KPI 分层：主卡 + 3 张辅卡 (紧凑行, shrink-0) */}
      <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4 items-stretch shrink-0">
        {/* 主卡：本站售出 */}
        <Card className="col-span-1 sm:col-span-2 xl:col-span-2 h-auto xl:h-full shadow-xs flex flex-col justify-between">
          <CardHeader className="p-4 pb-1 flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-[14px] leading-[20px] font-normal text-muted-foreground">
              本站售出
            </CardTitle>
            <DollarSign className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="px-4 pb-4 pt-0 flex-1 flex flex-col justify-between">
            <div>
              <div className="text-[28px] leading-[36px] font-semibold font-mono tracking-tight text-foreground tabular-nums whitespace-nowrap">
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
        <Card data-slot="kpi-aux-card" className="col-span-1 sm:col-span-1 xl:col-span-1 h-auto xl:h-full shadow-xs flex flex-col justify-between">
          <CardHeader className="p-4 pb-1 flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-[14px] leading-[20px] font-normal text-muted-foreground">
              请求数
            </CardTitle>
            <Activity className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="px-4 pb-4 pt-0 flex-1 flex flex-col justify-between">
            <div className="pt-1">
              <div className="text-[24px] leading-[28px] font-semibold font-mono tracking-tight text-foreground tabular-nums whitespace-nowrap">
                {formatNumber(kpiData.requests)}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* 辅卡 2: Token */}
        <Card data-slot="kpi-aux-card" className="col-span-1 sm:col-span-1 xl:col-span-1 h-auto xl:h-full shadow-xs flex flex-col justify-between">
          <CardHeader className="p-4 pb-1 flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-[14px] leading-[20px] font-normal text-muted-foreground">
              Token 消耗
            </CardTitle>
            <Cpu className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="px-4 pb-4 pt-0 flex-1 flex flex-col justify-between">
            <div className="pt-1">
              <div className="text-[24px] leading-[28px] font-semibold font-mono tracking-tight text-foreground tabular-nums whitespace-nowrap">
                {formatTokens(kpiData.tokens)}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* 辅卡 3: 缓存率 */}
        <Card data-slot="kpi-aux-card" className="col-span-1 sm:col-span-2 xl:col-span-1 h-auto xl:h-full shadow-xs flex flex-col justify-between">
          <CardHeader className="p-4 pb-1 flex flex-row items-center justify-between space-y-0">
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
          <CardContent className="px-4 pb-4 pt-0 flex-1 flex flex-col justify-between">
            <div className="pt-1">
              <div className="text-[24px] leading-[28px] font-semibold font-mono tracking-tight text-foreground tabular-nums whitespace-nowrap">
                {formatPercent(kpiData.cacheRate)}
              </div>
            </div>
            <p className="text-[12px] leading-[16px] text-muted-foreground mt-1.5">
              {kpiData.isCache7d ? "近 7 天窗口" : "当前窗口"}
            </p>
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
            <CardDescription className="text-[12px] leading-[16px] text-muted-foreground mt-0.5">
              按上游账户
            </CardDescription>
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
                        stroke="var(--card)"
                        strokeWidth={1}
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
            <CardDescription className="text-[12px] leading-[16px] text-muted-foreground mt-0.5">
              Token 消耗 (左轴) · 缓存命中率 (右轴)
            </CardDescription>
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
    </div>
  )
}
