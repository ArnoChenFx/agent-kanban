/**
 * 后端 API 客户端与类型定义。
 *
 * 核心约定（与 CLI / MCP 共用一套语义）：
 * - 读：`GET /api/board` 拿泳道快照，`GET /api/stream` 订阅 SSE 实时刷新
 * - 写：一律 `POST /api/op`，body = `{ project, op: { kind, params } }`
 *   这样本地/远程行为一致，前端不需要知道具体业务逻辑
 *
 * 鉴权：`X-Kanban-Key` 头。token 由用户输入后存 localStorage（`kanban.token`），
 * 刷新与重开浏览器都免登录——/admin 页的 `kanban.admin.token` 也是同一策略。
 */

import type { KanbanEvent } from "./types"
import { tActive } from "./i18n"

const TOKEN_KEY = "kanban.token"
const PROJECT_KEY = "kanban.project"

/**
 * 从 URL 参数读取一次性登录信息：`?key=k_xxx&project=demo`。
 *
 * 用途：分享看板链接、或从 CLI 一步跳到网页。
 * 读取后立即用 replaceState 抹掉参数——否则 token 会留在浏览器历史和
 * Referer 头里（一旦别人截图分享链接，token 就泄了）。
 */
export function consumeUrlLogin(): void {
  const url = new URL(window.location.href)
  const key = url.searchParams.get("key")
  const project = url.searchParams.get("project")
  if (!key && !project) return

  if (key) setToken(key)
  if (project) setLastProject(project)
  // 支持 ?theme=dark 一次性决定亮暗（截图/演示用）
  const theme = url.searchParams.get("theme")
  if (theme === "dark" || theme === "light") {
    localStorage.setItem("kanban.theme", theme)
  }
  if (key || project) {
    url.searchParams.delete("key")
    url.searchParams.delete("project")
    window.history.replaceState({}, "", url.pathname + url.search)
  }
}

/** 读到的 token（null = 未登录） */
export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
}

/** 上次选中的 project（下次打开自动恢复） */
export function getLastProject(): string | null {
  return localStorage.getItem(PROJECT_KEY)
}

export function setLastProject(project: string): void {
  localStorage.setItem(PROJECT_KEY, project)
}

/**
 * 忘掉上次选中的 project。
 *
 * 只有一种该用它的场景：登录表单里 project 留空。
 * 那一栏写的是「留空则自动选第一个有权限的」，所以旧记忆必须清掉，
 * 否则换个 token 登录时会被上一个 token 留下的 project 截胡。
 * 具体怎么退回第一个见 `lib/project.ts` 的 resolveProject。
 */
export function clearLastProject(): void {
  localStorage.removeItem(PROJECT_KEY)
}

/** 统一的错误类型：把后端的退出码语义搬过来 */
export class ApiError extends Error {
  readonly code: number
  readonly name2: string
  readonly details: Record<string, unknown>

  constructor(code: number, label: string, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.code = code
    this.name2 = label
    this.details = details
  }

  /** 是否为"登录失效"，UI 据此弹登录框 */
  get isAuth(): boolean {
    return this.code === 7
  }

  /** 是否可重试（数据库忙） */
  get isBusy(): boolean {
    return this.code === 4
  }

  /** 是否为"被别人占用"，UI 据此提示而不是当作错误 */
  get isConflict(): boolean {
    return this.code === 3
  }
}

interface Envelope<T> {
  ok: boolean
  data?: T
  next_actions?: string[]
  error?: { code: number; name: string; message: string; details?: Record<string, unknown> }
}

function authHeaders(token: string, sessionId?: string | null): HeadersInit {
  const headers: Record<string, string> = { "X-Kanban-Key": token }
  if (sessionId) headers["X-Kanban-Session"] = sessionId
  return headers
}

function throwIfError<T>(env: Envelope<T>): T {
  if (env.ok) return env.data as T
  const err = env.error
  throw new ApiError(err?.code ?? 6, err?.name ?? "INTERNAL", err?.message ?? tActive("api.error.unknown"), err?.details ?? {})
}

