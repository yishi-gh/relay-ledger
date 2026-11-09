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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { DollarSign, Radio, Layers, Cpu, Activity, Inbox } from "lucide-react"
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
  latencyP50ToneClass,
} from "@/components/table-utils"
import {
  RevenueCell,
  CacheRateCell,
  LatencyP95Cell,
  MarginCell,
} from "@/components/table-visualizers"
import {
  type SortState,
  type AccessorMap,
  nextSort,
  sortRows,
  getSortHeaderAttrs,
} from "@/lib/table-sort"
import { ColPicker, type ColumnItem } from "@/components/col-picker"
import type { ChannelRowData } from "@/components/channels-rank-view"
import type { GroupRowData } from "@/components/groups-rank-view"
import { cn } from "@/lib/utils"

export type DetailLevel = "channel" | "group"
export type ViewMode = "biz" | "perf" | "all"

const CHANNELS_STORAGE_PREFIX = "relay-ledger-cols-channels"
const GROUPS_STORAGE_PREFIX = "relay-ledger-cols-groups"

export const CHANNELS_ALL_COLUMNS: ColumnItem[] = [
  { key: "channel", label: "渠道", locked: true, group: "biz" },
  { key: "revenue", label: "售出", group: "biz" },
  { key: "requests", label: "请求数", group: "biz" },
  { key: "margin", label: "毛利率", group: "biz" },
  { key: "status", label: "状态", group: "biz" },
  { key: "upstream", label: "上游账户", group: "biz" },
  { key: "tokens", label: "TOKEN", group: "biz" },
  { key: "tps", label: "TPS", group: "perf" },
  { key: "cache", label: "缓存率", group: "perf" },
  { key: "p50", label: "P50", group: "perf" },
  { key: "p95", label: "P95", group: "perf" },
  { key: "per_1e8", label: "额度/亿TOKEN", group: "perf" },
  { key: "last", label: "最后请求", group: "perf" },
]

export const GROUPS_ALL_COLUMNS: ColumnItem[] = [
  { key: "group", label: "分组", locked: true, group: "biz" },
  { key: "revenue", label: "售出", group: "biz" },
  { key: "requests", label: "请求数", group: "biz" },
  { key: "margin", label: "毛利率", group: "biz" },
  { key: "status", label: "状态", group: "biz" },
  { key: "channels", label: "渠道数", group: "biz" },
  { key: "tokens", label: "TOKEN", group: "biz" },
  { key: "tps", label: "TPS", group: "perf" },
  { key: "cache", label: "缓存率", group: "perf" },
  { key: "p50", label: "P50", group: "perf" },
  { key: "p95", label: "P95", group: "perf" },
  { key: "per_1e8", label: "额度/亿TOKEN", group: "perf" },
  { key: "last", label: "最后请求", group: "perf" },
]

const CHANNELS_DEFAULT_KEYS: Record<ViewMode, string[]> = {
  biz: ["channel", "revenue", "requests", "margin", "status", "upstream"],
  perf: ["channel", "tps", "cache", "p50", "p95", "per_1e8", "last"],
  all: [
    "channel",
    "revenue",
    "tokens",
    "per_1e8",
    "tps",
    "requests",
    "cache",
    "p50",
    "p95",
    "last",
    "upstream",
  ],
}

const GROUPS_DEFAULT_KEYS: Record<ViewMode, string[]> = {
  biz: ["group", "revenue", "requests", "margin", "status", "channels"],
  perf: ["group", "tps", "cache", "p50", "p95", "per_1e8", "last"],
  all: [
    "group",
    "revenue",
    "tokens",
    "per_1e8",
    "tps",
    "requests",
    "cache",
    "p50",
    "p95",
    "last",
    "channels",
  ],
}

const CHANNELS_COL_WEIGHTS: Record<string, number> = {
  channel: 22,
  revenue: 16,
  requests: 12,
  margin: 14,
  status: 11,
  upstream: 15,
  tokens: 12,
  tps: 11,
  cache: 13,
  p50: 11,
  p95: 13,
  per_1e8: 13,
  last: 12,
}

