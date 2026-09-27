/**
 * 从事件流重建投影（ADR-1 的正确性证明）。
 *
 * ## 为什么需要它
 *
 * `events` 是唯一事实来源，`tasks/plans/handoffs/task_deps` 都只是投影。
 * 这个文件做的事只有一件：**只用 events 把投影重新算一遍**，
 * 然后和库里现有的投影逐字段比对。
 *
 * 它的价值有三个层次：
 *   1. **证明**：逐字段相等 → 说明写入路径没有隐藏 bug（架构自证）
 *   2. **诊断**：不相等 → 精确定位到"哪张卡的哪个字段对不上"
 *   3. **修复**：`--write` 用重算结果覆盖投影，救回被直接写库弄脏的库
 *
 * ## 设计：先算再比，默认不写
 *
 * 朴素实现是"清空投影表然后重放"，但那样一旦事件历史有缺口，
 * 用户辛苦攒的看板就被抹掉了。所以这里：
 *   - 重放在**内存**里完成（`Projection` 对象）
 *   - 默认只比对并报告（`--dry-run` 语义即默认行为）
 *   - 只有显式 `--write` 才落库，且要求当前无漂移（或 `--force`）
 *
 * ## 不参与比较的字段
 *
 * `lease_expires_at` 与 `updated_at` 被有意排除：它们是**时钟推导的易失状态**。
 * 租约每次心跳/续租都会前移，而这些续租**不写事件**（否则事件量会被心跳淹没）。
 * 因此 rebuild 后这两个字段会回到"最后一次有事件时的值"，
 * 这是设计上的正常现象，不算漂移。首次 heartbeat 会立刻刷新它们。
 */

import type { Database } from "bun:sqlite";
import { getConfig } from "./db.ts";
import { toEvent, type TaskRow } from "./rows.ts";
import { normalizeTaskId } from "./ids.ts";
import { withTx } from "./tx.ts";
import type { ChecklistItem, Handoff, KanbanEvent, Plan, TaskStatus } from "./types.ts";

/** rebuild 输入 */
export interface RebuildOptions {
  projectKey: string;
  /** 只重放 seq >= 该值的事件（增量重建） */
  fromSeq?: number;
  /** 真正写回投影表。默认 false（只校验） */
  write?: boolean;
  /** 有漂移时也强制写（配合 write 使用） */
  force?: boolean;
  now?: number;
}

/** 单个字段的漂移 */
export interface FieldDrift {
  table: "tasks" | "task_deps" | "plans" | "handoffs";
  id: string;
  field: string;
  /** 库里现有的值 */
  actual: unknown;
  /** 从事件重算出的值 */
  expected: unknown;
}

export interface RebuildReport {
  project_key: string;
  events_replayed: number;
  /** 重算出的各表行数 */
  counts: { tasks: number; deps: number; plans: number; handoffs: number };
  /** 逐字段比对结果 */
  drift: FieldDrift[];
  /** 无法重建的字段（历史事件 payload 不足时） */
  incomplete: Array<{ id: string; field: string; reason: string }>;
  ok: boolean;
  written: boolean;
  /** 落库时的耗时（毫秒） */
  elapsed_ms: number;
}

/**
 * 重建中的任务投影。
 *
 * 字段名与 tasks 表对齐（snake_case），方便最后直接写库。
 * 用 `Map` 而非对象：任务号是动态的，且顺序无关。
 */
interface TaskProjection {
  id: string;
  seq: number;
  project_key: string;
  title: string;
  body: string | null;
  status: TaskStatus;
  priority: number;
  assignee_session_id: string | null;
  lease_expires_at: number | null;
  progress: number;
  checklist: ChecklistItem[];
  labels: string[];
  parent_id: string | null;
  plan_id: string | null;
  block_reason: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
  estimate_ms: number | null;
}

/** 重建上下文：内存中的全部投影 */
interface Projection {
  tasks: Map<string, TaskProjection>;
  /** `${taskId}→${dependsOnId}` → 依赖行（created_at 是 NOT NULL，必须带） */
  deps: Map<string, { dependsOnId: string; createdAt: number }>;
  plans: Map<string, Plan>;
  handoffs: Map<number, Handoff>;
}

