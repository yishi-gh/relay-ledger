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
import { DetailsView } from "@/components/details-view"
import { RankView } from "@/components/rank-view"
import { ModelsView } from "@/components/models-view"
import { UpstreamsView } from "@/components/upstreams-view"
import { ChannelRoutesView } from "@/components/channel-routes-view"
import { QualityView } from "@/components/quality-view"
import { SystemView } from "@/components/system-view"
import { SettingsView } from "@/components/settings-view"
import {
  loadDashboard,
  type DashboardData,
  type DateRange,
  type RangeType,
} from "@/lib/api"
import { getInitialTimeRangeSelection, rememberTimeRange, useSettings } from "@/lib/settings"
import { startAutoRefresh } from "@/lib/refresh"
import { aggregateProfitBuckets, buildTrafficChartData } from "@/lib/dashboard-data"
import { bucketLabel, getTimeRangeKey, validateCustomRange } from "@/lib/time-range"

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

const VALID_VIEWS: ViewKey[] = [
  "overview",
  "profit",
  "rank",
  "models",
  "channels_detail",
  "groups_detail",
  "upstreams",
  "routes",
  "quality",
  "system",
  "settings",
]

const VIEW_TITLES: Record<ViewKey, string> = {
  overview: "总览",
  profit: "盈利",
  rank: "排行",
  models: "模型经营",
  channels_detail: "渠道明细",
  groups_detail: "分组明细",
  upstreams: "上游账户",
  routes: "渠道路由",
  quality: "数据质量",
  system: "系统状态",
  settings: "系统设置",
}

interface RouteState {
  view: ViewKey
}

/**
 * 纯函数：只读 URL，不写 history，渲染期可安全调用。
 * 规范化（把老别名写回规范 view）统一放在挂载后的 effect 里做。
 * 旧健康页与 availability 入口统一回到对应明细页。
 */
function parseRouteState(): RouteState {
  if (typeof window === "undefined") {
    return { view: "overview" }
  }

  const params = new URLSearchParams(window.location.search)
  const rawView = params.get("view")?.replace(/-/g, "_")
  const detailView = params.get("level") === "group" ? "groups_detail" : "channels_detail"

  if (!rawView) {
    return { view: "overview" }
  }

  if (rawView === "health" || rawView === "details") {
    return { view: detailView }
  }

  if (rawView === "quality") {
    return { view: "quality" }
  }

  if (rawView === "ops") {
    return { view: "system" }
  }

  if (rawView === "capital") {
    return { view: "upstreams" }
  }

  if (rawView === "channels_detail" || rawView === "channels_table") {
    return { view: "channels_detail" }
  }

  if (rawView === "groups_detail" || rawView === "groups_table") {
    return { view: "groups_detail" }
  }

  if (
    rawView === "rank" ||
    rawView === "channels_rank" ||
    rawView === "groups_rank"
  ) {
    return { view: "rank" }
  }

  if (VALID_VIEWS.includes(rawView as ViewKey)) {
    return { view: rawView as ViewKey }
  }

  return { view: "overview" }
}

/** 生成规范 URL：保留 preview 等既有参数，废弃的 level/tab 一律清除。 */
function buildViewUrl(
  href: string,
  view: ViewKey | "capital",
): string {
  const url = new URL(href)
  url.searchParams.set("view", view === "capital" ? "upstreams" : view)

  url.searchParams.delete("level")
  url.searchParams.delete("tab")

  return `${url.pathname}${url.search}${url.hash}`
}

function normalizeRouteUrl(route: RouteState) {
  if (typeof window === "undefined" || !new URLSearchParams(window.location.search).has("view")) return
  const canonical = buildViewUrl(window.location.href, route.view)
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`
  if (canonical !== current) window.history.replaceState(window.history.state, "", canonical)
}

function pushRoute(url: string) {
  if (typeof window === "undefined") return
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`
  if (url === current) return
  window.history.pushState({}, "", url)
}