const GROUPS_COL_WEIGHTS: Record<string, number> = {
  group: 22,
  revenue: 16,
  requests: 12,
  margin: 14,
  status: 11,
  channels: 14,
  tokens: 12,
  tps: 11,
  cache: 13,
  p50: 11,
  p95: 13,
  per_1e8: 13,
  last: 12,
}

function computeColWidths(
  visibleKeys: string[],
  weightsMap: Record<string, number>
): Record<string, string> {
  const total = visibleKeys.reduce((acc, k) => acc + (weightsMap[k] ?? 12), 0)
  const result: Record<string, string> = {}
  visibleKeys.forEach((k) => {
    const w = weightsMap[k] ?? 12
    result[k] = `${((w / (total || 1)) * 100).toFixed(2)}%`
  })
  return result
}

const CHANNEL_ACCESSORS: AccessorMap<ChannelRowData> = {
  channel: (r) => r.channel_name || "",
  revenue: (r) => r.revenue ?? null,
  requests: (r) => r.requests ?? null,
  margin: (r) => (r.margin_pct ?? r.margin) ?? null,
  status: (r) => r.margin_status ?? "",
  upstream: (r) => r.upstream_account || "",
  tokens: (r) => (r.tokens ?? r.tokens_total) ?? null,
  tps: (r) => (r.archive_only ? null : r.tps ?? null),
  cache: (r) => r.cache_rate ?? null,
  p50: (r) => (r.p50 ?? r.latency_p50) ?? null,
  p95: (r) => (r.p95 ?? r.latency_p95) ?? null,
  per_1e8: (r) => r.top_model?.per_1e8 ?? null,
  last: (r) => r.last_t ?? null,
}

const GROUP_ACCESSORS: AccessorMap<GroupRowData> = {
  group: (g) => g.group_name || "",
  revenue: (g) => g.revenue ?? null,
  requests: (g) => g.requests ?? null,
  margin: (g) => (g.margin_pct ?? g.margin) ?? null,
  status: (g) => g.status ?? "",
  channels: (g) => g.channels ?? null,
  tokens: (g) => g.tokens ?? null,
  tps: (g) => g.tps ?? null,
  cache: (g) => g.cache_rate ?? null,
  p50: (g) => (g.p50 ?? g.latency_p50) ?? null,
  p95: (g) => (g.p95 ?? g.latency_p95) ?? null,
  per_1e8: (g) => g.top_model?.per_1e8 ?? null,
  last: (g) => g.last_t ?? null,
}

function loadVisibleMap(
  prefix: string,
  defaults: Record<ViewMode, string[]>
): Record<ViewMode, string[]> {
  if (typeof window === "undefined") return defaults
  try {
    const saved = localStorage.getItem(prefix)
    if (saved) {
      const parsed = JSON.parse(saved)
      if (parsed && typeof parsed === "object") {
        return {
          biz: Array.isArray(parsed.biz) && parsed.biz.length > 0 ? parsed.biz : defaults.biz,
          perf: Array.isArray(parsed.perf) && parsed.perf.length > 0 ? parsed.perf : defaults.perf,
          all: Array.isArray(parsed.all) && parsed.all.length > 0 ? parsed.all : defaults.all,
        }
      }
    }
  } catch {
    // fallback
  }
  return defaults
}

function renderUpstreamStatusBadge(status?: string | null) {
  if (!status) {
    return <span className="text-muted-foreground">—</span>
  }
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
          {status}
        </Badge>
      )
  }
}

interface DetailsViewProps {
  timeRange: "24h" | "7d"
  channels: ChannelRowData[]
  groups: GroupRowData[]
  initialLevel?: DetailLevel
  onLevelChange?: (level: DetailLevel) => void
}

