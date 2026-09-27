/**
 * 领域类型定义。
 *
 * 这里只放"跨层共享"的类型：core 层的函数签名、CLI/MCP/HTTP 的输入输出都引用它们，
 * 保证三端契约不会各自漂移（ADR-6：单 core 多前端）。
 *
 * 字段命名约定（契约 §6，稳定性要求）：
 * - 数据库列名用 snake_case，TS 属性名用 camelCase，映射在 sql.ts / rows.ts 里集中做
 * - JSON 输出字段名一律 snake_case，因为 agent 脚本和前端 jq 都在用
 */

/** 任务状态机状态集合 */
export const TASK_STATUSES = [
  "backlog", // 想法池，未澄清，不应被随意认领
  "todo", // 已就绪可做（依赖已满足）
  "doing", // 有人正在做（有租约）
  "blocked", // 被阻塞，必须带 reason
  "review", // 产出待人评审
  "done", // 完成（终态之一）
  "cancelled", // 取消（终态之一）
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** 终态集合：不能直接流转，只能经 reopen 回到 todo */
export const TERMINAL_STATUSES: readonly TaskStatus[] = ["done", "cancelled"];

/** 活跃状态：正在占用资源、需要租约维护的状态 */
export const ACTIVE_STATUSES: readonly TaskStatus[] = ["doing"];

/** 会话状态 */
export const SESSION_STATUSES = ["active", "idle", "closed", "crashed"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** 交接类型 */
export const HANDOFF_KINDS = ["voluntary", "crash", "reclaim"] as const;
export type HandoffKind = (typeof HANDOFF_KINDS)[number];

/** 计划作用域与状态 */
export type PlanScope = "project" | "task";
export type PlanStatus = "active" | "superseded" | "draft";

/** 事件类型全集（契约 §7）。以字符串字面量联合而非 enum，便于拼接与穷尽检查。 */
export const EVENT_TYPES = [
  // 会话生命周期
  "session_started",
  "session_heartbeat",
  "session_closed",
  "session_crashed",
  // 任务生命周期
  "task_created",
  "task_updated",
  "task_ready",
  "task_claimed",
  "task_released",
  "task_reclaimed",
  "task_progress",
  "task_note",
  "task_blocked",
  "task_unblocked",
  "task_review",
  "task_done",
  "task_cancelled",
  "task_reopened",
  // 物理删除：事件保留（审计），但重建时不能把任务复活
  "task_removed",
  "dep_added",
  "dep_removed",
  // 计划
  "plan_created",
  "plan_superseded",
  // 凭据与项目的**审计**事件（不是 rebuild 的输入，见下方注释）
  "token_issued",
  "token_revoked",
  "token_updated",
  "project_created",
  "project_renamed",
  "project_key_rotated",
  // 交接
  "handoff_created",
  "handoff_consumed",
  // 系统
  "board_exported",
  "board_imported",
  "snapshot_written",
  "protocol_installed",
  // 审计（与 token_*/project_* 同类：rebuild 刻意不消费）
  "project_deleted",
  "system_notice",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/**
 * ⚠ 关于上面新增的 token_* / project_* 事件：**它们是审计，不是投影**。
 *
 * ADR-1 说「events 是唯一事实来源，tasks/plans/handoffs 都是它的投影」，
 * 但 `tokens` 与 `projects` **不在这个范围里**，而且不应该在：
 *
 *   - `tokens.key_hash` 是凭据的哈希。把它写进事件流，就等于在事件表里
 *     多存一份凭据材料——而事件表会被 `export` 成 JSONL 落到磁盘、被备份、
 *     被 `import` 重放。凭据材料的暴露面应当**只有** tokens 表一处。
 *   - `rebuild --write` 会按事件流**重写投影表**。若 token 是投影，
 *     一条缺哈希的历史事件就会把一个可用的 token 变成不可用（或反之）。
 *
 * 所以这六类事件只回答「谁在什么时候改了什么」，**rebuild 刻意不消费它们**
 * （`applyEvent` 的 default 分支忽略）。这一点必须写清楚，否则下一个人的
 * 直觉是「事件里有就该重建」，然后把凭据哈希塞进事件流。
 */

/** checklist 子项：进度双表示中的细粒度部分（ADR-8） */
export interface ChecklistItem {
  text: string;
  done: boolean;
  done_at?: number | null;
  by?: string | null;
}

/** 任务领域对象（camelCase，对应 tasks 表） */
export interface Task {
  /** 全局自增序号，用作 SSE 游标与稳定排序（**跨 project 唯一**） */
  seq: number;
  /** 对外 ID，如 T-0007。**per-project 唯一**（ADR-9） */
  id: string;
  /** 所属 project */
  projectKey: string;
  title: string;
  body: string | null;
  status: TaskStatus;
  /** 0 最高 … 4 最低 */
  priority: number;
  assigneeSessionId: string | null;
  /** 租约到期时间（epoch ms）。null 表示未持有 */
  leaseExpiresAt: number | null;
  /** 0..100 整数 */
  progress: number;
  checklist: ChecklistItem[];
  labels: string[];
  parentId: string | null;
  /** 当前生效的计划版本 ID */
  planId: string | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  estimateMs: number | null;
  /** 阻塞原因（block 时写入 note 旁的结构化字段，从事件投影得到） */
  blockReason?: string | null;
}

/** 会话领域对象 */
export interface Session {
  id: string;
  agentName: string;
  harness: string | null;
  cwd: string;
  pid: number | null;
  status: SessionStatus;
  startedAt: number;
  /** 最后心跳时间：任何 CLI/MCP 调用都会刷新，这是防误回收的基础 */
  lastSeenAt: number;
  leaseExpiresAt: number | null;
  meta: Record<string, unknown>;
}

/** 事件领域对象（不可变，只追加） */
export interface KanbanEvent {
  seq: number;
  ts: number;
  sessionId: string | null;
  type: EventType;
  taskId: string | null;
  planId: string | null;
  /** 所属 project（ADR-9） */
  projectKey: string | null;
  data: Record<string, unknown>;
}

/** 计划领域对象 */
export interface Plan {
  id: string;
  /** 所属 project（ADR-9） */
  projectKey: string;
  scope: PlanScope;
  taskId: string | null;
  version: number;
  title: string;
  body: string;
  status: PlanStatus;
  authorSessionId: string | null;
  createdAt: number;
  supersedesId: string | null;
}

/** 交接领域对象：恢复上下文的核心载体（ADR-7） */
export interface Handoff {
  id: number;
  /** 所属 project（ADR-9） */
  projectKey: string;
  taskId: string;
  sessionId: string;
  kind: HandoffKind;
  summary: string;
  nextStep: string | null;
  blockers: string[];
  openQuestions: string[];
  createdAt: number;
  consumedBy: string | null;
  consumedAt: number | null;
}

/** 任务依赖 */
export interface TaskDep {
  taskId: string;
  dependsOnId: string;
  createdAt: number;
}

/** 看板快照：把散落的任务、会话、事件汇成一份可直接渲染的数据 */
export interface BoardSnapshot {
  project: { name: string; key: string; createdAt: number | null };
  counts: Record<TaskStatus, number>;
  lanes: Record<TaskStatus, Task[]>;
  sessions: SessionView[];
  /** 最新事件序号，SSE 起点（已按 project 过滤） */
  headSeq: number;
  /**
   * 截断信息：看板一次只取 `limit` 张，但 `counts` 是全量的。
   * 不报出去的话「计数 620 / 只显示 500」看着像卡丢了。
   */
  truncated: {
    /** 泳道里的卡总数（与 counts 口径一致，不含 cancelled） */
    total: number;
    /** 本次实际返回的条数 */
    showing: number;
    limit: number;
    offset: number;
    /** 只在首页（offset=0）为真：还有卡没显示 */
    truncated: boolean;
  };
}

/** 会话视图：在原始会话上附加新鲜度与持有任务，便于人和 agent 判断"谁能动" */
export interface SessionView extends Session {
  /** 心跳相对描述，如 "2m 前" */
  fresh: string;
  /** 是否已超过 grace 阈值（即将或已被判定为失联） */
  stale: boolean;
  /** 正在持有的任务 ID 列表 */
  tasks: string[];
}

/** 统一操作结果包络：CLI --json 与 MCP / HTTP 共用（契约 §3.3） */
export interface OpResult<T = unknown> {
  ok: true;
  data: T;
  /** 专门写给 agent 的建议下一步，避免它猜接下来该干什么 */
  nextActions?: string[];
}

/** 看板级配置（存 meta 表） */
export interface KanbanConfig {
  schemaVersion: number;
  /** 全局默认项目名（仅 init 时写入参考值，实际展示用 projects.name） */
  projectName: string;
  createdAt: number;
  /** 默认租约时长（毫秒），默认 15 分钟；可被 project 级配置覆盖 */
  defaultTtlMs: number;
  /** 失联宽限时长（毫秒），默认 10 分钟；可被 project 级配置覆盖 */
  graceMs: number;
}
