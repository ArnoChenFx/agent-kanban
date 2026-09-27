/**
 * 计划版本化（ADR-1：历史计划可追溯）。
 *
 * 核心问题：agent 做长任务时，计划是会变的。"先做 A 再做 B"执行到一半发现
 * 得先做 C，如果只存**最新**计划，就永远说不清"当时为什么那么决定"。
 *
 * 因此计划**从不原地修改**：每次保存都产生一个新版本，旧版本转 superseded
 * 并被 `supersedes_id` 串成链。这样任何时刻都能回答：
 *   - "现在打算怎么做？"      → 取 active 版本
 *   - "一小时前打算怎么做？"  → 取当时那时的 active 版本
 *   - "计划改了几次？每次改了什么？" → 顺着版本链回溯
 *
 * 两种作用域：
 *   project 级 PL-0001      —— 整个项目的总体计划
 *   task 级    PL-T-0007-01 —— 单张卡的执行方案（更常用）
 *
 * 事件：`plan_created`（新版本落库）与 `plan_superseded`（旧版本被顶替）。
 * 两者都携带**完整计划内容**，这样 rebuild 能只靠事件重建 plans 表（ADR-1）。
 */

import type { Database } from "bun:sqlite";
import { KanbanError } from "./errors.ts";
import { nextProjectPlanId, nextTaskPlanId, normalizeTaskId } from "./ids.ts";
import { toPlan, type PlanRow } from "./rows.ts";
import { requireTask, type Scope } from "./tasks.ts";
import type { Plan, PlanScope, PlanStatus } from "./types.ts";
import type { TxContext } from "./tx.ts";

/** 保存计划的输入 */
export interface SavePlanInput {
  /** project 级还是 task 级 */
  scope: PlanScope;
  /** scope=task 时必填 */
  taskId?: string | null;
  title: string;
  /** markdown 全文 */
  body: string;
  /** author session */
  sessionId?: string | null;
  /**
   * 是否同时把任务的 plan_id 指向这个新版本。
   * 默认 true（agent 存计划几乎总是为了给这张卡用）。
   */
  attach?: boolean;
}

/**
 * 保存一个新计划版本。
 *
 * 事务内完成：版本号分配 → 旧 active 版本转 superseded → 新版本落库 → 挂到任务上。
 * 整个过程是一个原子操作，避免出现"两个 active 版本"或"新版本没挂上任务"的中间态。
 */
