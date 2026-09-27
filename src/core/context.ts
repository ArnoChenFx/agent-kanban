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
// 凭据事件的掩码规则与 events.ts / tokens.ts 同源（老库里 token_ref 可能是明文密钥）
import { describeTokenRef } from "./tokens.ts";
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
}

/**
 * 一条建议的**机器可读**形态：稳定代号 + 插值参数。
 *
 * 为什么已经有纯文本的 `next_actions` 还要这一份：那些串是写给 agent 看的
 * （CLI / MCP / `--json`），而 Web 看板是给**人**看的多语言界面。把它们
 * 直接塞进英文界面，等于让界面替 agent 说话；可在前端翻成英文，那条纯文本
 * 又会变成词典之外的第二份真相。折中办法是同一份建议同时给出
 * 「代号 + 参数」和多语言渲染结果，顺序、数量、措辞都不可能各自漂移。
 *
 * 代号是**契约**：前端按它选词典条目，后端新增代号而前端没翻，
 * 界面上会退回展示后端的中文串（而不是白屏或漏掉这条建议）。
 */
export type NextActionCode =
  /** 接管失联会话留下的卡（进度保留） */
  | "takeover"
  /** 读上一位 agent 主动写的交接 */
  | "read_handoff"
  /** 有崩溃自动合成的交接还没人接手 */
  | "crash_handoffs"
  /** 继续自己手上正在做的卡 */
  | "continue_mine"
  /** 有卡阻塞中，agent 只能提醒，得有人介入 */
  | "blocked_needs_human"
  /** 直接领新活 */
  | "claim_new"
  /** 手上还有活，先干完再领 */
  | "claim_after"
  /** 看板是空的，给条兜底建议 */
  | "idle";

/** 建议的插值参数。数组留给界面按语言拼接，不在这里拼死标点。 */
export interface NextActionArgs {
  /** 数量（"有 N 张卡…"这类句式） */
  n?: number;
  /** 交接号 / 任务号，按代号而定 */
  id?: number | string;
  /** 任务号 */
  task?: string;
  /** 交接摘要（已在后端截断，两种语言看到的长度一致） */
  summary?: string;
  /** 任务号或 `T-0001(40%)` 这类片段，按本地标点列举 */
  tasks?: string[];
  /** 可直接执行的命令行，按 " / " 列举（代码之间用斜杠，与语言无关） */
  commands?: string[];
}

export interface NextActionItem {
  code: NextActionCode;
  args: NextActionArgs;
}

/**
 * 待接手交接在 context 里最多列多少条。
 *
 * 以前写死 20；现在提成常量，因为消费侧（ops.ts）要按**同一个上限**去核对
 * 「返回了哪些」，两边不一致就会漏或多消费。
 */
export const PENDING_HANDOFF_LIMIT = 20;

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
  /** 建议的下一步（写给 agent 看的纯文本串，由 next_action_items 渲染而来） */
  next_actions: string[];
  /** 同一批建议的结构化形态：界面按 code 选词典条目自己拼文案 */
  next_action_items: NextActionItem[];
}

/**
 * 构建恢复上下文。
 *
 * 刻意**不返回任务全文与计划全文**：那会灌爆 agent 上下文。
 * 这里只给"该知道什么"，需要细节时 agent 自己调 `task.get` / `plan.show`。
 */
export function buildContext(input: ContextInput): RecoveryContext {
  const { scope, now, graceMs } = input;
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
        suggestion: `Run \`agent-kanban resume ${task.id}\` to take it over (progress is kept automatically)`,
      });
    }
  }

  // ---- 2. 待接手的交接 ----
  //
  // ⚠ 本函数**只读不写**：交接的消费由调用方（ops.ts 的 context.get）负责，
  //   而且只能消费**本次返回的这些**。以前这里是另一回事：
  //   调用方读完 context 之后又调了一次 pendingHandoffs 去消费，
  //   两次查询之间新到的交接会被「消费掉但 agent 从没看到过」——
  //   既没有交接被读，也没有交接还挂着，等于凭空丢一条。
  const pending = pendingHandoffs(scope, { sessionId: input.sessionId, limit: PENDING_HANDOFF_LIMIT });
  const pending_handoffs: RecoveryContext["pending_handoffs"] = pending.map((h) => {
    const task = getTask(scope, h.taskId);
    return {
      id: h.id,
      task_id: h.taskId,
      task_title: task?.title ?? "(task deleted)",
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
      reason: t.assigneeSessionId
        ? "the previous holder lost contact, you can take over"
        : "dependencies are satisfied",
    }));

  // ---- 7. 建议下一步 ----
  const nextActionItems = buildNextActions({
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
    next_actions: nextActionItems.map(renderNextAction),
    next_action_items: nextActionItems,
  };
}