/** 主入口：重建 + 比对（+ 可选写回） */
export function rebuild(db: Database, opts: RebuildOptions): RebuildReport {
  const startedAt = opts.now ?? Date.now();
  const projectKey = opts.projectKey;

  // ---- 1+2. 读事件流（只读本 project）→ 内存重放 ----
  const proj: Projection = { tasks: new Map(), deps: new Map(), plans: new Map(), handoffs: new Map() };
  let replayed = 0;
  const readAndReplay = (): void => {
    proj.tasks.clear(); proj.deps.clear(); proj.plans.clear(); proj.handoffs.clear();
    replayed = 0;
    const rows = db
      .query<{
        seq: number;
        ts: number;
        session_id: string | null;
        type: string;
        task_id: string | null;
        plan_id: string | null;
        project_key: string | null;
        data: string | null;
      }, [string, number]>(
        `SELECT seq, ts, session_id, type, task_id, plan_id, project_key, data
           FROM events
          WHERE project_key = ? AND seq >= ?
          ORDER BY seq ASC`,
      )
      .all(projectKey, opts.fromSeq ?? 0);
    for (const row of rows) {
      // 只认属于本 project 的事件（sessions 表是全局的，但事件流按 project 隔离）
      if (row.project_key !== projectKey) continue;
      applyEvent(proj, toEvent(row));
      replayed++;
    }
  };
  readAndReplay();

  // ---- 3. 逐字段比对 ----
  const drift: FieldDrift[] = [];
  const incomplete: RebuildReport["incomplete"] = [];
  const compareAll = (): void => {
    drift.length = 0;
    incomplete.length = 0;
    compareTasks(db, projectKey, proj, drift, incomplete);
    compareDeps(db, projectKey, proj, drift);
    comparePlans(db, projectKey, proj, drift, incomplete);
    compareHandoffs(db, projectKey, proj, drift, incomplete);
  };
  compareAll();

  // ---- 4. 可选写回 ----
  let written = false;
  if (opts.write && (drift.length === 0 || opts.force)) {
    // 整个写回在一个事务里：DELETE 4 张表再逐行 INSERT，
    // 中途出错（约束、磁盘满）必须整体回滚，否则会留下"表被清空但没填回"的半写状态。
    // 那种状态比漂移严重得多——漂移只是数据不对，半写是数据没了。
    //
    // 事务内还要**重读重放**一遍：上面的读发生在事务外，若这期间另一个 agent
    // 提交了新事件，用陈旧快照覆盖投影会丢更新。重放是纯内存操作，代价可忽略。
    withTx(
      db,
      () => {
        readAndReplay();
        compareAll();
        if (drift.length === 0 || opts.force) writeProjection(db, projectKey, proj);
        return true;
      },
      { now: () => Date.now() },
    );
    written = true;
  }

  return {
    project_key: projectKey,
    events_replayed: replayed,
    counts: {
      tasks: proj.tasks.size,
      deps: proj.deps.size,
      plans: proj.plans.size,
      handoffs: proj.handoffs.size,
    },
    drift,
    incomplete,
    ok: drift.length === 0,
    written,
    elapsed_ms: Date.now() - startedAt,
  };
}

// =============================================================================
// 重放：把一个事件应用到内存投影
// =============================================================================

