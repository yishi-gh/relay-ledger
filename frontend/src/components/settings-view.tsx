import * as React from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Server,
  HardDrive,
  Clock,
  Palette,
  Globe,
  Coins,
  RotateCcw,
  Check,
  AlertTriangle,
  RefreshCw,
  Activity,
  SlidersHorizontal,
  Info,
} from "lucide-react"
import { formatBeijingClock, formatRawNumber } from "@/lib/formatters"
import { useTheme } from "@/components/theme-provider"
import {
  useSettings,
  updatePreferences,
  saveServerSettings,
  loadServerSettings,
  validateServerSettings,
  DEFAULT_PERSONAL_PREFERENCES,
  type PersonalPreferences,
  type ServerSettings,
} from "@/lib/settings"
import type { Meta } from "@/lib/api"
import { cn } from "@/lib/utils"

interface SettingsViewProps {
  meta: Meta | null
  lastRefreshTime?: number
}

/** 完整保留浮点小数的字符串往返转换工具 */
function toFloatString(v: number): string {
  return Number.isFinite(v) ? String(parseFloat(v.toPrecision(12))) : ""
}

function parseInputNumber(raw: string): number {
  const trimmed = raw.trim()
  return trimmed === "" ? NaN : Number(trimmed)
}

const THRESHOLD_DOT_CLASSES = {
  good: "bg-emerald-600 dark:bg-emerald-400",
  warn: "bg-amber-600 dark:bg-amber-400",
  danger: "bg-rose-600 dark:bg-rose-400",
  neutral: "bg-muted-foreground",
}

type ThresholdTone = keyof typeof THRESHOLD_DOT_CLASSES

/** 双阈值行内表单组件 */
function ThresholdPairField({
  label,
  hint,
  error,
  leftValue,
  rightValue,
  onLeftChange,
  onRightChange,
  leftLabel,
  rightLabel,
  leftTone,
  rightTone,
  comparator = "<",
  step,
  min,
  max,
}: {
  label: string
  hint?: string
  error?: string
  leftValue: number | string
  rightValue: number | string
  onLeftChange: (val: string) => void
  onRightChange: (val: string) => void
  leftLabel: string
  rightLabel: string
  leftTone: ThresholdTone
  rightTone: ThresholdTone
  comparator?: "<" | ">"
  step?: number | string
  min?: number
  max?: number
}) {
  return (
    <div className="grid min-w-0 grid-cols-1 items-center gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_300px] sm:gap-x-6">
      <div className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
        <span>{label}</span>
        {hint && (
          <Tooltip>
            <TooltipTrigger render={<button type="button" aria-label={`${label}说明`} className="shrink-0 rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" />}>
              <Info className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent className="max-w-64 text-[12px]">{hint}</TooltipContent>
          </Tooltip>
        )}
      </div>
      <div className="grid grid-cols-2 items-end gap-4">
        <div className="min-w-0 flex flex-col gap-1">
          <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", THRESHOLD_DOT_CLASSES[leftTone])} />
            {leftLabel}
          </span>
          <div className="flex items-center gap-1.5">
            <span aria-hidden="true" className="text-[12px] text-muted-foreground">{comparator}</span>
            <Input
              type="number"
              min={min}
              max={max}
              step={step}
              value={leftValue}
              onChange={(e) => onLeftChange(e.target.value)}
              className="h-8 min-w-0 text-right text-[13px] font-mono tabular-nums"
              aria-label={`${label}${leftLabel}`}
              placeholder={leftLabel}
              aria-invalid={Boolean(error)}
            />
          </div>
        </div>
        <div className="min-w-0 flex flex-col gap-1">
          <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", THRESHOLD_DOT_CLASSES[rightTone])} />
            {rightLabel}
          </span>
          <div className="flex items-center gap-1.5">
            <span aria-hidden="true" className="text-[12px] text-muted-foreground">{comparator}</span>
            <Input
              type="number"
              min={min}
              max={max}
              step={step}
              value={rightValue}
              onChange={(e) => onRightChange(e.target.value)}
              className="h-8 min-w-0 text-right text-[13px] font-mono tabular-nums"
              aria-label={`${label}${rightLabel}`}
              placeholder={rightLabel}
              aria-invalid={Boolean(error)}
            />
          </div>
        </div>
      </div>
      {error ? (
        <span className="text-[12px] leading-tight text-destructive sm:col-start-2">{error}</span>
      ) : null}
    </div>
  )
}

