/**
 * 自动生成，**请勿手改**。
 * 由 `bun run gen:assets` 从 web/dist 扫描产出。
 * 改动请改生成脚本：scripts/gen-assets.ts
 *
 * 作用：把前端产物声明为 Bun embedded files，
 * 让 `bun build --compile` 能把它们打进单文件二进制。
 *
 * ⚠ 仓库里提交的是**空表占位**形态，因为 http.ts 静态 import 本文件，
 *   而干净 checkout（CI、新机器）时还没有 web/dist。少这个文件，
 *   `tsc --noEmit` 会直接报 TS2307。`bun run web:build` 会把它覆盖成真实清单。
 */

/**
 * 相对 web/dist 的路径 → 读取函数。
 *
 * 返回 `BunFile` 而非 Blob：它可以直接当 `Response` 的 body，
 * 且对内嵌资源同样有效（embedded 引用与文件路径对 Bun.file 是同一套接口）。
 * 用 `ReturnType<typeof Bun.file>` 而不是 `BunFile`，免得依赖全局类型名。
 */
export type EmbeddedAssetMap = Record<string, () => ReturnType<typeof Bun.file>>

/**
 * 内嵌的前端资源。
 *
 * 空表 = 仓库里还没有构建过前端（这是提交到 git 的形态）。
 * 执行 `bun run web:build`（会自动接着跑 gen:assets）后重新生成本文件。
 * 此时 server 会退回磁盘查找（KANBAN_WEB_DIR 或包根下的 web/dist），再退到占位页。
 */
export const EMBEDDED_ASSETS: EmbeddedAssetMap = {}

/** 内嵌资源数量与总字节（启动日志会显示） */
export const EMBEDDED_COUNT = 0
export const EMBEDDED_BYTES = 0
