import * as React from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  DollarSign,
  Radio,
  Layers,
  Cpu,
  Activity,
  Inbox,
} from "lucide-react"
import {
  formatBeijingClock,
  formatBeijingDate,
  formatCurrency,
  formatNumber,
  formatPercent,
} from "@/lib/formatters"
import { getServerSettings } from "@/lib/settings"
import {
  formatLatency,
  formatTokenCn,
  formatTps,
  latencyP50ToneClass,
  cacheToneClass,
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
import { HealthView } from "@/components/health-view"
import { SiteLogo } from "@/components/site-logo"
import type { ChannelRowData, GroupRowData } from "@/lib/api-types"
import type { DateRange, RangeType } from "@/lib/api"
import { cn } from "@/lib/utils"

export type DetailLevel = "channel" | "group"

const CHANNELS_STORAGE_KEY = "relay-ledger-cols-channels"
const GROUPS_STORAGE_KEY = "relay-ledger-cols-groups"

// 完整 13 列定义：单一全能大表，全部可选且默认展示，表头支持悬浮说明
export const CHANNELS_ALL_COLUMNS: ColumnItem[] = [
  { key: "channel", label: "渠道", locked: true },
  { key: "revenue", label: "售出" },
  { key: "requests", label: "请求数" },
  { key: "tokens", label: "Token" },
  { key: "margin", label: "毛利率" },
  { key: "status", label: "状态" },
  { key: "upstream", label: "上游" },
  { key: "tps", label: "TPS" },
  { key: "cache", label: "缓存" },
  { key: "p50", label: "P50" },
  { key: "p95", label: "P95" },
  { key: "per_1e8", label: "额度/亿T" },
  { key: "last", label: "最后请求" },
]

export const GROUPS_ALL_COLUMNS: ColumnItem[] = [
  { key: "group", label: "分组", locked: true },
  { key: "revenue", label: "售出" },
  { key: "requests", label: "请求数" },
  { key: "tokens", label: "Token" },
  { key: "margin", label: "毛利率" },
  { key: "status", label: "状态" },
  { key: "channels", label: "渠道数" },
  { key: "tps", label: "TPS" },
  { key: "cache", label: "缓存" },
  { key: "p50", label: "P50" },
  { key: "p95", label: "P95" },
  { key: "per_1e8", label: "额度/亿T" },
  { key: "last", label: "最后请求" },
]

const CHANNELS_DEFAULT_KEYS: string[] = CHANNELS_ALL_COLUMNS.map((c) => c.key)
const GROUPS_DEFAULT_KEYS: string[] = GROUPS_ALL_COLUMNS.map((c) => c.key)

// 数值列按内容定宽，名称列吸收剩余空间；窄屏只在表内横滚。
const CHANNELS_COL_PIXELS: Record<string, number> = {
  channel: 208,
  revenue: 96,
  requests: 88,
  tokens: 96,
  margin: 80,
  status: 90,
  upstream: 132,
  tps: 68,
  cache: 76,
  p50: 80,
  p95: 80,
  per_1e8: 100,
  last: 96,
}

const GROUPS_COL_PIXELS: Record<string, number> = {
  group: 208,
  revenue: 96,
  requests: 88,
  tokens: 96,
  margin: 80,
  status: 90,
  channels: 88,
  tps: 68,
  cache: 76,
  p50: 80,
  p95: 80,
  per_1e8: 100,
  last: 96,
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
  margin: (r) => (r.margin_pct ?? r.margin) ?? null,
  status: (r) => (r.margin_status ?? r.status) || "",
}

const GROUP_ACCESSORS: AccessorMap<GroupRowData> = {
  group: (r) => r.group_name || "",
  revenue: (r) => r.revenue ?? null,
  tokens: (r) => r.tokens ?? null,
  per_1e8: (r) => r.top_model?.per_1e8 ?? null,
  tps: (r) => r.tps ?? null,
  requests: (r) => r.requests ?? null,
  cache: (r) => r.cache_rate ?? null,
  p50: (r) => (r.p50 ?? r.latency_p50) ?? null,
  p95: (r) => (r.p95 ?? r.latency_p95) ?? null,
  last: (r) => r.last_t ?? null,
  channels: (r) => r.channels ?? null,
  margin: (r) => (r.margin_pct ?? r.margin) ?? null,
  status: (r) => r.status || "",
}

/** 格式化紧凑时间：日期在上、时间在下，节省水平宽度 */
function formatTwoLineTime(ms: number | null | undefined): React.ReactNode {
  if (!ms) return <span className="text-muted-foreground">—</span>
  const dateStr = formatBeijingDate(ms)
  const timeStr = formatBeijingClock(ms)
  return (
    <div className="flex flex-col items-start leading-[14px] text-right">
      <span className="text-[12px] text-muted-foreground font-mono">{dateStr}</span>
      <span className="text-[12px] text-foreground font-mono tabular-nums">{timeStr}</span>
    </div>
  )
}

/** 本地选列持久化：读取存储配置，过滤合法列，空数据兜底默认全列，并强制锁定首列名称 */
function loadVisibleKeys(
  storageKey: string,
  allColumns: ColumnItem[],
  defaultKeys: string[],
  lockedKey: string
): string[] {
  if (typeof window === "undefined") return defaultKeys
  try {
    const saved = localStorage.getItem(storageKey)
    if (saved) {
      const parsed = JSON.parse(saved)
      let rawList: string[] = []
      if (Array.isArray(parsed)) {
        rawList = parsed
      } else if (parsed && typeof parsed === "object") {
        if (Array.isArray(parsed.all)) {
          rawList = parsed.all
        } else if (Array.isArray(parsed.biz)) {
          rawList = parsed.biz
        } else {
          const firstArr = Object.values(parsed).find((v): v is string[] => Array.isArray(v))
          if (firstArr) rawList = firstArr
        }
      }

      const validKeys = allColumns.map((c) => c.key)
      const filtered = rawList.filter((k) => typeof k === "string" && validKeys.includes(k))
      // 若存储为空或被损坏过滤后无有效列，先兜底返回默认全部列
      if (filtered.length === 0) return defaultKeys
      // 保证锁定名称列位于首位
      if (!filtered.includes(lockedKey)) {
        filtered.unshift(lockedKey)
      }
      return filtered
    }
  } catch {
    // 降级使用默认全列
  }
  return defaultKeys
}

/** 毛利率沿用正绿、负红、零中性的色彩。 */
function renderCompactMargin(value: number | null | undefined): React.ReactNode {
  if (value == null || isNaN(value)) {
    return <span className="text-muted-foreground">—</span>
  }
  const isPositive = value > 0
  const isNegative = value < 0
  return (
    <span
      className={cn(
        "font-mono tabular-nums text-[13px] leading-[18px]",
        isPositive
          ? "text-emerald-600 dark:text-emerald-400 font-medium"
          : isNegative
          ? "text-rose-600 dark:text-rose-400 font-medium"
          : "text-muted-foreground font-medium"
      )}
    >
      {formatPercent(value)}
    </span>
  )
}

function renderUpstreamStatusBadge(status?: string) {
  switch (status) {
    case "complete":
      return (
        <Badge
          variant="outline"
          className="text-[12px] leading-[16px] h-[22px] px-1.5 whitespace-nowrap font-medium text-emerald-600 dark:text-emerald-400 border-emerald-500/30 bg-emerald-500/10"
        >
          已核算
        </Badge>
      )
    case "partial":
      return (
        <Badge
          variant="outline"
          className="text-[12px] leading-[16px] h-[22px] px-1.5 whitespace-nowrap font-medium text-amber-600 dark:text-amber-400 border-amber-500/30 bg-amber-500/10"
        >
          部分
        </Badge>
      )
    case "unavailable":
      return (
        <Badge
          variant="outline"
          className="text-[12px] leading-[16px] h-[22px] px-1.5 whitespace-nowrap font-medium text-muted-foreground border-border bg-muted/30"
        >
          待快照
        </Badge>
      )
    case "unconfigured":
      return (
        <Badge
          variant="outline"
          className="text-[12px] leading-[16px] h-[22px] px-1.5 whitespace-nowrap font-medium text-muted-foreground border-border bg-muted/30"
        >
          未配置
        </Badge>
      )
    case "disabled_account":
      return (
        <Badge
          variant="outline"
          className="text-[12px] leading-[16px] h-[22px] px-1.5 whitespace-nowrap font-medium text-muted-foreground border-border bg-muted/30"
        >
          已停用
        </Badge>
      )
    default:
      return (
        <Badge
          variant="outline"
          className="text-[12px] leading-[16px] h-[22px] px-1.5 whitespace-nowrap font-medium"
        >
          {status || "未映射"}
        </Badge>
      )
  }
}

export interface DetailsViewProps {
  timeRange: RangeType
  channels: ChannelRowData[]
  groups: GroupRowData[]
  dateRange?: DateRange | null
  initialLevel?: DetailLevel
  fixedLevel?: DetailLevel
  onLevelChange?: (level: DetailLevel) => void
}

export function DetailsView({
  timeRange,
  channels,
  groups,
  dateRange,
  initialLevel = "channel",
  fixedLevel,
  onLevelChange,
}: DetailsViewProps) {
  const [internalLevel, setInternalLevel] = React.useState<DetailLevel>(fixedLevel ?? initialLevel)
  const level: DetailLevel = fixedLevel ?? internalLevel

  const [prevInitialLevel, setPrevInitialLevel] = React.useState(initialLevel)
  if (prevInitialLevel !== initialLevel && !fixedLevel) {
    setPrevInitialLevel(initialLevel)
    setInternalLevel(initialLevel)
  }

  const handleLevelChange = (newLevel: DetailLevel) => {
    if (fixedLevel) return
    setInternalLevel(newLevel)
    onLevelChange?.(newLevel)
  }

  const [channelsVisibleKeys, setChannelsVisibleKeys] = React.useState<string[]>(
    () => loadVisibleKeys(CHANNELS_STORAGE_KEY, CHANNELS_ALL_COLUMNS, CHANNELS_DEFAULT_KEYS, "channel")
  )
  const [channelsSortState, setChannelsSortState] = React.useState<SortState | null>(null)

  const [groupsVisibleKeys, setGroupsVisibleKeys] = React.useState<string[]>(
    () => loadVisibleKeys(GROUPS_STORAGE_KEY, GROUPS_ALL_COLUMNS, GROUPS_DEFAULT_KEYS, "group")
  )
  const [groupsSortState, setGroupsSortState] = React.useState<SortState | null>(null)

  const [prevTimeRange, setPrevTimeRange] = React.useState(timeRange)
  if (prevTimeRange !== timeRange) {
    setPrevTimeRange(timeRange)
    setChannelsSortState(null)
    setGroupsSortState(null)
  }

  const activeChannelKeys = channelsVisibleKeys
  const activeGroupKeys = groupsVisibleKeys

  const effectiveChannelsSort = React.useMemo(() => {
    if (!channelsSortState) return null
    return activeChannelKeys.includes(channelsSortState.key) ? channelsSortState : null
  }, [channelsSortState, activeChannelKeys])

  const effectiveGroupsSort = React.useMemo(() => {
    if (!groupsSortState) return null
    return activeGroupKeys.includes(groupsSortState.key) ? groupsSortState : null
  }, [groupsSortState, activeGroupKeys])

  const handleChannelsSort = React.useCallback(
    (key: string) => {
      setChannelsSortState(() => nextSort(effectiveChannelsSort, key))
    },
    [effectiveChannelsSort]
  )

  const handleGroupsSort = React.useCallback(
    (key: string) => {
      setGroupsSortState(() => nextSort(effectiveGroupsSort, key))
    },
    [effectiveGroupsSort]
  )

  const toggleChannelsColumn = React.useCallback(
    (key: string) => {
      if (key === "channel") return
      setChannelsVisibleKeys((prev) => {
        const nextKeys = prev.includes(key)
          ? prev.filter((k) => k !== key)
          : [...prev, key]
        try {
          localStorage.setItem(CHANNELS_STORAGE_KEY, JSON.stringify(nextKeys))
        } catch {
          // ignore
        }
        return nextKeys
      })
    },
    []
  )

  const toggleGroupsColumn = React.useCallback(
    (key: string) => {
      if (key === "group") return
      setGroupsVisibleKeys((prev) => {
        const nextKeys = prev.includes(key)
          ? prev.filter((k) => k !== key)
          : [...prev, key]
        try {
          localStorage.setItem(GROUPS_STORAGE_KEY, JSON.stringify(nextKeys))
        } catch {
          // ignore
        }
        return nextKeys
      })
    },
    []
  )

  const sortedChannels = React.useMemo(() => {
    return sortRows(channels, effectiveChannelsSort, CHANNEL_ACCESSORS)
  }, [channels, effectiveChannelsSort])

  const sortedGroups = React.useMemo(() => {
    return sortRows(groups, effectiveGroupsSort, GROUP_ACCESSORS)
  }, [groups, effectiveGroupsSort])

  // 顶部汇总统计（紧凑型卡片）
  const totals = React.useMemo(() => {
    if (level === "channel") {
      const totalRev = sortedChannels.reduce((sum, r) => sum + (r.revenue ?? 0), 0)
      const totalTok = sortedChannels.reduce((sum, r) => sum + (r.tokens ?? r.tokens_total ?? 0), 0)
      const totalReq = sortedChannels.reduce((sum, r) => sum + (r.requests ?? 0), 0)
      const avgCache =
        sortedChannels.length > 0
          ? sortedChannels.reduce((sum, r) => sum + (r.cache_rate ?? 0), 0) / sortedChannels.length
          : 0
      return {
        revenue: totalRev,
        count: sortedChannels.length,
        countLabel: "在售渠道",
        tokens: totalTok,
        requests: totalReq,
        cacheRate: avgCache,
      }
    } else {
      const totalRev = sortedGroups.reduce((sum, g) => sum + (g.revenue ?? 0), 0)
      const totalTok = sortedGroups.reduce((sum, g) => sum + (g.tokens ?? 0), 0)
      const totalReq = sortedGroups.reduce((sum, g) => sum + (g.requests ?? 0), 0)
      const avgCache =
        sortedGroups.length > 0
          ? sortedGroups.reduce((sum, g) => sum + (g.cache_rate ?? 0), 0) / sortedGroups.length
          : 0
      return {
        revenue: totalRev,
        count: sortedGroups.length,
        countLabel: "在用分组",
        tokens: totalTok,
        requests: totalReq,
        cacheRate: avgCache,
      }
    }
  }, [level, sortedChannels, sortedGroups])

  const visibleCols =
    level === "channel"
      ? CHANNELS_ALL_COLUMNS.filter((c) => activeChannelKeys.includes(c.key))
      : GROUPS_ALL_COLUMNS.filter((c) => activeGroupKeys.includes(c.key))

  const colPixels = level === "channel" ? CHANNELS_COL_PIXELS : GROUPS_COL_PIXELS
  const totalMinPx = React.useMemo(() => {
    return visibleCols.reduce((acc, c) => acc + (colPixels[c.key] ?? 80), 0)
  }, [visibleCols, colPixels])

  const activeSortState = level === "channel" ? effectiveChannelsSort : effectiveGroupsSort
  const pageTitle = fixedLevel === "channel" ? "渠道明细" : fixedLevel === "group" ? "分组明细" : "经营明细"

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-2 overflow-y-auto pr-1">
      {/* 1. 顶部紧凑汇总指标行 */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-2 shrink-0">
        <Card className="shadow-xs min-w-0 gap-0 p-3.5 flex flex-col">
          <div className="flex items-center justify-between text-muted-foreground leading-none">
            <span className="text-[12px] font-medium text-muted-foreground">售出总计</span>
            <DollarSign className="size-3.5 text-muted-foreground" />
          </div>
          <div className="mt-3 flex items-baseline gap-2 leading-none">
            <span className="text-[20px] font-semibold font-mono tabular-nums text-foreground">
              {formatCurrency(totals.revenue)}
            </span>
          </div>
        </Card>

        <Card className="shadow-xs min-w-0 gap-0 p-3.5 flex flex-col">
          <div className="flex items-center justify-between text-muted-foreground leading-none">
            <span className="text-[12px] font-medium text-muted-foreground">
              {totals.countLabel}
            </span>
            {level === "channel" ? (
              <Radio className="size-3.5 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <Layers className="size-3.5 text-emerald-600 dark:text-emerald-400" />
            )}
          </div>
          <div className="mt-3 flex items-baseline gap-2 leading-none">
            <span className="text-[20px] font-semibold font-mono tabular-nums text-foreground">
              {totals.count} <span className="text-[12px] font-normal font-sans text-muted-foreground">个</span>
            </span>
          </div>
        </Card>

        <Card className="shadow-xs min-w-0 gap-0 p-3.5 flex flex-col">
          <div className="flex items-center justify-between text-muted-foreground leading-none">
            <span className="text-[12px] font-medium text-muted-foreground">消耗 Token</span>
            <Cpu className="size-3.5 text-indigo-500" />
          </div>
          <div className="mt-3 flex items-baseline gap-2 leading-none">
            <span className="text-[20px] font-semibold font-mono tabular-nums text-foreground" title={totals.tokens.toLocaleString("zh-CN")}>
              {formatTokenCn(totals.tokens)}
            </span>
          </div>
        </Card>

        <Card className="shadow-xs min-w-0 gap-0 p-3.5 flex flex-col">
          <div className="flex items-center justify-between text-muted-foreground leading-none">
            <span className="text-[12px] font-medium text-muted-foreground">请求总量</span>
            <Activity className="size-3.5 text-amber-500" />
          </div>
          <div className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1 leading-none">
            <span className="text-[20px] font-semibold font-mono tabular-nums text-foreground">
              {formatNumber(totals.requests)} <span className="text-[12px] font-normal font-sans text-muted-foreground">次</span>
            </span>
            <span className="text-[12px] text-muted-foreground truncate">
              缓存 {formatPercent(totals.cacheRate)}
            </span>
          </div>
        </Card>
      </section>

      {/* 2. 统一明细大表卡片：显式 gap-0 清除卡片默认间距，使标题紧贴表头；行高 32px */}
      <Card
        data-slot="detail-card"
        className="shadow-xs overflow-hidden flex flex-col min-w-0 p-3 pb-2.5 gap-0 shrink-0"
      >
        <CardHeader className="p-0 pb-1.5 flex flex-row items-center justify-between space-y-0 shrink-0 gap-3 flex-wrap">
          <div className="flex items-center gap-2.5 flex-wrap">
            <CardTitle className="text-[15px] leading-[22px] font-medium text-foreground">
              {pageTitle}
            </CardTitle>

            {!fixedLevel && (
              <ToggleGroup
                value={[level]}
                onValueChange={(vals) => {
                  const val = vals?.[0]
                  if (val === "channel" || val === "group") {
                    handleLevelChange(val)
                  }
                }}
                variant="outline"
                size="sm"
                className="shrink-0"
              >
                <ToggleGroupItem
                  value="channel"
                  className="text-[12px] leading-[16px] px-2.5 h-6.5 font-medium cursor-pointer"
                >
                  渠道
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="group"
                  className="text-[12px] leading-[16px] px-2.5 h-6.5 font-medium cursor-pointer"
                >
                  分组
                </ToggleGroupItem>
              </ToggleGroup>
            )}

            <Badge variant="secondary" className="text-[12px] leading-[16px] h-5 px-1.5 font-medium tabular-nums">
              {level === "channel" ? `${sortedChannels.length} 个渠道` : `${sortedGroups.length} 个分组`}
            </Badge>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <ColPicker
              columns={level === "channel" ? CHANNELS_ALL_COLUMNS : GROUPS_ALL_COLUMNS}
              visibleKeys={visibleCols.map((c) => c.key)}
              onToggleColumn={level === "channel" ? toggleChannelsColumn : toggleGroupsColumn}
            />
          </div>
        </CardHeader>

        <CardContent className="p-0 flex flex-col">
          <div className="rounded-lg border border-border bg-card overflow-hidden [&_[data-slot=table-container]]:h-[clamp(180px,calc((100dvh-320px)/2),420px)] [&_[data-slot=table-container]]:overflow-y-auto max-md:[&_[data-slot=table-container]]:h-auto max-md:[&_[data-slot=table-container]]:max-h-none">
            <Table className="table-fixed text-sm [--name-column-width:144px] sm:[--name-column-width:208px]" style={{ width: "100%", minWidth: `calc(${totalMinPx - 208}px + var(--name-column-width))` }}>
              <colgroup>
                {visibleCols.map((col) => (
                  <col key={col.key} style={col.key === "channel" || col.key === "group" ? undefined : { width: `${colPixels[col.key]}px` }} />
                ))}
              </colgroup>
              <TableHeader className="bg-muted/50 sticky top-0 z-20 backdrop-blur-xs">
                <TableRow className="hover:bg-transparent border-b border-border h-8">
                  {visibleCols.map((col) => {
                    const isLocked = col.key === "channel" || col.key === "group"
                    const isNum = [
                      "revenue",
                      "tokens",
                      "per_1e8",
                      "tps",
                      "requests",
                      "cache",
                      "p50",
                      "p95",
                      "margin",
                      "channels",
                    ].includes(col.key)
                    const sortAttrs = getSortHeaderAttrs(activeSortState, col.key)

                    return (
                      <TableHead
                        key={col.key}
                        aria-sort={sortAttrs.ariaSort}
                        onClick={() =>
                          level === "channel" ? handleChannelsSort(col.key) : handleGroupsSort(col.key)
                        }
                        className={cn(
                          "h-8 px-2 text-[12px] leading-[16px] font-medium text-muted-foreground whitespace-nowrap select-none cursor-pointer transition-colors group/th hover:bg-muted/80",
                          isNum ? "text-right" : "text-left",
                          isLocked && "sticky left-0 bg-muted z-30 border-r border-border shadow-[1px_0_0_0_var(--border)]",
                          sortAttrs.isActive && "text-foreground font-semibold"
                        )}
                        title={
                          col.key === "per_1e8"
                            ? "该主体售出额最高模型的每 1 亿 Token 售出额"
                            : col.key === "tps"
                            ? "输出 token / 秒（区间累计输出 token ÷ 累计请求耗时）"
                            : col.key === "margin"
                            ? "毛利率（区间售出与成本比率）"
                            : undefined
                        }
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
                {level === "channel" ? (
                  sortedChannels.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={visibleCols.length} className="h-32 text-center text-muted-foreground">
                        <div className="flex flex-col items-center justify-center text-muted-foreground gap-1.5 py-4">
                          <Inbox className="size-5 opacity-40" />
                          <span className="text-[13px]">暂无渠道明细数据</span>
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : (
                    sortedChannels.map((row) => (
                      <TableRow key={row.channel_id} className="h-8 hover:bg-muted/40 transition-colors border-b border-border/60">
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
                            "margin",
                          ].includes(col.key)

                          let content: React.ReactNode = null

                          switch (col.key) {
                            case "channel":
                              content = (
                                <div className="flex items-center gap-1.5 min-w-0">
                                  <SiteLogo kind="channel" id={row.channel_id} label={row.channel_name} size={16} />
                                  <span className="font-mono text-[12px] text-muted-foreground shrink-0">
                                    #{row.channel_id}
                                  </span>
                                  <span className="font-medium text-[13px] leading-[18px] text-foreground truncate" title={row.channel_name}>
                                    {row.channel_name || "未命名渠道"}
                                  </span>
                                </div>
                              )
                              break
                            case "revenue":
                              content =
                                row.revenue == null || isNaN(row.revenue) ? (
                                  <span className="text-muted-foreground">—</span>
                                ) : (
                                  <span className="font-mono tabular-nums text-[13px] leading-[18px] font-semibold text-foreground">
                                    {formatCurrency(row.revenue)}
                                  </span>
                                )
                              break
                            case "requests":
                              content = formatNumber(row.requests)
                              break
                            case "tokens":
                              content = formatTokenCn(row.tokens ?? row.tokens_total)
                              break
                            case "margin":
                              content = renderCompactMargin(row.margin_pct ?? row.margin)
                              break
                            case "status":
                              content = renderUpstreamStatusBadge(row.margin_status)
                              break
                            case "upstream":
                              content = (
                                <span className="text-muted-foreground truncate block max-w-[100px] text-[12px]" title={row.upstream_account || undefined}>
                                  {row.upstream_account || "—"}
                                </span>
                              )
                              break
                            case "tps":
                              content = row.archive_only ? (
                                <span className="text-muted-foreground" title="归档数据不计算实时 TPS">
                                  —
                                </span>
                              ) : (
                                formatTps(row.tps)
                              )
                              break
                            case "cache": {
                              const thresholds = getServerSettings().monitoring.cacheRate
                              content =
                                row.cache_rate != null && !isNaN(row.cache_rate) ? (
                                  <span className={cn("text-[13px] leading-[18px] font-mono tabular-nums", cacheToneClass(row.cache_rate, thresholds))}>
                                    {formatPercent(row.cache_rate)}
                                  </span>
                                ) : (
                                  <span className="text-muted-foreground">—</span>
                                )
                              break
                            }
                            case "p50":
                              content = (
                                <span className={latencyP50ToneClass(row.p50 ?? row.latency_p50)}>
                                  {formatLatency(row.p50 ?? row.latency_p50)}
                                </span>
                              )
                              break
                            case "p95": {
                              const val = row.p95 ?? row.latency_p95
                              const thresholds = getServerSettings().monitoring.latencyP95
                              content =
                                val != null && !isNaN(val) && val >= 0 ? (
                                  <span className={cn("text-[13px] leading-[18px] font-mono tabular-nums", latencyP95ToneClass(val, thresholds))}>
                                    {formatLatency(val)}
                                  </span>
                                ) : (
                                  <span className="text-muted-foreground">—</span>
                                )
                              break
                            }
                            case "per_1e8":
                              content = row.top_model?.per_1e8 != null ? (
                                <span className="font-mono tabular-nums text-[13px] leading-[18px]" title={row.top_model.model}>
                                  {formatCurrency(row.top_model.per_1e8)}
                                </span>
                              ) : (
                                "—"
                              )
                              break
                            case "last":
                              content = formatTwoLineTime(row.last_t)
                              break
                          }

                          return (
                            <TableCell
                              key={col.key}
                              className={cn(
                                "px-2 py-0 h-8 align-middle text-[13px] leading-[18px] font-mono tabular-nums whitespace-nowrap",
                                isNum ? "text-right" : "text-left",
                                isLocked && "sticky left-0 bg-card z-10 border-r border-border shadow-[1px_0_0_0_var(--border)]"
                              )}
                            >
                              {content}
                            </TableCell>
                          )
                        })}
                      </TableRow>
                    ))
                  )
                ) : sortedGroups.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={visibleCols.length} className="h-32 text-center text-muted-foreground">
                      <div className="flex flex-col items-center justify-center text-muted-foreground gap-1.5 py-4">
                        <Inbox className="size-5 opacity-40" />
                        <span className="text-[13px]">暂无分组明细数据</span>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  sortedGroups.map((group) => (
                    <TableRow key={group.group_name} className="h-8 hover:bg-muted/40 transition-colors border-b border-border/60">
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
                          "margin",
                          "channels",
                        ].includes(col.key)

                        let content: React.ReactNode = null

                        switch (col.key) {
                          case "group":
                            content = (
                              <div className="flex items-center gap-1.5 min-w-0">
                                <span className="font-medium text-[13px] leading-[18px] text-foreground truncate" title={group.group_name || "未分组"}>
                                  {group.group_name || "未分组"}
                                </span>
                              </div>
                            )
                            break
                          case "revenue":
                            content =
                              group.revenue == null || isNaN(group.revenue) ? (
                                <span className="text-muted-foreground">—</span>
                              ) : (
                                <span className="font-mono tabular-nums text-[13px] leading-[18px] font-semibold text-foreground">
                                  {formatCurrency(group.revenue)}
                                </span>
                              )
                            break
                          case "requests":
                            content = formatNumber(group.requests)
                            break
                          case "tokens":
                            content = formatTokenCn(group.tokens)
                            break
                          case "margin":
                            content = renderCompactMargin(group.margin_pct ?? group.margin)
                            break
                          case "status":
                            content = group.status ? renderUpstreamStatusBadge(group.status) : <span className="text-muted-foreground">—</span>
                            break
                          case "channels":
                            content = (
                              <span className="font-mono tabular-nums text-[13px] leading-[18px]">
                                {group.channels ?? 0}{" "}
                                <span className="text-[12px] font-sans text-muted-foreground">个</span>
                              </span>
                            )
                            break
                          case "tps":
                            content = formatTps(group.tps)
                            break
                          case "cache": {
                            const thresholds = getServerSettings().monitoring.cacheRate
                            content =
                              group.cache_rate != null && !isNaN(group.cache_rate) ? (
                                <span className={cn("text-[13px] leading-[18px] font-mono tabular-nums", cacheToneClass(group.cache_rate, thresholds))}>
                                  {formatPercent(group.cache_rate)}
                                </span>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )
                            break
                          }
                          case "p50":
                            content = (
                              <span className={latencyP50ToneClass(group.p50 ?? group.latency_p50)}>
                                {formatLatency(group.p50 ?? group.latency_p50)}
                              </span>
                            )
                            break
                          case "p95": {
                            const val = group.p95 ?? group.latency_p95
                            const thresholds = getServerSettings().monitoring.latencyP95
                            content =
                              val != null && !isNaN(val) && val >= 0 ? (
                                <span className={cn("text-[13px] leading-[18px] font-mono tabular-nums", latencyP95ToneClass(val, thresholds))}>
                                  {formatLatency(val)}
                                </span>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )
                            break
                          }
                          case "per_1e8":
                            content = group.top_model?.per_1e8 != null ? (
                              <span className="font-mono tabular-nums text-[13px] leading-[18px]" title={group.top_model.model}>
                                {formatCurrency(group.top_model.per_1e8)}
                              </span>
                            ) : (
                              "—"
                            )
                            break
                          case "last":
                            content = formatTwoLineTime(group.last_t)
                            break
                        }

                        return (
                          <TableCell
                            key={col.key}
                            className={cn(
                              "px-2 py-0 h-8 align-middle text-[13px] leading-[18px] font-mono tabular-nums whitespace-nowrap",
                              isNum ? "text-right" : "text-left",
                              isLocked && "sticky left-0 bg-card z-10 border-r border-border shadow-[1px_0_0_0_var(--border)]"
                            )}
                          >
                            {content}
                          </TableCell>
                        )
                      })}
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* 3. 明细卡片下方：对应维度的健康卡，状态矩阵与统计使用所选时间范围。 */}
      <HealthView
        timeRange={timeRange}
        dateRange={dateRange ?? null}
        embedded
        fixedLevel={level}
      />
    </div>
  )
}
