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
import { Cpu, DollarSign, Activity, Coins, Inbox, AlertCircle } from "lucide-react"
import {
  formatCurrency,
  formatNumber,
  formatPercent,
} from "@/lib/formatters"
import { formatTokenCn } from "@/components/table-utils"
import {
  type SortState,
  type AccessorMap,
  nextSort,
  sortRows,
  getSortHeaderAttrs,
} from "@/lib/table-sort"
import { ColPicker, type ColumnItem } from "@/components/col-picker"
import {
  fetchModels,
  getMockModels,
  type ModelItem,
  type ModelsPayload,
  type DateRange,
  type RangeType,
} from "@/lib/api"
import { cn } from "@/lib/utils"

const STORAGE_KEY = "relay-ledger-preview-cols-models"

const ALL_COLUMNS: ColumnItem[] = [
  { key: "model", label: "模型", locked: true },
  { key: "revenue", label: "售出 ($)" },
  { key: "share", label: "占比" },
  { key: "requests", label: "请求数" },
  { key: "tokens", label: "Token" },
  { key: "per_1e8", label: "亿Token 均价 ($)" },
  { key: "upstream", label: "上游账户" },
]

function getInitialVisibleKeys(): string[] {
  if (typeof window === "undefined") {
    return ALL_COLUMNS.map((c) => c.key)
  }
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      const parsed = JSON.parse(saved)
      if (Array.isArray(parsed) && parsed.length > 0) {
        const valid = parsed.filter((k) => ALL_COLUMNS.some((c) => c.key === k))
        if (!valid.includes("model")) {
          valid.unshift("model")
        }
        return valid
      }
    }
  } catch {
    // fallback
  }
  return ALL_COLUMNS.map((c) => c.key)
}

const COL_WIDTH_PCT: Record<string, number> = {
  model: 24,
  revenue: 12,
  share: 10,
  requests: 11,
  tokens: 14,
  per_1e8: 13,
  upstream: 16,
}

const MODEL_ACCESSORS: AccessorMap<ModelItem> = {
  model: (r) => r.model || "",
  revenue: (r) => r.revenue ?? null,
  share: (r) => r.share ?? null,
  requests: (r) => r.requests ?? null,
  tokens: (r) => r.tokens ?? null,
  per_1e8: (r) => r.per_1e8 ?? null,
  upstream: (r) => (r.upstream_accounts || []).join(", "),
}

interface ModelsViewProps {
  timeRange: RangeType
  dateRange: DateRange | null
  previewMode?: boolean
}

