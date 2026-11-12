import * as React from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Database,
  AlertTriangle,
  AlertCircle,
  Info,
} from "lucide-react"
import { formatBeijingClock, formatNumber } from "@/lib/formatters"
import { FreshnessCard } from "@/components/freshness-card"
import type { DateRange, RangeType } from "@/lib/api"
import type { QualityData, UpstreamAccount } from "@/lib/api-types"
import { cn } from "@/lib/utils"

export type { CollectError, JobRun, QualityData } from "@/lib/api-types"

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
  const errors = (quality.collect_errors || []).filter(
    (e) => e.reason !== "not_configured"
  )

  const unavailableAccounts = React.useMemo(() => {
    return accounts.filter((a) => a.status === "unavailable")
  }, [accounts])

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-4 overflow-y-auto pr-1">
      {/* 基础状态卡片：采用 2x2 自适应栅格，确保采集失败与缺快照账户在桌面与移动端均能完整读出原因与列表 */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4 shrink-0">
        {/* 1. 数据库与模式状态 */}
        <Card className="shadow-xs p-4 flex flex-col justify-between">
          <CardHeader className="p-0 pb-3 flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-[16px] leading-[24px] font-medium text-foreground">
              数据源
            </CardTitle>
            <Database className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="p-0 flex-1 flex flex-col justify-between gap-3">
            <div className="flex items-center gap-2">
              <Badge
                variant="outline"
                className={cn(
                  "text-[12px] leading-[16px] h-5 px-1.5 font-medium",
                  quality.schema_ok === true
                    ? "text-emerald-600 dark:text-emerald-400 border-emerald-500/30 bg-emerald-500/10"
                    : quality.schema_ok === false ? "text-rose-600 dark:text-rose-400 border-rose-500/30 bg-rose-500/10" : "text-muted-foreground"
                )}
              >
                {quality.schema_ok === true ? "结构正常" : quality.schema_ok === false ? "结构异常" : "未确认"}
              </Badge>
              <span className="text-[12px] leading-[16px] text-muted-foreground font-mono tabular-nums">
                {quality.checked_at
                  ? `自检时间: ${formatBeijingClock(quality.checked_at, true)}`
                  : "自检中…"}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3 pt-2 border-t border-border/70">
              <div className="space-y-0.5 min-w-0">
                <span className="text-[12px] leading-[16px] text-muted-foreground">源数据库有效记录</span>
                <div className="text-[18px] leading-[24px] font-mono font-semibold tabular-nums text-foreground">
                  {formatNumber(quality.source_rows ?? null)}
                  <span className="text-[12px] font-normal font-sans text-muted-foreground ml-1">行</span>
                </div>
              </div>
              <div className="space-y-0.5 min-w-0">
                <span className="text-[12px] leading-[16px] text-muted-foreground">HTTP 错误记录</span>
                <div className="text-[18px] leading-[24px] font-mono font-semibold tabular-nums text-foreground">
                  {formatNumber(quality.error_rows ?? null)}
                  <span className="text-[12px] font-normal font-sans text-muted-foreground ml-1">条</span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* 2. 数据新鲜度 */}
        <FreshnessCard accounts={accounts} />

        {/* 3. 采集错误告警 */}
        <Card className="shadow-xs p-4 flex flex-col justify-between">
          <CardHeader className="p-0 pb-3 flex flex-row items-center justify-between space-y-0">
            <div className="flex items-center gap-2">
              <CardTitle className="text-[16px] leading-[24px] font-medium text-foreground">
                采集异常
              </CardTitle>
              {errors.length > 0 && (
                <Badge variant="destructive" className="text-[12px] leading-[16px] h-5 px-1.5 font-medium tabular-nums">
                  {errors.length} 项异常
                </Badge>
              )}
            </div>
            <AlertTriangle className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="p-0 flex-1 flex flex-col justify-between gap-2">
            {errors.length === 0 ? (
              <div className="flex flex-col justify-center flex-1 py-4 text-center">
                <span className="text-[14px] leading-[20px] font-medium text-foreground">
                  暂无采集异常记录
                </span>
              </div>
            ) : (
              <ul className="flex flex-col gap-1.5 max-h-[140px] overflow-y-auto pr-1">
                {errors.map((err, idx) => (
                  <li
                    key={idx}
                    className="flex flex-col gap-0.5 rounded-lg border border-rose-500/30 bg-rose-500/5 p-2 text-[12px] leading-[16px]"
                  >
                    <div className="flex items-center justify-between font-medium text-rose-600 dark:text-rose-400">
                      <span>{err.name || err.account_id}</span>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {formatBeijingClock(err.at, true)}
                      </span>
                    </div>
                    <span className="text-muted-foreground break-all">{err.reason}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* 4. 缺快照账户 */}
        <Card className="shadow-xs p-4 flex flex-col justify-between">
          <CardHeader className="p-0 pb-3 flex flex-row items-center justify-between space-y-0">
            <div className="flex items-center justify-between w-full">
              <div className="flex items-center gap-2">
                <CardTitle className="text-[16px] leading-[24px] font-medium text-foreground">
                  缺快照
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
                仅影响成本核算
              </div>
            </div>

            <div className="flex-1 min-h-0 flex flex-col justify-start">
              {unavailableAccounts.length === 0 ? (
                <div className="text-[13px] leading-[18px] text-muted-foreground py-1">
                  暂无缺快照记录
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
    </div>
  )
}
