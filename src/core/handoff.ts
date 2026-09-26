/**
 * Handoff —— agent 之间的上下文交接（ADR-7）。
 *
 * 为什么它是"一等公民"而不是让新 agent 去翻时间线：
 * 时间线有几十条事件，新 agent 要自己推断"做到哪了、接下来该干什么"，
 * 而这正是崩溃恢复最容易出错的地方。交接把答案**结构化地写下来**。
 *
 * 两种来源：
 * 1. **voluntary（主动）**：agent 收工前自己写 —— summary/next 质量最高
 * 2. **crash（崩溃自动合成）**：持有者失联后由系统从事件流反推 ——
 *    不需要崩溃的 agent 配合（它已经死了），但内容是机器生成的，措辞更机械
 *
 * 消费语义：`consumed_by` 标记"谁接手了"。新会话读 context 时能看到
 * "这是给你的交接"与"这条已被别人处理过"的区别。
 */

import type { Database } from "bun:sqlite";
import { KanbanError } from "./errors.ts";
import { toEvent, toHandoff, type HandoffRow } from "./rows.ts";
import { taskRecentEvents, queryEvents } from "./events.ts";
import { requireTask, type Scope } from "./tasks.ts";
import { withTx, type TxContext } from "./tx.ts";
import type { Handoff, KanbanEvent } from "./types.ts";

/** 写交接的输入 */
export interface WriteHandoffInput {
  taskId: string;
  sessionId: string;
  /** 做了什么（必填：没有它交接就没意义） */
  summary: string;
  /** 建议下一步 */
  nextStep?: string | null;
  blockers?: string[];
  openQuestions?: string[];
  kind?: Handoff["kind"];
}

/**
 * 写一条交接（必须在写事务内）。
 * 返回新建的 handoff。
 */
export function writeHandoff(ctx: TxContext, input: WriteHandoffInput): Handoff {
  const task = requireTask({ db: ctx.db, projectKey: ctx.projectKey }, input.taskId);

  const summary = input.summary.trim();
  if (summary.length === 0) {
    throw KanbanError.usage(
      "handoff summary must not be empty",
      'Usage: agent-kanban handoff --task T-0007 --summary "finished X, blocked on Y" --next "then do Z"',
      { reason: "empty_handoff_summary" },
    );
  }

  const id = insertHandoff(ctx, {
    taskId: task.id,
    sessionId: input.sessionId,
    kind: input.kind ?? "voluntary",
    summary,
    nextStep: input.nextStep?.trim() || null,
    blockers: input.blockers ?? [],
    openQuestions: input.openQuestions ?? [],
  });

  ctx.emit({
    type: "handoff_created",
    taskId: task.id,
    // 携带**完整交接行**（而不是部分字段）：rebuild 只需 handoff_created 就能重建 handoffs 表。
    // 注意 session_id 写在 data 里而不是只靠 events.session_id：
    // crash 合成的事件本身是 system 发出的，交接归属的却是原持有者。
    data: {
      handoff: {
        id,
        task_id: task.id,
        session_id: input.sessionId,
        kind: input.kind ?? "voluntary",
        summary: input.summary,
        next_step: input.nextStep ?? null,
        blockers: input.blockers ?? [],
        open_questions: input.openQuestions ?? [],
        created_at: ctx.now(),
        consumed_by: null,
      },
    },
  });

  return requireHandoff(ctx.db, id);
}

/** 插入 handoff 行（内部使用） */
function insertHandoff(
  ctx: TxContext,
  input: {
    taskId: string;
    sessionId: string;
    kind: Handoff["kind"];
    summary: string;
    nextStep: string | null;
    blockers: string[];
    openQuestions: string[];
  },
): number {
  // 绑定值统一用宽松类型（string | number | null），避开 bun:sqlite 元组长度的推断坑
  const bindings: Array<string | number | null> = [
    ctx.projectKey,
    input.taskId,
    input.sessionId,
    input.kind,
    input.summary,
    input.nextStep,
    JSON.stringify(input.blockers),
    JSON.stringify(input.openQuestions),
    ctx.now(),
  ];
  const result = ctx.db
    .query<{ id: number }, Array<string | number | null>>(
      `INSERT INTO handoffs
         (project_key, task_id, session_id, kind, summary, next_step, blockers, open_questions, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(...bindings);
  return Number(result.lastInsertRowid);
}

/** 按 id 取交接 */
export function getHandoff(db: Database, id: number): Handoff | null {
  const row = db.query<HandoffRow, [number]>("SELECT * FROM handoffs WHERE id = ?").get(id);
  return row ? toHandoff(row) : null;
}

function requireHandoff(db: Database, id: number): Handoff {
  const handoff = getHandoff(db, id);
  if (!handoff) {
    throw KanbanError.state(`handoff not found: #${id}`, {
      reason: "handoff_not_found",
      handoff_id: id,
    });
  }
  return handoff;
}