/** 执行一个 Op（写操作统一入口） */
export async function executeOp<T>(
  token: string,
  project: string,
  op: { kind: string; params?: Record<string, unknown> },
  sessionId?: string | null,
): Promise<{ data: T; nextActions: string[] }> {
  let res: Response
  try {
    res = await fetch("/api/op", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(token, sessionId) },
      body: JSON.stringify({ project, op }),
    })
  } catch {
    throw new ApiError(4, "BUSY", tActive("api.error.network"), { hint: tActive("api.error.networkHint") })
  }
  const env = (await res.json()) as Envelope<T>
  const data = throwIfError(env)
  return { data, nextActions: env.next_actions ?? [] }
}

/** 拉取看板快照（可分页：`offset` + `limit`，见后端 board.get） */
export async function fetchBoard(
  token: string,
  project: string,
  page?: { offset?: number; limit?: number },
): Promise<BoardSnapshot> {
  const q = new URLSearchParams({ project })
  if (page?.offset) q.set("offset", String(page.offset))
  if (page?.limit) q.set("limit", String(page.limit))
  const res = await fetch(`/api/board?${q.toString()}`, {
    headers: authHeaders(token),
  })
  const env = (await res.json()) as Envelope<BoardSnapshot>
  return throwIfError(env)
}

/**
 * 泳道里的卡总数（与后端 `truncated.total` 口径一致：不含 cancelled）。
 *
 * 为什么要这个而不是直接用 `truncated.total`：前端要在**合并两页**时重算，
 * 而新一页的 `truncated.total` 是可信的、老服务端可能没有这个字段——所以两条路都得能走。
 *
 * ⚠ 「减掉 cancelled」与后端的「只加 LANE_ORDER」字面不同，两者等价**只因为**
 * 一个后端不变量：`LANE_ORDER` 恰好覆盖了 `TASK_STATUSES` 里除 `cancelled` 外的
 * 每一个状态。后端在 `test/board-truncation.test.ts` 里钉住了那条不变量；
 * 哪天后端加了一个不在 LANE_ORDER 里的状态而没改这里，前端会把新状态算进去、
 * 后端不会，「还有 N 张」就会一直差着几个数。
 *
 * 选「减法」而不是抄一份 LANE_ORDER 列表，是因为新增状态时减法自动跟随。
 */
function totalFromCounts(counts: Record<string, number>): number {
  return Object.values(counts).reduce((n, c) => n + c, 0) - (counts.cancelled ?? 0)
}

/**
 * 合并两页看板（用于「显示更多」）。
 *
 * 为什么需要：泳道是按优先级全局排序后切页的，所以**同一张卡不会跨页出现**，
 * 直接按 id 去重就够，不必重新排序——顺序已经由后端保证。
 */
export function mergeBoardPages(base: BoardSnapshot, next: BoardSnapshot): BoardSnapshot {
  const lanes: BoardSnapshot["lanes"] = {}
  const statuses = new Set([
    ...Object.keys(base.lanes ?? {}),
    ...Object.keys(next.lanes ?? {}),
  ])
  for (const s of statuses) {
    const seen = new Set<string>()
    const merged: TaskItem[] = []
    for (const t of [...(base.lanes?.[s] ?? []), ...(next.lanes?.[s] ?? [])]) {
      if (seen.has(t.id)) continue
      seen.add(t.id)
      merged.push(t)
    }
    lanes[s as TaskStatus] = merged
  }
  // ⚠ 截断信息必须**重算**，不能直接用 next 的：
  //   next 的 offset > 0，所以它的 `truncated` 恒为 false——
  //   直接透传会让「显示更多」之后提示条消失，而后面可能还有页。
  // 合并后的语义变成「你手上的完整视图」：offset 归 0，showing 是已加载总数。
  const showing = Object.values(lanes).reduce((n, l) => n + (l ?? []).length, 0)
  const total = next.truncated?.total ?? totalFromCounts(next.counts)
  return {
    ...next, // counts / head_seq / project 取新的一页
    lanes,
    truncated: {
      total,
      showing,
      // ⚠ 这个 500 必须与后端 `BOARD_PAGE_SIZE` 一致。web/ 不能 import src/core
      //   （会把 bun:sqlite 拖进浏览器构建），所以两边只能各写一份——那就让
      //   test/web-contract.test.ts 的静态守卫盯着它。
      limit: next.truncated?.limit ?? 500,
      offset: 0,
      truncated: showing < total,
    },
  }
}

