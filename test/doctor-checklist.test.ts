/**
 * `doctor` 能不能抓到「标了 done 但 checklist 没勾完」这种自相矛盾。
 *
 * ## 为什么值得单开一个文件
 *
 * 本项目开发期间真的踩到过：两张卡被标成 done，而它们的 checklist **全部未勾**。
 * 原因是关卡时把命令输出 `*> $null` 吞了，`checklist_item_not_found` 报错完全看不见，
 * 而 `pct 100` + `review` + `done` 照样一路绿灯。
 *
 * 这类错误对**工具链完全隐形**：
 *   - `bun test` 绿（测试不检查看板内容）；
 *   - `rebuild` 自证通过（投影与事件流确实一致——两张卡在库里就真是「done 且未勾」）；
 *   - 人眼扫一眼看板也不会注意到。
 *
 * 也就是说：看板的**自证机制覆盖不了「断言与证据不一致」**。
 * 所以必须有一条显式检查，而且它的存在本身就是价值——
 * 哪怕它只是让「有没有未勾项」变成一个会被看见的事实。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runDoctor } from "../src/core/doctor.ts";
import { rebuild } from "../src/core/rebuild.ts";
import { claimTask, createTask, getTask, transition, updateProgress } from "../src/core/tasks.ts";
import { createTestDb, type TestDb } from "./helpers/db.ts";

const PROJECT = "test";
let t: TestDb;
let clock: number;

beforeEach(() => {
  clock = 1_700_000_000_000;
  t = createTestDb({ projectKey: PROJECT, now: clock });
});

afterEach(() => {
  t.cleanup();
});

/** 走完 doing → review → done 的正规流程 */
function finish(id: string, checked: string[]): void {
  t.tx((c) => {
    claimTask(c, id, { sessionId: null, now: clock });
    for (const item of checked) updateProgress(c, id, { sessionId: null, now: clock }, { check: [item] });
    transition(c, id, "review", { sessionId: null, now: clock }, {});
    transition(c, id, "done", { sessionId: null, now: clock }, {});
  });
}

function undoneCodes(): string[] {
  return runDoctor(t.db, { projectKey: PROJECT, now: clock })
    .issues.filter((i) => i.code === "done_with_unchecked_checklist")
    .map((i) => i.code);
}

describe("doctor 抓「done 但 checklist 未勾完」", () => {
  test("全勾完的 done 卡不报", () => {
    let id = "";
    t.tx((c) => { id = createTask(c, { title: "干净收尾", checklist: ["甲", "乙"] }).id; });
    finish(id, ["甲", "乙"]);
    expect(undoneCodes()).toEqual([]);
  });

  test("有未勾项的 done 卡会被报出来", () => {
    let id = "";
    t.tx((c) => { id = createTask(c, { title: "漏勾了", checklist: ["甲", "乙", "丙"] }).id; });
    // 只勾两项就宣布完成 —— 正是本轮发生的事故
    finish(id, ["甲", "乙"]);
    const report = runDoctor(t.db, { projectKey: PROJECT, now: clock });
    const issue = report.issues.find((i) => i.code === "done_with_unchecked_checklist");
    expect(issue).toBeDefined();
    expect(issue!.subjects.join()).toContain(id);
    expect(issue!.message).toContain("unchecked");
    // 提示要说清「有意放弃」和「忘了做」要区别对待
    expect(issue!.hint).toContain("deliberately dropped");
    expect(issue!.severity).toBe("warning");
  });

  test("cancelled 卡同样适用（它也是「结束」的断言）", () => {
    let id = "";
    t.tx((c) => {
      id = createTask(c, { title: "取消但有未勾项", checklist: ["甲"] }).id;
      claimTask(c, id, { sessionId: null, now: clock });
      transition(c, id, "cancelled", { sessionId: null, now: clock }, { reason: "r" });
    });
    expect(undoneCodes()).toContain("done_with_unchecked_checklist");
  });

  test("doctor --fix 不替你勾（勾选是人的判断）", () => {
    let id = "";
    t.tx((c) => { id = createTask(c, { title: "有意放弃一项", checklist: ["甲", "乙"] }).id; });
    finish(id, ["甲"]);
    const before = runDoctor(t.db, { projectKey: PROJECT, now: clock, fix: true });
    const issue = before.issues.find((i) => i.code === "done_with_unchecked_checklist");
    expect(issue).toBeDefined();
    expect(issue!.fixed).toBe(false);
    // 跑完 --fix 之后仍然未勾（doctor 没有代替人做决定）
    const after = runDoctor(t.db, { projectKey: PROJECT, now: clock });
    expect(after.issues.some((i) => i.code === "done_with_unchecked_checklist")).toBe(true);
  });

  test("没有 checklist 的 done 卡不报（无证据链可矛盾）", () => {
    let id = "";
    t.tx((c) => { id = createTask(c, { title: "没有清单" }).id; });
    finish(id, []);
    expect(undoneCodes()).toEqual([]);
  });
});

/**
 * doctor --fix 不得绕过事件溯源（ADR-1）。
 *
 * 曾经的写法：stale_block 修复直接 UPDATE 成 todo、不写 task_unblocked 事件，
 * releaseOrphans 的 UPDATE 与事件 INSERT 各自 autocommit。后果有两个：
 *   - rebuild --write 会把修好的卡**打回** blocked（事件流是唯一事实源）；
 *   - 中断会留下「状态变了没日志」的半成品。
 * 守卫：修完之后跑 rebuild 只重放校验，drift 必须为空——这正是
 * "修复走了事件路径" 的可观测判据，比逐条查 events 表更贴近事故本身。
 */
describe("doctor --fix 走事件溯源", () => {
  test("stale_block 修复后 rebuild 无漂移", () => {
    let id = "";
    t.tx((c) => {
      id = createTask(c, { title: "被忘掉的阻塞" }).id;
      claimTask(c, id, { sessionId: "s1", now: clock });
      // 依赖本来就不存在（全部"已完成"）→ block 后立即成为 stale_block 候选
      transition(c, id, "blocked", { sessionId: "s1", now: clock }, { reason: "等一个不存在的上游" });
    });

    const report = runDoctor(t.db, { projectKey: PROJECT, now: clock, fix: true });
    const issue = report.issues.find((i) => i.code === "stale_block");
    expect(issue).toBeDefined();
    expect(issue!.fixed).toBe(true);
    expect(getTask(t.scope, id)!.status).toBe("todo");

    // 关键断言：投影与事件流一致。若修复没写 task_unblocked 事件，
    // rebuild 会期望 blocked，这里就会报 drift
    const rb = rebuild(t.db, { projectKey: PROJECT });
    expect(rb.drift).toEqual([]);
    expect(rb.ok).toBe(true);
  });

  test("stale_lease 回收后 rebuild 无漂移", () => {
    let id = "";
    t.tx((c) => {
      id = createTask(c, { title: "持有者失联" }).id;
      claimTask(c, id, { sessionId: "ghost", now: clock, ttlMs: 60_000 });
    }, { sessionId: "ghost" });

    // 持有者再无心跳，租约到期 → doctor 视为失联
    clock += 10 * 60 * 1000;
    const report = runDoctor(t.db, { projectKey: PROJECT, now: clock, fix: true });
    const issue = report.issues.find((i) => i.code === "stale_lease");
    expect(issue).toBeDefined();
    expect(issue!.fixed).toBe(true);
    expect(getTask(t.scope, id)!.status).toBe("todo");

    const rb = rebuild(t.db, { projectKey: PROJECT });
    expect(rb.drift).toEqual([]);
    expect(rb.ok).toBe(true);
  });
});
