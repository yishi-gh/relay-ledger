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

/** 状态条颜色：正常绿、告警黄、故障红、样本不足中性灰、无请求深灰 */
const STATE_COLOR: Record<StatusState, string> = {
  ok: "var(--chart-2)",
  warn: "var(--chart-3)",
  fail: "var(--chart-5)",
  unknown: "#64748b",
  none: "#334155",
}

const STATE_LABEL: Record<StatusState, string> = {
  ok: "正常",
  warn: "告警",
  fail: "故障",
  unknown: "样本不足",
  none: "无请求",
}

const LEGEND: StatusState[] = ["ok", "warn", "fail", "unknown", "none"]

/** 北京时间的 MM-DD HH:mm；coverage 只用于「错误数据自 X 起」的小字 */
function formatBeijingShort(ms: number): string {
  const d = new Date(ms + 8 * 3600_000)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

/** uptime 用两位小数：1 位小数会把 99.98% 显示成 100.0%，看起来像零故障 */
function formatUptime(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—"
  return `${(value * 100).toFixed(2)}%`
}

interface HealthViewProps {
  timeRange: RangeType
  dateRange: DateRange | null
}

export function HealthView({ timeRange, dateRange }: HealthViewProps) {
  const [level, setLevel] = React.useState<StatusLevel>("channel")
  const [data, setData] = React.useState<StatusPayload | null>(null)
  const [notReady, setNotReady] = React.useState(false)

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
  }, [range, level, bucketSize])

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

  return (
    <div className="flex-1 min-h-0 flex flex-col space-y-4">
      {/* 1. 顶部 3 张 KPI：整体 uptime、总请求、总错误 */}
      <section className="grid grid-cols-1 sm:grid-cols-3 gap-3.5 shrink-0">
        <Card className="shadow-xs p-3.5 flex flex-col justify-between">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-[14px] leading-[20px]">整体 uptime</span>
            <HeartPulse className="size-4 text-emerald-600 dark:text-emerald-400" />
          </div>
          <div className="mt-1.5 text-[24px] leading-[28px] font-semibold font-mono tabular-nums text-foreground">
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
      <Card className="shadow-xs overflow-hidden flex flex-col min-w-0 p-4 lg:flex-1 lg:min-h-0">
        <CardHeader className="p-0 pb-2.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 space-y-0 shrink-0">
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
            <ToggleGroup
              value={[level]}
              onValueChange={(vals) => {
                if (vals && vals.length > 0) setLevel(vals[0] as StatusLevel)
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
          </div>
        </CardHeader>

        <CardContent className="p-0 flex flex-col lg:flex-1 lg:min-h-0">
          {notReady ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-1.5 py-10 text-muted-foreground">
              <AlertTriangle className="size-5 opacity-50" />
              <span className="text-[14px] leading-[20px] font-medium">健康数据接口不可用</span>
              <span className="text-[12px] leading-[16px]">请确认后端已启动并完成一次上游错误同步</span>
            </div>
          ) : !data ? (
            <div className="flex-1 flex items-center justify-center py-10 text-[12px] leading-[16px] text-muted-foreground">
              加载中…
            </div>
          ) : components.length === 0 && !loading ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-1.5 py-10 text-muted-foreground">
              <Inbox className="size-5 opacity-40" />
              <span className="text-[12px] leading-[16px]">所选时间窗口内暂无渠道请求与错误记录</span>
            </div>
          ) : (
            <>
              <div className="rounded-lg border border-border bg-card overflow-x-auto lg:flex-1 lg:min-h-0 lg:overflow-auto">
                <Table className="min-w-[740px] lg:min-w-full table-auto">
                  <colgroup className="hidden lg:table-column-group">
                    <col style={{ width: "13%" }} />
                    <col style={{ width: "63%" }} />
                    <col style={{ width: "7%" }} />
                    <col style={{ width: "6%" }} />
                    <col style={{ width: "5%" }} />
                    <col style={{ width: "6%" }} />
                  </colgroup>
                  <TableHeader className="bg-muted/50 sticky top-0 z-20 backdrop-blur-xs">
                    <TableRow className="hover:bg-transparent border-b border-border">
                      <TableHead className="h-9 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground whitespace-nowrap">
                        {level === "channel" ? "渠道" : "分组"}
                      </TableHead>
                      <TableHead className="h-9 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground whitespace-nowrap">
                        {timeRange === "24h"
                          ? "24 小时状态（每格 15 分钟）"
                          : "7 天状态（每格 1 小时）"}
                      </TableHead>
                      <TableHead className="h-9 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground text-right whitespace-nowrap">
                        Uptime
                      </TableHead>
                      <TableHead className="h-9 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground text-right whitespace-nowrap">
                        请求
                      </TableHead>
                      <TableHead className="h-9 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground text-right whitespace-nowrap">
                        错误
                      </TableHead>
                      <TableHead className="h-9 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground whitespace-nowrap">
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
                          className="h-[44px] hover:bg-muted/40 transition-colors border-b border-border/60"
                        >
                          <TableCell className="px-3 py-1 min-w-[140px]">
                            <span
                              className="block truncate text-[14px] leading-[20px] text-foreground"
                              title={component.name}
                            >
                              {component.name}
                            </span>
                          </TableCell>

                          <TableCell className="px-3 py-1">
                            <div
                              className="flex items-center gap-[2px] h-6 w-full"
                              role="img"
                              aria-label={`${component.name} 状态分布`}
                            >
                              {buckets.map((bucket, idx) => {
                                const total = bucket.total ?? 0
                                const errors = bucket.errors ?? 0
                                const attempts = total + errors
                                const successRate =
                                  attempts > 0
                                    ? ((total / attempts) * 100).toFixed(1)
                                    : null
                                const state: StatusState = bucket.state ?? "none"
                                const topErrors = bucket.top_errors ?? []

                                return (
                                  <Tooltip key={bucket.t_ms ?? idx}>
                                    <TooltipTrigger
                                      render={
                                        <span
                                          className="flex-1 basis-0 min-w-[3px] h-5 rounded-[2px] transition-opacity hover:opacity-80 cursor-pointer"
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
                                      <div className="font-semibold text-[12px] leading-tight">
                                        {bucket.label}
                                      </div>
                                      <div className="text-[12px] opacity-85 leading-tight">
                                        {attempts === 0
                                          ? "无请求"
                                          : `成功 ${total} · 失败 ${errors} · 成功率 ${successRate}%`}
                                      </div>
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
                                                className="text-rose-400 dark:text-rose-600 font-medium"
                                              >
                                                HTTP {err.status} × {err.count}
                                              </div>
                                            ))}
                                          </div>
                                        )}
                                      </div>
                                      {state === "unknown" && (
                                        <div className="text-[11px] opacity-75 border-t border-current/20 pt-1 mt-0.5 leading-tight">
                                          样本不足（&lt; 3 次请求），不判定健康度
                                        </div>
                                      )}
                                    </TooltipContent>
                                  </Tooltip>
                                )
                              })}
                            </div>
                          </TableCell>

                          <TableCell
                            className="px-3 py-1 text-right font-mono tabular-nums text-[14px] leading-[20px] font-semibold text-foreground"
                            style={
                              uptime !== null && uptime < 0.98
                                ? { color: "var(--chart-5)" }
                                : undefined
                            }
                          >
                            {formatUptime(uptime)}
                          </TableCell>

                          <TableCell className="px-3 py-1 text-right font-mono tabular-nums text-[14px] leading-[20px] text-foreground">
                            {formatNumber(component.requests)}
                          </TableCell>

                          <TableCell
                            className={cn(
                              "px-3 py-1 text-right font-mono tabular-nums text-[14px] leading-[20px]",
                              component.errors > 0 ? "" : "text-muted-foreground"
                            )}
                            style={
                              component.errors > 0 ? { color: "var(--chart-5)" } : undefined
                            }
                          >
                            {formatNumber(component.errors)}
                          </TableCell>

                          <TableCell className="px-3 py-1 whitespace-nowrap">
                            {topErrorsList.length === 0 ? (
                              <span className="text-[12px] leading-[16px] text-muted-foreground">—</span>
                            ) : (
                              <div className="flex items-center gap-1 flex-wrap">
                                {topErrorsList.map((item) => (
                                  <Badge
                                    key={item.status}
                                    variant={item.status >= 500 ? "destructive" : "outline"}
                                    className="text-[12px] leading-[16px] h-5 px-1.5 font-mono tabular-nums"
                                  >
                                    {item.status}×{item.count}
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

              {/* 图例：与状态条同一套颜色 */}
              <div className="flex items-center gap-3 pt-2 shrink-0 text-[12px] leading-[16px] text-muted-foreground select-none">
                {LEGEND.map((state) => (
                  <span key={state} className="inline-flex items-center gap-1.5">
                    <span
                      className="inline-block size-2.5 rounded-[2px]"
                      style={{ backgroundColor: STATE_COLOR[state] }}
                    />
                    {STATE_LABEL[state]}
                  </span>
                ))}
                <span className="ml-auto hidden sm:inline">
                  uptime =（请求 − 错误）/ 请求；样本不足或无请求不参与状态判定
                </span>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
