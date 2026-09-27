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

/**
 * 泳道一次最多取多少张卡。
 *
 * 曾经这里是写死的 500 且**静默截断**：一个 620 张卡的 project，界面计数显示 620
 * （`counts` 来自全量 `countByStatus`），但只渲染 500，**没有任何提示**。
 * 看着像“卡丢了”。
 *
 * 现在：截断一定会随快照一起报出去（`truncated`），且 `board.get` Op 支持
 * `limit` / `offset`，前端可以拉下一页。
 */
export const BOARD_PAGE_SIZE = 500;

/**
 * `limit` 的硬上界（看板与任务列表**共用**）。
 *
 * 为什么必须有：SQLite 里 `LIMIT -1` 是**不限长**、`LIMIT 1e9` 会真的去扫那么多行。
 * `/api/op` 与 `/api/board` 面前都是未信任的输入，没有上界时一个手滑（或恶意）的
 * 请求就把整库塞进一个 HTTP 响应。
 *
 * 曾经这个数字在四个地方各写一遍（core 两处、http 一处、前端一处），于是「上界是多少」
 * 有四个可能互相矛盾的真相。现在这里是唯一出处。
 */
export const PAGE_LIMIT_MAX = 2000;

/**
 * `offset` 的硬上界。同样是防止有人把 offset 调到天文数字逼着 SQLite 干等。
 */
export const PAGE_OFFSET_MAX = 1_000_000;

/** 构建看板快照（强制按 project 过滤） */
export function buildBoard(
  scope: Scope,
  opts: { now?: number; includeTerminal?: boolean; graceMs?: number; limit?: number; offset?: number } = {},
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

  const limit = opts.limit ?? BOARD_PAGE_SIZE;
  const offset = opts.offset ?? 0;
  const tasks = listTasks(scope, {
    includeTerminal: opts.includeTerminal ?? true,
    sort: "priority",
    limit,
    offset,
  });

  const lanes = Object.fromEntries(
    LANE_ORDER.map((status) => [status, tasks.filter((t) => t.status === status)]),
  ) as Record<TaskStatus, Task[]>;

  // cancelled 不进泳道（无信息量），但计数里保留
  const counts = countByStatus(scope);

  // 截断信息：**必须报出去**，否则「计数 620 / 只显示 500」看着像卡丢了。
  // total 是所有非终态泳道卡的总数（不含 cancelled，与 lanes 的口径一致）。
  const totalInLanes = LANE_ORDER.reduce((sum, s) => sum + counts[s], 0);
  const showing = tasks.length;
  const truncated = offset === 0 && showing < totalInLanes;

  // 会话视图：会话跳 project，所以这里不做 project 过滤——
  // 需要知道"是谁持有本 project 的卡"，而持有人可能是跨项目工作的 agent
  const sessions = listSessions(db).map((s) => toSessionView(db, s, { now, graceMs, projectKey: scope.projectKey }));

  return {
    project: { name: project.name, key: project.key, createdAt: project.createdAt || null },
    counts,
    lanes,
    sessions,
    /**
     * 截断信息。`truncated` 只在**首页**（offset=0）为真——
     * 翻页时它当然也不完整，但那时调用方是「主动在翻」，不是在看完整看板。
     */
    truncated: { total: totalInLanes, showing, limit, offset, truncated },
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
