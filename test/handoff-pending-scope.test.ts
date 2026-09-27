/**
 * 待接手交接：卡片到达终态后，它就不再是「待接手」。
 *
 * ## 事故记录（用户在界面上发现的）
 *
 * 看板的交接侧栏挂着 6 条红色告警：
 * 「the previous holder s-niz0mr went silent (10 min without a heartbeat…)」，
 * 而那 6 张卡**全部已经 done、progress 100%**。
 *
 * 也就是说 `context` 一直在叫 agent 去接手**已完成的活**，而且交接正文里的
 * 「progress 0%」与库里的 100% 直接矛盾——两条都是假信息，而且假得很具体，
 * 比「没有提示」更坏。
 *
 * 成因链：
 *   1. 一次回收为 6 张卡合成了 crash 交接（那时它们确实是 todo，语义正确）；
 *   2. 随后那 6 张卡被正常做完并标 done；
 *   3. **没有任何东西在卡片到达终态时作废它的交接**。
 *
 * 修法是**读侧**过滤（不在完成时自动消费），理由见 handoff.ts 的注释：
 * 自动消费会销毁「这张卡曾经被丢下过」这个审计事实，而读侧过滤顺带修好存量。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { countPendingHandoffs, pendingHandoffs, writeHandoff } from "../src/core/handoff.ts";
import { claimTask, createTask, transition, updateProgress } from "../src/core/tasks.ts";
import { createSession } from "../src/core/sessions.ts";
import { withTx } from "../src/core/tx.ts";
import { buildContext } from "../src/core/context.ts";
import { createTestDb, type TestDb } from "./helpers/db.ts";

const ROOT = resolve(import.meta.dir, "..");
const PROJECT = "test";
let t: TestDb;
let clock: number;

beforeEach(() => {
  clock = 1_700_000_000_000;
  t = createTestDb({ projectKey: PROJECT, now: clock });
  withTx(
    t.db,
    (c) => {
      createSession(c, { agentName: "author", id: "s-author" });
      createSession(c, { agentName: "reader", id: "s-reader" });
    },
    { now: () => clock, projectKey: "system" },
  );
});

afterEach(() => {
  t.cleanup();
});

/** 造一张卡 + 一条主动交接，返回卡号 */
function seed(title: string): string {
  let id = "";
  withTx(
    t.db,
    (c) => {
      id = createTask(c, { title }).id;
      claimTask(c, id, { sessionId: "s-author", now: clock });
      writeHandoff(c, {
        taskId: id,
        sessionId: "s-author",
        summary: `${title} 的交接`,
        nextStep: "继续",
      });
    },
    { now: () => clock, projectKey: PROJECT, sessionId: "s-author" },
  );
  return id;
}

function pendingCount(): number {
  return pendingHandoffs(t.scope, { sessionId: "s-reader", limit: 100 }).length;
}