/** 当前 token 能访问的 project 列表 */
export async function fetchProjects(token: string): Promise<ProjectInfo[]> {
  const res = await fetch("/api/projects", { headers: authHeaders(token) })
  const env = (await res.json()) as Envelope<ProjectInfo[]>
  return throwIfError(env)
}

/**
 * `task.get` 的响应体：**任务本体 + 详情附加字段**。
 *
 * 服务端 ops.ts 的 task.get 分支是 `{ ...taskToJson(task), body, checklist, dependencies, ... }`，
 * 所以这里必须带索引签名，否则读 plan_id / timeline 时 TS 会报错而运行时却是好的。
 */
interface TaskGetData extends Omit<Partial<TaskItem>, "checklist" | "unfinished_dependencies"> {
  /** timeline: true 时服务端同响应附带事件（旧服务端不返回，故可选） */
  timeline?: KanbanEvent[]
  /** 详细描述（数据库列名 body，契约字段名 description） */
  body?: string | null
  /** 检查项明细：文本 + 勾没勾 + 谁勾的。taskToJson 只给计数，这里才有逐项 */
  checklist?: unknown
  /** 依赖列表。注意实际形状是 TaskDep 对象数组（{taskId, dependsOnId, createdAt}），不是 id 数组 */
  dependencies?: unknown
  /** 带标题与状态的依赖明细（服务端 >= 某版本才有；旧服务端回退到 dependencies + unfinished_dependencies） */
  dependency_details?: unknown
  /** 未完成的依赖 id 数组 */
  unfinished_dependencies?: unknown
  [key: string]: unknown
}

/** 检查项单项（与 src/core/types.ts 的 ChecklistItem 同形） */
export interface ChecklistItem {
  text: string
  done: boolean
  done_at?: number | null
  by?: string | null
}

/** 一条关联任务（依赖 / 父任务），与 CLI `task show` 读的是同一份服务端数据 */
export interface RelatedTaskItem {
  id: string
  title: string
  /** 依赖是否已完成（不是依赖行——父任务没有这个概念） */
  done: boolean
}

/** 详情抽屉消费的、已归一化的任务详情 */
export interface TaskDetail {
  /** 原始任务对象（保持扁平，与 CLI / MCP 同形，plan_id 等从这里读） */
  task: Record<string, unknown>
  /** 详细描述；没有描述时为 null */
  description: string | null
  /** 检查项明细；服务端没带或形状不对时是空数组 */
  checklist: ChecklistItem[]
  /** 依赖的任务 id（全部，已从 TaskDep 对象里抽出 dependsOnId） */
  dependencies: string[]
  /** 尚未完成的依赖 id（用于给依赖行标注“还没做完”） */
  unfinishedDependencies: string[]
  /** 关联任务明细：优先取服务端的 dependency_details，缺失时由上面两个字段拼出来 */
  related: RelatedTaskItem[]
  timeline: KanbanEvent[]
  handoffs: HandoffItem[]
  plan: PlanItem | null
  /** 计划的历史版本（新 → 旧），**不含正文**；见 PlanVersionItem */
  planVersions: PlanVersionItem[]
}

/**
 * 把服务端回的 checklist 归一化成 ChecklistItem[]。
 *
 * 为什么要在前端洗一遍：`checklist` 在库里是 TEXT（JSON 字符串），老数据可能是
 * `null`、空串或手改坏的形状。详情面板不该因为一行坏数据整个打不开，
 * 也不能把 `{text, done}` 的约定丢给每个渲染点自己判断。
 */
function normalizeChecklist(raw: unknown): ChecklistItem[] {
  // 老服务端（不带明细）直接给的是 {total, done} 计数对象，这时没有明细可显示
  if (!Array.isArray(raw)) return []
  return raw
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => ({
      text: String(x.text ?? ""),
      done: x.done === true,
      done_at: typeof x.done_at === "number" ? x.done_at : null,
      by: typeof x.by === "string" ? x.by : null,
    }))
    .filter((x) => x.text !== "")
}

