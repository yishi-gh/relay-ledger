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
import { Wallet, Hourglass, CreditCard, Percent, AlertCircle } from "lucide-react"
import {
  formatCurrency,
  formatPercent,
  formatTimestamp,
} from "@/lib/formatters"
import { SiteLogo } from "@/components/site-logo"
import {
  type SortState,
  type AccessorMap,
  nextSort,
  sortRows,
  getSortHeaderAttrs,
} from "@/lib/table-sort"
import { ColPicker, type ColumnItem } from "@/components/col-picker"
import { cn } from "@/lib/utils"
import type { CapitalAccount, CapitalPayload, DateRange, ProfitQuality, ProfitSite, RangeType } from "@/lib/api"
import type { UpstreamAccount } from "@/lib/api-types"
import { getServerSettings } from "@/lib/settings"

// 保留原有导出路径，兼容既有引用。
export type { UpstreamAccount } from "@/lib/api-types"

export type UpstreamViewMode = "biz" | "audit" | "all"

interface MergedUpstreamAccount extends UpstreamAccount {
  funding?: CapitalAccount
  ledger?: ProfitSite
}

const UPSTREAMS_STORAGE_KEY = "relay-ledger:upstreams-columns:v3"
const UPSTREAMS_PREVIOUS_STORAGE_KEY = "relay-ledger:upstreams-columns:v2"
const UPSTREAMS_LEGACY_STORAGE_KEY = "relay-ledger-cols-upstreams"

export const UPSTREAMS_ALL_COLUMNS: ColumnItem[] = [
  { key: "account", label: "账户", locked: true, group: "biz" },
  { key: "enabled", label: "启用状态", group: "biz" },
  { key: "latest_balance", label: "总计余额", group: "biz" },
  { key: "runway_days", label: "预计耗尽", group: "biz" },
  { key: "daily_avg_7d", label: "7日日均", group: "biz" },
  { key: "revenue", label: "售出", group: "biz" },
  { key: "funding_cost", label: "区间成本", group: "audit" },
  { key: "balance", label: "期末余额", group: "audit" },
  { key: "credits", label: "充值", group: "biz" },
  { key: "cost", label: "成本", group: "biz" },
  { key: "profit", label: "利润", group: "biz" },
  { key: "margin_pct", label: "毛利率", group: "biz" },
  { key: "status", label: "账本状态", group: "biz" },
  { key: "profit_status", label: "利润状态", group: "biz" },
  { key: "funding_status", label: "资金状态", group: "audit" },
  { key: "reported_spend", label: "区间上报", group: "audit" },
  { key: "reported_today", label: "今日上报", group: "audit" },
  { key: "consumption", label: "推导消费", group: "audit" },
  { key: "channels", label: "渠道（x/y）", group: "audit" },
  { key: "last_sync", label: "最后同步", group: "audit" },
]

const UPSTREAMS_DEFAULT_KEYS: Record<UpstreamViewMode, string[]> = {
  biz: ["account", "latest_balance", "runway_days", "daily_avg_7d", "revenue", "funding_cost", "credits", "cost", "profit", "margin_pct", "status"],
  audit: ["account", "enabled", "funding_cost", "balance", "reported_spend", "consumption", "channels", "last_sync"],
  all: [
    "account",
    "enabled",
    "latest_balance",
    "runway_days",
    "daily_avg_7d",
    "revenue",
    "funding_cost",
    "balance",
    "credits",
    "cost",
    "profit",
    "margin_pct",
    "status",
    "profit_status",
    "funding_status",
    "reported_spend",
    "reported_today",
    "consumption",
    "channels",
    "last_sync",
  ],
}

const UPSTREAMS_COL_PIXELS: Record<string, number> = {
  account: 210,
  enabled: 132,
  balance: 110,
  latest_balance: 110,
  runway_days: 104,
  daily_avg_7d: 104,
  revenue: 110,
  credits: 110,
  cost: 110,
  profit: 110,
  margin_pct: 92,
  status: 114,
  profit_status: 114,
  funding_status: 114,
  funding_cost: 130,
  reported_spend: 110,
  reported_today: 110,
  consumption: 110,
  channels: 104,
  last_sync: 156,
}

type ChannelStatusInfo =
  | { type: "unknown"; total?: number }
  | { type: "none"; total: 0 }
  | { type: "disabled"; live: 0; total: number }
  | { type: "partial"; live: number; total: number }
  | { type: "enabled"; live: number; total: number }

