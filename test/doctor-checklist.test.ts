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
import { claimTask, createTask, transition, updateProgress } from "../src/core/tasks.ts";
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
