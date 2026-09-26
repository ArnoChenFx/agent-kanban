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
  throw new ApiError(err?.code ?? 6, err?.name ?? "INTERNAL", err?.message ?? "未知错误", err?.details ?? {})
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
    throw new ApiError(4, "BUSY", "连不上看板服务（网络错误）", { hint: "确认 kanban serve 是否在运行" })
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

/** 任务详情（含事件时间线） */
export async function fetchTaskDetail(
  token: string,
  project: string,
  taskId: string,
): Promise<{ task: Record<string, unknown>; timeline: KanbanEvent[]; handoffs: HandoffItem[]; plan: PlanItem | null }> {
  const { data } = await executeOp<{ task: Record<string, unknown> }>(token, project, {
    kind: "task.get",
    params: { task_id: taskId, timeline: true, tail: 60 },
  })
  const task = data.task

  // 时间线 / 交接 / 计划分开取：任一失败都不该让整个详情面板打不开
  const [timeline, handoffs, plan] = await Promise.all([
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

  return { task, timeline, handoffs, plan }
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
  next_actions: string[]
}
