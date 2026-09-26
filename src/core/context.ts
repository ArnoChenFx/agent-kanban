/**
 * 恢复上下文（ADR-7 L4）—— 本项目核心价值所在。
 *
 * agent 意外停止后要能"接上"，需要把三件事一次性交到新 agent 手上：
 *   1. **现场**（board.get）：现在有什么
 *   2. **历史**（handoff）：上一个 agent 做到哪、说了什么
 *   3. **建议**（next_actions）：我接下来该干什么
 *
 * `buildContext` 负责前两件事的组装，`resumeTask` 负责"接管 + 注入历史"，
 * 让 agent **用一条命令**就回到工作状态，而不是自己翻时间线推理。
 */

import type { Database } from "bun:sqlite";
import { KanbanError } from "./errors.ts";
import { buildBoard } from "./board.ts";
import { getConfig } from "./db.ts";
import { getProject, type Project } from "./projects.ts";
import { isStale, listSessions, toSessionView } from "./sessions.ts";
import { taskRecentEvents } from "./events.ts";
import {
  consumeHandoff,
  countPendingHandoffs,
  pendingHandoffs,
  taskHandoffs,
} from "./handoff.ts";
import {
  claimTask,
  countByStatus,
  getDependencies,
  getTask,
  getUnfinishedDeps,
  listTasks,
  requireTask,
  type Actor,
  type Scope,
} from "./tasks.ts";
import { withTx, type TxContext } from "./tx.ts";
import { toEvent } from "./rows.ts";
import type { Handoff, KanbanEvent, Task, TaskStatus } from "./types.ts";

/** 恢复上下文输入 */
export interface ContextInput {
  scope: Scope;
  now: number;
  graceMs: number;
  /** 当前会话（用于排除"自己写的交接"） */
  sessionId?: string | null;
  /** 时间线上取多少条 */
  tail?: number;
  /** 是否把待接手的交接标记为已消费（只读预览用 false） */
  consumeHandoffs?: boolean;
}

/** 恢复上下文输出（JSON 形状，与 CLI/MCP/HTTP 共用） */
export interface RecoveryContext {
  project: { key: string; name: string };
  generated_at: number;
  counts: Record<TaskStatus, number>;
  /** 失联会话告警（含它们持有的任务） */
  zombie_sessions: Array<{
    session_id: string;
    agent_name: string;
    last_seen_at: number;
    silent_minutes: number;
    tasks: Array<{ id: string; title: string; progress: number }>;
    suggestion: string;
  }>;
  /** 待接手的交接（按时间倒序） */
  pending_handoffs: Array<{
    id: number;
    task_id: string;
    task_title: string;
    from_session: string;
    kind: Handoff["kind"];
    summary: string;
    next_step: string | null;
    blockers: string[];
    open_questions: string[];
    created_at: number;
    created_relative: string;
    task_progress: number;
  }>;
  /** 本会话正在做的 */
  my_tasks: Array<{
    id: string;
    title: string;
    progress: number;
    remaining_checklist: string[];
    last_event: string | null;
    updated_relative: string;
  }>;
  /** 本 project 全部进行中（含其他会话的） */
  in_progress: Array<{
    id: string;
    title: string;
    progress: number;
    assignee: string | null;
    assignee_agent: string | null;
    stale_holder: boolean;
  }>;
  /** 阻塞中 */
  blocked: Array<{ id: string; title: string; reason: string | null }>;
  /** 可认领（依赖已满足、无人持有） */
  ready: Array<{ id: string; title: string; priority: number; reason: string }>;
  /** 建议的下一步（写给 agent 看） */
  next_actions: string[];
}

/**
 * 构建恢复上下文。
 *
 * 刻意**不返回任务全文与计划全文**：那会灌爆 agent 上下文。
 * 这里只给"该知道什么"，需要细节时 agent 自己调 `task.get` / `plan.show`。
 */
