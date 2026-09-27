/**
 * `compact` 的裁剪边界（以及它**故意不**裁的东西）。
 *
 * ## 背景
 *
 * `compactEvents` 曾经收了 `opts.projectKey` 却从头到尾没用过——DELETE 只按
 * `ts` / `seq` / `task_id` 过滤，于是多 project server 上
 * `compact --project A` 会把 B 的历史**不可逆地**删掉。那条在
 * `test/write-project-isolation.test.ts` 里有行为用例；本文件补的是**边界**。
 *
 * ## 三条边界（本文件逐条钉住）
 *
 * 1. **只裁本 project**。跨 project 的部分见上面那个文件。
 * 2. **不裁 `project_key = 'system'` 的事件** —— 会话生命周期事件
 *    （`session_started` / `session_closed` / `session_crashed`）不属于任何 project，
 *    而 `compact` 是**按 project 触发**的。裁 project A 时删掉 server 全局的
 *    会话历史，既说不通也危险。
 * 3. **不裁进行中任务的事件** —— 租约回收与 `rebuild` 都要读它们。
 *
 * ## 一个已知且被接受的缺口
 *
 * 因为 compact 按 project 触发，**`system` 事件目前没有任何裁剪途径**，会一直增长。
 * 这是有意的取舍，不是遗漏：
 *   - 量级可控：每个会话 3 条（started/closed/crashed），心跳事件从未写入；
 *   - 不影响性能：rebuild 只重放目标 project 的事件，system 事件不参与；
 *   - SQLite 处理百万行毫无压力，events 表不是瓶颈。
 *
 * 真要清理的话，正确做法是加一个**显式的**全局裁剪（而不是偷偷让某个 project
 * 的 compact 越权删全局历史）。这里把取舍写在代码注释与本文件里，
 * 免得后人以为它是 bug。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactEvents } from "../src/core/backup.ts";
import { createProject } from "../src/core/projects.ts";
import { createSession, closeSession } from "../src/core/sessions.ts";
import { claimTask, createTask, transition } from "../src/core/tasks.ts";
import { withTx } from "../src/core/tx.ts";
import { createTestDb, type TestDb } from "./helpers/db.ts";

const P1 = "p1";
const P2 = "p2";
const NOW = 1_700_000_000_000;
/** 一年后：让所有事件都远超 cutoff */
const LATER = NOW + 365 * 86_400_000;

let t: TestDb;
let snapDir: string;

beforeEach(() => {
  t = createTestDb({ projectKey: P1, now: NOW });
  // ⚠ 统一时钟：createProject 不传 now 就用**真实时间**（2026），
  //   而本文件的逻辑时钟是 1.7e12（2023-11）+ 365 天 ≈ 2024-11。
  //   不统一的话新加的 project_created 会比 cutoff 还「新」，断言会变成在测别的东西。
  createProject(t.db, { key: P2, name: "第二个项目", rootPath: t.path, apiKeyHash: null, now: NOW });
  snapDir = mkdtempSync(join(tmpdir(), "kanban-compact-"));
});

afterEach(() => {
  rmSync(snapDir, { recursive: true, force: true });
  t.cleanup();
});

/** 在指定 project 下建卡（可选：走完到终态，便于被裁） */
function mk(projectKey: string, title: string, finish = false): string {
  let id = "";
  withTx(
    t.db,
    (c) => {
      id = createTask(c, { title }).id;
      if (finish) {
        claimTask(c, id, { sessionId: null, now: NOW });
        transition(c, id, "done", { sessionId: null, now: NOW }, { force: true });
      }
    },
    { now: () => NOW, projectKey },
  );
  return id;
}

/** 某个 project / system 下的事件条数 */
function countEvents(projectKey: string): number {
  return t.db
    .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM events WHERE project_key = ?")
    .get(projectKey)!.n;
}

/** 某个 project 下、**挂在某张卡上**的事件条数 */
function countTaskEvents(projectKey: string, taskId: string): number {
  return t.db
    .query<{ n: number }, [string, string]>(
      "SELECT COUNT(*) AS n FROM events WHERE project_key = ? AND task_id = ?",
    )
    .get(projectKey, taskId)!.n;
}

function compact(projectKey: string, keepDays = 0) {
  return compactEvents(t.db, {
    keepDays,
    snapshotOut: join(snapDir, "snap.json"),
    now: LATER,
    projectKey,
    scope: { db: t.db, projectKey },
  });
}

describe("compact：只裁本 project 的事件", () => {
  test("裁 p1 不动 p2，也不报 p2 的条数当自己的", () => {
    mk(P1, "p1 的终态卡", true);
    mk(P1, "p1 又一张", true);
    mk(P2, "p2 的终态卡", true);

    const p1Before = countEvents(P1);
    const p2Before = countEvents(P2);
    expect(p1Before).toBeGreaterThan(0);
    expect(p2Before).toBeGreaterThan(0);

    const res = compact(P1);

    expect(res.removed).toBeGreaterThan(0);
    // before/after 必须是 **project 作用域**的计数，不是全库
    expect(res.before).toBe(p1Before);
    expect(countEvents(P1)).toBeLessThan(p1Before);
    expect(countEvents(P2)).toBe(p2Before);
    expect(res.after).toBe(countEvents(P1));
  });

  test("p1 裁干净之后，p2 的历史一条不少", () => {
    mk(P1, "p1 终态 1", true);
    mk(P1, "p1 终态 2", true);
    mk(P2, "p2 终态 1", true);
    mk(P2, "p2 终态 2", true);
    const p2Before = countEvents(P2);

    compact(P1);
    compact(P2, 0);

    // p2 被自己裁过是应该的，但只裁自己那份
    expect(countEvents(P2)).toBeLessThan(p2Before);
    expect(countEvents(P1)).toBe(0);
  });
});

