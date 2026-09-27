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
  /**
   * 换一个会话身份，返回新的 Backend（连接复用，只换 sessionId）。
   *
   * 存在的原因：CLI 每次调用是一个独立进程，sessionId 从参数/文件读就行；
   * 而 MCP server 是**长驻进程**，agent 会在同一个进程里先 session_start
   * 再用返回的 id 调二十个工具。sessionId 存在构造参数里就没法中途换。
   *
   * 返回新实例而不是就地改：Backend 允许并发调用（MCP 允许多路 tools/call），
   * 就地改 sessionId 会让另一个在飞中的请求用到错的身份。
   */
  withSession(sessionId: string | null): Backend;
  /** 关闭资源（本地关连接；远程无操作） */
  close(): void;
}

/** LocalBackend 的构造选项 */
export interface LocalBackendOptions {
  db: Database;
  projectKey: string;
  sessionId?: string | null;
  now?: () => number;
  ttlMs?: number;
  /** 项目根目录；用于 doctor 检查 AGENTS.md 协作协议 */
  projectRoot?: string;
  /**
   * **调用方**的工作目录。
   *
   * `session.start` 会把它记进 `sessions.cwd`（“agent 从哪个目录发起”）。
   * 以前那行写的是 `ctx.db ? process.cwd() : process.cwd()` —— 三元两边一样，
   * 而远程模式下 `process.cwd()` 是 **server** 的目录，记成那个会让人以为
   * 持有者就在 server 的目录里。所以由调用方显式传，缺省就不填（不猜）。
   */
  cwd?: string;
}

/** LocalBackend：同进程直调 core */
export class LocalBackend implements Backend {
  readonly mode = "local" as const;
  readonly projectKey: string;
  private readonly db: Database;
  private readonly sessionId: string | null;
  private readonly nowFn: () => number;
  private readonly ttlMs: number | undefined;
  private readonly projectRoot: string | undefined;
  /** 调用方的工作目录（见 LocalBackendOptions.cwd） */
  private readonly cwd: string | undefined;
  /** 原始构造参数：withSession 重建时复用，避免字段拆成一堆平行私有成员 */
  private readonly opts: LocalBackendOptions;

  constructor(opts: LocalBackendOptions) {
    this.db = opts.db;
    this.projectKey = opts.projectKey;
    this.sessionId = opts.sessionId ?? null;
    this.nowFn = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs;
    this.projectRoot = opts.projectRoot;
    this.cwd = opts.cwd;
    this.opts = {
      db: this.db,
      projectKey: this.projectKey,
      sessionId: this.sessionId,
      now: this.nowFn,
      ttlMs: this.ttlMs,
      cwd: this.cwd,
      projectRoot: this.projectRoot,
    };
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
      cwd: this.cwd,
      projectRoot: this.projectRoot,
    };
    return executeOp(op, ctx);
  }

  /** 换一个会话身份：复用同一个 db 句柄，不开新连接（MCP 整个生命周期只开一次库） */
  withSession(sessionId: string | null): Backend {
    return new LocalBackend({ ...this.opts, sessionId });
  }

  close(): void {
    // 连接的关闭由 Ctx 管理（closeCtx），这里不重复关
  }
}
