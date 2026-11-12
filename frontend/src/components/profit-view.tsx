import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
import { AlertCircle } from "lucide-react"
import {
  formatCurrency,
  formatPercent,
} from "@/lib/formatters"
import {
  type SortState,
  type AccessorMap,
  nextSort,
  sortRows,
  getSortHeaderAttrs,
} from "@/lib/table-sort"
import { cn } from "@/lib/utils"
import * as React from "react"
import type { RangeType } from "@/lib/api"

export interface ProfitBucketRow {
  label: string
  fullLabel: string
  revenue: number | null
  cost: number | null
  profit: number | null
  margin: number | null
  sites: number
}

export interface SiteProfitItem {
  account_id: string
  name: string
  revenue?: number | null
  credits?: number | null
  cost?: number | null
  profit?: number | null
  margin?: number | null
  status: string
  covered_buckets: number
  bucket_count: number
}

export interface ProfitQuality {
  accounts_missing_balance?: string[]
  [key: string]: unknown
}

export interface ProfitAxisExtent {
  min: number
  max: number
}

export interface ProfitAxisDomains {
  leftDomain: [number, number]
  rightDomain: [number, number]
  leftTicks: number[]
  rightTicks: number[]
}

interface ProfitAxisScale {
  domain: [number, number]
  ticks: number[]
}

/** 向上取到 1 / 2 / 2.5 / 5 / 10 × 10^k 的 nice 步长。 */
function niceStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1
  const exponent = Math.floor(Math.log10(raw))
  const base = 10 ** exponent
  const fraction = raw / base
  const mantissa =
    fraction <= 1 + 1e-9 ? 1
    : fraction <= 2 + 1e-9 ? 2
    : fraction <= 2.5 + 1e-9 ? 2.5
    : fraction <= 5 + 1e-9 ? 5
    : 10
  return mantissa * base
}

/** 刻度不足时逐级缩小步长。 */
function previousNiceStep(step: number): number {
  const exponent = Math.floor(Math.log10(step))
  const base = 10 ** exponent
  const ratio = step / base
  if (ratio >= 10 - 1e-9) return 5 * base
  if (ratio >= 5 - 1e-9) return 2.5 * base
  if (ratio >= 2.5 - 1e-9) return 2 * base
  if (ratio >= 2 - 1e-9) return 1 * base
  return 0.5 * base
}

/** 生成 [bottom, top] 内所有 step 整数倍，0 必在其中。 */
function buildTicks(bottom: number, top: number, step: number): number[] {
  const first = Math.ceil(bottom / step - 1e-9)
  const last = Math.floor(top / step + 1e-9)
  const ticks: number[] = []
  for (let index = first; index <= last; index += 1) {
    const value = Number((index * step).toPrecision(12))
    if (value >= bottom - 1e-9 && value <= top + 1e-9) {
      ticks.push(Object.is(value, -0) ? 0 : value)
    }
  }
  if (!ticks.includes(0)) ticks.push(0)
  return ticks.sort((a, b) => a - b)
}

function buildAxisScale(pos: number, neg: number, f: number): ProfitAxisScale {
  const fallback: ProfitAxisScale = { domain: [0, 1], ticks: [0, 0.5, 1] }
  if (pos <= 0 && neg <= 0) return fallback

  const topNeeded = pos * 1.06
  const bottomNeeded = neg * 1.06
  // 先由共享零点比例确定未取整的顶端，再向上取整到 step 的整数倍。
  const provisionalTop = f > 0
    ? Math.max(topNeeded, (bottomNeeded * (1 - f)) / f)
    : topNeeded
  const topBase = provisionalTop > 0 && Number.isFinite(provisionalTop) ? provisionalTop : 1
  const provisionalBottom = f > 0 ? -(topBase * f) / (1 - f) : 0

  let step = niceStep((topBase - provisionalBottom) / 5)
  let top = Math.ceil(topBase / step - 1e-9) * step
  let bottom = f > 0 ? -(top * f) / (1 - f) : 0
  let ticks = buildTicks(bottom, top, step)

  for (let guard = 0; ticks.length < 3 && guard < 20; guard += 1) {
    step = previousNiceStep(step)
    top = Math.ceil(topBase / step - 1e-9) * step
    bottom = f > 0 ? -(top * f) / (1 - f) : 0
    ticks = buildTicks(bottom, top, step)
  }

  return { domain: [bottom, top], ticks }
}

