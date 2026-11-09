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
import { DollarSign, Layers, Cpu, Activity, Inbox } from "lucide-react"
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
import type { GroupRowData } from "@/components/groups-rank-view"
import { cn } from "@/lib/utils"

const STORAGE_KEY = "relay-ledger-preview-cols-groups"

const ALL_COLUMNS: ColumnItem[] = [
  { key: "group", label: "分组", locked: true },
  { key: "revenue", label: "售出" },
  { key: "tokens", label: "TOKEN" },
  { key: "per_1e8", label: "额度/亿TOKEN" },
  { key: "tps", label: "TPS" },
  { key: "requests", label: "请求数" },
  { key: "cache", label: "缓存率" },
  { key: "p50", label: "P50" },
  { key: "p95", label: "P95" },
  { key: "last", label: "最后请求" },
  { key: "channels", label: "渠道数" },
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
        if (!valid.includes("group")) {
          valid.unshift("group")
        }
        return valid
      }
    }
  } catch (e) {
    // fallback
  }
  return ALL_COLUMNS.map((c) => c.key)
}

// 固定列宽（百分比）：table-fixed 下按列定宽，数字列的右边缘才会逐行对齐。
const COL_WIDTH_PCT: Record<string, number> = {
  group: 19,
  revenue: 7.8,
  tokens: 8.4,
  per_1e8: 12.6,
  tps: 6.5,
  requests: 7.4,
  cache: 7.4,
  p50: 6.8,
  p95: 6.8,
  last: 9.3,
  channels: 8,
}
const GROUP_ACCESSORS: AccessorMap<GroupRowData> = {
  group: (g) => g.group_name || "",
  revenue: (g) => g.revenue ?? null,
  tokens: (g) => g.tokens ?? null,
  per_1e8: (g) => g.top_model?.per_1e8 ?? null,
  tps: (g) => g.tps ?? null,
  requests: (g) => g.requests ?? null,
  cache: (g) => g.cache_rate ?? null,
  p50: (g) => (g.p50 ?? g.latency_p50) ?? null,
  p95: (g) => (g.p95 ?? g.latency_p95) ?? null,
  last: (g) => g.last_t ?? null,
  channels: (g) => g.channels ?? null,
}

interface GroupsDetailViewProps {
  timeRange: "24h" | "7d"
  groups: GroupRowData[]
}

