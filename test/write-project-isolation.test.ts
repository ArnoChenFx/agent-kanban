/**
 * 任务**写路径**的 project 隔离。
 *
 * ## 为什么要单开一个文件（与 deps-project-isolation.test.ts 互补）
 *
 * 那个文件守的是 `task_deps` 的**读**路径（`listTasks({ready})` 的 NOT EXISTS 子查询、
 * `getWaitingDepsMap` 的相关子查询）。本文件守的是**写**：在 project A 里改一张卡，
 * 不能连带改掉 project B 里同号的那张。
 *
 * ## 曾经的 bug（全部静默，单 project 的库永远暴露不了）
 *
 * `tasks` 的唯一约束是 `UNIQUE(project_key, id)`，**T 编号是 per-project 的**（ADR-9：
 * agent 口语里的 "T-0007" 必须只指向本 project 的卡）。但 16 条写路径曾经只按 `id` 匹配：
 *
 *   - `claimTask` / `forceClaim` / `renewLease` / `updateProgress` / `addNote` /
 *     `editTask` / `transition` / `releaseTask` / `notifyDependentsReady`（tasks.ts）
 *   - `closeSession` / `reapZombies`（sessions.ts）
 *   - `releaseOrphans`（doctor.ts）
 *   - `compactEvents` 的 `DELETE FROM events`（backup.ts，且 projectKey 收了没用）
 *   - admin 的 `DELETE /api/admin/projects/:key`（http.ts）
 *
 * 三种后果，都不报错：
 *   1. 污染：在 A 里改标题/进度/状态，B 的同号卡跟着变
 *   2. 原子性被摧毁：在 A 抢了 T-0002 之后，B 里**根本抢不到自己的 T-0002**，
 *      因为 `before` 读到的 assignee 已被污染，判定成"别人在持有"
 *   3. **抢走健康会话的卡**：`reapZombies` 只按 id 更新，于是 sA 崩溃时把
 *      sB 手里 40% 的同号卡一并回收——整套租约机制存在的理由（防重复劳动）被反转
 *
 * ## 守卫分两层
 *
 * - **行为层**：两个 project 各有同号卡，在 A 里跑完整套生命周期后逐字段对比 B 的行。
 * - **静态层**：扫全仓 SQL 字面量，凡涉及 project 作用域业务表的语句必须出现
 *   `project_key`。行为测试只能钉住已经写出来的那几条，静态层才能拦住
 *   "新加一个查询时忘了带"。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createProject } from "../src/core/projects.ts";
import { closeSession, createSession, reapZombies, touchSession } from "../src/core/sessions.ts";
import { runDoctor } from "../src/core/doctor.ts";
import { compactEvents } from "../src/core/backup.ts";
import {
  addDependency,
  addNote,
  claimTask,
  createTask,
  editTask,
  getTask,
  releaseTask,
  transition,
  updateProgress,
} from "../src/core/tasks.ts";
import type { Task } from "../src/core/types.ts";
import { withTx } from "../src/core/tx.ts";
import { createTestDb, type TestDb } from "./helpers/db.ts";

const ROOT = resolve(import.meta.dir, "..");

/** 递归列出仓库里的 TS 源码（排除 .d.ts）——静态守卫共用 */
function tsSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsSources(p));
    else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}
const P1 = "p1";
const P2 = "p2";

let t: TestDb;
let clock: number;

beforeEach(() => {
  clock = 1_700_000_000_000;
  t = createTestDb({ projectKey: P1, now: clock });
  createProject(t.db, { key: P2, name: "第二个项目", rootPath: t.path, apiKeyHash: null });
});

afterEach(() => {
  t.cleanup();
});

/** 在指定 project 下建任务 */
function mk(projectKey: string, title: string): string {
  let id = "";
  withTx(t.db, (c) => { id = createTask(c, { title }).id; }, { now: () => clock, projectKey });
  return id;
}

