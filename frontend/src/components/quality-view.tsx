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
import { Database, Clock, AlertTriangle, AlertCircle, Info } from "lucide-react"
import { formatNumber, formatTimestamp, formatTimestampShort } from "@/lib/formatters"
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
}

export function QualityView({ quality, accounts }: QualityViewProps) {
  const recentRuns = React.useMemo(() => {
    return (quality.job_runs || []).slice(0, 8)
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

  return (
    <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-2 md:grid-rows-2 gap-4">
      {/* 1. 数据源 */}
      <Card className="shadow-xs overflow-hidden flex flex-col p-4 h-full min-h-0">
        <CardHeader className="p-0 pb-3 shrink-0">
          <div className="flex items-center justify-between">
            <CardTitle className="text-[16px] leading-[24px] font-medium text-foreground">
              数据源
            </CardTitle>
            <Database className="size-4 text-muted-foreground" />
          </div>
        </CardHeader>
        <CardContent className="p-0 flex-1 min-h-0 flex flex-col justify-center">
          <div className="grid grid-cols-2 gap-2.5 flex-1 min-h-0 auto-rows-fr">
            <div className="rounded-lg border border-border/70 bg-muted/20 p-3 flex flex-col justify-center gap-1">
              <span className="text-[12px] leading-[16px] text-muted-foreground font-medium">
                最新数据时间
              </span>
              <span className="text-[14px] leading-[20px] font-mono tabular-nums font-semibold text-foreground mt-2">
                {formatTimestamp(quality.source_last_t)}
              </span>
            </div>

            <div className="rounded-lg border border-border/70 bg-muted/20 p-3 flex flex-col justify-center gap-1">
              <span className="text-[12px] leading-[16px] text-muted-foreground font-medium">
                总行数
              </span>
              <span className="text-[20px] leading-[24px] font-mono tabular-nums font-semibold text-foreground mt-2">
                {formatNumber(quality.source_rows)}
              </span>
            </div>

            <div className="rounded-lg border border-border/70 bg-muted/20 p-3 flex flex-col justify-center gap-1">
              <span className="text-[12px] leading-[16px] text-muted-foreground font-medium">
                错误行
              </span>
              <span
                className={cn(
                  "text-[20px] leading-[24px] font-mono tabular-nums font-semibold mt-2",
                  (quality.error_rows ?? 0) > 0
                    ? "text-destructive"
                    : "text-foreground"
                )}
              >
                {formatNumber(quality.error_rows)}
              </span>
            </div>

            <div className="rounded-lg border border-border/70 bg-muted/20 p-3 flex flex-col justify-center gap-1">
              <span className="text-[12px] leading-[16px] text-muted-foreground font-medium">
                Schema 状态
              </span>
              <div className="mt-2">
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

          <div className="mt-2 shrink-0 text-[12px] leading-[16px] text-muted-foreground">
            校验于{" "}
            <span className="font-mono tabular-nums text-foreground">
              {formatTimestampShort(quality.checked_at)}
            </span>
          </div>
          </div>
        </CardContent>
      </Card>

      {/* 2. 采集任务 */}
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
                最近 5 条
              </Badge>
            </div>
            <Clock className="size-4 text-muted-foreground" />
          </div>
        </CardHeader>
        <CardContent className="p-0 flex-1 min-h-0 flex flex-col">
          <div className="rounded-lg border border-border bg-card flex-1 min-h-0 overflow-auto">
            <Table className="w-full table-fixed text-sm">
              <colgroup>
                <col style={{ width: "35%" }} />
                <col style={{ width: "27%" }} />
                <col style={{ width: "18%" }} />
                <col style={{ width: "20%" }} />
              </colgroup>
              <TableHeader className="bg-muted/50 sticky top-0 z-20 backdrop-blur-xs">
                <TableRow className="hover:bg-transparent border-b border-border">
                  <TableHead className="h-8 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground text-left whitespace-nowrap">
                    任务
                  </TableHead>
                  <TableHead className="h-8 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground text-left whitespace-nowrap">
                    开始时间
                  </TableHead>
                  <TableHead className="h-8 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground text-right whitespace-nowrap">
                    耗时
                  </TableHead>
                  <TableHead className="h-8 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground text-right whitespace-nowrap">
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
                      className="h-[40px] hover:bg-muted/40 transition-colors border-b border-border/60"
                    >
                      <TableCell
                        className="px-3 py-1 font-mono text-[13px] leading-[18px] text-foreground truncate"
                        title={run.job}
                      >
                        {run.job}
                      </TableCell>
                      <TableCell className="px-3 py-1 font-mono tabular-nums text-[12px] leading-[16px] text-muted-foreground whitespace-nowrap">
                        {formatTimestampShort(run.started_at)}
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
                            已完成
                          </Badge>
                        ) : run.status === "partial" ? (
                          <Badge
                            variant="outline"
                            className="text-[12px] leading-[16px] h-5 px-1.5 font-medium text-amber-600 dark:text-amber-400 border-amber-500/30 bg-amber-500/10"
                          >
                            部分完成
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
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* 3. 采集失败 */}
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
                    <TableHead className="h-8 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground text-left whitespace-nowrap">
                      账户
                    </TableHead>
                    <TableHead className="h-8 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground text-left whitespace-nowrap">
                      原因
                    </TableHead>
                    <TableHead className="h-8 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground text-right whitespace-nowrap">
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
                        className="px-3 py-1 font-normal text-[14px] leading-[20px] text-foreground truncate"
                        title={err.name || err.account_id}
                      >
                        {err.name || err.account_id}
                      </TableCell>
                      <TableCell
                        className="px-3 py-1 text-muted-foreground text-[12px] leading-[16px] truncate"
                        title={err.reason}
                      >
                        <Badge
                          variant="outline"
                          className="text-[11px] leading-[14px] h-4.5 px-1.5 font-normal text-amber-600 dark:text-amber-400 border-amber-500/30"
                        >
                          {err.reason}
                        </Badge>
                      </TableCell>
                      <TableCell className="px-3 py-1 text-right font-mono tabular-nums text-[12px] leading-[16px] text-muted-foreground whitespace-nowrap">
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

      {/* 4. 缺快照提示 */}
      <Card className="shadow-xs overflow-hidden flex flex-col p-4 h-full min-h-0">
        <CardHeader className="p-0 pb-3 shrink-0">
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
        <CardContent className="p-0 flex-1 min-h-0 flex flex-col justify-between gap-3">
          <div className="rounded-lg border border-border/70 bg-muted/30 p-3 flex items-start gap-2.5 shrink-0">
            <Info className="size-4 text-muted-foreground shrink-0 mt-0.5" />
            <div className="text-[14px] leading-[20px] text-muted-foreground font-normal">
              快照缺失只影响成本核算，不影响售出
            </div>
          </div>

          <div className="flex-1 min-h-0 flex flex-col justify-start">
            <div className="text-[12px] leading-[16px] text-muted-foreground font-medium mb-2 shrink-0">
              缺失快照账户：
            </div>
            {unavailableAccounts.length === 0 ? (
              <div className="text-[14px] leading-[20px] text-muted-foreground py-2">
                当前周期内暂无缺失快照账户
              </div>
            ) : (
              <div className="flex flex-wrap gap-2 overflow-y-auto max-h-[140px] p-0.5">
                {displayAccounts.map((acc) => (
                  <Badge
                    key={acc.id}
                    variant="secondary"
                    className="text-[13px] leading-[18px] py-1 px-2.5 font-normal text-foreground"
                    title={acc.name || acc.id}
                  >
                    {acc.name || acc.id}
                  </Badge>
                ))}
                {remainingCount > 0 && (
                  <Badge
                    variant="outline"
                    className="text-[13px] leading-[18px] py-1 px-2.5 font-normal text-muted-foreground border-border bg-muted/20"
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
  )
}