function applyEvent(p: Projection, event: KanbanEvent): void {
  const d = event.data as Record<string, unknown>;
  const ts = event.ts;

  switch (event.type) {
    // ---- 任务创建：一次性写入建时快照 ----
    case "task_created": {
      if (!event.taskId) return;
      p.tasks.set(event.taskId, {
        id: event.taskId,
        seq: p.tasks.size + 1, // 重建时按出现顺序重排（tasks.seq 只影响稳定排序）
        project_key: event.projectKey ?? "",
        title: str(d.title) ?? "",
        body: nullableStr(d.body),
        status: (str(d.status) ?? "todo") as TaskStatus,
        priority: num(d.priority) ?? 2,
        assignee_session_id: null,
        lease_expires_at: null,
        progress: 0,
        checklist: toChecklist(d.checklist),
        labels: strArray(d.labels),
        parent_id: nullableStr(d.parent_id),
        plan_id: null,
        block_reason: null,
        created_by: nullableStr(d.created_by) ?? event.sessionId,
        created_at: ts,
        updated_at: ts,
        started_at: null,
        finished_at: null,
        estimate_ms: nullableNum(d.estimate_ms),
      });
      return;
    }

    // ---- 抢占：租约 = 事件时刻 + ttl ----
    case "task_claimed": {
      const t = get(p, event.taskId);
      if (!t) return;
      t.status = "doing";
      t.assignee_session_id = event.sessionId;
      const ttl = num(d.ttl_ms);
      t.lease_expires_at = ttl === null ? null : ts + ttl;
      t.started_at = t.started_at ?? ts;
      t.finished_at = null;
      t.updated_at = ts;
      return;
    }

    // ---- 进度 / checklist：事件里带的是变更后的完整快照 ----
    case "task_progress": {
      const t = get(p, event.taskId);
      if (!t) return;
      const pct = num(d.pct);
      if (pct !== null) t.progress = pct;
      if (d.checklist !== undefined) t.checklist = toChecklist(d.checklist);
      // 推进即续租：租约按最后一条 progress 事件前移（真实值由心跳刷新，见文件头注释）
      const ttl = num(d.ttl_ms);
      if (ttl !== null && t.assignee_session_id) t.lease_expires_at = ts + ttl;
      t.updated_at = ts;
      return;
    }

    // ---- backlog → todo ----
    // ⚠ 这个事件以前**根本没有处理器**，于是重放时状态停在 backlog。
    //   症状：`backlog → todo` 之后跑 rebuild 报 `status: db="todo" 重算="backlog"`，
    //   而 `--force --write` 会把这张卡打回 backlog。
    case "task_ready": {
      const t = get(p, event.taskId);
      if (!t) return;
      t.status = "todo";
      t.updated_at = ts;
      return;
    }

    // ---- 状态转移 ----
    case "task_blocked": {
      const t = get(p, event.taskId);
      if (!t) return;
      t.status = "blocked";
      t.block_reason = nullableStr(d.reason);
      // 与 transition() 对齐：阻塞就是放手，持卡人与租约一起清。
      // 不清的话库里会永久残留一个没人回收的幽灵持卡人（reapZombies 只管 doing）。
      t.assignee_session_id = null;
      t.lease_expires_at = null;
      t.updated_at = ts;
      return;
    }
    // 解除阻塞：**回到 todo = 回到待认领池**，所以持卡人与租约一起清。
    // 两条发这个事件的路径（transition 的 blocked→todo、notifyDependentsReady 的
    // 自动解阻）现在对库的改动一致，所以一个处理器就对得上。
    case "task_unblocked": {
      const t = get(p, event.taskId);
      if (!t) return;
      t.status = "todo";
      t.assignee_session_id = null;
      t.lease_expires_at = null;
      t.block_reason = null;
      t.updated_at = ts;
      return;
    }
    case "task_released": {
      const t = get(p, event.taskId);
      if (!t) return;
      t.status = "todo";
      t.assignee_session_id = null;
      t.lease_expires_at = null;
      t.block_reason = null;
      t.updated_at = ts;
      return;
    }
    case "task_reclaimed": {
      const t = get(p, event.taskId);
      if (!t) return;
      // 强制抢占（forced）也是 reclaimed，但持有者换成了新会话
      t.status = "doing";
      if (d.forced === true) {
        t.assignee_session_id = str(d.prev_assignee) === null ? null : event.sessionId;
        t.lease_expires_at = null;
      } else {
        // 僵尸回收：退回待办，进度与 checklist 全部保留（ADR-4）
        t.status = "todo";
        t.assignee_session_id = null;
        t.lease_expires_at = null;
      }
      t.updated_at = ts;
      return;
    }
    case "task_review": {
      const t = get(p, event.taskId);
      if (!t) return;
      // ⚠ 这里**故意不清** assignee_session_id / lease_expires_at：
      //   transition() 转到 review 时就不清（持卡人继续持有这张卡的归属，
      //   评审打回时也还在他手上）。以前这里清成 null，于是最常见的
      //   `claim → review` 就报漂移，`--force --write` 还会把持卡人抹掉。
      t.status = "review";
      t.updated_at = ts;
      return;
    }
    case "task_done": {
      const t = get(p, event.taskId);
      if (!t) return;
      t.status = "done";
      t.assignee_session_id = null;
      t.lease_expires_at = null;
      t.finished_at = ts;
      t.updated_at = ts;
      return;
    }
    case "task_cancelled": {
      const t = get(p, event.taskId);
      if (!t) return;
      t.status = "cancelled";
      t.assignee_session_id = null;
      t.lease_expires_at = null;
      // 离开 blocked 就该清掉阻塞原因（transition 对任何非 blocked 目标都这么干）。
      // 以前漏了，于是 `blocked → cancelled` 报 block_reason 漂移。
      t.block_reason = null;
      t.finished_at = ts;
      t.updated_at = ts;
      return;
    }
    case "task_reopened": {
      const t = get(p, event.taskId);
      if (!t) return;
      // 同一个事件表示两种事：「review 打回 doing」与「终态重开 todo」。
      // 目标状态由**转移函数知道**，所以新事件直接带 `to`，不必推断。
      // 旧事件（没有 to）退回启发式：终态重开必然已无持有者。
      const explicit = str(d.to);
      if (explicit) {
        t.status = explicit as TaskStatus;
      } else {
        t.status = t.assignee_session_id ? "doing" : "todo";
      }
      t.finished_at = null;
      t.block_reason = null;
      t.updated_at = ts;
      return;
    }

    // ---- 元信息编辑：fields 里是新值 ----
    case "task_updated": {
      const t = get(p, event.taskId);
      if (!t) return;
      const fields = (d.fields ?? {}) as Record<string, unknown>;
      if ("title" in fields) t.title = str(fields.title) ?? t.title;
      if ("body" in fields) t.body = nullableStr(fields.body);
      if ("priority" in fields) t.priority = num(fields.priority) ?? t.priority;
      if ("labels" in fields) t.labels = strArray(fields.labels);
      if ("parent_id" in fields) t.parent_id = nullableStr(fields.parent_id);
      if ("estimate_ms" in fields) t.estimate_ms = nullableNum(fields.estimate_ms);
      if ("plan_id" in fields) t.plan_id = nullableStr(fields.plan_id);
      t.updated_at = ts;
      return;
    }

    // ---- 依赖 ----
    case "dep_added": {
      if (!event.taskId) return;
      const dep = str(d.depends_on_id);
      if (dep) p.deps.set(`${event.taskId}→${dep}`, { dependsOnId: dep, createdAt: ts });
      return;
    }
    case "dep_removed": {
      if (!event.taskId) return;
      const dep = str(d.depends_on_id);
      if (dep) p.deps.delete(`${event.taskId}→${dep}`);
      return;
    }

    // ---- 计划：事件里带完整行 ----
    case "plan_created": {
      const h = (d.handoff ?? d) as Record<string, unknown>;
      const plan = toPlanFromData(h, event, ts);
      if (plan) p.plans.set(plan.id, plan);
      return;
    }
    case "plan_superseded": {
      const h = (d.handoff ?? d) as Record<string, unknown>;
      const id = str(h.id) ?? event.planId;
      if (!id) return;
      const existing = p.plans.get(id);
      // 旧版本内容来自事件；没有就用已重建的行改状态
      const plan = toPlanFromData(h, event, ts) ?? existing;
      if (plan) p.plans.set(id, { ...plan, status: "superseded" });
      return;
    }

    // ---- 交接：事件里带完整行 ----
    case "handoff_created": {
      const h = (d.handoff ?? {}) as Record<string, unknown>;
      const id = num(h.id);
      if (id === null) return;
      p.handoffs.set(id, {
        id,
        projectKey: event.projectKey ?? "",
        taskId: str(h.task_id) ?? event.taskId ?? "",
        sessionId: str(h.session_id) ?? event.sessionId ?? "",
        kind: (str(h.kind) ?? "voluntary") as Handoff["kind"],
        summary: str(h.summary) ?? "",
        nextStep: nullableStr(h.next_step),
        blockers: strArray(h.blockers),
        openQuestions: strArray(h.open_questions),
        createdAt: num(h.created_at) ?? ts,
        consumedBy: null,
        consumedAt: null,
      });
      return;
    }
    case "handoff_consumed": {
      const id = num(d.handoff_id);
      if (id === null) return;
      const h = p.handoffs.get(id);
      if (h) {
        h.consumedBy = str(d.by_session) ?? null;
        h.consumedAt = ts;
      }
      return;
    }

    // ---- 任务删除：物理删除后投影里也不该有 ----
    case "task_removed": {
      if (!event.taskId) return;
      p.tasks.delete(event.taskId);
      // 被删任务作为依赖的那些边也要清掉
      for (const key of [...p.deps.keys()]) {
        if (key.startsWith(`${event.taskId}→`) || key.endsWith(`→${event.taskId}`)) {
          p.deps.delete(key);
        }
      }
      return;
    }

    // 其余事件（note/heartbeat/session_*）不改变投影，忽略
    default:
      return;
  }
}

