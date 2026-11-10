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
  base_url?: string
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
  tokens: number
  cache_rate: number | null
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

export interface ChannelRoutesPayload {
  available: boolean
  synced_at: number | null
  last_attempt_at: number | null
  error: string | null
  routes_available: boolean
  routes_error: string | null
  channels: Array<{
    id: number
    name: string
    status: number | null
    state: "enabled" | "disabled" | "unknown"
    endpoint: string | null
    account_ids: string[]
    model_mapping: Record<string, string> | null
    mapping_error: string | null
  }>
  accounts: Array<{
    id: string
    name: string
    website: string | null
    channel_ids: number[]
  }>
  abilities: Array<{
    group: string
    model: string
    channel_id: number
    enabled: boolean | null
    priority: number | null
    weight: number | null
  }>
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
  capital: CapitalPayload | null
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

export function getApiBaseUrl(): string {
  if (typeof window !== "undefined") {
    const port = window.location.port
    if (port === "5173" || port === "5178") {
      return "http://127.0.0.1:8788"
    }
    return window.location.origin
  }
  return "http://127.0.0.1:8788"
}

export async function fetchJson<T>(
  path: string,
  params?: Record<string, string | number>,
  options?: { signal?: AbortSignal },
): Promise<T> {
  const url = new URL(path, getApiBaseUrl())
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
    signal: options?.signal,
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

export function fetchChannelRoutes(options?: { signal?: AbortSignal }): Promise<ChannelRoutesPayload> {
  return fetchJson<ChannelRoutesPayload>("/api/routes", undefined, options)
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
    capital: null,
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
    capitalResult,
  ] = await Promise.allSettled([
    fetchJson<Overview>("/api/overview", rangeParams),
    fetchJson<TrendData>("/api/trend", { ...rangeParams, granularity }),
    fetchJson<ProfitData>("/api/profit", { ...rangeParams, granularity }),
    fetchJson<ChannelsPayload>("/api/channels", rangeParams),
    fetchJson<GroupsPayload>("/api/groups", rangeParams),
    fetchJson<UsersPayload>("/api/users", rangeParams),
    fetchJson<UpstreamsPayload>("/api/upstreams", rangeParams),
    fetchJson<QualityData>("/api/quality"),
    fetchJson<CapitalPayload>("/api/capital", rangeParams),
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
    capital: settledValue(capitalResult),
    errors,
  }
}

// ---------------------------------------------------------------------------
// 新增接口模型定义与请求函数
// ---------------------------------------------------------------------------

export interface ModelItem {
  model: string
  revenue: number
  requests: number
  tokens: number
  share: number
  per_1e8: number | null
  upstream_accounts: string[]
}

export interface ModelsPayload {
  models: ModelItem[]
  total_revenue: number
  archive?: ArchiveInfo
}

export interface CapitalAccount {
  account_id: string
  name: string
  balance: number | null
  cost_range: number | null
  credits_range: number | null
  daily_avg_7d: number | null
  runway_days: number | null
  top_group?: string | null
  status: string
  channels_live?: number
  channels_total?: number
}

export interface CapitalTotal {
  balance: number | null
  cost_range: number | null
  credits_range: number | null
  daily_avg_7d: number | null
  runway_days: number | null
  accounts_counted?: number
  avg?: number | null
  runway?: number | null
  credits?: number | null
}

export interface CapitalPayload {
  accounts: CapitalAccount[]
  total: CapitalTotal
  range: DateRange
  generated_at: number
}

export interface ErrorBucket {
  t_ms: number
  label: string
  total: number
  s4xx: number
  s5xx: number
}

export interface ErrorTopStatus {
  status: number
  count: number
  share: number
}

export interface ErrorPathGroup {
  path_group: string
  count: number
  share: number
}

export interface ErrorsPayload {
  from: number
  to: number
  available: boolean
  total: number
  buckets: ErrorBucket[]
  top_status: ErrorTopStatus[]
  by_path_group: ErrorPathGroup[]
}

export interface HealthzPayload {
  ok: boolean
}

export type StatusLevel = "channel" | "group"

export type StatusBucketSize = "15m" | "1h"

export type StatusState = "ok" | "warn" | "fail" | "unknown" | "none"

export interface StatusTopError {
  status: number
  count: number
}

export interface StatusBucket {
  t_ms: number
  label: string
  total: number
  errors: number
  state: StatusState
  top_errors: StatusTopError[]
}

export interface StatusComponent {
  key: string
  name: string
  requests: number
  errors: number
  uptime: number | null
  buckets: StatusBucket[]
  top_errors: StatusTopError[]
}

export interface StatusPayload {
  from: number
  to: number
  level: StatusLevel
  bucket?: StatusBucketSize
  components: StatusComponent[]
  overall: {
    requests: number
    errors: number
    uptime: number | null
  }
  coverage: {
    errors_since: number | null
  }
}

export async function fetchStatus(
  range: DateRange,
  level: StatusLevel,
  bucket?: StatusBucketSize
): Promise<StatusPayload> {
  return fetchJson<StatusPayload>("/api/status", {
    from: range.from,
    to: range.to,
    level,
    ...(bucket ? { bucket } : {}),
  })
}

export async function fetchModels(range: DateRange): Promise<ModelsPayload> {
  return fetchJson<ModelsPayload>("/api/models", { from: range.from, to: range.to })
}

export async function fetchCapital(range: DateRange): Promise<CapitalPayload> {
  return fetchJson<CapitalPayload>("/api/capital", { from: range.from, to: range.to })
}

export async function fetchErrors(range: DateRange): Promise<ErrorsPayload> {
  return fetchJson<ErrorsPayload>("/api/errors", { from: range.from, to: range.to })
}

export async function fetchHealthz(): Promise<HealthzPayload> {
  return fetchJson<HealthzPayload>("/api/healthz")
}

export function getMockModels(): ModelsPayload {
  const models: ModelItem[] = [
    {
      model: "claude-3-7-sonnet-20250219",
      revenue: 142.5,
      requests: 12450,
      tokens: 2850000000,
      share: 0.457,
      per_1e8: 5.0,
      upstream_accounts: ["acc-anthropic", "acc-aws"],
    },
    {
      model: "gpt-4o",
      revenue: 86.2,
      requests: 9820,
      tokens: 1724000000,
      share: 0.276,
      per_1e8: 5.0,
      upstream_accounts: ["acc-openai"],
    },
    {
      model: "deepseek-ai/DeepSeek-V3",
      revenue: 45.1,
      requests: 8430,
      tokens: 902000000,
      share: 0.145,
      per_1e8: 5.0,
      upstream_accounts: ["acc-deepseek"],
    },
    {
      model: "claude-3-5-haiku-20241022",
      revenue: 25.8,
      requests: 4320,
      tokens: 516000000,
      share: 0.083,
      per_1e8: 5.0,
      upstream_accounts: ["acc-anthropic"],
    },
    {
      model: "gpt-4o-mini",
      revenue: 12.3,
      requests: 1496,
      tokens: 246000000,
      share: 0.039,
      per_1e8: 5.0,
      upstream_accounts: ["acc-openai"],
    },
  ]
  return {
    models,
    total_revenue: 311.9,
    archive: {
      from_day: "",
      to_day: "",
      days: 0,
      available: false,
      partial_fields: [],
    },
  }
}

export function getMockCapital(range: DateRange): CapitalPayload {
  const accounts: CapitalAccount[] = [
    {
      account_id: "acc-anthropic",
      name: "Anthropic Direct",
      balance: 1250.0,
      cost_range: 168.3,
      credits_range: 500.0,
      daily_avg_7d: 24.04,
      runway_days: 52.0,
      status: "ok",
    },
    {
      account_id: "acc-openai",
      name: "OpenAI Platform",
      balance: 84.5,
      cost_range: 98.5,
      credits_range: 0,
      daily_avg_7d: 14.07,
      runway_days: 6.0,
      status: "ok",
    },
    {
      account_id: "acc-aws",
      name: "AWS Bedrock",
      balance: 18.2,
      cost_range: 42.1,
      credits_range: 0,
      daily_avg_7d: 6.01,
      runway_days: 3.0,
      status: "ok",
    },
    {
      account_id: "acc-deepseek",
      name: "DeepSeek API",
      balance: 4.8,
      cost_range: 45.1,
      credits_range: 100.0,
      daily_avg_7d: 6.44,
      runway_days: 0.7,
      status: "ok",
    },
    {
      account_id: "acc-openrouter",
      name: "OpenRouter Backup",
      balance: null,
      cost_range: null,
      credits_range: null,
      daily_avg_7d: null,
      runway_days: null,
      status: "missing_balance",
    },
  ]
  return {
    accounts,
    total: {
      balance: 1357.5,
      cost_range: 354.0,
      credits_range: 600.0,
      daily_avg_7d: 50.56,
      runway_days: 26.8,
      accounts_counted: 4,
    },
    range,
    generated_at: Date.now(),
  }
}

export function getMockErrors(range: DateRange): ErrorsPayload {
  const buckets: ErrorBucket[] = []
  const count = 24
  const start = range.from
  const step = Math.max(3600000, Math.floor((range.to - range.from) / count))

  for (let i = 0; i < count; i++) {
    const t = start + i * step
    const d = new Date(t)
    const label = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:00`
    const s4xx = i % 4 === 1 ? 3 : i % 5 === 0 ? 2 : 0
    const s5xx = i % 7 === 2 ? 2 : 0
    buckets.push({
      t_ms: t,
      label,
      total: s4xx + s5xx,
      s4xx,
      s5xx,
    })
  }

  return {
    from: range.from,
    to: range.to,
    available: true,
    total: 35,
    buckets,
    top_status: [
      { status: 429, count: 18, share: 0.514 },
      { status: 502, count: 8, share: 0.229 },
      { status: 400, count: 5, share: 0.143 },
      { status: 500, count: 4, share: 0.114 },
    ],
    by_path_group: [
      { path_group: "/v1", count: 26, share: 0.743 },
      { path_group: "/api", count: 6, share: 0.171 },
      { path_group: "other", count: 3, share: 0.086 },
    ],
  }
}