/** 某任务的全部交接（正序，便于读"交接史"） */
export function taskHandoffs(scope: Scope, taskId: string, limit = 50): Handoff[] {
  return scope.db
    .query<HandoffRow, [string, string, number]>(
      "SELECT * FROM handoffs WHERE project_key = ? AND task_id = ? ORDER BY id ASC LIMIT ?",
    )
    .all(scope.projectKey, taskId, limit)
    .map(toHandoff);
}

/**
 * 待接手的交接（尚未被任何人消费）。
 * 按时间倒序：最新的交接最能代表当前现场。
 */
export function pendingHandoffs(
  scope: Scope,
  opts: { sessionId?: string | null; limit?: number } = {},
): Handoff[] {
  // 排除"当前会话自己写的"：agent 不需要接手自己刚写的交接
  const excludeSelf = opts.sessionId
    ? "AND session_id != ?"
    : "";
  const params: Array<string | number> = [scope.projectKey];
  if (opts.sessionId) params.push(opts.sessionId);
  params.push(opts.limit ?? 20);

  return scope.db
    .query<HandoffRow, Array<string | number>>(
      `SELECT * FROM handoffs
        WHERE project_key = ? AND consumed_by IS NULL ${excludeSelf}
        ORDER BY id DESC LIMIT ?`,
    )
    .all(...params)
    .map(toHandoff);
}

/** 标记交接已被消费 */
export function consumeHandoff(
  ctx: TxContext,
  handoffId: number,
  consumerSessionId: string,
): Handoff {
  const handoff = requireHandoff(ctx.db, handoffId);
  if (handoff.consumedBy !== null) {
    // 已被消费：不是错误（可能两个 agent 同时读），但要告知事实
    return handoff;
  }
  ctx.db
    .query("UPDATE handoffs SET consumed_by = ?, consumed_at = ? WHERE id = ? AND consumed_by IS NULL")
    .run(consumerSessionId, ctx.now(), handoffId);
  ctx.emit({
    type: "handoff_consumed",
    taskId: handoff.taskId,
    data: { handoff_id: handoffId, by_session: consumerSessionId },
  });
  return requireHandoff(ctx.db, handoffId);
}

// =============================================================================
// 崩溃自动合成
// =============================================================================

/**
 * 从事件流自动合成崩溃交接。
 *
 * 这是 M2 最关键的一段：**崩溃的 agent 已经死了，不可能让它写交接**，
 * 所以系统必须能从"它做过什么"反推出"做到哪了、接着干什么"。
 *
 * 合成规则（全部基于已有事件，不猜测）：
 * - summary：最后几个动作 + 进度 + 最后活动时间
 * - next：checklist 里未完成的项（这是新 agent 最需要的）
 * - open_questions：从最近的 note 里抽取问号结尾的句子（启发式，但明确标注来源）
 *
 * @param reason 触发原因（正常由 reapZombies 调用）
 */
export function synthesizeCrashHandoff(
  db: Database,
  input: {
    projectKey: string;
    taskId: string;
    sessionId: string;
    /** 最后心跳时间（epoch ms） */
    lastSeenAt: number;
    /** 失联时长（毫秒） */
    silentMs: number;
    now: number;
  },
): Handoff {
  const scope: Scope = { db, projectKey: input.projectKey };
  const task = requireTask(scope, input.taskId);
  const events = taskRecentEvents(db, input.projectKey, task.id, 12);

  // ---- summary：人话描述"做到哪了" ----
  const summary = buildCrashSummary(task, events, input.silentMs);

  // ---- next：未完成的 checklist 项 ----
  const remaining = task.checklist.filter((c) => !c.done).map((c) => c.text);
  const nextStep =
    remaining.length > 0
      ? `Continue from ${task.progress}%. Remaining: ${remaining.join(", ")}`
      : task.progress < 100
        ? `Continue from ${task.progress}% (the checklist is fully ticked; confirm it is really done)`
        : `Progress is at ${task.progress}%; confirm it is really done before deciding between done and continuing`;

  // ---- open_questions：从最近 note 里抽问号句 ----
  const openQuestions = extractQuestions(events);

  // ---- blockers：接手方最需要先知道的“为什么会到我手上” ----
  // 任务本身不一定处于 blocked（回收后已回到 todo），但“原持有者失联”本身就是阻塞信息，
  // 不写进去会让接手方误以为这是正常排队到自己手上的卡。
  const silentMins = Math.round(input.silentMs / 60000);
  const silentText = formatSilent(silentMins);
  const blockers: string[] = [
    `the previous holder ${input.sessionId} went silent (${silentText} without a heartbeat, the process may have crashed)`,
  ];
  if (task.blockReason) blockers.push(task.blockReason);

  const row = db
    .query<{ id: number }, [string, string, string, string, string | null, string, string, number]>(
      `INSERT INTO handoffs
         (project_key, task_id, session_id, kind, summary, next_step, blockers, open_questions, created_at)
       VALUES (?, ?, ?, 'crash', ?, ?, ?, ?, ?)`,
    )
    .run(
      input.projectKey,
      task.id,
      input.sessionId,
      summary,
      nextStep,
      JSON.stringify(blockers),
      JSON.stringify(openQuestions),
      input.now,
    );

  const handoffId = Number(row.lastInsertRowid);
  db.query(
    `INSERT INTO events (ts, session_id, type, task_id, plan_id, project_key, data)
     VALUES (?, 'system', 'handoff_created', ?, NULL, ?, ?)`,
  ).run(
    input.now,
    task.id,
    input.projectKey,
    // 与 writeHandoff 保持同一形状：完整交接行
    JSON.stringify({
      handoff: {
        id: handoffId,
        task_id: task.id,
        session_id: input.sessionId,
        kind: "crash",
        summary,
        next_step: nextStep,
        blockers,
        open_questions: openQuestions,
        created_at: input.now,
        consumed_by: null,
      },
    }),
  );

  return requireHandoff(db, handoffId);
}

