/**
 * 会话心跳：**任何 Op 执行都必须刷新 last_seen_at**。
 *
 * ## 这条为什么值得单开一个文件
 *
 * 失联判据是 `sessions.last_seen_at`（ADR-4 L1）：超过宽限期没刷新就判 crashed，
 * 回收它持有的卡，并从事件流反推出一条 crash 交接。
 * 整个机制的前提是「agent 一直在调命令，所以调命令就算报平安」。
 *
 * 曾经 `touchSession` **零调用点**——函数和注释都在，但没人调。
 * 于是 `last_seen_at` 只在 `session start` 和显式 `session heartbeat` 时更新，
 * 一个连续工作 30 分钟、每 3 分钟调一次 `task progress` 的**完全正常**的 agent，
 * 在第 12 分钟被自己的下一条命令判成 crashed。这不是边缘情况，
 * 它就是默认配置（宽限 10 分钟）下最普通的用法。
 *
 * 症状之所以能长期存在：全程不报错、不空屏，`task progress` 照常成功
 * （回收后 assignee 变 NULL，而 updateProgress 只在「非 NULL 且不是我」时才报冲突），
 * 于是 agent 一边在被回收的卡上继续写进度，一边系统告诉别的 agent
 * 「这张卡的持有者失联了，快来接手」——正好制造项目要防的重复劳动。
 *
 * 守卫分三层：
 *   1. 行为：下面的「连续工作不会被判失联」
 *   2. 接线：`touchSession` 的调用点存在（防止又被摘掉）
 *   3. 顺序：刷新发生在 reapZombies **之前**
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { executeOp, type OpContext } from "../src/core/ops.ts";
import {
  DEFAULT_GRACE_MS,
  TOUCH_THROTTLE_MS,
  createSession,
  getSession,
  reapZombies,
  touchSession,
} from "../src/core/sessions.ts";
import { getTask } from "../src/core/tasks.ts";
import { createTestDb, type TestDb } from "./helpers/db.ts";
import { withTx } from "../src/core/tx.ts";

const ROOT = resolve(import.meta.dir, "..");

let t: TestDb;
/** 可推进的逻辑时钟（毫秒） */
let clock: number;

const PROJECT = "test";

beforeEach(() => {
  clock = 1_700_000_000_000;
  t = createTestDb({ projectKey: PROJECT, now: clock });
});

afterEach(() => {
  t.cleanup();
});

/** 在本 project 下建一个 Op 上下文（模拟一次 CLI/MCP 调用） */
function opCtx(sessionId: string | null, ttlMs = 15 * 60_000): OpContext {
  return { db: t.db, projectKey: PROJECT, sessionId, now: () => clock, ttlMs };
}

/** 走 op 层建会话（session.start 会把 last_seen_at 设为 now） */
function startSession(id: string, name = "worker"): void {
  executeOp({ kind: "session.start", params: { agent_name: name, id } }, opCtx(null));
}

/** 推进逻辑时钟 */
function advance(ms: number): void {
  clock += ms;
}

