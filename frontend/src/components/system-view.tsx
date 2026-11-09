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
  formatPercent,
} from "@/lib/formatters"
import { formatBeijingTime } from "@/components/top-bar"
import {
  fetchErrors,
  fetchHealthz,
  getMockErrors,
  type ErrorsPayload,
  type DateRange,
  type RangeType,
} from "@/lib/api"
import { cn } from "@/lib/utils"
import type { QualityData } from "@/components/quality-view"
import type { UpstreamAccount } from "@/components/upstreams-view"

interface ApiEndpointItem {
  path: string
  name: string
  interval: string
  description: string
}

const API_ENDPOINTS: ApiEndpointItem[] = [
  { path: "/api/healthz", name: "服务健康检查", interval: "实时探测", description: "后端单进程心跳探针与响应就绪检测" },
  { path: "/api/meta", name: "元数据与配置", interval: "15 分钟", description: "实例站点名、基础地址、币种汇率及数据边界" },
  { path: "/api/overview", name: "经营总览", interval: "15 分钟", description: "全站售出额、Token 消耗、请求总量与综合缓存率" },
  { path: "/api/trend", name: "售出趋势", interval: "15 分钟", description: "小时/自然日级售出金额堆叠与调用走势" },
  { path: "/api/profit", name: "盈利面板", interval: "15 分钟", description: "上游供应商账户成本、利润与毛利率账本对账" },
  { path: "/api/models", name: "模型经营", interval: "15 分钟", description: "按模型聚合售出、请求、Token 及每亿 Token 均价" },
  { path: "/api/channels", name: "渠道明细", interval: "15 分钟", description: "下游渠道经营表现、TPS 速率与延迟分位数" },
  { path: "/api/groups", name: "分组明细", interval: "15 分钟", description: "业务分组维度用量、售出额与渠道聚合明细" },
  { path: "/api/users", name: "用户排行", interval: "15 分钟", description: "下游调用用户售出贡献、请求量与 Token 消耗排行" },
  { path: "/api/capital", name: "资金与续航", interval: "15 分钟", description: "上游账户实时余额流水、7日日均消耗与续航天数" },
  { path: "/api/upstreams", name: "上游账户", interval: "15 分钟", description: "上游各供应商账户配置状态、渠道归属与期末余额" },
  { path: "/api/status", name: "可用性状态", interval: "15 分钟", description: "分时健康度状态条、成功与错误统计" },
  { path: "/api/quality", name: "数据质量", interval: "15 分钟", description: "日志同步任务、采集耗时、缺快照及 Schema 状态" },
  { path: "/api/errors", name: "HTTP 错误", interval: "15 分钟", description: "Nginx 4xx/5xx 小时分桶、Top 状态码与路径分布" },
]

export interface SystemViewProps {
  quality?: QualityData
  accounts?: UpstreamAccount[]
  dateRange?: DateRange | null
  timeRange?: RangeType
  previewMode?: boolean
  lastRefreshTime?: number
}

type ErrorsSnapshot =
  | { rangeKey: string; status: "ready"; data: ErrorsPayload; error: null }
  | { rangeKey: string; status: "error"; data: null; error: string }