/** 某 project 下某张卡的可比较快照（只看会被写路径改动的字段） */
function snapshot(projectKey: string, taskId: string): Record<string, unknown> {
  const task = getTask({ db: t.db, projectKey }, taskId);
  if (!task) return { missing: true };
  return shape(task);
}

/** 任务的「形状」：所有写路径可能改动的字段 */
function shape(task: Task): Record<string, unknown> {
  return {
    status: task.status,
    title: task.title,
    body: task.body,
    priority: task.priority,
    progress: task.progress,
    labels: task.labels,
    checklist: task.checklist,
    assignee: task.assigneeSessionId,
    lease: task.leaseExpiresAt,
    blockReason: task.blockReason ?? null,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
  };
}

/** 在指定 project 下建一个会话（sessions 表是全局的，不属于任何 project） */
function mkSession(id: string, name: string, lastSeenAt: number): void {
  withTx(
    t.db,
    (c) => {
      c.db
        .query(
          `INSERT INTO sessions (id, agent_name, harness, cwd, pid, status, started_at, last_seen_at, lease_expires_at, meta)
           VALUES (?, ?, NULL, '/x', NULL, 'active', ?, ?, NULL, '{}')`,
        )
        .run(id, name, lastSeenAt, lastSeenAt);
    },
    { now: () => clock, projectKey: "system" },
  );
  void createSession;
}

