/** 接口返回的行级模型：只描述数据形状，视图与 lib 层共用，避免 lib 反向依赖组件。 */

export interface ChannelRowData {
  channel_id: number
  channel_name: string
  revenue: number
  quota?: number
  tokens?: number
  tokens_total?: number
  requests?: number
  cache_rate?: number
  latency_p50?: number
  p50?: number
  latency_p95?: number
  p95?: number
  tps?: number
  last_t?: number | null
  top_model?: {
    model: string
    revenue: number
    tokens: number
    per_1e8: number
  } | null
  upstream_account?: string | null
  margin_status?: string
  archive_only?: boolean
  margin?: number | null
  margin_pct?: number | null
  status?: string
}

export interface GroupRowData {
  group_name: string
  channels?: number
  channel_names?: string[]
  revenue: number
  tokens?: number
  requests?: number
  cache_rate?: number
  p50?: number
  latency_p50?: number
  p95?: number
  latency_p95?: number
  tps?: number
  last_t?: number | null
  top_model?: {
    model: string
    revenue: number
    tokens: number
    per_1e8: number
  } | null
  margin?: number | null
  margin_pct?: number | null
  status?: string
}

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
  auto_channels?: number[]
  enabled?: boolean
  external?: boolean
  cost?: number | null
  profit?: number | null
}

export interface JobRun {
  job: string
  started_at: number
  finished_at: number
  status: "ok" | "complete" | "partial" | "error" | string
  detail?: string
}

export interface CollectError {
  account_id: string
  name?: string
  reason: string
  at: number
}

export interface QualityData {
  source_last_t?: number | null
  source_rows?: number | null
  error_rows?: number | null
  job_runs?: JobRun[]
  collect_errors?: CollectError[]
  schema_ok?: boolean
  checked_at?: number | null
}

export interface UserRowData {
  user_name: string
  revenue: number
  requests: number
  tokens: number
  share?: number
}

export interface TrafficChartPoint {
  label: string
  fullLabel: string
  requests: number | null
  tokens: number | null
  cacheRate: number | null
}
