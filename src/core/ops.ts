/**
 * Op 执行层（ADR-10）：本地与远程一致性的关键。
 *
 * 为什么不直接让命令层调 core 函数？因为那样远程模式就得把 core 的每个函数
 * 都做一次 HTTP 映射，很快会出现"本地能用、远程报错"的漂移。
 *
 * 改成：命令层构造一个**纯 JSON 的 Op**，交给 Backend：
 *   - LocalBackend  → 进程内 executeOp(op)
 *   - RemoteBackend → POST /api/op，server 端同样 executeOp(op)
 *
 * 于是两种模式走的是同一段 switch，行为一致性是**结构保证**而非人工纪律。
 *
 * 约束（新增 Op 时必须遵守）：
 * 1. params 必须是可 JSON 序列化的纯数据（不得含函数、Database、Date）
 * 2. params 不得信任：server 端会对每个字段做类型/范围校验
 * 3. 新增 Op 要同步更新 docs/plan/002-接口契约.md 的 §4.0
 */

import type { Database } from "bun:sqlite";
import { KanbanError } from "./errors.ts";
import { withTx, type TxContext } from "./tx.ts";
import {
  addDependency,
  addNote,
  claimTask,
  createTask,
  editTask,
  getDependencies,
  getTask,
  getUnfinishedDeps,
  getWaitingDepsMap,
  listTasks,
  legalTransitions,
  releaseTask,
  removeDependency,
  removeTask,
  requireTask,
  scopeOf,
  transition,
  updateProgress,
  type Actor,
  type ListFilter,
} from "./tasks.ts";
import { buildBoard } from "./board.ts";
import { closeSession, createSession, listSessions, toSessionView } from "./sessions.ts";
import { getConfig } from "./db.ts";
import { countEvents, queryEvents, taskRecentEvents } from "./events.ts";
import {
  consumeHandoff,
  pendingHandoffs,
  taskHandoffs,
  writeHandoff,
} from "./handoff.ts";
import { buildContext, resumeTask } from "./context.ts";
import { relativeTime } from "./format.ts";
import { runDoctor } from "./doctor.ts";
import { rebuild } from "./rebuild.ts";
import {
  attachPlan,
  listPlans,
  planAtTime,
  planHistory,
  requirePlan,
  savePlan,
} from "./plans.ts";
import {
  createProject,
  generateApiKey,
  getProject,
  hashApiKey,
  listProjects,
  requireProject,
} from "./projects.ts";
import { sessionToJson, taskToJson, toEvent } from "./rows.ts";
import type { Plan, Task, TaskStatus } from "./types.ts";

/**
 * diff 输出的行数上限。超过就截断：diff 本身是用来快速定位变化的，
 * 真要逐字对比时 agent 应该直接看两版正文。
 */
const DIFF_MAX_LINES = 400;

/**
 * 行级 diff（LCS）。
 *
 * 为什么不引三方 diff 库：只需要单文件纯文本 + 统一输出格式，自写 30 行足够，
 * 而且少一个依赖就少一处版本升级带来的行为漂移。
 *
 * 复杂度 O(n*m)，对计划正文（通常几十到几百行）完全够用；
 * 真遇到万行级别的正文，截断会先一步保护住输出。
 */
function diffText(from: string, to: string): {
  diff: string;
  added: number;
  removed: number;
  truncated: boolean;
} {
  const a = from.split("\n");
  const b = to.split("\n");

  // LCS 长度表
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const lines: string[] = [];
  let added = 0;
  let removed = 0;
  let truncated = false;
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (lines.length >= DIFF_MAX_LINES) {
      truncated = true;
      break;
    }
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      lines.push(`- ${a[i]}`);
      removed++;
      i++;
    } else {
      lines.push(`+ ${b[j]}`);
      added++;
      j++;
    }
  }
  if (!truncated) {
    for (; i < m; i++) {
      if (lines.length >= DIFF_MAX_LINES) {
        truncated = true;
        break;
      }
      lines.push(`- ${a[i]}`);
      removed++;
    }
    for (; j < n; j++) {
      if (lines.length >= DIFF_MAX_LINES) {
        truncated = true;
        break;
      }
      lines.push(`+ ${b[j]}`);
      added++;
    }
  }

  return { diff: lines.join("\n"), added, removed, truncated };
}

/**
 * Op 联合类型。
 *
 * 命名规则：`领域.动作`（如 task.create / session.start / board.get）。
 * 新增时同步更新：契约文档 §4.0、本文件 switch、MCP 工具映射表。
 */
