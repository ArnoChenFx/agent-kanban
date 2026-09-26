/**
 * 任务领域逻辑：状态机 + 抢占 + 进度 + 依赖。
 *
 * 设计要点：
 *
 * 1. **转移表数据驱动**（`TRANSITIONS`），不是散落的 if/else。
 *    好处：非法转移的报错可以自动列出"合法后继"（契约 §1.3），
 *    agent 读一次错误就能改对；新增状态只改一处表。
 *
 * 2. **抢占用条件 UPDATE + changes 判定**，不做"先 SELECT 再 UPDATE"。
 *    探针已验证：8 进程争抢同一行时恰好 1 个赢家，其余返回 changes=0。
 *    这是防重复劳动（两个 agent 同时做同一张卡）的唯一可靠做法。
 *
 * 3. **回收保留 progress**（ADR-4 L2）：持有者失联后任务回到 todo，
 *    但进度百分比与 checklist 原样保留，新 agent 从"做到哪"接着做。
 *
 * 4. **所有写操作都在写事务内完成"改投影 + 写事件"**（ADR-1），
 *    函数内部通过 withTx 保证，不存在中间态。
 *
 * 5. **隐式续租**：progress/note 等写操作会自动把 lease_expires_at 往后推。
 *    这样即使 agent 忘了单独调 heartbeat，只要在干活就不会被误判失联。
 */

import type { Database } from "bun:sqlite";
import { KanbanError } from "./errors.ts";
import { nextTaskId, normalizeTaskId } from "./ids.ts";
import { placeholders, taskNotFound, toTask, type DepRow, type TaskRow } from "./rows.ts";
import { withTx, type TxContext } from "./tx.ts";
import type { ChecklistItem, Task, TaskDep, TaskStatus } from "./types.ts";
import { TASK_STATUSES } from "./types.ts";

/** 默认租约时长（可被 meta 里的 default_ttl_ms 覆盖） */
export const FALLBACK_TTL_MS = 15 * 60 * 1000;

/** 单次转移的定义 */
interface TransitionDef {
  /** 目标状态 */
  to: TaskStatus;
  /** 转移对应的事件类型（必须是事件类型全集的子集） */
  event:
    | "task_ready"
    | "task_review"
    | "task_done"
    | "task_cancelled"
    | "task_reopened"
    | "task_unblocked"
    | "task_blocked";
  /** 必须提供 reason（阻塞原因、取消原因等） */
  requireReason?: boolean;
  /** 必须 progress=100 才允许（可用 --force 跳过） */
  requireProgress100?: boolean;
  /** 只允许在显式 --force 时执行（跳过正常流程的快捷通道） */
  forceOnly?: boolean;
}

/**
 * 状态转移表（docs/plan/001-总体设计.md §5.2 的可执行版本）。
 *
 * claiming（→doing）不在此表：它由 claimTask 特殊处理，因为需要原子抢占，
 * 且允许从"持有者已僵死"的任务上接管。
 */
const TRANSITIONS: Record<TaskStatus, Partial<Record<TaskStatus, TransitionDef>>> = {
  // 想法池：先澄清再进入待办
  backlog: {
    todo: { to: "todo", event: "task_ready" },
    cancelled: { to: "cancelled", event: "task_cancelled", requireReason: true },
  },
  // 待办：可阻塞 / 可取消 / --force 跳过流程直接完成
  // 注意：todo → doing 不在此表，由 claimTask 特殊处理（需要原子抢占 + 允许接管僵死持有者）
  // todo → todo 的"自动解除阻塞"也不在表里，由 notifyDependentsReady 单独处理
  todo: {
    blocked: { to: "blocked", event: "task_blocked", requireReason: true },
    // 完成的理由是可选的（--note）；只有取消/重开/阻塞才强制要求说明原因
    done: { to: "done", event: "task_done", forceOnly: true },
    cancelled: { to: "cancelled", event: "task_cancelled", requireReason: true },
  },
  // 进行中：阻塞 / 提交评审 / 完成（需 force）/ 释放（走 releaseTask）
  doing: {
    blocked: { to: "blocked", event: "task_blocked", requireReason: true },
    review: { to: "review", event: "task_review" },
    done: { to: "done", event: "task_done", forceOnly: true },
    cancelled: { to: "cancelled", event: "task_cancelled", requireReason: true },
  },
  // 阻塞：手动解除阻塞回待办，或直接取消
  blocked: {
    todo: { to: "todo", event: "task_unblocked" },
    cancelled: { to: "cancelled", event: "task_cancelled", requireReason: true },
  },
  // 待评审：确认通过 → done；打回 → doing（重做）
  review: {
    done: { to: "done", event: "task_done" },
    doing: { to: "doing", event: "task_reopened" },
    cancelled: { to: "cancelled", event: "task_cancelled", requireReason: true },
  },
  // 终态：只能 reopen
  done: {
    todo: { to: "todo", event: "task_reopened", requireReason: true },
  },
  cancelled: {
    todo: { to: "todo", event: "task_reopened", requireReason: true },
  },
};

/** 非法转移错误里"合法后继"的计算：包含普通转移 + 始终可用的取消/重开 */
export function legalTransitions(status: TaskStatus): string[] {
  const list = Object.keys(TRANSITIONS[status] ?? {});
  if (status === "todo" || status === "doing") list.push("doing (via agent-kanban task claim)");
  if (status === "doing") list.push("todo (via agent-kanban task release)");
  return list;
}

/** 会话上下文：所有写操作都要知道是谁在操作 */
export interface Actor {
  sessionId: string | null;
  /** 逻辑时钟，测试可注入 */
  now: number;
  /** 租约时长，缺省取库配置 */
  ttlMs?: number;
}

/**
 * 读取作用域：数据库 + 当前 project（ADR-9）。
 *
 * 为什么用 Scope 对象而不是散传 (db, projectKey)：
 * 1. 少一个参数，少一处传错的机会
 * 2. **强制 project 过滤**：所有查询都拿到 projectKey，
 *    从签名上就不可能写出"跨 project 裸查"的代码（那会导致数据泄漏）
 */
export interface Scope {
  db: Database;
  projectKey: string;
}

/**
 * 从事务上下文取出读取作用域。
 *
 * 写函数（参数是 ctx）内部要读任务时统一走这里，
 * 保证 project 过滤不会因为某处忘记传 projectKey 而漏掉。
 */
