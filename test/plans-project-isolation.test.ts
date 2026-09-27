/**
 * 计划 ID 的 project 隔离（v4 → v5 补的那一刀）。
 *
 * ## 背景
 *
 * **计划号是 per-project 分配的**（`ids.ts` 的 `nextProjectPlanId` /
 * `nextTaskPlanId` 都带 `projectKey`），但 `plans.id` 曾经是 `TEXT PRIMARY KEY`
 * （全局唯一）。于是第二个 project 存第一份计划时就撞主键：
 *
 * ```
 * pa → plan id = PL-0001
 * pb → unique constraint failed
 * ```
 *
 * 而 ADR-9 声称支持「一个 server 管多个 project」，所以这是**功能级断裂**，
 * 不是边角情况。更糟的是 `errors.ts` 把它映射成「usually a normal race under
 * concurrency, safe to retry once」——而重试一万次也一样失败。
 *
 * v5 把主键改成 `(project_key, id, version)`。`version` 也要在主键里：
 * 项目级计划的 id 只是 `PL-0001`，区分版本靠的是 version 列。
 *
 * ## 为什么要单开一个文件
 *
 * 迁移代码属于「只在老库上跑一次、跑完就没了」的路径——**全新库根本不执行它**
 * （走 schema.sql 直接建到最新），所以本文件后半段手工造一个 v4 形状的库再升级。
 * 那段代码一旦写错，老用户升级后要么计划丢了、要么被挂到错的 project 上，
 * 而且没有任何报错可以指回来。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION, getSchemaVersion, migrate, openDb, setInitialConfig, type Db } from "../src/core/db.ts";
import { createProject } from "../src/core/projects.ts";
import { attachPlan, getPlan, listPlans, requirePlan, savePlan } from "../src/core/plans.ts";
import { createTask, getTask } from "../src/core/tasks.ts";
import { withTx } from "../src/core/tx.ts";
import { toKanbanError } from "../src/core/errors.ts";
import { createTestDb, type TestDb } from "./helpers/db.ts";

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

/** 在指定 project 下存一份计划 */
function savePlanIn(projectKey: string, input: { scope: "project" | "task"; taskId?: string | null; title: string }) {
  return withTx(
    t.db,
    (c) =>
      savePlan(c, {
        scope: input.scope,
        taskId: input.taskId ?? null,
        title: input.title,
        body: "正文",
        attach: input.scope === "task",
      }),
    { now: () => clock, projectKey },
  );
}

describe("计划 ID 跨 project：两个 project 都能存下第一份计划", () => {
  test("项目级计划：pa 与 pb 各自拿到 PL-0001，互不冲突", () => {
    const a = savePlanIn(P1, { scope: "project", title: "p1 的项目计划" });
    const b = savePlanIn(P2, { scope: "project", title: "p2 的项目计划" });

    // ID 相同（都按 project 从 1 数起）——这正是修复前会撞主键的那个形状
    expect(a.id).toBe("PL-0001");
    expect(b.id).toBe("PL-0001");
    // 但内容各自独立
    expect(a.projectKey).toBe(P1);
    expect(b.projectKey).toBe(P2);
    expect(getPlan({ db: t.db, projectKey: P1 }, a.id)!.title).toBe("p1 的项目计划");
    expect(getPlan({ db: t.db, projectKey: P2 }, b.id)!.title).toBe("p2 的项目计划");
  });

  test("任务级计划：两个 project 的 T-0001 各自拿到 PL-T-0001-01", () => {
    let ta = "";
    let tb = "";
    withTx(t.db, (c) => { ta = createTask(c, { title: "p1 的卡" }).id; }, { now: () => clock, projectKey: P1 });
    withTx(t.db, (c) => { tb = createTask(c, { title: "p2 的卡" }).id; }, { now: () => clock, projectKey: P2 });
    expect(ta).toBe("T-0001");
    expect(tb).toBe("T-0001");

    const a = savePlanIn(P1, { scope: "task", taskId: ta, title: "p1 的任务计划" });
    const b = savePlanIn(P2, { scope: "task", taskId: tb, title: "p2 的任务计划" });

    expect(a.id).toBe("PL-T-0001-01");
    expect(b.id).toBe("PL-T-0001-01");
    expect(getPlan({ db: t.db, projectKey: P1 }, a.id)!.title).toBe("p1 的任务计划");
    expect(getPlan({ db: t.db, projectKey: P2 }, b.id)!.title).toBe("p2 的任务计划");
  });

  test("p1 存新版本时不会把 p2 的同号旧版本顶成 superseded", () => {
    // 两个 project 各有一份 PL-0001，且都已存到 v2
    savePlanIn(P1, { scope: "project", title: "p1 v1" });
    savePlanIn(P1, { scope: "project", title: "p1 v2" });
    savePlanIn(P2, { scope: "project", title: "p2 v1" });
    savePlanIn(P2, { scope: "project", title: "p2 v2" });

    // p1 再存 v3 —— 只应影响 p1
    const a3 = savePlanIn(P1, { scope: "project", title: "p1 v3" });
    expect(a3.version).toBe(3);

    const p1Plans = listPlans({ db: t.db, projectKey: P1 }, { status: "all" });
    const p2Plans = listPlans({ db: t.db, projectKey: P2 }, { status: "all" });
    expect(p1Plans.filter((p) => p.status === "superseded")).toHaveLength(2);
    expect(p2Plans.filter((p) => p.status === "superseded")).toHaveLength(1);
    expect(p2Plans.filter((p) => p.status === "active")).toHaveLength(1);
  });

  test("attachPlan 只改本 project 的任务", () => {
    let ta = "";
    let tb = "";
    withTx(t.db, (c) => { ta = createTask(c, { title: "p1 的卡" }).id; }, { now: () => clock, projectKey: P1 });
    withTx(t.db, (c) => { tb = createTask(c, { title: "p2 的卡" }).id; }, { now: () => clock, projectKey: P2 });
    const pa = savePlanIn(P1, { scope: "task", taskId: ta, title: "p1 的任务计划" });

    // p1 的任务已经指向 pa（savePlan 默认 attach）
    expect(getTask({ db: t.db, projectKey: P1 }, ta)!.planId).toBe(pa.id);
    // p2 的同号任务不该被影响
    expect(getTask({ db: t.db, projectKey: P2 }, tb)!.planId).toBeNull();
    // 重新 attach 也不会串
    withTx(t.db, (c) => { attachPlan(c, ta, pa.id); }, { now: () => clock, projectKey: P1 });
    expect(getTask({ db: t.db, projectKey: P2 }, tb)!.planId).toBeNull();
  });

  test("跨 project 取别人的计划会报 plan_not_found（而不是泄漏内容）", () => {
    const a = savePlanIn(P1, { scope: "project", title: "p1 的秘密计划" });
    expect(getPlan({ db: t.db, projectKey: P2 }, a.id)).toBeNull();
    expect(() => requirePlan({ db: t.db, projectKey: P2 }, a.id)).toThrow();
  });
});