/**
 * 归一化关联任务列表。
 *
 * 优先用服务端的 `dependency_details`（id + title + done，CLI 读的是同一份）；
 * 旧服务端没有这个字段时，用 `dependencies`（TaskDep 对象）+ `unfinished_dependencies` 拼出来，
 * 标题留空（界面上就不显示标题，而不是显示 undefined）。
 */
function normalizeRelated(
  details: unknown,
  depIds: string[],
  unfinishedIds: string[],
): RelatedTaskItem[] {
  if (Array.isArray(details)) {
    const fromDetails = details
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
      .map((x) => ({
        id: String(x.id ?? ""),
        title: typeof x.title === "string" ? x.title : "",
        done: x.done === true,
      }))
      .filter((x) => x.id !== "")
    if (fromDetails.length > 0) return fromDetails
  }
  return depIds.map((id) => ({ id, title: "", done: !unfinishedIds.includes(id) }))
}

/**
 * 任务详情（含事件时间线）。
 *
 * 契约要点：`task.get` 的 `data` **就是任务本体**（扁平对象），
 * 与 CLI `agent-kanban task show` / MCP `kanban_task_get` 消费的是同一个形状，
 * 并不是 `{ task: {...} }` 包装。早期版本前端误按包装形状取值，
 * 导致打开详情时读 `task.plan_id` 抛 `Cannot read properties of undefined`。
 */
export async function fetchTaskDetail(
  token: string,
  project: string,
  taskId: string,
): Promise<TaskDetail> {
  // timeline: true 让服务端在同一次响应里带上事件，省一次往返
  const { data } = await executeOp<TaskGetData>(token, project, {
    kind: "task.get",
    params: { task_id: taskId, timeline: true, tail: 60 },
  })
  const task = data as unknown as Record<string, unknown>
  if (!task || typeof task !== "object" || typeof task.id !== "string") {
    // 形状不符时给出可读报错，而不是让它顺着下面的 `task.plan_id` 崩成 TypeError
    throw new ApiError(6, "INTERNAL", tActive("api.error.badShape"), {
      task_id: taskId,
      keys: Object.keys((task ?? {}) as object).slice(0, 20).join(","),
    })
  }

  // 时间线优先用同响应内嵌的那份；老服务端没带时再单独拉一次
  const embedded = Array.isArray(data.timeline) ? (data.timeline as KanbanEvent[]) : null
  // 交接 / 计划分开取：任一失败都不该让整个详情面板打不开
  const [timeline, handoffs, plan, planVersions] = await Promise.all([
    embedded ??
      executeOp<KanbanEvent[]>(token, project, { kind: "events.tail", params: { task_id: taskId, tail: 60 } })
        .then((r) => r.data)
        .catch(() => [] as KanbanEvent[]),
    executeOp<HandoffItem[]>(token, project, { kind: "handoff.list", params: { task_id: taskId } })
      .then((r) => r.data)
      .catch(() => [] as HandoffItem[]),
    task.plan_id
      ? executeOp<PlanItem>(token, project, { kind: "plan.show", params: { plan_id: String(task.plan_id) } })
          .then((r) => r.data)
          .catch(() => null)
      : Promise.resolve(null),
    // 历史版本：status 必须显式给 "all"——plan.list 默认只回 active（见 listPlans），
    // 而"历史"恰恰是那些已被顶替（superseded）的旧版本。
    task.plan_id
      ? executeOp<PlanVersionItem[]>(token, project, {
          kind: "plan.list",
          params: { task_id: taskId, status: "all", limit: 50 },
        })
          .then((r) => r.data)
          .catch(() => [] as PlanVersionItem[])
      : Promise.resolve([] as PlanVersionItem[]),
  ])

  const dependencies = normalizeDeps(data.dependencies)
  const unfinishedDependencies = normalizeDeps(data.unfinished_dependencies)
  return {
    task,
    description: typeof data.body === "string" && data.body.trim() !== "" ? data.body : null,
    checklist: normalizeChecklist(data.checklist),
    dependencies,
    unfinishedDependencies,
    related: normalizeRelated(data.dependency_details, dependencies, unfinishedDependencies),
    timeline,
    handoffs,
    plan,
    planVersions: normalizePlanVersions(planVersions, plan),
  }
}

