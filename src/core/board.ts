/**
 * 看板快照：把散落的任务、会话、事件汇成一份可直接渲染的数据。
 *
 * CLI 的 `agent-kanban board`、Web 首屏 /api/board、MCP 的 kanban_board 共用这个函数，
 * 保证三处看到的数据形状完全一致（ADR-6）。
 */

import type { Database } from "bun:sqlite";
import { countByStatus, listTasks, type Scope } from "./tasks.ts";
import { getConfig } from "./db.ts";
import { getProject, type Project } from "./projects.ts";
import { isStale, listSessions, toSessionView } from "./sessions.ts";
import { headSeq } from "./tx.ts";
import { taskToJson } from "./rows.ts";
import type { BoardSnapshot, Task, TaskStatus } from "./types.ts";

/** board 泳道顺序：与人的心智模型一致（想做的 → 在做的 → 卡住的 → 做完了） */
export const LANE_ORDER: TaskStatus[] = ["backlog", "todo", "doing", "blocked", "review", "done"];

/** 构建看板快照（强制按 project 过滤） */
export function buildBoard(
  scope: Scope,
  opts: { now?: number; includeTerminal?: boolean; graceMs?: number } = {},
): BoardSnapshot {
  const now = opts.now ?? Date.now();
  const db = scope.db;
  const config = getConfig(db);
  const project: Project = getProject(db, scope.projectKey) ?? {
    key: scope.projectKey,
    name: scope.projectKey,
    rootPath: null,
    apiKeyHash: null,
    createdAt: 0,
    defaultTtlMs: null,
    graceMs: null,
  };
  const graceMs = project.graceMs ?? opts.graceMs ?? config.graceMs;

  const tasks = listTasks(scope, {
    includeTerminal: opts.includeTerminal ?? true,
    sort: "priority",
    limit: 500,
  });

  const lanes = Object.fromEntries(
    LANE_ORDER.map((status) => [status, tasks.filter((t) => t.status === status)]),
  ) as Record<TaskStatus, Task[]>;

  // cancelled 不进泳道（无信息量），但计数里保留
  const counts = countByStatus(scope);

  // 会话视图：会话跳 project，所以这里不做 project 过滤——
  // 需要知道"是谁持有本 project 的卡"，而持有人可能是跨项目工作的 agent
  const sessions = listSessions(db).map((s) => toSessionView(db, s, { now, graceMs, projectKey: scope.projectKey }));

  return {
    project: { name: project.name, key: project.key, createdAt: project.createdAt || null },
    counts,
    lanes,
    sessions,
    headSeq: headSeq(db, scope.projectKey),
  };
}

/** 泳道里的全部任务（flatten），供 CLI 与 Web 遍历 */
export function boardTasks(snapshot: BoardSnapshot): Task[] {
  return LANE_ORDER.flatMap((status) => snapshot.lanes[status] ?? []);
}

/** 找出需要人关注的会话（失联但仍持有本 project 的任务） */
export function findZombieSessions(snapshot: BoardSnapshot, graceMs: number, now: number): string[] {
  return snapshot.sessions
    .filter(
      (s) =>
        (s.status === "active" || s.status === "idle") &&
        isStale(s, now, graceMs) &&
        s.tasks.length > 0,
    )
    .map((s) => s.id);
}
