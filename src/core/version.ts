/**
 * 版本号读取。
 *
 * 为什么要 embedded file：`bun build --compile` 出来的单文件二进制里
 * 拿不到 `import.meta.dir` 指向的 package.json（编译产物在临时虚拟根目录），
 * 所以和 schema.sql 一样用 `with { type: "file" }` 声明为内嵌文件。
 *
 * 与发布流程的关系：CI 会在打 tag 时校验
 * `package.json.version === tag 名去掉 v` —— 二者漂移会让"这个二进制到底是哪版"
 * 变成一个查不到的问题，所以版本号只有一个来源。
 */

import { readFileSync } from "node:fs"
import PACKAGE_JSON_FILE from "../../package.json" with { type: "file" }

/**
 * 语义化版本号；读不到时返回 "0.0.0-unknown" 而不是崩掉
 * （`--version` 是纯信息命令，任何情况下都该给出输出而不是抛错）。
 */
export function readPackageVersion(): string {
  try {
    // 走 readFileSync 而非直接 import JSON：embedded file 导入拿到的是路径，
    // 统一用 fs 读，开发模式与编译模式行为一致。
    //
    // 断言说明：Bun 的类型会把 `import ... with { type: "file" }` 的 .json
    // 解析成“JSON 模块”（对象），而实际运行时它是路径字符串。
    // 声明为 string 会在编译产物里拿到对象，所以这里就地断言而不是改类型定义。
    const raw = readFileSync(PACKAGE_JSON_FILE as unknown as string, "utf8")
    const v = (JSON.parse(raw) as { version?: unknown }).version
    return typeof v === "string" && v.length > 0 ? v : "0.0.0-unknown"
  } catch {
    return "0.0.0-unknown"
  }
}
