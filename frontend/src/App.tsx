import * as React from "react"
import { AlertTriangle } from "lucide-react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { AppSidebar, type ViewKey } from "@/components/app-sidebar"
import { TopBar } from "@/components/top-bar"
import { OverviewView, type KpiData, type TrafficChartPoint } from "@/components/overview-view"
import { ProfitView } from "@/components/profit-view"
import { DetailsView } from "@/components/details-view"
import { RankView } from "@/components/rank-view"
import { ModelsView } from "@/components/models-view"
import { UpstreamsView } from "@/components/upstreams-view"
import { CapitalView } from "@/components/capital-view"
import { HealthView } from "@/components/health-view"
import { QualityView } from "@/components/quality-view"
import { SystemView } from "@/components/system-view"
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
  "upstreams",
  "capital",
  "health",
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
  capital: "资金与续航",
  health: "渠道健康",
  quality: "数据质量",
  system: "系统状态",
  settings: "系统设置",
}

const REFRESH_INTERVAL_MS = 15 * 60 * 1000
const REFRESH_OFFSET_MS = 12 * 1000
const HOUR_MS = 3600000
const DAY_MS = 86400000
const BEIJING_OFFSET_MS = 8 * HOUR_MS

/** 北京时间日界（与后端 beijingDayStart 一致） */
function beijingDayStart(ms: number): number {
  return Math.floor((ms + BEIJING_OFFSET_MS) / DAY_MS) * DAY_MS - BEIJING_OFFSET_MS
}

function pad2(value: number): string {
  return String(value).padStart(2, "0")
}

/** 与 /api/trend 的 bucket 字符串一致：hour=YYYY-MM-DD HH:00，day=YYYY-MM-DD */
function beijingTrendBucket(ms: number, granularity: "hour" | "day"): string {
  const d = new Date(ms + BEIJING_OFFSET_MS)
  const date = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
  return granularity === "hour" ? `${date} ${pad2(d.getUTCHours())}:00` : date
}

/** 下一次对齐到每 15 分钟的 :12/:27/:42/:57 的等待毫秒数 */
function nextRefreshDelay(now: number): number {
  return Math.max(
    0,
    Math.ceil((now - REFRESH_OFFSET_MS) / REFRESH_INTERVAL_MS) * REFRESH_INTERVAL_MS +
      REFRESH_OFFSET_MS -
      now
  )
}

type DetailLevel = "channel" | "group"

interface RouteState {
  view: ViewKey
  level: DetailLevel
}

function normalizeLevel(value: string | null): DetailLevel {
  return value === "group" ? "group" : "channel"
}

/**
 * 纯函数：只读 URL，不写 history，渲染期可安全调用。
 * 规范化（把老别名写回规范 view）统一放在挂载后的 effect 里做。
 * 旧的 tab=biz/perf/all 不再参与路由，只保留 tab=availability 转健康页的兼容。
 */
function parseRouteState(): RouteState {
  if (typeof window === "undefined") {
    return { view: "overview", level: "channel" }
  }

  const params = new URLSearchParams(window.location.search)
  const rawView = params.get("view")?.replace(/-/g, "_")
  const level = normalizeLevel(params.get("level"))

  if (!rawView) {
    return { view: "overview", level }
  }

  if (rawView === "health") {
    return { view: "health", level }
  }

  if (rawView === "quality") {
    return { view: "quality", level }
  }

  if (rawView === "ops") {
    return { view: "system", level }
  }

  // 老详情页的 availability 档已独立为渠道健康页
  const legacyAvailability = params.get("tab") === "availability"

  if (rawView === "details") {
    if (legacyAvailability) return { view: "health", level }
    return {
      view: level === "group" ? "groups_detail" : "channels_detail",
      level,
    }
  }

  if (rawView === "channels_detail" || rawView === "channels_table") {
    if (legacyAvailability) return { view: "health", level: "channel" }
    return { view: "channels_detail", level: "channel" }
  }

  if (rawView === "groups_detail" || rawView === "groups_table") {
    if (legacyAvailability) return { view: "health", level: "group" }
    return { view: "groups_detail", level: "group" }
  }

  if (
    rawView === "rank" ||
    rawView === "channels_rank" ||
    rawView === "groups_rank"
  ) {
    return { view: "rank", level }
  }

  if (VALID_VIEWS.includes(rawView as ViewKey)) {
    return { view: rawView as ViewKey, level }
  }

  return { view: "overview", level }
}

/** 生成规范 URL：保留 preview 等既有参数，level 只留给健康页；废弃的 tab 一律清除。 */
function buildViewUrl(
  href: string,
  view: ViewKey,
  level: DetailLevel
): string {
  const url = new URL(href)
  url.searchParams.set("view", view)

  if (view === "health" && level === "group") {
    url.searchParams.set("level", "group")
  } else {
    url.searchParams.delete("level")
  }

  url.searchParams.delete("tab")

  return `${url.pathname}${url.search}${url.hash}`
}

