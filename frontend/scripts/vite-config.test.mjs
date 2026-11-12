import assert from "node:assert/strict"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { loadConfigFromFile } from "vite"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")

test("dev 与 preview 的 /api 代理指向本机后端并保留原始 Host/Origin", async () => {
  const result = await loadConfigFromFile({ command: "serve", mode: "development" }, resolve(root, "vite.config.ts"))
  assert.ok(result, "vite 配置应能加载")
  for (const name of ["server", "preview"]) {
    const proxy = result.config[name]?.proxy?.["/api"]
    assert.ok(proxy, `${name}.proxy['/api'] 应存在`)
    assert.equal(proxy.target, "http://127.0.0.1:8788")
    // changeOrigin=true 会把 Host 改成后端地址，Origin 与 Host 不再一致，PATCH 会被后端拒绝。
    assert.equal(proxy.changeOrigin, false)
  }
})