// 解析关联 NewAPI 渠道启用状态：total 由 channels_total 或 channels 去重数确定，缺计数标状态未知
function getChannelStatus(a: UpstreamAccount): ChannelStatusInfo {
  const hasChannelsArr = Array.isArray(a.channels)
  const channelsCount = hasChannelsArr ? new Set(a.channels).size : undefined

  const total =
    typeof a.channels_total === "number" && Number.isFinite(a.channels_total) && a.channels_total >= 0
      ? a.channels_total
      : channelsCount

  const hasLive =
    typeof a.channels_live === "number" && Number.isFinite(a.channels_live) && a.channels_live >= 0
  const live = hasLive ? (a.channels_live as number) : undefined

  // 显式 total === 0 或明确空数组 => 无关联渠道
  if (total === 0) {
    return { type: "none", total: 0 }
  }

  // 缺少总数或 live 计数 => 状态未知
  if (total === undefined || live === undefined) {
    return { type: "unknown", total }
  }

  const safeLive = Math.min(live, total)
  if (safeLive === 0) {
    return { type: "disabled", live: 0, total }
  }
  if (safeLive < total) {
    return { type: "partial", live: safeLive, total }
  }
  return { type: "enabled", live: safeLive, total }
}

function getChannelStatusRank(a: UpstreamAccount): number {
  const status = getChannelStatus(a)
  switch (status.type) {
    case "enabled":
      return 4
    case "partial":
      return 3
    case "disabled":
      return 2
    case "none":
      return 1
    case "unknown":
      return 0
  }
}

const UPSTREAM_ACCESSORS: AccessorMap<MergedUpstreamAccount> = {
  account: (a) => a.name || a.id,
  enabled: (a) => getChannelStatusRank(a),
  balance: (a) => a.closing_balance ?? null,
  latest_balance: (a) => a.funding?.balance ?? null,
  runway_days: (a) => a.funding?.runway_days != null && Number.isFinite(a.funding.runway_days) ? a.funding.runway_days : null,
  daily_avg_7d: (a) => a.funding?.daily_avg_7d ?? null,
  revenue: (a) => a.ledger?.revenue ?? null,
  credits: (a) => a.credits ?? null,
  cost: (a) => a.ledger?.cost ?? null,
  profit: (a) => a.ledger?.profit ?? null,
  margin_pct: (a) => a.ledger?.margin ?? null,
  status: (a) => a.status || "",
  profit_status: (a) => a.ledger?.status ?? null,
  funding_status: (a) => a.funding?.status ?? null,
  funding_cost: (a) => a.funding?.cost_range ?? null,
  reported_spend: (a) => a.reported_spend_range ?? null,
  reported_today: (a) => a.reported_consumption ?? null,
  consumption: (a) => a.consumption ?? null,
  channels: (a) => a.channels_live ?? a.channels?.length ?? null,
  last_sync: (a) => a.last_sync ?? null,
}

interface UpstreamsViewProps {
  timeRange: RangeType
  accounts: UpstreamAccount[]
  capital?: CapitalPayload | null
  profitSites?: ProfitSite[]
  quality?: ProfitQuality | null
  dateRange?: DateRange | null
  refreshKey?: number
}

function getDefaultSortedRows(accounts: MergedUpstreamAccount[]): MergedUpstreamAccount[] {
  return [...accounts].sort((a, b) => {
    const left = a.funding?.runway_days
    const right = b.funding?.runway_days
    const leftValid = left != null && Number.isFinite(left)
    const rightValid = right != null && Number.isFinite(right)
    if (leftValid && rightValid) return left - right
    if (leftValid) return -1
    if (rightValid) return 1
    return 0
  })
}