export function savePlan(ctx: TxContext, input: SavePlanInput): Plan {
  const db = ctx.db;
  const now = ctx.now();
  const projectKey = ctx.projectKey;

  if (typeof input.title !== "string" || input.title.trim().length === 0) {
    throw KanbanError.usage(
      "plan title must not be empty",
      'Usage: agent-kanban plan save --title "Title" [--body-file plan.md]',
      { reason: "empty_plan_title" },
    );
  }
  if (typeof input.body !== "string" || input.body.trim().length === 0) {
    throw KanbanError.usage(
      "plan body must not be empty",
      "The body is where the value of a plan lives (the title is only one sentence).\n" +
        "Provide the markdown content with --body-file <path> or --body \"...\".",
      { reason: "empty_plan_body" },
    );
  }

  // ---- 解析任务级计划的任务号 ----
  const taskId = input.scope === "task" ? normalizeTaskId(input.taskId ?? "") : null;
  if (input.scope === "task" && !taskId) {
    throw KanbanError.usage(
      "a task-scoped plan requires --task",
      'Usage: agent-kanban plan save --task T-0007 --title "Title" --body-file plan.md',
      { reason: "missing_task_id" },
    );
  }
  // 任务必须存在且属于本 project（防止计划指向别的 project 的卡）
  if (taskId) requireTask({ db, projectKey }, taskId);

  // ---- 分配 ID 与版本号 ----
  // 版本号按 scope 内自增：同一任务的第 N 版就是 version=N
  const previousActive = getActivePlan({ db, projectKey }, input.scope, taskId);
  const version = previousActive ? previousActive.version + 1 : 1;
  const id = taskId
    ? nextTaskPlanId(db, projectKey, taskId)
    : nextProjectPlanId(db, projectKey);

  // ---- 旧版本转 superseded ----
  if (previousActive) {
    // ⚠ 必须带 project_key：v5 之后 plans 主键是 (project_key, id, version)，
    //   同号计划在两个 project 下可以共存，只按 id 更新会连带顶掉另一个的。
    db.query("UPDATE plans SET status = 'superseded' WHERE project_key = ? AND id = ?").run(
      projectKey,
      previousActive.id,
    );
    ctx.emit({
      type: "plan_superseded",
      taskId: previousActive.taskId,
      planId: previousActive.id,
      // 携带完整旧版本内容：rebuild 需要它还原当时的计划状态
      data: {
        id: previousActive.id,
        scope: previousActive.scope,
        task_id: previousActive.taskId,
        version: previousActive.version,
        title: previousActive.title,
        body: previousActive.body,
        status: "superseded",
        author_session_id: previousActive.authorSessionId,
        created_at: previousActive.createdAt,
        supersedes_id: previousActive.supersedesId,
      },
    });
  }

  // ---- 新版本落库 ----
  db.query(
    `INSERT INTO plans
       (id, project_key, scope, task_id, version, title, body, status,
        author_session_id, created_at, supersedes_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
  ).run(
    id,
    projectKey,
    input.scope,
    taskId,
    version,
    input.title.trim(),
    input.body,
    input.sessionId ?? null,
    now,
    previousActive?.id ?? null,
  );

  // ---- 挂到任务上 ----
  // 任务当前生效的计划 = 最新 active 版本。agent resume 时靠它读回"当时怎么打算的"。
  if (taskId && input.attach !== false) {
    attachPlan(ctx, taskId, id);
  }

  ctx.emit({
    type: "plan_created",
    taskId,
    planId: id,
    // 完整新版本内容：rebuild 靠它重建 plans 行
    data: {
      id,
      scope: input.scope,
      task_id: taskId,
      version,
      title: input.title.trim(),
      body: input.body,
      status: "active",
      author_session_id: input.sessionId ?? null,
      created_at: now,
      supersedes_id: previousActive?.id ?? null,
    },
  });

  return getPlan({ db, projectKey }, id)!;
}

/** 把任务的当前计划指向某个版本 */
export function attachPlan(ctx: TxContext, taskId: string, planId: string): Plan {
  const db = ctx.db;
  const projectKey = ctx.projectKey;
  const id = normalizeTaskId(taskId);
  const task = requireTask({ db, projectKey }, id);
  const plan = requirePlan({ db, projectKey }, planId);

  if (plan.scope !== "task" || plan.taskId !== task.id) {
    throw KanbanError.usage(
      `plan ${plan.id} is not the task-scoped plan of task ${task.id}`,
      "A project-scoped plan (PL-0001) cannot be attached to a task; only a task-scoped plan (PL-T-0007-01) can.",
      { reason: "plan_scope_mismatch" },
    );
  }

  db.query("UPDATE tasks SET plan_id = ?, updated_at = ? WHERE project_key = ? AND id = ?").run(
    plan.id,
    ctx.now(),
    projectKey,
    task.id,
  );
  // 统一用 { fields, ...值 } 格式：与 editTask 保持一致，rebuild 只需处理一种形状
  ctx.emit({
    type: "task_updated",
    taskId: task.id,
    data: { fields: { plan_id: plan.id } },
  });
  return plan;
}

/** 按 ID 取计划（不存在抛错） */
export function getPlan(scope: Scope, planId: string): Plan | null {
  const row = scope.db
    .query<PlanRow, [string, string]>("SELECT * FROM plans WHERE project_key = ? AND id = ?")
    .get(scope.projectKey, planId);
  return row ? toPlan(row) : null;
}

/** 按 ID 取计划，不存在抛 STATE 错误（给 agent 友好的报错） */
export function requirePlan(scope: Scope, planId: string): Plan {
  const plan = getPlan(scope, planId);
  if (!plan) {
    throw KanbanError.state(`plan ${planId} not found`, {
      reason: "plan_not_found",
      plan_id: planId,
      hint: "Run `agent-kanban plan list` to see the existing plans",
    });
  }
  return plan;
}

/**
 * 取某作用域当前生效的计划。
 *
 * 注意：即使任务已经把 plan_id 切到别的版本，这里也返回"最新写入的 active"，
 * 两者通常一致；不一致只可能来自直接改库（doctor 会报 drift）。
 */
export function getActivePlan(
  scope: Scope,
  planScope: PlanScope,
  taskId: string | null,
): Plan | null {
  // planScope 只用于校验入参：SQL 里直接用字面量，避免多传绑定值（bun:sqlite 会严格校验个数）
  if (planScope === "task" && !taskId) {
    throw KanbanError.usage("a task-scoped plan requires taskId", "Internal call error: getActivePlan(scope, 'task', null)");
  }
  if (planScope === "project" && taskId) {
    throw KanbanError.usage("a project-scoped plan must not carry taskId", "Internal call error: getActivePlan(scope, 'project', taskId)");
  }
  const row = taskId
    ? scope.db
        .query<PlanRow, [string, string]>(
          `SELECT * FROM plans
            WHERE project_key = ? AND scope = 'task' AND task_id = ? AND status = 'active'
            ORDER BY version DESC LIMIT 1`,
        )
        .get(scope.projectKey, taskId)
    : scope.db
        .query<PlanRow, [string]>(
          `SELECT * FROM plans
            WHERE project_key = ? AND scope = 'project' AND status = 'active'
            ORDER BY version DESC LIMIT 1`,
        )
        .get(scope.projectKey);
  return row ? toPlan(row) : null;
}

/** 列出计划（按作用域过滤，默认 active） */
export function listPlans(
  scope: Scope,
  opts: { taskId?: string | null; planScope?: PlanScope; status?: PlanStatus | "all"; limit?: number } = {},
): Plan[] {
  const where: string[] = ["project_key = ?"];
  const params: Array<string | number> = [scope.projectKey];

  if (opts.planScope) {
    where.push("scope = ?");
    params.push(opts.planScope);
  }
  if (opts.taskId) {
    where.push("task_id = ?");
    params.push(normalizeTaskId(opts.taskId));
  }
  if (opts.status && opts.status !== "all") {
    where.push("status = ?");
    params.push(opts.status);
  } else if (!opts.status) {
    where.push("status = 'active'");
  }
  // 同一作用域内版本倒序：新版本在前
  params.push(opts.limit ?? 50);

  return scope.db
    .query<PlanRow, Array<string | number>>(
      `SELECT * FROM plans WHERE ${where.join(" AND ")}
        ORDER BY created_at DESC, version DESC LIMIT ?`,
    )
    .all(...params)
    .map(toPlan);
}

/**
 * 取某计划的历史版本链（从最新往回）。
 *
 * 这是"计划改了什么"这个问题的答案来源。顺着 supersedes_id 一路回溯，
 * 得到 [(v3 当前), (v2), (v1)]。
 */
export function planHistory(scope: Scope, planId: string): Plan[] {
  const chain: Plan[] = [];
  let current = getPlan(scope, planId);
  // 防御：数据损坏导致环时最多走 200 步，避免死循环
  for (let i = 0; current && i < 200; i++) {
    chain.push(current);
    current = current.supersedesId ? getPlan(scope, current.supersedesId) : null;
  }
  return chain;
}

/**
 * 取某作用域在某时刻生效的计划（时间旅行查询）。
 *
 * 用途：agent 崩溃前 10 分钟的计划是什么？那时还没保存新版本，
 * 所以就是 `created_at <= ts` 的最后一个 active 版本。
 */
export function planAtTime(
  scope: Scope,
  planScope: PlanScope,
  taskId: string | null,
  ts: number,
): Plan | null {
  const row = taskId
    ? scope.db
        .query<PlanRow, [string, string, number]>(
          `SELECT * FROM plans
            WHERE project_key = ? AND scope = 'task' AND task_id = ? AND created_at <= ?
            ORDER BY created_at DESC, version DESC LIMIT 1`,
        )
        .get(scope.projectKey, taskId, ts)
    : scope.db
        .query<PlanRow, [string, number]>(
          `SELECT * FROM plans
            WHERE project_key = ? AND scope = 'project' AND created_at <= ?
            ORDER BY created_at DESC, version DESC LIMIT 1`,
        )
        .get(scope.projectKey, ts);
  return row ? toPlan(row) : null;
}

/** 计划列表的 JSON 形状（不含 body，正文要用 show 单独取，避免撑爆上下文） */
export function planToSummaryJson(plan: Plan): Record<string, unknown> {
  return {
    id: plan.id,
    scope: plan.scope,
    task_id: plan.taskId,
    version: plan.version,
    title: plan.title,
    status: plan.status,
    author_session_id: plan.authorSessionId,
    created_at: plan.createdAt,
    supersedes_id: plan.supersedesId,
    body_lines: plan.body.split("\n").length,
    body_chars: plan.body.length,
  };
}
