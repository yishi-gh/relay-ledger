import * as React from "react"
import { AlertTriangle } from "lucide-react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { AppSidebar, type ViewKey } from "@/components/app-sidebar"
import { TopBar } from "@/components/top-bar"
import { OverviewView, type KpiData } from "@/components/overview-view"
import { ProfitView } from "@/components/profit-view"
import { PlaceholderView, type PlaceholderKey } from "@/components/placeholder-view"
import { DetailsView } from "@/components/details-view"
import { RankView } from "@/components/rank-view"
import { ModelsView } from "@/components/models-view"
import { UpstreamsView } from "@/components/upstreams-view"
import { CapitalView } from "@/components/capital-view"
import { HealthView } from "@/components/health-view"
import { QualityView } from "@/components/quality-view"
import { SettingsView } from "@/components/settings-view"
import {
  loadDashboard,
  type DashboardData,
  type ProfitData,
  type RangeType,
} from "@/lib/api"

// 全局稳定的站点颜色映射表：首次出现的 account_id 按字典序分配固定色位，之后跨刷新/切窗口都不跳色
const SITE_COLOR_MAP: Record<string, string> = {}

function registerSiteColors(accountIds: string[]) {
  const missing = accountIds.filter((id) => SITE_COLOR_MAP[id] === undefined).sort()
  for (const id of missing) {
    const index = Object.keys(SITE_COLOR_MAP).length
    SITE_COLOR_MAP[id] = `var(--chart-${(index % 12) + 1})`
  }
}

function getSiteColor(accountId: string): string {
  return SITE_COLOR_MAP[accountId] || "var(--chart-1)"
}

type ProfitBucketRow = {
  label: string
  fullLabel: string
  revenue: number | null
  cost: number | null
  profit: number | null
  margin: number | null
  sites: number
}

/**
 * 逐桶只汇总「售出与成本都有值且 kind !== 'external'」的同一批站点。
 * 拿全量售出去减子集成本（某些账户缺快照）会把毛利率抬成 100%，属于 METRICS.md 禁止的部分求和。
 */
function aggregateProfitBuckets(profit: ProfitData, timeRange: RangeType) {
  const revBySite = profit.series.revenue_by_site
  const costBySite = profit.series.cost_by_site
  const accountIds = profit.sites.filter((s) => s.kind !== "external").map((s) => s.account_id)

  let totalRevenue = 0
  let totalCost = 0
  let coveredBuckets = 0

  const rows: ProfitBucketRow[] = profit.buckets.map((bucket, index) => {
    const label =
      timeRange === "24h" ? bucket.label.split(" ")[1] ?? bucket.label : bucket.label.slice(5)

    let revenue = 0
    let cost = 0
    let used = 0
    for (const siteId of accountIds) {
      const rev = revBySite[siteId]?.[index]
      const bucketCost = costBySite[siteId]?.[index]
      if (rev == null || bucketCost == null) continue
      revenue += rev
      cost += bucketCost
      used += 1
    }

    if (used === 0) {
      return { label, fullLabel: bucket.label, revenue: null, cost: null, profit: null, margin: null, sites: 0 }
    }

    coveredBuckets += 1
    totalRevenue += revenue
    totalCost += cost
    const profit = revenue - cost
    return {
      label,
      fullLabel: bucket.label,
      revenue,
      cost,
      profit,
      margin: revenue > 0 ? profit / revenue : null,
      sites: used,
    }
  })

  const totals =
    coveredBuckets === 0
      ? null
      : {
          revenue: totalRevenue,
          cost: totalCost,
          profit: totalRevenue - totalCost,
          margin: totalRevenue > 0 ? (totalRevenue - totalCost) / totalRevenue : null,
          coveredBuckets,
          bucketCount: rows.length,
        }

  return { rows, totals }
}

const VALID_VIEWS: ViewKey[] = [
  "overview",
  "profit",
  "rank",
  "models",
  "channels_detail",
  "groups_detail",
  "details",
  "upstreams",
  "capital",
  "health",
  "quality",
  "settings",
]

const VIEW_TITLES: Record<ViewKey, string> = {
  overview: "总览",
  profit: "盈利",
  rank: "排行",
  models: "模型经营",
  channels_detail: "经营明细",
  groups_detail: "经营明细",
  details: "经营明细",
  upstreams: "上游账户",
  capital: "资金与续航",
  health: "渠道健康",
  quality: "数据质量",
  settings: "系统设置",
}

const REFRESH_INTERVAL_MS = 15 * 60 * 1000
const REFRESH_OFFSET_MS = 12 * 1000

