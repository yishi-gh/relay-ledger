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
import {
  Database,
  Clock,
  AlertTriangle,
  AlertCircle,
  Info,
  Activity,
  Inbox,
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
  formatPercent,
  formatTimestamp,
  formatTimestampShort,
} from "@/lib/formatters"
import {
  fetchErrors,
  getMockErrors,
  type ErrorsPayload,
  type DateRange,
  type RangeType,
} from "@/lib/api"
import { cn } from "@/lib/utils"
import type { UpstreamAccount } from "@/components/upstreams-view"

export interface JobRun {
  job: string
  started_at: number
  finished_at: number
  status: "ok" | "complete" | "partial" | "error" | string
  detail?: string
}

export interface CollectError {
  account_id: string
  name?: string
  reason: string
  at: number
}

export interface QualityData {
  source_last_t?: number | null
  source_rows?: number | null
  error_rows?: number | null
  job_runs?: JobRun[]
  collect_errors?: CollectError[]
  schema_ok?: boolean
  checked_at?: number | null
}

interface QualityViewProps {
  quality: QualityData
  accounts: UpstreamAccount[]
  dateRange?: DateRange | null
  timeRange?: RangeType
  previewMode?: boolean
}

function formatTimeOnly(ms: number | null | undefined): string {
  if (!ms) return "—"
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function QualityView({
  quality,
  accounts,
  dateRange,
  timeRange = "24h",
  previewMode = false,
}: QualityViewProps) {
  const [errorsData, setErrorsData] = React.useState<ErrorsPayload | null>(null)
  const [notReady, setNotReady] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    setNotReady(false)

    async function load() {
      if (!dateRange) {
        if (previewMode) {
          setErrorsData(getMockErrors({ from: 0, to: Date.now() }))
        }
        return
      }

      try {
        const res = await fetchErrors(dateRange)
        if (cancelled) return
        setErrorsData(res)
      } catch {
        if (cancelled) return
        if (previewMode) {
          setErrorsData(getMockErrors(dateRange))
        } else {
          setNotReady(true)
          setErrorsData(null)
        }
      }
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [dateRange, previewMode])

  const recentRuns = React.useMemo(() => {
    return (quality.job_runs || []).slice(0, 6)
  }, [quality.job_runs])

  // not_configured 不是失败：它表示该账户本来就没有会话数据源（如只给了永久 API Key），
  // 把它算进「采集失败」会让每天都有假告警。
  const errors = (quality.collect_errors || []).filter(
    (e) => e.reason !== "not_configured"
  )

  const unavailableAccounts = React.useMemo(() => {
    return accounts.filter((a) => a.status === "unavailable")
  }, [accounts])

  const displayAccounts = unavailableAccounts.slice(0, 6)
  const remainingCount =
    unavailableAccounts.length > 6 ? unavailableAccounts.length - 6 : 0

  const chartBuckets = React.useMemo(() => {
    if (!errorsData?.buckets) return []
    return errorsData.buckets.map((b) => {
      const shortLabel =
        timeRange === "24h"
          ? b.label.split(" ")[1] ?? b.label
          : b.label.slice(5)
      return {
        ...b,
        shortLabel,
      }
    })
  }, [errorsData, timeRange])

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-3.5">
      {/* 1. 顶部 4 张运维基础卡片（一屏自适应） */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3.5 min-h-0 flex-1">
        {/* 卡 1: 数据源 */}
        <Card className="shadow-xs overflow-hidden flex flex-col p-4 h-full min-h-0">
          <CardHeader className="p-0 pb-2.5 shrink-0">
            <div className="flex items-center justify-between">
              <CardTitle className="text-[16px] leading-[24px] font-medium text-foreground">
                数据源
              </CardTitle>
              <Database className="size-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent className="p-0 flex-1 min-h-0 flex flex-col justify-between">
            <div className="grid grid-cols-2 gap-2 flex-1 min-h-0 auto-rows-fr">
              <div className="rounded-lg border border-border/70 bg-muted/20 p-2.5 flex flex-col justify-center">
                <span className="text-[12px] leading-[16px] text-muted-foreground font-medium">
                  最新数据时间
                </span>
                <span className="text-[12px] leading-[16px] font-mono tabular-nums font-semibold text-foreground mt-1 truncate" title={formatTimestamp(quality.source_last_t)}>
                  {formatTimestampShort(quality.source_last_t)}
                </span>
              </div>

              <div className="rounded-lg border border-border/70 bg-muted/20 p-2.5 flex flex-col justify-center">
                <span className="text-[12px] leading-[16px] text-muted-foreground font-medium">
                  总行数
                </span>
                <span className="text-[18px] leading-[24px] font-mono tabular-nums font-semibold text-foreground mt-1">
                  {formatNumber(quality.source_rows)}
                </span>
              </div>

              <div className="rounded-lg border border-border/70 bg-muted/20 p-2.5 flex flex-col justify-center">
                <span className="text-[12px] leading-[16px] text-muted-foreground font-medium">
                  错误行
                </span>
                <span
                  className={cn(
                    "text-[18px] leading-[24px] font-mono tabular-nums font-semibold mt-1",
                    (quality.error_rows ?? 0) > 0
                      ? "text-rose-600 dark:text-rose-400"
                      : "text-foreground"
                  )}
                >
                  {formatNumber(quality.error_rows)}
                </span>
              </div>

              <div className="rounded-lg border border-border/70 bg-muted/20 p-2.5 flex flex-col justify-center">
                <span className="text-[12px] leading-[16px] text-muted-foreground font-medium">
                  Schema 状态
                </span>
                <div className="mt-1">
                  {quality.schema_ok ? (
                    <Badge
                      variant="outline"
                      className="text-[12px] leading-[16px] h-5 px-1.5 font-medium text-emerald-600 dark:text-emerald-400 border-emerald-500/30 bg-emerald-500/10"
                    >
                      结构正常
                    </Badge>
                  ) : (
                    <Badge
                      variant="destructive"
                      className="text-[12px] leading-[16px] h-5 px-1.5 font-medium"
                    >
                      校验异常
                    </Badge>
                  )}
                </div>
              </div>
            </div>

            <div className="mt-2 shrink-0 text-[12px] leading-[16px] text-muted-foreground truncate">
              校验于{" "}
              <span className="font-mono tabular-nums text-foreground">
                {formatTimestampShort(quality.checked_at)}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* 卡 2: 采集任务 */}
        <Card className="shadow-xs overflow-hidden flex flex-col p-4 h-full min-h-0">
          <CardHeader className="p-0 pb-2.5 shrink-0">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CardTitle className="text-[16px] leading-[24px] font-medium text-foreground">
                  采集任务
                </CardTitle>
                <Badge
                  variant="secondary"
                  className="text-[12px] leading-[16px] h-5 px-1.5 font-medium tabular-nums"
                >
                  最近 {recentRuns.length} 条
                </Badge>
              </div>
              <Clock className="size-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent className="p-0 flex-1 min-h-0 flex flex-col">
            <div className="rounded-lg border border-border bg-card flex-1 min-h-0 overflow-auto">
              <Table className="w-full table-fixed text-sm">
                <colgroup>
                  <col style={{ width: "38%" }} />
                  <col style={{ width: "20%" }} />
                  <col style={{ width: "22%" }} />
                  <col style={{ width: "20%" }} />
                </colgroup>
                <TableHeader className="bg-muted/50 sticky top-0 z-20 backdrop-blur-xs">
                  <TableRow className="hover:bg-transparent border-b border-border">
                    <TableHead className="h-7 px-2 text-[12px] leading-[16px] font-medium text-muted-foreground text-left whitespace-nowrap">
                      任务
                    </TableHead>
                    <TableHead className="h-7 px-2 text-[12px] leading-[16px] font-medium text-muted-foreground text-left whitespace-nowrap">
                      时间
                    </TableHead>
                    <TableHead className="h-7 px-2 text-[12px] leading-[16px] font-medium text-muted-foreground text-right whitespace-nowrap">
                      耗时
                    </TableHead>
                    <TableHead className="h-7 px-2 text-[12px] leading-[16px] font-medium text-muted-foreground text-right whitespace-nowrap">
                      状态
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentRuns.map((run, idx) => {
                    const durationSec =
                      run.finished_at && run.started_at
                        ? ((run.finished_at - run.started_at) / 1000).toFixed(1)
                        : null
                    return (
                      <TableRow
                        key={idx}
                        className="h-[36px] hover:bg-muted/40 transition-colors border-b border-border/60"
                      >
                        <TableCell
                          className="px-2 py-0.5 font-mono text-[12px] leading-[16px] text-foreground truncate"
                          title={run.job}
                        >
                          {run.job}
                        </TableCell>
                        <TableCell
                          className="px-2 py-0.5 font-mono tabular-nums text-[12px] leading-[16px] text-muted-foreground whitespace-nowrap"
                          title={formatTimestamp(run.started_at)}
                        >
                          {formatTimeOnly(run.started_at)}
                        </TableCell>
                        <TableCell className="px-2 py-0.5 text-right font-mono tabular-nums text-[12px] leading-[16px] text-foreground whitespace-nowrap">
                          {durationSec != null ? `${durationSec}s` : "—"}
                        </TableCell>
                        <TableCell className="px-2 py-0.5 text-right whitespace-nowrap">
                          {run.status === "complete" || run.status === "ok" ? (
                            <Badge
                              variant="outline"
                              className="text-[12px] leading-[16px] h-5 px-1 font-medium text-emerald-600 dark:text-emerald-400 border-emerald-500/30 bg-emerald-500/10"
                            >
                              完成
                            </Badge>
                          ) : run.status === "partial" ? (
                            <Badge
                              variant="outline"
                              className="text-[12px] leading-[16px] h-5 px-1 font-medium text-amber-600 dark:text-amber-400 border-amber-500/30 bg-amber-500/10"
                            >
                              部分
                            </Badge>
                          ) : (
                            <Badge
                              variant="destructive"
                              className="text-[12px] leading-[16px] h-5 px-1 font-medium"
                            >
                              失败
                            </Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        {/* 卡 3: 采集失败 */}
        <Card className="shadow-xs overflow-hidden flex flex-col p-4 h-full min-h-0">
          <CardHeader className="p-0 pb-2.5 shrink-0">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CardTitle className="text-[16px] leading-[24px] font-medium text-foreground">
                  采集失败
                </CardTitle>
                {errors.length > 0 && (
                  <Badge
                    variant="destructive"
                    className="text-[12px] leading-[16px] h-5 px-1.5 font-medium tabular-nums"
                  >
                    {errors.length} 项
                  </Badge>
                )}
              </div>
              <AlertTriangle className="size-4 text-amber-500" />
            </div>
          </CardHeader>
          <CardContent className="p-0 flex-1 min-h-0 flex flex-col">
            {errors.length === 0 ? (
              <div className="flex-1 flex items-center justify-center rounded-lg border border-dashed border-border/70 bg-muted/10 text-muted-foreground text-[14px] leading-[20px]">
                无失败记录
              </div>
            ) : (
              <div className="rounded-lg border border-border bg-card flex-1 min-h-0 overflow-auto">
                <Table className="w-full table-fixed text-sm">
                  <colgroup>
                    <col style={{ width: "42%" }} />
                    <col style={{ width: "30%" }} />
                    <col style={{ width: "28%" }} />
                  </colgroup>
                  <TableHeader className="bg-muted/50 sticky top-0 z-20 backdrop-blur-xs">
                    <TableRow className="hover:bg-transparent border-b border-border">
                      <TableHead className="h-7 px-2 text-[12px] leading-[16px] font-medium text-muted-foreground text-left whitespace-nowrap">
                        账户
                      </TableHead>
                      <TableHead className="h-7 px-2 text-[12px] leading-[16px] font-medium text-muted-foreground text-left whitespace-nowrap">
                        原因
                      </TableHead>
                      <TableHead className="h-7 px-2 text-[12px] leading-[16px] font-medium text-muted-foreground text-right whitespace-nowrap">
                        时间
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {errors.map((err, idx) => (
                      <TableRow
                        key={idx}
                        className="h-[36px] hover:bg-muted/40 transition-colors border-b border-border/60"
                      >
                        <TableCell
                          className="px-2 py-0.5 font-normal text-[12px] leading-[16px] text-foreground truncate"
                          title={err.name || err.account_id}
                        >
                          {err.name || err.account_id}
                        </TableCell>
                        <TableCell
                          className="px-2 py-0.5 text-muted-foreground text-[12px] leading-[16px] truncate"
                          title={err.reason}
                        >
                          <Badge
                            variant="outline"
                            className="text-[12px] leading-[16px] h-5 px-1 font-normal text-amber-600 dark:text-amber-400 border-amber-500/30"
                          >
                            {err.reason}
                          </Badge>
                        </TableCell>
                        <TableCell className="px-2 py-0.5 text-right font-mono tabular-nums text-[12px] leading-[16px] text-muted-foreground whitespace-nowrap">
                          {formatTimestampShort(err.at)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* 卡 4: 缺快照提示 */}
        <Card className="shadow-xs overflow-hidden flex flex-col p-4 h-full min-h-0">
          <CardHeader className="p-0 pb-2.5 shrink-0">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CardTitle className="text-[16px] leading-[24px] font-medium text-foreground">
                  缺快照提示
                </CardTitle>
                <Badge
                  variant="outline"
                  className="text-[12px] leading-[16px] h-5 px-1.5 font-medium tabular-nums text-muted-foreground border-border bg-muted/30"
                >
                  {unavailableAccounts.length} 个账户
                </Badge>
              </div>
              <AlertCircle className="size-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent className="p-0 flex-1 min-h-0 flex flex-col justify-between gap-2.5">
            <div className="rounded-lg border border-border/70 bg-muted/30 p-2.5 flex items-start gap-2 shrink-0">
              <Info className="size-4 text-muted-foreground shrink-0 mt-0.5" />
              <div className="text-[12px] leading-[16px] text-muted-foreground font-normal">
                快照缺失只影响成本核算，不影响售出
              </div>
            </div>

            <div className="flex-1 min-h-0 flex flex-col justify-start">
              <div className="text-[12px] leading-[16px] text-muted-foreground font-medium mb-1.5 shrink-0">
                缺失快照账户：
              </div>
              {unavailableAccounts.length === 0 ? (
                <div className="text-[12px] leading-[16px] text-muted-foreground py-1">
                  当前周期内暂无缺失快照账户
                </div>
              ) : (
                <div className="flex flex-wrap gap-1.5 overflow-y-auto max-h-[110px] p-0.5">
                  {displayAccounts.map((acc) => (
                    <Badge
                      key={acc.id}
                      variant="secondary"
                      className="text-[12px] leading-[16px] py-0.5 px-2 font-normal text-foreground"
                      title={acc.name || acc.id}
                    >
                      {acc.name || acc.id}
                    </Badge>
                  ))}
                  {remainingCount > 0 && (
                    <Badge
                      variant="outline"
                      className="text-[12px] leading-[16px] py-0.5 px-2 font-normal text-muted-foreground border-border bg-muted/20"
                    >
                      另有 {remainingCount} 个
                    </Badge>
                  )}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 2. 补一张「HTTP 错误」卡片（整幅排布在下方） */}
      <Card className="shadow-xs overflow-hidden flex flex-col p-4 flex-1 min-h-0">
        <CardHeader className="p-0 pb-2.5 shrink-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CardTitle className="text-[16px] leading-[24px] font-medium text-foreground">
                HTTP 错误
              </CardTitle>
              {errorsData?.available && (
                <Badge
                  variant="secondary"
                  className="text-[12px] leading-[16px] h-5 px-1.5 font-medium tabular-nums"
                >
                  总计 {formatNumber(errorsData.total)} 次
                </Badge>
              )}
            </div>
            <Activity className="size-4 text-muted-foreground" />
          </div>
        </CardHeader>

        <CardContent className="p-0 flex-1 min-h-0 flex flex-col">
          {notReady ? (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center rounded-lg border border-dashed border-border/70 bg-muted/10">
              <AlertCircle className="size-8 text-muted-foreground/60 mb-2" />
              <span className="text-[14px] leading-[20px] font-medium text-foreground">
                接口未就绪
              </span>
              <span className="text-[12px] leading-[16px] text-muted-foreground mt-1">
                /api/errors 接口服务尚未上线或连接失败，单接口异常不影响整页其它模块
              </span>
            </div>
          ) : !errorsData?.available ? (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center rounded-lg border border-dashed border-border/70 bg-muted/10">
              <Inbox className="size-8 text-muted-foreground/40 mb-2" />
              <span className="text-[14px] leading-[20px] font-medium text-foreground">
                该区间没有错误记录
              </span>
              <span className="text-[12px] leading-[16px] text-muted-foreground mt-1">
                当前选定时间窗口内 HTTP 状态码均为正常成功请求
              </span>
            </div>
          ) : (
            <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12 gap-3.5">
              {/* 左侧：Hourly 堆叠柱状图（4xx 灰蓝 / 5xx 红） */}
              <div className="lg:col-span-7 xl:col-span-8 flex flex-col min-h-0">
                <div className="flex items-center justify-between mb-1.5 shrink-0">
                  <span className="text-[12px] leading-[16px] font-medium text-muted-foreground">
                    小时级错误分布 (4xx / 5xx)
                  </span>
                  <div className="flex items-center gap-3 text-[12px] leading-[16px] text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="size-2 rounded-xs bg-[var(--chart-11)] shrink-0" />
                      4xx (客户端错误)
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="size-2 rounded-xs bg-[var(--chart-5)] shrink-0" />
                      5xx (服务端错误)
                    </span>
                  </div>
                </div>

                <div className="flex-1 min-h-[160px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={chartBuckets}
                      margin={{ top: 8, right: 8, left: -20, bottom: 0 }}
                    >
                      <CartesianGrid
                        strokeDasharray="3 3"
                        vertical={false}
                        stroke="var(--border)"
                        strokeOpacity={0.6}
                      />
                      <XAxis
                        dataKey="shortLabel"
                        tickLine={false}
                        axisLine={{ stroke: "var(--border)" }}
                        tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
                      />
                      <YAxis
                        tickLine={false}
                        axisLine={false}
                        width={36}
                        tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
                        allowDecimals={false}
                      />
                      <RechartsTooltip
                        content={({ active, payload }) => {
                          if (!active || !payload || !payload.length) return null
                          const d = payload[0].payload
                          return (
                            <div className="rounded-lg border border-border bg-card p-2.5 text-[12px] leading-[16px] shadow-md space-y-1 min-w-[150px]">
                              <div className="font-medium text-foreground border-b border-border pb-1">
                                {d.label}
                              </div>
                              <div className="flex items-center justify-between text-muted-foreground">
                                <span className="inline-flex items-center gap-1">
                                  <span className="size-2 rounded-xs bg-[var(--chart-11)]" />
                                  4xx 错误
                                </span>
                                <span className="font-mono tabular-nums text-foreground font-semibold">
                                  {d.s4xx} 次
                                </span>
                              </div>
                              <div className="flex items-center justify-between text-muted-foreground">
                                <span className="inline-flex items-center gap-1">
                                  <span className="size-2 rounded-xs bg-[var(--chart-5)]" />
                                  5xx 错误
                                </span>
                                <span className="font-mono tabular-nums text-foreground font-semibold">
                                  {d.s5xx} 次
                                </span>
                              </div>
                              <div className="flex items-center justify-between text-muted-foreground border-t border-border/60 pt-1">
                                <span>合计错误</span>
                                <span className="font-mono tabular-nums text-foreground font-semibold">
                                  {d.total} 次
                                </span>
                              </div>
                            </div>
                          )
                        }}
                      />
                      <Bar
                        dataKey="s4xx"
                        name="4xx"
                        stackId="a"
                        fill="var(--chart-11)"
                        radius={[0, 0, 0, 0]}
                      />
                      <Bar
                        dataKey="s5xx"
                        name="5xx"
                        stackId="a"
                        fill="var(--chart-5)"
                        radius={[2, 2, 0, 0]}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* 右侧：两小块表（Top 状态码与按路径前缀） */}
              <div className="lg:col-span-5 xl:col-span-4 flex flex-col justify-between gap-2 min-h-0 pr-0.5">
                {/* 小块 1: Top 状态码 */}
                <div className="rounded-lg border border-border bg-card p-2 flex flex-col gap-1 shrink-0">
                  <span className="text-[12px] leading-[16px] font-medium text-muted-foreground">
                    Top 状态码
                  </span>
                  <Table className="w-full table-fixed text-sm">
                    <colgroup>
                      <col style={{ width: "36%" }} />
                      <col style={{ width: "32%" }} />
                      <col style={{ width: "32%" }} />
                    </colgroup>
                    <TableHeader className="bg-muted/40">
                      <TableRow className="border-b border-border hover:bg-transparent">
                        <TableHead className="h-5 px-1.5 text-[12px] leading-[16px] font-medium text-muted-foreground text-left">
                          状态
                        </TableHead>
                        <TableHead className="h-5 px-1.5 text-[12px] leading-[16px] font-medium text-muted-foreground text-right">
                          次数
                        </TableHead>
                        <TableHead className="h-5 px-1.5 text-[12px] leading-[16px] font-medium text-muted-foreground text-right">
                          占比
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(errorsData.top_status || []).slice(0, 4).map((s) => (
                        <TableRow
                          key={s.status}
                          className="h-[28px] hover:bg-muted/30 border-b border-border/40"
                        >
                          <TableCell className="px-1.5 py-0">
                            <Badge
                              variant="outline"
                              className={cn(
                                "text-[12px] leading-[16px] h-4.5 px-1 font-mono font-medium",
                                s.status >= 500
                                  ? "text-rose-600 dark:text-rose-400 border-rose-500/30 bg-rose-500/10"
                                  : "text-sky-600 dark:text-sky-400 border-sky-500/30 bg-sky-500/10"
                              )}
                            >
                              {s.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="px-1.5 py-0 text-right font-mono tabular-nums text-[12px] leading-[16px] text-foreground">
                            {formatNumber(s.count)}
                          </TableCell>
                          <TableCell className="px-1.5 py-0 text-right font-mono tabular-nums text-[12px] leading-[16px] text-muted-foreground">
                            {formatPercent(s.share)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                {/* 小块 2: 按路径前缀 */}
                <div className="rounded-lg border border-border bg-card p-2 flex flex-col gap-1 shrink-0">
                  <span className="text-[12px] leading-[16px] font-medium text-muted-foreground">
                    按路径前缀
                  </span>
                  <Table className="w-full table-fixed text-sm">
                    <colgroup>
                      <col style={{ width: "36%" }} />
                      <col style={{ width: "32%" }} />
                      <col style={{ width: "32%" }} />
                    </colgroup>
                    <TableHeader className="bg-muted/40">
                      <TableRow className="border-b border-border hover:bg-transparent">
                        <TableHead className="h-5 px-1.5 text-[12px] leading-[16px] font-medium text-muted-foreground text-left">
                          前缀
                        </TableHead>
                        <TableHead className="h-5 px-1.5 text-[12px] leading-[16px] font-medium text-muted-foreground text-right">
                          次数
                        </TableHead>
                        <TableHead className="h-5 px-1.5 text-[12px] leading-[16px] font-medium text-muted-foreground text-right">
                          占比
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(errorsData.by_path_group || []).slice(0, 3).map((p) => (
                        <TableRow
                          key={p.path_group}
                          className="h-[28px] hover:bg-muted/30 border-b border-border/40"
                        >
                          <TableCell className="px-1.5 py-0 font-mono text-[12px] leading-[16px] text-foreground truncate">
                            {p.path_group}
                          </TableCell>
                          <TableCell className="px-1.5 py-0 text-right font-mono tabular-nums text-[12px] leading-[16px] text-foreground">
                            {formatNumber(p.count)}
                          </TableCell>
                          <TableCell className="px-1.5 py-0 text-right font-mono tabular-nums text-[12px] leading-[16px] text-muted-foreground">
                            {formatPercent(p.share)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
