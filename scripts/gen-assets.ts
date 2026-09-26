/**
 * 生成前端资源的 embedded manifest。
 *
 * ## 为什么需要这一步
 *
 * 目标：让 `bun build --compile` 产出的单文件二进制**自带整个 Web 看板**，
 * 下载即用，不需要旁边再放一个 web/dist 目录。
 *
 * Bun 的 embedded files（`with { type: "file" }`）有两个限制：
 *   1. import 路径必须是**静态字面量**，不能是变量或 glob 通配
 *      （写成 glob 在 `bun run` 下不展开，会直接报语法错）
 *   2. Vite 产出的文件名带内容哈希（`assets/index-a1b2c3.js`），
 *      构建前根本不知道叫什么
 *
 * 所以做法是：构建完扫描 dist，生成一个写死路径的 manifest 模块，
 * 编译时这些 import 就都是静态的，文件被一并嵌进二进制。
 *
 * ## 用法
 *
 *   bun run web:build     # 产出 web/dist
 *   bun run gen:assets    # 扫 dist → 写 src/server/assets.generated.ts
 *   bun build --compile src/cli.ts --outfile kanban
 *
 * ## 仓库里为什么放了一个占位文件
 *
 * 新 clone 还没 build 前就跑 `bun run src/cli.ts` 是常见操作，
 * 那时 dist 不存在。占位文件让 import 不会失败，只是没有任何内嵌资源，
 * server 会退回磁盘查找（找不到就显示带构建指引的占位页）。
 */

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, posix, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const DIST = join(ROOT, "web", "dist");
const OUT = join(ROOT, "src", "server", "assets.generated.ts");

/** 递归收集 dist 下的所有文件（排除 sourcemap 之类纯调试产物） */
function collect(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collect(full, base));
    } else {
      // .map 体积大且对运行时无用，嵌进去只会让二进制白白变大
      if (entry.endsWith(".map")) continue;
      out.push(full);
    }
  }
  return out;
}

/** 文件头（注释 + 类型定义），两种产物共用 */
const HEADER = `/**
 * 自动生成，**请勿手改**。
 * 由 \`bun run gen:assets\` 从 web/dist 扫描产出。
 * 改动请改生成脚本：scripts/gen-assets.ts
 *
 * 作用：把前端产物声明为 Bun embedded files，
 * 让 \`bun build --compile\` 能把它们打进单文件二进制。
 */

/**
 * 相对 web/dist 的路径 → 读取函数。
 *
 * 返回 \`BunFile\` 而非 Blob：它可以直接当 \`Response\` 的 body，
 * 且对内嵌资源同样有效（embedded 引用与文件路径对 Bun.file 是同一套接口）。
 * 用 \`ReturnType<typeof Bun.file>\` 而不是 \`BunFile\`，免得依赖全局类型名。
 */
export type EmbeddedAssetMap = Record<string, () => ReturnType<typeof Bun.file>>
`

/** 没有前端产物时的占位内容（仍在仓库里，保证新 clone 就能 import） */
const PLACEHOLDER = `
/**
 * 内嵌的前端资源。
 *
 * 空表 = 仓库里还没有构建过前端。
 * 执行 \`bun run web:build && bun run gen:assets\` 后重新生成本文件。
 * 此时 server 会退回磁盘查找（KANBAN_WEB_DIR 或包根下的 web/dist），再退到占位页。
 */
export const EMBEDDED_ASSETS: EmbeddedAssetMap = {}

/** 内嵌资源数量与总字节（启动日志会显示） */
export const EMBEDDED_COUNT = 0
export const EMBEDDED_BYTES = 0
`

if (!existsSync(DIST)) {
  console.log("web/dist 不存在，跳过资源内嵌。")
  console.log("提示：先执行 `bun run web:build` 再重新生成。")
  writeFileSync(OUT, `${HEADER}${PLACEHOLDER}`, "utf8")
  process.exit(0)
}

const files = collect(DIST).sort()

// import 变量名必须是合法标识符
const entries: string[] = []
const decls: string[] = []
files.forEach((file, i) => {
  const rel = relative(DIST, file).split("\\").join("/")
  // 路径里的特殊字符（@ - .）转成安全标识符
  const ident = `a${i}_${rel.replace(/[^a-zA-Z0-9]/g, "_")}`
  decls.push(`import ${ident} from "../../web/dist/${rel}" with { type: "file" }`)
  // `as unknown as string` 是必需的：Bun 的内置类型会把 .html 导入声明成
  // HTMLBundle（SSR 用），直接传给 Bun.file() 匹配不到重载。
  // 运行时它们都是路径字符串。
  entries.push(`  ${JSON.stringify(rel)}: () => Bun.file(${ident} as unknown as string),`)
})

const totalBytes = files.reduce((n, f) => n + statSync(f).size, 0)
const source = `${HEADER}
${decls.join("\n")}

/** 内嵌的前端资源：键是相对 web/dist 的路径 */
export const EMBEDDED_ASSETS: EmbeddedAssetMap = {
${entries.join("\n")}
}

/** 内嵌资源数量与总字节（启动日志与 doctor 会显示） */
export const EMBEDDED_COUNT = ${files.length}
export const EMBEDDED_BYTES = ${totalBytes}
`

mkdirSync(join(ROOT, "src", "server"), { recursive: true })
writeFileSync(OUT, source, "utf8")

console.log(`已生成 ${posix.normalize(relative(ROOT, OUT))}：${files.length} 个文件，${(totalBytes / 1024).toFixed(0)} KB`)
for (const f of files.slice(0, 8)) {
  console.log(`  ${relative(DIST, f).split("\\").join("/")}`)
}
if (files.length > 8) console.log(`  … 还有 ${files.length - 8} 个`)