/**
 * 让左右轴的 0 落在绘图区同一相对高度，并返回显式刻度。
 * 两轴共用最大的负值占比 f；底端由取整后的顶端反推，
 * 因此 zeroFraction 严格相等，且 0 一定是刻度的整数倍。
 */
export function computeSharedZeroDomains(
  left: ProfitAxisExtent,
  right: ProfitAxisExtent
): ProfitAxisDomains {
  const negL = Math.max(0, -left.min)
  const posL = Math.max(0, left.max)
  const negR = Math.max(0, -right.min)
  const posR = Math.max(0, right.max)
  const spanL = negL + posL
  const spanR = negR + posR

  if (spanL === 0 && spanR === 0) {
    return {
      leftDomain: [0, 1],
      rightDomain: [0, 1],
      leftTicks: [0, 0.5, 1],
      rightTicks: [0, 0.5, 1],
    }
  }

  const ratioL = spanL > 0 ? negL / spanL : 0
  const ratioR = spanR > 0 ? negR / spanR : 0
  // 单侧没有正向数据时把零点略向下收，避免顶端取整后底端被成倍放大。
  const cap = posL <= 0 || posR <= 0 ? 0.9 : 0.999
  const f = Math.min(cap, Math.max(ratioL, ratioR))

  const leftScale = buildAxisScale(posL, negL, f)
  const rightScale = buildAxisScale(posR, negR, f)

  return {
    leftDomain: leftScale.domain,
    rightDomain: rightScale.domain,
    leftTicks: leftScale.ticks,
    rightTicks: rightScale.ticks,
  }
}

function seriesExtent(values: Array<number | null | undefined>): ProfitAxisExtent {
  let min = Infinity
  let max = -Infinity
  for (const value of values) {
    if (value == null || !Number.isFinite(value)) continue
    if (value < min) min = value
    if (value > max) max = value
  }
  return min === Infinity ? { min: 0, max: 0 } : { min, max }
}

/** 金额轴标签：按量级缩写，避免固定小数位在窄轴内被截断。 */
function formatAxisMoney(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) < 0.005) return "$0"
  const sign = value < 0 ? "-" : ""
  const abs = Math.abs(value)
  const trim = (text: string) => text.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1")
  if (abs >= 999_500) return `${sign}$${trim((abs / 1e6).toFixed(1))}M`
  if (abs >= 1e4) return `${sign}$${Math.round(abs / 1e3)}k`
  if (abs >= 1e3) return `${sign}$${trim((abs / 1e3).toFixed(1))}k`
  if (abs >= 100) return `${sign}$${Math.round(abs)}`
  if (abs >= 1) return `${sign}$${trim(abs.toFixed(1))}`
  return `${sign}$${trim(abs.toFixed(2))}`
}

/** 百分比轴标签固定 0 位小数，接近 0 时不显示负零。 */
function formatAxisPercent(value: number): string {
  if (!Number.isFinite(value)) return "0%"
  const percent = value * 100
  if (Math.abs(percent) < 0.5) return "0%"
  return `${percent.toFixed(0)}%`
}

const PROFIT_TABLE_ACCESSORS: AccessorMap<SiteProfitItem> = {
  name: (s) => s.name || s.account_id,
  revenue: (s) => s.revenue ?? null,
  credits: (s) => s.credits ?? null,
  cost: (s) => s.cost ?? null,
  profit: (s) => s.profit ?? null,
  margin: (s) => s.margin ?? null,
  status: (s) => s.status || "",
}

interface ProfitViewProps {
  timeRange: RangeType
  profitChartData: ProfitBucketRow[]
  tableData: SiteProfitItem[]
  quality?: ProfitQuality
  unmappedRevenue?: number
}

