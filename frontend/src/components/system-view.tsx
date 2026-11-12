import * as React from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Inbox,
  RefreshCw,
  Server,
} from "lucide-react"
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
} from "@/lib/recharts-sized"
import {
  formatNumber,
  formatTimestampShort,
} from "@/lib/formatters"
import { formatBeijingTime } from "@/components/top-bar"
import {
  fetchErrors,
  fetchHealthz,
  fetchServices,
  getMockErrors,
  type ErrorsPayload,
  type ServicesPayload,
  type DateRange,
  type RangeType,
} from "@/lib/api"
import { cn } from "@/lib/utils"
import { useSettings } from "@/lib/settings"
import type { QualityData } from "@/components/quality-view"
import type { UpstreamAccount } from "@/components/upstreams-view"

export interface SystemViewProps {
  quality?: QualityData
  accounts?: UpstreamAccount[]
  dateRange?: DateRange | null
  timeRange?: RangeType
  previewMode?: boolean
  lastRefreshTime?: number
}

type ServicesSnapshot =
  | { rangeKey: string; status: "ready"; data: ServicesPayload; error: null }
  | { rangeKey: string; status: "error"; data: null; error: string }

type ErrorsSnapshot =
  | { rangeKey: string; status: "ready"; data: ErrorsPayload; error: null }
  | { rangeKey: string; status: "error"; data: null; error: string }

const SERVICE_STATE_COLOR: Record<string, string> = {
  ok: "var(--chart-2)",
  warn: "var(--chart-3)",
  fail: "var(--chart-5)",
  disabled: "var(--muted-foreground)",
  unknown: "var(--status-unknown)",
  none: "transparent",
}

const SERVICE_STATE_LABEL: Record<string, string> = {
  ok: "正常",
  warn: "告警",
  fail: "异常",
  disabled: "停用",
  unknown: "未确认",
  none: "无运行",
}

