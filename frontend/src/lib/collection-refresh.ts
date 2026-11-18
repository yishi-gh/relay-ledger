export type CollectionResource = "logs" | "errors" | "httpErrors" | "spend" | "routes"
export type CollectionState = "queued" | "running" | "fresh" | "partial" | "error" | "cooldown" | "disabled"

interface SpendRefreshResult {
  updated_accounts: string[]
  issues: { name: string; reason: string }[]
}

export interface CollectionRefreshGroup {
  resource: CollectionResource
  request_id: number
  completed_id: number
  state: CollectionState
  last_success_at: number | null
  last_attempt_at: number | null
  retry_at: number | null
  error: string | null
  spend_result?: SpendRefreshResult
}

export interface CollectionRefreshPayload {
  groups: CollectionRefreshGroup[]
  revision: string
}

export interface RefreshCollectionOptions {
  view: string
  force?: boolean
  signal?: AbortSignal
  onProgress?: (payload: CollectionRefreshPayload) => void
}

export interface CollectionRefreshDependencies {
  fetch?: typeof fetch
  now?: () => number
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  url?: string | URL
}

export class CollectionRefreshError extends Error {
  code: string
  status?: number

  constructor(message: string, code: string, status?: number, cause?: unknown) {
    super(message, { cause })
    this.name = "CollectionRefreshError"
    this.code = code
    this.status = status
  }
}

const REQUEST_TIMEOUT_MS = 15_000
const REFRESH_TIMEOUT_MS = 120_000
const RESOURCE_LABELS: Record<CollectionResource, string> = {
  logs: "业务日志",
  errors: "上游错误",
  httpErrors: "入口错误",
  spend: "余额与充值",
  routes: "渠道配置",
}

async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  milliseconds: number,
  timeoutError: CollectionRefreshError,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw signal.reason
  const controller = new AbortController()
  const cancel = () => controller.abort(signal?.reason)
  signal?.addEventListener("abort", cancel, { once: true })
  const timer = setTimeout(() => controller.abort(timeoutError), milliseconds)
  let onAbort: () => void
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(controller.signal.reason)
    controller.signal.addEventListener("abort", onAbort, { once: true })
  })
  try {
    // 即使注入的 fetch/wait 不响应 signal，调用方也能及时结束等待。
    return await Promise.race([run(controller.signal), aborted])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", cancel)
    controller.signal.removeEventListener("abort", onAbort!)
  }
}

function waitForPoll(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", cancel)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel)
      resolve()
    }, milliseconds)
    signal.addEventListener("abort", cancel, { once: true })
    if (signal.aborted) cancel()
  })
}

function parsePayload(body: unknown): CollectionRefreshPayload {
  const payload = body as CollectionRefreshPayload | null
  const states: CollectionState[] = ["queued", "running", "fresh", "partial", "error", "cooldown", "disabled"]
  if (!payload || typeof payload.revision !== "string" || !Array.isArray(payload.groups)
    || payload.groups.some((group) => !group || !Object.hasOwn(RESOURCE_LABELS, group.resource)
      || !states.includes(group.state)
      || !Number.isSafeInteger(group.request_id) || group.request_id < 0
      || !Number.isSafeInteger(group.completed_id) || group.completed_id < 0
      || (group.state === "partial" && (group.resource !== "spend" || !validSpendResult(group.spend_result)))
      || (group.error !== null && typeof group.error !== "string"))
    || new Set(payload.groups.map((group) => group.resource)).size !== payload.groups.length) {
    throw new CollectionRefreshError("采集刷新响应格式错误", "INVALID_RESPONSE")
  }
  return payload
}

function validSpendResult(result: SpendRefreshResult | undefined): boolean {
  return Array.isArray(result?.updated_accounts) && result.updated_accounts.length > 0
    && result.updated_accounts.every((name) => typeof name === "string")
    && Array.isArray(result.issues)
    && result.issues.every((issue) => issue && typeof issue.name === "string" && typeof issue.reason === "string")
}