describe("写路径隔离：在 p1 里的任何操作都不该动到 p2 的同号卡", () => {
  // 两个 project 各自从 T-0001 开始，天然撞号——这正是 bug 的触发条件
  const t1 = "T-0001";
  let t2 = "";

  beforeEach(() => {
    mk(P1, "p1 的卡");
    t2 = mk(P2, "p2 的卡");
    // 断言前提：两张卡真的撞号了（否则下面的对比毫无意义）
    expect(t1).toBe(t2);
  });

  test("edit / claim / progress / note / release / transition 之后 p2 逐字段不变", () => {
    const before = snapshot(P2, t2);
    mkSession("sA", "A", clock);

    withTx(t.db, (c) => { editTask(c, t1, { title: "p1 改过的标题", priority: 0 }); }, { now: () => clock, projectKey: P1 });
    withTx(t.db, (c) => { claimTask(c, t1, { sessionId: "sA", now: clock }); }, { now: () => clock, projectKey: P1 });
    withTx(t.db, (c) => { updateProgress(c, t1, { sessionId: "sA", now: clock }, { pct: 50, note: "在做" }); }, { now: () => clock, projectKey: P1 });
    withTx(t.db, (c) => { addNote(c, t1, { sessionId: "sA", now: clock }, "又一条备注"); }, { now: () => clock, projectKey: P1 });
    withTx(t.db, (c) => { transition(c, t1, "review", { sessionId: "sA", now: clock }, {}); }, { now: () => clock, projectKey: P1 });
    withTx(t.db, (c) => { transition(c, t1, "doing", { sessionId: "sA", now: clock }, {}); }, { now: () => clock, projectKey: P1 });
    withTx(t.db, (c) => { releaseTask(c, t1, { sessionId: "sA", now: clock }); }, { now: () => clock, projectKey: P1 });
    withTx(t.db, (c) => { transition(c, t1, "done", { sessionId: "sA", now: clock }, { force: true }); }, { now: () => clock, projectKey: P1 });

    expect(snapshot(P2, t2)).toEqual(before);
    // 同时确认 p1 那边真的改了（否则上面那条断言可能是因为什么都没发生）
    expect(snapshot(P1, t1)).not.toEqual(before);
  });

  test("checklist 与依赖也一样隔离", () => {
    mkSession("sA", "A", clock);
    mk(P1, "p1 的上游");
    const before = snapshot(P2, t2);

    withTx(
      t.db,
      (c) => {
        editTask(c, t1, { labels: ["p1-only"] });
        updateProgress(c, t1, { sessionId: "sA", now: clock }, { check: [], addCheck: ["步骤一"] });
      },
      { now: () => clock, projectKey: P1 },
    );
    withTx(t.db, (c) => { addDependency(c, "T-0002", t1); }, { now: () => clock, projectKey: P1 });

    expect(snapshot(P2, t2)).toEqual(before);
  });

  test("完成上游时不会在 p2 凭空解阻同号的 blocked 卡", () => {
    // p2：T-0001 依赖 T-0002，且 T-0001 处于 blocked
    mk(P2, "p2 的上游");
    withTx(t.db, (c) => { addDependency(c, t2, "T-0002"); }, { now: () => clock, projectKey: P2 });
    withTx(t.db, (c) => { transition(c, t2, "blocked", { sessionId: null, now: clock }, { reason: "等东西" }); }, { now: () => clock, projectKey: P2 });
    // p1：同样连一条 T-0001 → T-0002 的边，并把 T-0001 置为 blocked
    mk(P1, "p1 的上游");
    mkSession("sA", "A", clock);
    withTx(t.db, (c) => { addDependency(c, t1, "T-0002"); }, { now: () => clock, projectKey: P1 });
    withTx(t.db, (c) => { transition(c, t1, "blocked", { sessionId: null, now: clock }, { reason: "p1 的原因" }); }, { now: () => clock, projectKey: P1 });

    // 先单独验证 p2 自己的机制是通的（否则后面的断言可能因为机制坏了而假绿）
    withTx(t.db, (c) => { transition(c, "T-0002", "done", { sessionId: null, now: clock }, { force: true }); }, { now: () => clock, projectKey: P2 });
    expect(getTask({ db: t.db, projectKey: P2 }, t2)!.status).toBe("todo");

    // p1 把自己的 T-0002 完成 → 也会触发 notifyDependentsReady("T-0001")
    withTx(t.db, (c) => { transition(c, "T-0002", "done", { sessionId: "sA", now: clock }, { force: true }); }, { now: () => clock, projectKey: P1 });
    expect(getTask({ db: t.db, projectKey: P1 }, t1)!.status).toBe("todo");

    // 关键断言：p2 的 T-0001 不该因为 p1 的动作而被**再改一次**
    // （修复前 p1 的 notifyDependentsReady 会把 p2 的同号 blocked 卡也推回 todo）
    const p2task = getTask({ db: t.db, projectKey: P2 }, t2)!;
    expect(p2task.status).toBe("todo");
    expect(p2task.blockReason ?? null).toBeNull();
  });

  test("claim 的原子性：p1 抢过 T-0001 之后，p2 仍能抢自己的 T-0001", () => {
    mkSession("sA", "A", clock);
    mkSession("sB", "B", clock);

    withTx(t.db, (c) => { claimTask(c, t1, { sessionId: "sA", now: clock }); }, { now: () => clock, projectKey: P1 });
    // 修复前这里会抛 CONFLICT（读到被污染的 assignee），且 p2 的卡其实已是 doing
    const claimed = withTx(
      t.db,
      (c) => claimTask(c, t2, { sessionId: "sB", now: clock }).id,
      { now: () => clock, projectKey: P2 },
    );

    expect(claimed).toBe("T-0001");
    expect(getTask({ db: t.db, projectKey: P2 }, t2)!.assigneeSessionId).toBe("sB");
    expect(getTask({ db: t.db, projectKey: P1 }, t1)!.assigneeSessionId).toBe("sA");
  });

  test("reapZombies 回收崩溃会话时，不会释放另一个健康会话的同号卡", () => {
    // 直接插行以隔离被测语句：两个 project 的 T-0002 归属不同会话
    const ins = t.db.query(
      `INSERT INTO tasks (id, project_key, title, status, priority, progress, labels, checklist,
                          assignee_session_id, lease_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, 'doing', 2, 40, '[]', '[]', ?, ?, ?, ?)`,
    );
    ins.run("T-0002", P1, "p1 的卡（sA 拿着）", "sA", clock + 900_000, clock, clock);
    ins.run("T-0002", P2, "p2 的卡（sB 拿着）", "sB", clock + 900_000, clock, clock);
    mkSession("sA", "A", clock); // 心跳停在 clock
    mkSession("sB", "B", clock + 30 * 60_000); // 刚刚还在动

    const later = clock + 30 * 60_000;
    const result = reapZombies(t.db, { graceMs: 10 * 60_000, now: later });

    expect(result.crashedSessions).toEqual(["sA"]);
    expect(result.reclaimedTasks.map((r) => `${r.taskId}@${r.projectKey}`)).toEqual([`T-0002@${P1}`]);
    // 核心断言：p2 那个正被健康会话持有的卡完好无损
    const p2task = getTask({ db: t.db, projectKey: P2 }, "T-0002")!;
    expect(p2task.status).toBe("doing");
    expect(p2task.assigneeSessionId).toBe("sB");
    expect(p2task.progress).toBe(40);
  });

  test("closeSession 只释放本会话在目标 project 之外也不误伤同号卡", () => {
    const ins = t.db.query(
      `INSERT INTO tasks (id, project_key, title, status, priority, progress, labels, checklist,
                          assignee_session_id, lease_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, 'doing', 2, 30, '[]', '[]', ?, ?, ?, ?)`,
    );
    ins.run("T-0003", P1, "p1 的卡（sX 拿着）", "sX", clock + 900_000, clock, clock);
    ins.run("T-0003", P2, "p2 的卡（sY 拿着）", "sY", clock + 900_000, clock, clock);
    mkSession("sX", "X", clock);
    mkSession("sY", "Y", clock);

    withTx(
      t.db,
      (c) => { closeSession(c, "sX"); },
      { now: () => clock, projectKey: P1 },
    );

    expect(getTask({ db: t.db, projectKey: P1 }, "T-0003")!.status).toBe("todo");
    const p2task = getTask({ db: t.db, projectKey: P2 }, "T-0003")!;
    expect(p2task.status).toBe("doing");
    expect(p2task.assigneeSessionId).toBe("sY");
  });

  test("doctor --fix 回收孤儿时只动本 project 的同号卡", () => {
    const ins = t.db.query(
      `INSERT INTO tasks (id, project_key, title, status, priority, progress, labels, checklist,
                          assignee_session_id, lease_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, 'doing', 2, 30, '[]', '[]', ?, ?, ?, ?)`,
    );
    ins.run("T-0004", P1, "p1 的卡（持卡人失联）", "sGone", clock, clock, clock);
    ins.run("T-0004", P2, "p2 的卡（健康会话持有）", "sOK", clock, clock, clock);
    mkSession("sGone", "Gone", clock); // 失联
    mkSession("sOK", "OK", clock + 60_000); // 新鲜

    const report = runDoctor(t.db, {
      projectKey: P1,
      now: clock + 30 * 60_000,
      graceMs: 10 * 60_000,
      fix: true,
    });

    expect(report.issues.some((i) => i.code === "stale_lease" && i.fixed)).toBe(true);
    expect(getTask({ db: t.db, projectKey: P1 }, "T-0004")!.status).toBe("todo");
    const p2task = getTask({ db: t.db, projectKey: P2 }, "T-0004")!;
    expect(p2task.status).toBe("doing");
    expect(p2task.assigneeSessionId).toBe("sOK");
  });

  test("compact --project p1 不会删掉 p2 的事件", () => {
    mkSession("sA", "A", clock);
    // p1 造一张会走到终态的卡：终态任务的历史才可被裁剪（非终态一律保留）
    mk(P1, "p1 的第二张");
    withTx(t.db, (c) => { transition(c, "T-0002", "done", { sessionId: null, now: clock }, { force: true }); }, { now: () => clock, projectKey: P1 });
    // p2 同样造一点历史（含一个终态），否则「p2 没被删」可能只是因为它本来就没东西可删
    mk(P2, "p2 又一张");
    withTx(t.db, (c) => { transition(c, "T-0002", "done", { sessionId: null, now: clock }, { force: true }); }, { now: () => clock, projectKey: P2 });

    const p1Before = t.db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM events WHERE project_key = ?")
      .get(P1)!.n;
    const p2Before = t.db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM events WHERE project_key = ?")
      .get(P2)!.n;
    expect(p1Before).toBeGreaterThan(0);
    expect(p2Before).toBeGreaterThan(0);

    // keepDays = 0 + 很久的 now → 超出 cutoff 的都够老
    // snapshotOut 要放进一个真实目录：TestDb 的 path 是**库文件**路径而非目录。
    const snapDir = mkdtempSync(join(tmpdir(), "kanban-snap-"));
    const res = compactEvents(t.db, {
      keepDays: 0,
      snapshotOut: join(snapDir, "snap.json"),
      now: clock + 365 * 86_400_000,
      projectKey: P1,
      scope: { db: t.db, projectKey: P1 },
    });
    rmSync(snapDir, { recursive: true, force: true });

    // p1 确实被裁了（否则下面那个「p2 没变」可能只是因为什么都没发生）
    expect(res.removed).toBeGreaterThan(0);
    const p1After = t.db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM events WHERE project_key = ?")
      .get(P1)!.n;
    expect(p1After).toBeLessThan(p1Before);
    // p2 的事件一条都不能少
    const p2After = t.db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM events WHERE project_key = ?")
      .get(P2)!.n;
    expect(p2After).toBe(p2Before);
  });
});

