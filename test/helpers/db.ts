/**
 * 测试辅助：临时数据库与可控时钟。
 *
 * 为什么需要可控时钟：租约/心跳/僵尸回收全部基于时间，
 * 用真实 sleep 会让测试慢且不稳定（还要处理 CI 机器负载波动）。
 * 这里提供"可注入的逻辑时钟"，让时间相关测试确定性地推进。
 */

import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, setInitialConfig } from "../../src/core/db.ts";
import { createProject } from "../../src/core/projects.ts";
import { withTx, type TxContext } from "../../src/core/tx.ts";
import type { Scope } from "../../src/core/tasks.ts";

/** 测试库句柄：含裸连接、可控时钟与自动清理 */
export interface TestDb {
  db: Database;
  /** 默认 project 的读取作用域（ADR-9：core 的读函数需要 {db, projectKey}） */
  scope: Scope;
  /** 构造另一个 project 的作用域（用于 project 隔离测试） */
  scopeOf(projectKey: string): Scope;
  /** 推进逻辑时钟（毫秒） */
  advance(ms: number): void;
  /** 当前逻辑时间 */
  now(): number;
  /** 在测试库上跑一个写事务（可指定 project） */
  tx(fn: (ctx: TxContext) => void, opts?: { projectKey?: string; sessionId?: string | null }): void;
  /** 清理临时目录 */
  cleanup(): void;
  /** 路径（给需要多进程访问的场景） */
  path: string;
}

/** 创建隔离的测试库（自动建一个本地 project，key 固定为 "test"） */
export function createTestDb(opts: { now?: number; projectKey?: string } = {}): TestDb {
  const dir = mkdtempSync(join(tmpdir(), "kanban-test-"));
  const path = join(dir, "test.db");
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");

  // 直接复用生产的迁移逻辑，保证测试跑的就是真实 schema
  const handle = { raw: db, dbPath: path, dir };
  migrate(handle);
  setInitialConfig(db, { projectName: "test-project", now: opts.now ?? Date.now() });

  // 创建默认 project（API 侧本地模式行为：自动派生一个）
  const projectKey = opts.projectKey ?? "test";
  createProject(db, { key: projectKey, name: "test-project", rootPath: dir, apiKeyHash: null });

  // 固定起点，避免依赖真实时间
  let clock = opts.now ?? 1_700_000_000_000;

  return {
    db,
    path,
    scope: { db, projectKey },
    scopeOf: (key: string) => ({ db, projectKey: key }),
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
    tx: (fn, txOpts = {}) => {
      withTx(db, fn, {
        now: () => clock,
        sessionId: txOpts.sessionId ?? null,
        projectKey: txOpts.projectKey ?? projectKey,
      });
    },
    cleanup: () => {
      try {
        db.close();
      } catch {
        // 已关闭则忽略
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 常用的 Actor 构造 */
export function actorAt(
  clock: () => number,
  sessionId: string | null,
  ttlMs?: number,
): { sessionId: string | null; now: number; ttlMs?: number } {
  return { sessionId, now: clock(), ttlMs };
}

/** 等待子进程退出并返回完整结果 */
export async function runProcess(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}
