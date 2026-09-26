/**
 * 非代码资产的模块声明。
 *
 * `with { type: "file" }` 是 Bun 的 embedded files 语法：让 `bun build --compile`
 * 把这些文件打进单文件二进制（否则编译产物里它们不存在）。
 * TypeScript 不认识这个导入属性，需要在这里补上类型。
 *
 * 导出的类型是 `string`——运行时拿到的是**文件路径**
 * （编译后指向二进制内嵌的虚拟路径），用 `readFileSync` 读取。
 */

declare module "*.sql" {
  const path: string
  export default path
}

/** 字体文件：web/dist 里会被内嵌进二进制（Bun embedded files） */
declare module "*.woff2" {
  const path: string
  export default path
}

declare module "*.woff" {
  const path: string
  export default path
}

declare module "*.ttf" {
  const path: string
  export default path
}

/** 前端构建产物（Vite 输出，文件名带内容哈希）：都作为 embedded file 引入 */
declare module "*.html" {
  const path: string
  export default path
}

declare module "*.js" {
  const path: string
  export default path
}

declare module "*.css" {
  const path: string
  export default path
}

declare module "*.svg" {
  const path: string
  export default path
}

// 注：不声明 "*.json" —— Bun 的类型已把 `with { type: "file" }` 的 json 导入
// 解析成 JSON 模块（对象），而运行时实际是路径字符串。
// core/version.ts 就地断言处理，不在这里覆盖以免影响其他导入语义。