/** 合成 summary：进度 + 最后几个动作 + 失联时长 */
function buildCrashSummary(task: { progress: number; title: string }, events: KanbanEvent[], silentMs: number): string {
  const mins = Math.round(silentMs / 60000);
  const silentText = formatSilent(mins);

  // 取最后 3 个有信息量的动作
  // 排除两类噪声事件：
  //   session_heartbeat —— 只是心跳，不是工作
  //   task_reclaimed   —— 回收本身就发生在合成之前，接手方看到"被回收"是废话
  const actions = events
    .filter((e) => e.type !== "session_heartbeat" && e.type !== "task_reclaimed")
    .slice(-3)
    .map(describeAction)
    .filter((s) => s.length > 0);

  const actionText =
    actions.length > 0 ? `Last actions: ${actions.join("; ")}` : "Last actions: unknown (no events recorded)";
  return `${task.title}: progress ${task.progress}%, the holder went silent (${silentText} without a heartbeat). ${actionText}`;
}

/** 失联时长的人话（小时 / 分钟） */
function formatSilent(mins: number): string {
  return mins >= 60 ? `${Math.round(mins / 60)} hour(s)` : `${mins} min`;
}

/** 单个事件的一句话描述（与 events.describeEvent 同源但更短） */
function describeAction(event: KanbanEvent): string {
  const d = event.data;
  switch (event.type) {
    case "task_claimed":
      return "claimed the task";
    case "task_progress":
      return `progress updated to ${d.pct}%${d.note ? ` (${d.note})` : ""}`;
    case "task_note":
      return `note: ${truncateText(String(d.text ?? ""), 40)}`;
    case "task_blocked":
      return `marked blocked: ${d.reason ?? ""}`;
    case "task_reclaimed":
      return "reclaimed";
    case "handoff_created":
      return "wrote a handoff";
    default:
      return event.type;
  }
}

/**
 * 从事件里抽取"待确认的问题"。
 *
 * 启发式：note 里以 ？/? 结尾的句子。这类问题往往是上一个 agent 留给人的，
 * 崩溃后更需要显式地传给下一个。
 */
function extractQuestions(events: KanbanEvent[]): string[] {
  const questions: string[] = [];
  for (const event of events) {
    if (event.type !== "task_note") continue;
    const text = String(event.data.text ?? "");
    for (const line of text.split(/[\n。；;]/)) {
      const trimmed = line.trim();
      if (trimmed.length > 0 && /[?？]\s*$/.test(trimmed)) {
        questions.push(trimmed);
      }
    }
  }
  return questions.slice(0, 5); // 最多 5 条，避免交接块过长
}

function truncateText(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

/** 取某 project 最近的交接（审计/上下文用） */
export function recentHandoffs(scope: Scope, limit = 10): Handoff[] {
  return scope.db
    .query<HandoffRow, [string, number]>(
      "SELECT * FROM handoffs WHERE project_key = ? ORDER BY id DESC LIMIT ?",
    )
    .all(scope.projectKey, limit)
    .map(toHandoff);
}

/** 统计待接手数量（board 上显示提醒） */
export function countPendingHandoffs(scope: Scope): number {
  return (
    scope.db
      .query<{ c: number }, [string]>(
        "SELECT COUNT(*) AS c FROM handoffs WHERE project_key = ? AND consumed_by IS NULL",
      )
      .get(scope.projectKey)?.c ?? 0
  );
}

void queryEvents;