export function buildContext(input: ContextInput): RecoveryContext {
  const { scope, now, graceMs, tail = 20 } = input;
  const db = scope.db;
  const project: Project = getProject(db, scope.projectKey) ?? {
    key: scope.projectKey,
    name: scope.projectKey,
    rootPath: null,
    apiKeyHash: null,
    createdAt: 0,
    defaultTtlMs: null,
    graceMs: null,
  };

  // ---- 1. 会话与失联告警 ----
  const sessions = listSessions(db)
    .map((s) => toSessionView(db, s, { now, graceMs, projectKey: scope.projectKey }));
  const sessionById = new Map(sessions.map((s) => [s.id, s]));

  const zombie_sessions: RecoveryContext["zombie_sessions"] = [];
  for (const session of sessions) {
    if (session.status !== "active" && session.status !== "idle") continue;
    if (!isStale(session, now, graceMs)) continue;

    const heldTasks = listTasks(scope, { includeTerminal: false, limit: 500 }).filter(
      (t) => t.assigneeSessionId === session.id,
    );
    if (heldTasks.length === 0) continue;

    for (const task of heldTasks) {
      zombie_sessions.push({
        session_id: session.id,
        agent_name: session.agentName,
        last_seen_at: session.lastSeenAt,
        silent_minutes: Math.round((now - session.lastSeenAt) / 60000),
        tasks: [{ id: task.id, title: task.title, progress: task.progress }],
        suggestion: `运行 \`agent-kanban resume ${task.id}\` 接管（进度会自动保留）`,
      });
    }
  }

  // ---- 2. 待接手的交接 ----
  const pending = pendingHandoffs(scope, { sessionId: input.sessionId, limit: 20 });
  const pending_handoffs: RecoveryContext["pending_handoffs"] = pending.map((h) => {
    const task = getTask(scope, h.taskId);
    return {
      id: h.id,
      task_id: h.taskId,
      task_title: task?.title ?? "(任务已删除)",
      from_session: h.sessionId,
      kind: h.kind,
      summary: h.summary,
      next_step: h.nextStep,
      blockers: h.blockers,
      open_questions: h.openQuestions,
      created_at: h.createdAt,
      created_relative: relativeTimeOf(h.createdAt, now),
      task_progress: task?.progress ?? 0,
    };
  });

  // ---- 3. 本会话正在做的 ----
  // 注意 mine: true —— listTasks 的 sessionId 过滤需要它门控，否则会把别人的卡算进来
  const my_tasks: RecoveryContext["my_tasks"] = input.sessionId
    ? listTasks(scope, { status: "doing", mine: true, sessionId: input.sessionId, limit: 50 }).map((t) => {
        const events = taskRecentEvents(db, scope.projectKey, t.id, 3);
        const last = events[events.length - 1];
        return {
          id: t.id,
          title: t.title,
          progress: t.progress,
          remaining_checklist: t.checklist.filter((c) => !c.done).map((c) => c.text),
          last_event: last ? describeEventBrief(last) : null,
          updated_relative: relativeTimeOf(t.updatedAt, now),
        };
      })
    : [];

  // ---- 4. 全部进行中 ----
  const in_progress: RecoveryContext["in_progress"] = listTasks(scope, { status: "doing", limit: 100 }).map(
    (t) => {
      const holder = t.assigneeSessionId ? sessionById.get(t.assigneeSessionId) : undefined;
      return {
        id: t.id,
        title: t.title,
        progress: t.progress,
        assignee: t.assigneeSessionId,
        assignee_agent: holder?.agentName ?? null,
        stale_holder: holder ? isStale(holder, now, graceMs) : false,
      };
    },
  );

  // ---- 5. 阻塞 ----
  const blocked: RecoveryContext["blocked"] = listTasks(scope, { status: "blocked", limit: 50 }).map(
    (t) => ({ id: t.id, title: t.title, reason: t.blockReason ?? null }),
  );

  // ---- 6. 可认领 ----
  const ready: RecoveryContext["ready"] = listTasks(scope, {
    status: "todo",
    ready: true,
    limit: 20,
  })
    .filter((t) => {
      // 已被他人持有（租约未过期）的不算可认领
      if (!t.assigneeSessionId) return true;
      const holder = sessionById.get(t.assigneeSessionId);
      return holder ? isStale(holder, now, graceMs) : true;
    })
    .map((t) => ({
      id: t.id,
      title: t.title,
      priority: t.priority,
      reason: t.assigneeSessionId ? "原持有者已失联，可接管" : "依赖已满足",
    }));

  // ---- 7. 建议下一步 ----
  const nextActions = buildNextActions({
    sessionId: input.sessionId,
    zombie_sessions,
    pending_handoffs,
    my_tasks,
    in_progress,
    blocked,
    ready,
    projectKey: scope.projectKey,
  });

  return {
    project: { key: project.key, name: project.name },
    generated_at: now,
    counts: countByStatus(scope),
    zombie_sessions,
    pending_handoffs,
    my_tasks,
    in_progress,
    blocked,
    ready,
    next_actions: nextActions,
  };
}