export function DetailsView({
  timeRange,
  channels,
  groups,
  initialLevel = "channel",
  onLevelChange,
}: DetailsViewProps) {
  const [level, setLevel] = React.useState<DetailLevel>(initialLevel)
  const [viewMode, setViewMode] = React.useState<ViewMode>("biz")

  // 同步外部 initialLevel 变更
  const [prevInitialLevel, setPrevInitialLevel] = React.useState(initialLevel)
  if (prevInitialLevel !== initialLevel) {
    setPrevInitialLevel(initialLevel)
    setLevel(initialLevel)
  }

  const handleLevelChange = (newLevel: DetailLevel) => {
    setLevel(newLevel)
    onLevelChange?.(newLevel)
  }

  // 渠道可见列按 viewMode 映射
  const [channelsVisibleMap, setChannelsVisibleMap] = React.useState<Record<ViewMode, string[]>>(
    () => loadVisibleMap(CHANNELS_STORAGE_PREFIX, CHANNELS_DEFAULT_KEYS)
  )
  const [channelsSortState, setChannelsSortState] = React.useState<SortState | null>(null)

  // 分组可见列按 viewMode 映射
  const [groupsVisibleMap, setGroupsVisibleMap] = React.useState<Record<ViewMode, string[]>>(
    () => loadVisibleMap(GROUPS_STORAGE_PREFIX, GROUPS_DEFAULT_KEYS)
  )
  const [groupsSortState, setGroupsSortState] = React.useState<SortState | null>(null)

  // 切换窗口口径时重置排序
  const [prevTimeRange, setPrevTimeRange] = React.useState(timeRange)
  if (prevTimeRange !== timeRange) {
    setPrevTimeRange(timeRange)
    setChannelsSortState(null)
    setGroupsSortState(null)
  }

  // 当前激活的可见列
  const activeChannelKeys = channelsVisibleMap[viewMode] || CHANNELS_DEFAULT_KEYS[viewMode]
  const activeGroupKeys = groupsVisibleMap[viewMode] || GROUPS_DEFAULT_KEYS[viewMode]

  // 切视图保留排序键（若该列在新视图不可见则回落到默认）
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
      setChannelsVisibleMap((prev) => {
        const curKeys = prev[viewMode] || CHANNELS_DEFAULT_KEYS[viewMode]
        const nextKeys = curKeys.includes(key)
          ? curKeys.filter((k) => k !== key)
          : [...curKeys, key]
        const nextMap = { ...prev, [viewMode]: nextKeys }
        try {
          localStorage.setItem(CHANNELS_STORAGE_PREFIX, JSON.stringify(nextMap))
        } catch {
          // ignore
        }
        return nextMap
      })
    },
    [viewMode]
  )

  const toggleGroupsColumn = React.useCallback(
    (key: string) => {
      if (key === "group") return
      setGroupsVisibleMap((prev) => {
        const curKeys = prev[viewMode] || GROUPS_DEFAULT_KEYS[viewMode]
        const nextKeys = curKeys.includes(key)
          ? curKeys.filter((k) => k !== key)
          : [...curKeys, key]
        const nextMap = { ...prev, [viewMode]: nextKeys }
        try {
          localStorage.setItem(GROUPS_STORAGE_PREFIX, JSON.stringify(nextMap))
        } catch {
          // ignore
        }
        return nextMap
      })
    },
    [viewMode]
  )

  // 排序行数据
  const sortedChannels = React.useMemo(() => {
    return sortRows(channels, effectiveChannelsSort, CHANNEL_ACCESSORS)
  }, [channels, effectiveChannelsSort])

  const sortedGroups = React.useMemo(() => {
    return sortRows(groups, effectiveGroupsSort, GROUP_ACCESSORS)
  }, [groups, effectiveGroupsSort])

  // 售出最大值与 Top1（用于归一化细横条）
  const maxChannelRevenue = React.useMemo(() => {
    return Math.max(...channels.map((r) => r.revenue ?? 0), 0.0001)
  }, [channels])

  const top1ChannelId = React.useMemo(() => {
    if (channels.length === 0) return null
    let max = -1
    let id: number | null = null
    for (const r of channels) {
      if ((r.revenue ?? 0) > max) {
        max = r.revenue ?? 0
        id = r.channel_id
      }
    }
    return id
  }, [channels])

  const maxGroupRevenue = React.useMemo(() => {
    return Math.max(...groups.map((g) => g.revenue ?? 0), 0.0001)
  }, [groups])

  const top1GroupName = React.useMemo(() => {
    if (groups.length === 0) return null
    let max = -1
    let name: string | null = null
    for (const g of groups) {
      if ((g.revenue ?? 0) > max) {
        max = g.revenue ?? 0
        name = g.group_name
      }
    }
    return name
  }, [groups])

  // 汇总统计指标
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
        countLabel: "在售渠道数",
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
        countLabel: "在用分组数",
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

  const colWidths = React.useMemo(() => {
    const keys = visibleCols.map((c) => c.key)
    const weights = level === "channel" ? CHANNELS_COL_WEIGHTS : GROUPS_COL_WEIGHTS
    return computeColWidths(keys, weights)
  }, [visibleCols, level])

  const isScrollable = (level === "channel" ? sortedChannels.length : sortedGroups.length) > 12
  const activeSortState = level === "channel" ? effectiveChannelsSort : effectiveGroupsSort

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
            {timeRange === "24h"
              ? level === "channel"
                ? "近 24 小时渠道售出"
                : "近 24 小时分组售出"
              : level === "channel"
              ? "近 7 天渠道售出"
              : "近 7 天分组售出"}
          </span>
        </Card>

        <Card className="shadow-xs p-3.5 flex flex-col justify-between">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-[14px] leading-[20px] font-normal text-muted-foreground">
              {totals.countLabel}
            </span>
            {level === "channel" ? (
              <Radio className="size-4 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <Layers className="size-4 text-emerald-600 dark:text-emerald-400" />
            )}
          </div>
          <div className="mt-1.5 text-[24px] leading-[28px] font-semibold font-mono tabular-nums text-foreground">
            {totals.count} <span className="text-[14px] font-normal font-sans text-muted-foreground">个</span>
          </div>
          <span className="text-[12px] leading-[16px] text-muted-foreground mt-1">
            {level === "channel" ? "产生调用与计费明细" : "产生调用与计费分组"}
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

      {/* 2. 核心表格卡片 */}
      <Card
        data-slot="detail-card"
        className={cn(
          "shadow-xs overflow-hidden flex flex-col min-w-0 p-4",
          isScrollable ? "lg:flex-1 lg:min-h-0" : "h-fit"
        )}
      >
        <CardHeader className="p-0 pb-3 flex flex-row items-center justify-between space-y-0 shrink-0 gap-3 flex-wrap">
          {/* 左侧：标题 + 层级切换 (渠道/分组) + 视图切换 (经营/性能/全部) + Badge */}
          <div className="flex items-center gap-2.5 flex-wrap">
            <CardTitle className="text-[16px] leading-[24px] font-medium text-foreground">
              经营明细
            </CardTitle>

            {/* 渠道/分组切换 */}
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
                className="text-[12px] leading-[16px] px-2.5 h-7 font-medium cursor-pointer"
              >
                渠道
              </ToggleGroupItem>
              <ToggleGroupItem
                value="group"
                className="text-[12px] leading-[16px] px-2.5 h-7 font-medium cursor-pointer"
              >
                分组
              </ToggleGroupItem>
            </ToggleGroup>

            {/* 经营/性能/全部视图切换 */}
            <ToggleGroup
              value={[viewMode]}
              onValueChange={(vals) => {
                const val = vals?.[0]
                if (val === "biz" || val === "perf" || val === "all") {
                  setViewMode(val)
                }
              }}
              variant="outline"
              size="sm"
              className="shrink-0"
            >
              <ToggleGroupItem
                value="biz"
                className="text-[12px] leading-[16px] px-2.5 h-7 font-medium cursor-pointer data-[state=on]:bg-accent data-[state=on]:text-accent-foreground"
              >
                经营
              </ToggleGroupItem>
              <ToggleGroupItem
                value="perf"
                className="text-[12px] leading-[16px] px-2.5 h-7 font-medium cursor-pointer data-[state=on]:bg-accent data-[state=on]:text-accent-foreground"
              >
                性能
              </ToggleGroupItem>
              <ToggleGroupItem
                value="all"
                className="text-[12px] leading-[16px] px-2.5 h-7 font-medium cursor-pointer data-[state=on]:bg-accent data-[state=on]:text-accent-foreground"
              >
                全部
              </ToggleGroupItem>
            </ToggleGroup>

            <Badge variant="secondary" className="text-[12px] leading-[16px] h-5 px-1.5 font-medium tabular-nums">
              {level === "channel" ? `${sortedChannels.length} 个渠道` : `${sortedGroups.length} 个分组`}
            </Badge>
          </div>

          {/* 右侧：列选择器 */}
          <div className="flex items-center gap-2 shrink-0">
            <ColPicker
              columns={level === "channel" ? CHANNELS_ALL_COLUMNS : GROUPS_ALL_COLUMNS}
              visibleKeys={level === "channel" ? activeChannelKeys : activeGroupKeys}
              onToggleColumn={level === "channel" ? toggleChannelsColumn : toggleGroupsColumn}
            />
          </div>
        </CardHeader>

        <CardContent className={cn("p-0 flex flex-col", isScrollable ? "lg:flex-1 lg:min-h-0" : "")}>
          <div
            className={cn(
              "rounded-lg border border-border bg-card overflow-hidden",
              isScrollable ? "lg:flex-1 lg:min-h-0 flex flex-col" : ""
            )}
          >
            <Table className={cn(
              "text-sm table-auto lg:table-fixed",
              visibleCols.length <= 7 ? "min-w-[700px] lg:min-w-full" : "min-w-[860px] lg:min-w-full"
            )}>
              <colgroup className="hidden lg:table-column-group">
                {visibleCols.map((col) => (
                  <col key={col.key} style={{ width: colWidths[col.key] || "10%" }} />
                ))}
              </colgroup>
              <TableHeader className="bg-muted/50 sticky top-0 z-20 backdrop-blur-xs">
                <TableRow className="hover:bg-transparent border-b border-border h-9">
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
                          "h-9 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground whitespace-nowrap select-none cursor-pointer transition-colors group/th hover:bg-muted/80",
                          isNum ? "text-right" : "text-left",
                          isLocked && "sticky left-0 bg-muted z-30 border-r border-border min-w-[150px] sm:min-w-[180px]",
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
                {level === "channel" ? (
                  sortedChannels.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={visibleCols.length} className="h-40 text-center">
                        <div className="flex flex-col items-center justify-center text-muted-foreground gap-2">
                          <Inbox className="size-6 opacity-40" />
                          <span className="text-[14px]">暂无渠道明细数据</span>
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : (
                    sortedChannels.map((row) => (
                      <TableRow key={row.channel_id} className="h-[44px] hover:bg-muted/50 transition-colors border-b border-border/60">
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
                                <div className="flex items-center gap-2 min-w-0">
                                  <span className="font-mono text-[12px] leading-[16px] text-muted-foreground shrink-0">
                                    #{row.channel_id}
                                  </span>
                                  <span className="font-medium text-[13px] leading-[18px] text-foreground truncate" title={row.channel_name}>
                                    {row.channel_name || "未命名渠道"}
                                  </span>
                                </div>
                              )
                              break
                            case "revenue":
                              content = (
                                <RevenueCell
                                  value={row.revenue}
                                  maxValue={maxChannelRevenue}
                                  isTop1={top1ChannelId === row.channel_id}
                                />
                              )
                              break
                            case "requests":
                              content = formatNumber(row.requests)
                              break
                            case "margin":
                              content = <MarginCell value={row.margin_pct ?? row.margin} />
                              break
                            case "status":
                              content = renderUpstreamStatusBadge(row.margin_status ?? row.status)
                              break
                            case "upstream":
                              // 若当前视图未单独显示 status 列（如全部视图），保留徽标+账户合并展示；若已有独立 status 列则只显示账户名
                              if (!visibleCols.some((c) => c.key === "status")) {
                                content = (
                                  <div className="flex items-center gap-1.5 justify-start min-w-0">
                                    {renderUpstreamStatusBadge(row.margin_status)}
                                    <span className="text-[12px] leading-[16px] text-muted-foreground truncate" title={row.upstream_account ?? undefined}>
                                      {row.upstream_account || "—"}
                                    </span>
                                  </div>
                                )
                              } else {
                                content = (
                                  <span className="text-[13px] leading-[18px] text-muted-foreground truncate block" title={row.upstream_account ?? undefined}>
                                    {row.upstream_account || "—"}
                                  </span>
                                )
                              }
                              break
                            case "tokens":
                              content = formatTokenCn(row.tokens ?? row.tokens_total)
                              break
                            case "tps":
                              content = row.archive_only ? (
                                <span className="text-muted-foreground font-sans text-[12px]">归档</span>
                              ) : (
                                formatTps(row.tps)
                              )
                              break
                            case "cache":
                              content = <CacheRateCell value={row.cache_rate} />
                              break
                            case "p50":
                              content = (
                                <span className={latencyP50ToneClass(row.p50 ?? row.latency_p50)}>
                                  {formatLatency(row.p50 ?? row.latency_p50)}
                                </span>
                              )
                              break
                            case "p95":
                              content = <LatencyP95Cell value={row.p95 ?? row.latency_p95} />
                              break
                            case "per_1e8":
                              content = row.top_model?.per_1e8 != null ? (
                                <span className="font-mono tabular-nums text-[13px] leading-[18px]" title={row.top_model.model}>
                                  ${row.top_model.per_1e8.toFixed(2)}
                                </span>
                              ) : (
                                "—"
                              )
                              break
                            case "last":
                              content = (
                                <span className="text-[12px] leading-[16px] text-muted-foreground font-mono">
                                  {formatTimestampShort(row.last_t)}
                                </span>
                              )
                              break
                          }

                          return (
                            <TableCell
                              key={col.key}
                              className={cn(
                                "px-3 py-0 h-[44px] align-middle text-[13px] leading-[18px] font-mono tabular-nums whitespace-nowrap",
                                isNum ? "text-right" : "text-left",
                                isLocked && "sticky left-0 bg-card z-10 border-r border-border min-w-[150px] sm:min-w-[180px]"
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
                    <TableCell colSpan={visibleCols.length} className="h-40 text-center">
                      <div className="flex flex-col items-center justify-center text-muted-foreground gap-2">
                        <Inbox className="size-6 opacity-40" />
                        <span className="text-[14px]">暂无分组明细数据</span>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  sortedGroups.map((group, index) => (
                    <TableRow key={group.group_name || `ungrouped-${index}`} className="h-[44px] hover:bg-muted/50 transition-colors border-b border-border/60">
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
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="font-medium text-[13px] leading-[18px] text-foreground truncate" title={group.group_name || "未分组"}>
                                  {group.group_name || "未分组"}
                                </span>
                              </div>
                            )
                            break
                          case "revenue":
                            content = (
                              <RevenueCell
                                value={group.revenue}
                                maxValue={maxGroupRevenue}
                                isTop1={top1GroupName === group.group_name}
                              />
                            )
                            break
                          case "requests":
                            content = formatNumber(group.requests)
                            break
                          case "margin":
                            content = <MarginCell value={group.margin_pct ?? group.margin} />
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
                          case "tokens":
                            content = formatTokenCn(group.tokens)
                            break
                          case "tps":
                            content = formatTps(group.tps)
                            break
                          case "cache":
                            content = <CacheRateCell value={group.cache_rate} />
                            break
                          case "p50":
                            content = (
                              <span className={latencyP50ToneClass(group.p50 ?? group.latency_p50)}>
                                {formatLatency(group.p50 ?? group.latency_p50)}
                              </span>
                            )
                            break
                          case "p95":
                            content = <LatencyP95Cell value={group.p95 ?? group.latency_p95} />
                            break
                          case "per_1e8":
                            content = group.top_model?.per_1e8 != null ? (
                              <span className="font-mono tabular-nums text-[13px] leading-[18px]" title={group.top_model.model}>
                                ${group.top_model.per_1e8.toFixed(2)}
                              </span>
                            ) : (
                              "—"
                            )
                            break
                          case "last":
                            content = (
                              <span className="text-[12px] leading-[16px] text-muted-foreground font-mono">
                                {formatTimestampShort(group.last_t)}
                              </span>
                            )
                            break
                        }

                        return (
                          <TableCell
                            key={col.key}
                            className={cn(
                              "px-3 py-0 h-[44px] align-middle text-[13px] leading-[18px] font-mono tabular-nums whitespace-nowrap",
                              isNum ? "text-right" : "text-left",
                              isLocked && "sticky left-0 bg-card z-10 border-r border-border min-w-[150px] sm:min-w-[180px]"
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
    </div>
  )
}