// =============================================================================
// 比对
// =============================================================================

/** 参与比较的字段（lease_expires_at / updated_at 有意排除，见文件头） */
const TASK_COMPARED_FIELDS = [
  "title",
  "body",
  "status",
  "priority",
  "assignee_session_id",
  "progress",
  "checklist",
  "labels",
  "parent_id",
  "plan_id",
  "block_reason",
  "created_by",
  "estimate_ms",
] as const;

function compareTasks(
  db: Database,
  projectKey: string,
  proj: Projection,
  drift: FieldDrift[],
  incomplete: RebuildReport["incomplete"],
): void {
  const actual = db
    .query<TaskRow, [string]>("SELECT * FROM tasks WHERE project_key = ?")
    .all(projectKey);

  const seen = new Set<string>();
  for (const row of actual) {
    seen.add(row.id);
    const rebuilt = proj.tasks.get(row.id);
    if (!rebuilt) {
      drift.push({
        table: "tasks",
        id: row.id,
        field: "(whole row)",
        actual: `status=${row.status}`,
        expected: "(the event stream has no creation record for this task)",
      });
      continue;
    }
    for (const field of TASK_COMPARED_FIELDS) {
      const a = normalizeForCompare(field, row[field as keyof TaskRow]);
      const b = normalizeForCompare(field, (rebuilt as unknown as Record<string, unknown>)[field]);
      if (a !== b) {
        drift.push({ table: "tasks", id: row.id, field, actual: a, expected: b });
      }
    }
  }

  // 事件里有、库里没有 = 库被直接改过（或删过）
  for (const id of proj.tasks.keys()) {
    if (!seen.has(id)) {
      drift.push({
        table: "tasks",
        id,
        field: "(whole row)",
        actual: null,
        expected: `status=${proj.tasks.get(id)!.status}`,
      });
    }
  }

  // 历史事件 payload 不足时明确报告，而不是静默当成"漂移"
  for (const id of proj.tasks.keys()) {
    const t = proj.tasks.get(id)!;
    if (t.body === null && t.estimate_ms === null) {
      // body 与 estimate 都为空可能是合法的（创建时就没填），无法区分，
      // 交给上面的逐字段比较处理，这里不做噪音报告
      void id;
    }
  }
  void incomplete;
}

