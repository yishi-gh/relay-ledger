import * as React from "react"
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
import { Wallet, DollarSign, Calendar, Hourglass, Inbox, AlertCircle } from "lucide-react"
import {
  formatCurrency,
} from "@/lib/formatters"
import { getServerSettings } from "@/lib/settings"
import { SiteLogo } from "@/components/site-logo"
import {
  type SortState,
  type AccessorMap,
  nextSort,
  sortRows,
  getSortHeaderAttrs,
} from "@/lib/table-sort"
import {
  fetchCapital,
  getMockCapital,
  type CapitalAccount,
  type CapitalPayload,
  type DateRange,
  type RangeType,
} from "@/lib/api"
import { cn } from "@/lib/utils"

const COL_WIDTH_PCT: Record<string, number> = {
  account: 22,
  balance: 13,
  cost_range: 13,
  credits_range: 12,
  daily_avg_7d: 14,
  runway_days: 13,
  status: 13,
}

const CAPITAL_ACCESSORS: AccessorMap<CapitalAccount> = {
  account: (r) => r.name || r.account_id || "",
  balance: (r) => r.balance ?? null,
  cost_range: (r) => r.cost_range ?? null,
  credits_range: (r) => r.credits_range ?? null,
  daily_avg_7d: (r) => r.daily_avg_7d ?? null,
  runway_days: (r) => r.runway_days ?? null,
  status: (r) => r.status || "",
}

interface CapitalViewProps {
  timeRange: RangeType
  dateRange: DateRange | null
  previewMode?: boolean
}

function renderStatusBadge(status: string) {
  switch (status) {
    case "ok":
      return (
        <Badge
          variant="outline"
          className="text-[12px] leading-[16px] h-5 px-1.5 font-medium text-emerald-600 dark:text-emerald-400 border-emerald-500/30 bg-emerald-500/10 whitespace-nowrap"
        >
          正常
        </Badge>
      )
    case "partial":
      return (
        <Badge
          variant="secondary"
          className="text-[12px] leading-[16px] h-5 px-1.5 font-medium whitespace-nowrap"
        >
          部分快照
        </Badge>
      )
    case "missing_balance":
      return (
        <Badge
          variant="outline"
          className="text-[12px] leading-[16px] h-5 px-1.5 font-medium text-amber-600 dark:text-amber-400 border-amber-500/30 whitespace-nowrap"
        >
          缺失余额
        </Badge>
      )
    default:
      return (
        <Badge
          variant="outline"
          className="text-[12px] leading-[16px] h-5 px-1.5 font-medium whitespace-nowrap text-muted-foreground"
        >
          {status || "未知"}
        </Badge>
      )
  }
}

function renderRunway(days: number | null | undefined) {
  if (days == null || isNaN(days)) {
    return <span className="text-muted-foreground">—</span>
  }

  const runwayThresholds = getServerSettings().monitoring.runway
  let colorClass = "text-foreground font-medium"
  if (days < runwayThresholds.dangerDays) {
    colorClass = "text-rose-600 dark:text-rose-400 font-semibold"
  } else if (days < runwayThresholds.warnDays) {
    colorClass = "text-amber-600 dark:text-amber-400 font-semibold"
  }

  return (
    <span className={cn("font-mono tabular-nums text-[14px] leading-[20px]", colorClass)}>
      {days.toFixed(1)} 天
    </span>
  )
}

