import assert from "node:assert/strict"
import { getEventListeners } from "node:events"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import vm from "node:vm"
import test from "node:test"

const require = createRequire(import.meta.url)
const ts = require("typescript")
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const file = resolve(root, "src/lib/collection-refresh.ts")
const compiled = ts.transpileModule(readFileSync(file, "utf8"), {
  fileName: file,
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText
const plain = (value) => JSON.parse(JSON.stringify(value))
const flush = () => new Promise(setImmediate)

function group(resource = "logs", overrides = {}) {
  return {
    resource, request_id: 1, completed_id: 1, state: "fresh",
    last_success_at: 0, last_attempt_at: 0, retry_at: null, error: null,
    ...overrides,
  }
}

const payload = (groups, revision = "revision-1") => ({ groups, revision })
const queued = (resource = "logs", overrides = {}) => group(resource, {
  state: "queued", request_id: 2, completed_id: 1, ...overrides,
})
const never = () => new Promise(() => {})

/** 编译执行真实 TS；fetch 严格使用夹具，计时器全部由虚拟时钟驱动。 */
function runtime({ responses = [], handler, href = "https://relay.example.test/dashboard" } = {}) {
  let clock = 0
  let timerId = 0
  const timers = new Map()
  const requests = []
  const setTimeout = (callback, delay) => {
    const id = ++timerId
    timers.set(id, { callback, at: clock + delay })
    return id
  }
  const fetch = async (input, options) => {
    const request = { input: String(input), url: new URL(input, href ?? "https://isolated.example.test"), options, at: clock }
    requests.push(request)
    if (handler) return handler(request, requests.length - 1)
    assert.ok(requests.length <= responses.length, "不应发送未约定的请求")
    const response = responses[requests.length - 1]
    return response instanceof Response ? response : Response.json(response)
  }
  const context = vm.createContext({
    console, Error, URL, URLSearchParams, AbortController, Response, fetch,
    Date: class extends Date { static now() { return clock } },
    setTimeout, clearTimeout: (id) => timers.delete(id),
    ...(href ? { window: { location: new URL(href) } } : {}),
  })
  const module = { exports: {} }
  vm.runInContext(`(function(require,module,exports){${compiled}\n})`, context, { filename: file })(
    (name) => { throw new Error(`独立模块不应依赖 ${name}`) }, module, module.exports,
  )
  async function tick(milliseconds) {
    const target = clock + milliseconds
    await flush()
    while (true) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (!next) break
      const [id, timer] = next
      clock = timer.at
      timers.delete(id)
      timer.callback()
      await flush()
    }
    clock = target
    await flush()
  }
  return {
    requests, timers, tick, fetch, exports: module.exports,
    now: () => clock,
    setNow: (value) => { clock = value },
    refresh: (options = {}, dependencies) => module.exports.refreshCollection({ view: "overview", ...options }, dependencies),
  }
}

test("只 POST 一次，再按一秒间隔 GET，完整转发进度和最终 revision", async () => {
  const posted = payload([queued(), queued("spend", { state: "running" }), group("routes")], "posted")
  const running = payload([queued("logs", { state: "running" }), group("spend", { request_id: 2, completed_id: 2 }), group("routes")], "running")
  const finished = payload([group("logs", { request_id: 2, completed_id: 2 }), group("spend", { request_id: 2, completed_id: 2 }), group("routes")], "finished")
  const r = runtime({ responses: [posted, running, finished] })
  const progress = []
  const controller = new AbortController()
  const pending = r.refresh({ view: "quality", force: true, signal: controller.signal, onProgress: (value) => progress.push(plain(value)) })
  await flush()
  assert.equal(r.requests.length, 1)
  assert.deepEqual(progress, [posted])
  const post = r.requests[0]
  assert.equal(post.options.method, "POST")
  assert.deepEqual(JSON.parse(post.options.body), { view: "quality", force: true })
  assert.equal(post.url.search, "")
  assert.equal(post.options.headers["Content-Type"], "application/json")
  await r.tick(999)
  assert.equal(r.requests.length, 1)
  await r.tick(1)
  assert.equal(r.requests.length, 2)
  assert.deepEqual(progress, [posted, running])
  await r.tick(1_000)
  assert.deepEqual(plain(await pending), finished)
  assert.deepEqual(progress, [posted, running, finished])
  assert.deepEqual(r.requests.map(({ options }) => options.method), ["POST", "GET", "GET"])
  assert.deepEqual(r.requests.map(({ at }) => at), [0, 1_000, 2_000])
  for (const { url, options } of r.requests) {
    assert.equal(url.pathname, "/api/refresh")
    assert.equal(url.origin, "https://relay.example.test")
    assert.equal(options.cache, "no-store")
    assert.equal(options.headers.Accept, "application/json")
    assert.equal(typeof options.signal.addEventListener, "function")
    if (options.method === "GET") {
      assert.equal(url.searchParams.get("view"), "quality")
      assert.equal(options.body, undefined)
    }
  }
  assert.equal(getEventListeners(controller.signal, "abort").length, 0)
  assert.equal(r.timers.size, 0)
})

test("初始全部 fresh、成功 cooldown 和无采集资源均直接复用，force 默认为 false", async () => {
  for (const groups of [
    ["logs", "errors", "httpErrors", "spend", "routes"].map((name) => group(name)),
    [group(), group("spend", { state: "cooldown", retry_at: 30_000 })],
    [],
  ]) {
    const result = payload(groups)
    const r = runtime({ responses: [result] })
    const progress = []
    assert.deepEqual(plain(await r.refresh({ onProgress: (value) => progress.push(plain(value)) })), result)
    assert.deepEqual(JSON.parse(r.requests[0].options.body), { view: "overview", force: false })
    assert.deepEqual(progress, [result])
    assert.equal(r.requests.length, 1)
    assert.equal(r.timers.size, 0)
  }
})

test("error、disabled、失败 cooldown 与空错误说明均抛出可见中文错误", async () => {
  for (const [state, error, expected] of [
    ["error", "上游服务拒绝请求", /采集失败.*上游服务拒绝请求/],
    ["error", null, /采集失败/],
    ["disabled", "采集进程未响应", /采集已禁用.*采集进程未响应/],
    ["cooldown", "余额查询失败", /采集失败，正在冷却.*余额查询失败/],
    ["cooldown", "", /采集失败，正在冷却/],
  ]) {
    const r = runtime({ responses: [payload([group(), group("spend", { state, error })])] })
    const progress = []
    await assert.rejects(r.refresh({ onProgress: (value) => progress.push(plain(value)) }), (failure) => {
      assert.equal(failure.name, "CollectionRefreshError")
      assert.equal(failure.code, "COLLECTION_FAILED")
      assert.match(failure.message, /余额与充值/)
      assert.match(failure.message, expected)
      return true
    })
    assert.equal(progress.length, 1)
    assert.equal(r.requests.length, 1)
    assert.equal(r.timers.size, 0)
  }
})

test("初始部分失败仍等待其他目标全部完成，最后汇总失败供 App 重读", async () => {
  for (const state of ["disabled", "error", "cooldown"]) {
    const failed = group("spend", { state, error: "余额采集失败" })
    const r = runtime({ responses: [
      payload([failed, queued(), queued("errors")]),
      payload([failed, group("logs", { request_id: 2, completed_id: 2 }), queued("errors", { state: "running" })]),
      payload([failed, group("logs", { request_id: 2, completed_id: 2 }), group("errors", { request_id: 2, completed_id: 2 })], "final"),
    ] })
    const progress = []
    let settled = false
    const pending = r.refresh({ onProgress: (value) => progress.push(plain(value)) })
    const rejected = assert.rejects(pending, /采集刷新失败.*余额采集失败/).then(() => { settled = true })
    await flush()
    assert.equal(settled, false)
    await r.tick(1_000)
    assert.equal(settled, false)
    assert.equal(r.requests.length, 2)
    await r.tick(1_000)
    await rejected
    assert.equal(settled, true)
    assert.equal(progress.at(-1).revision, "final")
    assert.equal(progress.at(-1).groups[2].completed_id, 2)
    assert.equal(r.requests.length, 3)
    assert.equal(r.timers.size, 0)
  }
})

test("轮询中失败也等待其余目标，并保留各资源失败说明", async () => {
  const r = runtime({ responses: [
    payload([queued(), queued("errors"), queued("routes")]),
    payload([group("logs", { request_id: 2, state: "error", error: "业务日志失败", completed_id: 2 }), queued("errors"), queued("routes")]),
    payload([group("logs", { request_id: 3, completed_id: 3 }), group("errors", { request_id: 2, state: "cooldown", error: "上游错误采集失败", completed_id: 2 }), queued("routes")]),
    payload([group("logs", { request_id: 3, completed_id: 3 }), group("errors", { request_id: 3, completed_id: 3 }), queued("routes", { state: "disabled", error: "渠道采集未响应" })]),
  ] })
  let settled = false
  const rejected = assert.rejects(r.refresh(), (error) => {
    assert.equal(error.code, "COLLECTION_FAILED")
    for (const detail of ["业务日志失败", "上游错误采集失败", "渠道采集未响应"]) assert.ok(error.message.includes(detail))
    return true
  }).then(() => { settled = true })
  await r.tick(2_000)
  assert.equal(settled, false)
  await r.tick(1_000)
  await rejected
  assert.equal(r.requests.length, 4)
  assert.equal(r.timers.size, 0)
})

test("后续请求 ID 增长、后续任务继续运行，不拖延本次 POST 的各目标", async () => {
  const r = runtime({ responses: [
    payload([queued("logs", { request_id: 7, completed_id: 6 }), queued("errors", { request_id: 3, completed_id: 2 }), group("routes")]),
    payload([queued("logs", { request_id: 8, completed_id: 7 }), queued("errors", { request_id: 4, completed_id: 2 }), queued("routes")]),
    payload([queued("logs", { state: "running", request_id: 10, completed_id: 9 }), queued("errors", { request_id: 5, completed_id: 3 }), queued("routes")], "our-targets-done"),
  ] })
  const pending = r.refresh()
  await r.tick(1_000)
  assert.equal(r.requests.length, 2)
  await r.tick(1_000)
  assert.equal((await pending).revision, "our-targets-done")
  assert.equal(r.requests.length, 3)
  assert.equal(r.timers.size, 0)
})

test("POST 与 GET 的 HTTP 错误保留 code、message、状态码，且不重试", async () => {
  for (const method of ["POST", "GET"]) {
    const failure = Response.json({ error: { code: "COLLECTOR_UNAVAILABLE", message: "采集服务暂不可用" } }, { status: 503 })
    const r = runtime({ responses: method === "POST" ? [failure] : [payload([queued()]), failure] })
    const rejected = assert.rejects(r.refresh(), (error) => {
      assert.equal(error.code, "COLLECTOR_UNAVAILABLE")
      assert.equal(error.status, 503)
      assert.match(error.message, /HTTP 503.*COLLECTOR_UNAVAILABLE.*采集服务暂不可用/)
      return true
    })
    if (method === "GET") await r.tick(1_000)
    await rejected
    assert.equal(r.requests.at(-1).options.method, method)
    assert.equal(r.requests.length, method === "POST" ? 1 : 2)
    assert.equal(r.timers.size, 0)
  }
})

test("网络异常与响应解析异常保持可见，非法协议不返回虚假成功", async () => {
  const cause = new Error("连接被重置")
  const network = runtime({ handler: () => { throw cause } })
  await assert.rejects(network.refresh(), (error) => {
    assert.equal(error.code, "NETWORK_ERROR")
    assert.equal(error.cause, cause)
    assert.match(error.message, /采集刷新请求失败.*连接被重置/)
    return true
  })
  for (const status of [200, 502]) {
    const r = runtime({ responses: [new Response("not json", { status })] })
    await assert.rejects(r.refresh(), (error) => {
      assert.equal(error.code, "INVALID_RESPONSE")
      assert.equal(error.status, status)
      assert.ok(error.cause)
      assert.match(error.message, /不是有效的 JSON/)
      return true
    })
    assert.equal(r.timers.size, 0)
  }
  for (const body of [{}, payload([group("unknown")]), payload([group(), group()]), payload([queued("logs", { request_id: null })])]) {
    const r = runtime({ responses: [body] })
    await assert.rejects(r.refresh(), /采集刷新响应格式错误/)
    assert.equal(r.timers.size, 0)
  }
  const missing = runtime({ responses: [payload([queued()]), payload([])] })
  const rejected = assert.rejects(missing.refresh(), /响应缺少数据源.*业务日志/)
  await missing.tick(1_000)
  await rejected
})

test("POST、GET 和响应体读取均在单次 15 秒超时并中止 HTTP", async () => {
  for (const phase of ["POST", "GET", "body"]) {
    const r = runtime({ handler: (_request, index) => {
      if (phase === "GET" && index === 0) return Response.json(payload([queued()]))
      if (phase === "body") return { ok: true, status: 200, json: never }
      return never()
    } })
    let settled = false
    const rejected = assert.rejects(r.refresh(), (error) => {
      assert.equal(error.code, "REQUEST_TIMEOUT")
      assert.match(error.message, /请求超时（15 秒）/)
      return true
    }).then(() => { settled = true })
    if (phase === "GET") await r.tick(1_000)
    await r.tick(14_999)
    assert.equal(settled, false)
    assert.equal(r.requests.at(-1).options.signal.aborted, false)
    await r.tick(1)
    await rejected
    assert.equal(r.requests.at(-1).options.signal.aborted, true)
    assert.equal(r.timers.size, 0)
  }
})

test("整体等待最多 120 秒，最后一条未满 15 秒的 HTTP 也被中止", async () => {
  const r = runtime({ handler: (request) => request.at >= 119_000 ? never() : Response.json(payload([queued()])) })
  const rejected = assert.rejects(r.refresh(), (error) => {
    assert.equal(error.code, "REFRESH_TIMEOUT")
    assert.match(error.message, /等待采集刷新超时（120 秒）/)
    return true
  })
  await r.tick(119_999)
  assert.equal(r.requests.at(-1).at, 119_000)
  assert.equal(r.requests.at(-1).options.signal.aborted, false)
  await r.tick(1)
  await rejected
  assert.equal(r.now(), 120_000)
  assert.equal(r.requests.length, 120)
  assert.equal(r.requests.at(-1).options.signal.aborted, true)
  assert.equal(r.timers.size, 0)
})

test("fetch、URL、now、wait 可独立注入，等待期限无需真实计时", async () => {
  const r = runtime({ href: null })
  const waits = []
  const requests = []
  await assert.rejects(r.refresh({ view: "页面 /?&" }, {
    url: new URL("https://injected.example.test/api/refresh?fixture=1&view=old"),
    fetch: async (url, options) => { requests.push({ url: String(url), options }); return Response.json(payload([queued()])) },
    now: r.now,
    wait: async (milliseconds, signal) => {
      assert.equal(signal.aborted, false)
      waits.push(milliseconds)
      r.setNow(r.now() + milliseconds)
    },
  }), /等待采集刷新超时（120 秒）/)
  assert.equal(r.requests.length, 0)
  assert.equal(requests.length, 120)
  assert.equal(waits.length, 120)
  assert.ok(waits.every((value) => value === 1_000))
  const last = new URL(requests.at(-1).url)
  assert.equal(last.searchParams.get("fixture"), "1")
  assert.deepEqual(last.searchParams.getAll("view"), ["页面 /?&"])
  assert.equal(r.timers.size, 0)
})

test("外部提前取消不发请求，不依赖 AbortSignal 静态 API", async () => {
  const r = runtime()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(r.refresh({ signal: controller.signal }), { name: "AbortError", message: "已取消采集刷新" })
  assert.equal(r.requests.length, 0)
  assert.equal(r.timers.size, 0)
  assert.equal(getEventListeners(controller.signal, "abort").length, 0)
})

test("外部取消中止 HTTP，不响应取消的 fetch 也不会阻塞或写回迟到进度", async () => {
  let release
  const held = new Promise((resolve) => { release = resolve })
  const r = runtime({ handler: () => held })
  const controller = new AbortController()
  const progress = []
  const rejected = assert.rejects(r.refresh({ signal: controller.signal, onProgress: (value) => progress.push(value) }), { name: "AbortError" })
  await flush()
  controller.abort(new Error("页面已切换"))
  await rejected
  assert.equal(r.requests[0].options.signal.aborted, true)
  assert.equal(r.timers.size, 0)
  release(Response.json(payload([group()])))
  await flush()
  assert.equal(progress.length, 0)
  assert.equal(r.requests.length, 1)
  assert.equal(getEventListeners(controller.signal, "abort").length, 0)
})

test("取消一秒轮询等待清理计时器，取消不响应 signal 的注入 wait 也及时返回", async () => {
  for (const customWait of [false, true]) {
    const r = runtime({ responses: [payload([queued()])] })
    const controller = new AbortController()
    let release
    const held = new Promise((resolve) => { release = resolve })
    const rejected = assert.rejects(r.refresh({ signal: controller.signal }, customWait ? { wait: () => held } : {}), {
      name: "AbortError", message: "已取消采集刷新",
    })
    await flush()
    assert.equal(r.requests.length, 1)
    controller.abort()
    await rejected
    assert.equal(r.timers.size, 0)
    release()
    await r.tick(2_000)
    assert.equal(r.requests.length, 1)
    assert.equal(getEventListeners(controller.signal, "abort").length, 0)
  }
})

test("onProgress 内取消或抛错保持可见，均不继续轮询", async () => {
  const canceled = runtime({ responses: [payload([group()])] })
  const controller = new AbortController()
  await assert.rejects(canceled.refresh({ signal: controller.signal, onProgress: () => controller.abort() }), { name: "AbortError" })
  const callbackError = new Error("进度回调失败")
  const broken = runtime({ responses: [payload([queued()])] })
  await assert.rejects(broken.refresh({ onProgress: () => { throw callbackError } }), (error) => error === callbackError)
  assert.equal(canceled.requests.length, 1)
  assert.equal(broken.requests.length, 1)
  assert.equal(canceled.timers.size + broken.timers.size, 0)
})

test("开发、预览、生产默认 URL 均与页面同源，无 window 时可用相对路径", async () => {
  for (const href of ["http://localhost:5173/", "http://127.0.0.1:4173/", "https://relay.example.test/app", null]) {
    const r = runtime({ href, responses: [payload([group()])] })
    await r.refresh()
    assert.equal(r.requests[0].input, href ? `${new URL(href).origin}/api/refresh` : "/api/refresh")
    assert.equal(r.timers.size, 0)
  }
})
