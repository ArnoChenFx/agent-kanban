/**
 * 并发测试：多个真实进程争抢同一张任务卡。
 *
 * 这是本项目最关键的正确性保证：如果两个 agent 同时认领同一张卡，
 * 就会出现重复劳动（本项目要解决的核心问题之一）。
 *
 * 断言："恰好 1 个赢家"，而不是"至少 1 个"。多赢家 = 两个 agent 以为都是自己的。
 *
 * 探针已验证技术可行性（8 进程 × 25 事务 0 次 BUSY），
 * 这里把它固化成回归测试。
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { KanbanError } from "../src/core/errors.ts";
import { migrate, openDb, setInitialConfig } from "../src/core/db.ts";
import { withTx } from "../src/core/tx.ts";
import { claimTask, createTask } from "../src/core/tasks.ts";
import { createSession } from "../src/core/sessions.ts";
import { actorAt, createTestDb, type TestDb } from "./helpers/db.ts";

/** src/core 目录绝对路径：worker 脚本写在临时目录，必须用绝对路径 import 核心模块 */
const SRC_DIR = join(import.meta.dir, "..", "src", "core");

describe("同进程多连接并发抢占", () => {
  let t: TestDb;

  beforeAll(() => {
    t = createTestDb();
  });
  afterAll(() => {
    t.cleanup();
  });

  test("条件 UPDATE 保证只有一个赢家（changes 判定）", () => {
    let taskId = "";
    t.tx((tx) => {
      taskId = createTask(tx, { title: "争抢目标" }).id;
    });

    // 第二个独立连接 = 模拟另一个进程（避免同连接事务互相嵌套）
    const other = new Database(t.path, { readwrite: true, create: false });
    other.exec("PRAGMA busy_timeout = 5000");

    // 赢家先抢到
    t.tx((tx) => {
      claimTask(tx, taskId, actorAt(t.now, "s-winner"));
    });

    // 输家必须拿到 CONFLICT(3)，且错误里能拿到赢家信息
    // 注意：第二个连接必须传**同一个 projectKey**，否则会因为 project 隔离而
    // 报"任务不存在(STATE)"而不是"冲突(CONFLICT)"——这正好证明了隔离生效
    let caught: KanbanError | null = null;
    try {
      withTx(
        other,
        (ctx) => {
          claimTask(ctx, taskId, actorAt(t.now, "s-loser"));
        },
        { now: t.now, sessionId: "s-loser", projectKey: t.scope.projectKey },
      );
    } catch (e) {
      caught = e as KanbanError;
    }

    expect(caught).toBeInstanceOf(KanbanError);
    expect(caught!.code).toBe(3); // CONFLICT
    const holder = caught!.details.holder as { session_id: string };
    expect(holder.session_id).toBe("s-winner");

    // 补一个反向断言：换个 projectKey 就**看不到这张卡**了（隔离而非仅过滤）
    let crossProjectCode: number | null = null;
    try {
      withTx(
        other,
        (ctx) => {
          claimTask(ctx, taskId, actorAt(t.now, "s-other"));
        },
        { now: t.now, sessionId: "s-other", projectKey: "another-project" },
      );
    } catch (e) {
      crossProjectCode = (e as KanbanError).code;
    }
    expect(crossProjectCode).toBe(2); // STATE：任务在别的 project 里不可见
    other.close();
  });
});