export function SystemView({
  dateRange,
  timeRange = "24h",
  previewMode = false,
  lastRefreshTime,
}: SystemViewProps) {
  const { collector } = useSettings()

  // 1. 服务状态数据 (/api/services)
  const servicesFrom = timeRange === "today" || timeRange === "custom" ? dateRange?.from : undefined
  const servicesTo = timeRange === "today" || timeRange === "custom" ? dateRange?.to : undefined
  const servicesRangeKey = `${timeRange}:${servicesFrom ?? ""}:${servicesTo ?? ""}:${lastRefreshTime ?? ""}`
  const [servicesSnapshot, setServicesSnapshot] = React.useState<ServicesSnapshot | null>(null)
  const servicesLoading = servicesSnapshot?.rangeKey !== servicesRangeKey
  const servicesData = servicesSnapshot?.rangeKey === servicesRangeKey ? servicesSnapshot.data : null
  const servicesError = servicesSnapshot?.rangeKey === servicesRangeKey ? servicesSnapshot.error : null

  React.useEffect(() => {
    const controller = new AbortController()

    if ((timeRange === "today" || timeRange === "custom") && (servicesFrom == null || servicesTo == null)) return
    fetchServices(timeRange, { signal: controller.signal, dateRange: servicesFrom != null && servicesTo != null ? { from: servicesFrom, to: servicesTo } : undefined })
      .then((res) => {
        if (controller.signal.aborted) return
        setServicesSnapshot({ rangeKey: servicesRangeKey, status: "ready", data: res, error: null })
      })
      .catch((e) => {
        if (controller.signal.aborted) return
        setServicesSnapshot({
          rangeKey: servicesRangeKey,
          status: "error",
          data: null,
          error: e instanceof Error ? e.message : String(e),
        })
      })

    return () => {
      controller.abort()
    }
  }, [timeRange, servicesFrom, servicesTo, servicesRangeKey])

  // 2. HTTP 错误数据快照 (/api/errors)
  const [errorsSnapshot, setErrorsSnapshot] = React.useState<ErrorsSnapshot | null>(null)
  const errorsRangeKey = dateRange ? `${dateRange.from}:${dateRange.to}:${lastRefreshTime ?? ""}` : null
  const errorsLoading =
    errorsRangeKey !== null && errorsSnapshot?.rangeKey !== errorsRangeKey
  const errorsData =
    errorsRangeKey !== null
      ? errorsSnapshot?.status === "ready" && errorsSnapshot.rangeKey === errorsRangeKey
        ? errorsSnapshot.data
        : null
      : previewMode && errorsSnapshot?.status === "ready" && errorsSnapshot.rangeKey === "preview"
        ? errorsSnapshot.data
        : null
  const errorsError =
    errorsRangeKey !== null &&
    errorsSnapshot?.status === "error" &&
    errorsSnapshot.rangeKey === errorsRangeKey
      ? errorsSnapshot.error
      : null

  // 3. /api/healthz 单独探针状态
  const [healthOk, setHealthOk] = React.useState<boolean | null>(null)
  const [checking, setChecking] = React.useState(false)
  const [lastCheckMs, setLastCheckMs] = React.useState<number>(() => Date.now())

  const checkHealth = React.useCallback(async () => {
    setChecking(true)
    try {
      const res = await fetchHealthz()
      setHealthOk(Boolean(res?.ok))
    } catch {
      setHealthOk(false)
    } finally {
      setChecking(false)
      setLastCheckMs(Date.now())
    }
  }, [])

  React.useEffect(() => {
    let cancelled = false
    fetchHealthz()
      .then((res) => {
        if (!cancelled) setHealthOk(Boolean(res?.ok))
      })
      .catch(() => {
        if (!cancelled) setHealthOk(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  React.useEffect(() => {
    if (!errorsRangeKey) return
    const key = errorsRangeKey
    let cancelled = false

    async function loadErrors() {
      const [fromStr, toStr] = key.split(":")
      const range: DateRange = { from: Number(fromStr), to: Number(toStr) }
      try {
        const res = await fetchErrors(range)
        if (cancelled) return
        setErrorsSnapshot({ rangeKey: key, status: "ready", data: res, error: null })
      } catch (err) {
        if (cancelled) return
        if (previewMode) {
          const fallback = getMockErrors(range)
          setErrorsSnapshot({ rangeKey: key, status: "ready", data: fallback, error: null })
          return
        }
        setErrorsSnapshot({
          rangeKey: key,
          status: "error",
          data: null,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    void loadErrors()
    return () => {
      cancelled = true
    }
  }, [errorsRangeKey, previewMode])

  const chartData = React.useMemo(() => {
    if (!errorsData?.buckets) return []
    return errorsData.buckets.map((b) => {
      const displayLabel = b.label.replace(/^\d{4}-/, "")
      return {
        ...b,
        displayLabel,
      }
    })
  }, [errorsData])

  const services = servicesData?.services ?? []
  const serviceSlots = services.reduce((max, service) => Math.max(max, service.buckets.length), 0)
  const bucketMinWidthPx = serviceSlots > 168 ? 3 : 2
  const matrixContentMinPx = Math.max(360, serviceSlots * bucketMinWidthPx + Math.max(0, serviceSlots - 1))
  const matrixColWidthPx = Math.max(servicesData?.bucket_ms === 15 * 60000 ? 480 : 540, matrixContentMinPx + 24)
  const servicesTableMinPx = matrixColWidthPx + 160 + 110 + 130 + 90
  const bucketMinutes = servicesData?.bucket_ms ? servicesData.bucket_ms / 60000 : null

  const currentCollector = servicesData?.collector ?? collector

  return (
    <div className="flex-1 min-h-0 min-w-0 flex flex-col gap-4 overflow-y-auto pr-1">
      {/* 1. 后台任务服务健康概览卡片 (替代原静态 API 职责表) */}
      <Card className="shadow-xs overflow-hidden flex min-w-0 flex-col p-4 shrink-0 gap-0">
        <CardHeader className="p-0 pb-3 flex flex-col sm:flex-row sm:items-center sm:justify-between space-y-0 shrink-0 gap-2">
          <div className="flex items-center gap-2.5 flex-wrap">
            <Server className="size-4 text-muted-foreground" />
            <CardTitle className="text-[16px] leading-[24px] font-medium text-foreground">
              后台任务
            </CardTitle>
            {currentCollector?.error ? (
              <Badge variant="destructive" className="text-[12px] h-5 px-1.5 font-medium">
                采集确认异常
              </Badge>
            ) : currentCollector?.state === "active" ? (
              <Badge variant="outline" className="text-[12px] h-5 px-1.5 font-medium text-emerald-600 dark:text-emerald-400 border-emerald-500/30 bg-emerald-500/10">
                采集器活跃
              </Badge>
            ) : currentCollector?.state === "stale" ? (
              <Badge variant="destructive" className="text-[12px] h-5 px-1.5 font-medium">
                采集器心跳延迟
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[12px] h-5 px-1.5 font-medium text-muted-foreground">
                采集器待确认
              </Badge>
            )}
            {healthOk === true ? (
              <Badge
                variant="outline"
                className="text-[12px] leading-[16px] h-5 px-1.5 font-medium text-emerald-600 dark:text-emerald-400 border-emerald-500/30 bg-emerald-500/10 flex items-center gap-1"
              >
                <CheckCircle2 className="size-3" />
                探针就绪
              </Badge>
            ) : healthOk === false ? (
              <Badge
                variant="destructive"
                className="text-[12px] leading-[16px] h-5 px-1.5 font-medium flex items-center gap-1"
              >
                <AlertCircle className="size-3" />
                探针异常
              </Badge>
            ) : null}
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <span className="text-[12px] leading-[16px] text-muted-foreground font-mono tabular-nums">
              探针时间: {formatBeijingTime(lastCheckMs)}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="text-[12px] leading-[16px] h-7 px-2.5 gap-1.5 cursor-pointer"
              onClick={checkHealth}
              disabled={checking}
              aria-label="执行健康检查探针"
            >
              <RefreshCw className={cn("size-3.5", checking && "animate-spin")} />
              <span>探针检测</span>
            </Button>
          </div>
        </CardHeader>

        {currentCollector?.error && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-2.5 mb-2.5 text-destructive text-[12px] flex items-center gap-2">
            <AlertCircle className="size-4 shrink-0" />
            <span>采集确认异常：{currentCollector.error}</span>
          </div>
        )}

        {servicesError && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 mb-3 text-destructive text-[13px] flex items-center gap-2">
            <AlertCircle className="size-4 shrink-0" />
            <span>获取后台服务状态失败：{servicesError}</span>
          </div>
        )}

        <CardContent className="p-0 flex flex-col">
          <div className="rounded-lg border border-border bg-card overflow-hidden [&_[data-slot=table-container]]:max-h-[380px] [&_[data-slot=table-container]]:overflow-y-auto">
            <Table className="table-fixed text-sm" style={{ width: "100%", minWidth: `${servicesTableMinPx}px` }}>
              <colgroup>
                <col style={{ width: "160px" }} />
                <col style={{ width: "110px" }} />
                <col style={{ width: "130px" }} />
                <col style={{ width: "90px" }} />
                <col style={{ width: `${matrixColWidthPx}px` }} />
              </colgroup>
              <TableHeader className="bg-muted/50 sticky top-0 z-20 backdrop-blur-xs">
                <TableRow className="hover:bg-transparent border-b border-border h-8">
                  <TableHead className="h-8 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground text-left whitespace-nowrap">
                    后台任务
                  </TableHead>
                  <TableHead className="h-8 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground text-left whitespace-nowrap">
                    调度周期
                  </TableHead>
                  <TableHead className="h-8 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground text-left whitespace-nowrap">
                    最近执行
                  </TableHead>
                  <TableHead className="h-8 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground text-left whitespace-nowrap">
                    当前状态
                  </TableHead>
                  <TableHead className="h-8 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground text-left whitespace-nowrap">
                    分时状态（{serviceSlots} 格{bucketMinutes != null ? ` · 每格 ${bucketMinutes} 分钟` : ""}）
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {servicesLoading && !servicesData ? (
                  <TableRow>
                    <TableCell colSpan={5} className="h-32 text-center text-muted-foreground text-[13px]">
                      <div className="flex items-center justify-center gap-2">
                        <RefreshCw className="size-4 animate-spin text-muted-foreground" />
                        <span>正在加载后台服务状态...</span>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : services.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="h-32 text-center text-muted-foreground text-[13px]">
                      暂无后台任务状态上报
                    </TableCell>
                  </TableRow>
                ) : (
                  services.map((svc) => {
                    const isOk = svc.state === "ok"
                    const isWarn = svc.state === "warn"
                    const isFail = svc.state === "fail"
                    const isDisabled = svc.state === "disabled"

                    const badgeVariant = isFail ? "destructive" : "outline"
                    const badgeClass = isOk
                      ? "text-emerald-600 dark:text-emerald-400 border-emerald-500/30 bg-emerald-500/10"
                      : isWarn
                      ? "text-amber-600 dark:text-amber-400 border-amber-500/30 bg-amber-500/10"
                      : isFail
                      ? ""
                      : isDisabled
                      ? "text-muted-foreground border-border bg-muted/30"
                      : "text-muted-foreground border-border"

                    return (
                      <TableRow key={svc.id} className="h-9 hover:bg-muted/40 transition-colors border-b border-border/60">
                        <TableCell className="px-3 py-1 font-medium text-[13px] leading-[18px] text-foreground truncate" title={svc.label}>
                          {svc.label}
                        </TableCell>

                        <TableCell className="px-3 py-1 font-mono text-[12px] leading-[16px] text-muted-foreground whitespace-nowrap">
                          {svc.interval_minutes != null ? `${svc.interval_minutes} 分钟` : "—"}
                        </TableCell>

                        <TableCell className="px-3 py-1 font-mono text-[12px] leading-[16px] text-muted-foreground whitespace-nowrap">
                          {svc.last_finished_at ? formatTimestampShort(svc.last_finished_at) : "未执行"}
                          {svc.last_status && svc.last_status !== "ok" && (
                            <span className="ml-1 text-[11px] text-amber-600">({svc.last_status})</span>
                          )}
                        </TableCell>

                        <TableCell className="px-3 py-1 whitespace-nowrap">
                          <Badge variant={badgeVariant} className={cn("text-[12px] h-5 px-1.5 font-medium", badgeClass)}>
                            {SERVICE_STATE_LABEL[svc.state] || svc.state}
                          </Badge>
                        </TableCell>

                        <TableCell className="px-3 py-1 align-middle">
                          <div className="flex items-center gap-[1px] h-4.5 w-full" style={{ minWidth: `${matrixContentMinPx}px` }} role="img" aria-label={`${svc.label} 运行分时状态`}>
                            {svc.buckets.map((b, idx) => (
                              <Tooltip key={b.from ?? idx}>
                                <TooltipTrigger
                                  render={
                                    <span
                                      className={cn(
                                        "flex-1 basis-0 h-3.5 rounded-[1px] transition-opacity hover:opacity-80 cursor-pointer",
                                        bucketMinWidthPx === 3 ? "min-w-[3px]" : "min-w-[2px]",
                                        b.state === "none" && "shadow-[inset_0_0_0_1px_var(--border)]",
                                        b.state === "unknown" && "health-pattern-unknown"
                                      )}
                                      style={{ backgroundColor: SERVICE_STATE_COLOR[b.state] }}
                                    />
                                  }
                                />
                                <TooltipContent side="top" sideOffset={4} className="flex flex-col gap-1 text-[12px] max-w-xs z-50">
                                  <div className="font-semibold text-foreground flex items-center justify-between gap-2">
                                    <span>{formatTimestampShort(b.from)} - {formatTimestampShort(b.to)}</span>
                                    <Badge variant="outline" className="text-[11px] h-4.5 px-1 font-medium">
                                      {SERVICE_STATE_LABEL[b.state] || b.state}
                                    </Badge>
                                  </div>
                                  <div className="text-muted-foreground">
                                    {b.runs === 0 ? "该槽位未运行" : `执行 ${b.runs} 次 · 失败 ${b.failures} · 部分 ${b.partial}`}
                                  </div>
                                </TooltipContent>
                              </Tooltip>
                            ))}
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>
          </div>

          {/* 状态图例 */}
          <div className="flex items-center justify-between text-[12px] leading-[16px] text-muted-foreground flex-wrap gap-2 pt-2 px-1">
            <div className="flex items-center gap-3.5 flex-wrap">
              <span className="font-medium text-foreground">状态图例：</span>
              {(["ok", "warn", "fail", "unknown", "none"] as const).map((st) => (
                <div key={st} className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      "size-2.5 rounded-[1px] shrink-0",
                      st === "unknown" && "health-pattern-unknown",
                      st === "none" && "border border-border/80"
                    )}
                    style={{ backgroundColor: SERVICE_STATE_COLOR[st] }}
                  />
                  <span>{SERVICE_STATE_LABEL[st]}</span>
                </div>
              ))}
            </div>
            <span className="text-muted-foreground/80">
              空白：未记录运行
            </span>
          </div>
        </CardContent>
      </Card>

      {/* 2. 入口 Nginx HTTP 错误分时柱图 */}
      <Card className="shadow-xs overflow-hidden flex flex-col p-4 shrink-0">
        <CardHeader className="p-0 pb-3 flex flex-col sm:flex-row sm:items-center sm:justify-between space-y-0 shrink-0 gap-2">
          <div className="flex items-center gap-2">
            <Activity className="size-4 text-muted-foreground" />
            <CardTitle className="text-[16px] leading-[24px] font-medium text-foreground">
              入口错误
            </CardTitle>
            <Badge variant="outline" className="text-[12px] leading-[16px] h-5 px-1.5 font-medium text-muted-foreground border-border bg-muted/30">
              Nginx 4xx / 5xx
            </Badge>
          </div>

          <span className="text-[12px] leading-[16px] text-muted-foreground font-mono tabular-nums">
            {errorsLoading
              ? "加载错误数据…"
              : errorsData
              ? `合计: ${formatNumber(errorsData.total)} 错误`
              : "暂无数据"}
          </span>
        </CardHeader>

        {errorsError && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 mb-3 text-destructive text-[13px] flex items-center gap-2">
            <AlertCircle className="size-4 shrink-0" />
            <span>加载 HTTP 错误失败：{errorsError}</span>
          </div>
        )}

        <CardContent className="p-0 flex flex-col">
          <div className="h-[220px] w-full min-w-0">
            {errorsLoading && !errorsData ? (
              <div className="h-full flex items-center justify-center text-muted-foreground text-[13px]">
                <RefreshCw className="size-4 animate-spin mr-2" />
                正在加载错误统计…
              </div>
            ) : chartData.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-muted-foreground gap-1.5">
                <Inbox className="size-5 opacity-40" />
                <span className="text-[13px]">{errorsError ? "入口错误数据暂不可用" : errorsData?.available === false ? "尚未采集入口错误" : "所选区间暂无入口错误"}</span>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" strokeOpacity={0.6} />
                  <XAxis
                    dataKey="displayLabel"
                    tickLine={false}
                    axisLine={{ stroke: "var(--border)" }}
                    tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    width={40}
                    tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
                    tickFormatter={(val) => (val >= 1000 ? `${(val / 1000).toFixed(0)}k` : String(val))}
                  />
                  <RechartsTooltip cursor={{ fill: "var(--muted)", fillOpacity: 0.35, stroke: "none" }}
                    content={({ active, payload }) => {
                      if (!active || !payload || !payload.length) return null
                      const point = payload[0].payload
                      return (
                        <div className="rounded-lg border border-border bg-card p-2.5 text-[12px] leading-[16px] shadow-md space-y-1.5 min-w-[180px]">
                          <div className="font-medium text-foreground border-b border-border pb-1">
                            {point.label}
                          </div>
                          <div className="space-y-1">
                            <div className="flex items-center justify-between text-amber-600 dark:text-amber-400">
                              <span>客户端 4xx:</span>
                              <span className="font-mono font-semibold tabular-nums">{formatNumber(point.s4xx)}</span>
                            </div>
                            <div className="flex items-center justify-between text-rose-600 dark:text-rose-400">
                              <span>服务端 5xx:</span>
                              <span className="font-mono font-semibold tabular-nums">{formatNumber(point.s5xx)}</span>
                            </div>
                            <div className="flex items-center justify-between text-foreground font-medium pt-1 border-t border-border">
                              <span>错误总计:</span>
                              <span className="font-mono font-semibold tabular-nums">{formatNumber(point.total)}</span>
                            </div>
                          </div>
                        </div>
                      )
                    }}
                  />
                  <Bar dataKey="s4xx" name="4xx 客户端错误" stackId="err" fill="var(--chart-3)" stroke="none" radius={[0, 0, 0, 0]} isAnimationActive={false} />
                  <Bar dataKey="s5xx" name="5xx 服务端错误" stackId="err" fill="var(--chart-5)" stroke="none" radius={[2, 2, 0, 0]} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