/**
 * 静态守卫：凡涉及 project 作用域业务表的 SQL，整条语句里必须出现 `project_key`。
 *
 * ## 为什么必须扫全仓而不是只靠行为测试
 *
 * 这类 bug 的特征是「新加一个查询/更新时忘了带 project_key」——它不会让任何现有
 * 行为测试变红，只会在多 project 部署下静默串数据。这里把整棵树的 SQL 字面量扫一遍，
 * 把「忘了带」变成提交时就能看到的失败。
 *
 * ## 判据
 *
 * 扫 `FROM|JOIN|UPDATE|INTO <表>`，读、写、插入都算；排除 DDL。
 * **需要 project_key 谓词的表**：`tasks` / `task_deps` / `plans` / `handoffs` / `events`。
 *
 * **例外只两类**（都不在上面的名单里）：
 *   - `sessions`：故意**不带** project_key（ADR-9：会话是 agent 进程身份，可以跨项目
 *     工作；租约回收因此是全局的）。下面有一条反向守卫钉住这一点。
 *   - `projects` / `meta` / `project_counters`：主键已含 project 标识。
 *
 * ## 为什么用「显式白名单 + 必须写理由」而不是自动推断
 *
 * 有一类语句**天然无法从字面量判定**：`WHERE ${where.join(" AND ")}` 这种
 * 「子句数组拼装」写法，`project_key` 在数组里而不在字符串里（listTasks / listPlans
 * / compactEvents / queryEvents 都是这个形状）。自动规则要么误报一片、要么放行一切，
 * 那样的守卫比没有更糟——它会训练人忽略自己的输出。
 *
 * 所以例外必须**逐条手写**并附理由。新增例外时要回答的问题是
 * 「为什么这条跨 project 是安全的」，而不是「怎么让扫描闭嘴」。
 * 真正的把关仍在行为层（本文件上半部分）与 deps-project-isolation.test.ts。
 */
