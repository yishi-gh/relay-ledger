import { useSyncExternalStore } from "react"
import sharedDefaults from "../../../shared/settings-defaults.json"
import { ApiError, getApiBaseUrl, type DateRange, type RangeType } from "./api"
import { validateCustomRange } from "./time-range"

export type PersonalPreferences = {
  display: {
    unitSystem: "zh" | "en" | "raw"
    currencyDecimals: number
    tokenDecimals: number
    percentDecimals: number
  }
  refresh: {
    intervalMinutes: 0 | 5 | 15 | 30 | 60
    pauseWhenHidden: boolean
    defaultRange: Exclude<RangeType, "custom"> | "remember"
  }
}

export type ServerSettings = Pick<typeof sharedDefaults, "monitoring" | "collection" | "health">
export type SettingsDefaults = PersonalPreferences & ServerSettings

export type CollectorStatus = {
  state: "active" | "stale" | "unconfirmed"
  observedRevision: string | null
  updatedAt: number | null
  effective: { logsMinutes: number | null; spendMinutes: number | null }
  overrides: { logs: boolean; spend: boolean }
  logsEnabled: boolean | null
  error?: string
}

export type SettingsSnapshot = {
  preferences: PersonalPreferences
  server: ServerSettings
  defaults: SettingsDefaults
  revision: string | null
  collector: CollectorStatus | null
  loading: boolean
  error: string | null
  timeRangeError: string | null
  serverError: string | null
  saving: boolean
}

export const PREFERENCES_STORAGE_KEY = "relay-ledger:preferences:v1"
export const LAST_RANGE_STORAGE_KEY = "relay-ledger:last-range"

function record(value: unknown, keys: string[], label: string, optionalKeys: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}格式无效`)
  }
  const result = value as Record<string, unknown>
  const allowedKeys = new Set([...keys, ...optionalKeys])
  if (Object.keys(result).some((key) => !allowedKeys.has(key)) || keys.some((key) => !Object.hasOwn(result, key))) {
    throw new Error(`${label}字段无效，请重新保存完整配置`)
  }
  return result
}

function finiteNumber(value: unknown, min: number, max: number, label: string, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${label}必须是 ${min} 至 ${max} 的${integer ? "整数" : "数值"}`)
  }
  return value
}

function positiveNumber(value: unknown, max: number, label: string): number {
  const result = finiteNumber(value, 0, max, label)
  if (result <= 0) throw new Error(`${label}必须大于 0 且不超过 ${max}`)
  return result
}

export function validatePreferences(value: unknown): PersonalPreferences {
  const root = record(value, ["display", "refresh"], "个人偏好")
  const display = record(root.display, ["unitSystem", "currencyDecimals", "tokenDecimals", "percentDecimals"], "显示设置")
  const refresh = record(root.refresh, ["intervalMinutes", "pauseWhenHidden", "defaultRange"], "刷新设置")
  if (display.unitSystem !== "zh" && display.unitSystem !== "en" && display.unitSystem !== "raw") {
    throw new Error("数字单位必须是中文、英文或原始数值")
  }
  if (![0, 5, 15, 30, 60].includes(refresh.intervalMinutes as number)) {
    throw new Error("自动刷新间隔必须是 0、5、15、30 或 60 分钟")
  }
  if (typeof refresh.pauseWhenHidden !== "boolean") throw new Error("后台暂停设置必须是布尔值")
  if (refresh.defaultRange !== "24h" && refresh.defaultRange !== "7d" && refresh.defaultRange !== "today" && refresh.defaultRange !== "remember") {
    throw new Error("默认时间范围无效")
  }
  return {
    display: {
      unitSystem: display.unitSystem,
      currencyDecimals: finiteNumber(display.currencyDecimals, 0, 4, "金额小数位", true),
      tokenDecimals: finiteNumber(display.tokenDecimals, 0, 4, "数量小数位", true),
      percentDecimals: finiteNumber(display.percentDecimals, 0, 3, "百分比小数位", true),
    },
    refresh: {
      intervalMinutes: refresh.intervalMinutes as PersonalPreferences["refresh"]["intervalMinutes"],
      pauseWhenHidden: refresh.pauseWhenHidden,
      defaultRange: refresh.defaultRange,
    },
  }
}

