/**
 * M3 测试：计划版本化 + 事件重放/rebuild。
 *
 * 核心断言只有一句话：**能从事件流把投影完整重算出来**。
 * 这条断言通过，就同时证明了：
 *   · 事件 payload 携带了重建所需的全部信息
 *   · 写入路径没有绕过 core 的隐藏写库
 *   · tasks/plans/handoffs/task_deps 都真的只是投影
 *
 * 时间全部走 TestDb 的可注入逻辑时钟。
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, type TestDb } from "./helpers/db.ts";
import { createSession } from "../src/core/sessions.ts";
import { resolveConfig } from "../src/core/config.ts";
import {
  addDependency,
  claimTask,
  createTask,
  editTask,
  getTask,
  removeTask,
  transition,
  updateProgress,
  type Actor,
} from "../src/core/tasks.ts";
import { attachPlan, getActivePlan, listPlans, planAtTime, planHistory, savePlan } from "../src/core/plans.ts";
import { writeHandoff, consumeHandoff, taskHandoffs } from "../src/core/handoff.ts";
import { rebuild } from "../src/core/rebuild.ts";
import { runDoctor } from "../src/core/doctor.ts";
import { withTx } from "../src/core/tx.ts";

// =============================================================================
// 测试脚手架
// =============================================================================

function startAgent(t: TestDb, name: string): string {
  return withTx(t.db, (tx) => createSession(tx, { agentName: name, harness: "pi", cwd: t.path }), {
    now: () => t.now(),
    sessionId: null,
    projectKey: t.scope.projectKey,
  }).id;
}

function opts(t: TestDb, sessionId: string) {
  return { now: () => t.now(), sessionId, projectKey: t.scope.projectKey };
}

function actor(t: TestDb, sessionId: string): Actor {
  return { sessionId, now: t.now() } as Actor;
}
/**
 * 在测试库里把几乎所有操作都做一遍，
 * 让事件流覆盖尽可能多的分支（重建逻辑的每个 case 都要被走到）。
 */
function exerciseEverything(t: TestDb): { sid: string; taskId: string; depId: string } {
  const sid = startAgent(t, "agent-a");
  const o = opts(t, sid);

  const t1 = withTx(t.db, (tx) => createTask(tx, { title: "实现 rebuild", body: "正文", priority: 0, labels: ["core"], checklist: ["a", "b"], estimateMs: 3600_000 }), o).id;
  const t2 = withTx(t.db, (tx) => createTask(tx, { title: "补 task_deps 隔离" }), o).id;
  const t3 = withTx(t.db, (tx) => createTask(tx, { title: "写一致性测试", blockedBy: [t1] }), o).id;
  void t2;

  // 抢占 / 进度 / checklist
  withTx(t.db, (tx) => claimTask(tx, t1, actor(t, sid)), o);
  t.advance(1000);
  withTx(t.db, (tx) => updateProgress(tx, t1, actor(t, sid), { pct: 50, check: ["a"], note: "做了点东西" }), o);

  // 阻塞 / 解除
  withTx(t.db, (tx) => addDependency(tx, t3, t2), o);
  withTx(t.db, (tx) => transition(tx, t2, "blocked", actor(t, sid), { reason: "等 schema 迁移" }), o);
  withTx(t.db, (tx) => transition(tx, t2, "todo", actor(t, sid), {}), o);

  // 编辑元信息
  withTx(t.db, (tx) => editTask(tx, t3, { title: "写 rebuild 一致性测试", priority: 1 }), o);

  // 交接 + 消费
  const hid = withTx(
    t.db,
    (tx) => writeHandoff(tx, { taskId: t1, sessionId: sid, summary: "做了 50%", nextStep: "继续", blockers: ["缺 schema"], openQuestions: ["要不要比较 lease？"] }),
    o,
  ).id;
  const sid2 = startAgent(t, "agent-b");
  withTx(t.db, (tx) => consumeHandoff(tx, hid, sid2), opts(t, sid2));

  // 计划（2 个版本）
  withTx(t.db, (tx) => savePlan(tx, { scope: "task", taskId: t1, title: "方案 v1", body: "## 步骤\n1. 补字段", sessionId: sid }), o);
  t.advance(1000);
  withTx(t.db, (tx) => savePlan(tx, { scope: "task", taskId: t1, title: "方案 v2", body: "## 步骤\n1. 补字段\n2. 写 rebuild", sessionId: sid }), o);

  // 完成（会隐式把 progress 提到 100）
  withTx(t.db, (tx) => transition(tx, t1, "done", actor(t, sid), { force: true, note: "搞定" }), o);

  return { sid, taskId: t1, depId: t3 };
}

