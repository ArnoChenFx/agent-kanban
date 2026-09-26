/**
 * Backend 抽象：本地与远程的唯一差别（ADR-10）。
 *
 * 命令层只认这个接口，不关心数据在本地 SQLite 还是远端 server：
 *
 *   命令层 ──Op──► Backend.execute(op)
 *                     ├─ LocalBackend  ──► executeOp()  同进程
 *                     └─ RemoteBackend ──► POST /api/op ──► server ──► executeOp()
 *
 * 因为两端最终都走 executeOp，**行为一致性是结构保证**：
 * 不存在"本地能用、远程报错"的分支漂移。
 */

import type { Database } from "bun:sqlite";
import { executeOp, type Op, type OpContext } from "./ops.ts";

/** Backend 接口 */
export interface Backend {
  /** 运行模式：本地 or 远程（UI 与报错信息需要区分） */
  readonly mode: "local" | "remote";
  /** 当前 project key */
  readonly projectKey: string;
  /** 执行一个 Op，返回其 data */
  execute<T = unknown>(op: Op): Promise<T>;
  /**
   * 执行 Op 并取回 next_actions（专门写给 agent 的下一步建议）。
   *
   * 为什么单独一个方法：next_actions 是 Op 执行的"副产品"，
   * 本地可以直接拿 executeOp 的返回值，远程要从响应体的 next_actions 字段读。
   * 统一成这个方法后，命令层不需要关心当前是本地还是远程。
   */
  executeWithHints(op: Op): Promise<{ data: unknown; nextActions: string[] }>;
  /** 关闭资源（本地关连接；远程无操作） */
  close(): void;
}

/** LocalBackend：同进程直调 core */
export class LocalBackend implements Backend {
  readonly mode = "local" as const;
  readonly projectKey: string;
  private readonly db: Database;
  private readonly sessionId: string | null;
  private readonly nowFn: () => number;
  private readonly ttlMs: number | undefined;

  constructor(opts: {
    db: Database;
    projectKey: string;
    sessionId?: string | null;
    now?: () => number;
    ttlMs?: number;
  }) {
    this.db = opts.db;
    this.projectKey = opts.projectKey;
    this.sessionId = opts.sessionId ?? null;
    this.nowFn = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs;
  }

  async execute<T = unknown>(op: Op): Promise<T> {
    const { data } = this.run(op);
    return data as T;
  }

  /** 本地模式：直接拿 executeOp 的双返回值（含 next_actions） */
  executeWithHints(op: Op): Promise<{ data: unknown; nextActions: string[] }> {
    return Promise.resolve(this.run(op));
  }

  /** 同步执行（仅本地；供 server 内部与测试用） */
  run(op: Op): { data: unknown; nextActions: string[] } {
    const ctx: OpContext = {
      db: this.db,
      projectKey: this.projectKey,
      sessionId: this.sessionId,
      now: this.nowFn,
      ttlMs: this.ttlMs,
    };
    return executeOp(op, ctx);
  }

  close(): void {
    // 连接的关闭由 Ctx 管理（closeCtx），这里不重复关
  }
}
