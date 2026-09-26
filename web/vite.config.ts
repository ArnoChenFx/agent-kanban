import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// 构建产物直接落在 web/dist，由 `kanban serve` 托管（src/server/http.ts 的 serveStatic）
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  build: {
    // 单页应用：保留目录结构，server 侧做 SPA 回退
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // 开发时把 API 与 SSE 代理到本地 kanban server，免去跨域配置
    proxy: {
      "/api": {
        target: "http://127.0.0.1:7788",
        changeOrigin: true,
      },
    },
  },
})
