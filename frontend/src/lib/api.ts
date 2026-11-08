import type { ChannelRowData } from "@/components/channels-rank-view"
import type { GroupRowData } from "@/components/groups-rank-view"
import type { UpstreamAccount } from "@/components/upstreams-view"
import type { QualityData } from "@/components/quality-view"
import type { UserRowData } from "@/components/table-utils"

const HOUR_MS = 3600000
const DAY_MS = 86400000
const BEIJING_OFFSET_MS = 8 * HOUR_MS

export type RangeType = "24h" | "7d"

export interface DateRange {
  from: number
  to: number
}

export interface ArchiveInfo {
  from_day: string | null
  to_day: string | null
  days: number
  available: boolean
  partial_fields: string[]
}

export interface Meta {
  site?: string
  source?: string
  min_t?: number | null
  max_t: number | null
  rows: number
  currency?: string
  quota_per_unit?: number
  preview?: boolean
  site_name?: string
}

export interface TokenStats {
  total: number
  input_total: number
  input_uncached: number
  cache_read: number
  cache_write: number
  output: number
}

export interface Overview {
  range: DateRange
  revenue: number
  quota: number
  requests: number
  tokens: TokenStats | null
  cache_rate: number | null
  latency: { p50: number | null; p95: number | null; count: number }
  archive: ArchiveInfo
  upstream_cost: number | null
  margin: number | null
  margin_status: string
}

export interface TrendPoint {
  bucket: string
  revenue: number
  quota: number
  requests: number
}

export interface TrendData {
  granularity: "day" | "hour"
  points: TrendPoint[]
  archive: ArchiveInfo
}

export interface ProfitBucket {
  t_ms?: number
  label: string
}

export interface ProfitSite {
  account_id: string
  name: string
  channels?: number[]
  kind?: string | null
  enabled?: boolean
  revenue: number
  credits?: number | null
  cost: number | null
  profit: number | null
  margin: number | null
  status: string
  covered_buckets: number
  bucket_count: number
}

export interface ProfitSeries {
  revenue_by_site: Record<string, (number | null)[]>
  cost_by_site: Record<string, (number | null)[]>
  profit_by_site?: Record<string, (number | null)[]>
  margin_by_site?: Record<string, (number | null)[]>
  revenue_by_channel?: unknown
}

export interface ProfitQuality {
  accounts_missing_balance?: string[]
  hours_without_snapshot?: number
  [key: string]: unknown
}

export interface ProfitUnmapped {
  revenue: number
  points?: number[]
  channels?: { channel_id: number; channel_name: string; revenue: number }[]
}

export interface ProfitData {
  granularity: "day" | "hour"
  from: number
  to: number
  buckets: ProfitBucket[]
  sites: ProfitSite[]
  series: ProfitSeries
  unmapped?: ProfitUnmapped
  quality?: ProfitQuality
  archive?: ArchiveInfo
}

export interface ChannelsPayload {
  rows: ChannelRowData[]
  archive?: ArchiveInfo
}

export interface GroupsPayload {
  groups: GroupRowData[]
}

export interface UsersPayload {
  users: UserRowData[]
  total_revenue: number
}

export interface UpstreamsPayload {
  accounts: UpstreamAccount[]
  archive?: ArchiveInfo
}

export interface DashboardData {
  meta: Meta | null
  range: DateRange | null
  overview: Overview | null
  trend: TrendData | null
  profit: ProfitData | null
  channels: ChannelsPayload | null
  groups: GroupsPayload | null
  users: UsersPayload | null
  upstreams: UpstreamsPayload | null
  quality: QualityData | null
  errors: string[]
}

export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "ApiError"
    this.status = status
  }
}

export async function fetchJson<T>(
  path: string,
  params?: Record<string, string | number>
): Promise<T> {
  const url = new URL(path, window.location.origin)
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value))
      }
    }
  }

  const res = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
    cache: "no-store",
  })

  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      const body = await res.json()
      if (body?.error?.message) message = String(body.error.message)
    } catch {
      // 响应体不是 JSON 时保留 HTTP 状态说明
    }
    throw new ApiError(message, res.status)
  }

  return (await res.json()) as T
}

