import type { DateRange, ProfitData, TrendData } from "./api"
import type { TrafficChartPoint } from "./api-types"
import { beijingDayStart, beijingTrendBucket, bucketLabel, DAY_MS, HOUR_MS } from "./time-range"

export type ProfitBucketRow = {
  label: string
  fullLabel: string
  revenue: number | null
  cost: number | null
  profit: number | null
  margin: number | null
  sites: number
}

/** 售出与成本只对同一批有完整值的非外部站点求和。 */
export function aggregateProfitBuckets(profit: ProfitData) {
  const revBySite = profit.series.revenue_by_site
  const costBySite = profit.series.cost_by_site
  const accountIds = profit.sites.filter((site) => site.kind !== "external").map((site) => site.account_id)
  let totalRevenue = 0
  let totalCost = 0
  let coveredBuckets = 0

  const rows: ProfitBucketRow[] = profit.buckets.map((bucket, index) => {
    const label = bucketLabel(bucket.label, profit.granularity)
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
    const bucketProfit = revenue - cost
    return { label, fullLabel: bucket.label, revenue, cost, profit: bucketProfit, margin: revenue > 0 ? bucketProfit / revenue : null, sites: used }
  })

  const totals = coveredBuckets === 0 ? null : {
    revenue: totalRevenue,
    cost: totalCost,
    profit: totalRevenue - totalCost,
    margin: totalRevenue > 0 ? (totalRevenue - totalCost) / totalRevenue : null,
    coveredBuckets,
    bucketCount: rows.length,
  }
  return { rows, totals }
}

/** 流量桶只依赖 trend 与实际范围，即使盈利接口失败也能补全零请求桶。 */
export function buildTrafficChartData(trend: TrendData | null, range?: DateRange | null): TrafficChartPoint[] {
  if (!trend) return []
  const granularity = trend.granularity
  const pointOf = (bucket: string, point?: TrendData["points"][number]): TrafficChartPoint => ({
    label: bucketLabel(bucket, granularity),
    fullLabel: bucket,
    requests: point ? typeof point.requests === "number" ? point.requests : null : 0,
    tokens: point ? typeof point.tokens === "number" ? point.tokens : null : 0,
    cacheRate: point && typeof point.cache_rate === "number" ? point.cache_rate : null,
  })
  if (!range) return trend.points.map((point) => pointOf(point.bucket, point))

  const byBucket = new Map(trend.points.map((point) => [point.bucket, point]))
  const step = granularity === "hour" ? HOUR_MS : DAY_MS
  const start = granularity === "hour" ? Math.floor(range.from / HOUR_MS) * HOUR_MS : beijingDayStart(range.from)
  const rows: TrafficChartPoint[] = []
  for (let t = start; t <= range.to; t += step) {
    const bucket = beijingTrendBucket(t, granularity)
    rows.push(pointOf(bucket, byBucket.get(bucket)))
  }
  return rows
}
