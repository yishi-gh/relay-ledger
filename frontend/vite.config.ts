import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const API_TARGET = "http://127.0.0.1:8788"

// /api 同源代理：保留浏览器原始 Host/Origin，后端 PATCH 的同源校验才能继续通过。
const apiProxy = {
  "/api": {
    target: API_TARGET,
    changeOrigin: false,
  },
}

// https://vite.dev/config/
export default defineConfig({
  // 生产挂在站点根路径；静态资源用绝对路径 /assets/...
  base: "/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    proxy: apiProxy,
  },
  preview: {
    proxy: apiProxy,
  },
})
