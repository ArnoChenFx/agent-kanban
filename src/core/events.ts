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

// 曾有 recordHeartbeat / lastHeartbeatTs（心跳**事件**的节流写入与读取），已删除：
// 零调用点，且 `session_heartbeat` 事件从未被写入过。
//
// 为什么不需要它：防误回收的承重机制是 `sessions.last_seen_at`（每次调 Op 刷新，
// 见 sessions.ts 的 touchSession）。事件只是审计便利，而接通它只会让
// 「每分钟一条」的心跳事件挤进事件表——而 ADR-1 说事件流是唯一事实来源，
// 往里灌无信息量的噪声会让 rebuild / plan.at 这类按事件重放的功能变慢。
//
// EVENT_TYPES 里的 "session_heartbeat" 条目保留：它是已发布契约的一部分
// （外部系统可能写过这类事件），且 buildConflictError / buildCrashSummary
// 对它的过滤是「万一有就正确处理」，不构成依赖。

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
      return `created task (p${d.priority ?? 2})`;
    case "task_ready":
      return "moved to todo";
    case "task_removed":
      return "deleted";
    case "task_ready":
      return "moved to todo";
    case "task_claimed":
      return d.prev_assignee ? `claimed (taken over from ${d.prev_assignee})` : "claimed";
    case "task_released":
      return `released${d.reason ? `: ${d.reason}` : ""}`;
    case "task_reclaimed":
      return d.holder_crashed ? "holder lost contact, reclaimed automatically" : "force reclaimed";
    case "task_progress":
      // ⚠ pct 也给兵底（prev_pct 已有）：事件 payload 是各写入点手写的，
      //   漏一个字段就会在时间线上渲染出字面量 undefined（仓库明令禁止）。
      //   当前所有写入点都带 pct，这里是防御性的。
      return `progress ${d.prev_pct ?? "?"}% → ${d.pct ?? "?"}%${d.note ? ` ${d.note}` : ""}`;
    case "task_note":
      return `note: ${d.text ?? ""}`;
    case "task_blocked":
      return `blocked: ${d.reason ?? ""}`;
    case "task_unblocked":
      return `auto-unblocked (because ${d.unblocked_by ?? "dependencies completed"})`;
    case "task_review":
      return `submitted for review${d.note ? `: ${d.note}` : ""}`;
    case "task_done":
      return `done${d.note ? `: ${d.note}` : ""}`;
    case "task_cancelled":
      return `cancelled: ${d.reason ?? ""}`;
    case "task_reopened":
      return `reopened: ${d.reason ?? ""}`;
    case "task_updated":
      return `updated fields: ${Object.keys(d.fields ?? {}).join(", ")}`;
    case "dep_added":
      return `added dependency ${d.depends_on_id ?? "(unknown)"}`;
    case "dep_removed":
      return `removed dependency ${d.depends_on_id ?? "(unknown)"}`;
    case "plan_created":
      return `saved plan ${d.version !== undefined ? `v${d.version}` : "(unknown version)"} (${d.scope ?? "?"})`;
    // ⚠ 字段名曾经写成 `d.old_plan_id`，而 savePlan 发的 data 里是 `id`
    //   （以及完整的旧版本快照）。于是 `plan history` / `task show --timeline`
    //   打出「plan undefined superseded by a new version」——
    //   直接违反仓库自己的「输出里不许出现 undefined」规矩。
    //   拼上 version 是因为**项目级**计划的 id 只是 `PL-0001`，区分版本靠 version。
    case "plan_superseded": {
      const id = d.id ?? "（未知）";
      const v = d.version !== undefined ? ` v${d.version}` : "";
      return `plan ${id}${v} superseded by a new version`;
    }
    case "handoff_created":
      // ⚠ kind 藏在 data.handoff 里，不是 data.kind：handoff_created 携带**完整交接行**
      //   （rebuild 靠它重建 handoffs 表），字段都在 handoff 对象下。
      //   读顶层 d.kind 会渲染成 "handoff (undefined)" —— 正好撞上仓库那条
      //   「输出里不许出现 undefined」的规矩。
      return `handoff (${(d.handoff as { kind?: string } | undefined)?.kind ?? "voluntary"})`;
    case "handoff_consumed":
      return `handoff taken over by ${d.by_session ?? "(unknown)"}`;
    case "session_started":
      return `session started (${d.agent_name ?? ""})`;
    case "session_closed":
      return `session closed${d.summary ? `: ${d.summary}` : ""}`;
    case "session_crashed":
      return `session lost contact (no heartbeat for ${Math.round(Number(d.grace_ms ?? 0) / 1000)}s)`;
    case "session_started":
      return `session started (${d.agent_name ?? ""})`;
    case "session_closed":
      return `session closed${d.summary ? `: ${d.summary}` : ""}`;
    case "session_crashed":
      return `session lost contact (no heartbeat for ${Math.round(Number(d.grace_ms ?? 0) / 1000)}s)`;
    // 心跳事件从未写入（last_seen_at 才是防误回收的承重机制），
    // 但旧库里可能有，补一个 case 免得退回原始事件名
    case "session_heartbeat":
      return "heartbeat";
    // ---- 凭据 / 项目的审计事件（不是 rebuild 输入，见 types.ts 的注释）----
    // ⚠ 这些只记「发生了什么」，**绝不包含 key / key_hash**。
    case "token_issued":
      return `issued ${d.role ?? "?"} token for ${(d.projects as string[] | undefined)?.join(", ") || "(every project)"}`;
    case "token_revoked":
      return `revoked token ${d.token_ref ?? ""}`.trim();
    case "token_updated":
      return `token ${d.token_ref ?? ""} updated (${d.field ?? ""})`;
    case "project_created":
      return `created project ${d.key ?? ""}`;
    case "project_renamed":
      return `renamed project: ${d.from ?? ""} → ${d.to ?? ""}`;
    case "project_key_rotated":
      return "rotated the project key";
    // ---- 以下几类不面向用户可读的时间线，但必须有 case：缺了会退回原始事件名 ----
    case "board_exported":
      return "board exported";
    case "board_imported":
      return "board imported";
    case "snapshot_written":
      return "snapshot written";
    case "protocol_installed":
      return "collaboration protocol installed";
    default:
      return event.type;
  }
}
