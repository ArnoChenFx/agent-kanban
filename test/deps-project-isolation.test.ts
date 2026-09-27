/**
 * task_deps 的 project 隔离回归。
 *
 * ## 为什么要单开一个文件
 *
 * v1→v2 迁移给 tasks/events/plans/handoffs 都加了 project_key，唯独漏了
 * task_deps（ADR-9 的遗漏），v3→v4 才补上。补的时候最容易漏的不是表结构，
 * 而是**读路径里那些没写 project_key 的子查询**：
 *
 *   - `listTasks({ready:true})` 的 NOT EXISTS 子查询：只按 `d.task_id = tasks.id` 匹配，
 *     而 T 编号是 per-project 的 → project B 的依赖边会把 project A 的卡判成"未就绪"。
 *   - `getWaitingDepsMap`（看板批量渲染用）的相关子查询：同一个洞，
 *     表现为 A 的卡上冒出"B 的上游"。
 *
 * 这两处**单 project 的本地库永远不会暴露**，只有多 project 才会出错，
 * 所以必须有专门的跨 project 用例钉住。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getSchemaVersion, migrate, openDb, setInitialConfig, SCHEMA_VERSION, type Db } from "../src/core/db.ts";
import { createProject, deleteProject } from "../src/core/projects.ts";
import {
  addDependency,
  createTask,
  getDependencies,
  getDependents,
  getUnfinishedDeps,
  getWaitingDepsMap,
  listTasks,
  removeTask,
} from "../src/core/tasks.ts";
import { createTestDb, type TestDb } from "./helpers/db.ts";

const ROOT = resolve(import.meta.dir, "..");

/** 两个 project：T 编号各自从 T-0001 开始，天然会撞号 */
const P1 = "p1";
const P2 = "p2";

let t: TestDb;

beforeEach(() => {
  t = createTestDb({ projectKey: P1 });
  // 第二个 project 手工建（createTestDb 只建默认那个）
  createProject(t.db, { key: P2, name: "第二个项目", rootPath: t.path, apiKeyHash: null });
});

afterEach(() => {
  t.cleanup();
});

/** 在指定 project 里建任务并返回 id */
function makeTask(projectKey: string, title: string): string {
  let id = "";
  t.tx(
    (tx) => {
      id = createTask(tx, { title }).id;
    },
    { projectKey },
  );
  return id;
}

/** 在指定 project 里连一条依赖 A → B */
function linkDep(projectKey: string, a: string, b: string): void {
  t.tx(
    (tx) => {
      addDependency(tx, a, b);
    },
    { projectKey },
  );
}

