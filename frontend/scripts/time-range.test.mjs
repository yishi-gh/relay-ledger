import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import vm from "node:vm"
import test from "node:test"

const require = createRequire(import.meta.url)
const ts = require("typescript")
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const HOUR = 3600000
const DAY = 24 * HOUR
const NOW = Date.parse("2026-11-11T02:23:00Z")
const MAX_T = Date.parse("2026-11-10T15:30:00Z")
const PREFERENCES = "relay-ledger:preferences:v1"
const LAST_RANGE = "relay-ledger:last-range"
const plain = (value) => JSON.parse(JSON.stringify(value))

function deferred() {
  let resolvePromise
  const promise = new Promise((resolve) => { resolvePromise = resolve })
  return { promise, resolve: resolvePromise }
}

function profitFixture(range, granularity) {
  return {
    ...range, granularity,
    buckets: [
      { label: granularity === "hour" ? "2026-11-11 08:00" : "2026-11-10" },
      { label: granularity === "hour" ? "2026-11-11 09:00" : "2026-11-11" },
    ],
    sites: [
      { account_id: "a", name: "A", revenue: 30, cost: 4 },
      { account_id: "b", name: "B", revenue: 130, cost: 9 },
      { account_id: "ext", name: "外部", kind: "external", revenue: 1400, cost: 0 },
    ],
    series: {
      revenue_by_site: { a: [10, 20], b: [100, 30], ext: [700, 700] },
      cost_by_site: { a: [4, null], b: [null, 9], ext: [0, 0] },
    },
    quality: { accounts_missing_balance: ["b"] },
    unmapped: { revenue: 5 },
  }
}