export const DEFAULT_PERSONAL_PREFERENCES = validatePreferences({
  display: sharedDefaults.display,
  refresh: sharedDefaults.refresh,
})
const DEFAULT_SERVER_SETTINGS: ServerSettings = {
  monitoring: sharedDefaults.monitoring,
  collection: sharedDefaults.collection,
  health: sharedDefaults.health,
}
const DEFAULTS: SettingsDefaults = { ...DEFAULT_PERSONAL_PREFERENCES, ...DEFAULT_SERVER_SETTINGS }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

let preferenceError: string | null = null
let timeRangeError: string | null = null
let serverError: string | null = null

function readPreferences(raw?: string | null): PersonalPreferences {
  try {
    const stored = raw === undefined && typeof window !== "undefined"
      ? window.localStorage.getItem(PREFERENCES_STORAGE_KEY)
      : raw
    if (!stored) return validatePreferences(DEFAULT_PERSONAL_PREFERENCES)
    return validatePreferences(JSON.parse(stored))
  } catch (error) {
    preferenceError = `个人偏好未能读取，当前使用默认值：${errorMessage(error)}`
    return validatePreferences(DEFAULT_PERSONAL_PREFERENCES)
  }
}

let snapshot: SettingsSnapshot = {
  preferences: readPreferences(),
  server: DEFAULT_SERVER_SETTINGS,
  defaults: DEFAULTS,
  revision: null,
  collector: null,
  loading: false,
  error: preferenceError,
  timeRangeError: null,
  serverError: null,
  saving: false,
}
const listeners = new Set<() => void>()
let serverReady = false
let requestVersion = 0
let loadRequest: Promise<void> | null = null
let pollTimer: number | undefined
let pollGeneration = 0

function publish(change: Partial<SettingsSnapshot> = {}) {
  const next = { ...snapshot, ...change, serverError, timeRangeError }
  const collectorError = next.collector?.error ? `采集确认异常：${next.collector.error}` : null
  snapshot = { ...next, error: [preferenceError, timeRangeError, serverError, collectorError].filter(Boolean).join("；") || null }
  for (const listener of listeners) listener()
}

export function getPreferences(): PersonalPreferences {
  return snapshot.preferences
}

export function getServerSettings(): ServerSettings {
  return snapshot.server
}

export function updatePreferences(next: PersonalPreferences): void {
  try {
    const preferences = validatePreferences(next)
    if (typeof window === "undefined") throw new Error("当前环境无法保存浏览器偏好")
    window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(preferences))
    preferenceError = null
    publish({ preferences })
  } catch (error) {
    preferenceError = `个人偏好保存失败：${errorMessage(error)}`
    publish()
    throw error
  }
}

export type TimeRangeSelection = { type: RangeType; customRange: DateRange | null }
let initialTimeRangeSelection: TimeRangeSelection | undefined

/** 同一次初始化只读一次存储，避免类型与自定义起止来自不同的 selection。 */
export function getInitialTimeRangeSelection(): TimeRangeSelection {
  if (initialTimeRangeSelection) return initialTimeRangeSelection
  const defaultRange = snapshot.preferences.refresh.defaultRange
  const fallback: TimeRangeSelection = { type: "24h", customRange: null }
  try {
    if (defaultRange !== "remember") {
      initialTimeRangeSelection = { type: defaultRange, customRange: null }
    } else {
      const stored = typeof window !== "undefined" ? window.localStorage.getItem(LAST_RANGE_STORAGE_KEY) : null
      if (!stored) initialTimeRangeSelection = fallback
      else if (stored === "24h" || stored === "7d" || stored === "today") {
        initialTimeRangeSelection = { type: stored, customRange: null }
      } else {
        const selection = record(JSON.parse(stored), ["type", "from", "to"], "上次自定义时间范围")
        if (selection.type !== "custom") throw new Error("上次时间范围类型无效")
        const range = validateCustomRange({ from: selection.from as number, to: selection.to as number })
        initialTimeRangeSelection = { type: "custom", customRange: range }
      }
    }
  } catch (error) {
    timeRangeError = `上次时间范围未能读取，已恢复近 24 小时：${errorMessage(error)}`
    snapshot = { ...snapshot, timeRangeError, error: [snapshot.error, timeRangeError].filter(Boolean).join("；") }
    initialTimeRangeSelection = fallback
  }
  return initialTimeRangeSelection
}