/** 单数字设置项组件 */
function NumberSettingField({
  label,
  tone,
  hint,
  error,
  value,
  onChange,
  min,
  max,
  step = 1,
}: {
  label: string
  tone?: ThresholdTone
  hint?: string
  error?: string
  value: number | string
  onChange: (val: string) => void
  min?: number
  max?: number
  step?: number | string
}) {
  const inputId = React.useId()
  return (
    <div className="grid min-w-0 grid-cols-1 items-center gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_300px] sm:gap-x-6">
      <div className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
        <label htmlFor={inputId} className="inline-flex items-center gap-1.5">
          {tone && <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", THRESHOLD_DOT_CLASSES[tone])} />}
          {label}
        </label>
        {hint && (
          <Tooltip>
            <TooltipTrigger render={<button type="button" aria-label={`${label}说明`} className="shrink-0 rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" />}>
              <Info className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent className="max-w-64 text-[12px]">{hint}</TooltipContent>
          </Tooltip>
        )}
      </div>
      <Input
        id={inputId}
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 min-w-0 text-right text-[13px] font-mono tabular-nums sm:w-28 sm:justify-self-end"
        aria-label={label}
        aria-invalid={Boolean(error)}
      />
      {error ? (
        <span className="text-[12px] leading-tight text-destructive sm:col-start-2">{error}</span>
      ) : null}
    </div>
  )
}

export function SettingsView({ meta }: SettingsViewProps) {
  const { theme } = useTheme()
  const {
    preferences,
    server,
    defaults,
    revision,
    collector,
    loading,
    error,
    serverError,
    saving,
  } = useSettings()

  // 本地偏好反馈
  const [localFeedback, setLocalFeedback] = React.useState<string | null>(null)
  const [localError, setLocalError] = React.useState<string | null>(null)

  // 全站共享设置草稿与乐观锁基准版本
  const [userEditedDraft, setUserEditedDraft] = React.useState<ServerSettings | null>(null)
  const [draftBaseRevision, setDraftBaseRevision] = React.useState<string | null>(null)
  const [serverSaveError, setServerSaveError] = React.useState<string | null>(null)
  const [serverSuccessNotice, setServerSuccessNotice] = React.useState<string | null>(null)

  const serverDraft = userEditedDraft ?? server
  const isServerDirty = userEditedDraft !== null

  // 辅助更新 serverDraft 并锁定编辑基准版本
  const updateServerDraft = React.useCallback(
    (updater: (prev: ServerSettings) => ServerSettings) => {
      setUserEditedDraft((prev) => updater(prev ?? server))
      setDraftBaseRevision((prev) => (prev !== null ? prev : revision))
    },
    [server, revision]
  )

  // 检测并发冲突：用户有未保存的 draft，但后台拉到的 revision 已变化
  const hasConflict = React.useMemo(() => {
    return (
      isServerDirty &&
      revision !== null &&
      draftBaseRevision !== null &&
      revision !== draftBaseRevision
    )
  }, [isServerDirty, revision, draftBaseRevision])

  // 复用 lib/settings 的 validateServerSettings，传 defaults.collection 保留原部署浮点
  const formValidationError = React.useMemo(() => {
    try {
      validateServerSettings(serverDraft, defaults.collection)
      return null
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  }, [serverDraft, defaults.collection])

  const isServerDraftValid = formValidationError === null

  // 更新个人偏好包装
  const handleUpdatePreferences = (next: PersonalPreferences, successMsg: string) => {
    try {
      updatePreferences(next)
      setLocalError(null)
      setLocalFeedback(successMsg)
      setTimeout(() => setLocalFeedback(null), 3000)
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : String(e))
    }
  }

  // 恢复特定偏好组默认
  const handleResetDisplayPreferences = () => {
    handleUpdatePreferences(
      { ...preferences, display: DEFAULT_PERSONAL_PREFERENCES.display },
      "已恢复显示格式默认设置"
    )
  }

  const handleResetRefreshPreferences = () => {
    handleUpdatePreferences(
      { ...preferences, refresh: DEFAULT_PERSONAL_PREFERENCES.refresh },
      "已恢复刷新与时间范围默认设置"
    )
  }

  const handleResetAllPreferences = () => {
    handleUpdatePreferences(DEFAULT_PERSONAL_PREFERENCES, "已恢复全部个人偏好设置")
  }

  // 恢复特定共享组草稿默认（标记为未保存，等待用户显式保存）
  const handleResetMonitoringDraft = () => {
    updateServerDraft((prev) => ({
      ...prev,
      monitoring: defaults.monitoring,
    }))
    setServerSuccessNotice("监控阈值已重置为部署默认草稿，请显式点击下方“保存全站共享设置”")
  }

  const handleResetCollectionAndHealthDraft = () => {
    updateServerDraft((prev) => ({
      ...prev,
      collection: defaults.collection,
      health: defaults.health,
    }))
    setServerSuccessNotice("采集与健康判定已重置为部署默认草稿，请显式点击下方“保存全站共享设置”")
  }

  // 放弃共享设置修改
  const handleDiscardServerChanges = () => {
    setUserEditedDraft(null)
    setDraftBaseRevision(null)
    setServerSaveError(null)
    setServerSuccessNotice(null)
  }

  // 保存服务端设置（乐观锁守卫）
  const handleSaveServerSettings = async () => {
    if (!isServerDraftValid || saving || loading || !revision || Boolean(serverError) || hasConflict) return
    setServerSaveError(null)
    setServerSuccessNotice(null)
    try {
      await saveServerSettings(serverDraft)
      setUserEditedDraft(null)
      setDraftBaseRevision(null)
      // 勿称已生效：标注采集间隔待确认，监控健康即刻保存
      setServerSuccessNotice("采集间隔等待采集器确认；监控与健康规则已保存")
      setTimeout(() => setServerSuccessNotice(null), 4000)
    } catch (e) {
      setServerSaveError(e instanceof Error ? e.message : String(e))
    }
  }

  // 重新加载服务器配置（仅真实成功才清草稿，失败保持 draft 并报错）
  const handleReloadLatestServerSettings = async () => {
    setServerSaveError(null)
    setServerSuccessNotice(null)
    try {
      await loadServerSettings()
      setUserEditedDraft(null)
      setDraftBaseRevision(null)
      setServerSuccessNotice("已同步最新服务端设置")
      setTimeout(() => setServerSuccessNotice(null), 4000)
    } catch (e) {
      setServerSaveError(`重新加载失败，已保留当前草稿：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const themeDisplay =
    theme === "dark" ? "暗色模式 (Dark)" : theme === "light" ? "亮色模式 (Light)" : "跟随系统 (System)"

  // 采集器状态展示（优先检查 error，避免 unconfirmed 吞掉异常报告；仅 stale 报心跳过期，pending 独立展示）
  const isStaleHeartbeat = collector?.state === "stale"
  const isPendingRevision = Boolean(
    collector?.observedRevision && revision && collector.observedRevision !== revision
  )

  const collectorStateBadge = React.useMemo(() => {
    if (collector?.error) {
      return (
        <Badge variant="destructive" className="text-[12px] h-5 px-1.5 font-medium">
          采集确认异常
        </Badge>
      )
    }
    if (!collector || collector.state === "unconfirmed") {
      return (
        <Badge variant="outline" className="text-[12px] h-5 px-1.5 font-medium text-muted-foreground border-border bg-muted/20">
          待心跳确认
        </Badge>
      )
    }
    if (isStaleHeartbeat) {
      return (
        <Badge variant="destructive" className="text-[12px] h-5 px-1.5 font-medium">
          心跳已过期 (&gt;90s)
        </Badge>
      )
    }
    return (
      <Badge variant="outline" className="text-[12px] h-5 px-1.5 font-medium text-emerald-600 dark:text-emerald-400 border-emerald-500/30 bg-emerald-500/10">
        调度运行中
      </Badge>
    )
  }, [collector, isStaleHeartbeat])

  const collectorDescription = React.useMemo(() => {
    if (collector?.error) return `采集确认异常: ${collector.error}`
    if (!collector || collector.state === "unconfirmed") return "待心跳确认"
    if (isStaleHeartbeat) return "采集心跳已超过 90 秒未上报（调度延迟或采集进程异常）"
    const parts: string[] = []
    if (collector.overrides.logs || collector.overrides.spend) parts.push("启动参数覆盖生效")
    if (collector.logsEnabled === false) parts.push("日志采集已停用")
    if (isPendingRevision) parts.push("待采用（调度重排中）")
    const logs = collector.effective.logsMinutes != null ? `${collector.effective.logsMinutes}m` : "未上报"
    const spend = collector.effective.spendMinutes != null ? `${collector.effective.spendMinutes}m` : "未上报"
    parts.push(`日志 ${logs} · 余额 ${spend}`)
    return parts.join(" · ")
  }, [collector, isStaleHeartbeat, isPendingRevision])

  return (
    <div className="flex-1 min-h-0 min-w-0 flex flex-col gap-6 overflow-y-auto px-1 pb-4 sm:px-4">
      {/* 顶部全局提示 / 错误条 */}
      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-3.5 py-2.5 flex items-start gap-2.5 shrink-0 text-destructive text-[13px] leading-[18px]">
          <AlertTriangle className="size-4 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <span className="font-semibold">设置服务提示：</span>
            <span>{error}</span>
          </div>
        </div>
      )}

      {localError && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-3.5 py-2.5 flex items-start gap-2.5 shrink-0 text-destructive text-[13px] leading-[18px]">
          <AlertTriangle className="size-4 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <span className="font-semibold">本地存储异常：</span>
            <span>{localError}</span>
          </div>
        </div>
      )}

      {localFeedback && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3.5 py-2 flex items-center gap-2 shrink-0 text-emerald-600 dark:text-emerald-400 text-[13px] leading-[18px]">
          <Check className="size-4 shrink-0" />
          <span>{localFeedback}</span>
        </div>
      )}

      {/* 1. 显示领域设置 (本地即时生效) */}
      <section className="mx-auto w-full max-w-[880px] shrink-0 border-b border-border/70 pb-6">
        <header className="pb-3 flex flex-row items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-[16px] leading-[24px] font-semibold text-foreground">
                显示
              </h2>
              <Badge variant="outline" className="text-[12px] h-5 px-1.5 font-medium text-muted-foreground border-border bg-muted/20">
                本机 · 即时保存
              </Badge>
            </div>
          </div>
          <Button variant="outline" size="sm" className="text-[12px] h-7 px-2.5" onClick={handleResetDisplayPreferences}>
            <RotateCcw className="size-3.5 mr-1" />
            恢复默认
          </Button>
        </header>

        <div>
          <div className="flex flex-col divide-y divide-border/50">
            {/* 数量 / Token 计量单位 */}
            <div className="grid min-w-0 grid-cols-1 items-center gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_300px] sm:gap-x-6">
              <label className="text-[13px] font-medium text-foreground">数量 / Token 单位制</label>
              <ToggleGroup
                value={[preferences.display.unitSystem]}
                onValueChange={(vals) => {
                  const val = vals?.[0]
                  if (val === "zh" || val === "en" || val === "raw") {
                    handleUpdatePreferences(
                      { ...preferences, display: { ...preferences.display, unitSystem: val } },
                      `已切换单位制为：${val === "zh" ? "中文 (万/亿)" : val === "en" ? "英文 (k/M/B)" : "完整原始数值"}`
                    )
                  }
                }}
                variant="outline"
                size="sm"
                className="w-full sm:max-w-sm flex"
              >
                <ToggleGroupItem value="zh" className="flex-1 text-[12px] h-8">中文 (万/亿)</ToggleGroupItem>
                <ToggleGroupItem value="en" className="flex-1 text-[12px] h-8">英文 (k/M/B)</ToggleGroupItem>
                <ToggleGroupItem value="raw" className="flex-1 text-[12px] h-8">完整数值</ToggleGroupItem>
              </ToggleGroup>
            </div>

            {/* 金额小数位数 */}
            <NumberSettingField
              label="金额小数位 (0 - 4)"
              hint="默认 2 位，控制 $ 金额精度"
              value={Number.isFinite(preferences.display.currencyDecimals) ? preferences.display.currencyDecimals : ""}
              min={0}
              max={4}
              onChange={(val) => {
                const num = parseInputNumber(val)
                if (Number.isInteger(num) && num >= 0 && num <= 4) {
                  handleUpdatePreferences(
                    { ...preferences, display: { ...preferences.display, currencyDecimals: num } },
                    `金额小数位已设为 ${num} 位`
                  )
                }
              }}
            />

            {/* Token / 数量小数位数 */}
            <NumberSettingField
              label="Token / 数量小数位 (0 - 4)"
              hint="默认 2 位，控制缩写数量精度"
              value={Number.isFinite(preferences.display.tokenDecimals) ? preferences.display.tokenDecimals : ""}
              min={0}
              max={4}
              onChange={(val) => {
                const num = parseInputNumber(val)
                if (Number.isInteger(num) && num >= 0 && num <= 4) {
                  handleUpdatePreferences(
                    { ...preferences, display: { ...preferences.display, tokenDecimals: num } },
                    `数量小数位已设为 ${num} 位`
                  )
                }
              }}
            />

            {/* 百分比小数位数 */}
            <NumberSettingField
              label="常规百分比小数位 (0 - 3)"
              hint="健康成功率固定保留 2 位，避免 99.98% 显示为 100%"
              value={Number.isFinite(preferences.display.percentDecimals) ? preferences.display.percentDecimals : ""}
              min={0}
              max={3}
              onChange={(val) => {
                const num = parseInputNumber(val)
                if (Number.isInteger(num) && num >= 0 && num <= 3) {
                  handleUpdatePreferences(
                    { ...preferences, display: { ...preferences.display, percentDecimals: num } },
                    `百分比小数位已设为 ${num} 位`
                  )
                }
              }}
            />
          </div>
        </div>
      </section>

      {/* 2. 刷新领域设置 (本地即时生效) */}
      <section className="mx-auto w-full max-w-[880px] shrink-0 border-b border-border/70 pb-6">
        <header className="pb-3 flex flex-row items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-[16px] leading-[24px] font-semibold text-foreground">
                刷新
              </h2>
              <Badge variant="outline" className="text-[12px] h-5 px-1.5 font-medium text-muted-foreground border-border bg-muted/20">
                本机 · 即时保存
              </Badge>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="outline" size="sm" className="text-[12px] h-7 px-2.5" onClick={handleResetRefreshPreferences}>
              <RotateCcw className="size-3.5 mr-1" />
              恢复默认
            </Button>
            <Button variant="ghost" size="sm" className="text-[12px] h-7 px-2.5 text-muted-foreground" onClick={handleResetAllPreferences}>
              恢复全部偏好
            </Button>
          </div>
        </header>

        <div>
          <div className="flex flex-col divide-y divide-border/50">
            {/* 自动刷新周期 */}
            <div className="grid min-w-0 grid-cols-1 items-center gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_300px] sm:gap-x-6">
              <label className="text-[13px] font-medium text-foreground">自动刷新间隔</label>
              <ToggleGroup
                value={[String(preferences.refresh.intervalMinutes)]}
                onValueChange={(vals) => {
                  const val = vals?.[0]
                  if (val !== undefined) {
                    const intVal = parseInt(val, 10) as PersonalPreferences["refresh"]["intervalMinutes"]
                    if ([0, 5, 15, 30, 60].includes(intVal)) {
                      handleUpdatePreferences(
                        { ...preferences, refresh: { ...preferences.refresh, intervalMinutes: intVal } },
                        intVal === 0 ? "已关闭前端自动定时刷新" : `自动刷新周期已设置为 ${intVal} 分钟`
                      )
                    }
                  }
                }}
                variant="outline"
                size="sm"
                className="w-full flex flex-wrap"
              >
                <ToggleGroupItem value="0" className="flex-1 min-w-[50px] text-[12px] h-8">关闭</ToggleGroupItem>
                <ToggleGroupItem value="5" className="flex-1 min-w-[50px] text-[12px] h-8">5m</ToggleGroupItem>
                <ToggleGroupItem value="15" className="flex-1 min-w-[50px] text-[12px] h-8">15m</ToggleGroupItem>
                <ToggleGroupItem value="30" className="flex-1 min-w-[50px] text-[12px] h-8">30m</ToggleGroupItem>
                <ToggleGroupItem value="60" className="flex-1 min-w-[50px] text-[12px] h-8">60m</ToggleGroupItem>
              </ToggleGroup>
            </div>

            {/* 后台挂起暂停刷新 */}
            <div className="grid min-w-0 grid-cols-1 items-center gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_300px] sm:gap-x-6">
              <label className="text-[13px] font-medium text-foreground">后台刷新</label>
              <div className="flex items-center gap-2 pt-1">
                <Checkbox
                  id="pauseWhenHidden"
                  checked={preferences.refresh.pauseWhenHidden}
                  onCheckedChange={(checked) => {
                    handleUpdatePreferences(
                      { ...preferences, refresh: { ...preferences.refresh, pauseWhenHidden: Boolean(checked) } },
                      checked ? "已开启后台隐藏暂停节流" : "已允许后台标签页持续轮询"
                    )
                  }}
                  disabled={preferences.refresh.intervalMinutes === 0}
                />
                <label
                  htmlFor="pauseWhenHidden"
                  className={cn(
                    "text-[13px] font-normal cursor-pointer select-none",
                    preferences.refresh.intervalMinutes === 0 ? "opacity-50 cursor-not-allowed" : "text-foreground"
                  )}
                >
                  页面隐藏时暂停，返回时补刷
                </label>
              </div>
            </div>

            {/* 默认时间范围 */}
            <div className="grid min-w-0 grid-cols-1 items-center gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_300px] sm:gap-x-6">
              <label className="text-[13px] font-medium text-foreground">默认时间范围</label>
              <ToggleGroup
                value={[preferences.refresh.defaultRange]}
                onValueChange={(vals) => {
                  const val = vals?.[0]
                  if (val === "24h" || val === "7d" || val === "today" || val === "remember") {
                    handleUpdatePreferences(
                      { ...preferences, refresh: { ...preferences.refresh, defaultRange: val } },
                      `默认时间窗口已设定为：${val === "remember" ? "记住上次选择" : val}`
                    )
                  }
                }}
                variant="outline"
                size="sm"
                className="grid w-full grid-cols-2 gap-1.5"
              >
                <ToggleGroupItem value="today" className="min-w-0 text-[12px] h-8">今日</ToggleGroupItem>
                <ToggleGroupItem value="24h" className="flex-1 text-[12px] h-8">24 小时 (默认)</ToggleGroupItem>
                <ToggleGroupItem value="7d" className="flex-1 text-[12px] h-8">7 天</ToggleGroupItem>
                <ToggleGroupItem value="remember" className="flex-1 text-[12px] h-8">记住上次选择</ToggleGroupItem>
              </ToggleGroup>
            </div>
          </div>
        </div>
      </section>

      {/* 3 & 4. 全站共享设置：saving 时通过 fieldset 禁用所有共享输入与恢复默认，避免覆盖保存中用户新输入 */}
      <fieldset disabled={saving} className="contents m-0 p-0 border-0">
        {/* 3. 告警领域设置 (全站共享) */}
        <section className="mx-auto w-full max-w-[880px] shrink-0 border-b border-border/70 pb-6">
        <header className="pb-3 flex flex-row items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-[16px] leading-[24px] font-semibold text-foreground">
                告警
              </h2>
              <Badge variant="secondary" className="text-[12px] h-5 px-1.5 font-medium">
                全站 · 需保存
              </Badge>
              {loading && <RefreshCw className="size-3 animate-spin text-muted-foreground" />}
            </div>
          </div>
          <Button variant="outline" size="sm" className="text-[12px] h-7 px-2.5" onClick={handleResetMonitoringDraft} disabled={saving || loading}>
            <RotateCcw className="size-3.5 mr-1" />
            恢复默认
          </Button>
        </header>

        <div>
          <div className="flex flex-col divide-y divide-border/50">
            {/* 缓存命中率阈值 */}
            <ThresholdPairField
              label="缓存命中率"
              hint="低于警告值变黄，低于严重值变红"
              comparator="<"
              leftLabel="警告 %"
              rightLabel="严重 %"
              leftTone="warn"
              rightTone="danger"
              leftValue={Number.isFinite(serverDraft.monitoring.cacheRate.good) ? toFloatString(serverDraft.monitoring.cacheRate.good * 100) : ""}
              rightValue={Number.isFinite(serverDraft.monitoring.cacheRate.warn) ? toFloatString(serverDraft.monitoring.cacheRate.warn * 100) : ""}
              min={0}
              max={100}
              step={0.5}
              onLeftChange={(v) => {
                const num = parseInputNumber(v) / 100
                updateServerDraft((prev) => ({
                  ...prev,
                  monitoring: { ...prev.monitoring, cacheRate: { ...prev.monitoring.cacheRate, good: num } },
                }))
              }}
              onRightChange={(v) => {
                const num = parseInputNumber(v) / 100
                updateServerDraft((prev) => ({
                  ...prev,
                  monitoring: { ...prev.monitoring, cacheRate: { ...prev.monitoring.cacheRate, warn: num } },
                }))
              }}
            />

            {/* P50 延迟阈值 */}
            <ThresholdPairField
              label="P50 延迟"
              hint="超过警告值变黄，超过严重值变红"
              comparator=">"
              leftLabel="警告 秒"
              rightLabel="严重 秒"
              leftTone="warn"
              rightTone="danger"
              leftValue={Number.isFinite(serverDraft.monitoring.latencyP50.goodMs) ? toFloatString(serverDraft.monitoring.latencyP50.goodMs / 1000) : ""}
              rightValue={Number.isFinite(serverDraft.monitoring.latencyP50.warnMs) ? toFloatString(serverDraft.monitoring.latencyP50.warnMs / 1000) : ""}
              min={0.001}
              max={3600}
              step={0.001}
              onLeftChange={(v) => {
                const num = parseInputNumber(v) * 1000
                updateServerDraft((prev) => ({
                  ...prev,
                  monitoring: { ...prev.monitoring, latencyP50: { ...prev.monitoring.latencyP50, goodMs: num } },
                }))
              }}
              onRightChange={(v) => {
                const num = parseInputNumber(v) * 1000
                updateServerDraft((prev) => ({
                  ...prev,
                  monitoring: { ...prev.monitoring, latencyP50: { ...prev.monitoring.latencyP50, warnMs: num } },
                }))
              }}
            />

            {/* P95 延迟阈值 */}
            <ThresholdPairField
              label="P95 延迟"
              hint="超过警告值变黄，超过严重值变红"
              comparator=">"
              leftLabel="警告 秒"
              rightLabel="严重 秒"
              leftTone="warn"
              rightTone="danger"
              leftValue={Number.isFinite(serverDraft.monitoring.latencyP95.goodMs) ? toFloatString(serverDraft.monitoring.latencyP95.goodMs / 1000) : ""}
              rightValue={Number.isFinite(serverDraft.monitoring.latencyP95.warnMs) ? toFloatString(serverDraft.monitoring.latencyP95.warnMs / 1000) : ""}
              min={0.001}
              max={3600}
              step={0.001}
              onLeftChange={(v) => {
                const num = parseInputNumber(v) * 1000
                updateServerDraft((prev) => ({
                  ...prev,
                  monitoring: { ...prev.monitoring, latencyP95: { ...prev.monitoring.latencyP95, goodMs: num } },
                }))
              }}
              onRightChange={(v) => {
                const num = parseInputNumber(v) * 1000
                updateServerDraft((prev) => ({
                  ...prev,
                  monitoring: { ...prev.monitoring, latencyP95: { ...prev.monitoring.latencyP95, warnMs: num } },
                }))
              }}
            />

            {/* 资金续航天数（允许小数） */}
            <ThresholdPairField
              label="预计耗尽"
              hint="低于警告天数变黄，低于严重天数变红"
              comparator="<"
              leftLabel="警告 天"
              rightLabel="严重 天"
              leftTone="warn"
              rightTone="danger"
              leftValue={Number.isFinite(serverDraft.monitoring.runway.warnDays) ? toFloatString(serverDraft.monitoring.runway.warnDays) : ""}
              rightValue={Number.isFinite(serverDraft.monitoring.runway.dangerDays) ? toFloatString(serverDraft.monitoring.runway.dangerDays) : ""}
              min={0.01}
              max={3650}
              step={0.5}
              onLeftChange={(v) => {
                const num = parseInputNumber(v)
                updateServerDraft((prev) => ({
                  ...prev,
                  monitoring: { ...prev.monitoring, runway: { ...prev.monitoring.runway, warnDays: num } },
                }))
              }}
              onRightChange={(v) => {
                const num = parseInputNumber(v)
                updateServerDraft((prev) => ({
                  ...prev,
                  monitoring: { ...prev.monitoring, runway: { ...prev.monitoring.runway, dangerDays: num } },
                }))
              }}
            />

            {/* 数据新鲜度阈值（允许小数） */}
            <ThresholdPairField
              label="数据陈旧"
              hint="超过警告分钟数变黄，超过严重分钟数变红"
              comparator=">"
              leftLabel="警告 分钟"
              rightLabel="严重 分钟"
              leftTone="warn"
              rightTone="danger"
              leftValue={Number.isFinite(serverDraft.monitoring.freshness.warnMinutes) ? toFloatString(serverDraft.monitoring.freshness.warnMinutes) : ""}
              rightValue={Number.isFinite(serverDraft.monitoring.freshness.dangerMinutes) ? toFloatString(serverDraft.monitoring.freshness.dangerMinutes) : ""}
              min={0.01}
              max={10080}
              step={5}
              onLeftChange={(v) => {
                const num = parseInputNumber(v)
                updateServerDraft((prev) => ({
                  ...prev,
                  monitoring: { ...prev.monitoring, freshness: { ...prev.monitoring.freshness, warnMinutes: num } },
                }))
              }}
              onRightChange={(v) => {
                const num = parseInputNumber(v)
                updateServerDraft((prev) => ({
                  ...prev,
                  monitoring: { ...prev.monitoring, freshness: { ...prev.monitoring.freshness, dangerMinutes: num } },
                }))
              }}
            />
          </div>
        </div>
      </section>

      {/* 4. 采集与健康判定，保留真实调度确认状态。 */}
      <section className="mx-auto w-full max-w-[880px] shrink-0 border-b border-border/70 pb-6">
        <header className="pb-3 flex flex-row items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-[16px] leading-[24px] font-semibold text-foreground">
                采集
              </h2>
              <Badge variant="secondary" className="text-[12px] h-5 px-1.5 font-medium">
                全站 · 需保存
              </Badge>
            </div>
          </div>
          <Button variant="outline" size="sm" className="text-[12px] h-7 px-2.5" onClick={handleResetCollectionAndHealthDraft} disabled={saving || loading}>
            <RotateCcw className="size-3.5 mr-1" />
            恢复默认
          </Button>
        </header>

        <div>
          <div className="flex flex-col divide-y divide-border/50">
            {/* 日志采集间隔 */}
            <NumberSettingField
              label="日志采集间隔 (分钟)"
              hint={`默认 ${defaults.collection.logsMinutes} 分钟，新输入必须是 1 至 1440 整数`}
              value={Number.isFinite(serverDraft.collection.logsMinutes) ? serverDraft.collection.logsMinutes : ""}
              min={1}
              max={1440}
              step={1}
              onChange={(v) => {
                const num = parseInputNumber(v)
                updateServerDraft((prev) => ({
                  ...prev,
                  collection: { ...prev.collection, logsMinutes: num },
                }))
              }}
            />

            {/* 余额采集间隔 */}
            <div className="flex flex-col gap-1.5">
              <NumberSettingField
                label="余额采集间隔 (分钟)"
                hint={`默认 ${defaults.collection.spendMinutes} 分钟，新输入必须是 1 至 1440 整数`}
                value={Number.isFinite(serverDraft.collection.spendMinutes) ? serverDraft.collection.spendMinutes : ""}
                min={1}
                max={1440}
                step={1}
                onChange={(v) => {
                  const num = parseInputNumber(v)
                  updateServerDraft((prev) => ({
                    ...prev,
                    collection: { ...prev.collection, spendMinutes: num },
                  }))
                }}
              />
            </div>

            {/* 健康最小样本数 */}
            <NumberSettingField
              label="健康判定最小样本数 (次)"
              tone="neutral"
              hint="默认 3 次，单桶调用低于此值判定为样本不足"
              value={Number.isFinite(serverDraft.health.minSamples) ? serverDraft.health.minSamples : ""}
              min={1}
              max={1000000}
              step={1}
              onChange={(v) => {
                const num = parseInputNumber(v)
                updateServerDraft((prev) => ({
                  ...prev,
                  health: { ...prev.health, minSamples: num },
                }))
              }}
            />

            {/* 判定为故障的错误率阈值 */}
            <NumberSettingField
              label="故障判定错误率临界点 (%)"
              tone="danger"
              hint="默认 2%，严格大于 0% 且不超过 100%"
              value={Number.isFinite(serverDraft.health.failErrorRate) ? toFloatString(serverDraft.health.failErrorRate * 100) : ""}
              min={0.01}
              max={100}
              step={0.1}
              onChange={(v) => {
                const num = parseInputNumber(v) / 100
                updateServerDraft((prev) => ({
                  ...prev,
                  health: { ...prev.health, failErrorRate: num },
                }))
              }}
            />
          </div>

          <Alert className="mt-4 bg-muted/30 border-border/70">
            <AlertTriangle aria-hidden="true" />
            <AlertDescription className="text-[12px] leading-[18px]" title="余额间隔过长或不能整除 60 分钟，可能缺少核算边界前后 5 分钟内的快照；不会额外补采整点或北京零点。">
              余额采集间隔可能影响边界快照与成本核算。
            </AlertDescription>
          </Alert>

          {/* 采集器确认与运行情况透传卡底 */}
          <div className="mt-4 pt-3 border-t border-border/70 flex flex-col gap-2 text-[12px] leading-[16px] text-muted-foreground">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="font-medium text-foreground flex items-center gap-1">
                <Activity className="size-3.5 text-muted-foreground" />
                采集调度状态：
              </span>
              <span>{collectorStateBadge}</span>
              {collector?.error && (
                <Badge variant="destructive" className="text-[11px] h-auto min-h-4.5 max-w-full whitespace-normal break-words px-1 font-medium">
                  采集确认异常: {collector.error}
                </Badge>
              )}
              {isPendingRevision && (
                <Badge variant="outline" className="text-[11px] h-4.5 px-1 font-medium border-amber-500/40 text-amber-600 dark:text-amber-400 bg-amber-500/10">
                  配置等待采用 (调度重排中)
                </Badge>
              )}
              {collector?.overrides.logs && (
                <Badge variant="outline" className="text-[11px] h-4.5 px-1 font-medium border-amber-500/40 text-amber-600 dark:text-amber-400">
                  日志 CLI 参数覆盖
                </Badge>
              )}
              {collector?.overrides.spend && (
                <Badge variant="outline" className="text-[11px] h-4.5 px-1 font-medium border-amber-500/40 text-amber-600 dark:text-amber-400">
                  余额 CLI 参数覆盖
                </Badge>
              )}
              {collector?.logsEnabled === false && (
                <Badge variant="outline" className="text-[11px] h-4.5 px-1 font-medium border-rose-500/40 text-rose-600 dark:text-rose-400">
                  日志采集已停用
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-x-2 gap-y-1 flex-wrap font-mono text-[12px]">
              <span className="text-foreground/90">
                实际生效: 日志 {collector?.effective.logsMinutes != null ? `${collector.effective.logsMinutes}m` : "未上报"} · 余额 {collector?.effective.spendMinutes != null ? `${collector.effective.spendMinutes}m` : "未上报"}
              </span>
              <span>·</span>
              {collector?.updatedAt ? (
                <span>最后心跳: {formatBeijingClock(collector.updatedAt, true)}</span>
              ) : (
                <span>暂无心跳</span>
              )}
            </div>
          </div>
        </div>
      </section>
      </fieldset>

      {/* 服务端设置持久化操作栏 (Dirty / Conflict 状态控制) */}
      {(isServerDirty || hasConflict || serverSaveError || serverSuccessNotice || formValidationError) && (
        <div className="sticky bottom-0 z-10 mx-auto w-full max-w-[880px] rounded-lg border border-border bg-card/95 p-3 shadow-sm backdrop-blur-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3 shrink-0">
          <div className="flex-1 min-w-0">
            {hasConflict ? (
              <div className="flex items-center gap-2 text-destructive text-[13px] leading-[18px]">
                <AlertTriangle className="size-4 shrink-0" />
                <span className="font-semibold">
                  配置已更新，请重新载入。{serverSaveError && <span className="block font-normal">{serverSaveError}</span>}
                </span>
              </div>
            ) : serverSaveError ? (
              <div className="flex items-center gap-2 text-destructive text-[13px] leading-[18px]">
                <AlertTriangle className="size-4 shrink-0" />
                <span>保存失败：{serverSaveError}</span>
              </div>
            ) : formValidationError ? (
              <div className="flex items-center gap-2 text-destructive text-[13px] leading-[18px]">
                <AlertTriangle className="size-4 shrink-0" />
                <span>表单输入无效：{formValidationError}</span>
              </div>
            ) : serverSuccessNotice ? (
              <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400 text-[13px] leading-[18px]">
                <Check className="size-4 shrink-0" />
                <span>{serverSuccessNotice}</span>
              </div>
            ) : isServerDirty ? (
              <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400 text-[13px] leading-[18px]">
                <SlidersHorizontal className="size-4 shrink-0" />
                <span className="font-medium">
                  共享设置尚未保存
                </span>
              </div>
            ) : null}
          </div>

          <div className="flex items-center gap-2.5 flex-wrap shrink-0 self-end sm:self-auto">
            {hasConflict ? (
              <Button
                variant="outline"
                size="sm"
                className="text-[13px] h-8 px-3"
                onClick={handleReloadLatestServerSettings}
              >
                <RefreshCw className="size-3.5 mr-1.5" />
                重新载入最新配置
              </Button>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-[13px] h-8 px-3 text-muted-foreground"
                  onClick={handleDiscardServerChanges}
                  disabled={saving || loading}
                >
                  放弃修改
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  className="text-[13px] h-8 px-4 font-medium"
                  onClick={handleSaveServerSettings}
                  disabled={!isServerDirty || !isServerDraftValid || saving || loading || !revision || Boolean(serverError)}
                >
                  {saving ? (
                    <>
                      <RefreshCw className="size-3.5 mr-1.5 animate-spin" />
                      正在保存...
                    </>
                  ) : (
                    "保存全站共享设置"
                  )}
                </Button>
              </>
            )}
          </div>
        </div>
      )}
      {/* 实例信息置于设置末尾，避免打断表单。 */}
      <section className="mx-auto w-full max-w-[880px] shrink-0">
        <header className="pb-3 flex flex-row items-center justify-between gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-[16px] leading-[24px] font-semibold text-foreground">实例</h2>
            {meta?.preview && (
              <Badge variant="secondary" className="text-[12px] h-5 px-1.5 font-medium">预览模式</Badge>
            )}
          </div>
          <Server className="size-4 text-muted-foreground shrink-0" />
        </header>
        <div>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 [&>div]:min-w-0">
            <div className="rounded-lg bg-muted/30 p-3 flex flex-col">
              <div className="flex items-center gap-1.5 text-muted-foreground text-[12px]">
                <Globe className="size-3.5" />站点名称
              </div>
              <span className="text-[14px] font-medium text-foreground mt-1 truncate capitalize" title={meta?.site_name || meta?.site || "Relay Ledger"}>
                {meta?.site_name || meta?.site || "Relay Ledger"}
              </span>
            </div>
            <div className="rounded-lg bg-muted/30 p-3 flex flex-col">
              <div className="flex items-center gap-1.5 text-muted-foreground text-[12px]">
                <Globe className="size-3.5" />基础地址
              </div>
              <span className="text-[14px] font-mono text-foreground mt-1 truncate" title={meta?.base_url || "https://ai.aobzii.cn"}>
                {meta?.base_url || "https://ai.aobzii.cn"}
              </span>
            </div>
            <div className="rounded-lg bg-muted/30 p-3 flex flex-col">
              <div className="flex items-center gap-1.5 text-muted-foreground text-[12px]">
                <HardDrive className="size-3.5" />数据源目录
              </div>
              <span className="text-[14px] font-mono text-foreground mt-1 truncate" title={meta?.source || "./data"}>
                {meta?.source || "./data"}
              </span>
            </div>
            <div className="rounded-lg bg-muted/30 p-3 flex flex-col">
              <div className="flex items-center justify-between gap-2 flex-wrap text-muted-foreground text-[12px]">
                <span className="flex items-center gap-1.5"><Clock className="size-3.5" />采集调度</span>
                {collectorStateBadge}
              </div>
              <span className="text-[13px] font-mono text-foreground mt-1 break-words" title={collectorDescription}>
                {collectorDescription}
              </span>
            </div>
            <div className="rounded-lg bg-muted/30 p-3 flex flex-col">
              <div className="flex items-center gap-1.5 text-muted-foreground text-[12px]">
                <Palette className="size-3.5" />当前主题
              </div>
              <span className="text-[14px] font-medium text-foreground mt-1">{themeDisplay}</span>
            </div>
            <div className="rounded-lg bg-muted/30 p-3 flex flex-col">
              <div className="flex items-center gap-1.5 text-muted-foreground text-[12px]">
                <Coins className="size-3.5" />基准汇率
              </div>
              <span className="text-[14px] font-mono tabular-nums text-foreground mt-1 break-words">
                1 {meta?.currency || "USD"} = {formatRawNumber(meta?.quota_per_unit || 500000)} Q
              </span>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