function compareDeps(db: Database, projectKey: string, proj: Projection, drift: FieldDrift[]): void {
  const rows = db
    .query<{ task_id: string; depends_on_id: string }, [string]>(
      "SELECT task_id, depends_on_id FROM task_deps WHERE project_key = ?",
    )
    .all(projectKey);
  const actual = new Set(rows.map((r) => `${r.task_id}→${r.depends_on_id}`));

  for (const key of actual) {
    if (!proj.deps.has(key)) {
      drift.push({ table: "task_deps", id: key, field: "edge", actual: "present", expected: null });
    }
  }
  for (const key of proj.deps.keys()) {
    if (!actual.has(key)) {
      drift.push({ table: "task_deps", id: key, field: "edge", actual: null, expected: "present" });
    }
  }
}

const PLAN_COMPARED_FIELDS = ["scope", "task_id", "version", "title", "body", "status", "author_session_id", "supersedes_id"] as const;

function comparePlans(
  db: Database,
  projectKey: string,
  proj: Projection,
  drift: FieldDrift[],
  incomplete: RebuildReport["incomplete"],
): void {
  const actual = db
    .query<Record<string, unknown>, [string]>("SELECT * FROM plans WHERE project_key = ?")
    .all(projectKey);

  const seen = new Set<string>();
  for (const row of actual) {
    const id = String(row.id);
    seen.add(id);
    const rebuilt = proj.plans.get(id);
    if (!rebuilt) {
      incomplete.push({
        id,
        field: "(whole row)",
        reason: "it exists in the database but there is no plan_created in the event stream - usually history from before plans were versioned",
      });
      continue;
    }
    for (const field of PLAN_COMPARED_FIELDS) {
      const a = normalizeForCompare(field, row[field]);
      const b = normalizeForCompare(field, (rebuilt as unknown as Record<string, unknown>)[toCamel(field)]);
      if (a !== b) drift.push({ table: "plans", id, field, actual: a, expected: b });
    }
  }
  for (const id of proj.plans.keys()) {
    if (!seen.has(id)) {
      drift.push({ table: "plans", id, field: "(whole row)", actual: null, expected: "present" });
    }
  }
}

