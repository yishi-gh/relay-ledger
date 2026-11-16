import * as React from "react"
import { Card, CardContent } from "@/components/ui/card"
import {
  Database,
  AlertTriangle,
  AlertCircle,
  CheckCircle2,
  Info,
} from "lucide-react"
import { formatBeijingClock, formatNumber, formatTimestampShort } from "@/lib/formatters"
import { FreshnessCard } from "@/components/freshness-card"
import {
  QualityBadge,
  QualityEmptyState,
  QualityPanelHeader,
  QualityStatusRow,
  type QualityTone,
} from "@/components/quality-kit"
import type { DateRange, RangeType } from "@/lib/api"
import type { QualityData, UpstreamAccount } from "@/lib/api-types"

export type { CollectError, JobRun, QualityData } from "@/lib/api-types"

function jobStatusTone(status?: string): QualityTone {
  if (status === "ok" || status === "complete") return "good"
  if (status === "partial") return "warn"
  if (status === "error") return "bad"
  return "neutral"
}

function jobStatusLabel(status?: string): string {
  if (status === "ok") return "正常"
  if (status === "complete") return "完成"
  if (status === "partial") return "部分成功"
  if (status === "error") return "失败"
  return "未运行"
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
  const errors = [
    ...(quality.alerts || []).map((alert) => ({
      key: `alert:${alert.key}`,
      name: alert.title,
      reason: alert.detail || "活动告警",
      at: alert.last_seen_at,
      tone: alert.severity === "error" ? "bad" as const : "warn" as const,
    })),
    ...(quality.collect_errors || [])
      .filter((e) => e.reason !== "not_configured")
      .map((e) => ({
        key: `error:${e.account_id}:${e.at}`,
        name: e.name || e.account_id,
        reason: e.reason,
        at: e.at,
        tone: "bad" as const,
      })),
  ]
  const schemaTone: QualityTone = quality.schema_ok === true
    ? "good"
    : quality.schema_ok === false ? "bad" : "neutral"
  const schemaLabel = quality.schema_ok === true
    ? "结构正常"
    : quality.schema_ok === false ? "结构异常" : "未确认"
  const errorTone: QualityTone = errors.some((item) => item.tone === "bad") ? "bad" : "warn"
  const latestRuns = React.useMemo(() => {
    const latest = new Map<string, { status: string; at: number }>()
    for (const run of quality.job_runs || []) {
      const current = latest.get(run.job)
      const at = run.finished_at ?? run.started_at
      if (!current || at > current.at) {
        latest.set(run.job, { status: run.status, at })
      }
    }
    return latest
  }, [quality.job_runs])
  const spendRun = latestRuns.get("collect-spend")

  const unavailableAccounts = React.useMemo(() => {
    return accounts.filter((a) => a.status === "unavailable")
  }, [accounts])
  const missingTone: QualityTone = unavailableAccounts.length === 0 ? "good" : "warn"

  return (
    <div className="dashboard-view dashboard-quality dashboard-flow-fallback flex-1 min-h-0 min-w-0 flex flex-col gap-4 md:overflow-hidden">
      {/* 基础状态卡片：采用 2x2 自适应栅格，确保采集失败与缺快照账户在桌面与移动端均能完整读出原因与列表 */}
      <section className="quality-panels grid grid-cols-1 md:grid-cols-2 gap-4 shrink-0 md:flex-1 md:min-h-0 md:grid-rows-[repeat(2,minmax(0,1fr))] [&>[data-slot=card]]:min-h-0">
        {/* 1. 数据库与模式状态 */}
        <Card className="dashboard-panel shadow-xs p-4 gap-0 flex flex-col">
          <QualityPanelHeader title="数据源" icon={Database}>
            <QualityBadge tone={schemaTone}>{schemaLabel}</QualityBadge>
          </QualityPanelHeader>
          <CardContent className="p-0 flex-1 min-h-0 flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] leading-[16px] text-muted-foreground">
              <span>自检时间</span>
              <span className="font-mono tabular-nums text-foreground/80">
                {quality.checked_at
                  ? formatBeijingClock(quality.checked_at, true)
                  : "自检中…"}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="min-w-0 rounded-lg border border-border/60 bg-muted/20 p-2.5">
                <span className="block text-[12px] leading-[16px] text-muted-foreground">源数据库有效记录</span>
                <div className="mt-1 font-mono text-[18px] font-semibold leading-[24px] tabular-nums text-foreground">
                  {formatNumber(quality.source_rows ?? null)}
                  <span className="ml-1 font-sans text-[12px] font-normal text-muted-foreground">行</span>
                </div>
              </div>
              <div className="min-w-0 rounded-lg border border-border/60 bg-muted/20 p-2.5">
                <span className="block text-[12px] leading-[16px] text-muted-foreground">HTTP 错误记录</span>
                <div className="mt-1 font-mono text-[18px] font-semibold leading-[24px] tabular-nums text-foreground">
                  {formatNumber(quality.error_rows ?? null)}
                  <span className="ml-1 font-sans text-[12px] font-normal text-muted-foreground">条</span>
                </div>
              </div>
            </div>
            <div className="mt-auto flex items-center justify-between gap-2 border-t border-border/60 pt-2 text-[12px] leading-[16px]">
              <span className="text-muted-foreground">数据截止</span>
              <span className="font-mono tabular-nums text-foreground/80">
                {formatTimestampShort(quality.source_last_t)}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* 2. 数据新鲜度 */}
        <FreshnessCard accounts={accounts} />

        {/* 3. 采集错误告警 */}
        <Card className="dashboard-panel shadow-xs p-4 gap-0 flex flex-col">
          <QualityPanelHeader title="采集异常" icon={AlertTriangle}>
            <QualityBadge tone={errors.length === 0 ? "good" : errorTone}>
              {errors.length === 0 ? "正常" : `${errors.length} 项`}
            </QualityBadge>
          </QualityPanelHeader>
          <CardContent className="p-0 flex-1 min-h-0 flex flex-col">
            {errors.length === 0 ? (
              <QualityEmptyState
                icon={CheckCircle2}
                title="采集链路正常"
                detail="当前没有活动告警"
              />
            ) : (
              <ul className="flex flex-col gap-1.5 max-h-[180px] md:max-h-none md:flex-1 md:min-h-0 overflow-y-auto pr-1">
                {errors.map((err) => (
                  <li key={err.key}>
                    <QualityStatusRow
                      tone={err.tone}
                      title={err.name}
                      detail={err.reason}
                      meta={formatTimestampShort(err.at)}
                    />
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-auto flex shrink-0 items-center justify-between gap-2 border-t border-border/60 pt-2 text-[12px] leading-[16px]">
              <span className="text-muted-foreground">最近采集</span>
              <span className="flex items-center gap-1.5 font-mono tabular-nums text-foreground/80">
                {formatTimestampShort(spendRun?.at)}
                <QualityBadge tone={jobStatusTone(spendRun?.status)}>
                  {jobStatusLabel(spendRun?.status)}
                </QualityBadge>
              </span>
            </div>
          </CardContent>
        </Card>

        {/* 4. 缺快照账户 */}
        <Card className="dashboard-panel shadow-xs p-4 gap-0 flex flex-col">
          <QualityPanelHeader title="缺快照" icon={AlertCircle}>
            <QualityBadge tone={missingTone}>
              {unavailableAccounts.length === 0 ? "完整" : `${unavailableAccounts.length} 个`}
            </QualityBadge>
          </QualityPanelHeader>
          <CardContent className="p-0 flex-1 min-h-0 flex flex-col gap-2">
            <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/20 p-2.5">
              <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span className="text-[12px] leading-[16px] text-muted-foreground">
                仅影响成本核算
              </span>
            </div>

            {unavailableAccounts.length === 0 ? (
              <QualityEmptyState
                icon={CheckCircle2}
                title="区段成本可核算"
                detail="当前没有缺失快照的账户"
              />
            ) : (
              <div className="flex max-h-[240px] flex-col gap-1.5 overflow-y-auto pr-0.5 md:max-h-none md:flex-1 md:min-h-0">
                {unavailableAccounts.map((acc) => (
                  <QualityStatusRow
                    key={acc.id}
                    tone="warn"
                    title={acc.name || acc.id}
                    detail="缺少余额快照"
                    meta={formatTimestampShort(acc.last_sync)}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  )
}