describe("多进程并发抢占（真实子进程）", () => {
  let dir: string;
  let dbPath: string;
  let taskId: string;
  let sessions: string[];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "kanban-conc-"));
    dbPath = join(dir, "kanban.db");

    // 建库 + 建卡 + 建 8 个会话
    const setup = new Database(dbPath, { create: true });
    setup.exec("PRAGMA journal_mode = WAL");
    const handle = openDb(dbPath);
    migrate(handle);
    setInitialConfig(handle.raw, { projectName: "conc-test" });
    // 必须关闭这个额外连接：它会在整个测试期间持有文件句柄，
    // 导致 afterAll 里的 rmSync 报 EBUSY
    handle.raw.close();

    withTx(
      setup,
      (ctx) => {
        taskId = createTask(ctx, { title: "并发争抢" }).id;
        sessions = Array.from({ length: 8 }, (_, i) =>
          createSession(ctx, { agentName: `agent-${i}`, id: `s-c${String(i).padStart(5, "0")}` }).id,
        );
      },
      { now: () => Date.now() },
    );
    setup.close();
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("8 进程同时 claim 同一张卡：恰好 1 个成功，其余退出码 3", async () => {
    // 每个子进程跑一个独立脚本：模拟真实的多个 agent 会话
    const workerPath = join(dir, "worker.ts");
    writeFileSync(
      workerPath,
      `
import { Database } from "bun:sqlite";
const [dbPath, taskId, sessionId] = Bun.argv.slice(2);
const db = new Database(dbPath, { readwrite: true, create: false });
db.exec("PRAGMA busy_timeout = 5000");
const { withTx } = await import(${JSON.stringify(join(SRC_DIR, "tx.ts"))});
const { claimTask } = await import(${JSON.stringify(join(SRC_DIR, "tasks.ts"))});
try {
  withTx(db, (ctx) => {
    claimTask(ctx, taskId, { sessionId, now: Date.now(), ttlMs: 15 * 60 * 1000 });
  }, { now: () => Date.now(), sessionId });
  process.stdout.write("WON:" + sessionId);
  process.exit(0);
} catch (err) {
  const code = err?.code ?? -1;
  process.stderr.write(String(err?.message ?? err));
  process.exit(code);   // 3 = CONFLICT，4 = BUSY
}
`,
      "utf8",
    );

    // 同时启动 8 个子进程
    const procs = sessions.map((sid) =>
      Bun.spawn(["bun", workerPath, dbPath, taskId, sid], { stdout: "pipe", stderr: "pipe" }),
    );

    const results = await Promise.all(
      procs.map(async (p) => {
        const out = await new Response(p.stdout).text();
        const err = await new Response(p.stderr).text();
        const code = await p.exited;
        return { out, err, code };
      }),
    );

    const winners = results.filter((r) => r.code === 0 && r.out.includes("WON"));
    const conflicts = results.filter((r) => r.code === 3);
    const busy = results.filter((r) => r.code === 4);
    const others = results.filter((r) => r.code !== 0 && r.code !== 3 && r.code !== 4);

    // 失败进程里出现意外错误时要能看到原因
    for (const o of others) {
      console.error(`意外失败 exit=${o.code}: ${o.err}`);
    }

    expect(winners.length).toBe(1); // 恰好 1 个赢家 —— 多赢家就是重复劳动
    expect(conflicts.length).toBe(7); // 其余都是冲突
    expect(busy.length + others.length).toBe(0); // 不允许 SQLITE_BUSY（busy_timeout 已设 5s）

    // 最终状态：持有者就是那个赢家
    const winnerSession = winners[0]!.out.replace("WON:", "").trim();
    const check = new Database(dbPath, { readwrite: true, create: false });
    const row = check.query<{ status: string; assignee: string | null }, [string]>(
      "SELECT status, assignee_session_id AS assignee FROM tasks WHERE id = ?",
    ).get(taskId);
    expect(row!.status).toBe("doing");
    expect(row!.assignee).toBe(winnerSession);
    check.close();
  }, 30000);

  test("并发写不会产生 SQLITE_BUSY（busy_timeout 生效）", async () => {
    // 8 进程各做 10 次 claim/release 循环，验证长事务下也不 BUSY
    const workerPath = join(dir, "churn.ts");
    writeFileSync(
      workerPath,
      `
import { Database } from "bun:sqlite";
const [dbPath, taskId, sessionId] = Bun.argv.slice(2);
const db = new Database(dbPath, { readwrite: true, create: false });
db.exec("PRAGMA busy_timeout = 5000");
const { withTx } = await import(${JSON.stringify(join(SRC_DIR, "tx.ts"))});
const { createTask, claimTask, releaseTask } = await import(${JSON.stringify(join(SRC_DIR, "tasks.ts"))});
let wins = 0, losses = 0;
for (let i = 0; i < 10; i++) {
  // 每轮建一张自己的卡并完成它：模拟真实的多 agent 并行工作
  try {
    withTx(db, (ctx) => {
      const id = createTask(ctx, { title: "并发任务 " + i }).id;
      const actor = { sessionId, now: Date.now(), ttlMs: 15 * 60 * 1000 };
      claimTask(ctx, id, actor);
      releaseTask(ctx, id, actor, "并发测试");
    }, { now: () => Date.now(), sessionId });
    wins++;
  } catch (err) {
    if (err?.code === 3) losses++; else { process.stderr.write(String(err?.message ?? err)); process.exit(99); }
  }
}
process.stdout.write(JSON.stringify({ wins, losses }));
`,
      "utf8",
    );

    const procs = sessions.map((sid) =>
      Bun.spawn(["bun", workerPath, dbPath, taskId, sid], { stdout: "pipe", stderr: "pipe" }),
    );
    const results = await Promise.all(
      procs.map(async (p) => {
        const out = await new Response(p.stdout).text();
        const err = await new Response(p.stderr).text();
        const code = await p.exited;
        return { out, err, code };
      }),
    );

    for (const r of results) {
      expect(r.code).toBe(0); // 99 = 遇到非冲突错误（如 BUSY），必须为 0
    }
    // 所有任务都应成功创建（每张卡只被自己碰）
    const totalWins = results.reduce((sum, r) => sum + (JSON.parse(r.out || '{"wins":0}').wins as number), 0);
    expect(totalWins).toBe(80); // 8 进程 × 10 轮
  }, 60000);
});