/**
 * 生成建议动作。
 *
 * 排序依据是"阻塞新工作的时间"：先处理别人留下的烂摊子，再做自己的活，
 * 最后才是新任务。这与人的直觉一致，但 agent 不一定会自己这么排。
 */
function buildNextActions(input: {
  sessionId?: string | null;
  zombie_sessions: RecoveryContext["zombie_sessions"];
  pending_handoffs: RecoveryContext["pending_handoffs"];
  my_tasks: RecoveryContext["my_tasks"];
  in_progress: RecoveryContext["in_progress"];
  blocked: RecoveryContext["blocked"];
  ready: RecoveryContext["ready"];
  projectKey: string;
}): string[] {
  const actions: string[] = [];
  const { zombie_sessions, pending_handoffs, my_tasks, blocked, ready, projectKey } = input;

  // 1. 别人失联留下的卡（优先级最高：不处理会一直占着）
  const orphanTasks = new Set(zombie_sessions.map((z) => z.tasks[0]?.id).filter(Boolean) as string[]);
  if (orphanTasks.size > 0) {
    const ids = [...orphanTasks].slice(0, 3);
    actions.push(
      `接管失联会话留下的任务（进度已保留）：${ids.map((id) => `agent-kanban resume ${id}`).join(" / ")}`,
    );
  }

  // 2. 主动交接：上一个 agent 明确交代的
  const voluntary = pending_handoffs.filter((h) => h.kind === "voluntary");
  if (voluntary.length > 0) {
    const h = voluntary[0]!;
    actions.push(
      `读交接 #${h.id}（${h.task_id}）：${h.summary.slice(0, 60)}${h.summary.length > 60 ? "…" : ""}`,
    );
  }
  const crash = pending_handoffs.filter((h) => h.kind === "crash");
  if (crash.length > 0) {
    actions.push(
      `有 ${crash.length} 条崩溃自动交接待处理：${crash.map((h) => h.task_id).join(", ")}`,
    );
  }

  // 3. 自己正在做的（别丢下）
  if (my_tasks.length > 0) {
    actions.push(
      `继续你正在做的：${my_tasks.map((t) => `${t.id}(${t.progress}%)`).join(", ")}`,
    );
  }

  // 4. 阻塞（需要人处理，agent 只能提醒）
  if (blocked.length > 0) {
    actions.push(`有 ${blocked.length} 张卡阻塞中（可能需要人介入）：${blocked.map((b) => b.id).join(", ")}`);
  }

  // 5. 领新活
  if (my_tasks.length === 0 && ready.length > 0) {
    actions.push(
      `认领新任务：${ready.slice(0, 2).map((r) => `agent-kanban task claim ${r.id}`).join(" / ")}`,
    );
  } else if (ready.length > 0) {
    actions.push(`完成手上的后，可认领：${ready[0]!.id}`);
  }

  // 6. 兜底
  if (actions.length === 0) {
    actions.push("没有待办任务。可用 `agent-kanban task add \"标题\"` 新建，或 `agent-kanban board` 复查看板。");
  }

  void projectKey;
  return actions;
}

// =============================================================================
// resume：一条命令接管
// =============================================================================