/** 北京时间自然日 00:00 的 UTC 毫秒时间戳 */
function beijingDayStart(ms: number): number {
  return Math.floor((ms + BEIJING_OFFSET_MS) / DAY_MS) * DAY_MS - BEIJING_OFFSET_MS
}

export function computeRange(meta: Meta, rangeType: RangeType): DateRange {
  const maxT = meta.max_t
  if (typeof maxT !== "number" || !Number.isFinite(maxT)) {
    throw new RangeError("meta.max_t 不是有效时间戳")
  }

  if (rangeType === "24h") {
    // 24 个整点桶（含当前未走完的小时），窗口锚定数据截止时间而不是浏览器当前时间
    const hourStart = Math.floor(maxT / HOUR_MS) * HOUR_MS
    return { from: hourStart - 23 * HOUR_MS, to: maxT }
  }

  return { from: beijingDayStart(maxT) - 6 * DAY_MS, to: maxT }
}

export function emptyDashboard(errors: string[]): DashboardData {
  return {
    meta: null,
    range: null,
    overview: null,
    trend: null,
    profit: null,
    channels: null,
    groups: null,
    users: null,
    upstreams: null,
    quality: null,
    errors,
  }
}

function settledValue<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === "fulfilled" ? result.value : null
}

export async function loadDashboard(rangeType: RangeType): Promise<DashboardData> {
  let meta: Meta
  try {
    meta = await fetchJson<Meta>("/api/meta")
  } catch {
    return emptyDashboard(["meta"])
  }

  if (typeof meta.max_t !== "number" || !Number.isFinite(meta.max_t)) {
    return emptyDashboard(["meta"])
  }

  const range = computeRange(meta, rangeType)
  const granularity = rangeType === "24h" ? "hour" : "day"
  const rangeParams = { from: range.from, to: range.to }

  const [
    overviewResult,
    trendResult,
    profitResult,
    channelsResult,
    groupsResult,
    usersResult,
    upstreamsResult,
    qualityResult,
  ] = await Promise.allSettled([
    fetchJson<Overview>("/api/overview", rangeParams),
    fetchJson<TrendData>("/api/trend", { ...rangeParams, granularity }),
    fetchJson<ProfitData>("/api/profit", { ...rangeParams, granularity }),
    fetchJson<ChannelsPayload>("/api/channels", rangeParams),
    fetchJson<GroupsPayload>("/api/groups", rangeParams),
    fetchJson<UsersPayload>("/api/users", rangeParams),
    fetchJson<UpstreamsPayload>("/api/upstreams", rangeParams),
    fetchJson<QualityData>("/api/quality"),
  ])

  const results = [
    overviewResult,
    trendResult,
    profitResult,
    channelsResult,
    groupsResult,
    usersResult,
    upstreamsResult,
    qualityResult,
  ] as const
  const names = [
    "overview",
    "trend",
    "profit",
    "channels",
    "groups",
    "users",
    "upstreams",
    "quality",
  ] as const

  const errors: string[] = []
  results.forEach((result, index) => {
    if (result.status === "rejected") errors.push(names[index])
  })

  const usersPayload = settledValue(usersResult)
  const totalRevenue = usersPayload?.total_revenue ?? 0
  const users = usersPayload
    ? {
        total_revenue: totalRevenue,
        users: (usersPayload.users ?? []).map((user) => ({
          ...user,
          share: totalRevenue > 0 ? (user.revenue ?? 0) / totalRevenue : 0,
        })),
      }
    : null

  return {
    meta,
    range,
    overview: settledValue(overviewResult),
    trend: settledValue(trendResult),
    profit: settledValue(profitResult),
    channels: settledValue(channelsResult),
    groups: settledValue(groupsResult),
    users,
    upstreams: settledValue(upstreamsResult),
    quality: settledValue(qualityResult),
    errors,
  }
}