/** 编译并执行真实 TS 模块；仅隔离 UI 组件与 React hooks，不复制业务实现。 */
function runtime({ stored = {}, defaultRange, href = "http://localhost/?view=overview", metaMaxT = MAX_T } = {}) {
  let now = NOW
  const storage = new Map(Object.entries(stored))
  const storageReads = new Map()
  if (defaultRange) {
    const defaults = JSON.parse(readFileSync(resolve(root, "../shared/settings-defaults.json"), "utf8"))
    storage.set(PREFERENCES, JSON.stringify({ display: defaults.display, refresh: { ...defaults.refresh, defaultRange } }))
  }
  const requests = []
  const failures = new Set()
  const held = new Map()
  const timers = new Map()
  const windowListeners = new Map()
  const documentListeners = new Map()
  const historyCalls = []
  const window = {
    location: new URL(href),
    localStorage: {
      getItem(key) { storageReads.set(key, (storageReads.get(key) ?? 0) + 1); return storage.get(key) ?? null },
      setItem(key, value) { storage.set(key, value) },
    },
    addEventListener(name, fn) { windowListeners.set(name, fn) },
    removeEventListener(name) { windowListeners.delete(name) },
    setTimeout(callback, delay) { const id = timers.size + 1; timers.set(id, { callback, delay }); return id },
    clearTimeout(id) { timers.delete(id) },
    history: { state: { existing: true }, ...Object.fromEntries(["pushState", "replaceState"].map((method) => [method, (state, title, url) => {
      historyCalls.push({ method, state, url })
      window.location = new URL(url, window.location)
    }])) },
  }
  const document = {
    hidden: false,
    addEventListener(name, fn) { documentListeners.set(name, fn) },
    removeEventListener(name) { documentListeners.delete(name) },
  }
  const slots = []
  let hookIndex = 0
  let effects = []
  let dirty = true
  let tree
  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  const react = {
    useState(initial) {
      const index = hookIndex++
      if (!slots[index]) slots[index] = { value: typeof initial === "function" ? initial() : initial }
      return [slots[index].value, (next) => {
        const value = typeof next === "function" ? next(slots[index].value) : next
        if (!Object.is(value, slots[index].value)) { slots[index].value = value; dirty = true }
      }]
    },
    useRef(initial) {
      const index = hookIndex++
      return slots[index] ??= { current: initial }
    },
    useMemo(callback, deps) {
      const index = hookIndex++
      if (!slots[index] || !sameDeps(slots[index].deps, deps)) slots[index] = { value: callback(), deps }
      return slots[index].value
    },
    useCallback(callback, deps) { return react.useMemo(() => callback, deps) },
    useEffect(callback, deps) {
      const index = hookIndex++
      if (!slots[index] || !sameDeps(slots[index].deps, deps)) {
        effects.push(() => {
          slots[index]?.cleanup?.()
          slots[index] = { deps, cleanup: callback() }
        })
      }
    },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
  }
  const jsx = (type, props) => ({ type, props })
  const ui = new Proxy({}, { get: (_target, key) => key === "__esModule" ? true : String(key) })
  const context = vm.createContext({
    console, window, document, URL, URLSearchParams, AbortController,
    Date: class extends Date { static now() { return now } },
    fetch: async (input, options) => {
      const url = new URL(input)
      requests.push({ url, options })
      if (url.pathname === "/api/meta") return Response.json({ max_t: metaMaxT, rows: 10 })
      const range = { from: Number(url.searchParams.get("from")), to: Number(url.searchParams.get("to")) }
      if (url.pathname === "/api/overview") await held.get(range.from)?.promise
      if (failures.has(url.pathname)) return Response.json({ error: { message: `fixture ${url.pathname}` } }, { status: 503 })
      const granularity = url.searchParams.get("granularity") ?? "hour"
      const bodies = {
        "/api/overview": { range, revenue: 1000, requests: 500, tokens: { total: 900 }, cache_rate: 0.4 },
        "/api/trend": { granularity, points: [{ bucket: "2026-11-11 08:00", requests: 7, tokens: 70, cache_rate: 0.5 }] },
        "/api/profit": profitFixture(range, granularity),
        "/api/channels": { rows: [{ id: 1, name: "渠道" }] },
        "/api/groups": { groups: [{ group: "g" }] },
        "/api/users": { users: [{ id: 1, revenue: 30 }], total_revenue: 100 },
        "/api/upstreams": { accounts: [{ account_id: "a", name: "A" }] },
        "/api/quality": { source_last_t: metaMaxT, schema_ok: true },
        "/api/capital": { range, accounts: [{ account_id: "a", balance: 42 }], total: { balance: 42 } },
        "/api/services": { ...range, bucket_ms: DAY, services: [] },
      }
      assert.ok(Object.hasOwn(bodies, url.pathname), `未约定的全局接口 ${url.pathname}`)
      return Response.json(bodies[url.pathname])
    },
  })
  const modules = new Map()
  function load(path) {
    const file = resolve(root, path)
    if (modules.has(file)) return modules.get(file).exports
    const module = { exports: {} }
    modules.set(file, module)
    if (file.endsWith(".json")) { module.exports = JSON.parse(readFileSync(file, "utf8")); return module.exports }
    const source = readFileSync(file, "utf8").replaceAll("import.meta.env.DEV", "false")
    const output = ts.transpileModule(source, {
      fileName: file,
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    }).outputText
    const localRequire = (name) => {
      if (name === "react") return react
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" }
      if (name === "lucide-react" || name.startsWith("@/components/")) return ui
      const target = name.startsWith("@/") ? resolve(root, "src", name.slice(2)) : resolve(dirname(file), name)
      return load(target.endsWith(".json") ? target : `${target}.ts`)
    }
    vm.runInContext(`(function(require,module,exports){${output}\n})`, context, { filename: file })(localRequire, module, module.exports)
    return module.exports
  }
  function render() {
    const { App } = load("src/App.tsx")
    let runs = 0
    do {
      assert.ok(++runs < 20, "App 不应发生无限重渲染")
      dirty = false
      hookIndex = 0
      effects = []
      tree = App()
      for (const effect of effects) effect()
    } while (dirty)
    return tree
  }
  function find(type) {
    function visit(node) {
      if (!node || typeof node !== "object") return null
      if (node.type === type) return node.props
      for (const child of [node.props?.children].flat(Infinity)) {
        const found = visit(child)
        if (found) return found
      }
      return null
    }
    return visit(tree)
  }
  async function settle() {
    await new Promise(setImmediate)
    render()
    await new Promise(setImmediate)
    return render()
  }
  return { load, requests, failures, held, storage, storageReads, historyCalls, window, timers, render, find, settle, setNow(value) { now = value } }
}