export function ProfitView({
  timeRange,
  profitChartData,
  tableData,
  quality,
  unmappedRevenue = 0,
}: ProfitViewProps) {
  const [sortState, setSortState] = React.useState<SortState | null>(null)

  // 切换时间范围回到默认口径顺序
  const [prevTimeRange, setPrevTimeRange] = React.useState(timeRange)
  if (prevTimeRange !== timeRange) {
    setPrevTimeRange(timeRange)
    setSortState(null)
  }

  const handleSort = React.useCallback((key: string) => {
    setSortState((prev) => nextSort(prev, key))
  }, [])

  const sortedTableData = React.useMemo(() => {
    return sortRows(tableData, sortState, PROFIT_TABLE_ACCESSORS)
  }, [tableData, sortState])

  const { leftDomain, rightDomain, leftTicks, rightTicks } = React.useMemo(
    () =>
      computeSharedZeroDomains(
        seriesExtent(profitChartData.flatMap((row) => [row.cost, row.profit])),
        seriesExtent(profitChartData.map((row) => row.margin))
      ),
    [profitChartData]
  )

  const missingAccounts = quality?.accounts_missing_balance ?? []
  const missingNames = tableData
    .filter((s) => missingAccounts.includes(s.account_id))
    .map((s) => s.name || s.account_id)
    .join("、")
  const completeCount = tableData.filter((s) => s.status === "complete").length
  const showAlert = unmappedRevenue > 0 || missingAccounts.length > 0

  const renderStatusBadge = (status: string, covered: number, count: number) => {
    switch (status) {
      case "complete":
        return (
          <Badge
            variant="default"
            className="text-[12px] leading-[16px] h-5 px-1.5 whitespace-nowrap inline-flex items-center justify-center font-medium"
            title="已完整核算（快照覆盖齐全）"
          >
            已核算
          </Badge>
        )
      case "partial":
        return (
          <Badge
            variant="secondary"
            className="text-[12px] leading-[16px] h-5 px-1.5 whitespace-nowrap inline-flex items-center justify-center font-medium"
            title="部分时段有效核算"
          >
            部分
          </Badge>
        )
      case "missing_balance":
        return (
          <Badge
            variant="outline"
            title={`缺失快照 ${covered}/${count} 桶`}
            className="tabular-nums text-[12px] leading-[16px] h-5 px-1.5 whitespace-nowrap inline-flex items-center justify-center font-medium"
          >
            缺 {covered}/{count}
          </Badge>
        )
      case "no_cost":
        return (
          <Badge
            variant="outline"
            className="opacity-75 text-[12px] leading-[16px] h-5 px-1.5 whitespace-nowrap inline-flex items-center justify-center font-medium"
            title="外部账户无成本来源"
          >
            无成本源
          </Badge>
        )
      case "no_revenue":
        return (
          <Badge
            variant="ghost"
            className="text-muted-foreground text-[12px] leading-[16px] h-5 px-1.5 whitespace-nowrap inline-flex items-center justify-center font-medium"
            title="该窗口暂无售出记录"
          >
            无售出
          </Badge>
        )
      default:
        return (
          <Badge
            variant="outline"
            className="text-[12px] leading-[16px] h-5 px-1.5 whitespace-nowrap inline-flex items-center justify-center font-medium"
            title={status}
          >
            {status}
          </Badge>
        )
    }
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-4 overflow-y-auto pr-1">
      {/* 趋势与账户核算上下排列，桌面表内滚动。 */}
      <div className="grid grid-cols-1 gap-4 items-stretch xl:grid-rows-[minmax(360px,2fr)_minmax(260px,3fr)] xl:flex-1 xl:min-h-[640px]">
        {/* 上方：盈利趋势 */}
        <Card className="col-span-1 h-full max-xl:h-auto shadow-xs overflow-hidden flex flex-col justify-between min-w-0 p-4">
          <CardHeader className="p-0 pb-2.5 shrink-0">
            <CardTitle className="text-[16px] leading-[24px] font-medium text-foreground">
              盈利趋势
            </CardTitle>
          </CardHeader>

          <CardContent className="p-0 flex-1 flex flex-col min-h-0 w-full py-1.5">
            <div className="h-[220px] xl:h-auto xl:flex-1 xl:min-h-[250px] w-full min-w-0">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                  data={profitChartData}
                  margin={{ top: 10, right: 8, left: 4, bottom: 0 }}
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
                    tickCount={6}
                    domain={leftDomain}
                    ticks={leftTicks}
                    tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
                    tickFormatter={formatAxisMoney}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    tickLine={false}
                    axisLine={false}
                    width={38}
                    tickCount={6}
                    domain={rightDomain}
                    ticks={rightTicks}
                    tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
                    tickFormatter={formatAxisPercent}
                  />
                  <RechartsTooltip cursor={{ fill: "var(--muted)", fillOpacity: 0.35, stroke: "none" }}
                    content={({ active, payload }) => {
                      if (!active || !payload || !payload.length) return null
                      const point = payload[0].payload
                      return (
                        <div className="rounded-lg border border-border bg-card p-2.5 text-[12px] leading-[16px] shadow-md space-y-1.5 min-w-[180px]">
                          <div className="font-medium text-foreground border-b border-border pb-1">
                            {point.fullLabel}
                          </div>
                          <div className="flex justify-between text-muted-foreground">
                            <span>售出:</span>
                            <span className="font-mono tabular-nums text-foreground font-semibold text-[14px]">
                              {formatCurrency(point.revenue)}
                            </span>
                          </div>
                          <div className="flex justify-between text-muted-foreground">
                            <span>成本:</span>
                            <span className="font-mono tabular-nums text-foreground font-semibold text-[14px]">
                              {formatCurrency(point.cost)}
                            </span>
                          </div>
                          <div className="flex justify-between text-muted-foreground">
                            <span>利润:</span>
                            <span
                              className={`font-mono tabular-nums font-semibold text-[14px] ${
                                point.profit != null && point.profit < 0
                                  ? "text-destructive"
                                  : "text-foreground"
                              }`}
                            >
                              {formatCurrency(point.profit)}
                            </span>
                          </div>
                          <div className="flex justify-between text-muted-foreground">
                            <span>毛利率:</span>
                            <span className="font-mono tabular-nums text-foreground font-semibold text-[14px]">
                              {formatPercent(point.margin)}
                            </span>
                          </div>
                        </div>
                      )
                    }}
                  />
                  <Bar
                    yAxisId="left"
                    dataKey="cost"
                    name="成本"
                    fill="var(--chart-cost)"
                    stroke="none"
                    radius={[2, 2, 0, 0]}
                    maxBarSize={timeRange === "24h" ? 18 : 42}
                    isAnimationActive={false}
                  />
                  <Line
                    yAxisId="left"
                    type="monotone"
                    dataKey="profit"
                    name="利润"
                    stroke="var(--chart-1)"
                    strokeWidth={2}
                    connectNulls={false}
                    dot={{ r: 2.5, fill: "var(--chart-1)" }}
                    isAnimationActive={false}
                  />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="margin"
                    name="毛利率"
                    stroke="var(--chart-2)"
                    strokeWidth={2}
                    strokeDasharray="4 4"
                    connectNulls={false}
                    dot={{ r: 2.5, fill: "var(--chart-2)" }}
                    isAnimationActive={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </CardContent>

          {/* 卡底 3 项图例 */}
          <div className="pt-2.5 border-t border-border/60 shrink-0 mt-auto">
            <div className="flex flex-wrap items-center gap-4 text-[12px] leading-[16px] text-muted-foreground">
              <div className="flex items-center gap-2">
                <span className="size-2.5 rounded-xs bg-[var(--chart-cost)] shrink-0" />
                <span>成本 (中性柱)</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-3.5 h-1 bg-[var(--chart-1)] shrink-0 rounded-full" />
                <span className="font-medium text-foreground">利润 (实线)</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-3.5 h-1 border-t-2 border-dashed border-[var(--chart-2)] shrink-0" />
                <span>毛利率 (虚线右轴)</span>
              </div>
            </div>
          </div>
        </Card>

        {/* 下方：账户核算 */}
        <Card className="col-span-1 h-full max-xl:h-auto shadow-xs overflow-hidden flex flex-col min-w-0 p-4">
          <CardHeader className="p-0 pb-2.5 flex flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-[16px] leading-[24px] font-medium text-foreground">
                账户核算
              </CardTitle>
            </div>
            <Badge variant="secondary" className="text-[12px] leading-[16px] h-5 px-1.5 font-medium tabular-nums">
              {tableData.length} 个账户
            </Badge>
          </CardHeader>

          <CardContent className="p-0 flex-1 flex flex-col min-h-0">
            <div className="flex-1 min-h-[280px] xl:min-h-0 overflow-auto rounded-lg border border-border">
              <Table data-slot="profit-table" className="w-full min-w-[856px] table-fixed sm:min-w-[920px]">
                <colgroup>
                  <col />
                  <col style={{ width: "120px" }} />
                  <col style={{ width: "120px" }} />
                  <col style={{ width: "120px" }} />
                  <col style={{ width: "120px" }} />
                  <col style={{ width: "104px" }} />
                  <col style={{ width: "136px" }} />
                </colgroup>
                <TableHeader className="bg-muted/40">
                  <TableRow>
                    {[
                      { key: "name", label: "账户", align: "left", className: "sticky left-0 bg-muted z-10 border-r border-border/60" },
                      { key: "revenue", label: "售出", align: "right" },
                      { key: "credits", label: "充值", align: "right" },
                      { key: "cost", label: "成本", align: "right" },
                      { key: "profit", label: "利润", align: "right" },
                      { key: "margin", label: "毛利率", align: "right" },
                      { key: "status", label: "状态", align: "left" },
                    ].map((col) => {
                      const sortAttrs = getSortHeaderAttrs(sortState, col.key)
                      const isNum = col.align === "right"

                      return (
                        <TableHead
                          key={col.key}
                          aria-sort={sortAttrs.ariaSort}
                          onClick={() => handleSort(col.key)}
                          className={cn(
                            "text-[12px] leading-[16px] font-medium text-muted-foreground px-2.5 py-2 cursor-pointer select-none transition-colors group/th hover:bg-muted/80 whitespace-nowrap",
                            col.align === "right" ? "text-right" : col.align === "center" ? "text-center" : "text-left",
                            col.className,
                            sortAttrs.isActive && "text-foreground font-semibold"
                          )}
                        >
                          <div
                            className={cn(
                              "relative inline-flex items-center"
                            )}
                          >
                            <span>{col.label}</span>
                            <span
                              className={cn(
                                "absolute text-[12px] leading-[16px] tabular-nums transition-opacity",
                                isNum ? "right-[calc(100%+4px)]" : "left-[calc(100%+4px)]",
                                sortAttrs.isActive
                                  ? "text-primary font-semibold opacity-100"
                                  : "text-muted-foreground/40 opacity-0 group-hover/th:opacity-100"
                              )}
                            >
                              {sortAttrs.symbol}
                            </span>
                          </div>
                        </TableHead>
                      )
                    })}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedTableData.map((site) => (
                    <TableRow key={site.account_id} className="h-[40px]">
                      <TableCell
                        className="sticky left-0 bg-card z-10 border-r border-border/50 py-[9px] px-2.5"
                        title={`${site.name} (${site.account_id})`}
                      >
                        <span className="font-normal text-foreground text-[14px] leading-[20px] truncate block" title={site.name}>
                          {site.name}
                        </span>
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums text-[14px] leading-[20px] font-semibold text-foreground py-[9px] px-2.5">
                        {formatCurrency(site.revenue)}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums text-muted-foreground text-[14px] leading-[20px] py-[9px] px-2.5">
                        {formatCurrency(site.credits)}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums text-[14px] leading-[20px] font-semibold text-foreground py-[9px] px-2.5">
                        {formatCurrency(site.cost)}
                      </TableCell>
                      <TableCell
                        className={`text-right font-mono tabular-nums text-[14px] leading-[20px] font-semibold py-[9px] px-2.5 ${
                          site.profit != null && site.profit < 0
                            ? "text-destructive"
                            : "text-foreground"
                        }`}
                      >
                        {formatCurrency(site.profit)}
                      </TableCell>
                      <TableCell
                        className={`text-right font-mono tabular-nums text-[14px] leading-[20px] font-semibold py-[9px] px-2.5 ${
                          site.margin != null && site.margin < 0
                            ? "text-destructive"
                            : "text-foreground"
                        }`}
                      >
                        {formatPercent(site.margin)}
                      </TableCell>
                      <TableCell className="text-left py-[9px] px-2.5">
                        {renderStatusBadge(
                          site.status,
                          site.covered_buckets,
                          site.bucket_count
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 下方全宽数据质量 Alert */}
      {showAlert && (
        <Alert className="py-2.5 px-3.5 bg-muted/30 border-border shrink-0">
          <AlertCircle className="size-4 text-muted-foreground mt-0.5" />
          <div>
            <AlertTitle className="text-[14px] font-semibold text-foreground">
              核算提示
            </AlertTitle>
            <AlertDescription className="text-[12px] leading-[16px] text-muted-foreground mt-0.5 leading-relaxed">
              <span title={missingNames || undefined}>缺快照 {missingAccounts.length} 个账户</span>；完整覆盖 {completeCount} 个。缺失时段不计入核算。
              {unmappedRevenue > 0 && (
                <span className="ml-2">
                  未映射渠道售出：
                  {formatCurrency(unmappedRevenue)}。
                </span>
              )}
            </AlertDescription>
          </div>
        </Alert>
      )}
    </div>
  )
}
