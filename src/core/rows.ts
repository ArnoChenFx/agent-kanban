/**
 * 数据库行 ↔ 领域对象 的映射层。
 *
 * 为什么要单独一层：SQLite 返回的是 snake_case 的裸行，领域层用 camelCase，
 * JSON 输出又必须回到 snake_case（agent 脚本和前端 jq 在用，契约 §6）。
 * 三处转换集中在这里，改一处不会漏另两处。
 */

import { KanbanError } from "./errors.ts";
import type {
  ChecklistItem,
  Handoff,
  KanbanEvent,
  Plan,
  Session,
  Task,
  TaskDep,
} from "./types.ts";

/** tasks 表行形状 */
export interface TaskRow {
  seq: number;
  id: string;
  project_key: string;
  title: string;
  body: string | null;
  status: string;
  priority: number;
  assignee_session_id: string | null;
  lease_expires_at: number | null;
  progress: number;
  checklist: string | null;
  labels: string | null;
  parent_id: string | null;
  plan_id: string | null;
  block_reason: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
  estimate_ms: number | null;
  spent_ms: number | null;
}

export interface SessionRow {
  id: string;
  agent_name: string;
  harness: string | null;
  cwd: string;
  pid: number | null;
  status: string;
  started_at: number;
  last_seen_at: number;
  lease_expires_at: number | null;
  meta: string | null;
}

export interface EventRow {
  seq: number;
  ts: number;
  session_id: string | null;
  type: string;
  task_id: string | null;
  plan_id: string | null;
  project_key: string | null;
  data: string | null;
}

export interface PlanRow {
  id: string;
  project_key: string;
  scope: string;
  task_id: string | null;
  version: number;
  title: string;
  body: string;
  status: string;
  author_session_id: string | null;
  created_at: number;
  supersedes_id: string | null;
}

export interface HandoffRow {
  id: number;
  project_key: string;
  task_id: string;
  session_id: string;
  kind: string;
  summary: string;
  next_step: string | null;
  blockers: string | null;
  open_questions: string | null;
  created_at: number;
  consumed_by: string | null;
  consumed_at: number | null;
}

export interface DepRow {
  task_id: string;
  depends_on_id: string;
  created_at: number;
}

/** 安全解析 JSON 文本，失败返回默认值而不是抛错（脏数据不应让整个命令崩掉） */
function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** TaskRow → Task */
export function toTask(row: TaskRow): Task {
  return {
    seq: row.seq,
    id: row.id,
    projectKey: row.project_key,
    title: row.title,
    body: row.body,
    status: row.status as Task["status"],
    priority: row.priority,
    assigneeSessionId: row.assignee_session_id,
    leaseExpiresAt: row.lease_expires_at,
    progress: row.progress,
    checklist: parseJson<ChecklistItem[]>(row.checklist, []),
    labels: parseJson<string[]>(row.labels, []),
    parentId: row.parent_id,
    planId: row.plan_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    estimateMs: row.estimate_ms,
    spentMs: row.spent_ms,
    blockReason: row.block_reason,
  };
}

/** SessionRow → Session */
export function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    agentName: row.agent_name,
    harness: row.harness,
    cwd: row.cwd,
    pid: row.pid,
    status: row.status as Session["status"],
    startedAt: row.started_at,
    lastSeenAt: row.last_seen_at,
    leaseExpiresAt: row.lease_expires_at,
    meta: parseJson<Record<string, unknown>>(row.meta, {}),
  };
}

/** EventRow → KanbanEvent */
export function toEvent(row: EventRow): KanbanEvent {
  return {
    seq: row.seq,
    ts: row.ts,
    sessionId: row.session_id,
    type: row.type as KanbanEvent["type"],
    taskId: row.task_id,
    planId: row.plan_id,
    projectKey: row.project_key,
    // 契约 §6：data 至少是 {}，保证 .data.pct 之类访问不炸
    data: parseJson<Record<string, unknown>>(row.data, {}),
  };
}

/** PlanRow → Plan */
export function toPlan(row: PlanRow): Plan {
  return {
    id: row.id,
    projectKey: row.project_key,
    scope: row.scope as Plan["scope"],
    taskId: row.task_id,
    version: row.version,
    title: row.title,
    body: row.body,
    status: row.status as Plan["status"],
    authorSessionId: row.author_session_id,
    createdAt: row.created_at,
    supersedesId: row.supersedes_id,
  };
}

/** HandoffRow → Handoff */
export function toHandoff(row: HandoffRow): Handoff {
  return {
    id: row.id,
    projectKey: row.project_key,
    taskId: row.task_id,
    sessionId: row.session_id,
    kind: row.kind as Handoff["kind"],
    summary: row.summary,
    nextStep: row.next_step,
    blockers: parseJson<string[]>(row.blockers, []),
    openQuestions: parseJson<string[]>(row.open_questions, []),
    createdAt: row.created_at,
    consumedBy: row.consumed_by,
    consumedAt: row.consumed_at,
  };
}

/** DepRow → TaskDep */
export function toDep(row: DepRow): TaskDep {
  return {
    taskId: row.task_id,
    dependsOnId: row.depends_on_id,
    createdAt: row.created_at,
  };
}

/**
 * Task → JSON 输出形状（snake_case，契约 §6 稳定性要求）。
 *
 * 注意：输出里**不包含** body 全文的大字段吗？不包含——CLI 人类可读输出也不打 body，
 * 需要时用 `task show` 的 --body 或 --json。这里省略是为了让 `task list --json` 足够轻，
 * 几百个任务也不至于灌爆 agent 上下文。
 */
export function taskToJson(task: Task): Record<string, unknown> {
  return {
    id: task.id,
    project: task.projectKey,
    title: task.title,
    status: task.status,
    priority: task.priority,
    progress: task.progress,
    assignee_session_id: task.assigneeSessionId,
    lease_expires_at: task.leaseExpiresAt,
    parent_id: task.parentId,
    plan_id: task.planId,
    labels: task.labels,
    checklist: {
      total: task.checklist.length,
      done: task.checklist.filter((c) => c.done).length,
    },
    block_reason: task.blockReason ?? null,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    started_at: task.startedAt,
    finished_at: task.finishedAt,
  };
}

/** Session → JSON 输出形状 */
export function sessionToJson(session: Session, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: session.id,
    agent_name: session.agentName,
    harness: session.harness,
    status: session.status,
    cwd: session.cwd,
    started_at: session.startedAt,
    last_seen_at: session.lastSeenAt,
    lease_expires_at: session.leaseExpiresAt,
    ...extra,
  };
}

/** 参数化查询的 IN 子句构造：把 ["a","b"] 变成 "?,?"，配合展开参数使用 */
export function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}

/** 统一的"任务不存在"错误（带上 project，便于定位是哪张看板上没有这张卡） */
export function taskNotFound(taskId: string, projectKey?: string): KanbanError {
  return KanbanError.state(
    `任务 ${taskId} 不存在${projectKey ? `（project: ${projectKey}）` : ""}`,
    {
      task_id: taskId,
      project: projectKey,
      hint: "用 `kanban task list` 查看现有任务；任务号形如 T-0007，且在每个 project 内**独立编号**",
    },
  );
}