function loadVisibleMap(
  key: string,
  defaults: Record<UpstreamViewMode, string[]>
): Record<UpstreamViewMode, string[]> {
  if (typeof window === "undefined") return defaults
  const validKeys = new Set(UPSTREAMS_ALL_COLUMNS.map((column) => column.key))
  const readMap = (saved: string): Record<UpstreamViewMode, string[]> => {
    try {
      const parsed: unknown = JSON.parse(saved)
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return defaults
      const record = parsed as Record<string, unknown>
      const readKeys = (mode: UpstreamViewMode) => {
        const value = record[mode]
        if (!Array.isArray(value)) return defaults[mode]
        const keys = value.filter((item): item is string => typeof item === "string" && validKeys.has(item))
        return keys.length > 0 ? [...new Set(["account", ...keys])] : defaults[mode]
      }
      return { biz: readKeys("biz"), audit: readKeys("audit"), all: readKeys("all") }
    } catch {
      return defaults
    }
  }
  try {
    const saved = localStorage.getItem(key)
    if (saved !== null) return readMap(saved)
    const legacy = localStorage.getItem(UPSTREAMS_PREVIOUS_STORAGE_KEY) ?? localStorage.getItem(UPSTREAMS_LEGACY_STORAGE_KEY)
    const previous = legacy === null ? defaults : readMap(legacy)
    // 仅首次迁入 v3 时补回区间成本；已有 v3 尊重用户隐藏，balance 仍表示期末余额。
    const migrated = {
      biz: [...new Set([...previous.biz, "funding_cost"])],
      audit: [...new Set([...previous.audit, "funding_cost"])],
      all: [...new Set([...previous.all, "funding_cost"])],
    }
    try {
      localStorage.setItem(key, JSON.stringify(migrated))
    } catch {
      // 存储不可写时，本次仍使用迁移后的列选择。
    }
    return migrated
  } catch {
    return defaults
  }
}