/**
 * 归一化计划版本列表。
 *
 * 两个兜底：
 * 1. 老服务端不认识 `plan.list`（会报错或回空）——此时用已经拿在手里的当前版本
 *    补一条，版本切换器退化成单版本视图，而不是整个"计划"页签空掉。
 * 2. 当前版本（`task.plan_id` 指向的那份）即便 `plan.list` 漏了它也补进去，
 *    否则会出现"正在显示 v2、切换器里却只有 v1"这种自相矛盾的界面。
 */
function normalizePlanVersions(
  raw: PlanVersionItem[],
  current: PlanItem | null,
): PlanVersionItem[] {
  const list = Array.isArray(raw) ? raw.filter((p) => !!p && typeof p.id === "string") : []
  if (current && !list.some((p) => p.id === current.id)) {
    list.unshift({
      id: current.id,
      version: current.version,
      title: current.title,
      status: current.status,
      created_at: current.created_at,
      supersedes_id: current.supersedes_id,
      body_lines: 0,
      body_chars: 0,
    })
  }
  return list
}

/**
 * 取某个版本的计划全文（`plan.show`）。
 *
 * 版本切换器点旧版本时才调：版本列表来自 `plan.list`，**不带正文**，
 * 正文必须单独取（见 PlanVersionItem 的说明）。
 */
export async function fetchPlan(
  token: string,
  project: string,
  planId: string,
): Promise<PlanItem> {
  const { data } = await executeOp<PlanItem>(token, project, {
    kind: "plan.show",
    params: { plan_id: planId },
  })
  return data
}

/**
 * 归一化依赖 id 列表。
 *
 * 服务端 `task.get` 的 `dependencies` 是 **TaskDep 对象数组**（taskId/dependsOnId/createdAt），
 * 不是 id 数组；`unfinished_dependencies` 才是 id 数组。
 * 早先按“数组里都是字符串”来过滤，结果一个依赖都留不下——所以这里两种形状都接。
 */
function normalizeDeps(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((x) => {
      if (typeof x === "string") return x
      const id = (x as { dependsOnId?: unknown } | null)?.dependsOnId
      return typeof id === "string" ? id : null
    })
    .filter((x): x is string => x !== null)
}

/** 恢复上下文：交接 / 失联会话 / 建议动作 */
export async function fetchContext(
  token: string,
  project: string,
  sessionId: string | null,
): Promise<RecoveryContext> {
  const { data } = await executeOp<RecoveryContext>(
    token,
    project,
    { kind: "context.get", params: { tail: 20, consume: false } },
    sessionId,
  )
  return data
}

// =============================================================================
// SSE：实时刷新
// =============================================================================

export interface StreamHandle {
  close(): void
}

/**
 * ⚠ 这里**曾经**有一个 `subscribeEvents(token, ...)`，它把 token 拼进
 * `/api/stream?...&key=k_xxx`。已删除（见 `subscribeEventsWithTicket`）：
 * URL 会进浏览器历史、反代 access log、容器日志与 Referer。
 * 留一个「参数收下但不用」的死函数只会让人以为它还能用。
 */

/**
 * **同步**拼出 SSE 的 URL（token 除外）。
 *
 * ⚠ 为什么不把 token 直接拼进去（以前是 `&key=k_xxx`）：URL 会进浏览器历史、
 *   反代 access log、容器日志与 Referer，等于把凭据到处留一份。
 *   浏览器的事件流只能用 `EventSource`（不能设 header），所以先换一张
 *   **60 秒一次性**的票——URL 里出现的是一个用完即废的随机串。
 *   能设 header 的客户端（如 core/backend-remote.ts）直接用 header，连票都不用换。
 */
function makeStreamUrl(project: string, afterSeq: number): string {
  return `/api/stream?project=${encodeURIComponent(project)}&after=${afterSeq}`
}