test("北京时间输入与范围不依赖 OS 时区，保留旧 24h/7d 锚点", () => {
  const { load } = runtime()
  const time = load("src/lib/time-range.ts")
  const api = load("src/lib/api.ts")
  const oldTZ = process.env.TZ
  try {
    for (const tz of ["UTC", "America/Los_Angeles", "Asia/Shanghai"]) {
      process.env.TZ = tz
      assert.equal(time.parseBeijingDateTime("2024-02-29T08:05"), Date.parse("2024-02-29T00:05:00Z"))
      assert.equal(time.formatBeijingDateTimeInput(NOW), "2026-11-11T10:23")
    }
  } finally {
    if (oldTZ === undefined) delete process.env.TZ
    else process.env.TZ = oldTZ
  }
  for (const input of ["2026-02-29T12:00", "2026-11-31T12:00", "2026-11-11T24:00", "2026-11-11T10:60", "2026-11-11"]) {
    assert.throws(() => time.parseBeijingDateTime(input))
  }
  const meta = { max_t: MAX_T }
  assert.deepEqual(plain(api.computeRange(meta, "24h", undefined, NOW)), { from: Date.parse("2026-11-09T16:00:00Z"), to: MAX_T })
  assert.deepEqual(plain(api.computeRange(meta, "7d", undefined, NOW)), { from: Date.parse("2026-11-03T16:00:00Z"), to: MAX_T })
  assert.deepEqual(plain(api.computeRange(meta, "today", undefined, NOW)), { from: Date.parse("2026-11-10T16:00:00Z"), to: NOW })
  assert.equal(api.computeRange({ max_t: null }, "today", undefined, NOW).to, NOW)
  const atMidnight = Date.parse("2026-11-11T16:00:00Z")
  assert.equal(api.computeRange(meta, "today", undefined, atMidnight).from, atMidnight)
})

test("自定义校验覆盖顺序、31 天上限、未来时间和 36 小时粒度边界", () => {
  const time = runtime().load("src/lib/time-range.ts")
  assert.deepEqual(plain(time.validateCustomRange({ from: NOW - 31 * DAY, to: NOW }, NOW)), { from: NOW - 31 * DAY, to: NOW })
  for (const range of [null, { from: NaN, to: NOW }, { from: NOW, to: NOW }, { from: NOW - 31 * DAY - 1, to: NOW }, { from: NOW, to: NOW + 60001 }]) {
    assert.throws(() => time.validateCustomRange(range, NOW))
  }
  assert.equal(time.validateCustomRange({ from: NOW - HOUR, to: NOW + 60000 }, NOW).to, NOW + 60000)
  assert.equal(time.getRangeGranularity("custom", { from: NOW - 36 * HOUR, to: NOW }), "hour")
  assert.equal(time.getRangeGranularity("custom", { from: NOW - 36 * HOUR - 1, to: NOW }), "day")
  assert.equal(time.getRangeGranularity("today", { from: NOW - DAY, to: NOW }), "hour")
  assert.equal(time.getRangeGranularity("7d", { from: NOW - HOUR, to: NOW }), "day")
})

test("loadDashboard 实际请求保持九路并行，今日查真实当天，失败接口可见", async () => {
  const r = runtime({ metaMaxT: null })
  const api = r.load("src/lib/api.ts")
  const from = Date.parse("2026-11-10T16:00:00Z")
  const gate = deferred()
  r.held.set(from, gate)
  r.failures.add("/api/profit")
  r.failures.add("/api/capital")
  const pending = api.loadDashboard("today", undefined, NOW)
  await new Promise(setImmediate)
  assert.equal(r.requests.length, 10)
  assert.equal(r.requests.filter(({ url }) => url.pathname === "/api/models").length, 0)
  for (const { url } of r.requests.filter(({ url }) => !["/api/meta", "/api/quality"].includes(url.pathname))) {
    assert.equal(Number(url.searchParams.get("from")), from)
    assert.equal(Number(url.searchParams.get("to")), NOW)
  }
  assert.equal(r.requests.find(({ url }) => url.pathname === "/api/trend").url.searchParams.get("granularity"), "hour")
  gate.resolve()
  const dashboard = await pending
  assert.deepEqual(plain(dashboard.errors), ["profit", "capital"])
  assert.equal(dashboard.users.users[0].share, 0.3)
  const chart = r.load("src/lib/dashboard-data.ts").buildTrafficChartData(dashboard.trend, dashboard.range)
  assert.equal(chart.length, 11)
  assert.equal(chart[0].fullLabel, "2026-11-11 00:00")
  assert.equal(chart[8].requests, 7)
  assert.equal(chart[10].requests, 0)
})