export function getInitialTimeRange(): RangeType {
  return getInitialTimeRangeSelection().type
}

export function getInitialCustomRange(): DateRange | null {
  return getInitialTimeRangeSelection().customRange
}

export function rememberTimeRange(range: RangeType, customRange?: DateRange): void {
  try {
    const stored = range === "custom" ? JSON.stringify({ type: range, ...validateCustomRange(customRange) }) : range
    window.localStorage.setItem(LAST_RANGE_STORAGE_KEY, stored)
    timeRangeError = null
    publish()
  } catch (error) {
    timeRangeError = `时间范围未能记住：${errorMessage(error)}`
    publish()
  }
}

/** 仅允许原部署采集间隔按原值保留；用户新设间隔仍须为 1 至 1440 的整数。 */
export function validateServerSettings(value: unknown, collectionDefaults?: ServerSettings["collection"]): ServerSettings {
  const root = record(value, ["monitoring", "collection", "health"], "共享设置")
  const monitoring = record(root.monitoring, ["cacheRate", "latencyP50", "latencyP95", "runway", "freshness"], "监控设置")
  const cache = record(monitoring.cacheRate, ["good", "warn"], "缓存率阈值")
  const p50 = record(monitoring.latencyP50, ["goodMs", "warnMs"], "P50 阈值")
  const p95 = record(monitoring.latencyP95, ["goodMs", "warnMs"], "P95 阈值")
  const runway = record(monitoring.runway, ["dangerDays", "warnDays"], "续航阈值")
  const freshness = record(monitoring.freshness, ["warnMinutes", "dangerMinutes"], "新鲜度阈值")
  const collection = record(root.collection, ["logsMinutes", "spendMinutes"], "采集设置")
  const health = record(root.health, ["minSamples", "failErrorRate"], "健康设置")
  function collectionMinutes(key: keyof ServerSettings["collection"], label: string): number {
    return collectionDefaults && collection[key] === collectionDefaults[key]
      ? positiveNumber(collection[key], Number.MAX_VALUE, label)
      : finiteNumber(collection[key], 1, 1440, label, true)
  }
  const result: ServerSettings = {
    monitoring: {
      cacheRate: { good: finiteNumber(cache.good, 0, 1, "缓存良好阈值"), warn: finiteNumber(cache.warn, 0, 1, "缓存警告阈值") },
      latencyP50: { goodMs: finiteNumber(p50.goodMs, 1, 3600000, "P50 良好阈值（毫秒）", true), warnMs: finiteNumber(p50.warnMs, 1, 3600000, "P50 警告阈值（毫秒）", true) },
      latencyP95: { goodMs: finiteNumber(p95.goodMs, 1, 3600000, "P95 良好阈值（毫秒）", true), warnMs: finiteNumber(p95.warnMs, 1, 3600000, "P95 警告阈值（毫秒）", true) },
      runway: { dangerDays: positiveNumber(runway.dangerDays, 3650, "续航危险阈值"), warnDays: positiveNumber(runway.warnDays, 3650, "续航警告阈值") },
      freshness: { warnMinutes: positiveNumber(freshness.warnMinutes, 10080, "新鲜度警告阈值"), dangerMinutes: positiveNumber(freshness.dangerMinutes, 10080, "新鲜度危险阈值") },
    },
    collection: {
      logsMinutes: collectionMinutes("logsMinutes", "日志采集间隔"),
      spendMinutes: collectionMinutes("spendMinutes", "余额采集间隔"),
    },
    health: {
      minSamples: finiteNumber(health.minSamples, 1, 1000000, "健康最小样本数", true),
      failErrorRate: positiveNumber(health.failErrorRate, 1, "失败错误率"),
    },
  }
  const m = result.monitoring
  if (m.cacheRate.warn >= m.cacheRate.good) throw new Error("缓存率警告阈值必须小于良好阈值")
  if (m.latencyP50.goodMs >= m.latencyP50.warnMs) throw new Error("P50 良好阈值必须小于警告阈值")
  if (m.latencyP95.goodMs >= m.latencyP95.warnMs) throw new Error("P95 良好阈值必须小于警告阈值")
  if (m.runway.dangerDays >= m.runway.warnDays) throw new Error("续航危险阈值必须小于警告阈值")
  if (m.freshness.warnMinutes >= m.freshness.dangerMinutes) throw new Error("新鲜度警告阈值必须小于危险阈值")
  return result
}