/** 换一张 SSE 票（`POST /api/stream-ticket`，token 走 header） */
async function fetchStreamTicket(token: string, project: string): Promise<string | null> {
  try {
    const res = await fetch("/api/stream-ticket", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(token) },
      body: JSON.stringify({ project }),
    })
    if (!res.ok) return null
    const env = (await res.json()) as Envelope<{ ticket: string }>
    return env.data?.ticket ?? null
  } catch {
    // 换票失败不该让整个看板跟着挂：退回「不订阅实时更新」，
    // 页面仍然能用（只是要手动刷新）
    return null
  }
}

/**
 * 订阅事件流（带一次性票据）。
 *
 * 返回的 handle 可以在换票后重连：EventSource 自己会按服务端给的 `retry:` 重连，
 * 但**重连时那张票已经用过了**（一次性），所以要重建一条带新票的连接。
 */
export function subscribeEventsWithTicket(
  token: string,
  project: string,
  afterSeq: number,
  onEvent: (event: KanbanEvent) => void,
  onStateChange?: (connected: boolean) => void,
  onAuthExpired?: () => void,
): StreamHandle {
  // `?static=1` 守卫：无头浏览器截图与「不需要实时更新」的场景靠它跳过 SSE。
  // scripts/verify-web-ui.ts 的截图步骤就带着这个参数，所以别因为「看起来没用」删掉。
  if (typeof window !== "undefined" && new URL(window.location.href).searchParams.get("static") === "1") {
    onStateChange?.(false)
    return { close: () => {} }
  }

  let source: EventSource | null = null
  let closed = false

  const connect = async () => {
    if (closed) return
    const ticket = await fetchStreamTicket(token, project)
    if (closed) return
    if (!ticket) {
      // 换不到票就不建连接（不把 token 塞进 URL 退而求其次）
      onStateChange?.(false)
      return
    }
    // 旧连接必须先关：EventSource 在 onerror 后会自带重连循环，而票是一次性的，
    // 旧对象拿核销的票只会反复 401——不 close 就会随着每次重连积累僵尸连接
    source?.close()
    source = new EventSource(`${makeStreamUrl(project, afterSeq)}&ticket=${encodeURIComponent(ticket)}`)
    source.onopen = () => onStateChange?.(true)
    source.onerror = () => {
      onStateChange?.(false)
      // 票是一次性的，原连接被服务端关掉后不会自动重连成功 → 换新票重连
      if (!closed) setTimeout(() => void connect(), 3000)
    }
    // 凭据在长连接期间失效：服务端会主动发这个事件（见 handleSse 的复验逻辑）
    // ⚠ 曾经这里还把事件负载 JSON.parse 出来存进 `detail`，然后用 `void detail` 把它丢掉。
    //   `onAuthExpired?: () => void` 不收参数，那段解析（10 行）纯是负担——
    //   要么真用起来（得先改回调签名），要么删掉，留在中间只会让人以为 reason 有用。
    source.addEventListener("auth_expired", () => {
      closed = true
      source?.close()
      onAuthExpired?.()
    })
    source.onmessage = (e) => {
      try {
        onEvent(JSON.parse(e.data) as KanbanEvent)
      } catch {
        // 心跳等非 JSON 负载直接忽略
      }
    }
  }

  void connect()
  return {
    close: () => {
      closed = true
      source?.close()
    },
  }
}

// =============================================================================
// 类型
// =============================================================================

export interface ProjectInfo {
  key: string
  name: string
  root_path: string | null
  task_count?: number
}

export type TaskStatus =
  | "backlog"
  | "todo"
  | "doing"
  | "blocked"
  | "review"
  | "done"
  | "cancelled"

export interface TaskItem {
  id: string
  project: string
  title: string
  status: TaskStatus
  priority: number
  progress: number
  assignee_session_id: string | null
  lease_expires_at: number | null
  parent_id: string | null
  plan_id: string | null
  labels: string[]
  checklist: { total: number; done: number }
  block_reason: string | null
  created_at: number
  updated_at?: number
  /** 未完成的依赖（等这几张卡做完） */
  unfinished_dependencies?: string[]
}

export interface SessionItem {
  id: string
  agent_name: string
  harness: string | null
  status: string
  last_seen_at: number
  fresh: string | null
  stale: boolean
  tasks: string[]
}

