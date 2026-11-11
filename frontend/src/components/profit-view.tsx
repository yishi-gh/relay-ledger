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
  timeRange: "24h" | "7d"
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
      {/* 图表与表：内容密度比例 1 : 1.15，自然适应高度，<1280 上下堆叠 */}
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_1.15fr] gap-4 items-stretch min-h-[300px] xl:flex-1 xl:min-h-0">
        {/* 左卡：账户盈利 (1fr, p-4) */}
        <Card className="col-span-1 h-full max-xl:h-auto shadow-xs overflow-hidden flex flex-col justify-between min-w-0 p-4">
          <CardHeader className="p-0 pb-2.5 shrink-0">
            <CardTitle className="text-[16px] leading-[24px] font-medium text-foreground">
              账户盈利
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
                    tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
                    tickFormatter={(val) => (val < 0 ? `-$${Math.abs(val)}` : `$${val}`)}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    tickLine={false}
                    axisLine={false}
                    width={38}
                    tickCount={6}
                    tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
                    tickFormatter={(val) => `${(val * 100).toFixed(0)}%`}
                  />
                  <RechartsTooltip
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

        {/* 右卡：账户汇总 (1.15fr, px-4 py-3, 等高内滚) */}
        <Card className="col-span-1 h-full max-xl:h-auto shadow-xs overflow-hidden flex flex-col min-w-0 p-4">
          <CardHeader className="p-0 pb-2.5 flex flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-[16px] leading-[24px] font-medium text-foreground">
                账户汇总
              </CardTitle>
            </div>
            <Badge variant="secondary" className="text-[12px] leading-[16px] h-5 px-1.5 font-medium tabular-nums">
              {tableData.length} 个账户
            </Badge>
          </CardHeader>

          <CardContent className="p-0 flex-1 flex flex-col min-h-0">
            <div className="flex-1 min-h-[280px] xl:min-h-0 overflow-auto rounded-lg border border-border">
              <Table data-slot="profit-table" className="w-full min-w-[500px] xl:min-w-full">
                <TableHeader className="bg-muted/40">
                  <TableRow>
                    {[
                      { key: "name", label: "账户", align: "left", className: "sticky left-0 bg-muted/95 backdrop-blur-xs z-10 w-[110px] min-w-[95px] max-w-[120px] border-r border-border/60" },
                      { key: "revenue", label: "售出", align: "right" },
                      { key: "credits", label: "充值", align: "right", className: "hidden 2xl:table-cell" },
                      { key: "cost", label: "成本", align: "right" },
                      { key: "profit", label: "利润", align: "right" },
                      { key: "margin", label: "毛利率", align: "right" },
                      { key: "status", label: "状态", align: "center", className: "w-[68px] min-w-[64px]" },
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
                              "inline-flex items-center gap-1",
                              isNum ? "flex-row-reverse" : "flex-row"
                            )}
                          >
                            <span>{col.label}</span>
                            <span
                              className={cn(
                                "font-mono text-[12px] leading-[16px] tabular-nums transition-opacity",
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
                        className="sticky left-0 bg-card z-10 border-r border-border/50 py-[9px] px-2.5 w-[110px] min-w-[95px] max-w-[120px]"
                        title={`${site.name} (${site.account_id})`}
                      >
                        <span className="font-normal text-foreground text-[14px] leading-[20px] line-clamp-2 block" title={site.name}>
                          {site.name}
                        </span>
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums text-[14px] leading-[20px] font-semibold text-foreground py-[9px] px-2">
                        {formatCurrency(site.revenue)}
                      </TableCell>
                      <TableCell className="hidden 2xl:table-cell text-right font-mono tabular-nums text-muted-foreground text-[14px] leading-[20px] py-[9px] px-2">
                        {formatCurrency(site.credits)}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums text-[14px] leading-[20px] font-semibold text-foreground py-[9px] px-2">
                        {formatCurrency(site.cost)}
                      </TableCell>
                      <TableCell
                        className={`text-right font-mono tabular-nums text-[14px] leading-[20px] font-semibold py-[9px] px-2 ${
                          site.profit != null && site.profit < 0
                            ? "text-destructive"
                            : "text-foreground"
                        }`}
                      >
                        {formatCurrency(site.profit)}
                      </TableCell>
                      <TableCell
                        className={`text-right font-mono tabular-nums text-[14px] leading-[20px] font-semibold py-[9px] px-2 ${
                          site.margin != null && site.margin < 0
                            ? "text-destructive"
                            : "text-foreground"
                        }`}
                      >
                        {formatPercent(site.margin)}
                      </TableCell>
                      <TableCell className="text-center py-[9px] px-2">
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
              快照数据质量说明
            </AlertTitle>
            <AlertDescription className="text-[12px] leading-[16px] text-muted-foreground mt-0.5 leading-relaxed">
              {timeRange === "24h" ? (
                <>
                  有 {missingAccounts.length} 个账户缺快照
                  {missingNames ? `（${missingNames}）` : ""}
                  ，成本核算已跳过缺失时段；另有 {completeCount} 个账户完整覆盖。
                </>
              ) : (
                <>
                  近 7 天窗口起点早于首条快照记录，
                  <span className="font-medium text-foreground">
                    {missingAccounts.length} 个账户
                  </span>
                  快照不完整（状态为缺快照）；成本与毛利率仅在具备快照的有效桶内计算呈现。
                </>
              )}
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
