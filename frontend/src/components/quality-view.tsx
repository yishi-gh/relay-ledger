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
} from "lucide-react"
import {
  formatNumber,
  formatTimestamp,
  formatTimestampShort,
} from "@/lib/formatters"
import { FreshnessCard } from "@/components/freshness-card"
import type { DateRange, RangeType } from "@/lib/api"
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

export interface QualityViewProps {
  quality: QualityData
  accounts?: UpstreamAccount[]
  dateRange?: DateRange | null
  timeRange?: RangeType
  previewMode?: boolean
  lastRefreshTime?: number
}

export function QualityView({
  quality,
  accounts = [],
}: QualityViewProps) {
  const allRuns = quality.job_runs || []

  const errors = (quality.collect_errors || []).filter(
    (e) => e.reason !== "not_configured"
  )

  const unavailableAccounts = React.useMemo(() => {
    return accounts.filter((a) => a.status === "unavailable")
  }, [accounts])

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-4 overflow-y-auto pr-1">
      {/* 1. 基础状态卡片：采用 2x2 自适应栅格，确保采集失败与缺快照账户在桌面与移动端均能完整读出原因与列表 */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4 shrink-0">
        {/* 卡 1: 数据新鲜度 */}
        <FreshnessCard accounts={accounts} className="min-h-[160px]" />

        {/* 卡 2: 数据源状态 */}
        <Card className="shadow-xs overflow-hidden flex flex-col p-4 min-h-[160px]">
          <CardHeader className="p-0 pb-3 shrink-0">
            <div className="flex items-center justify-between">
              <CardTitle className="text-[16px] leading-[24px] font-medium text-foreground">
                数据源状态
              </CardTitle>
              <Database className="size-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent className="p-0 flex-1 min-h-0 flex flex-col justify-between gap-2.5">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 flex-1 min-h-0">
              <div className="rounded-lg border border-border/70 bg-muted/20 p-2.5 flex flex-col justify-center">
                <span className="text-[12px] leading-[16px] text-muted-foreground font-medium">
                  最新数据时间
                </span>
                <span
                  className="text-[13px] leading-[18px] font-mono tabular-nums font-semibold text-foreground mt-1 truncate"
                  title={formatTimestamp(quality.source_last_t)}
                >
                  {formatTimestampShort(quality.source_last_t)}
                </span>
              </div>

              <div className="rounded-lg border border-border/70 bg-muted/20 p-2.5 flex flex-col justify-center">
                <span className="text-[12px] leading-[16px] text-muted-foreground font-medium">
                  总行数
                </span>
                <span className="text-[16px] leading-[22px] font-mono tabular-nums font-semibold text-foreground mt-1">
                  {formatNumber(quality.source_rows)}
                </span>
              </div>

              <div className="rounded-lg border border-border/70 bg-muted/20 p-2.5 flex flex-col justify-center">
                <span className="text-[12px] leading-[16px] text-muted-foreground font-medium">
                  错误行
                </span>
                <span
                  className={cn(
                    "text-[16px] leading-[22px] font-mono tabular-nums font-semibold mt-1",
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
                  {quality.schema_ok === true ? (
                    <Badge
                      variant="outline"
                      className="text-[12px] leading-[16px] h-5 px-1.5 font-medium text-emerald-600 dark:text-emerald-400 border-emerald-500/30 bg-emerald-500/10"
                    >
                      结构正常
                    </Badge>
                  ) : quality.schema_ok === false ? (
                    <Badge
                      variant="destructive"
                      className="text-[12px] leading-[16px] h-5 px-1.5 font-medium"
                    >
                      校验异常
                    </Badge>
                  ) : (
                    <Badge
                      variant="secondary"
                      className="text-[12px] leading-[16px] h-5 px-1.5 font-medium text-muted-foreground"
                    >
                      未校验
                    </Badge>
                  )}
                </div>
              </div>
            </div>

            <div className="shrink-0 text-[12px] leading-[16px] text-muted-foreground truncate border-t border-border/50 pt-2">
              校验时间：
              <span className="font-mono tabular-nums text-foreground">
                {formatTimestamp(quality.checked_at)}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* 卡 3: 采集失败 (可读换行列表，原因完整展现不截断) */}
        <Card className="shadow-xs overflow-hidden flex flex-col p-4 min-h-[180px]">
          <CardHeader className="p-0 pb-3 shrink-0">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CardTitle className="text-[16px] leading-[24px] font-medium text-foreground">
                  采集失败记录
                </CardTitle>
                {errors.length > 0 && (
                  <Badge
                    variant="destructive"
                    className="text-[12px] leading-[16px] h-5 px-1.5 font-medium tabular-nums"
                  >
                    {errors.length} 项异常
                  </Badge>
                )}
              </div>
              <AlertTriangle className="size-4 text-amber-500" />
            </div>
          </CardHeader>
          <CardContent className="p-0 flex-1 min-h-0 flex flex-col">
            {errors.length === 0 ? (
              <div className="flex-1 flex items-center justify-center rounded-lg border border-dashed border-border/70 bg-muted/10 text-muted-foreground text-[13px] leading-[18px] py-4">
                无采集失败记录
              </div>
            ) : (
              <div className="rounded-lg border border-border bg-card flex-1 min-h-0 overflow-auto max-h-[160px] divide-y divide-border/60">
                {errors.map((err, idx) => (
                  <div key={idx} className="p-2.5 flex flex-col gap-1 hover:bg-muted/30 transition-colors">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <span className="font-medium text-[13px] leading-[18px] text-foreground">
                        {err.name || err.account_id}
                      </span>
                      <span className="font-mono text-[12px] leading-[16px] text-muted-foreground">
                        {formatTimestamp(err.at)}
                      </span>
                    </div>
                    <div className="text-[12px] leading-[18px] text-amber-600 dark:text-amber-400 break-words">
                      {err.reason}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* 卡 4: 缺快照提示 (全名单自适应展示，不截断固定 6 条) */}
        <Card className="shadow-xs overflow-hidden flex flex-col p-4 min-h-[180px]">
          <CardHeader className="p-0 pb-3 shrink-0">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CardTitle className="text-[16px] leading-[24px] font-medium text-foreground">
                  缺快照账户提示
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
          <CardContent className="p-0 flex-1 min-h-0 flex flex-col justify-between gap-2">
            <div className="rounded-lg border border-border/70 bg-muted/30 p-2.5 flex items-start gap-2 shrink-0">
              <Info className="size-4 text-muted-foreground shrink-0 mt-0.5" />
              <div className="text-[12px] leading-[16px] text-muted-foreground font-normal">
                快照缺失仅影响成本核算，不影响售出统计
              </div>
            </div>

            <div className="flex-1 min-h-0 flex flex-col justify-start">
              <div className="text-[12px] leading-[16px] text-muted-foreground font-medium mb-1.5 shrink-0">
                缺失快照账户全名单：
              </div>
              {unavailableAccounts.length === 0 ? (
                <div className="text-[13px] leading-[18px] text-muted-foreground py-1">
                  当前周期内所有上游账户均具备有效快照
                </div>
              ) : (
                <div className="flex flex-wrap gap-1.5 overflow-y-auto max-h-[90px] p-0.5">
                  {unavailableAccounts.map((acc) => (
                    <Badge
                      key={acc.id}
                      variant="secondary"
                      className="text-[12px] leading-[16px] py-0.5 px-2 font-normal text-foreground"
                      title={acc.name || acc.id}
                    >
                      {acc.name || acc.id}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </section>

      {/* 2. 全宽采集任务运行历史大表 (全字段展示，不截断固定 6 条) */}
      <Card className="shadow-xs overflow-hidden flex flex-col p-4 flex-1 min-h-[300px]">
        <CardHeader className="p-0 pb-3 flex flex-row items-center justify-between space-y-0 shrink-0">
          <div className="flex items-center gap-2">
            <Clock className="size-4 text-muted-foreground" />
            <CardTitle className="text-[16px] leading-[24px] font-medium text-foreground">
              采集任务运行历史
            </CardTitle>
            <Badge
              variant="secondary"
              className="text-[12px] leading-[16px] h-5 px-1.5 font-medium tabular-nums"
            >
              共 {allRuns.length} 条记录
            </Badge>
          </div>
        </CardHeader>

        <CardContent className="p-0 flex-1 min-h-0 flex flex-col">
          <div className="rounded-lg border border-border bg-card flex-1 min-h-0 overflow-auto">
            <Table className="w-full table-fixed text-sm min-w-[700px]">
              <colgroup>
                <col style={{ width: "24%" }} />
                <col style={{ width: "22%" }} />
                <col style={{ width: "16%" }} />
                <col style={{ width: "14%" }} />
                <col style={{ width: "24%" }} />
              </colgroup>
              <TableHeader className="bg-muted/50 sticky top-0 z-20 backdrop-blur-xs">
                <TableRow className="hover:bg-transparent border-b border-border">
                  <TableHead className="h-8 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground text-left whitespace-nowrap">
                    任务名称
                  </TableHead>
                  <TableHead className="h-8 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground text-left whitespace-nowrap">
                    触发时间
                  </TableHead>
                  <TableHead className="h-8 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground text-right whitespace-nowrap">
                    耗时
                  </TableHead>
                  <TableHead className="h-8 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground text-right whitespace-nowrap">
                    执行状态
                  </TableHead>
                  <TableHead className="h-8 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground text-left whitespace-nowrap">
                    详细备注
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {allRuns.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="h-32 text-center text-muted-foreground text-[13px]">
                      暂无采集任务记录
                    </TableCell>
                  </TableRow>
                ) : (
                  allRuns.map((run, idx) => {
                    const durationSec =
                      run.finished_at && run.started_at
                        ? ((run.finished_at - run.started_at) / 1000).toFixed(1)
                        : null
                    return (
                      <TableRow
                        key={idx}
                        className="h-[40px] hover:bg-muted/40 transition-colors border-b border-border/60"
                      >
                        <TableCell
                          className="px-3 py-1 font-mono text-[13px] leading-[18px] text-foreground truncate"
                          title={run.job}
                        >
                          {run.job}
                        </TableCell>
                        <TableCell
                          className="px-3 py-1 font-mono tabular-nums text-[12px] leading-[16px] text-muted-foreground whitespace-nowrap"
                          title={formatTimestamp(run.started_at)}
                        >
                          {formatTimestamp(run.started_at)}
                        </TableCell>
                        <TableCell className="px-3 py-1 text-right font-mono tabular-nums text-[13px] leading-[18px] text-foreground whitespace-nowrap">
                          {durationSec != null ? `${durationSec}s` : "—"}
                        </TableCell>
                        <TableCell className="px-3 py-1 text-right whitespace-nowrap">
                          {run.status === "complete" || run.status === "ok" ? (
                            <Badge
                              variant="outline"
                              className="text-[12px] leading-[16px] h-5 px-1.5 font-medium text-emerald-600 dark:text-emerald-400 border-emerald-500/30 bg-emerald-500/10"
                            >
                              完成
                            </Badge>
                          ) : run.status === "partial" ? (
                            <Badge
                              variant="outline"
                              className="text-[12px] leading-[16px] h-5 px-1.5 font-medium text-amber-600 dark:text-amber-400 border-amber-500/30 bg-amber-500/10"
                            >
                              部分
                            </Badge>
                          ) : (
                            <Badge
                              variant="destructive"
                              className="text-[12px] leading-[16px] h-5 px-1.5 font-medium"
                            >
                              失败
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell
                          className="px-3 py-1 text-[12px] leading-[16px] text-muted-foreground truncate"
                          title={run.detail || undefined}
                        >
                          {run.detail || "—"}
                        </TableCell>
                      </TableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