function pushRoute(url: string) {
  if (typeof window === "undefined") return
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`
  if (url === current) return
  window.history.pushState({}, "", url)
}

export function App() {
  const initialRoute = React.useMemo(() => parseRouteState(), [])
  const [timeRange, setTimeRange] = React.useState<RangeType>("24h")
  const [currentView, setCurrentView] = React.useState<ViewKey>(initialRoute.view)
  const [detailLevel, setDetailLevel] = React.useState<DetailLevel>(initialRoute.level)
  const [lastLoadedAt, setLastLoadedAt] = React.useState<number>(0)
  const [data, setData] = React.useState<DashboardData | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [loadFailure, setLoadFailure] = React.useState<string | null>(null)

  // 首次挂载把老别名 URL 规范化为新 view key；state 已由 parseRouteState 解析好
  React.useEffect(() => {
    // 无 view 参数的裸 URL 保持干净，不额外写默认视图
    if (!new URLSearchParams(window.location.search).has("view")) return

    const canonical = buildViewUrl(
      window.location.href,
      initialRoute.view,
      initialRoute.level
    )
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`
    if (canonical !== current) {
      window.history.replaceState({}, "", canonical)
    }
  }, [initialRoute])

  const timeRangeRef = React.useRef(timeRange)
  const loadingRef = React.useRef(false)
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
          setLastLoadedAt(Date.now())
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
      if (Date.now() - lastLoadedAt > REFRESH_INTERVAL_MS) {
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
  }, [performLoad, lastLoadedAt])

  // 路由/视图同步 URL 查询参数：导航用 pushState，同 URL 不重复入栈
  const navigate = React.useCallback(
    (view: ViewKey, extra?: { level?: DetailLevel }) => {
      // 侧栏重复点击当前视图不再压栈
      if (view === currentView && !extra?.level) return

      const level = extra?.level ?? (view === "groups_detail" ? "group" : "channel")

      setCurrentView(view)
      setDetailLevel(level)

      if (typeof window !== "undefined") {
        pushRoute(buildViewUrl(window.location.href, view, level))
      }
    },
    [currentView]
  )

  React.useEffect(() => {
    const handlePopState = () => {
      const route = parseRouteState()
      setCurrentView(route.view)
      setDetailLevel(route.level)
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
  }, [currentProfit, timeRange])

  // 调用流量：独立于 profit，按实际查询范围生成稠密北京桶；缺桶是真实零请求
  const trafficChartData = React.useMemo<TrafficChartPoint[]>(() => {
    if (!currentTrend) return []

    const granularity: "hour" | "day" = timeRange === "24h" ? "hour" : "day"
    const labelOf = (bucket: string) =>
      granularity === "hour" ? bucket.split(" ")[1] ?? bucket : bucket.slice(5)
    const pointOf = (bucket: string, point?: (typeof currentTrend.points)[number]): TrafficChartPoint => {
      if (!point) {
        return { label: labelOf(bucket), fullLabel: bucket, requests: 0, tokens: 0, cacheRate: null }
      }
      return {
        label: labelOf(bucket),
        fullLabel: bucket,
        requests: typeof point.requests === "number" ? point.requests : null,
        tokens: typeof point.tokens === "number" ? point.tokens : null,
        cacheRate: typeof point.cache_rate === "number" ? point.cache_rate : null,
      }
    }

    const range = data?.range
    if (!range) {
      // 没有 range 时至少保留接口返回的真实桶，不补零
      return currentTrend.points.map((point) => pointOf(point.bucket, point))
    }

    const byBucket = new Map(currentTrend.points.map((point) => [point.bucket, point]))
    const buckets: string[] = []
    if (granularity === "hour") {
      const start = Math.floor(range.from / HOUR_MS) * HOUR_MS
      for (let t = start; t <= range.to; t += HOUR_MS) {
        buckets.push(beijingTrendBucket(t, "hour"))
      }
    } else {
      const start = beijingDayStart(range.from)
      for (let t = start; t <= range.to; t += DAY_MS) {
        buckets.push(beijingTrendBucket(t, "day"))
      }
    }
    return buckets.map((bucket) => pointOf(bucket, byBucket.get(bucket)))
  }, [currentTrend, data?.range, timeRange])

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
            title={VIEW_TITLES[currentView] || "Relay Ledger"}
            maxT={meta?.max_t ?? undefined}
            rows={meta?.rows}
            timeRange={timeRange}
            onTimeRangeChange={setTimeRange}
            onRefresh={handleRefresh}
            refreshing={loading}
          />

          <main className="flex-1 min-h-0 lg:overflow-y-auto flex flex-col p-3.5 md:p-4 xl:p-4.5 min-w-0">
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

                {(currentView === "channels_detail" ||
                  currentView === "groups_detail") && (
                  <DetailsView
                    key={currentView}
                    timeRange={timeRange}
                    dateRange={data?.range ?? null}
                    channels={currentChannels?.rows || []}
                    groups={currentGroups?.groups || []}
                    initialLevel={detailLevel}
                    fixedLevel={currentView === "groups_detail" ? "group" : "channel"}
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
                    initialLevel={detailLevel}
                    onLevelChange={(level) => {
                      setDetailLevel(level)
                      if (typeof window !== "undefined") {
                        pushRoute(buildViewUrl(window.location.href, "health", level))
                      }
                    }}
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
