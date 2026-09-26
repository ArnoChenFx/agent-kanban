/**
 * 事件流：只追加、只查询。
 *
 * 事件是唯一事实来源（ADR-1），这里负责三件事：
 * 1. 追加（实际写入走 tx.ts 的 ctx.emit，保证与业务修改同事务）
 * 2. 查询（任务时间线、会话动态、待消费交接的来源）
 * 3. 节流心跳（避免每次 CLI 调用都写一条心跳，把事件表撑爆）
 */

import type { Database } from "bun:sqlite";
import { toEvent, type EventRow } from "./rows.ts";
import type { EventType, KanbanEvent } from "./types.ts";

/** 心跳事件的节流间隔：距上次落库不足 60s 就不再写 */
export const HEARTBEAT_THROTTLE_MS = 60_000;

/**
 * 记录心跳（带节流）。
 *
 * 为什么节流：agent 每跑一条 kanban 命令都会调用它，若每次都落库，
 * 一个上午就能产生几千条无信息量的心跳事件。60s 粒度足够判断"是否失联"。
 *
 * @returns 是否真的写入了一条事件
 */
export function recordHeartbeat(
  db: Database,
  sessionId: string,
  now: number,
  lastRecordedAt: number | null,
  projectKey = "default",
): boolean {
  if (lastRecordedAt !== null && now - lastRecordedAt < HEARTBEAT_THROTTLE_MS) {
    // 未过节流窗口：仍然刷新 last_seen_at（这是真正的防回收依据），但不写事件
    db.query("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(now, sessionId);
    return false;
  }
  db.query("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(now, sessionId);
  db.query(
    `INSERT INTO events (ts, session_id, type, task_id, plan_id, project_key, data)
     VALUES (?, ?, 'session_heartbeat', NULL, NULL, ?, '{}')`,
  ).run(now, sessionId, projectKey);
  return true;
}

/** 读某会话最近一次心跳事件的 ts（用于节流判断） */
export function lastHeartbeatTs(db: Database, sessionId: string): number | null {
  const row = db
    .query<{ ts: number | null }, [string]>(
      `SELECT ts FROM events WHERE session_id = ? AND type = 'session_heartbeat' ORDER BY seq DESC LIMIT 1`,
    )
    .get(sessionId);
  return row?.ts ?? null;
}

/** 取任务的完整事件时间线（正序，便于阅读“从哪来”） */
export function taskTimeline(
  db: Database,
  projectKey: string,
  taskId: string,
  opts: { tail?: number; sinceSeq?: number } = {},
): KanbanEvent[] {
  const rows = queryEvents(
    db,
    { projectKey, taskId, sinceSeq: opts.sinceSeq, order: "asc", limit: opts.tail },
  );
  return rows.map(toEvent);
}

/** 取任务的最近 N 条事件（倒序取，再反转为正序返回） */
export function taskRecentEvents(
  db: Database,
  projectKey: string,
  taskId: string,
  tail = 10,
): KanbanEvent[] {
  const rows = queryEvents(db, { projectKey, taskId, order: "desc", limit: tail });
  return rows.map(toEvent).reverse();
}

/** 取会话的事件动态（会话跳 project，因此不按 project 过滤） */
export function sessionTimeline(
  db: Database,
  sessionId: string,
  opts: { tail?: number; order?: "asc" | "desc" } = {},
): KanbanEvent[] {
  return queryEvents(db, {
    sessionId,
    order: opts.order ?? "desc",
    limit: opts.tail ?? 20,
  }).map(toEvent);
}

/** 事件查询条件 */
export interface EventQuery {
  /** 按 project 过滤（ADR-9）。不传则跨 project（仅 server 内部用） */
  projectKey?: string;
  taskId?: string;
  sessionId?: string;
  type?: EventType;
  /** 只取 seq 大于该值的事件（SSE 增量拉取用） */
  sinceSeq?: number;
  /** 只取 ts 大于等于该值的事件（按时间导出 journal 用） */
  sinceTs?: number;
  order?: "asc" | "desc";
  limit?: number;
}

/** 通用事件查询 */
export function queryEvents(db: Database, q: EventQuery): EventRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.projectKey) {
    where.push("project_key = ?");
    params.push(q.projectKey);
  }
  if (q.taskId) {
    where.push("task_id = ?");
    params.push(q.taskId);
  }
  if (q.sessionId) {
    where.push("session_id = ?");
    params.push(q.sessionId);
  }
  if (q.type) {
    where.push("type = ?");
    params.push(q.type);
  }
  if (q.sinceSeq !== undefined) {
    where.push("seq > ?");
    params.push(q.sinceSeq);
  }
  if (q.sinceTs !== undefined) {
    where.push("ts >= ?");
    params.push(q.sinceTs);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const orderSql = q.order === "desc" ? "DESC" : "ASC";
  // limit 缺省给一个大值：SSE 首次回放要拿全部历史
  const limit = q.limit ?? 1000;
  // 绑定值必须是 SQLite 允许的基础类型（不能用 unknown[]）
  const bindings = [...params, limit] as Array<string | number | null>;
  return db
    .query<EventRow, Array<string | number | null>>(
      `SELECT * FROM events ${whereSql} ORDER BY seq ${orderSql} LIMIT ?`,
    )
    .all(...bindings);
}

/** 取单个事件 */
export function getEvent(db: Database, seq: number): KanbanEvent | null {
  const row = db.query<EventRow, [number]>("SELECT * FROM events WHERE seq = ?").get(seq);
  return row ? toEvent(row) : null;
}

/** 统计事件总数（doctor / board 用） */
export function countEvents(db: Database, projectKey?: string): number {
  const row = projectKey
    ? db
        .query<{ c: number }, [string]>("SELECT COUNT(*) AS c FROM events WHERE project_key = ?")
        .get(projectKey)
    : db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM events").get();
  return row?.c ?? 0;
}

/**
 * 事件的人类可读单行摘要，用于 board 详情与 Web 时间线。
 * 只描述"发生了什么"，不解释因果（因果在 handoff 里）。
 */
export function describeEvent(event: KanbanEvent): string {
  const d = event.data;
  switch (event.type) {
    case "task_created":
      return `创建任务（p${d.priority ?? 2}）`;
    case "task_ready":
      return "移入待办";
    case "task_claimed":
      return d.prev_assignee ? `抢占（接手自 ${d.prev_assignee}）` : "抢占认领";
    case "task_released":
      return `释放${d.reason ? `：${d.reason}` : ""}`;
    case "task_reclaimed":
      return d.holder_crashed ? "持有者失联，已自动回收" : "强制回收";
    case "task_progress":
      return `进度 ${d.prev_pct ?? "?"}% → ${d.pct}%${d.note ? ` ${d.note}` : ""}`;
    case "task_note":
      return `备注：${d.text ?? ""}`;
    case "task_blocked":
      return `阻塞：${d.reason ?? ""}`;
    case "task_unblocked":
      return `自动解除阻塞（因 ${d.unblocked_by ?? "依赖完成"}）`;
    case "task_review":
      return `提交评审${d.note ? `：${d.note}` : ""}`;
    case "task_done":
      return `完成${d.note ? `：${d.note}` : ""}`;
    case "task_cancelled":
      return `取消：${d.reason ?? ""}`;
    case "task_reopened":
      return `重新打开：${d.reason ?? ""}`;
    case "task_updated":
      return `更新元信息：${Object.keys(d.fields ?? {}).join(", ")}`;
    case "dep_added":
      return `新增依赖 ${d.depends_on_id}`;
    case "dep_removed":
      return `移除依赖 ${d.depends_on_id}`;
    case "plan_created":
      return `保存计划 v${d.version}（${d.scope}）`;
    case "plan_superseded":
      return `计划 ${d.old_plan_id} 被新版本取代`;
    case "handoff_created":
      return `交接（${d.kind}）`;
    case "handoff_consumed":
      return `交接被 ${d.by_session} 接手`;
    case "session_started":
      return `会话启动（${d.agent_name ?? ""}）`;
    case "session_closed":
      return `会话关闭${d.summary ? `：${d.summary}` : ""}`;
    case "session_crashed":
      return `会话失联（超 ${Math.round(Number(d.grace_ms ?? 0) / 1000)}s 无心跳）`;
    default:
      return event.type;
  }
}