export function SystemView({
  dateRange,
  timeRange = "24h",
  previewMode = false,
}: SystemViewProps) {
  // HTTP 错误数据快照：loading 由当前 range 与快照 key 的差异派生，避免在 effect 内同步 setState
  const [errorsSnapshot, setErrorsSnapshot] = React.useState<ErrorsSnapshot | null>(null)
  const errorsRangeKey = dateRange ? `${dateRange.from}:${dateRange.to}` : null
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

  // 接口健康探测状态
  const [healthOk, setHealthOk] = React.useState<boolean | null>(null)
  const [checking, setChecking] = React.useState(false)
  const [lastCheckMs, setLastCheckMs] = React.useState<number>(() => Date.now())

  // 执行接口健康探测（仅探测 /api/healthz）
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

  // 初始加载探测
  React.useEffect(() => {
    let cancelled = false

    void fetchHealthz()
      .then((res) => {
        if (cancelled) return
        setHealthOk(Boolean(res?.ok))
        setChecking(false)
        setLastCheckMs(Date.now())
      })
      .catch(() => {
        if (cancelled) return
        setHealthOk(false)
        setChecking(false)
        setLastCheckMs(Date.now())
      })

    return () => {
      cancelled = true
    }
  }, [])

  // 加载 HTTP 错误 (来自 Nginx 访问日志)：旧 range 的响应通过 cancelled 丢弃
  React.useEffect(() => {
    let cancelled = false

    if (!dateRange) {
      if (previewMode) {
        Promise.resolve().then(() => {
          if (cancelled) return
          setErrorsSnapshot({
            rangeKey: "preview",
            status: "ready",
            data: getMockErrors({ from: 0, to: Date.now() }),
            error: null,
          })
        })
      }
      return () => {
        cancelled = true
      }
    }

    const rangeKey = `${dateRange.from}:${dateRange.to}`

    void fetchErrors(dateRange)
      .then((res) => {
        if (cancelled) return
        setErrorsSnapshot({ rangeKey, status: "ready", data: res, error: null })
      })
      .catch((err) => {
        if (cancelled) return
        if (previewMode) {
          setErrorsSnapshot({
            rangeKey,
            status: "ready",
            data: getMockErrors(dateRange),
            error: null,
          })
        } else {
          setErrorsSnapshot({
            rangeKey,
            status: "error",
            data: null,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      })

    return () => {
      cancelled = true
    }
  }, [dateRange, previewMode])

  const chartBuckets = React.useMemo(() => {
    if (!errorsData?.buckets) return []
    return errorsData.buckets.map((b) => {
      const displayLabel =
        timeRange === "24h"
          ? b.label.split(" ")[1] ?? b.label
          : b.label.slice(5)
      return {
        ...b,
        displayLabel,
      }
    })
  }, [errorsData, timeRange])

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-4">
      {/* 1. 看板自身单进程 API 服务探测与端点清单 */}
      <Card className="shadow-xs overflow-hidden flex flex-col p-4 shrink-0">
        <CardHeader className="p-0 pb-3 flex flex-col sm:flex-row sm:items-center sm:justify-between space-y-0 shrink-0 gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <Server className="size-4 text-muted-foreground" />
            <CardTitle className="text-[16px] leading-[24px] font-medium text-foreground">
              系统服务状态与 API 端点清单
            </CardTitle>
            {healthOk === true ? (
              <Badge
                variant="outline"
                className="text-[12px] leading-[16px] h-5 px-1.5 font-medium text-emerald-600 dark:text-emerald-400 border-emerald-500/30 bg-emerald-500/10 flex items-center gap-1"
              >
                <CheckCircle2 className="size-3" />
                进程正常
              </Badge>
            ) : healthOk === false ? (
              <Badge
                variant="destructive"
                className="text-[12px] leading-[16px] h-5 px-1.5 font-medium flex items-center gap-1"
              >
                <AlertCircle className="size-3" />
                探测异常
              </Badge>
            ) : (
              <Badge variant="secondary" className="text-[12px] leading-[16px] h-5 px-1.5 font-medium">
                检测中...
              </Badge>
            )}
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <span className="text-[12px] leading-[16px] text-muted-foreground font-mono tabular-nums">
              最近探测: {formatBeijingTime(lastCheckMs)}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="text-[12px] leading-[16px] h-7 px-2.5 gap-1.5 cursor-pointer"
              onClick={checkHealth}
              disabled={checking}
            >
              <RefreshCw className={cn("size-3.5", checking && "animate-spin")} />
              <span>探测</span>
            </Button>
          </div>
        </CardHeader>

        <div className="mb-2.5 text-[12px] leading-[16px] text-muted-foreground">
          探测针对后端单进程服务 <span className="font-mono text-foreground font-medium">/api/healthz</span> 统一执行心跳探测；下方为本实例已挂载的核心路由清单与职责定义。
        </div>

        <CardContent className="p-0 flex flex-col">
          <div className="rounded-lg border border-border bg-card overflow-x-auto">
            <Table className="min-w-[680px] lg:min-w-full table-fixed text-sm">
              <colgroup>
                <col style={{ width: "22%" }} />
                <col style={{ width: "22%" }} />
                <col style={{ width: "16%" }} />
                <col style={{ width: "40%" }} />
              </colgroup>
              <TableHeader className="bg-muted/50 sticky top-0 z-20 backdrop-blur-xs">
                <TableRow className="hover:bg-transparent border-b border-border">
                  <TableHead className="h-8 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground text-left whitespace-nowrap">
                    接口路由
                  </TableHead>
                  <TableHead className="h-8 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground text-left whitespace-nowrap">
                    服务名称
                  </TableHead>
                  <TableHead className="h-8 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground text-left whitespace-nowrap">
                    刷新策略
                  </TableHead>
                  <TableHead className="h-8 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground text-left whitespace-nowrap">
                    功能定义与职责
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {API_ENDPOINTS.map((ep) => (
                  <TableRow
                    key={ep.path}
                    className="h-[38px] hover:bg-muted/40 transition-colors border-b border-border/60"
                  >
                    <TableCell className="px-3 py-1 font-mono text-[12px] leading-[16px] text-foreground font-medium truncate" title={ep.path}>
                      {ep.path}
                    </TableCell>
                    <TableCell className="px-3 py-1 text-[13px] leading-[18px] text-foreground font-normal truncate" title={ep.name}>
                      {ep.name}
                    </TableCell>
                    <TableCell className="px-3 py-1 font-mono tabular-nums text-[12px] leading-[16px] text-muted-foreground whitespace-nowrap">
                      {ep.interval}
                    </TableCell>
                    <TableCell className="px-3 py-1 text-[12px] leading-[16px] text-muted-foreground truncate" title={ep.description}>
                      {ep.description}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* 2. Nginx 入口 HTTP 错误监控（显式标明网关日志来源，与渠道业务 type=5 错误明确区分） */}
      <Card className="shadow-xs overflow-hidden flex flex-col p-4 shrink-0 min-h-[340px]">
        <CardHeader className="p-0 pb-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 space-y-0 shrink-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Activity className="size-4 text-muted-foreground" />
            <CardTitle className="text-[16px] leading-[24px] font-medium text-foreground">
              Nginx 入口 HTTP 错误监控
            </CardTitle>
            <Badge
              variant="outline"
              className="text-[12px] leading-[16px] h-5 px-1.5 font-normal text-muted-foreground border-border bg-muted/30"
            >
              来源: Nginx 访问日志 (http_errors_hourly)
            </Badge>
            {errorsData?.available && (
              <Badge
                variant="secondary"
                className="text-[12px] leading-[16px] h-5 px-1.5 font-medium tabular-nums"
              >
                总计 {formatNumber(errorsData.total)} 次
              </Badge>
            )}
          </div>

          <span className="text-[12px] leading-[16px] text-muted-foreground">
            覆盖 /v1、/api、other · 与渠道下游调用 type=5 业务错误互为独立数据链路
          </span>
        </CardHeader>

        <CardContent className="p-0 flex-1 min-h-0 flex flex-col">
          {errorsLoading ? (
            <div className="flex-1 flex items-center justify-center p-8 text-center text-muted-foreground text-[13px] leading-[18px]">
              加载中…
            </div>
          ) : errorsError ? (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center rounded-lg border border-dashed border-border/70 bg-muted/10">
              <AlertCircle className="size-8 text-destructive/70 mb-2" />
              <span className="text-[14px] leading-[20px] font-medium text-foreground">
                错误统计接口请求失败
              </span>
              <span className="text-[12px] leading-[16px] text-muted-foreground mt-1 max-w-md font-mono">
                {errorsError}
              </span>
            </div>
          ) : !errorsData ? (
            <div className="flex-1 flex items-center justify-center p-8 text-center text-muted-foreground text-[13px] leading-[18px]">
              加载中…
            </div>
          ) : !errorsData.available ? (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center rounded-lg border border-dashed border-border/70 bg-muted/10">
              <Inbox className="size-8 text-muted-foreground/40 mb-2" />
              <span className="text-[14px] leading-[20px] font-medium text-foreground">
                尚无已采集的 Nginx 错误日志数据
              </span>
              <span className="text-[12px] leading-[16px] text-muted-foreground mt-1">
                采集任务尚未运行或源访问日志暂无错误记录，不能推断请求全部成功
              </span>
            </div>
          ) : errorsData.total === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center rounded-lg border border-dashed border-border/70 bg-muted/10">
              <CheckCircle2 className="size-8 text-emerald-600/60 mb-2" />
              <span className="text-[14px] leading-[20px] font-medium text-foreground">
                该区间内无 4xx/5xx HTTP 错误记录
              </span>
              <span className="text-[12px] leading-[16px] text-muted-foreground mt-1">
                所选时间窗口内 Nginx 访问日志记录中未出现 4xx 客户端或 5xx 服务端错误
              </span>
            </div>
          ) : (
            <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12 gap-3.5">
              {/* 左侧：Hourly 堆叠柱状图 (对接真实字段 s4xx 与 s5xx) */}
              <div className="lg:col-span-7 xl:col-span-8 flex flex-col min-h-0">
                <div className="flex items-center justify-between mb-1.5 shrink-0">
                  <span className="text-[12px] leading-[16px] font-medium text-muted-foreground">
                    小时级错误分布 (4xx / 5xx)
                  </span>
                  <div className="flex items-center gap-3 text-[12px] leading-[16px] text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="size-2.5 rounded-xs bg-[var(--chart-11)] shrink-0" />
                      4xx (客户端错误)
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="size-2.5 rounded-xs bg-[var(--chart-5)] shrink-0" />
                      5xx (服务端错误)
                    </span>
                  </div>
                </div>

                <div className="h-[220px] w-full">
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
                        dataKey="displayLabel"
                        tickLine={false}
                        axisLine={{ stroke: "var(--border)" }}
                        tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
                      />
                      <YAxis
                        tickLine={false}
                        axisLine={false}
                        tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
                        allowDecimals={false}
                      />
                      <RechartsTooltip
                        content={({ active, payload }) => {
                          if (!active || !payload || !payload.length) return null
                          const dataPoint = payload[0].payload
                          return (
                            <div className="rounded-lg border border-border bg-card p-2.5 text-[12px] leading-[16px] shadow-md space-y-1.5 min-w-[150px]">
                              <div className="font-medium text-foreground border-b border-border pb-1">
                                {dataPoint.label}
                              </div>
                              <div className="flex items-center justify-between gap-3 text-muted-foreground pt-0.5">
                                <span className="flex items-center gap-1.5">
                                  <span className="size-2.5 rounded-xs bg-[var(--chart-11)]" />
                                  4xx 客户端错误:
                                </span>
                                <span className="font-mono tabular-nums text-foreground font-semibold">
                                  {formatNumber(dataPoint.s4xx)}
                                </span>
                              </div>
                              <div className="flex items-center justify-between gap-3 text-muted-foreground">
                                <span className="flex items-center gap-1.5">
                                  <span className="size-2.5 rounded-xs bg-[var(--chart-5)]" />
                                  5xx 服务端错误:
                                </span>
                                <span className="font-mono tabular-nums text-foreground font-semibold">
                                  {formatNumber(dataPoint.s5xx)}
                                </span>
                              </div>
                              <div className="flex items-center justify-between gap-3 text-muted-foreground border-t border-border/60 pt-1">
                                <span>合计错误:</span>
                                <span className="font-mono tabular-nums text-foreground font-semibold">
                                  {formatNumber(dataPoint.total)}
                                </span>
                              </div>
                            </div>
                          )
                        }}
                      />
                      <Bar
                        dataKey="s4xx"
                        name="4xx"
                        stackId="errors"
                        fill="var(--chart-11)"
                        radius={[0, 0, 0, 0]}
                        isAnimationActive={false}
                      />
                      <Bar
                        dataKey="s5xx"
                        name="5xx"
                        stackId="errors"
                        fill="var(--chart-5)"
                        radius={[2, 2, 0, 0]}
                        isAnimationActive={false}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* 右侧：Top 状态码与按路径前缀 */}
              <div className="lg:col-span-5 xl:col-span-4 flex flex-col gap-3 min-h-0 border-t lg:border-t-0 lg:border-l border-border/70 lg:pl-3.5 pt-2 lg:pt-0">
                <div className="flex-1 min-h-0 flex flex-col">
                  <span className="text-[12px] leading-[16px] font-medium text-muted-foreground mb-1.5 shrink-0">
                    Top 错误状态码
                  </span>
                  <div className="flex-1 min-h-0 overflow-y-auto max-h-[120px]">
                    <Table className="w-full table-fixed text-sm">
                      <TableHeader className="bg-muted/40 sticky top-0 backdrop-blur-xs">
                        <TableRow className="border-b border-border h-7">
                          <TableHead className="h-7 px-2.5 text-[12px] leading-[16px] text-muted-foreground">状态码</TableHead>
                          <TableHead className="h-7 px-2.5 text-[12px] leading-[16px] text-muted-foreground text-right">频次</TableHead>
                          <TableHead className="h-7 px-2.5 text-[12px] leading-[16px] text-muted-foreground text-right">占比</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(errorsData.top_status || []).slice(0, 5).map((s) => (
                          <TableRow key={s.status} className="h-8 border-b border-border/50">
                            <TableCell className="px-2.5 py-1 font-mono text-[12px]">
                              <Badge
                                variant={s.status >= 500 ? "destructive" : "outline"}
                                className="text-[11px] leading-[14px] h-4.5 px-1.5"
                              >
                                {s.status}
                              </Badge>
                            </TableCell>
                            <TableCell className="px-2.5 py-1 text-right font-mono tabular-nums text-[12px]">
                              {formatNumber(s.count)}
                            </TableCell>
                            <TableCell className="px-2.5 py-1 text-right font-mono tabular-nums text-[12px] text-muted-foreground">
                              {formatPercent(s.share)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>

                <div className="flex-1 min-h-0 flex flex-col">
                  <span className="text-[12px] leading-[16px] font-medium text-muted-foreground mb-1.5 shrink-0">
                    按路径前缀分布 (/v1、/api、other)
                  </span>
                  <div className="flex-1 min-h-0 overflow-y-auto max-h-[120px]">
                    <Table className="w-full table-fixed text-sm">
                      <TableHeader className="bg-muted/40 sticky top-0 backdrop-blur-xs">
                        <TableRow className="border-b border-border h-7">
                          <TableHead className="h-7 px-2.5 text-[12px] leading-[16px] text-muted-foreground">前缀</TableHead>
                          <TableHead className="h-7 px-2.5 text-[12px] leading-[16px] text-muted-foreground text-right">频次</TableHead>
                          <TableHead className="h-7 px-2.5 text-[12px] leading-[16px] text-muted-foreground text-right">占比</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(errorsData.by_path_group || []).slice(0, 4).map((p) => (
                          <TableRow key={p.path_group} className="h-8 border-b border-border/50">
                            <TableCell className="px-2.5 py-1 font-mono text-[12px] truncate" title={p.path_group}>
                              {p.path_group}
                            </TableCell>
                            <TableCell className="px-2.5 py-1 text-right font-mono tabular-nums text-[12px]">
                              {formatNumber(p.count)}
                            </TableCell>
                            <TableCell className="px-2.5 py-1 text-right font-mono tabular-nums text-[12px] text-muted-foreground">
                              {formatPercent(p.share)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