describe("compact：不裁进行中任务的事件", () => {
  test("非终态任务的历史全部保留（租约回收与 rebuild 要读）", () => {
    const id = mk(P1, "还在做", false);
    // 制造一些事件：进度 + 备注 + 交接
    withTx(
      t.db,
      (c) => {
        claimTask(c, id, { sessionId: null, now: NOW });
      },
      { now: () => NOW, projectKey: P1 },
    );
    const before = countEvents(P1);
    const beforeOfTask = countTaskEvents(P1, id);

    const res = compact(P1);

    // ⚠ 不断言 `removed === 0`：project_created 这类**不挂任务**的事件
    //   （task_id IS NULL）本来就该被裁，removed 会是 1。
    //   该断言的本意是「**这张卡**的历史一条不少」，所以精确数这张卡的事件。
    expect(countTaskEvents(P1, id)).toBe(beforeOfTask);
    expect(beforeOfTask).toBeGreaterThan(0);
    // 被裁掉的正好是那些无任务的事件
    expect(res.removed).toBe(before - beforeOfTask);
  });

  test("同一批里：终态的被裁、非终态的留着", () => {
    mk(P1, "已完成的", true);
    mk(P1, "还在做的", false);
    const before = countEvents(P1);

    const res = compact(P1);

    expect(res.removed).toBeGreaterThan(0);
    expect(countEvents(P1)).toBeLessThan(before);
    // 还在做的那张卡，历史一条没少
    const live = t.db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM events WHERE project_key = ? AND task_id = (SELECT id FROM tasks WHERE status = 'todo')",
      )
      .get(P1)!.n;
    expect(live).toBeGreaterThan(0);
  });
});

describe("compact：不裁 system 事件（会话生命周期）", () => {
  test("不挂在任务上的事件（task_id IS NULL）也会被裁", () => {
    // SQL 三值逻辑的坑：`NULL NOT IN (...)` 求值为 NULL（假），
    // 所以曾经**所有**无任务事件（project_created / snapshot_written…）
    // 都会因为 task_id 为 NULL 而永远裁不掉。那是意外，不是决定。
    //
    // ⚠ 必须传 now: NOW —— createTestDb 建的 project 用的是**真实时间**
    //   （`input.now ?? Date.now()`），而本文件的逻辑时钟是 1.7e12（2023-11）。
    //   不统一的话这条 project_created 会比 cutoff 还「新」，于是理应被保留，
    //   断言就会变成在测别的东西（第一版就是这么白红的）。
    const before = countEvents(P1);
    createProject(t.db, { key: "p-null", name: "p-null", rootPath: t.path, apiKeyHash: null, now: NOW });
    expect(countEvents(P1)).toBe(before);
    // 确认这条事件确实比 cutoff 老（否则下面那个断言没有意义）
    const ev = t.db
      .query<{ ts: number }, [string]>("SELECT ts FROM events WHERE project_key = ? AND type = 'project_created' LIMIT 1")
      .get(P1)!;
    expect(ev.ts).toBe(NOW);

    compact(P1);
    // project_created 跟着它的 project 一起被裁
    expect(countEvents(P1)).toBe(0);
  });

  test("裁任意 project 都不动 session_started / session_closed", () => {
    // 造几个真实会话（它们的事件 project_key 是 'system'）
    withTx(t.db, (c) => { createSession(c, { agentName: "a", id: "s-a" }); }, { now: () => NOW, projectKey: "system" });
    withTx(t.db, (c) => { createSession(c, { agentName: "b", id: "s-b" }); }, { now: () => NOW, projectKey: "system" });
    withTx(t.db, (c) => { closeSession(c, "s-b", "收工"); }, { now: () => NOW, projectKey: "system" });

    const systemBefore = countEvents("system");
    expect(systemBefore).toBe(3);

    // 让 p1 / p2 都有可裁的历史
    mk(P1, "p1 终态", true);
    mk(P2, "p2 终态", true);
    compact(P1);
    compact(P2);

    // system 一条没少
    expect(countEvents("system")).toBe(systemBefore);
    const kinds = t.db
      .query<{ type: string }, []>("SELECT type FROM events WHERE project_key = 'system' ORDER BY seq")
      .all()
      .map((r) => r.type);
    expect(kinds).toEqual(["session_started", "session_started", "session_closed"]);
  });

  test("这是**有意**的：裁剪按 project 触发，system 事件不属于任何 project", () => {
    // 用一条断言把取舍写进测试，而不是只写在注释里：
    // 若将来有人给 compact 加了 system 范围，这条会提醒他同步更新这段说明
    const src = readSource("src/core/backup.ts");
    expect(src).toMatch(/system/);
    expect(src).toMatch(/不裁|不会裁|不属于任何 project|不参与/);
  });
});

/** 读源码（用于把「取舍」钉成断言而不只是注释）；读不到就跳过，不因环境差异而红 */
function readSource(rel: string): string {
  try {
    return readFileSync(join(process.cwd(), rel), "utf8");
  } catch {
    return "";
  }
}