/** 下一次对齐到每 15 分钟的 :12/:27/:42/:57 的等待毫秒数 */
function nextRefreshDelay(now: number): number {
  return Math.max(
    0,
    Math.ceil((now - REFRESH_OFFSET_MS) / REFRESH_INTERVAL_MS) * REFRESH_INTERVAL_MS +
      REFRESH_OFFSET_MS -
      now
  )
}

function normalizeView(v: string | null): ViewKey {
  if (!v) return "overview"
  const normalized = v.replace(/-/g, "_")
  if (
    normalized === "channels_rank" ||
    normalized === "groups_rank" ||
    normalized === "rank"
  ) {
    return "rank"
  }
  if (normalized === "channels_table") return "channels_detail"
  if (normalized === "groups_table") return "groups_detail"
  if (VALID_VIEWS.includes(normalized as ViewKey)) {
    return normalized as ViewKey
  }
  return "overview"
}

function getInitialView(): ViewKey {
  if (typeof window === "undefined") return "overview"
  const params = new URLSearchParams(window.location.search)
  return normalizeView(params.get("view"))
}

export function App() {
  const [timeRange, setTimeRange] = React.useState<RangeType>("24h")
  const [currentView, setCurrentView] = React.useState<ViewKey>(getInitialView)
  const [data, setData] = React.useState<DashboardData | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [loadFailure, setLoadFailure] = React.useState<string | null>(null)

  const timeRangeRef = React.useRef(timeRange)
  const loadingRef = React.useRef(false)
  const lastLoadedAtRef = React.useRef(0)
  const requestSeqRef = React.useRef(0)
  const requestedRangeRef = React.useRef<RangeType | null>(null)

  React.useEffect(() => {
    timeRangeRef.current = timeRange
  }, [timeRange])

  const performLoad = React.useCallback(
    async (range: RangeType, options?: { clear?: boolean }) => {
      const seq = ++requestSeqRef.current
      loadingRef.current = true
      setLoading(true)
      if (options?.clear) setData(null)

      try {
        const result = await loadDashboard(range)
        if (seq !== requestSeqRef.current) return
        if (!result.meta || result.errors.includes("meta")) {
          // 后端不可用时不伪造数据：有旧数据就留住，没有就走致命错误卡。
          setLoadFailure("后端接口不可用（meta）")
          return
        }
        registerSiteColors(result.profit?.sites.map((site) => site.account_id) ?? [])
        setLoadFailure(null)
        setData(result)
      } catch (err) {
        if (seq !== requestSeqRef.current) return
        setLoadFailure(err instanceof Error ? err.message : String(err))
      } finally {
        if (seq === requestSeqRef.current) {
          loadingRef.current = false
          setLoading(false)
          lastLoadedAtRef.current = Date.now()
        }
      }
    },
    []
  )

  // 首次加载与 24h/7d 切换：每次都只请求当前窗口，切换时清掉旧窗口数据
  React.useEffect(() => {
    if (requestedRangeRef.current === timeRange) return
    requestedRangeRef.current = timeRange
    void performLoad(timeRange, { clear: true })
  }, [performLoad, timeRange])

  const handleRefresh = React.useCallback(() => {
    if (loadingRef.current) return
    void performLoad(timeRangeRef.current)
  }, [performLoad])

  // 自动刷新：对齐到每 15 分钟的 :12 秒；页面隐藏时跳过并顺延到下一个槽位
  React.useEffect(() => {
    let cancelled = false
    let timer: number | undefined

    function schedule() {
      if (cancelled) return
      timer = window.setTimeout(tick, nextRefreshDelay(Date.now()))
    }

    async function tick() {
      if (cancelled) return
      if (!document.hidden && !loadingRef.current) {
        await performLoad(timeRangeRef.current)
      }
      schedule()
    }

    function handleVisibilityChange() {
      if (document.hidden || loadingRef.current) return
      if (Date.now() - lastLoadedAtRef.current > REFRESH_INTERVAL_MS) {
        void performLoad(timeRangeRef.current)
      }
    }

    schedule()
    document.addEventListener("visibilitychange", handleVisibilityChange)

    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
      document.removeEventListener("visibilitychange", handleVisibilityChange)
    }
  }, [performLoad])

  // 路由/视图同步 URL 查询参数
  const navigate = React.useCallback((view: ViewKey) => {
    setCurrentView(view)
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href)
      url.searchParams.set("view", view)
      window.history.replaceState({}, "", url.toString())
    }
  }, [])

  React.useEffect(() => {
    const handlePopState = () => {
      const params = new URLSearchParams(window.location.search)
      setCurrentView(normalizeView(params.get("view")))
    }

    window.addEventListener("popstate", handlePopState)
    return () => window.removeEventListener("popstate", handlePopState)
  }, [])

  const meta = data?.meta ?? null
  const overview = data?.overview ?? null
  const currentProfit = data?.profit ?? null
  const currentTrend = data?.trend ?? null
  const currentChannels = data?.channels ?? null
  const currentGroups = data?.groups ?? null
  const currentUsers = data?.users ?? null
  const currentUpstreams = data?.upstreams ?? null

  // 1. KPI 逻辑计算（1 张主卡 + 3 张辅卡）
  const profitAgg = React.useMemo(
    () => (currentProfit ? aggregateProfitBuckets(currentProfit, timeRange) : null),
    [currentProfit, timeRange]
  )

  const kpiData: KpiData = React.useMemo(() => {
    const agg = profitAgg
    const upstreamCost = agg?.totals?.cost ?? null
    const profit = agg?.totals?.profit ?? null
    const margin = agg?.totals?.margin ?? null
    const coveredBuckets = agg?.totals?.coveredBuckets ?? 0
    const bucketCount = agg?.totals?.bucketCount ?? agg?.rows.length ?? 0
    const accountableRevenue = agg?.totals?.revenue ?? null

    if (timeRange === "24h") {
      const revenue = currentProfit
        ? currentProfit.sites.reduce((sum, s) => sum + (s.revenue || 0), 0) +
          (currentProfit.unmapped?.revenue || 0)
        : null
      const requests =
        currentTrend?.points.reduce((sum, p) => sum + (p.requests || 0), 0) ?? null

      return {
        revenue,
        tokens: overview?.tokens?.total ?? null,
        requests,
        cacheRate: overview?.cache_rate ?? null,
        upstreamCost,
        profit,
        margin,
        coveredBuckets,
        bucketCount,
        isCache7d: false,
        accountableRevenue,
      }
    }

    return {
      revenue: overview?.revenue ?? null,
      tokens: overview?.tokens?.total ?? null,
      requests: overview?.requests ?? null,
      cacheRate: overview?.cache_rate ?? null,
      upstreamCost,
      profit,
      margin,
      coveredBuckets,
      bucketCount,
      isCache7d: false,
      accountableRevenue,
    }
  }, [timeRange, overview, currentProfit, currentTrend, profitAgg])

  // 2. 售出堆叠柱数据
  const activeSites = React.useMemo(() => {
    if (!currentProfit) return []
    return currentProfit.sites
      .filter((s) => (s.revenue ?? 0) > 0)
      .sort((a, b) => (b.revenue ?? 0) - (a.revenue ?? 0))
  }, [currentProfit])

  const trendChartData = React.useMemo(() => {
    if (!currentProfit) return []
    return currentProfit.buckets.map((bucket, index) => {
      const label =
        timeRange === "24h"
          ? bucket.label.split(" ")[1] ?? bucket.label
          : bucket.label.slice(5) // MM-DD

      const pointData: Record<string, string | number> = {
        label,
        fullLabel: bucket.label,
        requests: currentTrend?.points[index]?.requests ?? 0,
      }

      // 堆叠各站点的售出金额
      const revBySite = currentProfit.series.revenue_by_site
      for (const site of currentProfit.sites) {
        const val = revBySite[site.account_id]?.[index]
        if (val != null && val > 0) {
          pointData[site.account_id] = val
        }
      }

      return pointData
    })
  }, [currentProfit, currentTrend, timeRange])

  // 3. 上游账户盈利图表数据（成本柱 + 利润实线 + 毛利率虚线）
  const profitChartData = profitAgg?.rows ?? []

  // 4. 汇总表格数据（按售出降序排列）
  const tableData = React.useMemo(() => {
    if (!currentProfit) return []
    return [...currentProfit.sites].sort((a, b) => (b.revenue ?? 0) - (a.revenue ?? 0))
  }, [currentProfit])

  const errorNames = data?.errors ?? []

  return (
    <TooltipProvider>
      <SidebarProvider
        className="min-h-screen lg:h-screen lg:max-h-screen lg:overflow-hidden"
        style={
          {
            "--sidebar-width": "15rem", // 240px
            "--sidebar-width-icon": "3.5rem", // 56px
          } as React.CSSProperties
        }
      >
        <AppSidebar
          siteName={meta?.site_name || meta?.site || "Madfu"}
          currentView={currentView}
          onSelectView={navigate}
        />

        <SidebarInset className="min-w-0 min-h-screen lg:h-screen lg:max-h-screen lg:overflow-hidden flex flex-col flex-1">
          <TopBar
            title={VIEW_TITLES[currentView]}
            maxT={meta?.max_t ?? undefined}
            rows={meta?.rows}
            timeRange={timeRange}
            onTimeRangeChange={setTimeRange}
            onRefresh={handleRefresh}
            refreshing={loading}
          />

          <main className="flex-1 min-h-0 lg:overflow-hidden flex flex-col p-3.5 md:p-4 xl:p-4.5 min-w-0">
            {errorNames.length > 0 && (
              <Alert variant="destructive" className="mb-4 shrink-0">
                <AlertTriangle />
                <AlertTitle>部分数据加载失败</AlertTitle>
                <AlertDescription>失败接口：{errorNames.join("、")}</AlertDescription>
                <AlertAction>
                  <Button variant="outline" size="sm" className="text-[12px] leading-[16px] h-7" onClick={handleRefresh} disabled={loading}>
                    重试
                  </Button>
                </AlertAction>
              </Alert>
            )}

            {!data && loadFailure ? (
              <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 text-center">
                <AlertTriangle className="size-6 text-destructive" />
                <div className="text-[14px] leading-[20px] font-medium">后端接口不可用</div>
                <div className="text-[12px] leading-[16px] text-muted-foreground max-w-md">{loadFailure}</div>
                <Button variant="outline" size="sm" onClick={handleRefresh} disabled={loading}>
                  重试
                </Button>
              </div>
            ) : !data && loading ? (
              <div className="flex-1 min-h-0 flex flex-col gap-4">
                <div className="grid grid-cols-1 sm:grid-cols-3 xl:grid-cols-5 gap-4 shrink-0">
                  {Array.from({ length: 5 }).map((_, index) => (
                    <Skeleton key={index} className="h-28 rounded-xl" />
                  ))}
                </div>
                <Skeleton className="flex-1 min-h-64 w-full rounded-xl" />
              </div>
            ) : (
              <>
                {currentView === "overview" && (
                  <OverviewView
                    timeRange={timeRange}
                    kpiData={kpiData}
                    activeSites={activeSites}
                    trendChartData={trendChartData}
                    getSiteColor={getSiteColor}
                    capital={data?.capital ?? null}
                    accounts={currentUpstreams?.accounts || []}
                  />
                )}

                {currentView === "profit" && (
                  <ProfitView
                    timeRange={timeRange}
                    profitChartData={profitChartData}
                    tableData={tableData}
                    quality={currentProfit?.quality}
                    unmappedRevenue={currentProfit?.unmapped?.revenue}
                  />
                )}

                {currentView === "rank" && (
                  <RankView
                    timeRange={timeRange}
                    channels={currentChannels?.rows || []}
                    groups={currentGroups?.groups || []}
                    users={currentUsers?.users || []}
                    onNavigateChannelsDetail={() => navigate("channels_detail")}
                    onNavigateGroupsDetail={() => navigate("groups_detail")}
                  />
                )}

                {currentView === "models" && (
                  <ModelsView
                    timeRange={timeRange}
                    dateRange={data?.range ?? null}
                    previewMode={import.meta.env.DEV && Boolean(meta?.preview)}
                  />
                )}

                {(currentView === "details" ||
                  currentView === "channels_detail" ||
                  currentView === "groups_detail") && (
                  <DetailsView
                    timeRange={timeRange}
                    channels={currentChannels?.rows || []}
                    groups={currentGroups?.groups || []}
                    initialLevel={
                      currentView === "groups_detail" ? "group" : "channel"
                    }
                  />
                )}

                {currentView === "upstreams" && (
                  <UpstreamsView
                    timeRange={timeRange}
                    accounts={currentUpstreams?.accounts || []}
                  />
                )}

                {currentView === "capital" && (
                  <CapitalView
                    timeRange={timeRange}
                    dateRange={data?.range ?? null}
                    previewMode={import.meta.env.DEV && Boolean(meta?.preview)}
                  />
                )}

                {currentView === "health" && (
                  <HealthView
                    timeRange={timeRange}
                    dateRange={data?.range ?? null}
                  />
                )}

                {currentView === "quality" && (
                  <QualityView
                    quality={data?.quality || {}}
                    accounts={currentUpstreams?.accounts || []}
                    dateRange={data?.range ?? null}
                    timeRange={timeRange}
                    previewMode={import.meta.env.DEV && Boolean(meta?.preview)}
                  />
                )}

                {currentView === "settings" && (
                  <SettingsView
                    meta={meta}
                    lastRefreshTime={lastLoadedAtRef.current}
                  />
                )}

                {currentView !== "overview" &&
                  currentView !== "profit" &&
                  currentView !== "rank" &&
                  currentView !== "models" &&
                  currentView !== "channels_detail" &&
                  currentView !== "groups_detail" &&
                  currentView !== "upstreams" &&
                  currentView !== "capital" &&
                  currentView !== "health" &&
                  currentView !== "quality" &&
                  currentView !== "settings" && (
                    <PlaceholderView viewKey={currentView as PlaceholderKey} />
                  )}
              </>
            )}
          </main>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}

export default App