export interface BoardSnapshot {
  project: { key: string; name: string; root_path: string | null }
  counts: Record<string, number>
  head_seq: number
  lanes: Partial<Record<TaskStatus, TaskItem[]>>
  sessions: SessionItem[]
  /**
   * 截断信息（后端 v? 起提供；**必须容错缺失**，老服务端没有这个字段）。
   *
   * 之前 `counts` 是全量、lanes 却被硬截到 500，界面不说一声——
   * 看着就像「卡丢了」。有了它才画得出「还有 N 张未显示」。
   */
  truncated?: {
    total: number
    showing: number
    limit: number
    offset: number
    truncated: boolean
  }
}

export interface HandoffItem {
  id: number
  task_id: string
  task_title?: string
  kind: "voluntary" | "crash" | "reclaim"
  summary: string
  next_step: string | null
  blockers: string[]
  open_questions: string[]
  from_session: string
  created_at: number
  created_relative?: string
  task_progress?: number
  consumed_by: string | null
}

/**
 * 后端建议动作的代号（与 `src/core/context.ts` 的 `NextActionCode` 一一对应）。
 *
 * 这是跨语言边界的契约：后端给「代号 + 参数」，界面给「怎么把参数说成人话」。
 * 后端新增代号而前端没翻，编译期报错（`keyFor` 的 `never` 分支），
 * 万一前端旧、服务端新，则退回展示后端的中文串而不是崩掉。
 */
export type NextActionCode =
  | "takeover"
  | "read_handoff"
  | "crash_handoffs"
  | "continue_mine"
  | "blocked_needs_human"
  | "claim_new"
  | "claim_after"
  | "idle"

export interface NextActionItem {
  code: NextActionCode
  args: {
    n?: number
    id?: number | string
    task?: string
    summary?: string
    /** 按本地标点列举（中文顿号、英文逗号） */
    tasks?: string[]
    /** 可直接执行的命令行，用 " / " 列举（斜杠分隔代码，不随语言变） */
    commands?: string[]
  }
}

/** `plan.show` / `plan.at` 的返回形状（含正文，字段名对齐 core 的 planToJson） */
export interface PlanItem {
  id: string
  title: string
  body: string
  version: number
  status: string
  /** 毫秒时间戳，与 TaskItem.created_at 同一口径，可直接喂 relativeTime */
  created_at: number
  /** 被这一版顶替掉的上一版；v1 为 null */
  supersedes_id: string | null
  author_session_id: string | null
}

/**
 * `plan.list` 的一条：**不含正文**。
 *
 * 计划正文动辄几百行，`plan.history` 一次把每个版本的全文都带回来，
 * 版本一多（改过十几次的卡并不罕见）抽屉会明显变沉。
 * 所以列表只取元数据 + 体量提示（body_lines / body_chars），
 * 正文等用户真的点了那个版本，再单独 `plan.show` 取。
 */
export interface PlanVersionItem {
  id: string
  version: number
  title: string
  status: string
  created_at: number
  supersedes_id: string | null
  body_lines: number
  body_chars: number
}

export interface RecoveryContext {
  project: { key: string; name: string }
  counts: Record<string, number>
  zombie_sessions: Array<{
    session_id: string
    agent_name: string
    silent_minutes: number
    tasks: Array<{ id: string; title: string; progress: number }>
    suggestion: string
  }>
  pending_handoffs: HandoffItem[]
  my_tasks: Array<{
    id: string
    title: string
    progress: number
    remaining_checklist: string[]
    last_event: string | null
    updated_relative: string
  }>
  in_progress: Array<{
    id: string
    title: string
    progress: number
    assignee: string | null
    assignee_agent: string | null
    stale_holder: boolean
  }>
  blocked: Array<{ id: string; title: string; reason: string | null }>
  ready: Array<{ id: string; title: string; priority: number; reason: string }>
  /** 给 agent 看的中文串（CLI / MCP / --json 的读者） */
  next_actions: string[]
  /**
   * 同一批建议的结构化形态：界面按 code 选词典条目自己拼文案。
   * 可选——老服务端不发这个字段，前端退回展示 next_actions（中文）。
   */
  next_action_items?: NextActionItem[]
}