describe("task_deps 跨 project 隔离（v3→v4 补的那一刀）", () => {
  test("p2 的依赖边不应让 p1 的同名卡变成未就绪", () => {
    // 两个 project 各自建 T-0001 / T-0002
    const p1a = makeTask(P1, "p1 的下游");
    makeTask(P1, "p1 的上游");
    const p2a = makeTask(P2, "p2 的下游");
    const p2b = makeTask(P2, "p2 的上游");
    // 只在 p2 里建依赖：p2 的 T-0001 → p2 的 T-0002
    linkDep(P2, p2a, p2b);

    // p1 的卡没有任何依赖 → 应当出现在 ready 列表里
    // （曾经因为子查询只按 d.task_id 匹配，p2 的边把 p1 的 T-0001 也拖了下去）
    const ready = listTasks(t.scopeOf(P1), { ready: true });
    expect(ready.map((x) => x.id)).toContain(p1a);
  });

  test("p2 的依赖边不应出现在 p1 的看板 waiting 列表里", () => {
    makeTask(P1, "p1 的下游");
    makeTask(P1, "p1 的上游");
    const p2a = makeTask(P2, "p2 的下游");
    const p2b = makeTask(P2, "p2 的上游");
    linkDep(P2, p2a, p2b);

    // p1 自己的两张卡互不依赖 → waiting map 不该有任何条目
    expect(getWaitingDepsMap(t.scopeOf(P1)).size).toBe(0);
    // p2 那边则确实在等 T-0002
    expect(getWaitingDepsMap(t.scopeOf(P2)).get(p2a)).toEqual([p2b]);
  });

  test("读接口各自按 project 过滤", () => {
    const p1a = makeTask(P1, "p1 的下游");
    const p1b = makeTask(P1, "p1 的上游");
    const p2a = makeTask(P2, "p2 的下游");
    const p2b = makeTask(P2, "p2 的上游");
    linkDep(P2, p2a, p2b);

    // p1 侧读到的依赖是空的
    expect(getDependencies(t.scopeOf(P1), p1a)).toEqual([]);
    expect(getDependents(t.scopeOf(P1), p1a)).toEqual([]);
    expect(getUnfinishedDeps(t.scopeOf(P1), p1a)).toEqual([]);
    // p2 侧读得到
    expect(getDependencies(t.scopeOf(P2), p2a).map((d) => d.dependsOnId)).toEqual([p2b]);
    expect(getUnfinishedDeps(t.scopeOf(P2), p2a).map((x) => x.id)).toEqual([p2b]);
  });

  test("同一条边可以在两个 project 各存一份（不再被 INSERT OR IGNORE 静默吞掉）", () => {
    const p1a = makeTask(P1, "p1 的下游");
    const p1b = makeTask(P1, "p1 的上游");
    const p2a = makeTask(P2, "p2 的下游");
    const p2b = makeTask(P2, "p2 的上游");

    linkDep(P1, p1a, p1b);
    linkDep(P2, p2a, p2b);

    // 老 schema 的主键是 (task_id, depends_on_id)，第二次插入会被 OR IGNORE 悄悄丢掉
    const rows = t.db
      .query<{ project_key: string; task_id: string }, []>(
        "SELECT project_key, task_id FROM task_deps ORDER BY project_key",
      )
      .all();
    expect(rows).toEqual([
      { project_key: P1, task_id: p1a },
      { project_key: P2, task_id: p2a },
    ]);
  });

  test("环检测不跨 project：p2 的反向边不因 p1 有同号边而误报成环", () => {
    const p1a = makeTask(P1, "p1 的下游");
    const p1b = makeTask(P1, "p1 的上游");
    const p2a = makeTask(P2, "p2 的下游");
    const p2b = makeTask(P2, "p2 的上游");

    // p1：T-0001 → T-0002。若 BFS 不按 project 过滤，p2 下面这条反向边会被判成环
    linkDep(P1, p1a, p1b);
    // p2：T-0002 → T-0001。p2 自己没有 T-0001 → T-0002，所以不是环
    expect(() => linkDep(P2, p2b, p2a)).not.toThrow();
    // 反过来，p1 里真的成环仍然要报错
    expect(() => linkDep(P1, p1b, p1a)).toThrow(/would create a cycle/);
  });

  test("删任务只清本 project 的依赖边", () => {
    const p1a = makeTask(P1, "p1 的下游");
    const p1b = makeTask(P1, "p1 的上游");
    const p2a = makeTask(P2, "p2 的下游");
    const p2b = makeTask(P2, "p2 的上游");
    linkDep(P1, p1a, p1b);
    linkDep(P2, p2a, p2b);

    t.tx(
      (tx) => {
        removeTask(tx, p1a, true);
      },
      { projectKey: P1 },
    );

    const remaining = t.db
      .query<{ project_key: string }, []>("SELECT DISTINCT project_key FROM task_deps")
      .all()
      .map((r) => r.project_key);
    expect(remaining).toEqual([P2]);
  });

  test("删 project 只清本 project 的依赖边（IN 子查询按编号匹配会误伤同号边）", () => {
    const p1a = makeTask(P1, "p1 的下游");
    const p1b = makeTask(P1, "p1 的上游");
    const p2a = makeTask(P2, "p2 的下游");
    const p2b = makeTask(P2, "p2 的上游");
    linkDep(P1, p1a, p1b);
    linkDep(P2, p2a, p2b);

    // 曾经的写法：task_id IN (SELECT id FROM tasks WHERE project_key = ?) ——
    // 两个 project 都有 T-0001/T-0002，删 p1 会把 p2 的边一并带走
    deleteProject(t.db, P1, true);

    const remaining = t.db
      .query<{ project_key: string; task_id: string }, []>(
        "SELECT project_key, task_id FROM task_deps",
      )
      .all();
    expect(remaining).toEqual([{ project_key: P2, task_id: p2a }]);
    // p2 的读路径不受影响
    expect(getDependencies(t.scopeOf(P2), p2a).map((d) => d.dependsOnId)).toEqual([p2b]);
  });
});