export function GroupsDetailView({
  timeRange,
  groups,
}: GroupsDetailViewProps) {
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
    if (key === "group") return // 第一列锁定
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
  const sortedGroups = React.useMemo(() => {
    return sortRows(groups, sortState, GROUP_ACCESSORS)
  }, [groups, sortState])

  // 汇总统计指标
  const totals = React.useMemo(() => {
    const totalRev = sortedGroups.reduce((sum, g) => sum + (g.revenue ?? 0), 0)
    const totalTok = sortedGroups.reduce((sum, g) => sum + (g.tokens ?? 0), 0)
    const totalReq = sortedGroups.reduce((sum, g) => sum + (g.requests ?? 0), 0)
    const avgCache =
      sortedGroups.length > 0
        ? sortedGroups.reduce((sum, g) => sum + (g.cache_rate ?? 0), 0) / sortedGroups.length
        : 0
    const totalCh = sortedGroups.reduce((sum, g) => sum + (g.channels ?? 0), 0)
    return {
      revenue: totalRev,
      tokens: totalTok,
      requests: totalReq,
      cacheRate: avgCache,
      channels: totalCh,
    }
  }, [sortedGroups])

  const visibleCols = ALL_COLUMNS.filter((c) => visibleKeys.includes(c.key))

  const isScrollable = sortedGroups.length > 12

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
            {timeRange === "24h" ? "近 24 小时分组售出" : "近 7 天分组售出"}
          </span>
        </Card>

        <Card className="shadow-xs p-3.5 flex flex-col justify-between">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-[14px] leading-[20px] font-normal text-muted-foreground">业务分组数</span>
            <Layers className="size-4 text-emerald-600 dark:text-emerald-400" />
          </div>
          <div className="mt-1.5 text-[24px] leading-[28px] font-semibold font-mono tabular-nums text-foreground">
            {sortedGroups.length} <span className="text-[14px] font-normal font-sans text-muted-foreground">个</span>
          </div>
          <span className="text-[12px] leading-[16px] text-muted-foreground mt-1">
            累计映射 {totals.channels} 个渠道
          </span>
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
              业务分组经营表现明细
            </CardTitle>
            <Badge variant="secondary" className="text-[12px] leading-[16px] h-5 px-1.5 font-medium tabular-nums">
              {sortedGroups.length} 个分组
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
                    const isLocked = col.key === "group"
                    const isNum = [
                      "revenue",
                      "tokens",
                      "per_1e8",
                      "tps",
                      "requests",
                      "cache",
                      "p50",
                      "p95",
                      "channels",
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
                            ? "该分组售出额最高模型的每 1 亿 Token 售出额"
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
                {sortedGroups.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={visibleCols.length}
                      className="h-32 text-center text-muted-foreground"
                    >
                      <div className="flex flex-col items-center justify-center gap-1.5 py-6">
                        <Inbox className="size-8 text-muted-foreground/40" />
                        <span className="text-[14px] leading-[20px] font-medium">所选时间窗口内暂无分组计费记录</span>
                        <span className="text-[12px] leading-[16px] text-muted-foreground">可切换为「近 7 天」查看更多记录</span>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  sortedGroups.map((group, index) => {
                    const p50Val = group.p50 ?? group.latency_p50
                    const p95Val = group.p95 ?? group.latency_p95
                    const channelNamesStr = Array.isArray(group.channel_names)
                      ? group.channel_names.join("、")
                      : ""

                    return (
                      <TableRow
                        key={`group-${group.group_name || "empty"}-${index}`}
                        className="h-[44px] hover:bg-muted/40 transition-colors border-b border-border/60"
                      >
                        {visibleCols.map((col) => {
                          switch (col.key) {
                            case "group":
                              return (
                                <TableCell
                                  key={col.key}
                                  className="sticky left-0 bg-card z-10 border-r border-border/50 px-3 py-1 whitespace-nowrap min-w-[160px] sm:min-w-[180px]"
                                >
                                  <span
                                    className={cn(
                                      "text-[14px] leading-[20px] line-clamp-2 block max-w-[200px]",
                                      group.group_name ? "font-normal text-foreground" : "text-muted-foreground italic"
                                    )}
                                    title={group.group_name || "未分组"}
                                  >
                                    {group.group_name || "未分组"}
                                  </span>
                                </TableCell>
                              )

                            case "revenue":
                              return (
                                <TableCell key={col.key} className="text-right font-mono tabular-nums text-[14px] leading-[20px] font-semibold text-foreground px-3 py-1 whitespace-nowrap">
                                  {formatCurrency(group.revenue)}
                                </TableCell>
                              )

                            case "tokens":
                              return (
                                <TableCell
                                  key={col.key}
                                  className="text-right font-mono tabular-nums text-[14px] leading-[20px] text-foreground px-3 py-1 whitespace-nowrap"
                                  title={group.tokens == null ? "—" : formatNumber(group.tokens)}
                                >
                                  {formatTokenCn(group.tokens)}
                                </TableCell>
                              )

                            case "per_1e8":
                              return (
                                <TableCell key={col.key} className="text-right px-3 py-1 whitespace-nowrap">
                                  {group.top_model ? (
                                    <div className="flex flex-col items-end leading-tight" title={`${group.top_model.model} · 每 1 亿 Token 售出额`}>
                                      <span className="font-mono tabular-nums text-[14px] leading-[20px] font-semibold text-foreground">
                                        {group.top_model.per_1e8 != null ? group.top_model.per_1e8.toFixed(2) : "—"}
                                      </span>
                                      <span className="text-[12px] leading-[16px] text-muted-foreground max-w-[140px] truncate">
                                        {group.top_model.model}
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
                                  {formatTps(group.tps)}
                                </TableCell>
                              )

                            case "requests":
                              return (
                                <TableCell key={col.key} className="text-right font-mono tabular-nums text-[14px] leading-[20px] text-foreground px-3 py-1 whitespace-nowrap">
                                  {formatNumber(group.requests)}
                                </TableCell>
                              )

                            case "cache":
                              return (
                                <TableCell key={col.key} className="text-right px-3 py-1 whitespace-nowrap">
                                  <span className={cn("font-mono tabular-nums text-[14px] leading-[20px] font-semibold", cacheToneClass(group.cache_rate))}>
                                    {formatPercent(group.cache_rate)}
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
                                  {formatTimestampShort(group.last_t)}
                                </TableCell>
                              )

                            case "channels":
                              return (
                                <TableCell
                                  key={col.key}
                                  className="text-right font-mono tabular-nums text-[14px] leading-[20px] text-foreground px-3 py-1 whitespace-nowrap cursor-help"
                                  title={channelNamesStr}
                                >
                                  <span className="underline decoration-dotted decoration-muted-foreground/50">
                                    {formatNumber(group.channels)}
                                  </span>
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
            <span>共 {sortedGroups.length} 条记录</span>
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
