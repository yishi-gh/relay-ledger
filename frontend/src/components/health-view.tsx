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
  fetchStatus,
  type DateRange,
  type RangeType,
  type StatusBucket,
  type StatusLevel,
  type StatusPayload,
  type StatusState,
} from "@/lib/api"
import { cn } from "@/lib/utils"

/** 状态条只用现有 --chart-* 语义色：正常绿、告警黄、故障红、无请求灰 */
const STATE_COLOR: Record<StatusState, string> = {
  ok: "var(--chart-2)",
  warn: "var(--chart-3)",
  fail: "var(--chart-5)",
  none: "var(--muted)",
}

const STATE_LABEL: Record<StatusState, string> = {
  ok: "正常",
  warn: "告警",
  fail: "故障",
  none: "无请求",
}

const LEGEND: StatusState[] = ["ok", "warn", "fail", "none"]

interface StripCell {
  key: number
  label: string
  total: number
  errors: number
  state: StatusState
}

/** 与后端同一阈值：只有该格有请求时才判状态 */
function stateOf(total: number, errors: number): StatusState {
  if (total <= 0) return "none"
  const rate = errors / total
  if (rate <= 0) return "ok"
  if (rate < 0.02) return "warn"
  return "fail"
}

/** 24h 每格 1 小时；7d 按 6 小时合并成 28 格，避免 168 格挤成一条线 */
function buildCells(buckets: StatusBucket[], groupSize: number): StripCell[] {
  if (groupSize <= 1) {
    return buckets.map((b) => ({
      key: b.t_ms,
      label: b.label,
      total: b.total,
      errors: b.errors,
      state: b.state,
    }))
  }

  const cells: StripCell[] = []
  for (let i = 0; i < buckets.length; i += groupSize) {
    const chunk = buckets.slice(i, i + groupSize)
    let total = 0
    let errors = 0
    for (const bucket of chunk) {
      total += bucket.total
      errors += bucket.errors
    }
    const first = chunk[0]
    const last = chunk[chunk.length - 1]
    cells.push({
      key: first.t_ms,
      label: first.t_ms === last.t_ms ? first.label : `${first.label} – ${last.label}`,
      total,
      errors,
      state: stateOf(total, errors),
    })
  }
  return cells
}

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

  // 健康页用固定整窗：24h = 24 个整点，7d = 168 小时（28 格 × 6 小时）。
  // 不用看板默认的自然日窗口，避免 7d 末端只走了几小时导致格子数不足 28。
  // 起点按整点对齐、终点保留数据截止时刻，所以首尾各含一个未走完的小时槽。
  const range = React.useMemo<DateRange | null>(() => {
    if (!dateRange) return null
    const to = dateRange.to
    const hourStart = Math.floor(to / 3600_000) * 3600_000
    const slots = timeRange === "7d" ? 24 * 7 : 24
    return { from: hourStart - (slots - 1) * 3600_000, to }
  }, [dateRange, timeRange])

  // 按视图懒加载：健康页不参与首屏 loadDashboard，切到本页或切换维度时才请求
  React.useEffect(() => {
    let cancelled = false

    async function load() {
      if (!range) return
      try {
        const res = await fetchStatus(range, level)
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
  }, [range, level])

  const components = data?.components ?? []
  const overall = data?.overall ?? null
  const coverageSince = data?.coverage?.errors_since ?? null
  const groupSize = timeRange === "7d" ? 6 : 1
  // 维度或窗口切换时旧数据还在路上：显示旧表并标注加载中，避免整页闪空
  const loading =
    !notReady && (!data || !range || data.from !== range.from || data.level !== level)

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
                <Table className="min-w-[740px] lg:min-w-full table-auto lg:table-fixed">
                  <colgroup className="hidden lg:table-column-group">
                    <col style={{ width: "18%" }} />
                    <col style={{ width: "44%" }} />
                    <col style={{ width: "10%" }} />
                    <col style={{ width: "9%" }} />
                    <col style={{ width: "8%" }} />
                    <col style={{ width: "11%" }} />
                  </colgroup>
                  <TableHeader className="bg-muted/50 sticky top-0 z-20 backdrop-blur-xs">
                    <TableRow className="hover:bg-transparent border-b border-border">
                      <TableHead className="h-9 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground">
                        {level === "channel" ? "渠道" : "分组"}
                      </TableHead>
                      <TableHead className="h-9 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground">
                        {timeRange === "24h" ? "24 小时状态（每格 1 小时）" : "7 天状态（每格 6 小时）"}
                      </TableHead>
                      <TableHead className="h-9 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground text-right">
                        Uptime
                      </TableHead>
                      <TableHead className="h-9 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground text-right">
                        请求
                      </TableHead>
                      <TableHead className="h-9 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground text-right">
                        错误
                      </TableHead>
                      <TableHead className="h-9 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground">
                        Top 错误
                      </TableHead>
                    </TableRow>
                  </TableHeader>

                  <TableBody>
                    {components.map((component) => {
                      const cells = buildCells(component.buckets, groupSize)
                      const uptime = component.uptime
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
                              {cells.map((cell) => (
                                <span
                                  key={cell.key}
                                  className="flex-1 h-5 min-w-[2px] rounded-[2px] transition-opacity hover:opacity-80"
                                  style={{ backgroundColor: STATE_COLOR[cell.state] }}
                                  title={`${cell.label} · 请求 ${formatNumber(cell.total)} · 错误 ${formatNumber(cell.errors)} · ${STATE_LABEL[cell.state]}`}
                                />
                              ))}
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
                            style={component.errors > 0 ? { color: "var(--chart-5)" } : undefined}
                          >
                            {formatNumber(component.errors)}
                          </TableCell>

                          <TableCell className="px-3 py-1">
                            {component.top_errors.length === 0 ? (
                              <span className="text-[12px] leading-[16px] text-muted-foreground">—</span>
                            ) : (
                              <div className="flex items-center gap-1 flex-wrap">
                                {component.top_errors.map((item) => (
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
                  uptime =（请求 − 错误）/ 请求；该小时无请求不参与状态判定
                </span>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