function nullableNumber(value: unknown, label: string): number | null {
  return value === null ? null : finiteNumber(value, 0, Number.MAX_SAFE_INTEGER, label)
}

function parseResponse(value: unknown): Pick<SettingsSnapshot, "server" | "defaults" | "revision" | "collector"> {
  const root = record(value, ["settings", "defaults", "revision", "collector"], "服务器设置响应")
  if (typeof root.revision !== "string" || !root.revision) throw new Error("服务器未返回有效配置版本")
  const defaults = record(root.defaults, ["display", "refresh", "monitoring", "collection", "health"], "默认设置")
  const defaultCollection = record(defaults.collection, ["logsMinutes", "spendMinutes"], "默认采集设置")
  const collectionDefaults = {
    logsMinutes: positiveNumber(defaultCollection.logsMinutes, Number.MAX_VALUE, "部署日志采集间隔"),
    spendMinutes: positiveNumber(defaultCollection.spendMinutes, Number.MAX_VALUE, "部署余额采集间隔"),
  }
  const c = record(root.collector, ["state", "observedRevision", "updatedAt", "effective", "overrides", "logsEnabled"], "采集器状态", ["error"])
  const effective = record(c.effective, ["logsMinutes", "spendMinutes"], "有效采集间隔")
  const overrides = record(c.overrides, ["logs", "spend"], "采集覆盖状态")
  if (c.state !== "active" && c.state !== "stale" && c.state !== "unconfirmed") throw new Error("采集器状态无效")
  if ((c.observedRevision !== null && typeof c.observedRevision !== "string") || typeof overrides.logs !== "boolean" || typeof overrides.spend !== "boolean" || (c.logsEnabled !== null && typeof c.logsEnabled !== "boolean")) {
    throw new Error("采集器确认数据无效")
  }
  if (Object.hasOwn(c, "error") && typeof c.error !== "string") throw new Error("采集器确认错误说明必须是字符串")
  return {
    server: validateServerSettings(root.settings, collectionDefaults),
    defaults: {
      ...validatePreferences({ display: defaults.display, refresh: defaults.refresh }),
      ...validateServerSettings({ monitoring: defaults.monitoring, collection: defaults.collection, health: defaults.health }, collectionDefaults),
    },
    revision: root.revision,
    collector: {
      state: c.state,
      observedRevision: c.observedRevision,
      updatedAt: nullableNumber(c.updatedAt, "采集器更新时间"),
      effective: { logsMinutes: nullableNumber(effective.logsMinutes, "日志有效间隔"), spendMinutes: nullableNumber(effective.spendMinutes, "余额有效间隔") },
      overrides: { logs: overrides.logs, spend: overrides.spend },
      logsEnabled: c.logsEnabled,
      ...(typeof c.error === "string" ? { error: c.error } : {}),
    },
  }
}