export function scopeOf(ctx: TxContext): Scope {
  return { db: ctx.db, projectKey: ctx.projectKey };
}

// =============================================================================
// 查询（只读，不开事务）
// =============================================================================

/** 按 ID 取任务（自动归一化 T-0007 / t-7） */
export function getTask(scope: Scope, taskId: string): Task | null {
  const id = normalizeTaskId(taskId);
  const row = scope.db
    .query<TaskRow, [string, string]>("SELECT * FROM tasks WHERE project_key = ? AND id = ?")
    .get(scope.projectKey, id);
  return row ? toTask(row) : null;
}

/** 按 ID 取任务，不存在则抛 STATE 错误（CLI 统一入口用） */
export function requireTask(scope: Scope, taskId: string): Task {
  const task = getTask(scope, taskId);
  if (!task) throw taskNotFound(normalizeTaskId(taskId), scope.projectKey);
  return task;
}

/** 列表查询条件 */
export interface ListFilter {
  status?: TaskStatus | TaskStatus[];
  mine?: boolean;
  sessionId?: string | null;
  ready?: boolean;
  label?: string;
  parentId?: string;
  /** 排除终态（默认 list 不排除，显式传） */
  includeTerminal?: boolean;
  sort?: "priority" | "created" | "updated" | "id";
  limit?: number;
  offset?: number;
}

/** 任务列表（强制按 project 过滤） */
export function listTasks(scope: Scope, filter: ListFilter = {}): Task[] {
  const where: string[] = ["project_key = ?"];
  const params: unknown[] = [scope.projectKey];

  if (filter.status) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    where.push(`status IN (${placeholders(statuses.length)})`);
    params.push(...statuses);
  }
  if (!filter.includeTerminal) {
    // 默认把终态折叠掉：看板默认视图里 done/cancelled 是噪音
    where.push("status NOT IN ('done','cancelled')");
  }
  if (filter.mine && filter.sessionId) {
    // ⚠ 坑：sessionId 单独传**不会**生效，必须同时给 mine: true。
    // 早期 buildContext 就踩了这个（传了 sessionId 忘了 mine），
    // 结果“你正在做的”把别人的卡也算进来。调用方请显式写 mine: true。
    where.push("assignee_session_id = ?");
    params.push(filter.sessionId);
  }
  if (filter.label) {
    // labels 存 JSON 数组，用带引号的精确匹配避免 "a" 命中 "ab"
    where.push("labels LIKE ?");
    params.push(`%"${filter.label}"%`);
  }
  if (filter.parentId) {
    where.push("parent_id = ?");
    params.push(normalizeTaskId(filter.parentId));
  }

  const sql = `SELECT * FROM tasks WHERE ${where.join(" AND ")}`;

  // ready = 依赖全部完成。SQLite 没有 "全部满足" 关键字，
  // 用 NOT EXISTS（存在未完成依赖）来表达，语义等价且可走索引
  const readySql = filter.ready
    ? ` AND NOT EXISTS (
        SELECT 1 FROM task_deps d
        JOIN tasks dt ON dt.id = d.depends_on_id AND dt.project_key = tasks.project_key
        WHERE d.task_id = tasks.id AND dt.status NOT IN ('done','cancelled')
      )`
    : "";

  const orderBy =
    filter.sort === "created"
      ? "created_at ASC"
      : filter.sort === "updated"
        ? "updated_at DESC"
        : filter.sort === "id"
          ? "seq ASC"
          : "priority ASC, created_at ASC"; // 默认：优先级 + 创建顺序
  // 绑定值必须是 SQLite 允许的基础类型（不能用 unknown[]）
  const bindings = [...params, filter.limit ?? 200, filter.offset ?? 0] as Array<
    string | number | null
  >;
  return scope.db
    .query<TaskRow, Array<string | number | null>>(`${sql}${readySql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .all(...bindings)
    .map(toTask);
}

/** 统计各状态任务数（当前 project） */
export function countByStatus(scope: Scope): Record<TaskStatus, number> {
  const rows = scope.db
    .query<{ status: string; c: number }, [string]>(
      "SELECT status, COUNT(*) AS c FROM tasks WHERE project_key = ? GROUP BY status",
    )
    .all(scope.projectKey);
  const counts = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
  for (const row of rows) counts[row.status as TaskStatus] = row.c;
  return counts;
}

// =============================================================================
// 创建与元信息更新
// =============================================================================

export interface CreateTaskInput {
  title: string;
  body?: string | null;
  status?: TaskStatus;
  priority?: number;
  labels?: string[];
  parentId?: string | null;
  /** 初始依赖：依赖这些任务 */
  blockedBy?: string[];
  checklist?: string[];
  estimateMs?: number | null;
}

/** 创建任务（在写事务内执行） */
export function createTask(ctx: TxContext, input: CreateTaskInput): Task {
  const db = ctx.db;
  const now = ctx.now();
  const status = input.status ?? "todo";
  if (!TASK_STATUSES.includes(status)) {
    throw KanbanError.usage(
      `unknown status: ${status}`,
      `One of: ${TASK_STATUSES.join(", ")}`,
      { reason: "invalid_status" },
    );
  }
  const id = nextTaskId(db, ctx.projectKey);
  const priority = Math.max(0, Math.min(4, input.priority ?? 2));

  // 父任务存在性校验（拼错父任务号要立刻报错，而不是留个悬空引用）
  let parentId: string | null = null;
  if (input.parentId) {
    parentId = normalizeTaskId(input.parentId);
    if (parentId && !getTask(scopeOf(ctx), parentId)) throw taskNotFound(parentId, ctx.projectKey);
  }

  const checklist: ChecklistItem[] = (input.checklist ?? []).map((text) => ({
    text,
    done: false,
    done_at: null,
    by: null,
  }));

  db.query(
    `INSERT INTO tasks
       (id, project_key, title, body, status, priority, progress, checklist, labels,
        parent_id, created_by, created_at, updated_at, estimate_ms)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    ctx.projectKey,
    input.title.trim(),
    input.body?.trim() || null,
    status,
    priority,
    JSON.stringify(checklist),
    JSON.stringify(input.labels ?? []),
    parentId,
    ctx.sessionId,
    now,
    now,
    input.estimateMs ?? null,
  );

  // 依赖写入
  for (const dep of input.blockedBy ?? []) {
    insertDep(ctx, id, dep);
  }

  ctx.emit({
    type: "task_created",
    taskId: id,
    data: {
      title: input.title,
      // 以下字段看似"建完就不动了"，但 rebuild 必须能仅靠事件重建任务行（ADR-1），
      // 所以创建事件要携带全部建时输入。缺一个字段，rebuild 出来的库就少一列信息。
      body: input.body ?? null,
      // 创建时的 checklist 全是未完成项（没有 done_at/by），带上也无害且格式统一
      checklist: checklist.map((c) => ({ text: c.text, done: c.done, done_at: c.done_at, by: c.by })),
      estimate_ms: input.estimateMs ?? null,
      // 事件的 session_id 即创建者（rebuild 时能拿到，库里存的 created_by 也来自它）
      created_by: ctx.sessionId ?? null,
      priority,
      labels: input.labels ?? [],
      parent_id: parentId,
      status,
    },
  });
  // 初始依赖也记事件，便于重建时间线
  for (const dep of input.blockedBy ?? []) {
    ctx.emit({ type: "dep_added", taskId: id, data: { depends_on_id: normalizeTaskId(dep) } });
  }

  return requireTask(scopeOf(ctx), id);
}