export function App() {
  const { preferences, timeRangeError } = useSettings()
  const initialRoute = React.useMemo(() => parseRouteState(), [])
  const [selection, setSelection] = React.useState(getInitialTimeRangeSelection)
  const { type: timeRange, customRange } = selection
  const [currentView, setCurrentView] = React.useState<ViewKey>(initialRoute.view)
  const [lastLoadedAt, setLastLoadedAt] = React.useState<number>(0)
  const [data, setData] = React.useState<DashboardData | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [loadFailure, setLoadFailure] = React.useState<string | null>(null)
  const [rangeFailure, setRangeFailure] = React.useState<string | null>(null)

  // 首次挂载把老别名 URL 规范化为新 view key；state 已由 parseRouteState 解析好
  React.useEffect(() => {
    normalizeRouteUrl(initialRoute)
  }, [initialRoute])

  const selectionRef = React.useRef(selection)
  const loadingRef = React.useRef(false)
  const requestSeqRef = React.useRef(0)
  const requestedRangeRef = React.useRef<string | null>(null)
  const lastLoadedAtRef = React.useRef(0)

  React.useEffect(() => {
    selectionRef.current = selection
  }, [selection])

  const performLoad = React.useCallback(
    async (range: RangeType, custom?: DateRange | null, options?: { clear?: boolean }) => {
      const seq = ++requestSeqRef.current
      loadingRef.current = true
      setLoading(true)
      if (options?.clear) setData(null)

      try {
        const result = await loadDashboard(range, custom ?? undefined)
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
          const loadedAt = Date.now()
          lastLoadedAtRef.current = loadedAt
          setLastLoadedAt(loadedAt)
        }
      }
    },
    []
  )

  // 自定义起止也参与窗口标识；同为 custom 的两次选择必须清除旧窗口并重新加载。
  React.useEffect(() => {
    const key = getTimeRangeKey(timeRange, customRange)
    if (requestedRangeRef.current === key) return
    requestedRangeRef.current = key
    void performLoad(timeRange, customRange, { clear: true })
  }, [performLoad, timeRange, customRange])

  const handleRefresh = React.useCallback(() => {
    if (loadingRef.current) return
    const current = selectionRef.current
    void performLoad(current.type, current.customRange)
  }, [performLoad])

  const handleTimeRangeChange = React.useCallback((range: RangeType, custom?: DateRange) => {
    try {
      const next = { type: range, customRange: range === "custom" ? validateCustomRange(custom) : null }
      setRangeFailure(null)
      rememberTimeRange(range, next.customRange ?? undefined)
      if (getTimeRangeKey(next.type, next.customRange) === getTimeRangeKey(selectionRef.current.type, selectionRef.current.customRange)) return
      // 选择生效时立即使旧异步请求过期，防止新 effect 开始前写回旧窗口。
      requestSeqRef.current += 1
      selectionRef.current = next
      setData(null)
      setLoadFailure(null)
      setSelection(next)
    } catch (error) {
      setRangeFailure(error instanceof Error ? error.message : String(error))
    }
  }, [])

  // 偏好变化时清理旧计时器；读取 ref 保证异步刷新始终使用最新窗口。
  React.useEffect(() => {
    return startAutoRefresh({
      intervalMinutes: preferences.refresh.intervalMinutes,
      pauseWhenHidden: preferences.refresh.pauseWhenHidden,
    }, {
      isLoading: () => loadingRef.current,
      getLastLoadedAt: () => lastLoadedAtRef.current,
      refresh: () => {
        const current = selectionRef.current
        return performLoad(current.type, current.customRange)
      },
    })
  }, [performLoad, preferences.refresh.intervalMinutes, preferences.refresh.pauseWhenHidden])

  // 路由/视图同步 URL 查询参数：导航用 pushState，同 URL 不重复入栈
  const navigate = React.useCallback(
    (view: ViewKey) => {
      // 侧栏重复点击当前视图不再压栈
      if (view === currentView) return

      setCurrentView(view)

      if (typeof window !== "undefined") {
        pushRoute(buildViewUrl(window.location.href, view))
      }
    },
    [currentView]
  )

  React.useEffect(() => {
    const handlePopState = () => {
      const route = parseRouteState()
      setCurrentView(route.view)
      normalizeRouteUrl(route)
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
  const currentQuality = data?.quality ?? null

  // 1. KPI 逻辑计算（1 张主卡 + 3 张辅卡）
  const profitAgg = React.useMemo(
    () => (currentProfit ? aggregateProfitBuckets(currentProfit) : null),
    [currentProfit]
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
      const label = bucketLabel(bucket.label, currentProfit.granularity)

      const pointData: Record<string, string | number> = {
        label,
        fullLabel: bucket.label,
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
  }, [currentProfit])

  // 调用流量：独立于 profit，按实际查询范围生成稠密北京桶；缺桶是真实零请求
  const trafficChartData = React.useMemo(
    () => buildTrafficChartData(currentTrend, data?.range),
    [currentTrend, data?.range]
  )

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
            "--sidebar-width": "11rem", // 176px
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
            title={VIEW_TITLES[currentView] || "Relay Ledger"}
            maxT={meta?.max_t ?? undefined}
            rows={meta?.rows}
            timeRange={timeRange}
            customRange={customRange}
            onTimeRangeChange={handleTimeRangeChange}
            onRefresh={handleRefresh}
            refreshing={loading}
          />

          <main className="flex-1 min-h-0 lg:overflow-y-auto flex flex-col p-3.5 md:p-4 xl:p-4.5 min-w-0">
            {(rangeFailure || timeRangeError) && (
              <Alert variant="destructive" className="mb-4 shrink-0">
                <AlertTriangle />
                <AlertTitle>时间范围异常</AlertTitle>
                <AlertDescription>{rangeFailure || timeRangeError}</AlertDescription>
              </Alert>
            )}
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
                    trafficChartData={trafficChartData}
                    getSiteColor={getSiteColor}
                    capital={data?.capital ?? null}
                    accounts={currentUpstreams?.accounts || []}
                    profitData={currentProfit}
                    quality={currentQuality}
                    channels={currentChannels?.rows || []}
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
                    profitSites={currentProfit?.sites || []}
                    dateRange={data?.range ?? null}
                    refreshKey={lastLoadedAt}
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

                {(currentView === "channels_detail" ||
                  currentView === "groups_detail") && (
                  <DetailsView
                    key={currentView}
                    timeRange={timeRange}
                    dateRange={data?.range ?? null}
                    channels={currentChannels?.rows || []}
                    groups={currentGroups?.groups || []}
                    fixedLevel={currentView === "groups_detail" ? "group" : "channel"}
                  />
                )}

                {currentView === "upstreams" && (
                  <UpstreamsView
                    timeRange={timeRange}
                    accounts={currentUpstreams?.accounts || []}
                    capital={data?.capital ?? null}
                    profitSites={currentProfit?.sites || []}
                    quality={currentProfit?.quality}
                    dateRange={data?.range ?? null}
                    refreshKey={lastLoadedAt}
                  />
                )}

                {currentView === "routes" && (
                  <ChannelRoutesView refreshKey={lastLoadedAt} />
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

                {currentView === "system" && (
                  <SystemView
                    quality={data?.quality || {}}
                    accounts={currentUpstreams?.accounts || []}
                    dateRange={data?.range ?? null}
                    timeRange={timeRange}
                    previewMode={import.meta.env.DEV && Boolean(meta?.preview)}
                    lastRefreshTime={lastLoadedAt}
                  />
                )}

                {currentView === "settings" && (
                  <SettingsView
                    meta={meta}
                    lastRefreshTime={lastLoadedAt}
                  />
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
