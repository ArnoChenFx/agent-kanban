/**
 * 事务封装。
 *
 * 这是整个数据一致性的基石（ADR-1）：**每一次状态变化都必须在同一个事务里
 * 完成"改投影 + 写事件"两件事**，因此不存在"状态变了但没有日志"或
 * "有日志但状态没变"的中间态。崩溃恢复、审计、rebuild 全都依赖这个不变量。
 *
 * 事务模式固定为 BEGIN IMMEDIATE：
 * - 立即取写锁，避免 DEFERRED 事务在升级锁时才发现冲突（SQLITE_BUSY_SNAPSHOT）
 * - 配合 busy_timeout=5000，并发写会等待而不是立刻失败（探针已实测）
 * - agent 场景写频率低（分钟级），串行化写完全可接受
 */

import type { Database } from "bun:sqlite";
import { toKanbanError } from "./errors.ts";
import type { EventType } from "./types.ts";

/**
 * 事务上下文：传给业务回调，用于写事件。
 * 业务代码只能通过 emit 写事件，从而保证事件字段被统一规范化（契约 §6）。
 */
export interface TxContext {
  /** 数据库句柄（已处于事务内） */
  db: Database;
  /** 写入事件：与业务修改在同一事务，失败一起回滚 */
  emit: (event: EmitInput) => number;
  /** 逻辑时钟（毫秒）。测试可注入固定时钟，让时间相关测试无需 sleep */
  now: () => number;
  /** 会话标识：写事件时若未显式指定 session_id，则用这个 */
  sessionId: string | null;
  /**
   * 当前 project（ADR-9）。所有写操作自动打上这个 project_key，
   * 所以业务函数不需要到处传 projectKey —— 它在本上下文里。
   */
  projectKey: string;
}

export interface EmitInput {
  type: EventType;
  taskId?: string | null;
  planId?: string | null;
  sessionId?: string | null;
  projectKey?: string | null;
  data?: Record<string, unknown>;
  /** 显式时间戳，仅测试与 import 重放时使用 */
  ts?: number;
}

/** 事务执行结果泛型 */
export type TxResult<T> = T;

/** 退避重试配置 */
export interface RetryOptions {
  /** 最大重试次数（不含首次尝试） */
  maxRetries?: number;
  /** 首次退避时长（毫秒），后续按倍数递增 */
  baseDelayMs?: number;
}

/**
 * 可重试的 SQLite 错误码。
 *
 * - SQLITE_BUSY / SQLITE_LOCKED：写锁竞争，busy_timeout 已经等过一轮，再来一次多半能成
 * - SQLITE_IOERR：Windows 上 SQLite WAL 共享内存（-shm）初始化的瞬时竞争。
 *   实测 8 进程连续写时偶发，与 busy_timeout 无关，退避后重试即可恢复。
 */
const RETRYABLE_CODES = new Set(["SQLITE_BUSY", "SQLITE_LOCKED", "SQLITE_IOERR"]);

/** 判断异常是否值得重试 */
function isRetryable(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === "string" && RETRYABLE_CODES.has(code)) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /database is locked|disk I\/O error/i.test(message);
}

/** 同步睡眠（Bun.sleep） */
function sleepSync(ms: number): void {
  // 用 Atomics.wait 在主线程阻塞指定毫秒：这里没有异步上下文（Bun 的 sleep 是 async）
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

/**
 * 在 BEGIN IMMEDIATE 事务中执行回调，瞬时竞争时自动退避重试。
 *
 * 重要前提（重试安全的前提）：**回调内部只能做数据库操作，不能有外部副作用**
 * （发网络请求、写外部文件、累加内存变量等）。
 * 因为重试意味着整个事务会被重跑一遍。本项目所有 core 写函数都满足这个约束。
 * 未来若加入外部副作用调用，必须移到事务之外。
 *
 * @param opts.retry 退避配置；传 { maxRetries: 0 } 可关闭重试
 */
export function withTx<T>(
  db: Database,
  fn: (ctx: TxContext) => TxResult<T>,
  opts: { now?: () => number; sessionId?: string | null; projectKey?: string } & RetryOptions = {},
): T {
  const nowFn = opts.now ?? Date.now;
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 40;
  // projectKey 缺省为 "default"：本地模式与未迁移库的兼容回退
  const projectKey = opts.projectKey ?? "default";

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let begun = false;
    try {
      db.exec("BEGIN IMMEDIATE");
      begun = true;

      const ctx: TxContext = {
        db,
        now: nowFn,
        sessionId: opts.sessionId ?? null,
        projectKey,
        emit: (event: EmitInput) =>
          insertEvent(db, event, nowFn(), opts.sessionId ?? null, projectKey),
      };

      const result = fn(ctx);
      db.exec("COMMIT");
      begun = false;
      return result;
    } catch (err) {
      if (begun) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // 回滚失败说明连接已不可用，保留原始异常更有价值
        }
      }
      lastError = err;

      // 不可重试的错误直接抛出
      if (!isRetryable(err) || attempt === maxRetries) {
        throw toKanbanError(err);
      }
      // 退避后重试：40ms → 80ms → 160ms（指数递增）
      sleepSync(baseDelayMs * 2 ** attempt);
    }
  }

  // 理论上不可达（循环内必定返回或抛出）
  throw toKanbanError(lastError);
}

/**
 * 插入事件行。
 *
 * 单独抽出来是为了让"import 从 journal 重放"能复用同一条插入路径，
 * 保证重放产生的事件与原事件逐字段一致（replay 测试依赖这一点）。
 */
export function insertEvent(
  db: Database,
  event: EmitInput,
  ts: number,
  fallbackSessionId: string | null,
  fallbackProjectKey: string,
): number {
  // data 至少是 {}（契约 §6：保证 .data.pct 之类的访问不会炸）
  const payload = JSON.stringify(event.data ?? {});
  const row = db
    .query<
      { seq: number },
      [number, string | null, string, string | null, string | null, string, string]
    >(
      `INSERT INTO events (ts, session_id, type, task_id, plan_id, project_key, data)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ts,
      event.sessionId !== undefined ? event.sessionId : fallbackSessionId,
      event.type,
      event.taskId ?? null,
      event.planId ?? null,
      event.projectKey ?? fallbackProjectKey,
      payload,
    );
  return Number(row.lastInsertRowid);
}

/** 取当前最大事件 seq（board 快照的 headSeq / SSE 起点） */
export function headSeq(db: Database, projectKey?: string): number {
  const row = projectKey
    ? db
        .query<{ seq: number | null }, [string]>(
          "SELECT MAX(seq) AS seq FROM events WHERE project_key = ?",
        )
        .get(projectKey)
    : db.query<{ seq: number | null }, []>("SELECT MAX(seq) AS seq FROM events").get();
  return row?.seq ?? 0;
}