describe("ID 分配并发唯一性", () => {
  test("8 进程并发建任务：ID 无重复", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-id-"));
    const dbPath = join(dir, "kanban.db");
    const setup = new Database(dbPath, { create: true });
    const handle = openDb(dbPath);
    migrate(handle);
    setInitialConfig(handle.raw, { projectName: "id-test" });
    handle.raw.close();
    setup.close();

    const worker = join(dir, "mk.ts");
    writeFileSync(
      worker,
      `
import { Database } from "bun:sqlite";
const [dbPath, n] = Bun.argv.slice(2);
const db = new Database(dbPath, { readwrite: true, create: false });
db.exec("PRAGMA busy_timeout = 5000");
const { withTx } = await import(${JSON.stringify(join(SRC_DIR, "tx.ts"))});
const { createTask } = await import(${JSON.stringify(join(SRC_DIR, "tasks.ts"))});
const ids: string[] = [];
for (let i = 0; i < Number(n); i++) {
  withTx(db, (ctx) => { ids.push(createTask(ctx, { title: "T" }).id); }, { now: () => Date.now(), sessionId: "s-w" + n });
}
process.stdout.write(JSON.stringify(ids));
`,
      "utf8",
    );

    const procs = Array.from({ length: 8 }, (_, i) =>
      Bun.spawn(["bun", worker, dbPath, "10"], { stdout: "pipe", stderr: "pipe" }),
    );
    const results = await Promise.all(
      procs.map(async (p) => {
        const out = await new Response(p.stdout).text();
        const err = await new Response(p.stderr).text();
        const code = await p.exited;
        return { out, err, code };
      }),
    );
    const allIds: string[] = [];
    for (const r of results) {
      if (r.code !== 0) console.error("ID 分配 worker 失败:", r.out, r.err);
      expect(r.code).toBe(0);
      allIds.push(...(JSON.parse(r.out) as string[]));
    }
    // 80 个 ID 必须两两不同
    expect(allIds.length).toBe(80);
    expect(new Set(allIds).size).toBe(80);
    rmSync(dir, { recursive: true, force: true });
  }, 60000);
});