describe("交接的「待接手」以卡片是否还开着为准", () => {
  test("卡还开着 → 交接仍然待接手", () => {
    const id = seed("还开着的卡");
    expect(pendingCount()).toBe(1);
    expect(countPendingHandoffs(t.scope)).toBe(1);
    expect(pendingHandoffs(t.scope, { sessionId: "s-reader" })[0]!.taskId).toBe(id);
  });

  test("卡被做完 → 交接不再待接手（这正是用户看到的那 6 条）", () => {
    const id = seed("做完的卡");
    expect(pendingCount()).toBe(1);
    withTx(
      t.db,
      (c) => {
        updateProgress(c, id, { sessionId: "s-author", now: clock }, { pct: 100 });
        transition(c, id, "review", { sessionId: "s-author", now: clock }, {});
        transition(c, id, "done", { sessionId: "s-author", now: clock }, {});
      },
      { now: () => clock, projectKey: PROJECT, sessionId: "s-author" },
    );
    // 卡确实完成了
    expect(
      t.db.query<{ status: string }, [string]>("SELECT status FROM tasks WHERE id = ?").get(id)!.status,
    ).toBe("done");
    // 但交接行还在库里（审计价值保留）
    expect(
      t.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM handoffs WHERE consumed_by IS NULL").get()!.n,
    ).toBe(1);
    // 只是不再被当成「待接手」
    expect(pendingCount()).toBe(0);
    expect(countPendingHandoffs(t.scope)).toBe(0);
  });

  test("卡被取消 → 同样不再待接手", () => {
    const id = seed("取消的卡");
    withTx(
      t.db,
      (c) => { transition(c, id, "cancelled", { sessionId: "s-author", now: clock }, { reason: "r" }); },
      { now: () => clock, projectKey: PROJECT, sessionId: "s-author" },
    );
    expect(pendingCount()).toBe(0);
  });

  test("卡被 reopen（done → todo）→ 它的旧交接重新变得相关", () => {
    const id = seed("会被重开的卡");
    withTx(
      t.db,
      (c) => {
        transition(c, id, "done", { sessionId: "s-author", now: clock }, { force: true });
      },
      { now: () => clock, projectKey: PROJECT, sessionId: "s-author" },
    );
    expect(pendingCount()).toBe(0);
    withTx(
      t.db,
      (c) => { transition(c, id, "todo", { sessionId: "s-author", now: clock }, { reason: "重开" }); },
      { now: () => clock, projectKey: PROJECT, sessionId: "s-author" },
    );
    // 判据是**当前状态**而不是「完成时打个标记」，所以重开后交接自动回来
    expect(pendingCount()).toBe(1);
  });

  test("context 不再建议接手已完成的卡，且不生成 crash_handoffs 建议", () => {
    seed("做完的卡 A");
    seed("做完的卡 B");
    for (const id of ["T-0001", "T-0002"]) {
      withTx(
        t.db,
        (c) => { transition(c, id, "done", { sessionId: "s-author", now: clock }, { force: true }); },
        { now: () => clock, projectKey: PROJECT, sessionId: "s-author" },
      );
    }
    const ctx = buildContext({
      scope: t.scope,
      now: clock,
      graceMs: 10 * 60_000,
      sessionId: "s-reader",
    });
    expect(ctx.pending_handoffs).toEqual([]);
    // 建议区里也不能出现「去接手」
    const joined = ctx.next_actions.join(" | ");
    expect(joined).not.toContain("left behind by a lost session");
    expect(joined).not.toContain("crash");
  });

  test("卡被删掉 → 它的交接也不再待接手（否则指向一张不存在的卡）", () => {
    const id = seed("会被删的卡");
    expect(pendingCount()).toBe(1);
    withTx(
      t.db,
      (c) => { transition(c, id, "cancelled", { sessionId: "s-author", now: clock }, { reason: "r" }); },
      { now: () => clock, projectKey: PROJECT, sessionId: "s-author" },
    );
    t.db.query("DELETE FROM tasks WHERE id = ?").run(id);
    expect(pendingCount()).toBe(0);
  });
});

describe("接线守卫：两条读路径必须用同一条过滤（角标与列表口径不能不一致）", () => {
  /** 剥注释的源码 */
  function src(rel: string): string {
    return readFileSync(join(ROOT, rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
  }

  test("pendingHandoffs 与 countPendingHandoffs 都用**同一条**过滤子句", () => {
    const h = src("src/core/handoff.ts");
    // ⚠ 这条断言曾写成「`NOT IN ('done','cancelled')` 出现 2 次」——那是在两个函数
    //   里数同一段 SQL 的副本数。它能抓住「少了一处」，但**结构上鼓励复制**：
    //   复制出来两份各自改，谁也看不出来。真正的修法是抽成单一来源
    //   （`PENDING_TASK_EXISTS`），而那样出现次数就变成 1 了——
    //   一个为了防漂移而写的守卫，反过来把「消除重复」判成失败。
    // 现在改判结构：子句只有一处定义，且两条读路径都引用它。
    const defs = (h.match(/const PENDING_TASK_EXISTS\s*=/g) ?? []).length;
    expect(defs).toBe(1);
    expect(h).toMatch(/PENDING_TASK_EXISTS\s*=\s*`EXISTS \([\s\S]*?NOT IN \('done','cancelled'\)[\s\S]*?`/);
    // 两条读路径各自引用它——不是各自内联一份
    const uses = (h.match(/\$\{PENDING_TASK_EXISTS\}/g) ?? []).length;
    expect(uses).toBe(2);
    // 反向：这段 SQL 在整个文件里**只该出现一次**（就在常量定义里）。
    // ⚠ 别写成 not.toMatch(/EXISTS \(…/)：常量定义本身就匹配那个形状。
    const sqlSites = (h.match(/EXISTS \(\s*SELECT 1 FROM tasks t/g) ?? []).length;
    expect(sqlSites).toBe(1);
  });
});