export type Op =
  // ---- 任务 ----
  | { kind: "task.create"; params: CreateTaskParams }
  | { kind: "task.list"; params: ListTaskParams }
  | { kind: "task.get"; params: { task_id: string; timeline?: boolean; tail?: number } }
  | { kind: "task.edit"; params: { task_id: string } & Partial<CreateTaskParams> }
  | { kind: "task.claim"; params: { task_id: string; force?: boolean; ttl?: string } }
  | { kind: "task.progress"; params: ProgressParams }
  | { kind: "task.note"; params: { task_id: string; text: string } }
  | { kind: "task.block"; params: { task_id: string; reason: string } }
  | { kind: "task.unblock"; params: { task_id: string } }
  | { kind: "task.review"; params: { task_id: string; note?: string } }
  | { kind: "task.done"; params: { task_id: string; note?: string; force?: boolean } }
  | { kind: "task.cancel"; params: { task_id: string; reason: string } }
  | { kind: "task.reopen"; params: { task_id: string; reason: string } }
  | { kind: "task.release"; params: { task_id: string; reason?: string } }
  | { kind: "task.transition"; params: { task_id: string; to: TaskStatus; force?: boolean; reason?: string; note?: string } }
  | { kind: "task.dep.add"; params: { task_id: string; depends_on: string } }
  | { kind: "task.dep.remove"; params: { task_id: string; depends_on: string } }
  | { kind: "task.dep.list"; params: { task_id: string } }
  | { kind: "task.remove"; params: { task_id: string; force?: boolean } }
  // ---- 会话 ----
  | { kind: "session.start"; params: { agent_name: string; harness?: string; id?: string } }
  | { kind: "session.end"; params: { summary?: string } }
  | { kind: "session.heartbeat"; params: Record<string, never> }
  | { kind: "session.list"; params: { include_closed?: boolean } }
  // ---- 看板 / 事件 ----
  | { kind: "board.get"; params: { include_done?: boolean } }
  | { kind: "events.list"; params: { after_seq?: number; limit?: number } }
  | { kind: "events.tail"; params: { task_id: string; tail?: number } }
  // ---- 崩溃恢复（ADR-7）----
  | { kind: "context.get"; params: { tail?: number; consume?: boolean } }
  | { kind: "handoff.list"; params: { task_id: string; limit?: number } }
  | { kind: "handoff.create"; params: { task_id: string; summary: string; next_step?: string; blockers?: string[]; open_questions?: string[] } }
  | { kind: "resume.task"; params: { task_id: string; force?: boolean; tail?: number } }
  | { kind: "doctor.check"; params: { deep?: boolean; fix?: boolean } }
  // ---- 计划（ADR-1：版本化，历史可追溯）----
  | {
      kind: "plan.save";
      params: {
        scope: "project" | "task";
        task_id?: string | null;
        title: string;
        body: string;
        session_id?: string | null;
        attach?: boolean;
      };
    }
  | { kind: "plan.show"; params: { plan_id: string } }
  | { kind: "plan.list"; params: { task_id?: string | null; scope?: "project" | "task"; status?: "active" | "superseded" | "draft" | "all"; limit?: number } }
  | { kind: "plan.history"; params: { plan_id: string } }
  | { kind: "plan.at"; params: { task_id?: string | null; scope?: "project" | "task"; ts: number } }
  | { kind: "plan.attach"; params: { task_id: string; plan_id: string; session_id?: string | null } }
  | { kind: "plan.diff"; params: { from_plan_id: string; to_plan_id: string } }
  | { kind: "rebuild.check"; params: { from_seq?: number; write?: boolean; force?: boolean } }
  // ---- project ----
  | { kind: "project.get"; params: Record<string, never> }
  | { kind: "project.list"; params: Record<string, never> }
  | { kind: "project.create"; params: { key: string; name?: string; root_path?: string; api_key?: string | null } }
  | { kind: "project.rename"; params: { key: string; name: string } }
  | { kind: "project.rotate_key"; params: { key: string } };

/** 创建任务的参数（task.create / task.edit 共用） */
export interface CreateTaskParams {
  title: string;
  description?: string | null;
  status?: TaskStatus;
  priority?: number;
  labels?: string[];
  parent_id?: string | null;
  blocked_by?: string[];
  checklist?: string[];
  estimate?: string | null;
  /** 估算时长（毫秒），由调用方从 duration 字符串解析 */
  estimate_ms?: number | null;
}

export interface ListTaskParams {
  status?: TaskStatus | TaskStatus[];
  mine?: boolean;
  ready?: boolean;
  label?: string;
  parent_id?: string;
  include_terminal?: boolean;
  sort?: "priority" | "created" | "updated" | "id";
  limit?: number;
}

export interface ProgressParams {
  task_id: string;
  pct?: number;
  note?: string;
  check?: string[];
  uncheck?: string[];
  add_check?: string[];
}

/** 执行 Op 所需的环境 */
export interface OpContext {
  db: Database;
  projectKey: string;
  /** 会话标识（来自 --session / KANBAN_SESSION / HTTP 头） */
  sessionId: string | null;
  /** 逻辑时钟（测试可注入） */
  now: () => number;
  /** 默认租约时长 */
  ttlMs?: number;
  /**
   * 项目根目录（.kanban 的父目录）。
   * 存在时 `doctor.check` 才会检查 AGENTS.md 协作协议是否落后。
   * 远程模式的 client 本地不该检查别人仓库的文件，所以可以不传。
   */
  projectRoot?: string;
}