async function requestSettings(init?: RequestInit): Promise<ReturnType<typeof parseResponse>> {
  const response = await fetch(new URL("/api/settings", getApiBaseUrl()), {
    ...init,
    headers: { Accept: "application/json", ...init?.headers },
    cache: "no-store",
    credentials: "same-origin",
  })
  if (!response.ok) {
    let message = `HTTP ${response.status}`
    try {
      const body = await response.json()
      if (body?.error?.message) message = String(body.error.message)
    } catch {
      // 非 JSON 错误仍保留 HTTP 状态。
    }
    if (response.status === 409) message = `共享设置已被其他人修改，请重新读取后再保存：${message}`
    throw new ApiError(message, response.status)
  }
  return parseResponse(await response.json())
}

export function loadServerSettings(): Promise<void> {
  if (loadRequest) return loadRequest
  if (snapshot.saving) return Promise.reject(new Error("共享设置正在保存，请保存完成后再读取"))
  const version = requestVersion
  publish({ loading: true })
  loadRequest = (async () => {
    try {
      const result = await requestSettings()
      if (version !== requestVersion) throw new Error("本次共享设置读取已被较新的保存取代，请重新读取")
      serverReady = true
      serverError = null
      publish(result)
    } catch (error) {
      if (version !== requestVersion) throw error
      serverReady = false
      serverError = `共享设置读取失败，保存已禁用：${errorMessage(error)}`
      publish()
      throw error
    } finally {
      loadRequest = null
      publish({ loading: false })
    }
  })()
  return loadRequest
}

export async function saveServerSettings(next: ServerSettings): Promise<void> {
  if (snapshot.saving) throw new Error("共享设置正在保存")
  try {
    if (!serverReady || !snapshot.revision) throw new Error("请先成功读取服务器设置，再保存修改")
    const settings = validateServerSettings(next, snapshot.defaults.collection)
    const revision = snapshot.revision
    requestVersion += 1
    publish({ saving: true })
    const result = await requestSettings({
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Requested-With": "relay-ledger" },
      body: JSON.stringify({ settings, revision }),
    })
    serverReady = true
    serverError = null
    publish(result)
    schedulePoll()
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) serverReady = false
    serverError = `共享设置保存失败：${errorMessage(error)}`
    publish()
    throw error
  } finally {
    publish({ saving: false })
  }
}

function handleStorage(event: StorageEvent) {
  if (event.key !== PREFERENCES_STORAGE_KEY && event.key !== null) return
  preferenceError = null
  publish({ preferences: readPreferences(event.newValue) })
}

function schedulePoll() {
  if (pollTimer !== undefined) window.clearTimeout(pollTimer)
  if (!listeners.size) return
  const generation = pollGeneration
  const pending = snapshot.collector?.observedRevision !== snapshot.revision
  pollTimer = window.setTimeout(async () => {
    try {
      await loadServerSettings()
    } catch {
      // 失败已在 store 中显示；后台轮询按固定间隔重试。
    } finally {
      if (generation === pollGeneration) schedulePoll()
    }
  }, pending && !serverError ? 5000 : 30000)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1 && typeof window !== "undefined") {
    const generation = ++pollGeneration
    window.addEventListener("storage", handleStorage)
    const afterLoad = () => {
      if (generation === pollGeneration) schedulePoll()
    }
    void loadServerSettings().then(afterLoad, afterLoad)
  }
  return () => {
    listeners.delete(listener)
    if (!listeners.size && typeof window !== "undefined") {
      pollGeneration += 1
      if (pollTimer !== undefined) window.clearTimeout(pollTimer)
      pollTimer = undefined
      window.removeEventListener("storage", handleStorage)
    }
  }
}

function getSnapshot(): SettingsSnapshot {
  return snapshot
}

export function useSettings(): SettingsSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
