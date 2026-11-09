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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Wallet, CheckCircle2, CreditCard, Percent } from "lucide-react"
import {
  formatCurrency,
  formatPercent,
  formatTimestamp,
} from "@/lib/formatters"
import { MarginCell } from "@/components/table-visualizers"
import {
  type SortState,
  type AccessorMap,
  nextSort,
  sortRows,
  getSortHeaderAttrs,
} from "@/lib/table-sort"
import { ColPicker, type ColumnItem } from "@/components/col-picker"
import { cn } from "@/lib/utils"

export type UpstreamViewMode = "biz" | "audit" | "all"

export interface UpstreamAccount {
  id: string
  name: string
  kind: "sub2api" | "newapi" | "external" | string
  base_url?: string
  status: "complete" | "partial" | "unavailable" | "unconfigured" | string
  reason?: string | null
  opening_balance?: number | null
  closing_balance?: number | null
  credits?: number | null
  credit_events?: number | null
  consumption?: number | null
  reported_consumption?: number | null
  reported_spend_range?: number | null
  last_sync?: number | null
  unit?: string
  local_revenue?: number | null
  margin?: number | null
  margin_pct?: number | null
  channels?: number[]
  channels_live?: number
  channels_total?: number
  enabled?: boolean
  external?: boolean
  cost?: number | null
  profit?: number | null
}

const UPSTREAMS_STORAGE_KEY = "relay-ledger-cols-upstreams"

export const UPSTREAMS_ALL_COLUMNS: ColumnItem[] = [
  { key: "account", label: "账户", locked: true, group: "biz" },
  { key: "enabled", label: "启用状态", group: "biz" },
  { key: "balance", label: "当前余额", group: "biz" },
  { key: "credits", label: "充值", group: "biz" },
  { key: "cost", label: "成本", group: "biz" },
  { key: "profit", label: "利润", group: "biz" },
  { key: "margin_pct", label: "毛利率", group: "biz" },
  { key: "status", label: "状态", group: "biz" },
  { key: "reported_spend", label: "上报消费", group: "audit" },
  { key: "consumption", label: "推导消费", group: "audit" },
  { key: "channels", label: "渠道（x/y）", group: "audit" },
  { key: "last_sync", label: "最后同步", group: "audit" },
]

const UPSTREAMS_DEFAULT_KEYS: Record<UpstreamViewMode, string[]> = {
  biz: ["account", "enabled", "balance", "credits", "cost", "profit", "margin_pct", "status"],
  audit: ["account", "reported_spend", "consumption", "channels", "last_sync"],
  all: [
    "account",
    "enabled",
    "balance",
    "credits",
    "cost",
    "profit",
    "margin_pct",
    "status",
    "reported_spend",
    "channels",
    "last_sync",
  ],
}

const UPSTREAMS_COL_WEIGHTS: Record<string, number> = {
  account: 20,
  enabled: 9,
  balance: 13,
  credits: 11,
  cost: 12,
  profit: 12,
  margin_pct: 13,
  status: 10,
  reported_spend: 14,
  consumption: 14,
  channels: 11,
  last_sync: 14,
}

function computeColWidths(
  visibleKeys: string[],
  weightsMap: Record<string, number>
): Record<string, string> {
  const total = visibleKeys.reduce((acc, k) => acc + (weightsMap[k] ?? 12), 0)
  const result: Record<string, string> = {}
  visibleKeys.forEach((k) => {
    const w = weightsMap[k] ?? 12
    result[k] = `${((w / (total || 1)) * 100).toFixed(2)}%`
  })
  return result
}

const UPSTREAM_ACCESSORS: AccessorMap<UpstreamAccount> = {
  account: (a) => a.name || a.id,
  enabled: (a) => (a.enabled === false ? 0 : a.external ? 1 : 2),
  balance: (a) => a.closing_balance ?? null,
  credits: (a) => a.credits ?? null,
  cost: (a) => a.consumption ?? null,
  profit: (a) => a.margin ?? null,
  margin_pct: (a) => a.margin_pct ?? null,
  status: (a) => a.status || "",
  reported_spend: (a) => (a.reported_spend_range ?? a.reported_consumption) ?? null,
  consumption: (a) => a.consumption ?? null,
  channels: (a) => a.channels_live ?? a.channels?.length ?? null,
  last_sync: (a) => a.last_sync ?? null,
}

interface UpstreamsViewProps {
  timeRange: "24h" | "7d"
  accounts: UpstreamAccount[]
}