describe("心跳：连续干活的 agent 不会被判失联", () => {
  test("每 3 分钟调一次 task progress，干满 30 分钟仍持有卡、会话仍是 active", () => {
    startSession("s-live");
    executeOp({ kind: "task.create", params: { title: "要做的卡" } }, opCtx(null));
    executeOp({ kind: "task.claim", params: { task_id: "T-0001" } }, opCtx("s-live"));

    for (let i = 1; i <= 10; i++) {
      advance(3 * 60_000);
      executeOp(
        { kind: "task.progress", params: { task_id: "T-0001", pct: i * 10, note: `第 ${i} 步` } },
        opCtx("s-live"),
      );
      // 真实命令开头都会跑回收
      reapZombies(t.db, { graceMs: DEFAULT_GRACE_MS, now: clock });

      const session = getSession(t.db, "s-live")!;
      const task = getTask({ db: t.db, projectKey: PROJECT }, "T-0001")!;
      expect(session.status).toBe("active");
      expect(task.status).toBe("doing");
      expect(task.assigneeSessionId).toBe("s-live");
      expect(task.progress).toBe(i * 10);
    }
  });

  test("真的失联（不调任何命令）仍会被判 crashed 并回收，进度保留", () => {
    startSession("s-dead");
    executeOp({ kind: "task.create", params: { title: "被丢下的卡" } }, opCtx(null));
    executeOp({ kind: "task.claim", params: { task_id: "T-0001" } }, opCtx("s-dead"));
    advance(3 * 60_000);
    executeOp(
      { kind: "task.progress", params: { task_id: "T-0001", pct: 40 } },
      opCtx("s-dead"),
    );

    // 彻底不再调用：直接跳到 30 分钟后跑回收
    advance(30 * 60_000);
    const result = reapZombies(t.db, { graceMs: DEFAULT_GRACE_MS, now: clock });

    expect(result.crashedSessions).toEqual(["s-dead"]);
    const task = getTask({ db: t.db, projectKey: PROJECT }, "T-0001")!;
    expect(task.status).toBe("todo");
    expect(task.assigneeSessionId).toBeNull();
    // ADR-4 L2：回收保留进度，新 agent 从「做到哪」接着做
    expect(task.progress).toBe(40);
    // 崩溃交接必须被合成（这是 ADR-7 L3 的兜底路径）
    expect(t.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM handoffs").get()!.n).toBe(1);
  });

  test("只有一个 session 失联时，不影响别的活跃会话持有的卡", () => {
    startSession("s-a", "A");
    startSession("s-b", "B");
    executeOp({ kind: "task.create", params: { title: "A 的卡" } }, opCtx(null));
    executeOp({ kind: "task.create", params: { title: "B 的卡" } }, opCtx(null));
    executeOp({ kind: "task.claim", params: { task_id: "T-0001" } }, opCtx("s-a"));
    executeOp({ kind: "task.claim", params: { task_id: "T-0002" } }, opCtx("s-b"));

    advance(20 * 60_000);
    // A 死了（没人调它），B 一直在干活
    reapZombies(t.db, { graceMs: DEFAULT_GRACE_MS, now: clock - 15 * 60_000 });
    executeOp({ kind: "task.progress", params: { task_id: "T-0002", pct: 60 } }, opCtx("s-b"));
    reapZombies(t.db, { graceMs: DEFAULT_GRACE_MS, now: clock });

    expect(getSession(t.db, "s-a")!.status).toBe("crashed");
    expect(getSession(t.db, "s-b")!.status).toBe("active");
    expect(getTask({ db: t.db, projectKey: PROJECT }, "T-0001")!.status).toBe("todo");
    const bTask = getTask({ db: t.db, projectKey: PROJECT }, "T-0002")!;
    expect(bTask.status).toBe("doing");
    expect(bTask.assigneeSessionId).toBe("s-b");
  });
});

describe("心跳：节流与边界", () => {
  test("节流窗口内不重复写（避免把每条命令变成一次写）", () => {
    startSession("s-t");
    advance(TOUCH_THROTTLE_MS - 1_000);
    expect(touchSession(t.db, "s-t", clock)).toBe(false);
    advance(2_000);
    expect(touchSession(t.db, "s-t", clock)).toBe(true);
    expect(getSession(t.db, "s-t")!.lastSeenAt).toBe(clock);
  });

  test("会话行不存在时返回 false，不静默造行", () => {
    expect(touchSession(t.db, "s-ghost", clock)).toBe(false);
  });

  test("时钟回拨：last_seen_at 在未来时视为新鲜（不算超时）", () => {
    startSession("s-future");
    // 模拟系统时间被往回调：last_seen_at 比 now 还新
    t.db.query("UPDATE sessions SET last_seen_at = ? WHERE id = 's-future'").run(clock + 60_000);
    reapZombies(t.db, { graceMs: DEFAULT_GRACE_MS, now: clock });
    expect(getSession(t.db, "s-future")!.status).toBe("active");
  });

  test("没有僵尸时不开写事务（每条命令都跑 reap，不该每次抢全库写锁）", () => {
    startSession("s-idle");
    advance(5 * 60_000);
    // 会话仍新鲜 → 快路径应当直接返回，不进 withTx。
    // 用「事务能否嵌套」当探针：故意在一个写事务里调它，
    // 若它开了事务就会因 BEGIN 嵌套而抛 SQLITE_ERROR。
    expect(() => {
      withTx(
        t.db,
        () => {
          reapZombies(t.db, { graceMs: DEFAULT_GRACE_MS, now: clock });
        },
        { now: () => clock, projectKey: PROJECT },
      );
    }).not.toThrow();
  });
});

/**
 * 接线守卫：防止有人把心跳调用点摘掉，或把顺序颠倒。
 *
 * 为什么要有这一层：上面那些行为测试全部依赖「executeOp 会刷新」这个前提。
 * 万一有人重构时把 `touchSession(...)` 从 executeOp 里删了（比如嫌多一次查询），
 * 行为测试会以「心跳没刷新」的方式集体变红，但**报出来的错会指向 reapZombies**，
 * 让人去查回收逻辑——查不到真正的原因。这里直接把调用点钉住。
 */
describe("接线守卫：心跳的调用点与顺序", () => {
  function read(rel: string): string {
    return readFileSync(join(ROOT, rel), "utf8");
  }

  test("ops.ts 在 executeOp 里刷新心跳（远程模式只有 server 端能刷）", () => {
    expect(read("src/core/ops.ts")).toMatch(/touchSession\(\s*ctx\.db,\s*ctx\.sessionId,\s*ctx\.now\(\)/);
  });

  test("commands/context.ts 里 touchSession 出现在 reapZombies **之前**", () => {
    const src = read("src/commands/context.ts");
    const touchAt = src.indexOf("touchSession(handle.raw");
    const reapAt = src.indexOf("reapZombies(handle.raw");
    expect(touchAt).toBeGreaterThan(-1);
    expect(reapAt).toBeGreaterThan(-1);
    // 顺序错了就是那个「agent 证明自己活着的命令杀死它」的 bug
    expect(touchAt).toBeLessThan(reapAt);
  });

  test("touchSession 自带节流常量，不允许退回成每条命令一次写", () => {
    expect(read("src/core/sessions.ts")).toContain("TOUCH_THROTTLE_MS");
  });
});
