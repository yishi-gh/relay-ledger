import * as React from "react"
import previewData from "@/data/preview.json"
import { TooltipProvider } from "@/components/ui/tooltip"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { AppSidebar, type ViewKey } from "@/components/app-sidebar"
import { TopBar } from "@/components/top-bar"
import { OverviewView, type KpiData } from "@/components/overview-view"
import { ProfitView } from "@/components/profit-view"
import { PlaceholderView, type PlaceholderKey } from "@/components/placeholder-view"
import { ChannelsDetailView } from "@/components/channels-detail-view"
import { GroupsDetailView } from "@/components/groups-detail-view"
import { RankView } from "@/components/rank-view"
import { UpstreamsView } from "@/components/upstreams-view"
import { QualityView } from "@/components/quality-view"

// 全局稳定的站点颜色映射表（按 account_id 字典序排序后的固定索引，绝对不跳色）
const ALL_ACCOUNT_IDS = Array.from(
  new Set([
    ...previewData.profit_hour.sites.map((s) => s.account_id),
    ...previewData.profit_day.sites.map((s) => s.account_id),
  ])
).sort()

const SITE_COLOR_MAP: Record<string, string> = Object.fromEntries(
  ALL_ACCOUNT_IDS.map((id, index) => [
    id,
    `var(--chart-${(index % 12) + 1})`,
  ])
)

function getSiteColor(accountId: string): string {
  return SITE_COLOR_MAP[accountId] || "var(--chart-1)"
}

