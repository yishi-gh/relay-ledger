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
import { Activity, AlertTriangle, HeartPulse, Inbox } from "lucide-react"
import { formatNumber } from "@/lib/formatters"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  fetchStatus,
  type DateRange,
  type RangeType,
  type StatusBucketSize,
  type StatusLevel,
  type StatusPayload,
  type StatusState,
} from "@/lib/api"
import { cn } from "@/lib/utils"
import { useSettings } from "@/lib/settings"
import { SiteLogo } from "@/components/site-logo"

/** 状态条颜色：正常、告警、故障、样本不足、无请求 */
export const STATE_COLOR: Record<StatusState, string> = {
  ok: "var(--chart-2)",
  warn: "var(--chart-3)",
  fail: "var(--chart-5)",
  unknown: "var(--status-unknown)",
  none: "var(--status-none)",
}

export const STATE_LABEL: Record<StatusState, string> = {
  ok: "正常",
  warn: "告警",
  fail: "故障",
  unknown: "样本不足",
  none: "无请求",
}

export const LEGEND: StatusState[] = ["ok", "warn", "fail", "unknown", "none"]

/** 北京时间的 MM-DD HH:mm；coverage 只用于「错误数据自 X 起」的小字 */
export function formatBeijingShort(ms: number): string {
  const d = new Date(ms + 8 * 3600_000)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

/** uptime 用两位小数：1 位小数会把 99.98% 显示成 100.0%，看起来像零故障 */
export function formatUptime(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—"
  return `${(value * 100).toFixed(2)}%`
}

export interface HealthViewProps {
  timeRange: RangeType
  dateRange?: DateRange | null
  initialLevel?: StatusLevel
  fixedLevel?: StatusLevel
  embedded?: boolean
  onLevelChange?: (level: StatusLevel) => void
  previewMode?: boolean
}

export function HealthView({
  timeRange,
  dateRange,
  initialLevel = "channel",
  fixedLevel,
  embedded = false,
  onLevelChange,
}: HealthViewProps) {
  const { server, revision } = useSettings()
  const [internalLevel, setInternalLevel] = React.useState<StatusLevel>(fixedLevel ?? initialLevel)
  const [data, setData] = React.useState<StatusPayload | null>(null)
  const [notReady, setNotReady] = React.useState(false)

  const level: StatusLevel = fixedLevel ?? internalLevel

  // 同步外部 initialLevel 变更（仅未固定时）
  const [prevInitialLevel, setPrevInitialLevel] = React.useState(initialLevel)
  if (prevInitialLevel !== initialLevel && !fixedLevel) {
    setPrevInitialLevel(initialLevel)
    setInternalLevel(initialLevel)
  }

  const handleLevelChange = (newLevel: StatusLevel) => {
    if (fixedLevel) return
    setInternalLevel(newLevel)
    onLevelChange?.(newLevel)
  }

  const bucketSize: StatusBucketSize = timeRange === "24h" ? "15m" : "1h"

  // 健康页窗口对齐桶粒度：24h = 96 个 15 分钟桶，7d = 168 个 1 小时桶。
  const range = React.useMemo<DateRange | null>(() => {
    if (!dateRange) return null
    const to = dateRange.to
    if (timeRange === "24h") {
      const slotStart = Math.floor(to / (15 * 60_000)) * (15 * 60_000)
      return { from: slotStart - (96 - 1) * 15 * 60_000, to }
    }
    const hourStart = Math.floor(to / 3600_000) * 3600_000
    return { from: hourStart - (168 - 1) * 3600_000, to }
  }, [dateRange, timeRange])

  // 按视图懒加载：健康页不参与首屏 loadDashboard，切到本页或切换维度/跨度时才请求
  React.useEffect(() => {
    let cancelled = false

    async function load() {
      if (!range) return
      try {
        const res = await fetchStatus(range, level, bucketSize)
        if (cancelled) return
        setData(res)
        setNotReady(false)
      } catch {
        if (cancelled) return
        setNotReady(true)
        setData(null)
      }
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [range, level, bucketSize, revision])

  const components = data?.components ?? []
  const overall = data?.overall ?? null
  const coverageSince = data?.coverage?.errors_since ?? null
  // 维度或窗口切换时旧数据还在路上：显示旧表并标注加载中，避免整页闪空
  const loading =
    !notReady &&
    (!data ||
      !range ||
      data.from !== range.from ||
      data.level !== level ||
      (data.bucket && data.bucket !== bucketSize))

  const healthRules =
    (data as (StatusPayload & { health_rules?: { minSamples: number; failErrorRate: number } }) | null)
      ?.health_rules ?? server.health

  const getHealthStatusColor = (
    requests: number | null | undefined,
    errors: number | null | undefined,
    uptime: number | null | undefined
  ) => {
    const req = requests ?? 0
    const err = errors ?? 0
    const attempts = req + err
    if (attempts <= 0 || uptime == null || !Number.isFinite(uptime)) return "text-muted-foreground"
    if (attempts < healthRules.minSamples) return "text-muted-foreground" // 样本不足与后端一致保持中性
    if (err <= 0) return "text-emerald-600 dark:text-emerald-400 font-medium"
    if (err / attempts < healthRules.failErrorRate) return "text-amber-600 dark:text-amber-400 font-medium"
    return "text-rose-600 dark:text-rose-400 font-semibold"
  }

  // 表格内部公共渲染
  const renderTableContent = () => {
    if (notReady) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center gap-1.5 py-10 text-muted-foreground">
          <AlertTriangle className="size-5 opacity-50" />
          <span className="text-[14px] leading-[20px] font-medium">健康数据接口不可用</span>
          <span className="text-[12px] leading-[16px]">请确认后端已启动并完成一次上游错误同步</span>
        </div>
      )
    }

    if (!data && loading) {
      return (
        <div className="flex-1 flex items-center justify-center py-10 text-[12px] leading-[16px] text-muted-foreground">
          加载中…
        </div>
      )
    }

    if (components.length === 0 && !loading) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center gap-1.5 py-10 text-muted-foreground">
          <Inbox className="size-5 opacity-40" />
          <span className="text-[12px] leading-[16px]">所选时间窗口内暂无渠道请求与错误记录</span>
        </div>
      )
    }

    const matrixColWidthPx = timeRange === "24h" ? 480 : 540
    const matrixContentMinPx = timeRange === "24h" ? 380 : 480
    const healthTableMinPx = timeRange === "24h" ? 912 : 972

    return (
      <div className="flex flex-col gap-2">
        <div className="rounded-lg border border-border bg-card overflow-hidden [&_[data-slot=table-container]]:h-[clamp(180px,calc((100dvh-320px)/2),420px)] [&_[data-slot=table-container]]:overflow-y-auto max-md:[&_[data-slot=table-container]]:h-auto max-md:[&_[data-slot=table-container]]:max-h-none">
          <Table className="table-fixed text-sm" style={{ width: "100%", minWidth: `${healthTableMinPx}px` }}>
            <colgroup>
              <col style={{ width: "155px" }} />
              <col style={{ width: `${matrixColWidthPx}px` }} />
              <col style={{ width: "72px" }} />
              <col style={{ width: "65px" }} />
              <col style={{ width: "60px" }} />
              <col style={{ width: "80px" }} />
            </colgroup>
            <TableHeader className="bg-muted/50 sticky top-0 z-20 backdrop-blur-xs">
              <TableRow className="hover:bg-transparent border-b border-border h-8">
                <TableHead className="h-8 px-2.5 text-[12px] leading-[16px] font-medium text-muted-foreground whitespace-nowrap" style={{ width: "155px" }}>
                  {level === "channel" ? "渠道" : "分组"}
                </TableHead>
                <TableHead className="h-8 px-2 text-[12px] leading-[16px] font-medium text-muted-foreground whitespace-nowrap" style={{ width: `${matrixColWidthPx}px` }}>
                  {timeRange === "24h"
                    ? "24 小时状态（每格 15 分钟）"
                    : "7 天状态（每格 1 小时）"}
                </TableHead>
                <TableHead className="h-8 px-2 text-[12px] leading-[16px] font-medium text-muted-foreground text-right whitespace-nowrap" style={{ width: "72px" }}>
                  Uptime
                </TableHead>
                <TableHead className="h-8 px-2 text-[12px] leading-[16px] font-medium text-muted-foreground text-right whitespace-nowrap" style={{ width: "65px" }}>
                  请求
                </TableHead>
                <TableHead className="h-8 px-2 text-[12px] leading-[16px] font-medium text-muted-foreground text-right whitespace-nowrap" style={{ width: "60px" }}>
                  错误
                </TableHead>
                <TableHead className="h-8 px-2 text-[12px] leading-[16px] font-medium text-muted-foreground whitespace-nowrap" style={{ width: "80px" }}>
                  Top 错误
                </TableHead>
              </TableRow>
            </TableHeader>

            <TableBody>
              {components.map((component) => {
                const uptime = component.uptime
                const buckets = component.buckets ?? []
                const topErrorsList = component.top_errors ?? []
                return (
                  <TableRow
                    key={component.key}
                    className="h-8 hover:bg-muted/40 transition-colors border-b border-border/60"
                  >
                    <TableCell className="px-2.5 py-0 h-8 align-middle" style={{ width: "155px" }}>
                      <div className="flex items-center gap-1.5 min-w-0">
                        {level === "channel" && (
                          <SiteLogo kind="channel" id={component.key} label={component.name} size={16} />
                        )}
                        <span
                          className="block truncate text-[13px] leading-[18px] text-foreground font-medium"
                          title={component.name}
                        >
                          {component.name}
                        </span>
                      </div>
                    </TableCell>

                    <TableCell className="px-2 py-0 h-8 align-middle" style={{ width: `${matrixColWidthPx}px` }}>
                      <div
                        className="flex items-center gap-[1px] h-4.5 w-full"
                        style={{ minWidth: `${matrixContentMinPx}px` }}
                        role="img"
                        aria-label={`${component.name} 状态分布`}
                      >
                        {buckets.map((bucket, idx) => {
                          const total = bucket.total ?? 0
                          const errors = bucket.errors ?? 0
                          const attempts = total + errors
                          const successRate =
                            attempts > 0
                              ? ((total / attempts) * 100).toFixed(2)
                              : null
                          const state: StatusState = bucket.state ?? "none"
                          const topErrors = bucket.top_errors ?? []

                          return (
                            <Tooltip key={bucket.t_ms ?? idx}>
                              <TooltipTrigger
                                render={
                                  <span
                                    className={cn(
                                      "flex-1 basis-0 min-w-[1px] h-3.5 rounded-[1px] transition-opacity hover:opacity-80 cursor-pointer",
                                      state === "unknown" && "health-pattern-unknown",
                                      state === "none" && "shadow-[inset_0_0_0_1px_var(--border)]"
                                    )}
                                    style={{
                                      backgroundColor: STATE_COLOR[state],
                                    }}
                                  />
                                }
                              />
                              <TooltipContent
                                side="top"
                                sideOffset={4}
                                className="flex flex-col gap-1 items-start text-left px-2.5 py-2 max-w-xs z-50 pointer-events-none"
                              >
                                <div className="font-semibold text-[12px] leading-tight flex items-center justify-between gap-2 w-full">
                                  <span>{bucket.label}</span>
                                  <span className="inline-flex items-center gap-1.5 text-[12px] font-medium px-1.5 py-0.5 rounded-[3px] bg-muted/80 text-foreground border border-border/60">
                                    <span
                                      className={cn(
                                        "size-2 rounded-[1px] shrink-0",
                                        state === "unknown" && "health-pattern-unknown",
                                        state === "none" && "border border-border/60"
                                      )}
                                      style={{ backgroundColor: STATE_COLOR[state] }}
                                    />
                                    <span>{STATE_LABEL[state]}</span>
                                  </span>
                                </div>
                                <div className="text-[12px] opacity-85 leading-tight">
                                  {attempts === 0
                                    ? "无请求记录"
                                    : `成功 ${total} · 失败 ${errors} · 成功率 ${successRate}%`}
                                </div>
                                {attempts > 0 && attempts < healthRules.minSamples && (
                                  <div className="text-[11px] text-muted-foreground leading-tight">
                                    注：调用数 ({attempts}) 低于故障判定门槛 ({healthRules.minSamples} 次)
                                  </div>
                                )}
                                <div className="text-[12px] leading-tight pt-0.5">
                                  {topErrors.length === 0 ? (
                                    <span className="opacity-75">
                                      无错误码记录
                                    </span>
                                  ) : (
                                    <div className="flex flex-col gap-0.5 font-mono">
                                      {topErrors.map((err) => (
                                        <div
                                          key={err.status}
                                          className="flex items-center justify-between gap-3"
                                        >
                                          <span>状态 {err.status}:</span>
                                          <span>{err.count} 次</span>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              </TooltipContent>
                            </Tooltip>
                          )
                        })}
                      </div>
                    </TableCell>

                    <TableCell className="px-2 py-0 h-8 align-middle text-right font-mono tabular-nums text-[13px] leading-[18px]" style={{ width: "72px" }}>
                      {uptime != null ? (
                        <span className={cn("font-medium", getHealthStatusColor(component.requests, component.errors, uptime))}>
                          {formatUptime(uptime)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>

                    <TableCell className="px-2 py-0 h-8 align-middle text-right font-mono tabular-nums text-[13px] leading-[18px] text-foreground" style={{ width: "65px" }}>
                      {formatNumber(component.requests ?? null)}
                    </TableCell>

                    <TableCell className="px-2 py-0 h-8 align-middle text-right font-mono tabular-nums text-[13px] leading-[18px]" style={{ width: "60px" }}>
                      <span
                        className={cn(
                          (component.errors ?? 0) > 0
                            ? "text-rose-600 dark:text-rose-400 font-semibold"
                            : "text-muted-foreground"
                        )}
                      >
                        {formatNumber(component.errors ?? null)}
                      </span>
                    </TableCell>

                    <TableCell className="px-2 py-0 h-8 align-middle whitespace-nowrap" style={{ width: "80px" }}>
                      {topErrorsList.length === 0 ? (
                        <span className="text-muted-foreground text-[12px] leading-[16px]">—</span>
                      ) : (
                        <div className="flex items-center gap-1">
                          {topErrorsList.slice(0, 2).map((err) => (
                            <Badge
                              key={err.status}
                              variant={err.status >= 500 ? "destructive" : "outline"}
                              className="text-[12px] leading-[16px] h-5 px-1.5 font-mono font-normal"
                              title={`${err.status}: ${err.count} 次`}
                            >
                              {err.status}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>

        {/* 状态图例与口径说明 */}
        <div className="flex items-center justify-between text-[12px] leading-[16px] text-muted-foreground flex-wrap gap-2 pt-1 px-0.5">
          <div className="flex items-center gap-3.5 flex-wrap">
            <span className="font-medium text-foreground">状态图例：</span>
            {LEGEND.map((state) => (
              <div key={state} className="flex items-center gap-1.5">
                <span
                  className={cn(
                    "size-2.5 rounded-[1px] shrink-0",
                    state === "unknown" && "health-pattern-unknown",
                    state === "none" && "border border-border/60"
                  )}
                  style={{ backgroundColor: STATE_COLOR[state] }}
                />
                <span>{STATE_LABEL[state]}</span>
              </div>
            ))}
          </div>
          <span className="text-muted-foreground/80">
            注：样本不足（调用 &lt; {healthRules.minSamples} 次）与无请求不参与状态判定
          </span>
        </div>
      </div>
    )
  }

  // 嵌入模式：作为卡片挂在明细下方，卡头含整体 3 指标紧凑摘要，无独立 3 大卡，自然纵向展开
  if (embedded) {
    return (
      <Card className="shadow-xs overflow-hidden flex flex-col p-3 pb-2.5 gap-0 shrink-0">
        <CardHeader className="p-0 pb-1.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 space-y-0 shrink-0 flex-wrap">
          <div className="flex items-center gap-2.5 flex-wrap">
            <CardTitle className="text-[15px] leading-[22px] font-medium text-foreground">
              {level === "channel" ? "渠道可用性健康" : "分组可用性健康"}
            </CardTitle>
            <Badge
              variant="secondary"
              className="text-[12px] leading-[16px] h-5 px-1.5 font-medium tabular-nums"
            >
              {components.length} 个{level === "channel" ? "渠道" : "分组"}
            </Badge>
            {loading && (
              <span className="text-[12px] leading-[16px] text-muted-foreground animate-pulse">
                加载中…
              </span>
            )}
          </div>

          {/* 内嵌卡保留 overall 3 指标作为卡内紧凑摘要 + 覆盖起点 / 暂无上游错误说明 */}
          <div className="flex items-center gap-2.5 text-[12px] leading-[16px] flex-wrap">
            <div className="flex items-center gap-1.5 font-mono tabular-nums">
              <span className="text-muted-foreground">整体 Uptime:</span>
              <span className={cn("font-semibold", getHealthStatusColor(overall?.requests, overall?.errors, overall?.uptime))}>
                {formatUptime(overall?.uptime ?? null)}
              </span>
            </div>
            <span className="text-border">·</span>
            <div className="flex items-center gap-1.5 font-mono tabular-nums">
              <span className="text-muted-foreground">总请求:</span>
              <span className="font-semibold text-foreground">
                {formatNumber(overall?.requests ?? null)}
              </span>
            </div>
            <span className="text-border">·</span>
            <div className="flex items-center gap-1.5 font-mono tabular-nums">
              <span className="text-muted-foreground">错误数:</span>
              <span className={cn("font-semibold", (overall?.errors ?? 0) > 0 ? "text-amber-500" : "text-foreground")}>
                {formatNumber(overall?.errors ?? null)}
              </span>
            </div>
            <span className="text-border">·</span>
            {coverageSince !== null ? (
              <span className="text-muted-foreground whitespace-nowrap">
                错误自 {formatBeijingShort(coverageSince)} 起
              </span>
            ) : (
              <span className="text-muted-foreground whitespace-nowrap" title="上游错误表尚未初始化或当前窗口无错误日志">
                暂无上游错误数据
              </span>
            )}
          </div>
        </CardHeader>

        <CardContent className="p-0 flex flex-col">
          {renderTableContent()}
        </CardContent>
      </Card>
    )
  }

  // 独立健康页模式：顶部 3 张独立 KPI 卡 + 主表卡
  return (
    <div className="flex-1 min-h-0 flex flex-col gap-4 overflow-y-auto pr-1">
      {/* 1. 顶部 3 张 KPI：整体 uptime、总请求、总错误 */}
      <section className="grid grid-cols-1 sm:grid-cols-3 gap-3.5 shrink-0">
        <Card className="shadow-xs p-3.5 flex flex-col justify-between">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-[14px] leading-[20px]">整体 uptime</span>
            <HeartPulse className={cn("size-4", getHealthStatusColor(overall?.requests, overall?.errors, overall?.uptime))} />
          </div>
          <div className={cn("mt-1.5 text-[24px] leading-[28px] font-semibold font-mono tabular-nums", getHealthStatusColor(overall?.requests, overall?.errors, overall?.uptime))}>
            {formatUptime(overall?.uptime ?? null)}
          </div>
          <span className="text-[12px] leading-[16px] text-muted-foreground mt-1">
            有请求的记录里未出错的比例
          </span>
        </Card>

        <Card className="shadow-xs p-3.5 flex flex-col justify-between">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-[14px] leading-[20px]">总请求</span>
            <Activity className="size-4 text-indigo-500" />
          </div>
          <div className="mt-1.5 text-[24px] leading-[28px] font-semibold font-mono tabular-nums text-foreground">
            {formatNumber(overall?.requests ?? null)}
            <span className="text-[14px] font-normal font-sans text-muted-foreground"> 次</span>
          </div>
          <span className="text-[12px] leading-[16px] text-muted-foreground mt-1">
            {timeRange === "24h" ? "近 24 小时成功消费" : "近 7 天成功消费"}
          </span>
        </Card>

        <Card className="shadow-xs p-3.5 flex flex-col justify-between">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-[14px] leading-[20px]">总错误</span>
            <AlertTriangle className="size-4 text-amber-500" />
          </div>
          <div className="mt-1.5 text-[24px] leading-[28px] font-semibold font-mono tabular-nums text-foreground">
            {formatNumber(overall?.errors ?? null)}
            <span className="text-[14px] font-normal font-sans text-muted-foreground"> 次</span>
          </div>
          <span className="text-[12px] leading-[16px] text-muted-foreground mt-1">
            {coverageSince !== null ? "来自源库 type=5 错误日志" : "暂无上游错误数据"}
          </span>
        </Card>
      </section>

      {/* 2. 主表：名称 + 每小时状态条 + uptime / 请求 / 错误 / Top 错误码 */}
      <Card className="shadow-xs overflow-hidden flex flex-col min-w-0 p-3 pb-2.5">
        <CardHeader className="p-0 pb-2 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 space-y-0 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <CardTitle className="text-[16px] leading-[24px] font-medium text-foreground whitespace-nowrap">
              渠道健康
            </CardTitle>
            <Badge
              variant="secondary"
              className="text-[12px] leading-[16px] h-5 px-1.5 font-medium tabular-nums"
            >
              {components.length} 个{level === "channel" ? "渠道" : "分组"}
            </Badge>
            {loading && (
              <span className="text-[12px] leading-[16px] text-muted-foreground">加载中…</span>
            )}
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            {coverageSince !== null && (
              <span className="hidden md:inline text-[12px] leading-[16px] text-muted-foreground">
                错误数据自 {formatBeijingShort(coverageSince)} 起
              </span>
            )}
            {!fixedLevel && (
              <ToggleGroup
                value={[level]}
                onValueChange={(vals) => {
                  const val = vals?.[0]
                  if (val === "channel" || val === "group") {
                    handleLevelChange(val as StatusLevel)
                  }
                }}
                variant="outline"
                size="sm"
                className="shrink-0"
              >
                <ToggleGroupItem
                  value="channel"
                  className="text-[12px] leading-[16px] px-3 h-7.5"
                >
                  渠道
                </ToggleGroupItem>
                <ToggleGroupItem value="group" className="text-[12px] leading-[16px] px-3 h-7.5">
                  分组
                </ToggleGroupItem>
              </ToggleGroup>
            )}
          </div>
        </CardHeader>

        <CardContent className="p-0 flex flex-col">
          {renderTableContent()}
        </CardContent>
      </Card>
    </div>
  )
}