export function UpstreamsView({ timeRange, accounts, capital, profitSites, quality, dateRange }: UpstreamsViewProps) {
  const mergedAccounts = React.useMemo<MergedUpstreamAccount[]>(() => {
    const fundingMap = new Map(capital?.accounts.map((account) => [account.account_id, account]))
    const ledgerMap = new Map(profitSites?.map((account) => [account.account_id, account]))
    return accounts.map((account) => ({ ...account, funding: fundingMap.get(account.id), ledger: ledgerMap.get(account.id) }))
  }, [accounts, capital, profitSites])
  const [viewMode, setViewMode] = React.useState<UpstreamViewMode>("biz")

  // 可见列按视图保存
  const [visibleMap, setVisibleMap] = React.useState<Record<UpstreamViewMode, string[]>>(
    () => loadVisibleMap(UPSTREAMS_STORAGE_KEY, UPSTREAMS_DEFAULT_KEYS)
  )

  const [sortState, setSortState] = React.useState<SortState | null>(null)
  const rangeKey = `${timeRange}:${dateRange?.from ?? ""}:${dateRange?.to ?? ""}`
  const [prevTimeRange, setPrevTimeRange] = React.useState(rangeKey)
  if (prevTimeRange !== rangeKey) {
    setPrevTimeRange(rangeKey)
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
    const eligible = profitSites?.filter((site) => site.kind !== "external") ?? []
    const covered = eligible.filter((site) => site.cost != null && site.profit != null && Number.isFinite(site.cost) && Number.isFinite(site.profit))
    const allCovered = eligible.length > 0 && covered.length === eligible.length
    const revenue = allCovered ? covered.reduce((sum, site) => sum + site.revenue, 0) : null
    const profit = allCovered ? covered.reduce((sum, site) => sum + site.profit!, 0) : null
    const shortest = (capital?.accounts ?? []).filter((account) => account.channels_live !== 0 && account.runway_days != null && Number.isFinite(account.runway_days)).reduce<CapitalAccount | null>((current, account) => !current || account.runway_days! < current.runway_days! ? account : current, null)
    return {
      totalBalance: capital?.total.balance,
      totalCredits: capital?.total.credits_range,
      weightedMargin: revenue != null && revenue > 0 && profit != null ? profit / revenue : null,
      coveredCount: covered.length,
      accountCount: eligible.length,
      shortest,
    }
  }, [capital, profitSites])
  const runwayThresholds = getServerSettings().monitoring.runway
  const shortestDays = kpiData.shortest?.runway_days
  const totalRunwayDays = capital?.total.runway_days
  const missingAccountIds = quality?.accounts_missing_balance ?? []
  const missingAccountNames = missingAccountIds.map((id) => accounts.find((account) => account.id === id)?.name || id)

  // 排序行
  const sortedRows = React.useMemo(() => {
    if (!effectiveSort) {
      return getDefaultSortedRows(mergedAccounts)
    }
    return sortRows(mergedAccounts, effectiveSort, UPSTREAM_ACCESSORS)
  }, [mergedAccounts, effectiveSort])

  const visibleCols = UPSTREAMS_ALL_COLUMNS.filter((c) => activeKeys.includes(c.key))

  const tableMinWidth = visibleCols.reduce((sum, column) => sum + UPSTREAMS_COL_PIXELS[column.key], 0)

  return (
    <div className="flex-1 min-h-0 min-w-0 flex flex-col gap-4 overflow-y-auto pr-1">
      {/* 顶部 4 张 KPI 卡（等高） */}
      <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3.5 shrink-0 [&>[data-slot=card]]:min-w-0">
        <Card className="shadow-xs gap-0 p-3.5 flex flex-col">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-[14px] leading-[20px] font-normal text-muted-foreground">
              总计余额
            </span>
            <Wallet className="size-4" />
          </div>
          <div className="mt-3 text-[24px] leading-[28px] font-semibold font-mono tabular-nums text-foreground">
            {formatCurrency(kpiData.totalBalance)}
          </div>
          <span className="text-[12px] leading-[16px] text-muted-foreground mt-1" title={capital?.total.accounts_counted != null ? `${capital.total.accounts_counted} 个账户参与估算` : undefined}>
            7日日均 {formatCurrency(capital?.total.daily_avg_7d)}
          </span>
        </Card>

        <Card className="shadow-xs gap-0 p-3.5 flex flex-col">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-[14px] leading-[20px] font-normal text-muted-foreground">
              最早耗尽
            </span>
            <Hourglass className="size-4 text-amber-500" />
          </div>
          <div className="mt-3 flex min-w-0 items-baseline gap-2 text-[22px] leading-[28px] font-semibold tabular-nums">
            <span className="min-w-0 flex-1 truncate" title={kpiData.shortest?.name}>{kpiData.shortest?.name ?? "—"}</span>
            <span className={cn("shrink-0 text-[24px]", shortestDays != null && shortestDays < runwayThresholds.dangerDays ? "text-rose-600 dark:text-rose-400" : shortestDays != null && shortestDays < runwayThresholds.warnDays ? "text-amber-600 dark:text-amber-400" : "text-foreground")}>
              {shortestDays != null ? shortestDays.toFixed(1) : "—"}<span className="ml-1 text-[13px] font-normal text-muted-foreground">天后耗尽</span>
            </span>
          </div>
          <span className="text-[12px] leading-[16px] text-muted-foreground mt-1">
            综合 {totalRunwayDays != null && Number.isFinite(totalRunwayDays) ? `${totalRunwayDays.toFixed(1)} 天` : "—"}
          </span>
        </Card>

        <Card className="shadow-xs gap-0 p-3.5 flex flex-col">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-[14px] leading-[20px] font-normal text-muted-foreground">
              区间成本
            </span>
            <CreditCard className="size-4 text-indigo-500" />
          </div>
          <div className="mt-3 text-[24px] leading-[28px] font-semibold font-mono tabular-nums text-foreground" title="资金口径；可能仅含部分时段">
            {formatCurrency(capital?.total.cost_range)}
          </div>
          <span className="text-[12px] leading-[16px] text-muted-foreground mt-1">
            区间充值 {formatCurrency(kpiData.totalCredits)}
          </span>
        </Card>

        <Card className="shadow-xs gap-0 p-3.5 flex flex-col">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-[14px] leading-[20px] font-normal text-muted-foreground">
              核算毛利
            </span>
            <Percent className="size-4 text-amber-500" />
          </div>
          <div className="mt-3 text-[24px] leading-[28px] font-semibold font-mono tabular-nums text-foreground">
            {formatPercent(kpiData.weightedMargin)}
          </div>
          <span className="text-[12px] leading-[16px] text-muted-foreground mt-1">
            已核算 {kpiData.coveredCount} / {kpiData.accountCount} 个账户
          </span>
        </Card>
      </section>

      {!capital && <div role="alert" className="flex shrink-0 items-center gap-2 text-[12px] text-muted-foreground"><AlertCircle className="size-4 shrink-0" />余额数据暂不可用</div>}

      {missingAccountIds.length > 0 && <div role="alert" className="flex shrink-0 items-start gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-[12px] text-muted-foreground"><AlertCircle className="size-4 shrink-0" /><span>缺快照：{missingAccountNames.join("、")}</span></div>}

      {/* 下方表卡 */}
      <Card
        data-slot="detail-card"
        className="shadow-xs overflow-hidden flex flex-col min-w-0 p-4 flex-1 min-h-0"
      >
        <CardHeader className="p-0 pb-3 flex flex-row items-center justify-between space-y-0 shrink-0 gap-3 flex-wrap">
          <div className="flex items-center gap-2.5 flex-wrap">
            <CardTitle className="text-[16px] leading-[24px] font-medium text-foreground">
              上游账户
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
                对账
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
            <Table className="table-fixed text-sm [--name-column-width:136px] sm:[--name-column-width:210px]" style={{ minWidth: `calc(${tableMinWidth - UPSTREAMS_COL_PIXELS.account}px + var(--name-column-width))` }}>
              <colgroup>
                {visibleCols.map((col) => (
                  <col key={col.key} style={col.key === "account" ? undefined : { width: `${UPSTREAMS_COL_PIXELS[col.key]}px` }} />
                ))}
              </colgroup>
              <TableHeader className="bg-muted/50 sticky top-0 z-20 backdrop-blur-xs">
                <TableRow className="hover:bg-transparent border-b border-border h-9">
                  {visibleCols.map((col) => {
                    const isLocked = col.key === "account"
                    const isNum = [
                      "balance",
                      "latest_balance",
                      "runway_days",
                      "daily_avg_7d",
                      "revenue",
                      "credits",
                      "cost",
                      "funding_cost",
                      "profit",
                      "margin_pct",
                      "reported_spend",
                      "reported_today",
                      "consumption",
                      "channels",
                    ].includes(col.key)
                    const sortAttrs = getSortHeaderAttrs(effectiveSort ?? { key: "runway_days", dir: "asc" }, col.key)

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
                            "relative inline-flex items-center"
                          )}
                        >
                          <span>{col.label}</span>
                          <span
                            className={cn(
                              "absolute text-[12px] leading-[16px] tabular-nums transition-opacity",
                              isNum ? "right-[calc(100%+4px)]" : "left-[calc(100%+4px)]",
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
                        "latest_balance",
                        "runway_days",
                        "daily_avg_7d",
                        "revenue",
                        "credits",
                        "cost",
                        "funding_cost",
                        "profit",
                        "margin_pct",
                        "reported_spend",
                        "reported_today",
                        "consumption",
                        "channels",
                      ].includes(col.key)

                      let content: React.ReactNode = null

                      switch (col.key) {
                        case "account": {
                          const autoCount = row.auto_channels?.length ?? 0
                          const accountTitle = autoCount > 0
                            ? `${row.name || row.id} (含 ${autoCount} 个自动关联渠道)`
                            : (row.name || row.id)
                          content = (
                            <div className="flex items-center gap-2 min-w-0" title={accountTitle}>
                              <SiteLogo kind="account" id={row.id} label={row.name || row.id} size={18} />
                              <div className="flex flex-col justify-center min-w-0 leading-tight">
                                <span
                                  className="font-medium text-foreground text-[13px] leading-[18px] truncate"
                                  title={accountTitle}
                                >
                                  {row.name || row.id}
                                </span>
                                <span className="font-mono text-[11px] leading-[15px] text-muted-foreground">
                                  {row.kind}
                                </span>
                              </div>
                            </div>
                          )
                          break
                        }
                        case "enabled": {
                          const status = getChannelStatus(row)
                          switch (status.type) {
                            case "unknown":
                              content = (
                                <Badge
                                  variant="outline"
                                  className="text-[12px] leading-[16px] h-5 px-1.5 whitespace-nowrap font-medium text-muted-foreground border-border bg-muted/20"
                                  title="未获取到关联渠道状态数据"
                                >
                                  状态未知
                                </Badge>
                              )
                              break
                            case "none":
                              content = (
                                <Badge
                                  variant="secondary"
                                  className="text-[12px] leading-[16px] h-5 px-1.5 whitespace-nowrap font-medium text-muted-foreground"
                                  title="该账户暂无关联的 NewAPI 渠道"
                                >
                                  无关联渠道
                                </Badge>
                              )
                              break
                            case "disabled":
                              content = (
                                <Badge
                                  variant="outline"
                                  className="text-[12px] leading-[16px] h-5 px-1.5 whitespace-nowrap font-medium text-rose-600 dark:text-rose-400 border-rose-500/30 bg-rose-500/10"
                                  title={`关联 NewAPI 渠道已全部停用 (0/${status.total})`}
                                >
                                  已停用
                                </Badge>
                              )
                              break
                            case "partial":
                              content = (
                                <Badge
                                  variant="outline"
                                  className="text-[12px] leading-[16px] h-5 px-1.5 whitespace-nowrap font-medium text-amber-600 dark:text-amber-400 border-amber-500/30 bg-amber-500/10"
                                  title={`关联 NewAPI 渠道部分启用 (${status.live}/${status.total})`}
                                >
                                  部分启用 ({status.live}/{status.total})
                                </Badge>
                              )
                              break
                            case "enabled":
                              content = (
                                <Badge
                                  variant="outline"
                                  className="text-[12px] leading-[16px] h-5 px-1.5 whitespace-nowrap font-medium text-emerald-600 dark:text-emerald-400 border-emerald-500/30 bg-emerald-500/10"
                                  title={`关联 NewAPI 渠道全部启用 (${status.live}/${status.total})`}
                                >
                                  启用
                                </Badge>
                              )
                              break
                          }
                          break
                        }
                        case "latest_balance":
                          content = <span className="font-semibold" title={row.funding?.status === "missing_balance" ? "缺失总计余额" : undefined}>{formatCurrency(row.funding?.balance)}</span>
                          break
                        case "runway_days": {
                          const days = row.funding?.runway_days
                          content = days != null && Number.isFinite(days) ? <span className={cn(days < runwayThresholds.dangerDays ? "text-rose-600 dark:text-rose-400" : days < runwayThresholds.warnDays ? "text-amber-600 dark:text-amber-400" : "text-foreground")}>{days.toFixed(1)} 天</span> : "—"
                          break
                        }
                        case "daily_avg_7d":
                          content = formatCurrency(row.funding?.daily_avg_7d)
                          break
                        case "revenue":
                          content = formatCurrency(row.ledger?.revenue)
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
                          content = formatCurrency(row.ledger?.cost)
                          break
                        case "funding_cost":
                          content = <span title="资金口径；可能仅含部分时段">{formatCurrency(row.funding?.cost_range)}</span>
                          break
                        case "profit":
                          content = <span className={row.ledger?.profit != null && row.ledger.profit < 0 ? "text-rose-600 dark:text-rose-400" : undefined}>{formatCurrency(row.ledger?.profit)}</span>
                          break
                        case "margin_pct":
                          content = (
                            <span
                              className={cn(
                                "font-mono tabular-nums text-[13px] leading-[18px]",
                                row.ledger?.margin != null && row.ledger.margin > 0
                                  ? "text-emerald-600 dark:text-emerald-400 font-medium"
                                : row.ledger?.margin != null && row.ledger.margin < 0
                                  ? "text-rose-600 dark:text-rose-400 font-medium"
                                  : "text-muted-foreground"
                              )}
                            >
                              {formatPercent(row.ledger?.margin)}
                            </span>
                          )
                          break
                        case "status":
                        case "profit_status":
                        case "funding_status": {
                          const status = col.key === "profit_status" ? row.ledger?.status : col.key === "funding_status" ? row.funding?.status : row.status
                          const labels: Record<string, string> = { complete: "已核算", partial: "部分数据", missing_balance: "缺余额", unavailable: "缺快照", unconfigured: "未配置", no_cost: "无成本源", no_revenue: "无售出", disabled_account: "已停用", ok: "余额已采集" }
                          content = status ? <Badge variant="outline" title={[col.key === "status" ? row.reason : null, col.key === "profit_status" && row.ledger ? `覆盖 ${row.ledger.covered_buckets}/${row.ledger.bucket_count}` : null].filter(Boolean).join("；")} className={cn("whitespace-nowrap text-[12px]", status === "complete" ? "text-emerald-600 dark:text-emerald-400" : status === "partial" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>{col.key === "profit_status" && status === "missing_balance" ? "缺快照" : labels[status] ?? status}</Badge> : "—"
                          break
                        }
                        case "reported_spend":
                          content = formatCurrency(row.reported_spend_range)
                          break
                        case "reported_today":
                          content = formatCurrency(row.reported_consumption)
                          break
                        case "consumption":
                          content = formatCurrency(row.consumption)
                          break
                        case "channels": {
                          const autoCount = row.auto_channels?.length ?? 0
                          const baseText =
                            row.channels_live != null
                              ? `${row.channels_live} / ${row.channels_total ?? row.channels?.length ?? 0}`
                              : String(row.channels?.length ?? 0)
                          const autoTooltip = autoCount > 0
                            ? `关联渠道: ${baseText} (含 ${autoCount} 个自动关联渠道)`
                            : undefined

                          content = (
                            <span title={autoTooltip}>
                              {baseText}
                            </span>
                          )
                          break
                        }
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
