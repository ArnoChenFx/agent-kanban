/**
 * 错误码与异常体系。
 *
 * 设计要点（见 docs/plan/002-接口契约.md §1.2）：
 * 1. agent 会根据退出码做分支判断，所以退出码一旦发布就必须稳定，不能重新分配含义。
 * 2. 错误对象要"可自我修正"：冲突错误要告诉 agent 当前持有者是谁、最后做了什么，
 *    非法状态转移要列出合法的后继状态，这样 agent 读一次错误就能改对，而不是反复重试。
 */

/** 退出码枚举：数值与契约文档一一对应，禁止变更 */
export const ExitCode = {
  /** 成功 */
  OK: 0,
  /** 参数/用法错误：读 details.usage 修正命令 */
  USAGE: 1,
  /** 状态或数据错误：任务不存在、非法转移、缺少必填 reason。不要重试 */
  STATE: 2,
  /** 冲突：任务被他人持有且租约有效、计划版本冲突。改做别的任务，不要用 --force */
  CONFLICT: 3,
  /** 数据库忙：退避后重试，最多 3 次 */
  BUSY: 4,
  /** 未初始化：找不到 .kanban/ 或 schema 未迁移。跑 agent-kanban init */
  NOT_INIT: 5,
  /** 内部错误：视为 bug，上报而不是重试 */
  INTERNAL: 6,
  /** 远程认证失败：缺 key / key 不对 / project 不存在 */
  AUTH: 7,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/** 错误名字符串：写入 --json 的 error.name，便于脚本精确匹配而不必依赖 code 数值 */
export const ErrorName = {
  USAGE: "USAGE",
  STATE: "STATE",
  CONFLICT: "CONFLICT",
  BUSY: "BUSY",
  NOT_INIT: "NOT_INIT",
  INTERNAL: "INTERNAL",
  AUTH: "AUTH",
} as const;

export type ErrorNameValue = (typeof ErrorName)[keyof typeof ErrorName];

/**
 * 业务异常。所有可预期的失败都通过它抛出，由 CLI 边界统一转成退出码 + JSON 错误对象。
 *
 * details 中承载"让调用方能自我修正"的结构化信息，例如：
 * - 抢占冲突：details.holder = { session_id, agent_name, progress, last_seen_at, last_event }
 * - 非法转移：details.legal_transitions = ["doing", "blocked", "cancelled"]
 * - 用法错误：details.usage = "agent-kanban task claim <id> [--ttl ms] [--force]"
 */
export class KanbanError extends Error {
  readonly code: ExitCodeValue;
  override readonly name: ErrorNameValue;
  readonly details: Record<string, unknown>;

  constructor(
    code: ExitCodeValue,
    name: ErrorNameValue,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.code = code;
    this.name = name;
    this.details = details;
  }

  /** 序列化成 --json 模式下的 error 对象（契约 §1.3） */
  toJSON(): Record<string, unknown> {
    return {
      error: {
        code: this.code,
        name: this.name,
        message: this.message,
        details: this.details,
      },
    };
  }

  // ---- 工厂方法：让调用点保持简洁，且错误信息措辞集中管理 ----

  /** 用法错误：命令参数不对 */
  static usage(
    message: string,
    usage?: string,
    details: Record<string, unknown> = {},
  ): KanbanError {
    return new KanbanError(
      ExitCode.USAGE,
      ErrorName.USAGE,
      message,
      usage ? { ...details, usage } : details,
    );
  }

  /** 状态错误：数据层面不允许的操作 */
  static state(message: string, details: Record<string, unknown> = {}): KanbanError {
    return new KanbanError(ExitCode.STATE, ErrorName.STATE, message, details);
  }

  /**
   * 冲突错误：典型场景是任务已被他人持有且租约有效。
   * holder 字段是 agent 判断"该换任务还是该等"的关键信息，必须带上。
   */
  static conflict(message: string, details: Record<string, unknown> = {}): KanbanError {
    return new KanbanError(ExitCode.CONFLICT, ErrorName.CONFLICT, message, details);
  }

  /** 数据库忙：调用方应退避重试 */
  static busy(message: string, details: Record<string, unknown> = {}): KanbanError {
    return new KanbanError(ExitCode.BUSY, ErrorName.BUSY, message, details);
  }

  /** 未初始化：缺少 .kanban/ 目录或 schema */
  static notInit(message: string, details: Record<string, unknown> = {}): KanbanError {
    return new KanbanError(ExitCode.NOT_INIT, ErrorName.NOT_INIT, message, details);
  }

  /** 远程认证失败：缺 key / key 错 / project 不存在（不区分具体原因，防 key 猜解 oracle） */
  static auth(message: string, details: Record<string, unknown> = {}): KanbanError {
    return new KanbanError(ExitCode.AUTH, ErrorName.AUTH, message, details);
  }

  /** 非法状态转移：额外附带合法后继状态，agent 读一次就能改对 */
  static illegalTransition(
    taskId: string,
    from: string,
    to: string,
    legalTransitions: string[],
  ): KanbanError {
    const list = legalTransitions.length > 0 ? legalTransitions.join(", ") : "(none)";
    return KanbanError.state(
      `task ${taskId} cannot move from ${from} to ${to}; legal transitions: ${list}`,
      { reason: "illegal_transition", task_id: taskId, from, to, legal_transitions: legalTransitions },
    );
  }
}

/**
 * 把任意异常转换成 KanbanError。
 *
 * 关键点：SQLite 的 busy/locked 错误必须映射为 BUSY(4) 而不是 INTERNAL(6)，
 * 因为调用方（agent）的正确反应是"退避重试"而不是"上报 bug"。
 * 这是 ADR-2 的直接落地：并发写竞争是正常现象，不是故障。
 */
export function toKanbanError(err: unknown): KanbanError {
  if (err instanceof KanbanError) return err;

  const message = err instanceof Error ? err.message : String(err);
  const rawCode = (err as { code?: unknown })?.code;

  // SQLITE_BUSY(5) / SQLITE_LOCKED(6)：与 busy_timeout 有关的竞争
  if (rawCode === "SQLITE_BUSY" || rawCode === "SQLITE_LOCKED" || /database is locked/i.test(message)) {
    return KanbanError.busy(
      "database busy (another agent may be writing), back off 1 second and retry, at most 3 times",
      {
        reason: "sqlite_busy",
        sqlite_code: rawCode ?? null,
        hint: "Retry the command; if it keeps happening run agent-kanban doctor",
      },
    );
  }

  /**
   * SQLITE_IOERR(10) / SQLITE_CANTOPEN / "disk I/O error"
   *
   * 在 Windows 上 SQLite 的 WAL 共享内存（-shm）机制在高并发写入时会瞬时报
   * disk I/O error，即使 busy_timeout 设了也不管用（它不是锁，而是共享内存初始化竞争）。
   * 实测：8 进程连续写事务时偶发。agent 场景写入稀疏，偶发概率极低，
   * 但一旦发生必须让 agent 能重试，因此归类为 BUSY(4) 而非 INTERNAL(6)。
   */
  if (
    rawCode === "SQLITE_IOERR" ||
    rawCode === "SQLITE_CANTOPEN" ||
    /disk I\/O error/i.test(message)
  ) {
    return KanbanError.busy(
      "transient database I/O conflict (a known SQLite WAL behaviour on Windows), back off and retry",
      {
        reason: "sqlite_io_error",
        sqlite_code: rawCode ?? null,
        retryable: true,
        hint: "Just retry the same command; if it keeps happening run agent-kanban doctor",
      },
    );
  }

  // 唯一约束冲突：通常是并发下重复分配 ID（正常竞争，可安全重试）
  if (rawCode === "SQLITE_CONSTRAINT_UNIQUE" || /UNIQUE constraint failed/i.test(message)) {
    return KanbanError.conflict("unique constraint failed (usually a normal race under concurrency), safe to retry once", {
      reason: "unique_constraint",
      sqlite_code: rawCode ?? null,
    });
  }

  return new KanbanError(ExitCode.INTERNAL, ErrorName.INTERNAL, message, {
    stack: err instanceof Error ? err.stack : undefined,
  });
}
