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
import { DollarSign, Radio, Cpu, Activity, Inbox } from "lucide-react"
import {
  formatCurrency,
  formatNumber,
  formatPercent,
  formatTimestampShort,
} from "@/lib/formatters"
import {
  formatLatency,
  formatTokenCn,
  formatTps,
  cacheToneClass,
  latencyP50ToneClass,
  latencyP95ToneClass,
} from "@/components/table-utils"
import {
  type SortState,
  type AccessorMap,
  nextSort,
  sortRows,
  getSortHeaderAttrs,
} from "@/lib/table-sort"
import { ColPicker, type ColumnItem } from "@/components/col-picker"
import type { ChannelRowData } from "@/components/channels-rank-view"
import { cn } from "@/lib/utils"

const STORAGE_KEY = "relay-ledger-preview-cols-channels"

const ALL_COLUMNS: ColumnItem[] = [
  { key: "channel", label: "渠道", locked: true },
  { key: "revenue", label: "售出" },
  { key: "tokens", label: "TOKEN" },
  { key: "per_1e8", label: "额度/亿TOKEN" },
  { key: "tps", label: "TPS" },
  { key: "requests", label: "请求数" },
  { key: "cache", label: "缓存率" },
  { key: "p50", label: "P50" },
  { key: "p95", label: "P95" },
  { key: "last", label: "最后请求" },
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
        if (!valid.includes("channel")) {
          valid.unshift("channel")
        }
        return valid
      }
    }
  } catch (e) {
    // fallback
  }
  return ALL_COLUMNS.map((c) => c.key)
}

function renderUpstreamStatusBadge(status?: string) {
  switch (status) {
    case "complete":
      return (
        <Badge
          variant="default"
          className="text-[12px] leading-[16px] h-5 px-1.5 whitespace-nowrap font-medium"
        >
          已核算
        </Badge>
      )
    case "partial":
      return (
        <Badge
          variant="secondary"
          className="text-[12px] leading-[16px] h-5 px-1.5 whitespace-nowrap font-medium"
        >
          部分数据
        </Badge>
      )
    case "unavailable":
      return (
        <Badge
          variant="outline"
          className="text-[12px] leading-[16px] h-5 px-1.5 whitespace-nowrap font-medium text-amber-600 dark:text-amber-400 border-amber-500/30"
        >
          待接快照
        </Badge>
      )
    case "unconfigured":
      return (
        <Badge
          variant="outline"
          className="text-[12px] leading-[16px] h-5 px-1.5 whitespace-nowrap font-medium text-muted-foreground"
        >
          未配置上游
        </Badge>
      )
    case "disabled_account":
      return (
        <Badge
          variant="outline"
          className="text-[12px] leading-[16px] h-5 px-1.5 whitespace-nowrap font-medium text-muted-foreground"
        >
          已停用
        </Badge>
      )
    default:
      return (
        <Badge
          variant="outline"
          className="text-[12px] leading-[16px] h-5 px-1.5 whitespace-nowrap font-medium"
        >
          {status || "未映射"}
        </Badge>
      )
  }
}

// 固定列宽（百分比）：table-fixed 下按列定宽，数字列的右边缘才会逐行对齐，
// 不再随「模型名长短 / 账户名长短」自动伸缩。
const COL_WIDTH_PCT: Record<string, number> = {
  channel: 18,
  revenue: 7.6,
  tokens: 8.2,
  per_1e8: 11.2,
  tps: 6.2,
  requests: 7,
  cache: 7,
  p50: 6.4,
  p95: 6.4,
  last: 8.8,
  upstream: 13.2,
}

const CHANNEL_ACCESSORS: AccessorMap<ChannelRowData> = {
  channel: (r) => r.channel_name || "",
  revenue: (r) => r.revenue ?? null,
  tokens: (r) => (r.tokens ?? r.tokens_total) ?? null,
  per_1e8: (r) => r.top_model?.per_1e8 ?? null,
  tps: (r) => (r.archive_only ? null : r.tps ?? null),
  requests: (r) => r.requests ?? null,
  cache: (r) => r.cache_rate ?? null,
  p50: (r) => (r.p50 ?? r.latency_p50) ?? null,
  p95: (r) => (r.p95 ?? r.latency_p95) ?? null,
  last: (r) => r.last_t ?? null,
  upstream: (r) => r.upstream_account || "",
}

