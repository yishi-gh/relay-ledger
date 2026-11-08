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
import { Wallet, CheckCircle2, CreditCard, Percent } from "lucide-react"
import {
  formatCurrency,
  formatPercent,
  formatTimestamp,
} from "@/lib/formatters"
import {
  type SortState,
  type AccessorMap,
  sortRows,
  getSortHeaderAttrs,
} from "@/lib/table-sort"
import { cn } from "@/lib/utils"

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
  enabled?: boolean
  external?: boolean
}

const COL_WIDTH_PCT: Record<string, number> = {
  account: 18,
  enabled: 8,
  balance: 11,
  credits: 10,
  consumption: 11,
  margin_pct: 9,
  status: 11,
  last_sync: 13,
  channels: 9,
}

const UPSTREAM_ACCESSORS: AccessorMap<UpstreamAccount> = {
  balance: (a) => a.closing_balance ?? null,
  credits: (a) => a.credits ?? null,
  consumption: (a) => a.consumption ?? null,
  margin_pct: (a) => a.margin_pct ?? null,
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

export function UpstreamsView({ timeRange, accounts }: UpstreamsViewProps) {
  const [sortState, setSortState] = React.useState<SortState | null>(null)

  React.useEffect(() => {
    setSortState(null)
  }, [timeRange])

  const handleSort = React.useCallback((key: string) => {
    setSortState((prev) => {
      if (!prev || prev.key !== key) {
        return { key, dir: key === "balance" ? "asc" : "desc" }
      }
      if (key === "balance") {
        if (prev.dir === "asc") return { key, dir: "desc" }
        return null
      }
      if (prev.dir === "desc") return { key, dir: "asc" }
      return null
    })
  }, [])

  // KPI 汇总计算
  const kpiData = React.useMemo(() => {
    // 账户余额合计：只算 enabled 且非 external，closing_balance 求和，null 跳过
    const activeAccounts = accounts.filter((a) => a.enabled !== false && !a.external)
    const totalBalance = activeAccounts.reduce(
      (sum, a) => sum + (a.closing_balance ?? 0),
      0
    )

    // 已核算账户：status==='complete' 数 / 启用总数；另外拆出部分数据与缺快照，
    // 24h 这类非完整日窗口下完整核算数必然是 0，只报「0/10」会让人误以为全线故障。
    const enabledAccounts = accounts.filter((a) => a.enabled !== false)
    const completeCount = enabledAccounts.filter((a) => a.status === "complete").length
    const partialCount = enabledAccounts.filter((a) => a.status === "partial").length
    const missingCount = enabledAccounts.filter(
      (a) => a.status === "unavailable" || a.status === "unconfigured"
    ).length

    // 本期充值合计：credits 求和
    const totalCredits = accounts.reduce((sum, a) => sum + (a.credits ?? 0), 0)

    // 加权毛利率：Σmargin ÷ Σlocal_revenue，分母 0 显示 —
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
    if (!sortState) {
      return getDefaultSortedRows(accounts)
    }
    return sortRows(accounts, sortState, UPSTREAM_ACCESSORS)
  }, [accounts, sortState])

  return (
    <div className="flex-1 min-h-0 flex flex-col space-y-4">
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

      {/* 下方一张表卡，占满剩余高度（flex-1 min-h-0），表内滚动 */}
      <Card
        data-slot="detail-card"
        className="shadow-xs overflow-hidden flex flex-col min-w-0 p-4 flex-1 min-h-0"
      >
        <CardHeader className="p-0 pb-2.5 flex flex-row items-center justify-between space-y-0 shrink-0">
          <div className="flex items-center gap-2">
            <CardTitle className="text-[16px] leading-[24px] font-medium text-foreground">
              上游账户明细
            </CardTitle>
            <Badge
              variant="secondary"
              className="text-[12px] leading-[16px] h-5 px-1.5 font-medium tabular-nums"
            >
              {sortedRows.length} 个账户
            </Badge>
          </div>
        </CardHeader>

        <CardContent className="p-0 flex flex-col flex-1 min-h-0">
          <div
            data-slot="table-container"
            className="rounded-lg border border-border bg-card flex-1 min-h-0 overflow-auto"
          >
            <Table className="w-full table-fixed text-sm">
              <colgroup>
                <col style={{ width: `${COL_WIDTH_PCT.account}%` }} />
                <col style={{ width: `${COL_WIDTH_PCT.enabled}%` }} />
                <col style={{ width: `${COL_WIDTH_PCT.balance}%` }} />
                <col style={{ width: `${COL_WIDTH_PCT.credits}%` }} />
                <col style={{ width: `${COL_WIDTH_PCT.consumption}%` }} />
                <col style={{ width: `${COL_WIDTH_PCT.margin_pct}%` }} />
                <col style={{ width: `${COL_WIDTH_PCT.status}%` }} />
                <col style={{ width: `${COL_WIDTH_PCT.last_sync}%` }} />
                <col style={{ width: `${COL_WIDTH_PCT.channels}%` }} />
              </colgroup>
              <TableHeader className="bg-muted/50 sticky top-0 z-20 backdrop-blur-xs">
                <TableRow className="hover:bg-transparent border-b border-border">
                  {/* 1. 账户（首列 sticky） */}
                  <TableHead className="h-9 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground text-left sticky left-0 bg-muted/95 z-30 border-r border-border min-w-[160px]">
                    账户
                  </TableHead>

                  {/* 2. 启用状态 */}
                  <TableHead className="h-9 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground text-left whitespace-nowrap">
                    启用状态
                  </TableHead>

                  {/* 3. 余额（可排） */}
                  {(() => {
                    const sortAttrs = getSortHeaderAttrs(sortState, "balance")
                    return (
                      <TableHead
                        aria-sort={sortAttrs.ariaSort}
                        onClick={() => handleSort("balance")}
                        className={cn(
                          "h-9 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground text-right whitespace-nowrap select-none cursor-pointer transition-colors group/th hover:bg-muted/80",
                          sortAttrs.isActive && "text-foreground font-semibold"
                        )}
                      >
                        <div className="inline-flex items-center gap-1.5 flex-row-reverse">
                          <span>余额</span>
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
                  })()}

                  {/* 4. 充值（可排） */}
                  {(() => {
                    const sortAttrs = getSortHeaderAttrs(sortState, "credits")
                    return (
                      <TableHead
                        aria-sort={sortAttrs.ariaSort}
                        onClick={() => handleSort("credits")}
                        className={cn(
                          "h-9 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground text-right whitespace-nowrap select-none cursor-pointer transition-colors group/th hover:bg-muted/80",
                          sortAttrs.isActive && "text-foreground font-semibold"
                        )}
                      >
                        <div className="inline-flex items-center gap-1.5 flex-row-reverse">
                          <span>充值</span>
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
                  })()}

                  {/* 5. 推导消费（可排） */}
                  {(() => {
                    const sortAttrs = getSortHeaderAttrs(sortState, "consumption")
                    return (
                      <TableHead
                        aria-sort={sortAttrs.ariaSort}
                        onClick={() => handleSort("consumption")}
                        className={cn(
                          "h-9 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground text-right whitespace-nowrap select-none cursor-pointer transition-colors group/th hover:bg-muted/80",
                          sortAttrs.isActive && "text-foreground font-semibold"
                        )}
                      >
                        <div className="inline-flex items-center gap-1.5 flex-row-reverse">
                          <span>推导消费</span>
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
                  })()}

                  {/* 6. 毛利率（可排） */}
                  {(() => {
                    const sortAttrs = getSortHeaderAttrs(sortState, "margin_pct")
                    return (
                      <TableHead
                        aria-sort={sortAttrs.ariaSort}
                        onClick={() => handleSort("margin_pct")}
                        className={cn(
                          "h-9 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground text-right whitespace-nowrap select-none cursor-pointer transition-colors group/th hover:bg-muted/80",
                          sortAttrs.isActive && "text-foreground font-semibold"
                        )}
                      >
                        <div className="inline-flex items-center gap-1.5 flex-row-reverse">
                          <span>毛利率</span>
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
                  })()}

                  {/* 7. 状态 */}
                  <TableHead className="h-9 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground text-left whitespace-nowrap">
                    状态
                  </TableHead>

                  {/* 8. 最后同步 */}
                  <TableHead className="h-9 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground text-left whitespace-nowrap">
                    最后同步
                  </TableHead>

                  {/* 9. 渠道数 */}
                  <TableHead className="h-9 px-3 text-[12px] leading-[16px] font-medium text-muted-foreground text-right whitespace-nowrap">
                    渠道数
                  </TableHead>
                </TableRow>
              </TableHeader>

              <TableBody>
                {sortedRows.map((row) => (
                  <TableRow
                    key={row.id}
                    className="h-[38px] hover:bg-muted/40 transition-colors border-b border-border/60"
                  >
                    {/* 1. 账户：名称（可折行 2 行）+ 小字 kind */}
                    <TableCell className="sticky left-0 bg-card z-10 border-r border-border/50 px-3 py-1 min-w-[160px]">
                      <div className="flex flex-col justify-center min-w-0 leading-tight">
                        <span
                          className="font-medium text-foreground text-[14px] leading-[18px] line-clamp-2"
                          title={row.name || row.id}
                        >
                          {row.name || row.id}
                        </span>
                        <span className="font-mono text-[11px] leading-[14px] text-muted-foreground">
                          {row.kind}
                        </span>
                      </div>
                    </TableCell>

                    {/* 2. 启用状态 */}
                    <TableCell className="px-3 py-1 whitespace-nowrap">
                      {row.enabled === false ? (
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
                      )}
                    </TableCell>

                    {/* 3. 余额 */}
                    <TableCell className="text-right font-mono tabular-nums text-[14px] leading-[20px] font-semibold text-foreground px-3 py-1 whitespace-nowrap">
                      {formatCurrency(row.closing_balance)}
                    </TableCell>

                    {/* 4. 充值：没有数据源的账户（缺快照/未配置）不写 $0.00 */}
                    <TableCell className="text-right font-mono tabular-nums text-[14px] leading-[20px] text-foreground px-3 py-1 whitespace-nowrap">
                      {row.status === "unavailable" || row.status === "unconfigured"
                        ? "—"
                        : formatCurrency(row.credits)}
                    </TableCell>

                    {/* 5. 推导消费 */}
                    <TableCell className="text-right font-mono tabular-nums text-[14px] leading-[20px] text-foreground px-3 py-1 whitespace-nowrap">
                      {formatCurrency(row.consumption)}
                    </TableCell>

                    {/* 6. 毛利率 */}
                    <TableCell className="text-right font-mono tabular-nums text-[14px] leading-[20px] text-foreground px-3 py-1 whitespace-nowrap">
                      {formatPercent(row.margin_pct)}
                    </TableCell>

                    {/* 7. 状态 */}
                    <TableCell className="px-3 py-1 whitespace-nowrap">
                      {row.status === "complete" ? (
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
                      )}
                    </TableCell>

                    {/* 8. 最后同步 */}
                    <TableCell className="px-3 py-1 font-mono tabular-nums text-[13px] leading-[18px] text-muted-foreground whitespace-nowrap">
                      {formatTimestamp(row.last_sync)}
                    </TableCell>

                    {/* 9. 渠道数 */}
                    <TableCell className="text-right font-mono tabular-nums text-[14px] leading-[20px] text-foreground px-3 py-1 whitespace-nowrap">
                      {row.channels?.length ?? 0}
                    </TableCell>
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