/**
 * 默认行序：启用且有余额（余额升序）→ 启用无余额 → 已禁用/无上游（名称升序）
 */
function getDefaultSortedRows(accounts: UpstreamAccount[]): UpstreamAccount[] {
  const group1 = accounts
    .filter((a) => a.enabled !== false && !a.external && a.closing_balance != null)
    .sort((a, b) => (a.closing_balance ?? 0) - (b.closing_balance ?? 0))

  const group2 = accounts
    .filter((a) => a.enabled !== false && !a.external && a.closing_balance == null)
    .sort((a, b) =>
      (a.name || a.id).localeCompare(b.name || b.id, "zh-Hans-CN", { numeric: true })
    )

  const group3 = accounts
    .filter((a) => a.enabled === false || a.external === true)
    .sort((a, b) =>
      (a.name || a.id).localeCompare(b.name || b.id, "zh-Hans-CN", { numeric: true })
    )

  return [...group1, ...group2, ...group3]
}

function loadVisibleMap(
  key: string,
  defaults: Record<UpstreamViewMode, string[]>
): Record<UpstreamViewMode, string[]> {
  if (typeof window === "undefined") return defaults
  try {
    const saved = localStorage.getItem(key)
    if (saved) {
      const parsed = JSON.parse(saved)
      if (parsed && typeof parsed === "object") {
        return {
          biz: Array.isArray(parsed.biz) && parsed.biz.length > 0 ? parsed.biz : defaults.biz,
          audit: Array.isArray(parsed.audit) && parsed.audit.length > 0 ? parsed.audit : defaults.audit,
          all: Array.isArray(parsed.all) && parsed.all.length > 0 ? parsed.all : defaults.all,
        }
      }
    }
  } catch {
    // fallback
  }
  return defaults
}