/**
 * 生成建议动作（结构化）。
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
}): NextActionItem[] {
  const actions: NextActionItem[] = [];
  const { zombie_sessions, pending_handoffs, my_tasks, blocked, ready, projectKey } = input;

  // 1. 别人失联留下的卡（优先级最高：不处理会一直占着）
  const orphanTasks = new Set(zombie_sessions.map((z) => z.tasks[0]?.id).filter(Boolean) as string[]);
  if (orphanTasks.size > 0) {
    actions.push({
      code: "takeover",
      args: { commands: [...orphanTasks].slice(0, 3).map((id) => `agent-kanban resume ${id}`) },
    });
  }

  // 2. 主动交接：上一个 agent 明确交代的
  const voluntary = pending_handoffs.filter((h) => h.kind === "voluntary");
  if (voluntary.length > 0) {
    const h = voluntary[0]!;
    actions.push({
      code: "read_handoff",
      args: {
        id: h.id,
        task: h.task_id,
        // 截断放在构建期：纯文本串与前端各自拼文案，但两边看到的摘要长度一致
        summary: h.summary.slice(0, 60) + (h.summary.length > 60 ? "…" : ""),
      },
    });
  }
  const crash = pending_handoffs.filter((h) => h.kind === "crash");
  if (crash.length > 0) {
    actions.push({
      code: "crash_handoffs",
      args: { n: crash.length, tasks: crash.map((h) => h.task_id) },
    });
  }

  // 3. 自己正在做的（别丢下）
  if (my_tasks.length > 0) {
    actions.push({
      code: "continue_mine",
      args: { tasks: my_tasks.map((t) => `${t.id}(${t.progress}%)`) },
    });
  }

  // 4. 阻塞（需要人处理，agent 只能提醒）
  if (blocked.length > 0) {
    actions.push({
      code: "blocked_needs_human",
      args: { n: blocked.length, tasks: blocked.map((b) => b.id) },
    });
  }

  // 5. 领新活
  if (my_tasks.length === 0 && ready.length > 0) {
    actions.push({
      code: "claim_new",
      args: { commands: ready.slice(0, 2).map((r) => `agent-kanban task claim ${r.id}`) },
    });
  } else if (ready.length > 0) {
    actions.push({ code: "claim_after", args: { id: ready[0]!.id } });
  }

  // 6. 兜底
  if (actions.length === 0) {
    actions.push({ code: "idle", args: {} });
  }

  void projectKey;
  return actions;
}

/**
 * 把一条结构化建议渲染成给 agent 看的串。
 *
 * ⚠ 产出的是 `next_actions`（终端/agent 读的纯文本），与 Web 无关：
 *   界面走的是 `next_action_items` 的 `code` + `args`，由前端查自己的词典渲染。
 *   两个字段各自独立演进，本函数只决定终端那一侧的措辞。
 *
 * 穷尽性检查与 `executeOp` 里的 `default` 分支同源：新增代号忘记写文案，
 * 会在 tsc 阶段报错，而不是界面上少一条建议。
 */
export function renderNextAction(item: NextActionItem): string {
  const a = item.args;
  // 列表项用 ", " 拼接，命令行之间用 " / "（斜杠两边都有代码，不是语言的一部分）
  const join = (xs?: string[]) => (xs ?? []).join(", ");
  const joinCmds = (xs?: string[]) => (xs ?? []).join(" / ");
  switch (item.code) {
    case "takeover":
      return `Take over the task(s) left behind by a lost session (progress is kept): ${joinCmds(a.commands)}`;
    case "read_handoff":
      return `Read handoff #${a.id} (${a.task}): ${a.summary}`;
    case "crash_handoffs":
      return `${a.n} auto-synthesized crash handoff(s) are waiting: ${join(a.tasks)}`;
    case "continue_mine":
      return `Keep going with what you are already doing: ${join(a.tasks)}`;
    case "blocked_needs_human":
      return `${a.n} task(s) are blocked (this may need a human): ${join(a.tasks)}`;
    case "claim_new":
      return `Claim a new task: ${joinCmds(a.commands)}`;
    case "claim_after":
      return `Once the current one is done, you can claim: ${a.id}`;
    case "idle":
      return "There is nothing to do. Create one with `agent-kanban task add \"Title\"`, or review the board with `agent-kanban board`.";
    default: {
      const exhaustive: never = item.code;
      throw new Error(`unhandled next-action code: ${String(exhaustive)}`);
    }
  }
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
  // ⚠ 必须带 project_key：task_id 是 per-project 的（ADR-9），不过滤会拿到
  //   别的看板上同号卡的回收事件，把 reclaimed 报成一个不存在的事实。
  const wasReclaimed =
    (
      db
        .query<{ n: number }, [string, string, string, string, string]>(
          `SELECT COUNT(*) AS n FROM events
            WHERE project_key = ? AND task_id = ? AND type = 'task_reclaimed' AND seq > (
              SELECT COALESCE(MAX(seq), 0) FROM events
               WHERE project_key = ? AND task_id = ? AND type = 'task_claimed' AND session_id = ?
            )`,
        )
        .get(ctx.projectKey, before.id, ctx.projectKey, before.id, previousHolder?.session_id ?? "")
          ?.n ?? 0
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
  // ⚠ 必须带 project_key：plan id 是 per-project 计数的（ids.ts），
  //   任务上的 plan_id 只在本 project 内有意义。不过滤会读出别的看板的计划。
  const plan = task.planId
    ? db
        .query<{ id: string; title: string; version: number }, [string, string]>(
          "SELECT id, title, version FROM plans WHERE project_key = ? AND id = ?",
        )
        .get(ctx.projectKey, task.planId) ?? null
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
    actions.push(`Handoff (${handoff.kind === "crash" ? "auto-synthesized after a crash" : "voluntary"}): ${handoff.summary}`);
    if (handoff.nextStep) actions.push(handoff.nextStep);
    for (const q of handoff.openQuestions) {
      actions.push(`To confirm: ${q}`);
    }
  }
  if (plan) {
    actions.push(`Read the full plan: agent-kanban plan show ${plan.id}`);
  }
  if (remaining.length > 0) {
    actions.push(`Remaining work: ${remaining.join(", ")}`);
  } else if (progress < 100) {
    actions.push(`The checklist is fully ticked but progress is ${progress}%, confirm what is actually done`);
  }

  actions.push(`Update progress while you work: agent-kanban task progress ${taskId} --pct <number> --note "<what you did>"`);
  actions.push(`Write a handoff before wrapping up: agent-kanban handoff --task ${taskId} --summary "..." --next "..."`);

  return actions;
}

