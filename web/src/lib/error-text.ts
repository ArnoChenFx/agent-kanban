/**
 * 后端错误 → 界面文案的解析层。
 *
 * 为什么需要这个文件（背景见 docs/plan/006-CLI文案英文化.md §五）：
 * CLI 文案英文化之后，`KanbanError.message` 变成英文，而看板同时支持中英双语——
 * 中文界面不能直接把后端的英文 message 显示出来。
 *
 * 做法：后端在 `details.reason` 里给每个面向 Web 的错误一个稳定 slug，
 * 这里按 `error.<reason>` 查词典，命中则用词典里的中文模板；
 * **查不到、或者模板是空串，就原样回退到后端 message**（英文）。
 * 空串不是漏翻：英文界面里 `error.*` 一律留空，因为后端那句已经是英文，
 * 词典里再抄一份就多一处会漂移的第二真相。
 *
 * 两条约定（与 lib/i18n 的其它部分一致）：
 * 1. 插值占位符直接用 `details` 的键名（原样 snake_case），不做键名映射——
 *    多一层映射就多一处可能对不上的地方，而这里的收益只是少写一个转换函数。
 * 2. 缺占位符参数时**保留占位符本身**（渲染出 `{task_id}`）而不是渲染成空串：
 *    空串会让用户以为"错误信息不完整"，而 `{task_id}` 直接暴露了缺哪个字段。
 *
 * 本模块不引 React：`t` 由调用方（组件）传入，也可以用 `tActive` 走模块级语言。
 */

import { tActive, type Translate } from "./i18n.tsx"

/** 只需要 ApiError 的这几个字段，因此结构化收窄，避免和 api.ts 形成 import 环 */
export interface BackendErrorLike {
  code: number
  name: string
  message: string
  details: Record<string, unknown>
}

/** 词典键前缀：与 i18n 词典里的 `error.*` 一一对应 */
const PREFIX = "error."

/**
 * 把 `{name}` 占位符替换成 details 里的值；缺参数时保留占位符原样。
 *
 * 只认 `\{(\w+)\}`：`\w` 覆盖 snake_case 与数字，符合 details 的键名风格。
 */
function fill(template: string, details: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in details ? String(details[key]) : whole,
  )
}

/**
 * 从词典里取 `error.<reason>` 的模板。
 *
 * 两种“拿不到”，都要回退到后端 message：
 * 1. **键不存在**：`lookup` 查不到时会把键原样返回（见 i18n 的 lookup）。
 * 2. **模板是空串**：英文界面里 `error.*` 一律留空 `""`，
 *    那是刻意的约定而不是漏翻（见 i18n 里那组注释）——
 *    后端那句 message 本身已经是英文，没必要再抄一份进词典。
 *    所以这里必须把纯空白也当成“没有模板”，否则英文界面会显示一个空错误框。
 */
function templateFor(t: Translate, key: string): string | null {
  const template = t(key)
  if (template === key || template.trim() === "") return null
  return template
}

/**
 * 错误正文：优先走词典（中文界面显示中文），查不到 / 模板为空就回退后端的英文 message。
 *
 * @param e      后端错误（ApiError 满足这个结构）
 * @param t      翻译函数；组件里用 `useI18n().t`，非组件模块可用 `tActive`
 */
export function errorText(e: BackendErrorLike, t: Translate = tActive): string {
  const reason = e.details?.reason
  if (typeof reason !== "string" || reason === "") return e.message
  const template = templateFor(t, PREFIX + reason)
  if (template === null) return e.message
  return fill(template, e.details)
}

/**
 * 错误提示（toast 的 description 位置）。
 *
 * 与 `errorText` 分开，是因为 hint 的存在与否由后端决定：
 * 有 `details.hint` 才显示，没有就返回空串让调用方别渲染第二行。
 * hint 同样英文化了，但它的动态参数少（一般只有任务 id），所以没有单独一套
 * `error.*.hint` 键——中文界面拿英文 hint 当补充说明是可接受的，
 * 正文（errorText）才是必须中文化的那一行。
 */
export function errorHint(e: BackendErrorLike): string {
  const hint = e.details?.hint
  return typeof hint === "string" ? hint : ""
}

/**
 * 冲突错误的持有者信息，拼成一行可读文本。
 *
 * ⚠ 这里修了一个旧 bug：调用点原来写的是 `String(e.details.holder ?? e.message)`，
 *   而 `holder` 是个**对象**（session_id / agent_name / progress），
 *   `String(obj)` 直接渲染成 `[object Object]`，冲突 toast 的描述行等于没有信息。
 *   对象存在时走这里；不存在时回退到 fallback（通常是错误正文）。
 */
export function holderText(holder: unknown, fallback = ""): string {
  if (!holder || typeof holder !== "object") return fallback
  const h = holder as Record<string, unknown>
  const session = typeof h.session_id === "string" ? h.session_id : ""
  const agent = typeof h.agent_name === "string" ? h.agent_name : ""
  const progress = typeof h.progress === "number" ? `${h.progress}%` : ""
  // agent 名比 session id 更认得出来，所以放前面
  const parts = [agent || session, agent && session ? `(${session})` : "", progress ? `${progress}` : ""]
  const text = parts.filter(Boolean).join(" ").trim()
  return text || fallback
}