/**
 * 静态守卫：**凡是 FROM/JOIN task_deps 的 SQL 字面量，都必须出现 project_key**。
 *
 * 为什么不只靠上面的行为测试：行为测试只能钉住已经写出来的那几条读路径，
 * 而这类 bug 的特征是“新加一个查询时忘了带 project_key”——它不会让任何现有
 * 测试变红，只会在多 project 部署下静默串数据。这里把整棵树的 SQL 字面量
 * 扫一遍，把“忘了带”变成编译期就能看到的失败。
 *
 * 判据选得很窄（只管 FROM/JOIN task_deps）：
 *   - `PRAGMA table_info(task_deps)`、`DROP TABLE`、`CREATE INDEX` 这类 DDL 不需要过滤
 *   - 迁移脚本（db.ts 的 v3→v4）在同一条语句里自带 project_key，天然通过
 *   - 注释与界面文案不是字符串字面量里的 SQL，不会被误伤
 * 写 SQL 时用反引号或双引号（仓库惯例）都能被扫到；拼出来的字符串扫不到——
 * 所以别拼 SQL。
 */
describe("静态守卫：task_deps 的 SQL 必须带 project_key", () => {
  /** 递归列出仓库里的 TS 源码（排除 .d.ts） */
  function tsSources(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out.push(...tsSources(p));
      else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
    }
    return out;
  }

  /** 抽出所有字符串与模板字面量（SQL 一律是反引号或双引号，无需解析 AST） */
  function stringLiterals(src: string): string[] {
    return [
      ...[...src.matchAll(/`[^`]*`/g)].map((m) => m[0]),
      ...[...src.matchAll(/"(?:[^"\\\n]|\\.)*"/g)].map((m) => m[0]),
    ];
  }

  test("src/ 与 scripts/ 里没有不带 project_key 的 task_deps 查询", () => {
    const files = [...tsSources(join(ROOT, "src")), ...tsSources(join(ROOT, "scripts"))];
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const lit of stringLiterals(src)) {
        // 只看“读 task_deps”的语句：INSERT 带列名、DELETE 用 WHERE，都不落在这个判据里，
        // 而它们在 core 里都写成 INSERT OR IGNORE INTO task_deps (project_key, ...)
        if (!/\b(?:FROM|JOIN)\s+task_deps\b/.test(lit)) continue;
        if (lit.includes("project_key")) continue;
        const line = src.slice(0, src.indexOf(lit)).split(/\r?\n/).length;
        violations.push(`${file.slice(ROOT.length + 1)}:${line} → ${lit.replace(/\s+/g, " ")}`);
      }
    }
    expect(violations).toEqual([]);
  });
});

/**
 * v3 → v4 迁移本身（src/core/db.ts 的 MIGRATIONS[3]）。
 *
 * 为什么要单独测迁移：这张卡的主体是迁移，而迁移代码属于“只在老库上跑一次、
 * 跑完就没了”的路径——单 project 的新库根本不会执行它，回归测试也永远覆盖不到。
 * 一旦 backfill 写错，老用户升级后要么依赖边丢了，要么被挂到错的 project 上，
 * 而且没有任何报错可以指回来。所以这里手工造一个 v3 形状的库再升级。
 */
describe("v3 → v4 迁移：给 task_deps 回填 project_key", () => {
  let dir: string;
  let dbPath: string;
  let handle: Db;

  const NOW = 1_700_000_000_000;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kanban-deps-migrate-"));
    dbPath = join(dir, "legacy.db");
    handle = openDb(dbPath);
    // 先按当前 schema 建库（v0 → v4），再人为把 task_deps 退回 v3 形状
    migrate(handle);
    setInitialConfig(handle.raw, { projectName: "legacy", now: NOW });

    // 故意给不同的 created_at：迁移的悬空边回填靠 “ORDER BY created_at ASC” 挑最早的
    // project，两边时间相同时会退化成按 key 排（字母序），断言就会变得含糊
    createProject(handle.raw, {
      key: "p-old",
      name: "老项目",
      rootPath: dir,
      apiKeyHash: null,
      now: NOW,
    });
    createProject(handle.raw, {
      key: "p-new",
      name: "新项目",
      rootPath: dir,
      apiKeyHash: null,
      now: NOW + 10,
    });

    // v3 的 task_deps：主键 (task_id, depends_on_id)，压根没有 project_key
    handle.raw.exec("DROP TABLE task_deps");
    handle.raw.exec(`CREATE TABLE task_deps (
      task_id       TEXT NOT NULL,
      depends_on_id TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      PRIMARY KEY (task_id, depends_on_id)
    )`);

    // 两条任务：p-old 的 T-0001（T-0001 依赖 T-0002）；T-0002 只存在于 p-new。
    // 于是 T-0001 这条边只能按 p-old 回填，而 T-0003 → T-9999 的悬空边退化为最早 project。
    insertTask(handle.raw, "p-old", "T-0001", NOW);
    insertTask(handle.raw, "p-old", "T-0002", NOW + 1);
    insertTask(handle.raw, "p-new", "T-0001", NOW + 2);
    insertLegacyDep(handle.raw, "T-0001", "T-0002", NOW);
    insertLegacyDep(handle.raw, "T-0003", "T-9999", NOW);

    // 版本号退回 3，下次 migrate() 才会跑 v3 → v4
    handle.raw.query("INSERT OR REPLACE INTO meta (k, v) VALUES ('schema_version', '3')").run();
  });

  afterEach(() => {
    handle.raw.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("回填按任务实际所属的 project 归位，主键换成含 project 的三元组", () => {
    expect(getSchemaVersion(handle)).toBe(3);
    // migrate 一次跑到当前最新版本（v5 又补了 plans 的 project 隔离），
    // 所以终点是 SCHEMA_VERSION 而不是当时的 4
    expect(migrate(handle)).toEqual({ from: 3, to: SCHEMA_VERSION });
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(4);

    const rows = handle.raw
      .query<{ project_key: string; task_id: string; depends_on_id: string }, []>(
        "SELECT project_key, task_id, depends_on_id FROM task_deps ORDER BY project_key, task_id",
      )
      .all();
    expect(rows).toEqual([
      // p-old 与 p-new 都有 T-0001，取 created_at 更早的那个（p-old）
      { project_key: "p-old", task_id: "T-0001", depends_on_id: "T-0002" },
      // 悬空边查不到任务 → 退化为最早创建的 project
      { project_key: "p-old", task_id: "T-0003", depends_on_id: "T-9999" },
    ]);

    // 新主键里带 project：迁移后同号边能在两个 project 各存一份
    const cols = handle.raw
      .query<{ name: string }, []>("PRAGMA table_info(task_deps)")
      .all()
      .map((c) => c.name);
    expect(cols).toEqual(["project_key", "task_id", "depends_on_id", "created_at"]);
  });

  test("迁移后老依赖仍能被 core 读出来（不是只对了表、没对上接口）", () => {
    migrate(handle);
    const scope = { db: handle.raw, projectKey: "p-old" };
    expect(getDependencies(scope, "T-0001").map((d) => d.dependsOnId)).toEqual(["T-0002"]);
    expect(getUnfinishedDeps(scope, "T-0001").map((t) => t.id)).toEqual(["T-0002"]);
  });

  test("重复跑 migrate 是幂等的（不会二次回填、不会重复建索引报错）", () => {
    migrate(handle);
    const first = handle.raw.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task_deps").get()!.n;
    expect(getSchemaVersion(handle)).toBe(SCHEMA_VERSION);
    // 版本已是最新，migrate 直接空转
    expect(migrate(handle)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    expect(handle.raw.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task_deps").get()!.n).toBe(
      first,
    );
  });
});

/** 直接插一条任务（绕开 core：这里要的是"表里长这样"，不是"core 能建出来"） */
function insertTask(db: Database, projectKey: string, id: string, createdAt: number): void {
  db.query(
    `INSERT INTO tasks (id, project_key, title, status, priority, progress, labels, checklist,
                        assignee_session_id, lease_expires_at, created_at, updated_at)
     VALUES (?, ?, '迁移测试', 'todo', 2, 0, '[]', '[]', NULL, NULL, ?, ?)`,
  ).run(id, projectKey, createdAt, createdAt);
}

/** 往 v3 形状的 task_deps 里塞一条边 */
function insertLegacyDep(
  db: Database,
  taskId: string,
  dependsOnId: string,
  createdAt: number,
): void {
  db.query("INSERT INTO task_deps (task_id, depends_on_id, created_at) VALUES (?, ?, ?)").run(
    taskId,
    dependsOnId,
    createdAt,
  );
}