describe("UNIQUE 冲突的错误文案不再承诺「重试就好」", () => {
  test("报出冲突的表名与列名", () => {
    const err = toKanbanError(new Error("UNIQUE constraint failed: plans.project_key, plans.id, plans.version"));
    expect(err.code).toBe(3);
    expect(err.message).toContain("plans.project_key");
    // 关键：不能说「重试一次就好」——那会把 agent 引进死循环
    expect(err.message).not.toContain("safe to retry");
    expect(err.details.constraint_target).toBe("plans.project_key, plans.id, plans.version");
    expect(String(err.details.hint)).toContain("plans");
  });

  test("认不出表名时也不承诺重试", () => {
    const err = toKanbanError(new Error("UNIQUE constraint failed"));
    expect(err.code).toBe(3);
    expect(err.message).not.toContain("safe to retry");
  });
});

/**
 * v4 → v5 迁移本身。
 *
 * 全新库走 schema.sql 直接建到 v5，**根本不会执行这段代码**，所以只能手工造库再验证。
 */
describe("v4 → v5 迁移：plans 主键改成含 project_key", () => {
  let dir: string;
  let dbPath: string;
  let handle: Db;
  const NOW = 1_700_000_000_000;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kanban-plans-migrate-"));
    dbPath = join(dir, "legacy.db");
    handle = openDb(dbPath);
    migrate(handle); // 先建到 v5
    setInitialConfig(handle.raw, { projectName: "legacy", now: NOW });
    createProject(handle.raw, { key: "p-old", name: "老项目", rootPath: dir, apiKeyHash: null, now: NOW });
    createProject(handle.raw, { key: "p-new", name: "新项目", rootPath: dir, apiKeyHash: null, now: NOW + 10 });

    // 人为把 plans 退回 v4 形状：主键只有 id
    handle.raw.exec("DROP TABLE plans");
    handle.raw.exec(`CREATE TABLE plans (
      id                TEXT PRIMARY KEY,
      project_key       TEXT,
      scope             TEXT NOT NULL,
      task_id           TEXT,
      version           INTEGER NOT NULL,
      title             TEXT NOT NULL,
      body              TEXT NOT NULL,
      status            TEXT NOT NULL,
      author_session_id TEXT,
      created_at        INTEGER NOT NULL,
      supersedes_id     TEXT
    )`);

    insertLegacyPlan(handle.raw, "PL-0001", "p-old", "project", null, 1, "老项目计划", "active", NOW);
    insertLegacyPlan(handle.raw, "PL-0002", "p-old", "project", null, 1, "老项目计划 v2", "superseded", NOW + 1, "PL-0001");
    insertLegacyPlan(handle.raw, "PL-T-0001-01", "p-old", "task", "T-0001", 1, "任务计划", "active", NOW + 2);
    // project_key 为空的老数据（v1→v2 的 ADD COLUMN 允许 NULL）
    insertLegacyPlan(handle.raw, "PL-0003", "", "project", null, 1, "无 project 的孤儿计划", "active", NOW + 3);

    // 版本号退回 4
    handle.raw.query("INSERT OR REPLACE INTO meta (k, v) VALUES ('schema_version', '4')").run();
  });

  afterEach(() => {
    handle.raw.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("迁移后主键含 project_key；空的 project_key 回落到最早创建的 project", () => {
    expect(getSchemaVersion(handle)).toBe(4);
    // 终点写 SCHEMA_VERSION 而不是 5：migrate() 总是一次跑到最新版本，
    // 硬编码版本号意味着每加一条迁移就要回来改这个断言（漏改即红，且与本用例
    // 要验的 plans 主键毫无关系）。起点 4 是这批用例刻意造出来的，可以写死。
    expect(migrate(handle)).toEqual({ from: 4, to: SCHEMA_VERSION });

    const pk = handle.raw
      .query<{ name: string; pk: number }, []>("PRAGMA table_info(plans)")
      .all()
      .filter((c) => c.pk !== 0)
      .map((c) => c.name)
      .sort();
    expect(pk).toEqual(["id", "project_key", "version"]);

    const rows = handle.raw
      .query<{ id: string; project_key: string; title: string }, []>(
        "SELECT id, project_key, title FROM plans ORDER BY id",
      )
      .all();
    expect(rows).toHaveLength(4);
    // 所有行都挂到了具体 project（不再有 NULL）
    expect(rows.every((r) => r.project_key.length > 0)).toBe(true);
    expect(rows.find((r) => r.id === "PL-0003")!.project_key).toBe("p-old");
  });

  test("迁移后同一 project 内的同号计划可共存（version 也在主键里）", () => {
    migrate(handle);
    // 修复前这行插不进去（主键只有 id）。项目级计划的 id 只是 PL-0001，
    // 区分版本靠的就是 version 列，所以它必须在主键里。
    handle.raw
      .query(
        `INSERT INTO plans (id, project_key, scope, task_id, version, title, body, status, author_session_id, created_at, supersedes_id)
         VALUES ('PL-0001', 'p-old', 'project', NULL, 2, '同号不同版本', 'b', 'active', NULL, ?, NULL)`,
      )
      .run(NOW + 5);
    expect(
      handle.raw
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM plans WHERE project_key = ? AND id = 'PL-0001'",
        )
        .get("p-old")!.n,
    ).toBe(2);
  });

  test("迁移后 core 读得到的仍是迁移前的那些计划（不只是表对了）", () => {
    migrate(handle);
    const scope = { db: handle.raw, projectKey: "p-old" };
    expect(requirePlan(scope, "PL-0001").title).toBe("老项目计划");
    expect(requirePlan(scope, "PL-0002").title).toBe("老项目计划 v2");
    expect(requirePlan(scope, "PL-T-0001-01").title).toBe("任务计划");
    expect(requirePlan(scope, "PL-0003").title).toBe("无 project 的孤儿计划");
    expect(listPlans(scope, { status: "all" })).toHaveLength(4);
  });

  test("迁移是幂等的（重复跑不会二次处理、不会索引报错）", () => {
    migrate(handle);
    const first = handle.raw.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM plans").get()!.n;
    expect(getSchemaVersion(handle)).toBe(SCHEMA_VERSION);
    expect(migrate(handle)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    expect(handle.raw.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM plans").get()!.n).toBe(first);
  });

  test("核心回归：迁移后 p-new 存的第一份计划就是 PL-0001，与 p-old 的共存", () => {
    migrate(handle);
    // p-new 之前一张计划都没有 → 它的第一份是 PL-0001。
    // 迁移前这行会报 unique constraint failed（因为 p-old 已占用 PL-0001）。
    const added = withTx(
      handle.raw,
      (c) => savePlan(c, { scope: "project", title: "新项目的第一份计划", body: "正文", attach: false }),
      { now: () => NOW + 100, projectKey: "p-new" },
    );
    expect(added.id).toBe("PL-0001");
    expect(added.projectKey).toBe("p-new");
    // p-old 的那份一个字都没变
    expect(requirePlan({ db: handle.raw, projectKey: "p-old" }, "PL-0001").title).toBe("老项目计划");
    expect(requirePlan({ db: handle.raw, projectKey: "p-new" }, "PL-0001").title).toBe("新项目的第一份计划");
  });
});

/** 往 v4 形状的 plans 里塞一行 */
function insertLegacyPlan(
  db: import("bun:sqlite").Database,
  id: string,
  projectKey: string,
  scope: string,
  taskId: string | null,
  version: number,
  title: string,
  status: string,
  createdAt: number,
  supersedesId: string | null = null,
): void {
  db.query(
    `INSERT INTO plans (id, project_key, scope, task_id, version, title, body, status, author_session_id, created_at, supersedes_id)
     VALUES (?, ?, ?, ?, ?, ?, '正文', ?, NULL, ?, ?)`,
  ).run(id, projectKey, scope, taskId, version, title, status, createdAt, supersedesId);
}