describe("静态守卫：project 作用域业务表的 SQL 必须带 project_key", () => {
  /** 需要 project_key 谓词的表（sessions / projects / meta / project_counters 除外） */
  const GUARDED_TABLES = ["tasks", "task_deps", "plans", "handoffs", "events"];

  /**
   * 逐条白名单。每条 = 「能唯一认出这条语句的正则」+「为什么跨 project 是安全的」（必填）。
   *
   * 用正则而不是整句字面量：SQL 会被重新格式化（换行、缩进），字面量匹配会在
   * 一次无关的 prettier 式改动后突然失配，报出一个看不懂的失败。
   *
   * 新增例外时要回答的是「为什么这条跨 project 是安全的」，而不是「怎么让扫描闭嘴」。
   * 真正的把关仍在行为层（本文件上半部分）与 deps-project-isolation.test.ts。
   */
  const ALLOWED: Array<{ id: string; match: RegExp; why: string }> = [
    // ---- 子句数组拼装：project_key 在数组里，不在字面量里 ----
    {
      id: "tasks.ts/listTasks",
      match: /SELECT \* FROM tasks WHERE \$\{where\.join/,
      why: "listTasks 的子句数组第一项恒为 'project_key = ?'，见函数开头",
    },
    {
      id: "plans.ts/listPlans",
      match: /SELECT \* FROM plans WHERE \$\{where\.join/,
      why: "listPlans 的子句数组第一项恒为 'project_key = ?'，见函数开头",
    },
    {
      id: "events.ts/queryEvents",
      match: /SELECT \* FROM events \$\{whereSql\}/,
      why: "queryEvents 的 projectKey 是可选入参（不传 = 跨 project，仅 server 内部用）",
    },
    {
      id: "backup.ts/compactEvents",
      match: /DELETE FROM events WHERE \$\{clauses\.join/,
      why: "compactEvents 的子句数组第一项恒为 'project_key = ?'（已修，见该函数注释）",
    },

    // ---- 全局键查询：主键本身就全局唯一，不存在跨 project 命中 ----
    {
      id: "events.ts/getEvent",
      match: /SELECT \* FROM events WHERE seq = \?/,
      why: "events.seq 是全局 AUTOINCREMENT 主键",
    },
    {
      id: "tx.ts/headSeq",
      match: /SELECT MAX\(seq\) AS seq FROM events/,
      why: "headSeq(db) 不传 projectKey 时就是全局最大游标（board/SSE 起点）",
    },
    {
      id: "events.ts/countEvents",
      match: /SELECT COUNT\(\*\) AS c FROM events/,
      why: "countEvents(db) 不传 projectKey 时就是全局计数",
    },
    {
      id: "handoff.ts/getHandoff",
      match: /SELECT \* FROM handoffs WHERE id = \?/,
      why: "handoffs.id 是全局 AUTOINCREMENT 主键",
    },
    {
      id: "handoff.ts/consumeHandoff",
      match: /UPDATE handoffs SET consumed_by = \?/,
      why: "同上（主键全局唯一）；调用方的 id 列表已按 project 过滤（resumeTask / context.get）",
    },
    {
      id: "backup.ts/importEvents 去重集合",
      match: /SELECT seq FROM events\s*[`"']?$/,
      why: "importEvents 的幂等去重集合：seq 全局唯一，跨 project 重叠才是真正要拦的重复",
    },

    // ---- 刻意保留的保底阈值：用全局值是有意为之 ----
    {
      id: "backup.ts/compactEvents 保底 1000 条",
      match: /SELECT seq FROM events ORDER BY seq DESC LIMIT 1 OFFSET 999/,
      why: "compactEvents 的「至少留 1000 条」保底，取全局值只会多留不会少留，偏保守",
    },
    // 注：曾经还有一条「http.ts/health 探活」的例外（回全局 head_seq），
    //   已随 /api/health 只回 liveness 一起删掉。删除后「白名单不得腐化」那条断言
    //   立刻报它未使用——这正是那条断言的用途。

    // ---- sessions 跳 project：这些查询刻意跨 project ----
    {
      id: "sessions.ts/getSessionTasks",
      match: /SELECT \* FROM tasks WHERE assignee_session_id = \? ORDER BY seq/,
      why: "getSessionTasks：会话可跨项目工作，这里要的是它在所有看板上的卡",
    },
    {
      id: "sessions.ts/toSessionView 无 projectKey 分支",
      match: /SELECT id FROM tasks WHERE assignee_session_id = \? ORDER BY seq/,
      why: "toSessionView 未传 projectKey 时的分支（调用方需要本 project 视图时会传）",
    },

    // ---- 脚本：故意不隔离的地方 ----
    {
      id: "verify-rebuild.ts 注入漂序 1",
      match: /UPDATE tasks SET title = '被偷偷改过的标题'/,
      why: "rebuild 自检故意注入漂移，验证 check 能报出来；单 project 的临时库",
    },
    {
      id: "verify-rebuild.ts 注入漂移 2",
      match: /UPDATE tasks SET progress = 99 WHERE id = 'T-0003'/,
      why: "同上（故意注入漂移），用来验证 rebuild --check 能报出来",
    },
    {
      id: "seed-demo.ts 的排查说明字符串 1",
      match: /^[`"']?FROM tasks[`"']?$/,
      why: "这是脚本里讲怎么排查的中文说明字符串里的反引号片段，不是真的 SQL",
    },
    {
      id: "seed-demo.ts 的排查说明字符串 2",
      match: /^[`"']?FROM events[`"']?$/,
      why: "同上，说明字符串里的反引号片段",
    },
    {
      id: "seed-demo.ts 的排查说明字符串 3",
      match: /^[`"']?FROM handoffs[`"']?$/,
      why: "同上，说明字符串里的反引号片段",
    },
    {
      id: "seed-demo.ts 的排查说明整句",
      match: /Grep for .*without a project predicate/,
      why: "同上，整句中文说明；它同时含三个被扫到的表名",
    },
  ];

  function stringLiterals(src: string): string[] {
    return [
      ...[...src.matchAll(/`[^`]*`/g)].map((m) => m[0]),
      ...[...src.matchAll(/"(?:[^"\\\n]|\\.)*"/g)].map((m) => m[0]),
    ];
  }

  test("src/ 与 scripts/ 里没有不带 project_key 的语句（除白名单外）", () => {
    const files = [...tsSources(join(ROOT, "src")), ...tsSources(join(ROOT, "scripts"))];
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];
    const usedAllowances = new Set<string>();
    for (const file of files) {
      const rel = file.slice(ROOT.length + 1);
      const src = readFileSync(file, "utf8");
      for (const lit of stringLiterals(src)) {
        const hit = GUARDED_TABLES.find((table) =>
          new RegExp(`\\b(?:FROM|JOIN|UPDATE|INTO)\\s+${table}\\b`, "i").test(lit),
        );
        if (!hit) continue;
        if (/\b(?:CREATE|ALTER|DROP)\s+TABLE\b/i.test(lit)) continue;
        if (/\bproject_key\b/.test(lit)) continue;
        const allowance = ALLOWED.find((a) => a.match.test(lit));
        if (allowance) {
          usedAllowances.add(allowance.id);
          continue;
        }
        const line = src.slice(0, src.indexOf(lit)).split(/\r?\n/).length;
        violations.push(`${rel}:${line} [${hit}] → ${lit.replace(/\s+/g, " ").slice(0, 140)}`);
      }
    }
    expect(violations).toEqual([]);

    // 白名单也不能腐化：代码改了语句、理由已不适用，却没人回来清理
    const stale = ALLOWED.filter((a) => !usedAllowances.has(a.id)).map((a) => a.id);
    expect(stale).toEqual([]);
  });

  test("白名单里每一条都写了理由，且 id 唯一", () => {
    const ids = ALLOWED.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of ALLOWED) {
      expect(a.why.trim().length).toBeGreaterThanOrEqual(12);
    }
  });

  /**
   * 反向守卫：sessions 表确实**刻意**不带 project_key。
   *
   * 有了上面的白名单，这条就必要了：将来若有人「顺手」给 sessions 也加
   * project_key（看起来像在修 bug），会话就会退化成 project 局部，
   * 跨项目工作的 agent 在另一个看板上的租约不再被回收——而这条没有任何
   * 行为测试会红。
   */
  test("sessions 表仍然刻意不带 project_key（跨项目回收依赖这一点）", () => {
    const schema = readFileSync(join(ROOT, "src/core/schema.sql"), "utf8");
    const sessionsBlock = schema.slice(
      schema.indexOf("CREATE TABLE IF NOT EXISTS sessions"),
      schema.indexOf("CREATE INDEX IF NOT EXISTS idx_sessions_status"),
    );
    expect(sessionsBlock).toContain("CREATE TABLE IF NOT EXISTS sessions");
    expect(sessionsBlock).not.toContain("project_key");
  });
});

/**
 * 验收脚本不得隐式用仓库根定位库（否则会砸开发者的真实看板）。
 *
 * ## 事故记录
 *
 * `scripts/verify-rebuild.ts` 与 `scripts/verify-recovery.ts` 曾经用
 * `cwd: ROOT` spawn CLI、且开头就 `init --force`，于是每次有人跑
 * `bun run scripts/verify-rebuild.ts`，**开发者自己的看板就被重置 + 灌夹具卡**。
 * verify-rebuild 还会在中间**故意改坏投影**（改标题/状态、错改进度、删依赖）再修复。
 *
 * 本轮实际踩到：18 张真卡被冲成一张 `实现崩溃恢复`。
 *
 * AGENTS.md 早就记过这个坑（「别让验收脚本的 CLI 跑在仓库根」）并修了
 * `verify-web-ui.ts`，但这两个脚本当时漏了——所以这里用静态扫描钉住。
 *
 * ## 判据（窄，但精确）
 *
 * **spawn CLI 时若 `cwd` 是仓库根（或没写 cwd），该脚本必须把库指到别处**
 * ——即脚本里出现 `--db` 或 `KANBAN_DB`。只要有，cwd 就不再参与库的定位。
 *
 * 判在**文件级**而不是 spawn 块级：`--db` 通常写在传给包装函数的参数数组里
 * （`cli(["init", "--db", dbPath])`），不在 `spawn(...)` 块内，块级扫描会误报。
 *
 * 反过来，**不要求**每个脚本都建临时目录：`seed-demo` / `dogfood` 本来就该
 * 操作仓库里那个库（它们是工具，不是回归）。
 */
describe("静态守卫：验收脚本不得靠 cwd 隐式定位库", () => {
  const SCRIPTS = tsSources(join(ROOT, "scripts"));

  test("scripts/ 里 spawn CLI 时不会在仓库根隐式找库", () => {
    const violations: string[] = [];
    for (const file of SCRIPTS) {
      const rel = file.slice(ROOT.length + 1).replace(/\\/g, "/");
      const src = readFileSync(file, "utf8");
      // 只看真正 spawn 了 CLI 的脚本
      if (!/spawn\([\s\S]{0,400}?cli\.ts/.test(src)) continue;
      // 有没有把 cwd 指向仓库根（或没写，默认为继承）
      const usesRepoRoot = /cwd:\s*(?:ROOT|"\.")/.test(src) || !/cwd:\s*\w+/.test(src);
      if (!usesRepoRoot) continue;
      // 文件里有没有显式把库指到别处
      if (/--db\b/.test(src) || /KANBAN_DB/.test(src)) continue;
      violations.push(`${rel}: spawn CLI 时 cwd 可能是仓库根，且全文没有 --db / KANBAN_DB`);
    }
    expect(violations).toEqual([]);
  });

  test("会 init --force 的脚本必须建临时目录并清理", () => {
    // 破坏性最强的两个：它们会重置投影 + 故意弄脏 + 修复
    for (const name of ["verify-rebuild.ts", "verify-recovery.ts"]) {
      const src = readFileSync(join(ROOT, "scripts", name), "utf8");
      expect(src).toContain("mkdtempSync");
      expect(src).toContain("rmSync"); // 否则临时目录越堆越多
      expect(src).toMatch(/tmpdir\(\)/);
    }
  });

  test("seed-demo / dogfood 这类工具脚本不被这条守卫误伤（它们本就该用仓库里的库）", () => {
    // 它们确实要操作仓库里那个库，但必须**默认指向一个明确的路径**而不是
    // “碰巧在仓库根跑”。这里钉住它们仍然声明自己的默认 --db。
    for (const name of ["seed-demo.ts", "dogfood.ts"]) {
      const src = readFileSync(join(ROOT, "scripts", name), "utf8");
      expect(src).toMatch(/--db|\.kanban/);
    }
  });
});

void touchSession;
void ({} as Database);