export function UpstreamsView({ timeRange, accounts }: UpstreamsViewProps) {
  const [viewMode, setViewMode] = React.useState<UpstreamViewMode>("biz")

  // 可见列按视图保存
  const [visibleMap, setVisibleMap] = React.useState<Record<UpstreamViewMode, string[]>>(
    () => loadVisibleMap(UPSTREAMS_STORAGE_KEY, UPSTREAMS_DEFAULT_KEYS)
  )

  const [sortState, setSortState] = React.useState<SortState | null>(null)
  const [prevTimeRange, setPrevTimeRange] = React.useState(timeRange)
  if (prevTimeRange !== timeRange) {
    setPrevTimeRange(timeRange)
    setSortState(null)
  }

  const activeKeys = visibleMap[viewMode] || UPSTREAMS_DEFAULT_KEYS[viewMode]

  // 切视图保留排序键（若该列在新视图不可见则回落到默认）
  const effectiveSort = React.useMemo(() => {
    if (!sortState) return null
    return activeKeys.includes(sortState.key) ? sortState : null
  }, [sortState, activeKeys])

  const handleSort = React.useCallback(
    (key: string) => {
      setSortState(() => nextSort(effectiveSort, key))
    },
    [effectiveSort]
  )

  const toggleColumn = React.useCallback(
    (key: string) => {
      if (key === "account") return
      setVisibleMap((prev) => {
        const curKeys = prev[viewMode] || UPSTREAMS_DEFAULT_KEYS[viewMode]
        const nextKeys = curKeys.includes(key)
          ? curKeys.filter((k) => k !== key)
          : [...curKeys, key]
        const nextMap = { ...prev, [viewMode]: nextKeys }
        try {
          localStorage.setItem(UPSTREAMS_STORAGE_KEY, JSON.stringify(nextMap))
        } catch {
          // ignore
        }
        return nextMap
      })
    },
    [viewMode]
  )

  // KPI 汇总计算
  const kpiData = React.useMemo(() => {
    const activeAccounts = accounts.filter((a) => a.enabled !== false && !a.external)
    const totalBalance = activeAccounts.reduce(
      (sum, a) => sum + (a.closing_balance ?? 0),
      0
    )

    const enabledAccounts = accounts.filter((a) => a.enabled !== false)
    const completeCount = enabledAccounts.filter((a) => a.status === "complete").length
    const partialCount = enabledAccounts.filter((a) => a.status === "partial").length
    const missingCount = enabledAccounts.filter(
      (a) => a.status === "unavailable" || a.status === "unconfigured"
    ).length

    const totalCredits = accounts.reduce((sum, a) => sum + (a.credits ?? 0), 0)

    const totalMargin = accounts.reduce((sum, a) => sum + (a.margin ?? 0), 0)
    const totalLocalRevenue = accounts.reduce((sum, a) => sum + (a.local_revenue ?? 0), 0)
    const weightedMargin = totalLocalRevenue > 0 ? totalMargin / totalLocalRevenue : null

    return {
      totalBalance,
      completeCount,
      partialCount,
      missingCount,
      enabledTotal: enabledAccounts.length,
      totalCredits,
      weightedMargin,
      totalMargin,
      totalLocalRevenue,
      activeCount: activeAccounts.length,
    }
  }, [accounts])

  // 排序行
  const sortedRows = React.useMemo(() => {
    if (!effectiveSort) {
      return getDefaultSortedRows(accounts)
    }
    return sortRows(accounts, effectiveSort, UPSTREAM_ACCESSORS)
  }, [accounts, effectiveSort])

  const visibleCols = UPSTREAMS_ALL_COLUMNS.filter((c) => activeKeys.includes(c.key))

  const colWidths = React.useMemo(() => {
    const keys = visibleCols.map((c) => c.key)
    return computeColWidths(keys, UPSTREAMS_COL_WEIGHTS)
  }, [visibleCols])

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-4 overflow-y-auto pr-1">
      {/* 顶部 4 张 KPI 卡（等高） */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3.5 shrink-0">
        <Card className="shadow-xs p-3.5 flex flex-col justify-between">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-[14px] leading-[20px] font-normal text-muted-foreground">
              账户余额合计
            </span>
            <Wallet className="size-4" />
          </div>
          <div className="mt-1.5 text-[24px] leading-[28px] font-semibold font-mono tabular-nums text-foreground">
            {formatCurrency(kpiData.totalBalance)}
          </div>
          <span className="text-[12px] leading-[16px] text-muted-foreground mt-1">
            {kpiData.activeCount} 个在用账户余额
          </span>
        </Card>

        <Card className="shadow-xs p-3.5 flex flex-col justify-between">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-[14px] leading-[20px] font-normal text-muted-foreground">
              已核算账户
            </span>
            <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />
          </div>
          <div className="mt-1.5 text-[24px] leading-[28px] font-semibold font-mono tabular-nums text-foreground">
            {kpiData.completeCount} / {kpiData.enabledTotal}
            <span className="text-[14px] font-normal font-sans text-muted-foreground ml-1">
              个
            </span>
          </div>
          <span className="text-[12px] leading-[16px] text-muted-foreground mt-1">
            部分数据 {kpiData.partialCount} · 缺快照 {kpiData.missingCount}
          </span>
        </Card>

        <Card className="shadow-xs p-3.5 flex flex-col justify-between">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-[14px] leading-[20px] font-normal text-muted-foreground">
              本期充值合计
            </span>
            <CreditCard className="size-4 text-indigo-500" />
          </div>
          <div className="mt-1.5 text-[24px] leading-[28px] font-semibold font-mono tabular-nums text-foreground">
            {formatCurrency(kpiData.totalCredits)}
          </div>
          <span className="text-[12px] leading-[16px] text-muted-foreground mt-1">
            {timeRange === "24h" ? "近 24 小时充值入账" : "近 7 天充值入账"}
          </span>
        </Card>

        <Card className="shadow-xs p-3.5 flex flex-col justify-between">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-[14px] leading-[20px] font-normal text-muted-foreground">
              加权毛利率
            </span>
            <Percent className="size-4 text-amber-500" />
          </div>
          <div className="mt-1.5 text-[24px] leading-[28px] font-semibold font-mono tabular-nums text-foreground">
            {formatPercent(kpiData.weightedMargin)}
          </div>
          <span className="text-[12px] leading-[16px] text-muted-foreground mt-1">
            Σ利润 {formatCurrency(kpiData.totalMargin)} ÷ Σ售出 {formatCurrency(kpiData.totalLocalRevenue)}
          </span>
        </Card>
      </section>

      {/* 下方表卡 */}
      <Card
        data-slot="detail-card"
        className="shadow-xs overflow-hidden flex flex-col min-w-0 p-4 flex-1 min-h-0"
      >
        <CardHeader className="p-0 pb-3 flex flex-row items-center justify-between space-y-0 shrink-0 gap-3 flex-wrap">
          <div className="flex items-center gap-2.5 flex-wrap">
            <CardTitle className="text-[16px] leading-[24px] font-medium text-foreground">
              上游账户明细
            </CardTitle>

            {/* 经营/核算/全部视图切换 */}
            <ToggleGroup
              value={[viewMode]}
              onValueChange={(vals) => {
                const val = vals?.[0]
                if (val === "biz" || val === "audit" || val === "all") {
                  setViewMode(val)
                }
              }}
              variant="outline"
              size="sm"
              className="shrink-0"
            >
              <ToggleGroupItem
                value="biz"
                className="text-[12px] leading-[16px] px-2.5 h-7 font-medium cursor-pointer data-[state=on]:bg-accent data-[state=on]:text-accent-foreground"
              >
                经营
              </ToggleGroupItem>
              <ToggleGroupItem
                value="audit"
                className="text-[12px] leading-[16px] px-2.5 h-7 font-medium cursor-pointer data-[state=on]:bg-accent data-[state=on]:text-accent-foreground"
              >
                核算
              </ToggleGroupItem>
              <ToggleGroupItem
                value="all"
                className="text-[12px] leading-[16px] px-2.5 h-7 font-medium cursor-pointer data-[state=on]:bg-accent data-[state=on]:text-accent-foreground"
              >
                全部
              </ToggleGroupItem>
            </ToggleGroup>

            <Badge
              variant="secondary"
              className="text-[12px] leading-[16px] h-5 px-1.5 font-medium tabular-nums"
            >
              {sortedRows.length} 个账户
            </Badge>
          </div>

          {/* 列选择器 */}
          <div className="flex items-center gap-2 shrink-0">
            <ColPicker
              columns={UPSTREAMS_ALL_COLUMNS}
              visibleKeys={activeKeys}
              onToggleColumn={toggleColumn}
            />
          </div>
        </CardHeader>

        <CardContent className="p-0 flex flex-col flex-1 min-h-0">
          <div
            className="rounded-lg border border-border bg-card overflow-hidden flex-1 min-h-[300px] lg:min-h-0"
          >
            <Table className={cn(
              "text-sm table-auto lg:table-fixed",
              visibleCols.length <= 8 ? "min-w-[760px] lg:min-w-full" : "min-w-[960px] lg:min-w-full"
            )}>
              <colgroup className="hidden lg:table-column-group">
                {visibleCols.map((col) => (
                  <col key={col.key} style={{ width: colWidths[col.key] || "10%" }} />
                ))}
              </colgroup>
              <TableHeader className="bg-muted/50 sticky top-0 z-20 backdrop-blur-xs">
                <TableRow className="hover:bg-transparent border-b border-border h-9">
                  {visibleCols.map((col) => {
                    const isLocked = col.key === "account"
                    const isNum = [
                      "balance",
                      "credits",
                      "cost",
                      "profit",
                      "margin_pct",
                      "reported_spend",
                      "consumption",
                      "channels",
                    ].includes(col.key)
                    const sortAttrs = getSortHeaderAttrs(effectiveSort, col.key)

                    return (
                      <TableHead
                        key={col.key}
                        aria-sort={sortAttrs.ariaSort}
                        onClick={() => handleSort(col.key)}
                        className={cn(
                          "h-9 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground whitespace-nowrap select-none cursor-pointer transition-colors group/th hover:bg-muted/80",
                          isNum ? "text-right" : "text-left",
                          isLocked && "sticky left-0 bg-muted z-30 border-r border-border min-w-[140px] sm:min-w-[160px]",
                          sortAttrs.isActive && "text-foreground font-semibold"
                        )}
                      >
                        <div
                          className={cn(
                            "inline-flex items-center gap-1.5",
                            isNum ? "flex-row-reverse" : "flex-row"
                          )}
                        >
                          <span>{col.label}</span>
                          <span
                            className={cn(
                              "font-mono text-[12px] leading-[16px] tabular-nums transition-opacity",
                              sortAttrs.isActive
                                ? "text-primary font-semibold opacity-100"
                                : "text-muted-foreground/40 opacity-0 group-hover/th:opacity-100"
                            )}
                          >
                            {sortAttrs.symbol}
                          </span>
                        </div>
                      </TableHead>
                    )
                  })}
                </TableRow>
              </TableHeader>

              <TableBody>
                {sortedRows.map((row) => (
                  <TableRow
                    key={row.id}
                    className="h-[44px] hover:bg-muted/40 transition-colors border-b border-border/60"
                  >
                    {visibleCols.map((col) => {
                      const isLocked = col.key === "account"
                      const isNum = [
                        "balance",
                        "credits",
                        "cost",
                        "profit",
                        "margin_pct",
                        "reported_spend",
                        "consumption",
                        "channels",
                      ].includes(col.key)

                      let content: React.ReactNode = null

                      switch (col.key) {
                        case "account":
                          content = (
                            <div className="flex flex-col justify-center min-w-0 leading-tight">
                              <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
                                <span
                                  className="font-medium text-foreground text-[13px] leading-[18px] line-clamp-2"
                                  title={row.name || row.id}
                                >
                                  {row.name || row.id}
                                </span>
                                {row.channels_live === 0 && (
                                  <Badge
                                    variant="destructive"
                                    className="text-[11px] leading-[14px] h-4.5 px-1.5 font-medium whitespace-nowrap shrink-0"
                                  >
                                    渠道已全部停用
                                  </Badge>
                                )}
                              </div>
                              <span className="font-mono text-[11px] leading-[15px] text-muted-foreground">
                                {row.kind}
                              </span>
                            </div>
                          )
                          break
                        case "enabled":
                          content =
                            row.enabled === false ? (
                              <Badge
                                variant="outline"
                                className="text-[12px] leading-[16px] h-5 px-1.5 font-medium text-muted-foreground border-border bg-muted/30"
                              >
                                已禁用
                              </Badge>
                            ) : row.external ? (
                              <Badge
                                variant="secondary"
                                className="text-[12px] leading-[16px] h-5 px-1.5 font-medium text-muted-foreground"
                              >
                                无上游
                              </Badge>
                            ) : (
                              <Badge
                                variant="outline"
                                className="text-[12px] leading-[16px] h-5 px-1.5 font-medium text-emerald-600 dark:text-emerald-400 border-emerald-500/30 bg-emerald-500/10"
                              >
                                启用
                              </Badge>
                            )
                          break
                        case "balance":
                          content = (
                            <span className="font-semibold text-foreground">
                              {formatCurrency(row.closing_balance)}
                            </span>
                          )
                          break
                        case "credits":
                          content =
                            row.status === "unavailable" || row.status === "unconfigured"
                              ? "—"
                              : formatCurrency(row.credits)
                          break
                        case "cost":
                          content = formatCurrency(row.consumption)
                          break
                        case "profit":
                          content = formatCurrency(row.margin)
                          break
                        case "margin_pct":
                          content = <MarginCell value={row.margin_pct} />
                          break
                        case "status":
                          content =
                            row.status === "complete" ? (
                              <Badge
                                variant="outline"
                                className="text-[12px] leading-[16px] h-5 px-1.5 whitespace-nowrap font-medium text-emerald-600 dark:text-emerald-400 border-emerald-500/30 bg-emerald-500/10"
                              >
                                已核算
                              </Badge>
                            ) : row.status === "partial" ? (
                              <Badge
                                variant="outline"
                                title={row.reason || "部分数据"}
                                className="text-[12px] leading-[16px] h-5 px-1.5 whitespace-nowrap font-medium text-amber-600 dark:text-amber-400 border-amber-500/30 bg-amber-500/10"
                              >
                                部分数据
                              </Badge>
                            ) : row.status === "unavailable" ? (
                              <Badge
                                variant="outline"
                                className="text-[12px] leading-[16px] h-5 px-1.5 whitespace-nowrap font-medium text-muted-foreground border-border bg-muted/30"
                              >
                                缺快照
                              </Badge>
                            ) : (
                              <Badge
                                variant="outline"
                                className="text-[12px] leading-[16px] h-5 px-1.5 whitespace-nowrap font-medium text-muted-foreground border-border bg-muted/30"
                              >
                                未配置
                              </Badge>
                            )
                          break
                        case "reported_spend":
                          content = formatCurrency(row.reported_spend_range ?? row.reported_consumption)
                          break
                        case "consumption":
                          content = formatCurrency(row.consumption)
                          break
                        case "channels":
                          content =
                            row.channels_live != null
                              ? `${row.channels_live} / ${row.channels_total ?? row.channels?.length ?? 0}`
                              : (row.channels?.length ?? 0)
                          break
                        case "last_sync":
                          content = (
                            <span className="text-muted-foreground">
                              {formatTimestamp(row.last_sync)}
                            </span>
                          )
                          break
                      }

                      return (
                        <TableCell
                          key={col.key}
                          className={cn(
                            "px-3 py-0 h-[44px] align-middle text-[13px] leading-[18px] font-mono tabular-nums whitespace-nowrap",
                            isNum ? "text-right" : "text-left",
                            isLocked && "sticky left-0 bg-card z-10 border-r border-border/50 min-w-[140px] sm:min-w-[160px]"
                          )}
                        >
                          {content}
                        </TableCell>
                      )
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