// =============================================================================
// 工具
// =============================================================================

/** 事件的一句话描述（短版，与 events.describeEvent 类似但更紧凑） */
function describeEventBrief(event: KanbanEvent): string {
  const d = event.data;
  switch (event.type) {
    case "task_created": return "created task";
    case "task_ready": return "moved to todo";
    case "task_removed": return "deleted";
    case "task_progress": return `progress ${d.prev_pct ?? "?"}% → ${d.pct ?? "?"}%${d.note ? `: ${d.note}` : ""}`;
    case "task_claimed": return d.prev_assignee ? `taken over from ${d.prev_assignee}` : "claimed";
    case "task_note": return `note: ${String(d.text ?? "").slice(0, 50)}`;
    case "task_blocked": return `blocked: ${d.reason ?? ""}`;
    case "task_unblocked": return "auto-unblocked";
    case "task_reclaimed": return d.holder_crashed ? "holder lost contact, reclaimed automatically" : "force reclaimed";
    case "task_released": return "released";
    case "task_review": return "submitted for review";
    case "task_done": return "done";
    case "task_cancelled": return "cancelled";
    case "task_reopened": return "reopened";
    // kind 在 data.handoff 里（事件携带的是完整交接行），见 events.describeEvent 同处注释
    case "handoff_created": return `handoff written (${(d.handoff as { kind?: string } | undefined)?.kind ?? "voluntary"})`;
    case "dep_added": return `added dependency ${d.depends_on_id ?? "(unknown)"}`;
    case "dep_removed": return `removed dependency ${d.depends_on_id ?? "(unknown)"}`;
    case "plan_created": return `saved plan ${d.version !== undefined ? `v${d.version}` : "(unknown)"}`;
    // ⚠ 字段名与 events.describeEvent 保持一致：savePlan 发的是 `id`，不是 old_plan_id
    case "plan_superseded": {
      const id = d.id ?? "(unknown)";
      const v = d.version !== undefined ? ` v${d.version}` : "";
      return `plan ${id}${v} superseded by a new version`;
    }
    case "task_updated": return "updated fields";
    case "handoff_consumed": return `handoff taken over by ${d.by_session ?? "(unknown)"}`;
    // ---- 以下几类不出现在任务时间线里，但必须有 case：缺了会退回原始事件名 ----
    // 凭据 / 项目的审计事件（不是 rebuild 输入，见 types.ts 的注释）
    case "token_issued": return `issued ${d.role ?? "?"} token`;
    case "token_revoked": return `revoked token ${describeTokenRef(String(d.token_ref ?? ""))}`.trim();
    case "token_updated": return `token updated (${d.field ?? ""})`;
    case "project_created": return `created project ${d.key ?? ""}`;
    case "project_renamed": return `renamed project → ${d.to ?? ""}`;
    case "project_key_rotated": return "project key rotated";
    case "session_started": return "session started";
    case "session_heartbeat": return "heartbeat";
    case "session_closed": return "session closed";
    case "session_crashed": return "session lost contact";
    case "board_exported": return "board exported";
    case "board_imported": return "board imported";
    case "project_deleted": return `project ${d.key ?? ""} deleted`;
    case "system_notice": return d.action ? `system: ${String(d.action)}` : "system notice";
    case "snapshot_written": return "snapshot written";
    case "protocol_installed": return "collaboration protocol installed";
    default: return event.type;
  }
}

/** 相对时间（与 format.relativeTime 同源，避免多引依赖） */
function relativeTimeOf(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}h ago`;
  return `${Math.floor(hour / 24)}d ago`;
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