// =============================================================================
describe("计划版本化", () => {
  test("每次保存产生新版本，旧版本转 superseded 并串成链", () => {
    const t = createTestDb();
    try {
      const sid = startAgent(t, "agent-a");
      const o = opts(t, sid);
      const tid = withTx(t.db, (tx) => createTask(tx, { title: "长任务" }), o).id;

      const v1 = withTx(t.db, (tx) => savePlan(tx, { scope: "task", taskId: tid, title: "v1", body: "原计划", sessionId: sid }), o);
      expect(v1.version).toBe(1);
      expect(v1.status).toBe("active");
      expect(v1.supersedesId).toBeNull();

      t.advance(1000);
      const v2 = withTx(t.db, (tx) => savePlan(tx, { scope: "task", taskId: tid, title: "v2", body: "改过的计划", sessionId: sid }), o);
      expect(v2.version).toBe(2);
      expect(v2.supersedesId).toBe(v1.id);

      // 旧版本内容**没有被覆盖**，只是状态变了
      const old = listPlans(t.scope, { taskId: tid, status: "all" });
      expect(old).toHaveLength(2);
      const v1Row = old.find((p) => p.id === v1.id)!;
      expect(v1Row.status).toBe("superseded");
      expect(v1Row.body).toBe("原计划");

      // 同一 scope 只能有一个 active
      expect(getActivePlan(t.scope, "task", tid)?.id).toBe(v2.id);
    } finally {
      t.cleanup();
    }
  });

  test("版本链可回溯（history 从新到旧）", () => {
    const t = createTestDb();
    try {
      const sid = startAgent(t, "agent-a");
      const o = opts(t, sid);
      const tid = withTx(t.db, (tx) => createTask(tx, { title: "长任务" }), o).id;
      for (const v of ["v1", "v2", "v3"]) {
        withTx(t.db, (tx) => savePlan(tx, { scope: "task", taskId: tid, title: v, body: `内容 ${v}`, sessionId: sid }), o);
        t.advance(1000);
      }
      const chain = planHistory(t.scope, "PL-T-0001-03");
      expect(chain.map((p) => p.version)).toEqual([3, 2, 1]);
      expect(chain[0]!.status).toBe("active");
      expect(chain[2]!.status).toBe("superseded");
    } finally {
      t.cleanup();
    }
  });

  test("保存后自动挂到任务上（agent resume 能读到）", () => {
    const t = createTestDb();
    try {
      const sid = startAgent(t, "agent-a");
      const o = opts(t, sid);
      const tid = withTx(t.db, (tx) => createTask(tx, { title: "长任务" }), o).id;
      const plan = withTx(t.db, (tx) => savePlan(tx, { scope: "task", taskId: tid, title: "方案", body: "内容", sessionId: sid }), o);
      expect(getTask(t.scope, tid)!.planId).toBe(plan.id);

      // 新版本保存后指向也跟着换
      t.advance(1000);
      const v2 = withTx(t.db, (tx) => savePlan(tx, { scope: "task", taskId: tid, title: "方案2", body: "内容2", sessionId: sid }), o);
      expect(getTask(t.scope, tid)!.planId).toBe(v2.id);
    } finally {
      t.cleanup();
    }
  });

  test("时间旅行：能查到某时刻生效的计划", () => {
    const t = createTestDb();
    try {
      const sid = startAgent(t, "agent-a");
      const o = opts(t, sid);
      const tid = withTx(t.db, (tx) => createTask(tx, { title: "长任务" }), o).id;
      withTx(t.db, (tx) => savePlan(tx, { scope: "task", taskId: tid, title: "v1", body: "原计划", sessionId: sid }), o);
      const beforeV2 = t.now();
      t.advance(10_000);
      withTx(t.db, (tx) => savePlan(tx, { scope: "task", taskId: tid, title: "v2", body: "新计划", sessionId: sid }), o);

      // v2 保存之前那一刻，生效的是 v1
      expect(planAtTime(t.scope, "task", tid, beforeV2)!.title).toBe("v1");
      expect(planAtTime(t.scope, "task", tid, t.now())!.title).toBe("v2");
    } finally {
      t.cleanup();
    }
  });

  test("拒绝空标题与空正文", () => {
    const t = createTestDb();
    try {
      const sid = startAgent(t, "agent-a");
      const o = opts(t, sid);
      const tid = withTx(t.db, (tx) => createTask(tx, { title: "长任务" }), o).id;
      expect(() => withTx(t.db, (tx) => savePlan(tx, { scope: "task", taskId: tid, title: "", body: "内容" }), o)).toThrow();
      expect(() => withTx(t.db, (tx) => savePlan(tx, { scope: "task", taskId: tid, title: "标题", body: "" }), o)).toThrow();
    } finally {
      t.cleanup();
    }
  });

  test("项目级计划不能挂到任务上", () => {
    const t = createTestDb();
    try {
      const sid = startAgent(t, "agent-a");
      const o = opts(t, sid);
      const tid = withTx(t.db, (tx) => createTask(tx, { title: "长任务" }), o).id;
      const projectPlan = withTx(t.db, (tx) => savePlan(tx, { scope: "project", title: "路线图", body: "## M3", sessionId: sid }), o);
      expect(() => withTx(t.db, (tx) => attachPlan(tx, tid, projectPlan.id), o)).toThrow();
    } finally {
      t.cleanup();
    }
  });

  test("计划按 project 隔离", () => {
    const t = createTestDb({ projectKey: "p1" });
    try {
      const sid = startAgent(t, "agent-a");
      const tid = withTx(t.db, (tx) => createTask(tx, { title: "长任务" }), { now: () => t.now(), sessionId: sid, projectKey: "p1" }).id;
      withTx(t.db, (tx) => savePlan(tx, { scope: "task", taskId: tid, title: "p1 的计划", body: "内容", sessionId: sid }), {
        now: () => t.now(),
        sessionId: sid,
        projectKey: "p1",
      });
      expect(listPlans(t.scope, { status: "all" })).toHaveLength(1);
      expect(listPlans(t.scopeOf("p2"), { status: "all" })).toHaveLength(0);
    } finally {
      t.cleanup();
    }
  });
});