interface ChannelsDetailViewProps {
  timeRange: "24h" | "7d"
  rows: ChannelRowData[]
}

export function ChannelsDetailView({
  timeRange,
  rows,
}: ChannelsDetailViewProps) {
  const [visibleKeys, setVisibleKeys] = React.useState<string[]>(getInitialVisibleKeys)
  const [sortState, setSortState] = React.useState<SortState | null>(null)

  // 切换时间范围回到默认口径顺序
  React.useEffect(() => {
    setSortState(null)
  }, [timeRange])

  const handleSort = React.useCallback((key: string) => {
    setSortState((prev) => nextSort(prev, key))
  }, [])

  const toggleColumn = React.useCallback((key: string) => {
    if (key === "channel") return // 第一列锁定
    setVisibleKeys((prev) => {
      const next = prev.includes(key)
        ? prev.filter((k) => k !== key)
        : [...prev, key]
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      } catch (e) {}
      return next
    })
  }, [])

  // 排序：sortState 为 null 时保持接口原始顺序
  const sortedRows = React.useMemo(() => {
    return sortRows(rows, sortState, CHANNEL_ACCESSORS)
  }, [rows, sortState])

  // 汇总统计指标
  const totals = React.useMemo(() => {
    const totalRev = sortedRows.reduce((sum, r) => sum + (r.revenue ?? 0), 0)
    const totalTok = sortedRows.reduce((sum, r) => sum + (r.tokens ?? r.tokens_total ?? 0), 0)
    const totalReq = sortedRows.reduce((sum, r) => sum + (r.requests ?? 0), 0)
    const avgCache =
      sortedRows.length > 0
        ? sortedRows.reduce((sum, r) => sum + (r.cache_rate ?? 0), 0) / sortedRows.length
        : 0
    return {
      revenue: totalRev,
      tokens: totalTok,
      requests: totalReq,
      cacheRate: avgCache,
    }
  }, [sortedRows])

  const visibleCols = ALL_COLUMNS.filter((c) => visibleKeys.includes(c.key))

  const isScrollable = sortedRows.length > 12

  return (
    <div className="flex-1 min-h-0 flex flex-col space-y-4">
      {/* 1. 顶部紧凑汇总指标行 (4 张小卡) */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3.5 shrink-0">
        <Card className="shadow-xs p-3.5 flex flex-col justify-between">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-[14px] leading-[20px] font-normal text-muted-foreground">售出总计</span>
            <DollarSign className="size-4" />
          </div>
          <div className="mt-1.5 text-[24px] leading-[28px] font-semibold font-mono tabular-nums text-foreground">
            {formatCurrency(totals.revenue)}
          </div>
          <span className="text-[12px] leading-[16px] text-muted-foreground mt-1">
            {timeRange === "24h" ? "近 24 小时渠道售出" : "近 7 天渠道售出"}
          </span>
        </Card>

        <Card className="shadow-xs p-3.5 flex flex-col justify-between">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-[14px] leading-[20px] font-normal text-muted-foreground">在售渠道数</span>
            <Radio className="size-4 text-emerald-600 dark:text-emerald-400" />
          </div>
          <div className="mt-1.5 text-[24px] leading-[28px] font-semibold font-mono tabular-nums text-foreground">
            {sortedRows.length} <span className="text-[14px] font-normal font-sans text-muted-foreground">个</span>
          </div>
          <span className="text-[12px] leading-[16px] text-muted-foreground mt-1">产生调用与计费明细</span>
        </Card>

        <Card className="shadow-xs p-3.5 flex flex-col justify-between">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-[14px] leading-[20px] font-normal text-muted-foreground">消耗 Token</span>
            <Cpu className="size-4 text-indigo-500" />
          </div>
          <div className="mt-1.5 text-[24px] leading-[28px] font-semibold font-mono tabular-nums text-foreground">
            {formatTokenCn(totals.tokens)}
          </div>
          <span className="text-[12px] leading-[16px] text-muted-foreground mt-1 tabular-nums font-mono">
            {formatNumber(totals.tokens)}
          </span>
        </Card>

        <Card className="shadow-xs p-3.5 flex flex-col justify-between">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-[14px] leading-[20px] font-normal text-muted-foreground">请求总量</span>
            <Activity className="size-4 text-amber-500" />
          </div>
          <div className="mt-1.5 text-[24px] leading-[28px] font-semibold font-mono tabular-nums text-foreground">
            {formatNumber(totals.requests)} <span className="text-[14px] font-normal font-sans text-muted-foreground">次</span>
          </div>
          <span className="text-[12px] leading-[16px] text-muted-foreground mt-1">
            均缓存率 {formatPercent(totals.cacheRate)}
          </span>
        </Card>
      </section>

      {/* 2. 核心表格卡片：行数 <= 12 时贴合内容高度 h-fit 无空白；> 12 行才 flex-1 卡内滚动 */}
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
              渠道经营表现明细
            </CardTitle>
            <Badge variant="secondary" className="text-[12px] leading-[16px] h-5 px-1.5 font-medium tabular-nums">
              {sortedRows.length} 个渠道
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
                  <col key={col.key} style={{ width: `${COL_WIDTH_PCT[col.key] ?? 8}%` }} />
                ))}
              </colgroup>
              <TableHeader className="bg-muted/50 sticky top-0 z-20 backdrop-blur-xs">
                <TableRow className="hover:bg-transparent border-b border-border">
                  {visibleCols.map((col) => {
                    const isLocked = col.key === "channel"
                    const isNum = [
                      "revenue",
                      "tokens",
                      "per_1e8",
                      "tps",
                      "requests",
                      "cache",
                      "p50",
                      "p95",
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
                          isLocked && "sticky left-0 bg-muted/95 z-30 border-r border-border min-w-[160px] sm:min-w-[180px]",
                          sortAttrs.isActive && "text-foreground font-semibold"
                        )}
                        title={
                          col.key === "per_1e8"
                            ? "该渠道售出额最高模型的每 1 亿 Token 售出额"
                            : col.key === "tps"
                            ? "输出 token / 秒（区间累计输出 token ÷ 累计请求耗时）"
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
                        <span className="text-[14px] leading-[20px] font-medium">所选时间窗口内暂无渠道计费记录</span>
                        <span className="text-[12px] leading-[16px] text-muted-foreground">可切换为「近 7 天」查看更多记录</span>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  sortedRows.map((row) => {
                    const tokensVal = row.tokens ?? row.tokens_total
                    const p50Val = row.p50 ?? row.latency_p50
                    const p95Val = row.p95 ?? row.latency_p95

                    return (
                      <TableRow
                        key={`channel-${row.channel_id}`}
                        className="h-[44px] hover:bg-muted/40 transition-colors border-b border-border/60"
                      >
                        {visibleCols.map((col) => {
                          switch (col.key) {
                            case "channel":
                              return (
                                <TableCell
                                  key={col.key}
                                  className="sticky left-0 bg-card z-10 border-r border-border/50 px-3 py-1 whitespace-nowrap min-w-[160px] sm:min-w-[180px]"
                                >
                                  <div className="flex items-center gap-1.5 min-w-0">
                                    <span className="font-mono text-[12px] leading-[16px] text-muted-foreground shrink-0">
                                      #{row.channel_id}
                                    </span>
                                    <span className="font-normal text-foreground text-[14px] leading-[20px] line-clamp-2 max-w-[200px]" title={row.channel_name}>
                                      {row.channel_name || "未命名渠道"}
                                    </span>
                                  </div>
                                </TableCell>
                              )

                            case "revenue":
                              return (
                                <TableCell key={col.key} className="text-right font-mono tabular-nums text-[14px] leading-[20px] font-semibold text-foreground px-3 py-1 whitespace-nowrap">
                                  {formatCurrency(row.revenue)}
                                </TableCell>
                              )

                            case "tokens":
                              return (
                                <TableCell
                                  key={col.key}
                                  className="text-right font-mono tabular-nums text-[14px] leading-[20px] text-foreground px-3 py-1 whitespace-nowrap"
                                  title={tokensVal == null ? "—" : formatNumber(tokensVal)}
                                >
                                  {formatTokenCn(tokensVal)}
                                </TableCell>
                              )

                            case "per_1e8":
                              return (
                                <TableCell key={col.key} className="text-right px-3 py-1 whitespace-nowrap">
                                  {row.top_model ? (
                                    <div className="flex flex-col items-end leading-tight" title={`${row.top_model.model} · 每 1 亿 Token 售出额`}>
                                      <span className="font-mono tabular-nums text-[14px] leading-[20px] font-semibold text-foreground">
                                        {row.top_model.per_1e8 != null ? row.top_model.per_1e8.toFixed(2) : "—"}
                                      </span>
                                      <span className="text-[12px] leading-[16px] text-muted-foreground max-w-[140px] truncate">
                                        {row.top_model.model}
                                      </span>
                                    </div>
                                  ) : (
                                    <span className="text-[12px] leading-[16px] text-muted-foreground">—</span>
                                  )}
                                </TableCell>
                              )

                            case "tps":
                              return (
                                <TableCell key={col.key} className="text-right font-mono tabular-nums text-[14px] leading-[20px] text-foreground px-3 py-1 whitespace-nowrap">
                                  {row.archive_only ? "—" : formatTps(row.tps)}
                                </TableCell>
                              )

                            case "requests":
                              return (
                                <TableCell key={col.key} className="text-right font-mono tabular-nums text-[14px] leading-[20px] text-foreground px-3 py-1 whitespace-nowrap">
                                  {formatNumber(row.requests)}
                                </TableCell>
                              )

                            case "cache":
                              return (
                                <TableCell key={col.key} className="text-right px-3 py-1 whitespace-nowrap">
                                  <span className={cn("font-mono tabular-nums text-[14px] leading-[20px] font-semibold", cacheToneClass(row.cache_rate))}>
                                    {formatPercent(row.cache_rate)}
                                  </span>
                                </TableCell>
                              )

                            case "p50":
                              return (
                                <TableCell key={col.key} className="text-right px-3 py-1 whitespace-nowrap">
                                  <span className={cn("font-mono tabular-nums text-[14px] leading-[20px] font-semibold", latencyP50ToneClass(p50Val))}>
                                    {formatLatency(p50Val)}
                                  </span>
                                </TableCell>
                              )

                            case "p95":
                              return (
                                <TableCell key={col.key} className="text-right px-3 py-1 whitespace-nowrap">
                                  <span className={cn("font-mono tabular-nums text-[14px] leading-[20px] font-semibold", latencyP95ToneClass(p95Val))}>
                                    {formatLatency(p95Val)}
                                  </span>
                                </TableCell>
                              )

                            case "last":
                              return (
                                <TableCell key={col.key} className="text-left font-mono tabular-nums text-[12px] leading-[16px] text-muted-foreground px-3 py-1 whitespace-nowrap whitespace-nowrap">
                                  {formatTimestampShort(row.last_t)}
                                </TableCell>
                              )

                            case "upstream":
                              return (
                                <TableCell key={col.key} className="text-left px-3 py-1 min-w-[140px] sm:min-w-[168px]">
                                  <div className="flex flex-col items-start gap-0.5">
                                    <span
                                      className="font-normal text-foreground text-[14px] leading-[20px] line-clamp-2 min-w-0"
                                      title={`${row.upstream_account || "未映射"} · ${row.margin_status ?? ""}`}
                                    >
                                      {row.upstream_account || "未映射"}
                                    </span>
                                    <span className="shrink-0 scale-90 origin-left">{renderUpstreamStatusBadge(row.margin_status)}</span>
                                  </div>
                                </TableCell>
                              )

                            default:
                              return null
                          }
                        })}
                      </TableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>

        {/* 表格底部汇总行 */}
        <div
          data-slot="detail-card-footer"
          className="pt-2 mt-2 border-t border-border/60 flex flex-wrap items-center justify-between text-[12px] leading-[16px] text-muted-foreground shrink-0 gap-2"
        >
          <div className="flex items-center gap-3 tabular-nums">
            <span>共 {sortedRows.length} 条记录</span>
            <span>·</span>
            <span>售出汇总: <strong className="font-mono text-foreground font-semibold text-[14px]">{formatCurrency(totals.revenue)}</strong></span>
            <span>·</span>
            <span>Token: <strong className="font-mono text-foreground font-semibold text-[14px]">{formatTokenCn(totals.tokens)}</strong></span>
          </div>
          <span className="text-[12px] leading-[16px] text-muted-foreground">
            列配置已自动同步到本地存储
          </span>
        </div>
      </Card>
    </div>
  )
}