/** 只提交一次采集请求，随后只读状态；固定历史窗口由调用方直接读取本地数据。 */
export async function refreshCollection(
  { view, force = false, signal, onProgress }: RefreshCollectionOptions,
  dependencies: CollectionRefreshDependencies = {},
): Promise<CollectionRefreshPayload> {
  const requestFetch = dependencies.fetch ?? globalThis.fetch
  const now = dependencies.now ?? Date.now
  const wait = dependencies.wait ?? waitForPoll
  const url = String(dependencies.url ?? (typeof window === "undefined"
    ? "/api/refresh"
    : new URL("/api/refresh", window.location.origin)))
  const [path, query] = url.split("?")
  const params = new URLSearchParams(query)
  params.set("view", view)
  const statusUrl = `${path}?${params}`
  const deadline = now() + REFRESH_TIMEOUT_MS
  const timeoutError = new CollectionRefreshError("等待采集刷新超时（120 秒），请稍后重试", "REFRESH_TIMEOUT")

  try {
    return await withTimeout(async (refreshSignal) => {
      function checkActive() {
        if (refreshSignal.aborted) throw refreshSignal.reason
        if (now() >= deadline) throw timeoutError
      }

      async function request(method: "POST" | "GET"): Promise<CollectionRefreshPayload> {
        checkActive()
        return withTimeout(async (requestSignal) => {
          let response: Response
          try {
            response = await requestFetch(method === "POST" ? url : statusUrl, {
              method,
              headers: method === "POST"
                ? { Accept: "application/json", "Content-Type": "application/json" }
                : { Accept: "application/json" },
              cache: "no-store",
              signal: requestSignal,
              ...(method === "POST" ? { body: JSON.stringify({ view, force }) } : {}),
            })
          } catch (cause) {
            if (requestSignal.aborted) throw requestSignal.reason
            const detail = cause instanceof Error ? cause.message : String(cause)
            throw new CollectionRefreshError(`采集刷新请求失败：${detail}`, "NETWORK_ERROR", undefined, cause)
          }
          let body: unknown
          try {
            body = await response.json()
          } catch (cause) {
            throw new CollectionRefreshError(`采集刷新响应不是有效的 JSON（HTTP ${response.status}）`, "INVALID_RESPONSE", response.status, cause)
          }
          if (!response.ok) {
            const error = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error
            const code = typeof error?.code === "string" ? error.code : "HTTP_ERROR"
            const message = typeof error?.message === "string" ? error.message : "服务返回错误"
            throw new CollectionRefreshError(`采集刷新请求失败（HTTP ${response.status}，${code}）：${message}`, code, response.status)
          }
          return parsePayload(body)
        }, REQUEST_TIMEOUT_MS, new CollectionRefreshError("采集刷新请求超时（15 秒），请稍后重试", "REQUEST_TIMEOUT"), refreshSignal)
      }

      let payload = await request("POST")
      // 已复用的资源不必再等；排队资源只等待本次 POST 对应的 ID。
      const targets = payload.groups
        .filter((group) => group.state === "queued" || group.state === "running")
        .map((group) => ({ resource: group.resource, requestId: group.request_id }))
      const failures = new Map<CollectionResource, CollectionRefreshGroup>()
      while (true) {
        checkActive()
        onProgress?.(payload)
        checkActive()
        for (const group of payload.groups) {
          if (group.state === "error" || group.state === "disabled"
            || (group.state === "cooldown" && group.error !== null)) failures.set(group.resource, group)
        }
        const completed = targets.every(({ resource, requestId }) => {
          const group = payload.groups.find((item) => item.resource === resource)
          if (!group) throw new CollectionRefreshError(`采集刷新响应缺少数据源：${RESOURCE_LABELS[resource]}`, "INVALID_RESPONSE")
          return group.completed_id >= requestId || failures.has(resource)
        })
        if (completed) {
          // 部分资源失败时仍等其余任务结束，调用方才能一次读到最终本地数据。
          if (failures.size) {
            const details = [...failures.values()].map((group) => {
              const state = group.state === "disabled" ? "采集已禁用" : group.state === "cooldown" ? "采集失败，正在冷却" : "采集失败"
              return `${RESOURCE_LABELS[group.resource]}：${state}${group.error ? `（${group.error}）` : ""}`
            })
            throw new CollectionRefreshError(`采集刷新失败：${details.join("；")}`, "COLLECTION_FAILED")
          }
          return payload
        }
        await wait(Math.min(1_000, deadline - now()), refreshSignal)
        checkActive()
        payload = await request("GET")
      }
    }, REFRESH_TIMEOUT_MS, timeoutError, signal)
  } catch (cause) {
    if (signal?.aborted) {
      const error = new Error("已取消采集刷新", { cause })
      error.name = "AbortError"
      throw error
    }
    throw cause
  }
}