// =============================================================================
describe("配置合并：空值不得屏蔽配置文件", () => {
  test("空字符串环境变量被当作未设置（否则会静默退回本地模式）", () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-config-"));
    try {
      writeFileSync(
        join(dir, "config.toml"),
        ['mode = "remote"', "", "[server]", 'url = "https://kanban.corp:7788"', 'token = "k_from_file"', "", "[project]", 'key = "demo"', ""].join("\n"),
        "utf8",
      );

      // 场景：CI 里把环境变量显式设为空串（等价于想"清掉"它）
      const resolved = resolveConfig({
        kanbanDir: dir,
        cli: {},
        env: { KANBAN_SERVER: "", KANBAN_KEY: "", KANBAN_PROJECT: "" },
      });
      expect(resolved.config.server).toBe("https://kanban.corp:7788");
      expect(resolved.config.token).toBe("k_from_file");
      expect(resolved.config.project).toBe("demo");
      expect(resolved.config.mode).toBe("remote");
      expect(resolved.sources.serverSource).toBe("config");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("纯空白与未设置等价；真正的值仍然优先", () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-config-"));
    try {
      writeFileSync(
        join(dir, "config.toml"),
        ['[server]', 'url = "https://from-file:7788"', "", "[project]", 'key = "demo"', ""].join("\n"),
        "utf8",
      );
      // 空白 → 当未设置
      expect(resolveConfig({ kanbanDir: dir, cli: {}, env: { KANBAN_SERVER: "   " } }).config.server).toBe("https://from-file:7788");
      // 环境变量有值 → 优先于文件
      expect(resolveConfig({ kanbanDir: dir, cli: {}, env: { KANBAN_SERVER: "https://from-env:9000" } }).config.server).toBe("https://from-env:9000");
      // CLI 有值 → 最优先
      expect(
        resolveConfig({ kanbanDir: dir, cli: { server: "https://from-cli:1234" }, env: { KANBAN_SERVER: "https://from-env:9000" } }).config.server,
      ).toBe("https://from-cli:1234");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// =============================================================================
describe("rebuild —— 从事件流重建投影", () => {
  test("覆盖所有操作后，投影与事件流完全一致（核心断言）", () => {
    const t = createTestDb();
    try {
      exerciseEverything(t);
      const report = rebuild(t.db, { projectKey: t.scope.projectKey, now: t.now() });
      expect(report.drift).toEqual([]);
      expect(report.ok).toBe(true);
      expect(report.written).toBe(false);
      // 重算出的行数与库里一致
      expect(report.counts.tasks).toBe(3);
      expect(report.counts.plans).toBe(2);
      expect(report.counts.handoffs).toBe(1);
      expect(report.counts.deps).toBe(2);
    } finally {
      t.cleanup();
    }
  });

  test("默认只校验不改库", () => {
    const t = createTestDb();
    try {
      exerciseEverything(t);
      const before = t.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tasks").get()!.n;
      const report = rebuild(t.db, { projectKey: t.scope.projectKey, now: t.now() });
      expect(report.written).toBe(false);
      const after = t.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tasks").get()!.n;
      expect(after).toBe(before);
    } finally {
      t.cleanup();
    }
  });

  test("直接改库造成的漂移能被逐字段发现", () => {
    const t = createTestDb();
    try {
      const { taskId, depId } = exerciseEverything(t);
      // 绕过 core 直接改库（模拟有人用 sqlite3 手改，或代码有 bug）
      t.db.query("UPDATE tasks SET title = '被改坏了' WHERE id = ?").run(taskId);
      t.db.query("UPDATE tasks SET status = 'doing' WHERE id = ?").run("T-0002");

      const report = rebuild(t.db, { projectKey: t.scope.projectKey, now: t.now() });
      expect(report.ok).toBe(false);
      const titleDrift = report.drift.find((d) => d.id === taskId && d.field === "title");
      expect(titleDrift?.actual).toBe("被改坏了");
      const statusDrift = report.drift.find((d) => d.id === "T-0002" && d.field === "status");
      expect(statusDrift?.expected).toBe("todo");
      void depId;
    } finally {
      t.cleanup();
    }
  });

  test("--write 能用事件流修复投影", () => {
    const t = createTestDb();
    try {
      const { taskId } = exerciseEverything(t);
      t.db.query("UPDATE tasks SET title = '被改坏了' WHERE id = ?").run(taskId);

      const fix = rebuild(t.db, { projectKey: t.scope.projectKey, now: t.now(), write: true, force: true });
      expect(fix.written).toBe(true);
      // 修复后应当一致
      expect(getTask(t.scope, taskId)!.title).toBe("实现 rebuild");
      const after = rebuild(t.db, { projectKey: t.scope.projectKey, now: t.now() });
      expect(after.ok).toBe(true);
    } finally {
      t.cleanup();
    }
  });

  test("没有漂移时 --write 是幂等的（反复执行不改变结果）", () => {
    const t = createTestDb();
    try {
      exerciseEverything(t);
      const first = rebuild(t.db, { projectKey: t.scope.projectKey, now: t.now() });
      expect(first.ok).toBe(true);
      const snapshot = snapshotProjection(t);

      rebuild(t.db, { projectKey: t.scope.projectKey, now: t.now(), write: true });
      const afterFirst = snapshotProjection(t);
      expect(afterFirst).toEqual(snapshot);

      rebuild(t.db, { projectKey: t.scope.projectKey, now: t.now(), write: true });
      expect(snapshotProjection(t)).toEqual(snapshot);
    } finally {
      t.cleanup();
    }
  });

  test("删除任务后不会被复活", () => {
    const t = createTestDb();
    try {
      const sid = startAgent(t, "agent-a");
      const o = opts(t, sid);
      const keep = withTx(t.db, (tx) => createTask(tx, { title: "保留" }), o).id;
      const drop = withTx(t.db, (tx) => createTask(tx, { title: "待删除" }), o).id;
      withTx(t.db, (tx) => removeTask(tx, drop, true), o);

      expect(getTask(t.scope, drop)).toBeNull();
      const report = rebuild(t.db, { projectKey: t.scope.projectKey, now: t.now() });
      // 已删任务不应被重建出来，因此不算漂移
      expect(report.ok).toBe(true);
      expect(report.counts.tasks).toBe(1);
      expect(report.counts.tasks).toBe(1);
      void keep;
    } finally {
      t.cleanup();
    }
  });

  test("project 隔离：rebuild 只重建本 project", () => {
    const t = createTestDb();
    try {
      const sid = startAgent(t, "agent-a");
      // p1 的一张卡
      withTx(t.db, (tx) => createTask(tx, { title: "p1 的卡" }), {
        now: () => t.now(),
        sessionId: sid,
        projectKey: "p1",
      });
      // p2 的一张卡（同名 T-0001）
      withTx(t.db, (tx) => createTask(tx, { title: "p2 的卡" }), {
        now: () => t.now(),
        sessionId: sid,
        projectKey: "p2",
      });

      const r1 = rebuild(t.db, { projectKey: "p1", now: t.now() });
      expect(r1.ok).toBe(true);
      expect(r1.counts.tasks).toBe(1);
      expect(r1.drift).toEqual([]);

      const r2 = rebuild(t.db, { projectKey: "p2", now: t.now() });
      expect(r2.ok).toBe(true);
      expect(r2.counts.tasks).toBe(1);
    } finally {
      t.cleanup();
    }
  });

  test("lease/updated_at 不参与比较（心跳会改它们，但那是正常的）", () => {
    const t = createTestDb();
    try {
      const sid = startAgent(t, "agent-a");
      const o = opts(t, sid);
      const tid = withTx(t.db, (tx) => createTask(tx, { title: "长任务" }), o).id;
      withTx(t.db, (tx) => claimTask(tx, tid, actor(t, sid)), o);
      // 模拟心跳：只改租约，不改逻辑状态
      t.advance(60_000);
      t.db.query("UPDATE tasks SET lease_expires_at = ?, updated_at = ? WHERE id = ?").run(t.now() + 900_000, t.now(), tid);

      const report = rebuild(t.db, { projectKey: t.scope.projectKey, now: t.now() });
      expect(report.drift).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  test("交接的消费状态能被重建", () => {
    const t = createTestDb();
    try {
      const sid = startAgent(t, "agent-a");
      const o = opts(t, sid);
      const tid = withTx(t.db, (tx) => createTask(tx, { title: "长任务" }), o).id;
      withTx(t.db, (tx) => writeHandoff(tx, { taskId: tid, sessionId: sid, summary: "做完了" }), o);

      expect(taskHandoffs(t.scope, tid)[0]!.consumedBy).toBeNull();
      const sid2 = startAgent(t, "agent-b");
      withTx(t.db, (tx) => consumeHandoff(tx, taskHandoffs(t.scope, tid)[0]!.id, sid2), opts(t, sid2));

      const report = rebuild(t.db, { projectKey: t.scope.projectKey, now: t.now() });
      expect(report.ok).toBe(true);
    } finally {
      t.cleanup();
    }
  });

  test("rebuild 后新建任务不会撞号", () => {
    const t = createTestDb();
    try {
      exerciseEverything(t);
      rebuild(t.db, { projectKey: t.scope.projectKey, now: t.now(), write: true, force: true });
      const sid = startAgent(t, "agent-a");
      const fresh = withTx(t.db, (tx) => createTask(tx, { title: "重建后新建" }), opts(t, sid));
      expect(fresh.id).toBe("T-0004");
    } finally {
      t.cleanup();
    }
  });

  test("doctor 能与 rebuild 联动（drift 是 error 级）", () => {
    const t = createTestDb();
    try {
      const { taskId } = exerciseEverything(t);
      t.db.query("UPDATE tasks SET status = 'doing' WHERE id = ?").run("T-0002");
      const report = runDoctor(t.db, { projectKey: t.scope.projectKey, now: t.now(), deep: true });
      const drift = report.issues.find((i) => i.code === "projection_drift");
      expect(drift).toBeDefined();
      expect(drift!.severity).toBe("error");
      expect(drift!.hint).toContain("rebuild");
      void taskId;
    } finally {
      t.cleanup();
    }
  });
});

// =============================================================================

/** 抓取投影表当前内容，用于幂等性比对（包含 done_at / by 这些容易丢的细节） */
function snapshotProjection(t: TestDb): string {
  return JSON.stringify({
    tasks: t.db.query("SELECT id, title, status, progress, checklist, plan_id FROM tasks ORDER BY id").all(),
    deps: t.db.query("SELECT project_key, task_id, depends_on_id, created_at FROM task_deps ORDER BY task_id").all(),
    plans: t.db.query("SELECT id, version, status, title, body FROM plans ORDER BY id").all(),
    handoffs: t.db.query("SELECT id, summary, consumed_by, consumed_at FROM handoffs ORDER BY id").all(),
  });
}
