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
const settingsStub = {
  getPreferences: () => ({
    display: { unitSystem: "zh", currencyDecimals: 2, tokenDecimals: 2, percentDecimals: 2 },
  }),
}

/** 用真实 TS 源码验证格式与 URL，不做业务逻辑复制。 */
function runtime({ stubs = {}, globals = {} } = {}) {
  const context = vm.createContext({
    console, Date, URL, URLSearchParams, AbortController, Response, ...globals,
  })
  const modules = new Map()
  function load(file) {
    if (modules.has(file)) return modules.get(file).exports
    const module = { exports: {} }
    modules.set(file, module)
    if (file.endsWith(".json")) {
      module.exports = JSON.parse(readFileSync(file, "utf8"))
      return module.exports
    }
    const source = readFileSync(file, "utf8")
    const output = ts.transpileModule(source, {
      fileName: file,
      compilerOptions: {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
      },
    }).outputText
    const localRequire = (name) => {
      if (Object.hasOwn(stubs, name)) return stubs[name]
      const target = name.startsWith("@/") ? resolve(root, "src", name.slice(2)) : resolve(dirname(file), name)
      return load(target.endsWith(".json") ? target : `${target}.ts`)
    }
    vm.runInContext(`(function(require,module,exports){${output}\n})`, context, { filename: file })(localRequire, module, module.exports)
    return module.exports
  }
  return (path) => load(resolve(root, path))
}

test("北京时间格式器跨系统时区稳定，空值语义保持 —", () => {
  const load = runtime({ stubs: { "./settings": settingsStub } })
  const fmt = load("src/lib/formatters.ts")
  const midnight = Date.parse("2026-11-10T16:00:00Z")
  const afternoon = Date.parse("2026-03-08T07:05:00Z")
  const oldTZ = process.env.TZ
  try {
    for (const tz of ["UTC", "America/Los_Angeles", "Asia/Shanghai", "Pacific/Kiritimati"]) {
      process.env.TZ = tz
      assert.equal(fmt.formatBeijingTime(midnight), "2026-11-11 00:00")
      assert.equal(fmt.formatTimestamp(midnight), "2026-11-11 00:00")
      assert.equal(fmt.formatBeijingShort(midnight), "11-11 00:00")
      assert.equal(fmt.formatTimestampShort(midnight), "11-11 00:00")
      assert.equal(fmt.formatBeijingDate(midnight), "11-11")
      assert.equal(fmt.formatBeijingClock(midnight), "00:00")
      assert.equal(fmt.formatBeijingClock(midnight + 65000, true), "00:01:05")
      assert.equal(fmt.formatBeijingTime(midnight + 86399999), "2026-11-11 23:59")
      assert.equal(fmt.formatBeijingTime(afternoon), "2026-03-08 15:05")
    }
  } finally {
    if (oldTZ === undefined) delete process.env.TZ
    else process.env.TZ = oldTZ
  }
  assert.equal(fmt.formatBeijingTime(null), "—")
  assert.equal(fmt.formatBeijingTime(0), "—")
  assert.equal(fmt.formatTimestampShort(undefined), "—")
})

test("浏览器请求始终同源，非浏览器回退本机后端", async () => {
  for (const [href, origin] of [
    ["http://localhost:5173/?view=overview", "http://localhost:5173"],
    ["http://localhost:5178/", "http://localhost:5178"],
    ["http://127.0.0.1:4173/", "http://127.0.0.1:4173"],
    ["https://relay.example.com/app", "https://relay.example.com"],
  ]) {
    const requests = []
    const load = runtime({
      globals: {
        window: { location: new URL(href) },
        fetch: async (url) => {
          requests.push(String(url))
          return Response.json({ ok: true })
        },
      },
    })
    const api = load("src/lib/api.ts")
    assert.equal(api.getApiBaseUrl(), origin)
    await api.fetchJson("/api/meta")
    assert.equal(requests[0], `${origin}/api/meta`)
  }

  const load = runtime()
  assert.equal(load("src/lib/api.ts").getApiBaseUrl(), "http://127.0.0.1:8788")
})