export interface ResumeResult {
  task: {
    id: string;
    title: string;
    progress: number;
    status: string;
    lease_expires_at: number | null;
    remaining_checklist: string[];
  };
  /** 接管前是否发生了自动回收 */
  reclaimed: boolean;
  /** 原持有者 */
  previous_holder: { session_id: string; agent_name?: string | null } | null;
  /** 最近的交接（含内容，供 agent 立即上手） */
  handoff: {
    id: number;
    kind: Handoff["kind"];
    summary: string;
    next_step: string | null;
    blockers: string[];
    open_questions: string[];
    created_at: number;
  } | null;
  /** 最近事件时间线（短） */
  timeline: Array<{ ts: number; type: string; text: string }>;
  /** 建议动作（针对这张卡） */
  next_actions: string[];
  /** 完整计划（若任务有） */
  plan: { id: string; title: string; version: number } | null;
}

/**
 * 接管任务并注入恢复上下文。
 *
 * 允许接管的三种情况（与 claimTask 一致）：
 * 1. 无人持有
 * 2. 已被系统回收（持有者崩溃，状态已回 todo）
 * 3. 原持有者租约已过期（还没到回收时机，但事实已失联）
 *
 * `force` 可以抢仍在有效租约内的卡——**只应在人工确认后使用**，
 * 会留下 task_reclaimed 事件供审计。
 */
export function resumeTask(
  ctx: TxContext,
  taskId: string,
  actor: Actor,
  opts: { force?: boolean; tail?: number } = {},
): ResumeResult {
  const scope: Scope = { db: ctx.db, projectKey: ctx.projectKey };
  const db = ctx.db;
  const tail = opts.tail ?? 10;

  const before = requireTask(scope, taskId);
  const previousHolder = before.assigneeSessionId
    ? {
        session_id: before.assigneeSessionId,
        agent_name:
          db.query<{ agent_name: string }, [string]>("SELECT agent_name FROM sessions WHERE id = ?")
            .get(before.assigneeSessionId)?.agent_name ?? null,
      }
    : null;

  // 已被系统回收 = 原持有者崩溃过（事件里有痕迹）
  const wasReclaimed =
    (
      db
        .query<{ n: number }, [string, string, string]>(
          `SELECT COUNT(*) AS n FROM events
            WHERE task_id = ? AND type = 'task_reclaimed' AND seq > (
              SELECT COALESCE(MAX(seq), 0) FROM events
               WHERE task_id = ? AND type = 'task_claimed' AND session_id = ?
            )`,
        )
        .get(before.id, before.id, previousHolder?.session_id ?? "")?.n ?? 0
    ) > 0;

  // ---- 抢占（内部复用 claimTask 的原子逻辑）----
  const task = claimTask(ctx, taskId, actor, { force: opts.force, ttlMs: actor.ttlMs });

  // ---- 拉交接 ----
  // **优先用主动交接**：上一个 agent 认真写的信息量远大于系统自动合成的。
  // crash 合成只是兜底（agent 崩了，根本没机会写交接）。
  const handoffs = taskHandoffs(scope, task.id, 20);
  const latest =
    [...handoffs].reverse().find((h) => h.kind === "voluntary") ??
    handoffs[handoffs.length - 1] ??
    null;

  // ---- 消费交接：标记为"我接手了" ----
  // 全部未消费的都要标记：它们都是这张卡的历史，接手就该一次性结清
  let consumedHandoff: Handoff | null = null;
  if (actor.sessionId) {
    for (const h of handoffs) {
      if (h.consumedBy === null) {
        const consumed = consumeHandoff(ctx, h.id, actor.sessionId);
        consumedHandoff ??= consumed;
      }
    }
  }

  // ---- 时间线（短，供 agent 快速了解）----
  const events = taskRecentEvents(db, ctx.projectKey, task.id, tail);
  const timeline = events.map((e) => ({
    ts: e.ts,
    type: e.type,
    text: describeEventBrief(e),
  }));

  // ---- 当前计划 ----
  const plan = task.planId
    ? db
        .query<{ id: string; title: string; version: number }, [string]>(
          "SELECT id, title, version FROM plans WHERE id = ?",
        )
        .get(task.planId) ?? null
    : null;

  const remaining = task.checklist.filter((c) => !c.done).map((c) => c.text);

  return {
    task: {
      id: task.id,
      title: task.title,
      progress: task.progress,
      status: task.status,
      lease_expires_at: task.leaseExpiresAt,
      remaining_checklist: remaining,
    },
    reclaimed: wasReclaimed,
    previous_holder: previousHolder,
    handoff: latest
      ? {
          id: latest.id,
          kind: latest.kind,
          summary: latest.summary,
          next_step: latest.nextStep,
          blockers: latest.blockers,
          open_questions: latest.openQuestions,
          created_at: latest.createdAt,
        }
      : null,
    timeline,
    plan: plan ? { id: plan.id, title: plan.title, version: plan.version } : null,
    next_actions: buildResumeActions(task.id, task.progress, remaining, latest, plan),
  };
}