const HANDOFF_COMPARED_FIELDS = ["task_id", "session_id", "kind", "summary", "next_step", "blockers", "open_questions", "consumed_by"] as const;

function compareHandoffs(
  db: Database,
  projectKey: string,
  proj: Projection,
  drift: FieldDrift[],
  incomplete: RebuildReport["incomplete"],
): void {
  const actual = db
    .query<Record<string, unknown>, [string]>("SELECT * FROM handoffs WHERE project_key = ?")
    .all(projectKey);

  for (const row of actual) {
    const id = num(row.id);
    if (id === null) continue;
    const rebuilt = proj.handoffs.get(id);
    if (!rebuilt) {
      incomplete.push({
        id: String(id),
        field: "(whole row)",
        reason: "the handoff event is in the old format (it carries no full content), so the row cannot be rebuilt from the event stream",
      });
      continue;
    }
    for (const field of HANDOFF_COMPARED_FIELDS) {
      const a = normalizeForCompare(field, row[field]);
      const b = normalizeForCompare(field, (rebuilt as unknown as Record<string, unknown>)[toCamel(field)]);
      if (a !== b) drift.push({ table: "handoffs", id: String(id), field, actual: a, expected: b });
    }
  }
  for (const id of proj.handoffs.keys()) {
    const exists = actual.some((r) => num(r.id) === id);
    if (!exists) {
      drift.push({ table: "handoffs", id: String(id), field: "(whole row)", actual: null, expected: "present" });
    }
  }
}

// =============================================================================
// 写回
// =============================================================================