test("实际自定义/旧窗口请求粒度、服务查询和盈利金额一致", async () => {
  const r = runtime()
  const api = r.load("src/lib/api.ts")
  const data = r.load("src/lib/dashboard-data.ts")
  for (const [type, custom, granularity] of [
    ["24h", undefined, "hour"], ["7d", undefined, "day"],
    ["custom", { from: NOW - HOUR, to: NOW }, "hour"],
    ["custom", { from: NOW - 3 * DAY, to: NOW }, "day"],
  ]) {
    const result = await api.loadDashboard(type, custom, NOW)
    assert.equal(result.profit.granularity, granularity)
    assert.deepEqual(plain(data.aggregateProfitBuckets(result.profit).totals), {
      revenue: 40, cost: 13, profit: 27, margin: 27 / 40, coveredBuckets: 2, bucketCount: 2,
    })
    assert.equal(data.aggregateProfitBuckets(result.profit).rows[0].label, granularity === "hour" ? "08:00" : "11-10")
    if (custom) assert.deepEqual(plain(result.range), custom)
  }
  await api.fetchServices("24h")
  assert.equal(r.requests.at(-1).url.search, "?range=24h")
  await api.fetchServices("7d")
  assert.equal(r.requests.at(-1).url.search, "?range=7d")
  const selected = { from: NOW - HOUR, to: NOW }
  const services = await api.fetchServices("custom", { dateRange: selected })
  assert.equal(services.bucket_ms, DAY)
  assert.equal(r.requests.at(-1).url.searchParams.get("range"), null)
  assert.equal(Number(r.requests.at(-1).url.searchParams.get("from")), selected.from)
  const before = r.requests.length
  await assert.rejects(api.loadDashboard("custom"), /自定义时间范围/)
  await assert.rejects(api.fetchServices("custom"), /自定义时间范围/)
  assert.equal(r.requests.length, before)
  const missing = profitFixture(selected, "hour")
  missing.series.cost_by_site = {}
  assert.equal(data.aggregateProfitBuckets(missing).totals, null)
  assert.equal(data.aggregateProfitBuckets(missing).rows[0].profit, null)
  const denseDays = data.buildTrafficChartData({ granularity: "day", points: [] }, { from: NOW - 2 * DAY, to: NOW })
  assert.deepEqual(plain(denseDays.map((row) => row.fullLabel)), ["2026-11-09", "2026-11-10", "2026-11-11"])
})

test("remember 兼容旧值，自定义完整保存且一次读取，损坏值回退并显示错误", () => {
  for (const value of ["24h", "7d", "today"]) {
    const r = runtime({ defaultRange: "remember", stored: { [LAST_RANGE]: value } })
    const settings = r.load("src/lib/settings.ts")
    assert.equal(settings.getInitialTimeRange(), value)
    assert.equal(settings.getInitialCustomRange(), null)
    assert.equal(r.storageReads.get(LAST_RANGE), 1)
  }
  const custom = { from: NOW - DAY, to: NOW }
  const r = runtime({ defaultRange: "remember", stored: { [LAST_RANGE]: JSON.stringify({ type: "custom", ...custom }) } })
  const settings = r.load("src/lib/settings.ts")
  assert.equal(settings.getInitialTimeRange(), "custom")
  assert.deepEqual(plain(settings.getInitialCustomRange()), custom)
  settings.rememberTimeRange("custom", custom)
  assert.deepEqual(JSON.parse(r.storage.get(LAST_RANGE)), { type: "custom", ...custom })
  assert.equal(r.storageReads.get(LAST_RANGE), 1)
  assert.throws(() => settings.validatePreferences({ ...plain(settings.getPreferences()), refresh: { ...settings.getPreferences().refresh, defaultRange: "custom" } }))
  assert.equal(runtime({ defaultRange: "today" }).load("src/lib/settings.ts").getInitialTimeRange(), "today")
  for (const bad of ["garbage", JSON.stringify({ type: "custom", from: NOW, to: NOW }), JSON.stringify({ type: "custom", from: 0, to: NOW })]) {
    const broken = runtime({ defaultRange: "remember", stored: { [LAST_RANGE]: bad } })
    const store = broken.load("src/lib/settings.ts")
    assert.equal(store.getInitialTimeRange(), "24h")
    assert.equal(store.getInitialCustomRange(), null)
    assert.match(store.useSettings().timeRangeError, /已恢复近 24 小时/)
  }
})