/** 可修改的元信息字段 */
export interface EditTaskInput {
  title?: string;
  body?: string | null;
  priority?: number;
  labels?: string[];
  estimateMs?: number | null;
}

/** 修改任务元信息（不涉及状态转移） */
export function editTask(ctx: TxContext, taskId: string, input: EditTaskInput): Task {
  const id = normalizeTaskId(taskId);
  requireTask(scopeOf(ctx), id);
  const fields: Record<string, unknown> = {};
  const sets: string[] = [];

  if (input.title !== undefined) {
    fields.title = input.title;
    sets.push("title = ?");
  }
  if (input.body !== undefined) {
    fields.body = input.body;
    sets.push("body = ?");
  }
  if (input.priority !== undefined) {
    fields.priority = input.priority;
    sets.push("priority = ?");
  }
  if (input.labels !== undefined) {
    fields.labels = input.labels;
    sets.push("labels = ?");
  }
  if (input.estimateMs !== undefined) {
    fields.estimate_ms = input.estimateMs;
    sets.push("estimate_ms = ?");
  }

  if (sets.length === 0) {
    throw KanbanError.usage(
      "no field to update",
      "Available: --title / -d / --priority / --label / --estimate",
      { reason: "no_fields_to_update" },
    );
  }

  // 显式按固定顺序取值，避免与 sets 的顺序错位
  const values: Array<string | number | null> = [];
  if (input.title !== undefined) values.push(input.title);
  if (input.body !== undefined) values.push(input.body);
  if (input.priority !== undefined) values.push(input.priority);
  if (input.labels !== undefined) values.push(JSON.stringify(input.labels));
  if (input.estimateMs !== undefined) values.push(input.estimateMs);
  values.push(ctx.now(), id);

  sets.push("updated_at = ?");
  ctx.db.query(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  // 注意：fields 里存的是**新值**（不是旧值），rebuild 直接用它重放即可。
  // 不用记 diff：edit 的语义就是“把这些字段设成这些值”，快照比 diff 更好重放。
  ctx.emit({ type: "task_updated", taskId: id, data: { fields } });
  return requireTask(scopeOf(ctx), id);
}

// =============================================================================
// 抢占（claim）：并发的关键路径
// =============================================================================

/**
 * 原子抢占任务为 doing。
 *
 * 正确性来源：单条条件 UPDATE 在写事务内完成"检查+占有"，
 * 不存在两个 agent 同时认为自己抢到的窗口。
 *
 * 允许抢占的四种情况：
 * 1. 无人持有（assignee 为 NULL）
 * 2. 自己已持有（续租/推进）
 * 3. 原持有者已僵死（lease 过期或会话 crashed）—— 这是崩溃恢复的关键路径
 * 4. 原持有者**已留下未消费的主动交接**（handoff = 明确的移交信号）
 */
export function claimTask(
  ctx: TxContext,
  taskId: string,
  actor: Actor,
  opts: { ttlMs?: number; force?: boolean } = {},
): Task {
  const db = ctx.db;
  const id = normalizeTaskId(taskId);
  const before = requireTask(scopeOf(ctx), id);
  const now = actor.now;
  const ttl = opts.ttlMs ?? actor.ttlMs ?? FALLBACK_TTL_MS;

  // ---- 前置状态校验 ----
  // 分支要点：doing 状态下别人拿着租约时，要给 CONFLICT（带 holder 详情让 agent 改道），
  // 而不能归为“非法转移”（那会让 agent 以为是自己的用法错了，从而反复重试）。
  if (before.status === "doing") {
    if (before.assigneeSessionId === actor.sessionId) {
      // 自己持有 → 视为续租
      return renewLease(ctx, id, actor, ttl);
    }
    if (opts.force) {
      // 强制抢占：需要留痕，后续可审计
      return forceClaim(ctx, before, actor, ttl);
    }
    // 租约已过期（持有者可能已崩溃但尚未被回收）：允许接管，走同一条条件 UPDATE
    const leaseExpired =
      before.leaseExpiresAt === null || before.leaseExpiresAt <= actor.now;
    // 持有者主动留了交接 = 他已经把这张卡交出去了，即使进程还活着。
    // 不放开这个条件会导致“交接写得越认真，越接不了手”的荒谬结果。
    const handedOver = hasPendingHandover(ctx, id, before.assigneeSessionId);
    // ⚠ 第二条：**本会话已消费过这条交接**也算让位。
    //   典型触发：MCP 的标准流程是 bootstrap（读交接，consume=true）→ resume。
    //   如果“消费”抹掉了让位信号，这个流程会卡在 CONFLICT，agent 只能去 force——
    //   而 force 会留下一条 task_reclaimed 痕迹，把一次正常接手续记成“抢占”。
    //   消费回答的是“谁接手了”，不是“能不能接手”，这两件事不该耦合。
    const consumedByMe = actor.sessionId
      ? hasHandoverConsumedBy(ctx, id, actor.sessionId)
      : false;
    if (!leaseExpired && !handedOver && !consumedByMe) {
      // 租约有效、未交接、我也还没读过 → 冲突。
      // buildConflictError 会附上 holder 进度/心跳/最后动作
      throw buildConflictError(db, before, actor, now);
    }
    // 租约已过期，或持有者已交接，或本会话已读走交接：走条件 UPDATE
  } else if (before.status !== "todo") {
    // backlog / blocked / review / done / cancelled：不能用 claim 抢占
    throw KanbanError.illegalTransition(id, before.status, "doing", legalTransitions(before.status));
  }

  // 条件 UPDATE：只有满足"无人持有 / 原持有者已僵死 / 自己持有"才写入成功。
  // 这里的 status = 'todo' 条件对“租约过期的 doing 卡”不成立，
  // 所以这种情况单独用一条 SQL 处理（见下方），保持两条路径的语义清晰。
  const result =
    before.status === "todo"
      ? db
          .query(
            `UPDATE tasks
                SET status = 'doing',
                    assignee_session_id = ?,
                    lease_expires_at = ?,
                    started_at = COALESCE(started_at, ?),
                    finished_at = NULL,
                    updated_at = ?
              WHERE id = ?
                AND status = 'todo'
                AND (assignee_session_id IS NULL
                     OR lease_expires_at IS NULL
                     OR lease_expires_at <= ?
                     OR assignee_session_id = ?)`,
          )
          .run(actor.sessionId, now + ttl, now, now, id, now, actor.sessionId)
      : // 接管理由已过期持有者（或已让位的持有者）留下的 doing 卡
        db
          .query(
            `UPDATE tasks
                SET status = 'doing', assignee_session_id = ?, lease_expires_at = ?, updated_at = ?
              WHERE id = ?
                AND status = 'doing'
                AND (lease_expires_at IS NULL
                     OR lease_expires_at <= ?
                     OR assignee_session_id = ?
                     OR ${HANDOVER_PREDICATE}
                     OR ${CONSUMED_BY_PREDICATE})`,
          )
          .run(
            actor.sessionId,
            now + ttl,
            now,
            id,
            now,
            actor.sessionId,
            ctx.projectKey,
            id,
            ctx.projectKey,
            id,
            actor.sessionId ?? "",
          );

  if (Number(result.changes) === 0) {
    // 条件不成立 → 有人正在做。构造带 holder 详情的冲突错误，让 agent 能改道
    const current = requireTask(scopeOf(ctx), id);
    throw buildConflictError(db, current, actor, now);
  }

  ctx.emit({
    type: "task_claimed",
    taskId: id,
    data: {
      prev_assignee: before.assigneeSessionId,
      prev_status: before.status,
      ttl_ms: ttl,
      // 接管了已僵死持有者的卡，额外标记，便于统计
      took_over: before.assigneeSessionId !== null && before.assigneeSessionId !== actor.sessionId,
    },
  });
  return requireTask(scopeOf(ctx), id);
}

/**
 * “当前持有者已留下未消费的主动交接”判定。
 *
 * 交接是明确的移交信号：写了交接就等于告诉别人“我做完了，接手吧”。
 * 没有这条判定会出现荒谬结果——交接写得越认真，接手方越被 CONFLICT 拦住
 * （因为持有者的租约可能还有十几分钟才到期）。
 *
 * 只认 voluntary：crash 交接是系统在自己回收时合成的，此时任务已无租约，
 * 不需要也不应该参与抢占判断。
 */
const HANDOVER_PREDICATE = `EXISTS (
        SELECT 1 FROM handoffs h
         WHERE h.project_key = ?
           AND h.task_id = ?
           AND h.kind = 'voluntary'
           AND h.session_id = tasks.assignee_session_id
           AND h.consumed_by IS NULL
      )`;

/**
 * “交接已被本会话消费”的 SQL 谓词。
 *
 * ⚠ 必须与 hasPendingHandover / hasHandoverConsumedBy 的判定**保持一致**。
 *   两处曾经不一致：JS 侧放行、UPDATE 侧拒绝，表现为
 *   “日志说可以接管，紧接着就抛 CONFLICT”——最难查的那类不一致。
 *   凡靠条件 UPDATE 保证原子性的地方，谓词都要同步加。
 */
const CONSUMED_BY_PREDICATE = `EXISTS (
        SELECT 1 FROM handoffs h
         WHERE h.project_key = ?
           AND h.task_id = ?
           AND h.kind = 'voluntary'
           AND h.consumed_by = ?
      )`;

/** 该任务是否处于“持有者已交接”状态（供前置校验用） */
function hasPendingHandover(ctx: TxContext, taskId: string, holderSessionId: string | null): boolean {
  if (!holderSessionId) return false;
  const row = ctx.db
    .query<{ n: number }, [string, string, string]>(
      `SELECT COUNT(*) AS n FROM handoffs
        WHERE project_key = ? AND task_id = ? AND kind = 'voluntary'
          AND session_id = ? AND consumed_by IS NULL`,
    )
    .get(ctx.projectKey, taskId, holderSessionId);
  return (row?.n ?? 0) > 0;
}

/**
 * 本会话是否已消费过该任务的主动交接。
 *
 * 与 hasPendingHandover 的分工：那条问“还有没有人没读”，这条问“我读没读过”。
 * 任一成立就说明持有者已经让位，可以接管。
 */
function hasHandoverConsumedBy(ctx: TxContext, taskId: string, consumerSessionId: string): boolean {
  const row = ctx.db
    .query<{ n: number }, [string, string, string]>(
      `SELECT COUNT(*) AS n FROM handoffs
      WHERE project_key = ? AND task_id = ? AND kind = 'voluntary'
      AND consumed_by = ?`,
    )
    .get(ctx.projectKey, taskId, consumerSessionId);
  return (row?.n ?? 0) > 0;
}

/** 强制抢占他人正在做的任务：记 reclaimed 事件，保留原进度 */
function forceClaim(ctx: TxContext, before: Task, actor: Actor, ttl: number): Task {
  const now = actor.now;
  ctx.db
    .query(
      `UPDATE tasks
          SET status = 'doing', assignee_session_id = ?, lease_expires_at = ?, updated_at = ?
        WHERE id = ?`,
    )
    .run(actor.sessionId, now + ttl, now, before.id);
  ctx.emit({
    type: "task_reclaimed",
    taskId: before.id,
    data: {
      forced: true,
      prev_assignee: before.assigneeSessionId,
      prev_status: before.status,
      prev_progress: before.progress,
    },
  });
  ctx.emit({
    type: "task_claimed",
    taskId: before.id,
    data: { prev_assignee: before.assigneeSessionId, ttl_ms: ttl, forced: true },
  });
  return requireTask(scopeOf(ctx), before.id);
}

/** 续租：延长租约并刷新心跳 */
export function renewLease(ctx: TxContext, taskId: string, actor: Actor, ttl?: number): Task {
  const id = normalizeTaskId(taskId);
  const actualTtl = ttl ?? actor.ttlMs ?? FALLBACK_TTL_MS;
  ctx.db
    .query(
      `UPDATE tasks SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND assignee_session_id = ?`,
    )
    .run(actor.now + actualTtl, actor.now, id, actor.sessionId);
  return requireTask(scopeOf(ctx), id);
}

/**
 * 构造抢占冲突错误。
 *
 * 这个错误信息是 agent 决策的关键输入，必须包含：
 * - holder：谁在做、进度多少、最后心跳、租约还剩多久
 * - last_event：他最后做了什么（判断是"正在活跃工作"还是"卡住不动了"）
 * - hint：明确建议换任务，而不是 --force 硬抢
 */
function buildConflictError(db: Database, current: Task, actor: Actor, now: number): KanbanError {
  const holderSessionId = current.assigneeSessionId;

  // 查询持有者会话信息（表里没有对应行时容错：可能数据被手工改过）
  let lastSeenAt: number | null = null;
  let agentName: string | null = null;
  if (holderSessionId) {
    const row = db
      .query<{ last_seen_at: number; agent_name: string }, [string]>(
        "SELECT last_seen_at, agent_name FROM sessions WHERE id = ?",
      )
      .get(holderSessionId);
    lastSeenAt = row?.last_seen_at ?? null;
    agentName = row?.agent_name ?? null;
  }

  // 持有者最后一条事件：让人和 agent 判断"在干活"还是"卡住了"
  const lastEvent = holderSessionId
    ? (db
        .query<{ seq: number; ts: number; type: string; data: string | null }, [string]>(
          "SELECT seq, ts, type, data FROM events WHERE session_id = ? AND type != 'session_heartbeat' ORDER BY seq DESC LIMIT 1",
        )
        .get(holderSessionId) ?? null)
    : null;

  const leaseLeftMin = current.leaseExpiresAt
    ? Math.max(0, Math.ceil((current.leaseExpiresAt - now) / 60_000))
    : 0;

  return KanbanError.conflict(
    `task ${current.id} is being worked on by ${holderSessionId ?? "another session"}` +
      ` (progress ${current.progress}%, ${leaseLeftMin} minute(s) left on the lease)`,
    {
      reason: "not_lease_holder",
      task_id: current.id,
      holder: {
        session_id: holderSessionId,
        agent_name: agentName,
        progress: current.progress,
        last_seen_at: lastSeenAt,
        lease_expires_at: current.leaseExpiresAt,
        lease_left_min: leaseLeftMin,
      },
      last_event: lastEvent
        ? { type: lastEvent.type, ts: lastEvent.ts, data: safeParse(lastEvent.data) }
        : null,
      hint: "Someone else is working on this task. Pick a task from `agent-kanban task list --ready` instead; if you really need to take over, have a human confirm and use --force",
    },
  );
}

/** 宽容 JSON 解析：脏数据不应让冲突错误构造失败 */
function safeParse(text: string | null): Record<string, unknown> {
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// =============================================================================
// 进度与备注
// =============================================================================

export interface ProgressInput {
  pct?: number;
  note?: string;
  /** 勾选 checklist 项（按文本匹配） */
  check?: string[];
  /** 取消勾选 */
  uncheck?: string[];
  /** 追加 checklist 项 */
  addCheck?: string[];
}

/**
 * 更新进度 / checklist / 备注。
 *
 * 隐式续租在这里生效：只要 agent 还在推进任务，租约就自动延长，
 * 不会被误判失联回收（ADR-4 L1）。
 */
export function updateProgress(
  ctx: TxContext,
  taskId: string,
  actor: Actor,
  input: ProgressInput,
): Task {
  const db = ctx.db;
  const id = normalizeTaskId(taskId);
  const before = requireTask(scopeOf(ctx), id);
  const now = actor.now;
  const ttl = actor.ttlMs ?? FALLBACK_TTL_MS;

  // 持有者校验：非持有者写进度会造成上下文混乱（两个 agent 各写各的）
  if (before.assigneeSessionId !== null && before.assigneeSessionId !== actor.sessionId) {
    throw buildConflictError(db, before, actor, now);
  }

  const checklist = before.checklist.map((item) => ({ ...item }));
  if (input.check) {
    for (const text of input.check) {
      const item = checklist.find((c) => c.text === text && !c.done);
      if (!item) {
        throw KanbanError.state(
          `task ${id} has no unfinished checklist item "${text}"`,
          {
            reason: "checklist_item_not_found",
            task_id: id,
            available: checklist.filter((c) => !c.done).map((c) => c.text),
          },
        );
      }
      item.done = true;
      item.done_at = now;
      item.by = actor.sessionId;
    }
  }
  if (input.uncheck) {
    for (const text of input.uncheck) {
      const item = checklist.find((c) => c.text === text && c.done);
      if (item) {
        item.done = false;
        item.done_at = null;
        item.by = null;
      }
    }
  }
  if (input.addCheck) {
    for (const text of input.addCheck) {
      if (!checklist.some((c) => c.text === text)) {
        checklist.push({ text, done: false, done_at: null, by: null });
      }
    }
  }

  // checklist 变化时，进度自动跟随已完成项比例（ADR-8 双表示的联动）
  let pct = before.progress;
  const checklistChanged = Boolean(input.check || input.uncheck || input.addCheck);
  if (input.pct !== undefined) {
    pct = Math.max(0, Math.min(100, Math.round(input.pct)));
  } else if (checklistChanged && checklist.length > 0) {
    const doneCount = checklist.filter((c) => c.done).length;
    pct = Math.round((doneCount / checklist.length) * 100);
  }

  // 续租：只有持有者才续（非持有者写进度是异常情况，不应延长别人的租约）
  if (before.assigneeSessionId === actor.sessionId) {
    db.query(
      `UPDATE tasks SET progress = ?, checklist = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?`,
    ).run(pct, JSON.stringify(checklist), now + ttl, now, id);
  } else {
    db.query(`UPDATE tasks SET progress = ?, checklist = ?, updated_at = ? WHERE id = ?`).run(
      pct,
      JSON.stringify(checklist),
      now,
      id,
    );
  }

  if (pct !== before.progress || checklistChanged) {
    ctx.emit({
      type: "task_progress",
      taskId: id,
      data: {
        pct,
        prev_pct: before.progress,
        note: input.note ?? null,
        // checklist 变更时携带**完整快照**（而不是 diff）。
        // rebuild 重放时只需取最后一条 task_progress 的 checklist 就能还原当前勾选状态，
        // 不必理解 check/uncheck/addCheck 三种操作的语义组合。
        //
        // 快照里必须带 done_at 与 by：否则 --write 重建会把“谁在什么时候勾的”抹成 null，
        // 重建就不幂等了。宁可事件大一点，也不能重建丢数据。
        ...(checklistChanged ? { checklist: checklist.map((c) => ({ ...c })) } : {}),
      },
    });
  }
  if (input.note) {
    ctx.emit({ type: "task_note", taskId: id, data: { text: input.note } });
  }
  if (checklistChanged) {
    ctx.emit({
      type: "task_note",
      taskId: id,
      data: {
        text: `checklist updated (${checklist.filter((c) => c.done).length}/${checklist.length} done)`,
        checklist: checklist.map((c) => ({ text: c.text, done: c.done })),
      },
    });
  }
  return requireTask(scopeOf(ctx), id);
}

/** 追加一条备注（进时间线，不改进度） */
export function addNote(ctx: TxContext, taskId: string, actor: Actor, text: string): Task {
  const db = ctx.db;
  const id = normalizeTaskId(taskId);
  const before = requireTask(scopeOf(ctx), id);
  const now = actor.now;

  // 备注同样续租：agent 思考、查资料期间可能超过租约时长
  if (before.assigneeSessionId === actor.sessionId) {
    db.query(`UPDATE tasks SET lease_expires_at = ?, updated_at = ? WHERE id = ?`).run(
      now + (actor.ttlMs ?? FALLBACK_TTL_MS),
      now,
      id,
    );
  }
  ctx.emit({ type: "task_note", taskId: id, data: { text } });
  return requireTask(scopeOf(ctx), id);
}

// =============================================================================
// 状态转移（统一入口）
// =============================================================================

export interface TransitionInput {
  /** 强制执行（跳过 requireProgress100 / forceOnly 守卫） */
  force?: boolean;
  reason?: string;
  note?: string;
}

/**
 * 统一状态转移入口。
 *
 * @param to 目标状态
 * @param autoReason 自动 unblock 时使用的原因说明
 * @returns 转移后的任务；若触发了下游自动 unblocked，则附带在 result.unblocked
 */
export function transition(
  ctx: TxContext,
  taskId: string,
  to: TaskStatus,
  actor: Actor,
  input: TransitionInput = {},
): { task: Task; unblocked: string[] } {
  const db = ctx.db;
  const id = normalizeTaskId(taskId);
  const before = requireTask(scopeOf(ctx), id);

  // 归一化别名：review→doing 在表里叫 task_reopened
  // 索引需转成 TaskStatus：外部传入的 to 可能是任意字符串
  const def = TRANSITIONS[before.status]?.[to as TaskStatus];
  if (!def) {
    throw KanbanError.illegalTransition(id, before.status, to, legalTransitions(before.status));
  }

  // ---- 守卫检查 ----
  if (def.requireReason && !input.reason) {
    throw KanbanError.usage(
      "this transition requires a --reason argument",
      'Usage: --reason "why"',
      { reason: "reason_required" },
    );
  }
  if (def.requireProgress100 && before.progress < 100 && !input.force) {
    throw KanbanError.state(
      `task ${id} is at ${before.progress}%, not finished; pass --force to confirm`,
      {
        reason: "progress_not_complete",
        task_id: id,
        progress: before.progress,
        hint: "Mark it finished with `agent-kanban task progress " + id + " --pct 100`, or just pass --force",
      },
    );
  }
  if (def.forceOnly && !input.force) {
    throw KanbanError.state(
      `moving from ${before.status} straight to ${to} requires --force (going through the normal flow is recommended)`,
      {
        reason: "force_required",
        task_id: id,
        from: before.status,
        to,
        legal_transitions: legalTransitions(before.status),
      },
    );
  }

  const now = actor.now;
  const isTerminal = to === "done" || to === "cancelled";

  // ---- 更新投影 ----
  const sets = ["status = ?", "updated_at = ?"];
  const values: Array<string | number | null> = [to, now];

  if (to === "doing") {
    // review 打回 doing：继续由评审者或新会话持有
    sets.push("finished_at = NULL");
  }
  if (isTerminal) {
    // 完工时释放租约：任务不再占用任何会话，持有者可以安心去做别的
    // 三个字段里只有 finished_at 需要参数，NULL 写成字面量避免占位符错位
    sets.push("finished_at = ?", "lease_expires_at = NULL", "assignee_session_id = NULL");
    values.push(now);
  }
  if (to === "blocked") {
    sets.push("block_reason = ?");
    values.push(input.reason ?? null);
  }
  if (to !== "blocked") {
    // 离开 blocked 时清掉阻塞原因，避免 board 显示过期原因
    sets.push("block_reason = NULL");
  }
  if (to === "todo") {
    // 回到待办：释放租约但保留进度（恢复时不从头再来）
    sets.push("lease_expires_at = NULL", "assignee_session_id = NULL");
  }
  if (to === "review" || to === "done") {
    sets.push("progress = 100");
  }

  values.push(id);
  db.query(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...values);

  // ---- 写事件 ----
  const eventData: Record<string, unknown> = {};
  if (input.note) eventData.note = input.note;
  if (input.reason) eventData.reason = input.reason;
  if (input.force) eventData.force = true;
  if (isTerminal && before.startedAt) {
    eventData.spent_ms = now - before.startedAt;
  }
  // 进 review / done 会把 progress 提到 100，这个**隐式变更必须单独记事件**，
  // 否则事件流里最后一条 progress 还是旧值（如 60%），
  // rebuild 重算出来的进度就会与库里不符（漂移）。
  if ((to === "review" || to === "done") && before.progress !== 100) {
    ctx.emit({
      type: "task_progress",
      taskId: id,
      data: { pct: 100, prev_pct: before.progress, note: null, implicit: `transition→${to}` },
    });
  }
  ctx.emit({ type: def.event, taskId: id, data: eventData });

  // ---- 终态时检查下游自动 unblock ----
  const unblocked: string[] = [];
  if (to === "done") {
    unblocked.push(...autoUnblockDependents(ctx, id, actor));
  }

  return { task: requireTask(scopeOf(ctx), id), unblocked };
}

/** 释放任务：doing → todo，保留进度（等价 transition 的语义化包装） */
export function releaseTask(
  ctx: TxContext,
  taskId: string,
  actor: Actor,
  reason?: string,
): Task {
  const id = normalizeTaskId(taskId);
  const db = ctx.db;
  const now = actor.now;
  requireTask(scopeOf(ctx), id);
  db.query(
    `UPDATE tasks SET status = 'todo', assignee_session_id = NULL, lease_expires_at = NULL,
                       block_reason = NULL, updated_at = ? WHERE id = ?`,
  ).run(now, id);
  ctx.emit({ type: "task_released", taskId: id, data: { reason: reason ?? null } });
  return requireTask(scopeOf(ctx), id);
}

/** 删除任务（仅允许 cancelled，或 --force 删任意状态） */
export function removeTask(ctx: TxContext, taskId: string, force = false): { id: string } {
  const db = ctx.db;
  const id = normalizeTaskId(taskId);
  const task = requireTask(scopeOf(ctx), id);
  if (task.status !== "cancelled" && !force) {
    throw KanbanError.state(
      `task ${id} is in status ${task.status}; only cancelled tasks can be deleted directly, pass --force to confirm`,
      {
        reason: "task_not_cancelled",
        task_id: id,
        status: task.status,
        legal_transitions: legalTransitions(task.status),
      },
    );
  }
  // 先取出将被一并删除的依赖（emit 在 DELETE 之后，所以必须提前查）
  const removedDeps = db
    .query<{ depends_on_id: string }, [string, string]>(
      "SELECT depends_on_id FROM task_deps WHERE project_key = ? AND task_id = ?",
    )
    .all(ctx.projectKey, id)
    .map((r) => r.depends_on_id);

  // 事件与 handoff 保留（审计价值），只清任务本体与依赖
  db.query(
    "DELETE FROM task_deps WHERE project_key = ? AND (task_id = ? OR depends_on_id = ?)",
  ).run(ctx.projectKey, id, id);
  db.query("DELETE FROM tasks WHERE project_key = ? AND id = ?").run(ctx.projectKey, id);
  // 必须记删除事件：否则 rebuild 从事件流重建时会把已删任务**复活**
  // （事件里 task_created 还在，投影里却没有对应行 → 漂移）
  ctx.emit({
    type: "task_removed",
    taskId: id,
    data: { title: task.title, status: task.status, forced: force, removed_deps: removedDeps },
  });
  return { id };
}

// =============================================================================
// 依赖
// =============================================================================

/** 写入一条依赖（内部使用；自依赖已在上层拦截，这里只做存在性与去重） */
function insertDep(ctx: TxContext, taskId: string, dependsOnId: string): void {
  const dep = normalizeTaskId(dependsOnId);
  if (!getTask(scopeOf(ctx), dep)) throw taskNotFound(dep, ctx.projectKey);
  ctx.db
    .query(
      `INSERT OR IGNORE INTO task_deps (project_key, task_id, depends_on_id, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(ctx.projectKey, taskId, dep, ctx.now());
}

/** 添加依赖：会做环检测（A 依赖 B、B 依赖 A 必须报错） */
export function addDependency(
  ctx: TxContext,
  taskId: string,
  dependsOnId: string,
): TaskDep[] {
  const db = ctx.db;
  const id = normalizeTaskId(taskId);
  const dep = normalizeTaskId(dependsOnId);
  requireTask(scopeOf(ctx), id);

  // 自依赖必须先于环检测判定：否则 T-0001 → T-0001 会被当成“长度为 1 的环”，
  // 报出误导性的“会形成环”而不是“不能依赖自己”
  if (dep === id) {
    throw KanbanError.state(`task ${id} cannot depend on itself`, {
      reason: "self_dependency",
      task_id: id,
      hint: "A dependency expresses what has to be done first, so depending on itself is meaningless",
    });
  }

  if (wouldCreateCycle(db, ctx.projectKey, id, dep)) {
    throw KanbanError.state(
      `adding this dependency would create a cycle: ${id} → ${dep}`,
      {
        reason: "dependency_cycle",
        task_id: id,
        depends_on_id: dep,
        cycle: findCyclePath(db, ctx.projectKey, id, dep),
        hint: "Dependencies must form a directed acyclic graph: the task to be done first comes first",
      },
    );
  }

  insertDep(ctx, id, dep);
  ctx.emit({ type: "dep_added", taskId: id, data: { depends_on_id: dep } });

  // 若依赖已全部完成，立即把任务放回待办（或至少发通知）
  notifyDependentsReady(ctx, id, "dependencies satisfied");
  return getDependencies(scopeOf(ctx), id);
}

/** 移除依赖 */
export function removeDependency(ctx: TxContext, taskId: string, dependsOnId: string): TaskDep[] {
  const id = normalizeTaskId(taskId);
  const dep = normalizeTaskId(dependsOnId);
  requireTask(scopeOf(ctx), id);
  ctx.db
    .query("DELETE FROM task_deps WHERE project_key = ? AND task_id = ? AND depends_on_id = ?")
    .run(ctx.projectKey, id, dep);
  ctx.emit({ type: "dep_removed", taskId: id, data: { depends_on_id: dep } });
  return getDependencies(scopeOf(ctx), id);
}

/**
 * 批量取“每张卡还差哪些依赖没完成”。
 *
 * 为什么批量而不是逐个 getUnfinishedDeps：看板一次要渲染几百张卡，
 * 逐个查就是几百次 SQL（N+1）。这里用一条带相关子查询的 SQL 一次拿完。
 *
 * 返回：taskId → 未完成依赖 ID 列表（无未完成依赖的卡不在 map 里）
 */
export function getWaitingDepsMap(scope: Scope): Map<string, string[]> {
  const rows = scope.db
    .query<{ task_id: string; waiting: string | null }, [string]>(
      `SELECT t.id AS task_id,
              (SELECT group_concat(d2.depends_on_id)
                 FROM task_deps d2
                 JOIN tasks dt2
                   ON dt2.project_key = t.project_key AND dt2.id = d2.depends_on_id
                WHERE d2.task_id = t.id
                  AND dt2.status NOT IN ('done','cancelled')) AS waiting
         FROM tasks t
        WHERE t.project_key = ?`,
    )
    .all(scope.projectKey);

  const map = new Map<string, string[]>();
  for (const row of rows) {
    if (row.waiting) {
      map.set(row.task_id, row.waiting.split(","));
    }
  }
  return map;
}

/** 取某任务的直接依赖 */
export function getDependencies(scope: Scope, taskId: string): TaskDep[] {
  return scope.db
    .query<DepRow, [string, string]>(
      "SELECT * FROM task_deps WHERE project_key = ? AND task_id = ?",
    )
    .all(scope.projectKey, normalizeTaskId(taskId))
    .map((r) => ({ taskId: r.task_id, dependsOnId: r.depends_on_id, createdAt: r.created_at }));
}

/** 取某任务的下游（谁依赖它） */
export function getDependents(scope: Scope, taskId: string): TaskDep[] {
  return scope.db
    .query<DepRow, [string, string]>(
      "SELECT * FROM task_deps WHERE project_key = ? AND depends_on_id = ?",
    )
    .all(scope.projectKey, normalizeTaskId(taskId))
    .map((r) => ({ taskId: r.task_id, dependsOnId: r.depends_on_id, createdAt: r.created_at }));
}

/**
 * 任务的全部未完成依赖。
 *
 * JOIN/子查询必须带 project_key 条件：否则 project A 的 T-0001 会去查
 * project B 的 T-0001，导致跨 project 串数据。
 */
export function getUnfinishedDeps(scope: Scope, taskId: string): Task[] {
  return scope.db
    .query<TaskRow, [string, string, string]>(
      `SELECT * FROM tasks
        WHERE project_key = ?
          AND id IN (
            SELECT depends_on_id FROM task_deps WHERE project_key = ? AND task_id = ?
          )
          AND status NOT IN ('done','cancelled')`,
    )
    .all(scope.projectKey, scope.projectKey, normalizeTaskId(taskId))
    .map(toTask);
}

/** 判断添加 taskId→dep 是否成环（从 dep 出发能否走回 taskId） */
function wouldCreateCycle(db: Database, projectKey: string, taskId: string, dep: string): boolean {
  return findCyclePath(db, projectKey, taskId, dep) !== null;
}

/** 若成环，返回环路径（便于错误信息展示）；否则 null */
function findCyclePath(
  db: Database,
  projectKey: string,
  taskId: string,
  dep: string,
): string[] | null {
  // 从 dep 出发 BFS，看能否到达 taskId
  const queue: string[] = [dep];
  const visited = new Set<string>([dep]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === taskId) return [taskId, dep];
    const deps = db
      .query<DepRow, [string, string]>(
        "SELECT * FROM task_deps WHERE project_key = ? AND task_id = ?",
      )
      .all(projectKey, current);
    for (const d of deps) {
      if (!visited.has(d.depends_on_id)) {
        visited.add(d.depends_on_id);
        queue.push(d.depends_on_id);
      }
    }
  }
  return null;
}

/**
 * 任务完成后检查下游：所有依赖都完成的任务现在可以做了。
 * 返回被解锁的任务 ID 列表。
 *
 * 为什么区分两种情况：
 * - 下游是 **blocked**：状态确实要变（回 todo），这才是严格意义的"解除阻塞"
 * - 下游本来就是 **todo**（只是依赖没满足所以不能认领）：状态不用变，
 *   但**仍要返回并写事件**，否则 agent 永远收不到"现在可以去做了"的信号。
 *   只处理 blocked 是常见实现里最容易漏的一环。
 *
 * 两种情况都写 task_unblocked 事件，data.status_changed 区分是否真的改了状态。
 */
function autoUnblockDependents(ctx: TxContext, finishedTaskId: string, actor: Actor): string[] {
  const scope = scopeOf(ctx);
  const unblocked: string[] = [];
  for (const dep of getDependents(scope, finishedTaskId)) {
    if (notifyDependentsReady(ctx, dep.taskId, finishedTaskId)) {
      unblocked.push(dep.taskId);
    }
  }
  void actor;
  return unblocked;
}

/**
 * 若某任务的全部依赖已完成：
 * - 当前 blocked → 转回 todo（真解除阻塞）
 * - 当前 todo   → 状态不变，仅返回 true（通知"可以开工了"）
 * - 其他状态    → 返回 false（不关别人的事）
 */
function notifyDependentsReady(ctx: TxContext, taskId: string, unlockedBy: string): boolean {
  const db = ctx.db;
  const scope = scopeOf(ctx);
  const task = getTask(scope, taskId);
  if (!task) return false;
  if (task.status !== "blocked" && task.status !== "todo") return false;
  if (getUnfinishedDeps(scope, taskId).length > 0) return false;

  const wasBlocked = task.status === "blocked";
  if (wasBlocked) {
    db.query(
      `UPDATE tasks SET status = 'todo', block_reason = NULL, updated_at = ? WHERE id = ? AND status = 'blocked'`,
    ).run(ctx.now(), taskId);
  }
  ctx.emit({
    type: "task_unblocked",
    taskId,
    data: { unblocked_by: unlockedBy, status_changed: wasBlocked },
  });
  return true;
}

// =============================================================================
// 组合入口（供 CLI/MCP/HTTP 复用，保证三端行为一致 —— ADR-6）
// =============================================================================

/** 在写事务中执行任务操作（自动带上 project 作用域） */
export function runTaskCommand<T>(
  db: Database,
  actor: Actor,
  projectKey: string,
  fn: (ctx: TxContext) => T,
): T {
  return withTx(db, fn, { now: () => actor.now, sessionId: actor.sessionId, projectKey });
}
