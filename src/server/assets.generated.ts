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

import a0_assets_geist_cyrillic_ext_wght_normal_DjL33_gN_woff2 from "../../web/dist/assets/geist-cyrillic-ext-wght-normal-DjL33-gN.woff2" with { type: "file" }
import a1_assets_geist_cyrillic_wght_normal_BEAKL7Jp_woff2 from "../../web/dist/assets/geist-cyrillic-wght-normal-BEAKL7Jp.woff2" with { type: "file" }
import a2_assets_geist_latin_ext_wght_normal_DC_KSUi6_woff2 from "../../web/dist/assets/geist-latin-ext-wght-normal-DC-KSUi6.woff2" with { type: "file" }
import a3_assets_geist_latin_wght_normal_BgDaEnEv_woff2 from "../../web/dist/assets/geist-latin-wght-normal-BgDaEnEv.woff2" with { type: "file" }
import a4_assets_geist_vietnamese_wght_normal_6IgcOCM7_woff2 from "../../web/dist/assets/geist-vietnamese-wght-normal-6IgcOCM7.woff2" with { type: "file" }
import a5_assets_index_8RvhIDBp_js from "../../web/dist/assets/index-8RvhIDBp.js" with { type: "file" }
import a6_assets_index_Do_OhEWj_css from "../../web/dist/assets/index-Do-OhEWj.css" with { type: "file" }
import a7_favicon_svg from "../../web/dist/favicon.svg" with { type: "file" }
import a8_icons_svg from "../../web/dist/icons.svg" with { type: "file" }
import a9_index_html from "../../web/dist/index.html" with { type: "file" }

/** 内嵌的前端资源：键是相对 web/dist 的路径 */
export const EMBEDDED_ASSETS: EmbeddedAssetMap = {
  "assets/geist-cyrillic-ext-wght-normal-DjL33-gN.woff2": () => Bun.file(a0_assets_geist_cyrillic_ext_wght_normal_DjL33_gN_woff2 as unknown as string),
  "assets/geist-cyrillic-wght-normal-BEAKL7Jp.woff2": () => Bun.file(a1_assets_geist_cyrillic_wght_normal_BEAKL7Jp_woff2 as unknown as string),
  "assets/geist-latin-ext-wght-normal-DC-KSUi6.woff2": () => Bun.file(a2_assets_geist_latin_ext_wght_normal_DC_KSUi6_woff2 as unknown as string),
  "assets/geist-latin-wght-normal-BgDaEnEv.woff2": () => Bun.file(a3_assets_geist_latin_wght_normal_BgDaEnEv_woff2 as unknown as string),
  "assets/geist-vietnamese-wght-normal-6IgcOCM7.woff2": () => Bun.file(a4_assets_geist_vietnamese_wght_normal_6IgcOCM7_woff2 as unknown as string),
  "assets/index-8RvhIDBp.js": () => Bun.file(a5_assets_index_8RvhIDBp_js as unknown as string),
  "assets/index-Do-OhEWj.css": () => Bun.file(a6_assets_index_Do_OhEWj_css as unknown as string),
  "favicon.svg": () => Bun.file(a7_favicon_svg as unknown as string),
  "icons.svg": () => Bun.file(a8_icons_svg as unknown as string),
  "index.html": () => Bun.file(a9_index_html as unknown as string),
}

/** 内嵌资源数量与总字节（启动日志与 doctor 会显示） */
export const EMBEDDED_COUNT = 10
export const EMBEDDED_BYTES = 746334