/** Op 返回的 next_actions：专门写给 agent 的下一步建议 */
export interface OpMeta {
  nextActions?: string[];
  [key: string]: unknown;
}

/**
 * 执行一个 Op。
 *
 * @param op 操作（纯 JSON）
 * @param ctx 环境
 * @returns { data, nextActions } —— data 是可 JSON 序列化的结果
 */
export function executeOp(op: Op, ctx: OpContext): { data: unknown; nextActions: string[] } {
  validateOp(op);
  const actor: Actor = {
    sessionId: ctx.sessionId,
    now: ctx.now(),
    ttlMs: ctx.ttlMs,
  };
  const scope = { db: ctx.db, projectKey: ctx.projectKey };

  switch (op.kind) {
    // ================= 任务 =================
    case "task.create": {
      const p = op.params;
      const task = withOp(ctx, (tx) =>
        createTask(tx, {
          title: requireString(p.title, "title"),
          body: p.description ?? null,
          status: p.status,
          priority: p.priority,
          labels: p.labels,
          parentId: p.parent_id ?? null,
          blockedBy: p.blocked_by ?? [],
          checklist: p.checklist ?? [],
          estimateMs: p.estimate_ms ?? null,
        }),
      );
      const unfinished = getUnfinishedDeps(scope, task.id);
      return {
        data: taskToJson(task),
        nextActions:
          unfinished.length > 0
            ? [
                `Not claimable yet: waiting for ${unfinished.map((u) => u.id).join(", ")} to finish (you will be notified once the dependencies are satisfied)`,
                `Work on an upstream task first: agent-kanban task list --ready`,
              ]
            : [`Claim: agent-kanban task claim ${task.id}`],
      };
    }

    case "task.list": {
      const p = op.params;
      const tasks = listTasks(scope, {
        status: p.status,
        mine: p.mine,
        sessionId: ctx.sessionId,
        ready: p.ready,
        label: p.label,
        parentId: p.parent_id,
        includeTerminal: p.include_terminal,
        sort: p.sort,
        limit: p.limit ?? 200,
      });
      return { data: tasks.map((t) => taskToJson(t)), nextActions: [] };
    }

    case "task.get": {
      const task = requireTask(scope, op.params.task_id);
      const deps = getDependencies(scope, task.id);
      const unfinished = getUnfinishedDeps(scope, task.id).map((u) => u.id);
      const data: Record<string, unknown> = {
        ...taskToJson(task),
        body: task.body,
        checklist: task.checklist,
        dependencies: deps,
        unfinished_dependencies: unfinished,
        // 带标题与状态的依赖明细。只给 `dependencies`（TaskDep 对象）的话，
        // 三个接入面各自去猜字段名——CLI 就猜错过（读 depends_on_id，拿到 undefined），
        // 而“这条依赖还欠着 / 叫什么”正是看详情的人第一个要确认的事。
        dependency_details: deps.map((d) => {
          const dep = getTask(scope, d.dependsOnId);
          return {
            id: d.dependsOnId,
            title: dep?.title ?? "",
            status: dep?.status ?? null,
            done: !unfinished.includes(d.dependsOnId),
          };
        }),
      };
      if (op.params.timeline) {
        data.timeline = taskRecentEvents(ctx.db, ctx.projectKey, op.params.task_id, op.params.tail ?? 20).map(
          (e) => e,
        );
      }
      return { data, nextActions: hintsForTask(task.status, task.id) };
    }

    case "task.edit": {
      const p = op.params;
      const task = withOp(ctx, (tx) =>
        editTask(tx, p.task_id, {
          title: p.title,
          body: p.description,
          priority: p.priority,
          labels: p.labels,
          estimateMs: p.estimate_ms,
        }),
      );
      return { data: taskToJson(task), nextActions: [] };
    }

    case "task.claim": {
      const before = getTask(scope, op.params.task_id);
      const task = withOp(ctx, (tx) => claimTask(tx, op.params.task_id, actor, {
        force: op.params.force,
        ttlMs: op.params.ttl ? parseTtl(op.params.ttl) : undefined,
      }));
      return {
        data: { ...taskToJson(task), took_over: before?.assigneeSessionId !== null && before?.assigneeSessionId !== ctx.sessionId },
        nextActions: [
          `Progress: agent-kanban task progress ${task.id} --pct 40 --note "..."`,
          `Blocked: agent-kanban task block ${task.id} --reason "..."`,
          `Wrap up: agent-kanban handoff --task ${task.id} --summary "..." --next "..."`,
        ],
      };
    }

    case "task.progress": {
      const p = op.params;
      const task = withOp(ctx, (tx) =>
        updateProgress(tx, p.task_id, actor, {
          pct: p.pct,
          note: p.note,
          check: p.check,
          uncheck: p.uncheck,
          addCheck: p.add_check,
        }),
      );
      return {
        data: taskToJson(task),
        nextActions:
          task.progress >= 100
            ? [`Submit for review: agent-kanban task review ${task.id}`, `Or just finish it: agent-kanban task done ${task.id}`]
            : [`Continue: agent-kanban task progress ${task.id} --pct ${Math.min(99, task.progress + 20)} --note "..."`],
      };
    }

    case "task.note": {
      const task = withOp(ctx, (tx) => addNote(tx, op.params.task_id, actor, op.params.text));
      return { data: taskToJson(task), nextActions: [] };
    }

    case "task.block": {
      const { task } = doTransition(ctx, actor, op.params.task_id, "blocked", {
        reason: op.params.reason,
      });
      return { data: taskToJson(task), nextActions: [`Unblock: agent-kanban task unblock ${task.id}`] };
    }

    case "task.unblock": {
      const { task } = doTransition(ctx, actor, op.params.task_id, "todo", {});
      return { data: taskToJson(task), nextActions: [`Claim: agent-kanban task claim ${task.id}`] };
    }

    case "task.review": {
      const { task } = doTransition(ctx, actor, op.params.task_id, "review", { note: op.params.note });
      return {
        data: taskToJson(task),
        nextActions: [
          `Approve: agent-kanban task done ${task.id}`,
          `Send back for rework: agent-kanban task reopen ${task.id} --reason "..."`,
        ],
      };
    }

    case "task.done": {
      const { task, unblocked } = doTransition(ctx, actor, op.params.task_id, "done", {
        note: op.params.note,
        force: op.params.force,
      });
      return {
        data: { ...taskToJson(task), unblocked },
        nextActions:
          unblocked.length > 0
            ? [`The task(s) that depend on it can be started now: ${unblocked.join(", ")}`, `Claim: agent-kanban task claim ${unblocked[0]}`]
            : [],
      };
    }

    case "task.cancel": {
      const { task } = doTransition(ctx, actor, op.params.task_id, "cancelled", {
        reason: op.params.reason,
      });
      return { data: taskToJson(task), nextActions: [] };
    }

    case "task.reopen": {
      const { task } = doTransition(ctx, actor, op.params.task_id, "todo", {
        reason: op.params.reason,
      });
      return { data: taskToJson(task), nextActions: [`Claim: agent-kanban task claim ${task.id}`] };
    }

    case "task.release": {
      const task = withOp(ctx, (tx) => releaseTask(tx, op.params.task_id, actor, op.params.reason));
      return {
        data: taskToJson(task),
        nextActions: [`Claim again: agent-kanban task claim ${task.id} (progress ${task.progress}% is kept)`],
      };
    }

    // 通用状态转移：Web 看板拖拽/菜单改状态走这条。
    // 具体动作（block/done/cancel…）仍有各自的专用 Op，这里只补“任意合法转移”这个缺口，
    // 合法性、守卫（requireReason / requireProgress100 / forceOnly）全部交给 transition()。
    case "task.transition": {
      const { task, unblocked } = doTransition(ctx, actor, op.params.task_id, op.params.to, {
        force: op.params.force,
        reason: op.params.reason,
        note: op.params.note,
      });
      return {
        data: { ...taskToJson(task), unblocked },
        nextActions:
          unblocked.length > 0
            ? [`The task(s) that depend on it can be started now: ${unblocked.join(", ")}`, `Claim: agent-kanban task claim ${unblocked[0]}`]
            : [],
      };
    }

    case "task.dep.add": {
      const deps = withOp(ctx, (tx) =>
        addDependency(tx, op.params.task_id, op.params.depends_on),
      );
      return { data: { task_id: op.params.task_id, dependencies: deps }, nextActions: [] };
    }

    case "task.dep.remove": {
      const deps = withOp(ctx, (tx) =>
        removeDependency(tx, op.params.task_id, op.params.depends_on),
      );
      return { data: { task_id: op.params.task_id, dependencies: deps }, nextActions: [] };
    }

    case "task.dep.list": {
      return {
        data: { task_id: op.params.task_id, dependencies: getDependencies(scope, op.params.task_id) },
        nextActions: [],
      };
    }

    case "task.remove": {
      const result = withOp(ctx, (tx) => removeTask(tx, op.params.task_id, op.params.force));
      return { data: { deleted: result.id }, nextActions: [] };
    }

    // ================= 会话 =================
    case "session.start": {
      const session = withOp(ctx, (tx) =>
        createSession(tx, {
          agentName: requireString(op.params.agent_name, "agent_name"),
          harness: op.params.harness ?? null,
          cwd: ctx.db ? process.cwd() : process.cwd(),
          pid: process.pid,
          id: op.params.id,
        }),
      );
      return {
        data: sessionToJson(session, { written_session_file: false }),
        nextActions: [
          "Read the situation: agent-kanban context (unconsumed handoffs, tasks in progress, tasks you can claim)",
          "`agent-kanban session start` writes the local session file by default, no manual step needed",
        ],
      };
    }

    case "session.end": {
      if (!ctx.sessionId) {
        throw KanbanError.usage(
          "missing session id",
          "Run `agent-kanban session start --agent <name>` first",
          { reason: "missing_session_id" },
        );
      }
      const result = withOp(ctx, (tx) => closeSession(tx, ctx.sessionId!, op.params.summary));
      return {
        data: { session_id: ctx.sessionId, released: result.released },
        nextActions: result.released.length > 0
          ? [`Released task(s) (progress kept): ${result.released.join(", ")}`]
          : [],
      };
    }

    case "session.heartbeat": {
      if (!ctx.sessionId) {
        throw KanbanError.usage(
          "missing session id",
          "The heartbeat needs `agent-kanban session start` first",
          { reason: "missing_session_id" },
        );
      }
      const now = ctx.now();
      const renewed = withTx(
        ctx.db,
        (tx) => {
          tx.db.query("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(now, ctx.sessionId!);
          // 续期该会话在本 project 下持有的任务租约
          tx.db
            .query(
              `UPDATE tasks SET lease_expires_at = ?
                WHERE assignee_session_id = ? AND project_key = ?`,
            )
            .run(now + (ctx.ttlMs ?? 15 * 60 * 1000), ctx.sessionId!, ctx.projectKey);
          return tx.db
            .query<{ id: string }, [string, string]>(
              "SELECT id FROM tasks WHERE assignee_session_id = ? AND project_key = ?",
            )
            .all(ctx.sessionId!, ctx.projectKey)
            .map((r) => r.id);
        },
        { now: () => now, sessionId: ctx.sessionId, projectKey: ctx.projectKey },
      );
      return { data: { session_id: ctx.sessionId, renewed_tasks: renewed, at: now }, nextActions: [] };
    }

    case "session.list": {
      const now = ctx.now();
      const graceMs = getConfig(ctx.db).graceMs;
      const views = listSessions(ctx.db, { includeClosed: op.params.include_closed }).map((s) =>
        toSessionView(ctx.db, s, { now, graceMs, projectKey: ctx.projectKey }),
      );
      return {
        data: views.map((v) => sessionToJson(v, { fresh: v.fresh, stale: v.stale, tasks: v.tasks })),
        nextActions: [],
      };
    }

    // ================= 看板 / 事件 =================
    case "board.get": {
      const now = ctx.now();
      const snapshot = buildBoard(scope, { now, includeTerminal: op.params.include_done ?? true });
      // 批量取“未完成依赖”（避免逐卡查询的 N+1）
      const waiting = getWaitingDepsMap(scope);
      return {
        data: {
          project: snapshot.project,
          counts: snapshot.counts,
          head_seq: snapshot.headSeq,
          lanes: Object.fromEntries(
            Object.entries(snapshot.lanes).map(([status, tasks]) => [
              status,
              (tasks as Task[]).map((t) => ({
                ...taskToJson(t),
                unfinished_dependencies: waiting.get(t.id) ?? [],
              })),
            ]),
          ),
          sessions: snapshot.sessions.map((s) => ({
            id: s.id,
            agent_name: s.agentName,
            harness: s.harness,
            status: s.status,
            last_seen_at: s.lastSeenAt,
            fresh: s.fresh,
            stale: s.stale,
            tasks: s.tasks,
          })),
        },
        nextActions: [],
      };
    }

    case "events.list": {
      const rows = queryEvents(ctx.db, {
        projectKey: ctx.projectKey,
        sinceSeq: op.params.after_seq,
        order: "asc",
        limit: op.params.limit ?? 200,
      });
      return { data: rows.map((r) => toEvent(r)), nextActions: [] };
    }

    case "events.tail": {
      const events = taskRecentEvents(ctx.db, ctx.projectKey, op.params.task_id, op.params.tail ?? 20);
      return { data: events.map((e) => e), nextActions: [] };
    }

    // ================= 崩溃恢复（ADR-7）=================
    case "context.get": {
      // project 的 grace 优先于全局配置（per-project 可调）
      const proj = getProject(ctx.db, ctx.projectKey);
      const graceMs = proj?.graceMs ?? getConfig(ctx.db).graceMs;
      const result = buildContext({
        scope,
        now: ctx.now(),
        graceMs,
        sessionId: ctx.sessionId,
        tail: op.params.tail ?? 20,
        consumeHandoffs: op.params.consume ?? false,
      });
      // 消费模式：把待接手交接标记为已读，避免下次重复提醒
      if (op.params.consume && ctx.sessionId) {
        const toConsume = pendingHandoffs(scope, { sessionId: ctx.sessionId, limit: 20 });
        withOp(ctx, (tx) => {
          for (const h of toConsume) {
            consumeHandoff(tx, h.id, ctx.sessionId!);
          }
        });
        // 记为操作结果而不是“建议”——建议里混进系统反馈会干扰 agent 判断
        (result as { consumed_count?: number }).consumed_count = toConsume.length;
      }
      return { data: result, nextActions: result.next_actions };
    }

    // 单任务的完整交接史（Web 详情页“交接”页签）。
    // 与 context.get 的 pending_handoffs 区别：那个只给“未被人接手的”，这个给全部（含已被消费的）。
    case "handoff.list": {
      requireTask(scope, op.params.task_id);
      const now = ctx.now();
      const items = taskHandoffs(scope, op.params.task_id, op.params.limit ?? 50).map((h) => {
        const t = getTask(scope, h.taskId);
        return {
          id: h.id,
          task_id: h.taskId,
          task_title: t?.title ?? "(task deleted)",
          from_session: h.sessionId,
          kind: h.kind,
          summary: h.summary,
          next_step: h.nextStep,
          blockers: h.blockers,
          open_questions: h.openQuestions,
          created_at: h.createdAt,
          created_relative: relativeTime(h.createdAt, now),
          task_progress: t?.progress ?? 0,
          consumed_by: h.consumedBy,
          consumed_at: h.consumedAt,
        };
      });
      return { data: items, nextActions: [] };
    }

    case "handoff.create": {
      if (!ctx.sessionId) {
        throw KanbanError.usage(
          "writing a handoff requires a session id",
          "Run `agent-kanban session start --agent <name>` first, or pass --session",
          { reason: "missing_session_id" },
        );
      }
      const handoff = withOp(ctx, (tx) =>
        writeHandoff(tx, {
          taskId: op.params.task_id,
          sessionId: ctx.sessionId!,
          summary: op.params.summary,
          nextStep: op.params.next_step ?? null,
          blockers: op.params.blockers ?? [],
          openQuestions: op.params.open_questions ?? [],
        }),
      );
      return {
        data: {
          id: handoff.id,
          task_id: handoff.taskId,
          kind: handoff.kind,
          summary: handoff.summary,
          next_step: handoff.nextStep,
          created_at: handoff.createdAt,
        },
        nextActions: [
          `Handoff recorded. To wrap up: agent-kanban session end`,
          "The next session will see this handoff when it runs `agent-kanban context`",
        ],
      };
    }

    case "resume.task": {
      const actor: Actor = { sessionId: ctx.sessionId, now: ctx.now(), ttlMs: ctx.ttlMs };
      const result = withOp(ctx, (tx) =>
        resumeTask(tx, op.params.task_id, actor, { force: op.params.force, tail: op.params.tail }),
      );
      return { data: result, nextActions: result.next_actions };
    }

    case "doctor.check": {
      const report = runDoctor(ctx.db, {
        projectKey: ctx.projectKey,
        deep: op.params.deep ?? false,
        fix: op.params.fix ?? false,
        now: ctx.now(),
        projectRoot: ctx.projectRoot,
      });
      return {
        data: report,
        nextActions: report.issues.length > 0
          ? [
              ...report.issues.filter((i) => !i.fixed).slice(0, 3).map((i) => `Fix: ${i.hint}`),
              ...(report.issues.length === 0 ? [] : []),
            ]
          : ["All good, keep working with `agent-kanban task ready`"],
      };
    }

    // ================= 计划（ADR-1）=================
    case "plan.save": {
      if (!op.params.title?.trim()) {
        throw KanbanError.usage(
          "a plan requires --title",
          'Usage: agent-kanban plan save --title "Title" --body-file <path>',
          { reason: "empty_plan_title" },
        );
      }
      const plan = withOp(ctx, (tx) =>
        savePlan(tx, {
          scope: op.params.scope,
          taskId: op.params.task_id ?? null,
          title: op.params.title,
          body: op.params.body,
          sessionId: op.params.session_id ?? ctx.sessionId,
          attach: op.params.attach,
        }),
      );
      return {
        data: planToJson(plan, { includeBody: false }),
        nextActions: [
          plan.taskId
            ? `The plan of ${plan.taskId} is now at v${plan.version}; agent resume will read it`
            : `The project plan is now at v${plan.version}`,
          `Read the full text: agent-kanban plan show ${plan.id}`,
        ],
      };
    }

    case "plan.show": {
      const plan = requirePlan(scope, op.params.plan_id);
      return {
        data: planToJson(plan, { includeBody: true }),
        nextActions: plan.supersedesId
          ? [`Previous version: agent-kanban plan show ${plan.supersedesId}`]
          : [],
      };
    }

    case "plan.list": {
      const plans = listPlans(scope, {
        taskId: op.params.task_id ?? null,
        planScope: op.params.scope,
        status: op.params.status ?? "active",
        limit: op.params.limit ?? 50,
      });
      return {
        data: plans.map((p) => planToJson(p, { includeBody: false })),
        nextActions: plans.length > 0 ? [`Read the full text: agent-kanban plan show ${plans[0]!.id}`] : [],
      };
    }

    case "plan.history": {
      const chain = planHistory(scope, op.params.plan_id);
      return {
        data: chain.map((p) => planToJson(p, { includeBody: true })),
        nextActions: [],
      };
    }

    case "plan.at": {
      const plan = planAtTime(scope, op.params.scope ?? "task", op.params.task_id ?? null, op.params.ts);
      return {
        data: plan ? planToJson(plan, { includeBody: true }) : null,
        nextActions: plan ? [] : ["No plan was saved at that point in time"],
      };
    }

    case "plan.attach": {
      const plan = withOp(ctx, (tx) => attachPlan(tx, op.params.task_id, op.params.plan_id));
      return {
        data: planToJson(plan, { includeBody: false }),
        nextActions: [`The current plan of ${plan.taskId} is now ${plan.id}`],
      };
    }

    case "plan.diff": {
      const from = requirePlan(scope, op.params.from_plan_id);
      const to = requirePlan(scope, op.params.to_plan_id);
      // 标题也要比：只看正文会漏掉“改了标题没改正文”这种半途而废
      const bodyDiff = diffText(from.body ?? "", to.body ?? "");
      const titleChanged = from.title !== to.title;
      return {
        data: {
          from_plan_id: from.id,
          to_plan_id: to.id,
          from_version: from.version,
          to_version: to.version,
          title_changed: titleChanged,
          title: titleChanged ? { from: from.title, to: to.title } : null,
          ...bodyDiff,
        },
        nextActions: bodyDiff.truncated
          ? [`The diff is longer than ${DIFF_MAX_LINES} lines and was truncated; compare the two bodies directly for the full text`]
          : [],
      };
    }

    // ================= 重建（ADR-1 自证）=================
    case "rebuild.check": {
      const report = rebuild(ctx.db, {
        projectKey: ctx.projectKey,
        fromSeq: op.params.from_seq,
        write: op.params.write ?? false,
        force: op.params.force ?? false,
      });
      return {
        data: report,
        nextActions: report.ok
          ? [
              `The projection and the event stream agree completely (${report.events_replayed} events verified)`,
              "This self-check can run in CI: it proves the write path has no hidden bugs",
            ]
          : [
                `Found ${report.drift.length} drift(s). Run \`agent-kanban rebuild --write\` to overwrite the projection from the event stream`,
                ...report.drift
                  .slice(0, 3)
                  .map((d) => `  ${d.table}.${d.id}.${d.field}: in db=${JSON.stringify(d.actual)}, recomputed=${JSON.stringify(d.expected)}`),
              ],
      };
    }

    // ================= project =================
    case "project.get": {
      const project = getProject(ctx.db, ctx.projectKey);
      if (!project) {
        throw KanbanError.notInit(`project "${ctx.projectKey}" not found`, {
          reason: "project_not_found",
          project: ctx.projectKey,
        });
      }
      const counts = listTasks(scope, { includeTerminal: true, limit: 1000 });
      return {
        data: {
          key: project.key,
          name: project.name,
          root_path: project.rootPath,
          requires_key: project.apiKeyHash !== null,
          created_at: project.createdAt,
          task_count: counts.length,
          event_count: countEvents(ctx.db, ctx.projectKey),
        },
        nextActions: [],
      };
    }

    case "project.list": {
      return {
        data: listProjects(ctx.db).map((p) => ({
          key: p.key,
          name: p.name,
          root_path: p.rootPath,
          requires_key: p.apiKeyHash !== null,
          created_at: p.createdAt,
        })),
        nextActions: [],
      };
    }

    case "project.create": {
      // 只在 server 端（或本地库直接操作）执行；远程调用会被 server 的鉴权层拦住
      const project = withTx(
        ctx.db,
        (tx) => {
          const created = createProject(tx.db, {
            key: op.params.key,
            name: op.params.name,
            rootPath: op.params.root_path ?? null,
            apiKeyHash: op.params.api_key ? hashApiKey(op.params.api_key) : null,
            now: ctx.now(),
          });
          tx.emit({
            type: "board_exported",
            projectKey: created.key,
            data: { action: "project_created", key: created.key },
            sessionId: "system",
          });
          return created;
        },
        { now: ctx.now, sessionId: "system", projectKey: op.params.key },
      );
      return { data: project, nextActions: [] };
    }

    case "project.rename": {
      const project = requireProject(ctx.db, op.params.key);
      ctx.db.query("UPDATE projects SET name = ? WHERE key = ?").run(op.params.name, project.key);
      return { data: requireProject(ctx.db, project.key), nextActions: [] };
    }

    case "project.rotate_key": {
      const project = requireProject(ctx.db, op.params.key);
      const apiKey = generateApiKey();
      ctx.db
        .query("UPDATE projects SET api_key_hash = ? WHERE key = ?")
        .run(hashApiKey(apiKey), project.key);
      return {
        data: { project: project.key, api_key: apiKey },
        nextActions: [`**Save this key right now, it is only shown once**: ${apiKey}`],
      };
    }

    default: {
      // 穷尽性检查：新增 Op 但忘记实现时会在这里被 TS 报错
      const exhaustive: never = op;
      throw KanbanError.state(`unimplemented op: ${JSON.stringify(exhaustive)}`, {
        reason: "unimplemented_op",
      });
    }
  }
}

// =============================================================================
// 辅助
// =============================================================================

/** 在写事务里执行（自动带上 project 作用域） */
function withOp<T>(ctx: OpContext, fn: (tx: TxContext) => T): T {
  return withTx(ctx.db, fn, {
    now: ctx.now,
    sessionId: ctx.sessionId,
    projectKey: ctx.projectKey,
  });
}

/**
 * Plan → JSON。
 *
 * 默认**不带 body**：计划正文可能有几百行，列表类调用全量返回会把 agent 上下文撑爆。
 * 需要正文时（plan.show / history / at）显式 includeBody。
 */
function planToJson(plan: Plan, opts: { includeBody?: boolean } = {}): Record<string, unknown> {
  const json: Record<string, unknown> = {
    id: plan.id,
    scope: plan.scope,
    task_id: plan.taskId,
    version: plan.version,
    title: plan.title,
    status: plan.status,
    author_session_id: plan.authorSessionId,
    created_at: plan.createdAt,
    supersedes_id: plan.supersedesId,
  };
  if (opts.includeBody) {
    json.body = plan.body;
  } else {
    // 不给正文时也给个体量提示，agent 能判断"要不要去读全文"
    json.body_lines = plan.body.split("\n").length;
    json.body_chars = plan.body.length;
  }
  return json;
}

/** 状态转移的通用包装（需要 session 归属） */
function doTransition(
  ctx: OpContext,
  actor: Actor,
  taskId: string,
  to: TaskStatus,
  input: { reason?: string; note?: string; force?: boolean },
): { task: ReturnType<typeof requireTask>; unblocked: string[] } {
  return withOp(ctx, (tx) => transition(tx, taskId, to, actor, input));
}

/** 根据状态给出可执行的下一步提示 */
function hintsForTask(status: TaskStatus, taskId: string): string[] {
  switch (status) {
    case "todo":
      return [`agent-kanban task claim ${taskId}`, `agent-kanban task block ${taskId} --reason "..."`];
    case "doing":
      return [
        `agent-kanban task progress ${taskId} --pct 60 --note "..."`,
        `agent-kanban task review ${taskId}`,
        `agent-kanban task done ${taskId}`,
      ];
    case "blocked":
      return [`agent-kanban task unblock ${taskId}`];
    case "review":
      return [`agent-kanban task done ${taskId}`, `agent-kanban task reopen ${taskId} --reason "..."`];
    default:
      return [];
  }
}

/** 解析租约时长（"2h"/"30m"/"short"），与 CLI 行为一致 */
function parseTtl(input: string): number | undefined {
  if (input === "short") return undefined;
  const match = /^(\d+)\s*([dhms])$/.exec(input.trim().toLowerCase());
  if (!match) {
    throw KanbanError.usage(
      `cannot parse lease duration "${input}"`,
      "Supported: 15m / 2h / 1d, or short (use the default)",
      { reason: "invalid_duration" },
    );
  }
  const value = Number(match[1]);
  switch (match[2]) {
    case "d":
      return value * 86_400_000;
    case "h":
      return value * 3_600_000;
    case "m":
      return value * 60_000;
    default:
      return value * 1_000;
  }
}

/** 必填字符串校验（server 端不可信输入，必须校验） */
function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw KanbanError.usage(
      `parameter ${field} must be a non-empty string`,
      `Got: ${JSON.stringify(value)}`,
      { reason: "invalid_param" },
    );
  }
  return value;
}