export function CapitalView({
  timeRange,
  dateRange,
  previewMode = false,
}: CapitalViewProps) {
  const [data, setData] = React.useState<CapitalPayload | null>(null)
  const [notReady, setNotReady] = React.useState(false)
  const [sortState, setSortState] = React.useState<SortState | null>(null)

  // 窗口改变时重置排序口径
  const [prevTimeRange, setPrevTimeRange] = React.useState(timeRange)
  if (prevTimeRange !== timeRange) {
    setPrevTimeRange(timeRange)
    setSortState(null)
  }

  // 数据请求
  React.useEffect(() => {
    let cancelled = false

    if (!dateRange) {
      if (previewMode) {
        Promise.resolve().then(() => {
          if (!cancelled) setData(getMockCapital({ from: 0, to: Date.now() }))
        })
      }
      return
    }

    void fetchCapital(dateRange)
      .then((res) => {
        if (cancelled) return
        setData(res)
        setNotReady(false)
      })
      .catch(() => {
        if (cancelled) return
        if (previewMode) {
          setData(getMockCapital(dateRange))
          setNotReady(false)
        } else {
          setNotReady(true)
          setData(null)
        }
      })

    return () => {
      cancelled = true
    }
  }, [dateRange, previewMode])

  const handleSort = React.useCallback((key: string) => {
    setSortState((prev) => nextSort(prev, key))
  }, [])

  const rows = data?.accounts || []
  const shortest = React.useMemo(() => {
    return rows.reduce<{
      name: string
      days: number
    } | null>((acc, a) => {
      if (a.channels_live === 0) return acc
      if (a.runway_days == null || !Number.isFinite(a.runway_days)) return acc
      if (acc && a.runway_days >= acc.days) return acc
      return { name: a.name || a.account_id, days: a.runway_days }
    }, null)
  }, [rows])

  const sortedRows = React.useMemo(() => {
    return sortRows(rows, sortState, CAPITAL_ACCESSORS)
  }, [rows, sortState])

  const total = data?.total
  const isScrollable = sortedRows.length > 8

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-4 overflow-y-auto pr-1">
      {/* 1. 顶部 4 张 KPI 卡片 */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3.5 shrink-0">
        <Card className="shadow-xs p-3.5 flex flex-col justify-between">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-[14px] leading-[20px] font-normal text-muted-foreground">余额合计</span>
            <Wallet className="size-4 text-emerald-600 dark:text-emerald-400" />
          </div>
          <div className="mt-1.5 text-[24px] leading-[28px] font-semibold font-mono tabular-nums text-foreground">
            {formatCurrency(total?.balance)}
          </div>
          <span className="text-[12px] leading-[16px] text-muted-foreground mt-1">
            有效上游账户最新可用余额汇总
          </span>
        </Card>

        <Card className="shadow-xs p-3.5 flex flex-col justify-between">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-[14px] leading-[20px] font-normal text-muted-foreground">区间成本合计</span>
            <DollarSign className="size-4" />
          </div>
          <div className="mt-1.5 text-[24px] leading-[28px] font-semibold font-mono tabular-nums text-foreground">
            {formatCurrency(total?.cost_range)}
          </div>
          <span className="text-[12px] leading-[16px] text-muted-foreground mt-1">
            {timeRange === "24h" ? "近 24 小时上游总消耗" : "近 7 天上游总消耗"}
          </span>
        </Card>

        <Card className="shadow-xs p-3.5 flex flex-col justify-between">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-[14px] leading-[20px] font-normal text-muted-foreground">7 日日均成本</span>
            <Calendar className="size-4 text-indigo-500" />
          </div>
          <div className="mt-1.5 text-[24px] leading-[28px] font-semibold font-mono tabular-nums text-foreground">
            {formatCurrency(total?.daily_avg_7d)}
          </div>
          <span className="text-[12px] leading-[16px] text-muted-foreground mt-1">
            固定最近 7 个自然日均消耗
          </span>
        </Card>

        <Card className="shadow-xs p-3.5 flex flex-col justify-between">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-[14px] leading-[20px] font-normal text-muted-foreground">预计最早耗尽时间</span>
            <Hourglass className="size-4 text-amber-500" />
          </div>
          <div className="mt-1.5 text-[24px] leading-[28px] font-semibold font-mono tabular-nums">
            {shortest?.days != null ? (
              (() => {
                const runwayThresholds = getServerSettings().monitoring.runway
                return (
                  <span
                    className={
                      shortest.days < runwayThresholds.dangerDays
                        ? "text-rose-600 dark:text-rose-400"
                        : shortest.days < runwayThresholds.warnDays
                        ? "text-amber-600 dark:text-amber-400"
                        : "text-foreground"
                    }
                  >
                    {shortest.days.toFixed(1)}{" "}
                    <span className="text-[14px] font-normal font-sans text-muted-foreground">天后耗尽</span>
                  </span>
                )
              })()
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </div>
          <div className="text-[12px] leading-[16px] text-muted-foreground mt-1 flex flex-col gap-0.5">
            <span>
              {shortest
                ? `最早耗尽上游账户: ${shortest.name}`
                : "暂无上游账户消耗数据"}
            </span>
            <span>
              全站加权估算: {total?.runway_days != null ? `${total.runway_days.toFixed(1)} 天` : "—"}
            </span>
          </div>
        </Card>
      </section>

      {/* 2. 下方账户表 */}
      <Card
        data-slot="detail-card"
        className={cn(
          "shadow-xs overflow-hidden flex flex-col min-w-0 p-4",
          isScrollable ? "lg:flex-1 lg:min-h-0" : "h-fit"
        )}
      >
        <CardHeader className="p-0 pb-2.5 flex flex-row items-center justify-between space-y-0 shrink-0">
          <div className="flex items-center gap-2">
            <CardTitle className="text-[16px] leading-[24px] font-medium text-foreground">
              上游账户余额与预计耗尽时间
            </CardTitle>
            <Badge variant="secondary" className="text-[12px] leading-[16px] h-5 px-1.5 font-medium tabular-nums">
              {sortedRows.length} 个账户
            </Badge>
          </div>
        </CardHeader>

        <CardContent className={cn("p-0 flex flex-col", isScrollable ? "lg:flex-1 lg:min-h-0" : "")}>
          {notReady ? (
            <div className="flex flex-col items-center justify-center py-16 text-center border border-dashed border-border rounded-lg bg-muted/20">
              <AlertCircle className="size-8 text-muted-foreground mb-2" />
              <span className="text-[14px] leading-[20px] font-medium text-foreground">
                接口未就绪
              </span>
              <span className="text-[12px] leading-[16px] text-muted-foreground mt-1">
                后端 /api/capital 接口未上线或连接失败，单接口异常不影响整页其它功能
              </span>
            </div>
          ) : (
            <div
              data-slot="table-container"
              className={cn(
                "rounded-lg border border-border bg-card overflow-x-auto",
                isScrollable ? "lg:flex-1 lg:min-h-0 lg:overflow-auto" : ""
              )}
            >
              <Table className="min-w-[800px] lg:min-w-full table-auto lg:table-fixed text-sm">
                <colgroup className="hidden lg:table-column-group">
                  <col style={{ width: `${COL_WIDTH_PCT.account}%` }} />
                  <col style={{ width: `${COL_WIDTH_PCT.balance}%` }} />
                  <col style={{ width: `${COL_WIDTH_PCT.cost_range}%` }} />
                  <col style={{ width: `${COL_WIDTH_PCT.credits_range}%` }} />
                  <col style={{ width: `${COL_WIDTH_PCT.daily_avg_7d}%` }} />
                  <col style={{ width: `${COL_WIDTH_PCT.runway_days}%` }} />
                  <col style={{ width: `${COL_WIDTH_PCT.status}%` }} />
                </colgroup>
                <TableHeader className="bg-muted/50 sticky top-0 z-20 backdrop-blur-xs">
                  <TableRow className="hover:bg-transparent border-b border-border">
                    {[
                      { key: "account", label: "账户", isNum: false, isLocked: true },
                      { key: "balance", label: "余额 ($)", isNum: true },
                      { key: "cost_range", label: "区间成本 ($)", isNum: true },
                      { key: "credits_range", label: "充值 ($)", isNum: true },
                      { key: "daily_avg_7d", label: "7日日均成本 ($)", isNum: true },
                      { key: "runway_days", label: "预计耗尽", isNum: true },
                      { key: "status", label: "状态", isNum: false },
                    ].map((col) => {
                      const sortAttrs = getSortHeaderAttrs(sortState, col.key)
                      return (
                        <TableHead
                          key={col.key}
                          aria-sort={sortAttrs.ariaSort}
                          onClick={() => handleSort(col.key)}
                          className={cn(
                            "h-9 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground whitespace-nowrap select-none cursor-pointer transition-colors group/th hover:bg-muted/80",
                            col.isNum ? "text-right" : "text-left",
                            col.isLocked && "sticky left-0 bg-muted/95 z-30 border-r border-border min-w-[160px] sm:min-w-[200px]",
                            sortAttrs.isActive && "text-foreground font-semibold"
                          )}
                        >
                          <div
                            className={cn(
                              "inline-flex items-center gap-1.5",
                              col.isNum ? "flex-row-reverse" : "flex-row"
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
                  {sortedRows.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={7}
                        className="h-32 text-center text-muted-foreground"
                      >
                        <div className="flex flex-col items-center justify-center gap-1.5 py-6">
                          <Inbox className="size-8 text-muted-foreground/40" />
                          <span className="text-[14px] leading-[20px] font-medium">
                            所选时间窗口内暂无账户资金记录
                          </span>
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : (
                    sortedRows.map((row) => (
                      <TableRow
                        key={`capital-${row.account_id}`}
                        className="h-[40px] hover:bg-muted/40 transition-colors border-b border-border/60"
                      >
                        {/* 1. 账户 */}
                        <TableCell className="sticky left-0 bg-card z-10 border-r border-border/50 px-3 py-1 whitespace-nowrap min-w-[160px] sm:min-w-[200px]">
                          <div className="flex items-center gap-2 min-w-0">
                            <SiteLogo kind="account" id={row.account_id} label={row.name || row.account_id} size={18} />
                            <div className="flex flex-col justify-center min-w-0 leading-tight">
                              <span
                                className="font-medium text-foreground text-[14px] leading-[20px] truncate max-w-[220px]"
                                title={row.name || row.account_id}
                              >
                                {row.name || row.account_id}
                              </span>
                              <span className="font-mono text-[12px] leading-[16px] text-muted-foreground">
                                {row.account_id}
                              </span>
                            </div>
                          </div>
                        </TableCell>

                        {/* 2. 余额 */}
                        <TableCell className="text-right font-mono tabular-nums text-[14px] leading-[20px] font-semibold text-foreground px-3 py-1 whitespace-nowrap">
                          {formatCurrency(row.balance)}
                        </TableCell>

                        {/* 3. 区间成本 */}
                        <TableCell className="text-right font-mono tabular-nums text-[14px] leading-[20px] text-foreground px-3 py-1 whitespace-nowrap">
                          {formatCurrency(row.cost_range)}
                        </TableCell>

                        {/* 4. 充值 */}
                        <TableCell className="text-right font-mono tabular-nums text-[14px] leading-[20px] text-muted-foreground px-3 py-1 whitespace-nowrap">
                          {formatCurrency(row.credits_range)}
                        </TableCell>

                        {/* 5. 7日日均成本 */}
                        <TableCell className="text-right font-mono tabular-nums text-[14px] leading-[20px] text-foreground px-3 py-1 whitespace-nowrap">
                          {formatCurrency(row.daily_avg_7d)}
                        </TableCell>

                        {/* 6. 续航天数 */}
                        <TableCell className="text-right px-3 py-1 whitespace-nowrap">
                          {renderRunway(row.runway_days)}
                        </TableCell>

                        {/* 7. 状态 */}
                        <TableCell className="px-3 py-1 whitespace-nowrap">
                          {renderStatusBadge(row.status)}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
