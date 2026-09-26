/**
 * 后端 API 客户端与类型定义。
 *
 * 核心约定（与 CLI / MCP 共用一套语义）：
 * - 读：`GET /api/board` 拿泳道快照，`GET /api/stream` 订阅 SSE 实时刷新
 * - 写：一律 `POST /api/op`，body = `{ project, op: { kind, params } }`
 *   这样本地/远程行为一致，前端不需要知道具体业务逻辑
 *
 * 鉴权：`X-Kanban-Key` 头。token 由用户输入后存 localStorage
 * （与 /admin 页面的 sessionStorage 策略不同：看板希望刷新后免重复登录）
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

/** 拉取看板快照 */
export async function fetchBoard(token: string, project: string): Promise<BoardSnapshot> {
  const res = await fetch(`/api/board?project=${encodeURIComponent(project)}`, {
    headers: authHeaders(token),
  })
  const env = (await res.json()) as Envelope<BoardSnapshot>
  return throwIfError(env)
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
  const [timeline, handoffs, plan] = await Promise.all([
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
  }
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
 * 订阅事件流。
 *
 * 服务端实现是 1s 轮询 events 表（零 IPC 复杂度，跨进程也能工作），
 * 前端只做一件事：收到事件就标记"有更新"，由调用方决定何时重新拉看板。
 *
 * EventSource 不能带自定义 header，所以 token 走 query 参数（服务端已支持）。
 */
export function subscribeEvents(
  token: string,
  project: string,
  afterSeq: number,
  onEvent: (event: KanbanEvent) => void,
  onStateChange?: (connected: boolean) => void,
): StreamHandle {
  // URL 参数 ?static=1 时不建连接。
  // 用途：无头浏览器截图时，SSE 长连接会让 Chrome 的 virtual-time 永不结束
  // （虚拟时间等的是"网络空闲"，EventSource 一直 pending）。
  if (typeof window !== "undefined" && new URL(window.location.href).searchParams.get("static") === "1") {
    onStateChange?.(false)
    return { close: () => {} }
  }

  const url = `/api/stream?project=${encodeURIComponent(project)}&after=${afterSeq}&key=${encodeURIComponent(token)}`
  const source = new EventSource(url)
  source.onopen = () => onStateChange?.(true)
  source.onerror = () => onStateChange?.(false)
  source.onmessage = (e) => {
    try {
      onEvent(JSON.parse(e.data) as KanbanEvent)
    } catch {
      // 心跳等非 JSON 负载直接忽略
    }
  }
  return { close: () => source.close() }
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

export interface PlanItem {
  id: string
  title: string
  body: string
  version: number
  status: string
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