type ProfitSnapshot = {
  buckets: { label: string }[]
  sites: { account_id: string; kind?: string }[]
  series: {
    revenue_by_site: Record<string, (number | null)[]>
    cost_by_site: Record<string, (number | null)[]>
  }
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
function aggregateProfitBuckets(profit: ProfitSnapshot, timeRange: "24h" | "7d") {
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
  "channels_detail",
  "groups_detail",
  "upstreams",
  "quality",
  "settings",
]

const VIEW_TITLES: Record<ViewKey, string> = {
  overview: "总览",
  profit: "盈利",
  rank: "排行",
  channels_detail: "渠道明细",
  groups_detail: "分组明细",
  upstreams: "上游账户",
  quality: "数据质量",
  settings: "系统设置",
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
  const [timeRange, setTimeRange] = React.useState<"24h" | "7d">("24h")
  const [currentView, setCurrentView] = React.useState<ViewKey>(getInitialView)

  const { meta, overview, trend_day, trend_hour, profit_day, profit_hour } = previewData

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

  // 当前激活的数据源
  const currentProfit = timeRange === "24h" ? profit_hour : profit_day
  const currentTrend = timeRange === "24h" ? trend_hour : trend_day
  const currentChannels = timeRange === "24h" ? previewData.channels_24h : previewData.channels_7d
  const currentGroups = timeRange === "24h" ? previewData.groups_24h : previewData.groups_7d
  const currentUsers = timeRange === "24h" ? previewData.users_24h : previewData.users_7d
  const currentUpstreams = timeRange === "24h" ? previewData.upstreams_24h : previewData.upstreams_7d

  // 1. KPI 逻辑计算（1 张主卡 + 3 张辅卡）
  const kpiData: KpiData = React.useMemo(() => {
    const agg = aggregateProfitBuckets(currentProfit, timeRange)
    const upstreamCost = agg.totals?.cost ?? null
    const profit = agg.totals?.profit ?? null
    const margin = agg.totals?.margin ?? null
    const coveredBuckets = agg.totals?.coveredBuckets ?? 0
    const bucketCount = agg.totals?.bucketCount ?? agg.rows.length
    const accountableRevenue = agg.totals?.revenue ?? null

    if (timeRange === "24h") {
      const revenue =
        currentProfit.sites.reduce((sum, s) => sum + (s.revenue || 0), 0) +
        (currentProfit.unmapped?.revenue || 0)
      const requests = trend_hour.points.reduce(
        (sum, p) => sum + (p.requests || 0),
        0
      )

      return {
        revenue,
        tokens: null,
        requests,
        cacheRate: overview.cache_rate,
        upstreamCost,
        profit,
        margin,
        coveredBuckets,
        bucketCount,
        isCache7d: true,
        accountableRevenue,
      }
    }

    return {
      revenue: overview.revenue,
      tokens: overview.tokens?.total ?? null,
      requests: overview.requests,
      cacheRate: overview.cache_rate,
      upstreamCost,
      profit,
      margin,
      coveredBuckets,
      bucketCount,
      isCache7d: false,
      accountableRevenue,
    }
  }, [timeRange, overview, currentProfit, trend_hour])

  // 2. 售出堆叠柱数据
  const activeSites = React.useMemo(() => {
    return currentProfit.sites
      .filter((s) => (s.revenue ?? 0) > 0)
      .sort((a, b) => (b.revenue ?? 0) - (a.revenue ?? 0))
  }, [currentProfit])

  const trendChartData = React.useMemo(() => {
    return currentProfit.buckets.map((bucket, index) => {
      const label =
        timeRange === "24h"
          ? bucket.label.split(" ")[1] ?? bucket.label
          : bucket.label.slice(5) // MM-DD

      const pointData: Record<string, string | number> = {
        label,
        fullLabel: bucket.label,
        requests: currentTrend.points[index]?.requests ?? 0,
      }

      // 堆叠各站点的售出金额
      const revBySite = currentProfit.series.revenue_by_site as Record<string, (number | null)[]>
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
  const profitChartData = React.useMemo(
    () => aggregateProfitBuckets(currentProfit, timeRange).rows,
    [currentProfit, timeRange]
  )

  // 4. 汇总表格数据（按售出降序排列）
  const tableData = React.useMemo(() => {
    return [...currentProfit.sites].sort((a, b) => (b.revenue ?? 0) - (a.revenue ?? 0))
  }, [currentProfit])

  return (
    <TooltipProvider>
      <SidebarProvider
        className="h-screen max-h-screen overflow-hidden"
        style={
          {
            "--sidebar-width": "15rem", // 240px
            "--sidebar-width-icon": "3.5rem", // 56px
          } as React.CSSProperties
        }
      >
        <AppSidebar
          siteName={meta.site_name || "Madfu"}
          currentView={currentView}
          onSelectView={navigate}
        />

        <SidebarInset className="min-w-0 h-screen max-h-screen overflow-hidden flex flex-col flex-1">
          <TopBar
            title={VIEW_TITLES[currentView]}
            maxT={meta.max_t}
            rows={meta.rows}
            timeRange={timeRange}
            onTimeRangeChange={setTimeRange}
          />

          <main className="flex-1 min-h-0 overflow-y-auto md:overflow-hidden flex flex-col p-3.5 md:p-4 xl:p-4.5 min-w-0">
            {currentView === "overview" && (
              <OverviewView
                timeRange={timeRange}
                kpiData={kpiData}
                activeSites={activeSites}
                trendChartData={trendChartData}
                getSiteColor={getSiteColor}
              />
            )}

            {currentView === "profit" && (
              <ProfitView
                timeRange={timeRange}
                profitChartData={profitChartData}
                tableData={tableData}
                quality={currentProfit.quality}
                unmappedRevenue={currentProfit.unmapped?.revenue}
              />
            )}

            {currentView === "rank" && (
              <RankView
                timeRange={timeRange}
                channels={currentChannels.rows || []}
                groups={currentGroups.groups || []}
                users={currentUsers.rows || []}
                onNavigateChannelsDetail={() => navigate("channels_detail")}
                onNavigateGroupsDetail={() => navigate("groups_detail")}
              />
            )}

            {currentView === "channels_detail" && (
              <ChannelsDetailView
                timeRange={timeRange}
                rows={currentChannels.rows || []}
              />
            )}

            {currentView === "groups_detail" && (
              <GroupsDetailView
                timeRange={timeRange}
                groups={currentGroups.groups || []}
              />
            )}

            {currentView === "upstreams" && (
              <UpstreamsView
                timeRange={timeRange}
                accounts={(currentUpstreams?.accounts as any) || []}
              />
            )}

            {currentView === "quality" && (
              <QualityView
                quality={(previewData.quality as any) || {}}
                accounts={(currentUpstreams?.accounts as any) || []}
              />
            )}

            {currentView !== "overview" &&
              currentView !== "profit" &&
              currentView !== "rank" &&
              currentView !== "channels_detail" &&
              currentView !== "groups_detail" &&
              currentView !== "upstreams" &&
              currentView !== "quality" && (
                <PlaceholderView viewKey={currentView as PlaceholderKey} />
              )}
          </main>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}

export default App