function writeProjection(db: Database, projectKey: string, proj: Projection): void {
  // ⚠ 不要在这里写 `PRAGMA foreign_keys = OFF`。
  //   SQLite 明确规定：**该 pragma 在事务里是 no-op**（“foreign key constraint
  //   enforcement may only be enabled or disabled when there is no pending BEGIN”），
  //   而本函数恰好是在 withTx 里跑的。旧注释写着“关外键约束”，是假的。
  //   实际也不需要：schema.sql 里没有声明任何 FOREIGN KEY，
  //   所以换表期间既没有约束检查、也没有级联要担心。
  //   （同理 db.ts 的 v1→v2 换表也写了这条，它同样在 migrate 里——那处更早，
  //     当时也没有外键，所以只是无害。但别再照抄成“它在保护什么”。）

  db.query("DELETE FROM task_deps WHERE project_key = ?").run(projectKey);
  db.query("DELETE FROM plans WHERE project_key = ?").run(projectKey);
  db.query("DELETE FROM handoffs WHERE project_key = ?").run(projectKey);
  db.query("DELETE FROM tasks WHERE project_key = ?").run(projectKey);

  const insertTask = db.query(
    `INSERT INTO tasks
       (seq, id, project_key, title, body, status, priority, assignee_session_id,
        lease_expires_at, progress, checklist, labels, parent_id, plan_id, block_reason,
        created_by, created_at, updated_at, started_at, finished_at, estimate_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let seq = 0;
  for (const t of proj.tasks.values()) {
    seq++;
    insertTask.run(
      seq,
      t.id,
      projectKey,
      t.title,
      t.body,
      t.status,
      t.priority,
      t.assignee_session_id,
      t.lease_expires_at,
      t.progress,
      JSON.stringify(t.checklist),
      JSON.stringify(t.labels),
      t.parent_id,
      t.plan_id,
      t.block_reason,
      t.created_by,
      t.created_at,
      t.updated_at,
      t.started_at,
      t.finished_at,
      t.estimate_ms,
    );
  }

  const insertDep = db.query(
    "INSERT INTO task_deps (project_key, task_id, depends_on_id, created_at) VALUES (?, ?, ?, ?)",
  );
  for (const [key, edge] of proj.deps) {
    const [from] = key.split("→");
    if (from) insertDep.run(projectKey, from, edge.dependsOnId, edge.createdAt);
  }

  const insertPlan = db.query(
    `INSERT INTO plans
       (id, project_key, scope, task_id, version, title, body, status,
        author_session_id, created_at, supersedes_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const p of proj.plans.values()) {
    insertPlan.run(
      p.id,
      projectKey,
      p.scope,
      p.taskId,
      p.version,
      p.title,
      p.body,
      p.status,
      p.authorSessionId,
      p.createdAt,
      p.supersedesId,
    );
  }

  const insertHandoff = db.query(
    `INSERT INTO handoffs
       (id, project_key, task_id, session_id, kind, summary, next_step,
        blockers, open_questions, created_at, consumed_by, consumed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const h of proj.handoffs.values()) {
    insertHandoff.run(
      h.id,
      projectKey,
      h.taskId,
      h.sessionId,
      h.kind,
      h.summary,
      h.nextStep,
      JSON.stringify(h.blockers),
      JSON.stringify(h.openQuestions),
      h.createdAt,
      h.consumedBy,
      h.consumedAt,
    );
  }

  // 任务号计数器推到最大值之后，避免重建后立即新建任务就撞号
  const maxNum = db
    .query<{ n: number | null }, [string]>(
      "SELECT MAX(CAST(SUBSTR(id, 3) AS INTEGER)) AS n FROM tasks WHERE project_key = ?",
    )
    .get(projectKey)?.n;
  if (maxNum !== null && maxNum !== undefined) {
    db.query(
      `INSERT INTO project_counters (project_key, next_task_num) VALUES (?, ?)
         ON CONFLICT(project_key) DO UPDATE SET next_task_num = MAX(next_task_num, ?)`,
    ).run(projectKey, maxNum + 1, maxNum + 1);
  }
}

// =============================================================================
// 工具
// =============================================================================

function get(p: Projection, taskId: string | null): TaskProjection | undefined {
  return taskId ? p.tasks.get(normalizeTaskId(taskId)) : undefined;
}

function currentProjectOf(p: Projection, event: KanbanEvent): string {
  void p;
  return event.projectKey ?? "";
}

function toPlanFromData(h: Record<string, unknown>, event: KanbanEvent, ts: number): Plan | null {
  const id = str(h.id) ?? event.planId;
  if (!id) return null;
  return {
    id,
    projectKey: event.projectKey ?? "",
    scope: (str(h.scope) ?? "project") as Plan["scope"],
    taskId: nullableStr(h.task_id),
    version: num(h.version) ?? 1,
    title: str(h.title) ?? "",
    body: str(h.body) ?? "",
    status: (str(h.status) ?? "active") as Plan["status"],
    authorSessionId: nullableStr(h.author_session_id),
    createdAt: num(h.created_at) ?? ts,
    supersedesId: nullableStr(h.supersedes_id),
  };
}

/** 从事件里的 checklist 快照还原（完整保留 done_at / by，保证重建幂等） */
function toChecklist(value: unknown): ChecklistItem[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const it = item as { text?: string; done?: boolean; done_at?: number | null; by?: string | null };
    return {
      text: String(it.text ?? ""),
      done: it.done === true,
      done_at: typeof it.done_at === "number" ? it.done_at : null,
      by: typeof it.by === "string" ? it.by : null,
    };
  });
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function nullableStr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function nullableNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * 规范化比较：checklist 类字段按「{text, done}」投影后的 JSON 比较。
 *
 * 为什么要投影：`done_at` / `by` 是"谁在什么时候勾的"，
 * 老版本事件里没带这两个字段，重建出来会是 null。
 * 但这类差异**不应该**报成漂移（它们不影响"这张卡做到哪了"这个事实），
 * 而一旦报出来，--write 就会把旧库的 done_at 洗成 null，反而更糟。
 */
function normalizeForCompare(field: string, value: unknown): string {
  if (value === undefined || value === null) return "";
  if (field === "checklist" || field === "labels" || field === "blockers" || field === "open_questions") {
    if (typeof value === "string") {
      try {
        return JSON.stringify(sortDeep(JSON.parse(value)));
      } catch {
        return value;
      }
    }
    return JSON.stringify(sortDeep(value));
  }
  return String(value);
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((v) =>
      v && typeof v === "object" ? { text: (v as { text?: string }).text, done: (v as { done?: boolean }).done } : v,
    );
  }
  return value;
}

/** snake_case 列名 → 投影对象上的 camelCase 字段名 */
function toCamel(field: string): string {
  return field.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

void getConfig;