/** 接管后给 agent 的具体指令 */
function buildResumeActions(
  taskId: string,
  progress: number,
  remaining: string[],
  handoff: Handoff | null,
  plan: { id: string } | null,
): string[] {
  const actions: string[] = [];

  // 先读交接/计划（避免重复劳动）
  if (handoff) {
    actions.push(`交接（${handoff.kind === "crash" ? "崩溃自动合成" : "主动"}）：${handoff.summary}`);
    if (handoff.nextStep) actions.push(handoff.nextStep);
    for (const q of handoff.openQuestions) {
      actions.push(`待确认：${q}`);
    }
  }
  if (plan) {
    actions.push(`读计划全文：agent-kanban plan show ${plan.id}`);
  }
  if (remaining.length > 0) {
    actions.push(`剩余工作：${remaining.join("、")}`);
  } else if (progress < 100) {
    actions.push(`checklist 已全部勾选但进度 ${progress}%，先确认实际完成情况`);
  }

  actions.push(`推进时更新进度：agent-kanban task progress ${taskId} --pct <数字> --note "<做了什么>"`);
  actions.push(`收工前写交接：agent-kanban handoff --task ${taskId} --summary "..." --next "..."`);

  return actions;
}

// =============================================================================
// 工具
// =============================================================================

/** 事件的一句话描述（短版，与 events.describeEvent 类似但更紧凑） */
function describeEventBrief(event: KanbanEvent): string {
  const d = event.data;
  switch (event.type) {
    case "task_created": return "创建任务";
    case "task_claimed": return d.prev_assignee ? `被 ${d.prev_assignee} 抢占` : "认领";
    case "task_progress": return `进度 ${d.prev_pct ?? "?"}% → ${d.pct}%${d.note ? `：${d.note}` : ""}`;
    case "task_note": return `备注：${String(d.text ?? "").slice(0, 50)}`;
    case "task_blocked": return `阻塞：${d.reason ?? ""}`;
    case "task_unblocked": return "自动解除阻塞";
    case "task_reclaimed": return d.holder_crashed ? "持有者失联，被自动回收" : "被强制回收";
    case "task_released": return "被释放";
    case "task_review": return "提交评审";
    case "task_done": return "完成";
    case "task_cancelled": return "取消";
    case "task_reopened": return "重新打开";
    case "handoff_created": return `写了交接（${d.kind}）`;
    case "handoff_consumed": return `交接被 ${d.by_session} 接手`;
    case "dep_added": return `新增依赖 ${d.depends_on_id}`;
    case "dep_removed": return `移除依赖 ${d.depends_on_id}`;
    case "plan_created": return `保存计划 v${d.version}`;
    case "task_updated": return "更新元信息";
    default: return event.type;
  }
}

/** 相对时间（与 format.relativeTime 同源，避免多引依赖） */
function relativeTimeOf(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min}m 前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}h 前`;
  return `${Math.floor(hour / 24)}d 前`;
}

/** 供 command 层使用：在事务里执行 resume */
export function runResume(
  db: Database,
  actor: Actor,
  projectKey: string,
  taskId: string,
  opts: { force?: boolean; tail?: number } = {},
): ResumeResult {
  return withTx(
    db,
    (ctx) => resumeTask(ctx, taskId, actor, opts),
    { now: () => actor.now, sessionId: actor.sessionId, projectKey },
  );
}

/** context 里的可消费交接数量（board 顶部提示用） */
export { countPendingHandoffs, getDependencies, getUnfinishedDeps, buildBoard, getConfig };