export function ModelsView({
  timeRange,
  dateRange,
  previewMode = false,
}: ModelsViewProps) {
  const [data, setData] = React.useState<ModelsPayload | null>(null)
  const [notReady, setNotReady] = React.useState(false)
  const [fetchError, setFetchError] = React.useState<string | null>(null)
  const [visibleKeys, setVisibleKeys] = React.useState<string[]>(getInitialVisibleKeys)
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
          if (!cancelled) setData(getMockModels())
        })
      }
      return
    }

    void fetchModels(dateRange)
      .then((res) => {
        if (cancelled) return
        setData(res)
        setNotReady(false)
        setFetchError(null)
      })
      .catch((error) => {
        if (cancelled) return
        if (previewMode) {
          setData(getMockModels())
          setNotReady(false)
        } else {
          setNotReady(true)
          setData(null)
          setFetchError(error instanceof Error ? error.message : String(error))
        }
      })

    return () => {
      cancelled = true
    }
  }, [dateRange, previewMode])

  const handleSort = React.useCallback((key: string) => {
    setSortState((prev) => nextSort(prev, key))
  }, [])

  const toggleColumn = React.useCallback((key: string) => {
    if (key === "model") return // 第一列锁定
    setVisibleKeys((prev) => {
      const next = prev.includes(key)
        ? prev.filter((k) => k !== key)
        : [...prev, key]
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      } catch {
        // ignore
      }
      return next
    })
  }, [])

  const rows = React.useMemo(() => data?.models ?? [], [data])

  const sortedRows = React.useMemo(() => {
    return sortRows(rows, sortState, MODEL_ACCESSORS)
  }, [rows, sortState])

  const totals = React.useMemo(() => {
    const totalRev = data?.total_revenue ?? rows.reduce((sum, r) => sum + (r.revenue ?? 0), 0)
    const totalTok = rows.reduce((sum, r) => sum + (r.tokens ?? 0), 0)
    const avgPer1e8 =
      totalTok > 0 ? (totalRev / (totalTok / 1e8)) : null
    return {
      modelCount: rows.length,
      revenue: totalRev,
      tokens: totalTok,
      avgPer1e8,
    }
  }, [data, rows])

  const visibleCols = ALL_COLUMNS.filter((c) => visibleKeys.includes(c.key))
  const isScrollable = sortedRows.length > 10

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-4 overflow-y-auto pr-1">
      {/* 1. 顶部 4 张 KPI 卡片 */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3.5 shrink-0">
        <Card className="shadow-xs p-3.5 flex flex-col justify-between">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-[14px] leading-[20px] font-normal text-muted-foreground">模型数</span>
            <Cpu className="size-4 text-emerald-600 dark:text-emerald-400" />
          </div>
          <div className="mt-1.5 text-[24px] leading-[28px] font-semibold font-mono tabular-nums text-foreground">
            {data ? totals.modelCount : "—"} <span className="text-[14px] font-normal font-sans text-muted-foreground">个</span>
          </div>
        </Card>

        <Card className="shadow-xs p-3.5 flex flex-col justify-between">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-[14px] leading-[20px] font-normal text-muted-foreground">售出合计</span>
            <DollarSign className="size-4" />
          </div>
          <div className="mt-1.5 text-[24px] leading-[28px] font-semibold font-mono tabular-nums text-foreground">
            {formatCurrency(data ? totals.revenue : null)}
          </div>
        </Card>

        <Card className="shadow-xs p-3.5 flex flex-col justify-between">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-[14px] leading-[20px] font-normal text-muted-foreground">Token 合计</span>
            <Activity className="size-4 text-indigo-500" />
          </div>
          <div className="mt-1.5 text-[24px] leading-[28px] font-semibold font-mono tabular-nums text-foreground">
            {formatTokenCn(data ? totals.tokens : null)}
          </div>
          <span className="text-[12px] leading-[16px] text-muted-foreground mt-1 tabular-nums font-mono">
            {formatNumber(data ? totals.tokens : null)}
          </span>
        </Card>

        <Card className="shadow-xs p-3.5 flex flex-col justify-between">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-[14px] leading-[20px] font-normal text-muted-foreground">每亿 Token 均价</span>
            <Coins className="size-4 text-amber-500" />
          </div>
          <div className="mt-1.5 text-[24px] leading-[28px] font-semibold font-mono tabular-nums text-foreground">
            {formatCurrency(totals.avgPer1e8)}
          </div>
        </Card>
      </section>

      {/* 2. 下方整幅表 */}
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
              模型明细
            </CardTitle>
            <Badge variant="secondary" className="text-[12px] leading-[16px] h-5 px-1.5 font-medium tabular-nums">
              {sortedRows.length} 个模型
            </Badge>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <ColPicker
              columns={ALL_COLUMNS}
              visibleKeys={visibleKeys}
              onToggleColumn={toggleColumn}
            />
          </div>
        </CardHeader>

        <CardContent className={cn("p-0 flex flex-col", isScrollable ? "lg:flex-1 lg:min-h-0" : "")}>
          {notReady ? (
            <div className="flex flex-col items-center justify-center py-16 text-center border border-dashed border-border rounded-lg bg-muted/20">
              <AlertCircle className="size-8 text-muted-foreground mb-2" />
              <span className="text-[14px] leading-[20px] font-medium text-foreground">
                模型数据暂不可用
              </span>
              {fetchError && <span role="alert" className="mt-1 max-w-full break-words text-[12px] text-destructive">{fetchError}</span>}
            </div>
          ) : (
            <div
              data-slot="table-container"
              className={cn(
                "rounded-lg border border-border bg-card overflow-x-auto",
                isScrollable ? "lg:flex-1 lg:min-h-0 lg:overflow-auto" : ""
              )}
            >
              <Table className="min-w-[860px] lg:min-w-full table-auto lg:table-fixed text-sm">
                <colgroup className="hidden lg:table-column-group">
                  {visibleCols.map((col) => (
                    <col key={col.key} style={{ width: `${COL_WIDTH_PCT[col.key] ?? 12}%` }} />
                  ))}
                </colgroup>
                <TableHeader className="bg-muted/50 sticky top-0 z-20 backdrop-blur-xs">
                  <TableRow className="hover:bg-transparent border-b border-border">
                    {visibleCols.map((col) => {
                      const isLocked = col.key === "model"
                      const isNum = [
                        "revenue",
                        "share",
                        "requests",
                        "tokens",
                        "per_1e8",
                      ].includes(col.key)
                      const sortAttrs = getSortHeaderAttrs(sortState, col.key)

                      return (
                        <TableHead
                          key={col.key}
                          aria-sort={sortAttrs.ariaSort}
                          onClick={() => handleSort(col.key)}
                          className={cn(
                            "h-9 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground whitespace-nowrap select-none cursor-pointer transition-colors group/th hover:bg-muted/80",
                            isNum ? "text-right" : "text-left",
                            isLocked && "sticky left-0 bg-muted/95 z-30 border-r border-border min-w-[180px] sm:min-w-[220px]",
                            sortAttrs.isActive && "text-foreground font-semibold"
                          )}
                          title={
                            col.key === "per_1e8"
                              ? "该模型每 1 亿 Token 售出额"
                              : undefined
                          }
                        >
                          <div
                            className={cn(
                              "inline-flex items-center gap-1.5",
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
                  {sortedRows.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={visibleCols.length}
                        className="h-32 text-center text-muted-foreground"
                      >
                        <div className="flex flex-col items-center justify-center gap-1.5 py-6">
                          <Inbox className="size-8 text-muted-foreground/40" />
                          <span className="text-[14px] leading-[20px] font-medium">
                            所选时间窗口内暂无模型记录
                          </span>
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : (
                    sortedRows.map((row) => (
                      <TableRow
                        key={`model-${row.model}`}
                        className="h-[40px] hover:bg-muted/40 transition-colors border-b border-border/60"
                      >
                        {visibleCols.map((col) => {
                          switch (col.key) {
                            case "model":
                              return (
                                <TableCell
                                  key={col.key}
                                  className="sticky left-0 bg-card z-10 border-r border-border/50 px-3 py-1 whitespace-nowrap min-w-[180px] sm:min-w-[220px]"
                                >
                                  <span
                                    className="font-medium text-foreground text-[14px] leading-[20px] truncate block max-w-[240px]"
                                    title={row.model}
                                  >
                                    {row.model}
                                  </span>
                                </TableCell>
                              )

                            case "revenue":
                              return (
                                <TableCell
                                  key={col.key}
                                  className="text-right font-mono tabular-nums text-[14px] leading-[20px] font-semibold text-foreground px-3 py-1 whitespace-nowrap"
                                >
                                  {formatCurrency(row.revenue)}
                                </TableCell>
                              )

                            case "share":
                              return (
                                <TableCell
                                  key={col.key}
                                  className="text-right font-mono tabular-nums text-[14px] leading-[20px] text-muted-foreground px-3 py-1 whitespace-nowrap"
                                >
                                  {formatPercent(row.share)}
                                </TableCell>
                              )

                            case "requests":
                              return (
                                <TableCell
                                  key={col.key}
                                  className="text-right font-mono tabular-nums text-[14px] leading-[20px] text-foreground px-3 py-1 whitespace-nowrap"
                                >
                                  {formatNumber(row.requests)}
                                </TableCell>
                              )

                            case "tokens":
                              return (
                                <TableCell
                                  key={col.key}
                                  className="text-right font-mono tabular-nums text-[14px] leading-[20px] text-foreground px-3 py-1 whitespace-nowrap"
                                  title={row.tokens == null ? "—" : formatNumber(row.tokens)}
                                >
                                  {formatTokenCn(row.tokens)}
                                </TableCell>
                              )

                            case "per_1e8":
                              return (
                                <TableCell
                                  key={col.key}
                                  className="text-right font-mono tabular-nums text-[14px] leading-[20px] text-foreground px-3 py-1 whitespace-nowrap"
                                >
                                  {formatCurrency(row.per_1e8)}
                                </TableCell>
                              )

                            case "upstream":
                              return (
                                <TableCell
                                  key={col.key}
                                  className="px-3 py-1 whitespace-nowrap"
                                >
                                  {row.upstream_accounts && row.upstream_accounts.length > 0 ? (
                                    <div className="flex flex-wrap gap-1 max-w-[200px]">
                                      {row.upstream_accounts.map((acc) => (
                                        <Badge
                                          key={acc}
                                          variant="secondary"
                                          className="text-[12px] leading-[16px] h-5 px-1.5 font-normal text-foreground"
                                        >
                                          {acc}
                                        </Badge>
                                      ))}
                                    </div>
                                  ) : (
                                    <span className="text-muted-foreground text-[14px] leading-[20px]">
                                      —
                                    </span>
                                  )}
                                </TableCell>
                              )

                            default:
                              return null
                          }
                        })}
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