/**
 * Op 结构校验。
 *
 * 远程模式下 params 来自网络，**绝不能信任**：
 * 少一个字段就让 executeOp 报 "cannot read property of undefined" 是糟糕的体验，
 * 应该在边界处给出可操作的错误。
 */
function validateOp(op: Op): void {
  if (!op || typeof op !== "object" || typeof op.kind !== "string") {
    throw KanbanError.usage(
      "an op must be a { kind, params } object",
      `Got: ${JSON.stringify(op)}`,
      { reason: "invalid_op" },
    );
  }
  if (op.params !== undefined && (typeof op.params !== "object" || op.params === null)) {
    throw KanbanError.usage(`the params of op ${op.kind} must be an object`, undefined, {
      reason: "invalid_op_params",
    });
  }
  // 进度范围预检
  if (op.kind === "task.progress") {
    const pct = (op.params as ProgressParams).pct;
    if (pct !== undefined && (typeof pct !== "number" || pct < 0 || pct > 100)) {
      throw KanbanError.usage(`--pct must be between 0 and 100`, `Got: ${JSON.stringify(pct)}`, {
        reason: "invalid_progress",
      });
    }
  }
}

// 重新导出便于 server/命令层使用
export { buildBoard, getDependencies, getTask, legalTransitions, listTasks, requireTask, scopeOf };
export type { Actor, ListFilter };