test("真实 App 拒绝旧请求写回，自定义同类型切换清窗，刷新保持起止", async () => {
  const r = runtime()
  r.render()
  await r.settle()
  assert.equal(r.find("OverviewView").kpiData.revenue, 1565)
  assert.equal(r.find("OverviewView").kpiData.requests, 7)
  const a = { from: NOW - 2 * HOUR, to: NOW - HOUR }
  const b = { from: NOW - 4 * HOUR, to: NOW - 3 * HOUR }
  const gateA = deferred()
  const gateB = deferred()
  r.held.set(a.from, gateA)
  r.held.set(b.from, gateB)
  r.find("TopBar").onTimeRangeChange("custom", a)
  r.render()
  assert.equal(r.find("OverviewView"), null)
  await r.settle()
  r.find("TopBar").onTimeRangeChange("custom", b)
  r.render()
  await r.settle()
  gateA.resolve()
  await r.settle()
  assert.equal(r.find("OverviewView"), null)
  assert.equal(r.find("TopBar").refreshing, true)
  gateB.resolve()
  await r.settle()
  assert.equal(r.find("OverviewView").profitData.from, b.from)
  assert.equal(r.find("TopBar").refreshing, false)
  r.setNow(NOW + 5 * HOUR)
  r.find("TopBar").onRefresh()
  await r.settle()
  assert.equal(r.find("OverviewView").profitData.from, b.from)
  assert.equal(r.find("OverviewView").profitData.to, b.to)
  const beforeInvalid = r.requests.length
  r.find("TopBar").onTimeRangeChange("custom")
  r.render()
  assert.equal(r.requests.length, beforeInvalid)
  assert.equal(r.find("AlertTitle").children, "时间范围异常")
  r.find("TopBar").onTimeRangeChange("7d")
  await r.settle()
  assert.equal(r.find("OverviewView").kpiData.revenue, 1000)
  assert.equal(r.find("OverviewView").kpiData.requests, 500)
})

test("真实 App 今日手动与自动刷新重算 now，资本旧入口 replace 并保留参数与 hash", async () => {
  const r = runtime({ defaultRange: "today", href: "http://localhost/?view=capital&preview=1&keep=yes#account" })
  r.render()
  await r.settle()
  assert.equal(r.find("AppSidebar").currentView, "upstreams")
  assert.equal(r.historyCalls.length, 1)
  assert.equal(r.historyCalls[0].method, "replaceState")
  assert.deepEqual(r.historyCalls[0].state, { existing: true })
  assert.equal(r.window.location.searchParams.get("preview"), "1")
  assert.equal(r.window.location.searchParams.get("keep"), "yes")
  assert.equal(r.window.location.hash, "#account")
  const upstreams = r.find("UpstreamsView")
  assert.equal(upstreams.capital.total.balance, 42)
  assert.equal(upstreams.profitSites.length, 3)
  assert.equal(upstreams.dateRange.to, NOW)
  r.setNow(NOW + HOUR)
  r.find("TopBar").onRefresh()
  await r.settle()
  assert.equal(r.find("UpstreamsView").dateRange.to, NOW + HOUR)
  r.setNow(NOW + 2 * HOUR)
  const timer = [...r.timers.values()][0]
  assert.ok(timer)
  timer.callback()
  await r.settle()
  assert.equal(r.find("UpstreamsView").dateRange.to, NOW + 2 * HOUR)
  r.find("AppSidebar").onSelectView("rank")
  r.render()
  assert.equal(r.find("RankView").dateRange.to, NOW + 2 * HOUR)
  assert.equal(r.find("RankView").profitSites.length, 3)
  assert.equal(r.requests.filter(({ url }) => url.pathname === "/api/models").length, 0)
})

test("损坏的自定义记忆只发送 24h 请求，错误在 App 可见", async () => {
  const r = runtime({ defaultRange: "remember", stored: { [LAST_RANGE]: '{"type":"custom","from":10}' } })
  r.render()
  await r.settle()
  assert.equal(r.find("TopBar").timeRange, "24h")
  assert.match(r.find("AlertDescription").children, /已恢复近 24 小时/)
  assert.equal(r.find("OverviewView").profitData.to, MAX_T)
})
