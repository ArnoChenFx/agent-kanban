/**
 * MCP 工具描述必须与实际行为一致。
 *
 * ## 为什么值得单开一个文件
 *
 * 工具描述是 **agent 唯一的文档**——agent 读不到源码，它只能读描述来推断
 * 「调了这个工具会发生什么」。所以描述说错的后果不是「文档过时」这种小事，
 * 而是 **agent 会基于错误的预期行动**。
 *
 * ## 事故记录
 *
 * `kanban_task_block` 的描述写着：
 *
 * > Mark a task blocked. **Releases the lease** so someone else can pick it up.
 *
 * 而实现**不清** `assignee_session_id` / `lease_expires_at`（`transition()` 只在
 * `isTerminal` 与 `to === "todo"` 时清）。于是：
 *
 *   - agent 以为「阻塞 = 放手，别人能接」，实际卡上一直挂着自己的名字；
 *   - 而 `reapZombies` 只回收 `status='doing'`、doctor 的孤儿检查也只筛 `doing`，
 *     所以这个持卡人**永远不会被回收**——持有者会话行都不存在了，界面还显示着他。
 *
 * 描述描述的是**设计意图**，实现落后于它。这类不一致没有任何现有测试会红：
 * 测试读的是行为，描述是字符串，两者之间没有任何联系。
 *
 * 所以这里做一件事：**把「描述里承诺的副作用」变成可执行断言。**
 */

import { describe, expect, test } from "bun:test";
import { afterEach, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TOOLS } from "../src/mcp/tools.ts";
import { claimTask, createTask, requireTask, transition, updateProgress } from "../src/core/tasks.ts";
import { createTestDb, type TestDb } from "./helpers/db.ts";

const ROOT = resolve(import.meta.dir, "..");
const PROJECT = "test";

let t: TestDb;
let clock: number;
const SID = "s-mcp";

beforeEach(() => {
  clock = 1_700_000_000_000;
  t = createTestDb({ projectKey: PROJECT, now: clock });
});

afterEach(() => {
  t.cleanup();
});

/** 取某个工具的描述 */
function descOf(name: string): string {
  const tool = (TOOLS as Array<{ name: string; description: string }>).find((x) => x.name === name);
  expect(tool, `工具 ${name} 不存在`).toBeDefined();
  return tool!.description;
}

describe("kanban_task_block：描述承诺「释放租约」→ 行为必须真的释放", () => {
  test("描述里仍写着释放租约（改描述时这条会提醒你同步改断言）", () => {
    const d = descOf("kanban_task_block");
    expect(d).toMatch(/releases? the lease/i);
  });

  test("行为：阻塞后 assignee 与 lease 都是空的", () => {
    let id = "";
    t.tx((tx) => {
      id = createTask(tx, { title: "会被阻塞的卡" }).id;
      const actor = { sessionId: SID, now: clock, ttlMs: 900_000 };
      claimTask(tx, id, actor);
      updateProgress(tx, id, actor, { pct: 40 });
      transition(tx, id, "blocked", actor, { reason: "等外部 API" });
    });

    const task = requireTask(t.scope, id);
    expect(task.status).toBe("blocked");
    // 描述承诺的那件事
    expect(task.assigneeSessionId).toBeNull();
    expect(task.leaseExpiresAt).toBeNull();
  });
});

describe("接线守卫：工具描述里不得出现「释放/清空」这类副作用承诺而无对应实现", () => {
  /**
   * 语义侧的粗筛：描述里出现这些词，就必须在同文件里能找到对应的实现痕迹。
   *
   * 这不是完备检查（描述可以是错的而实现也有那个词），但能挡住
   * 「把描述改成承诺了什么、却没动实现」这类最常见的漂移——
   * 人改描述时不会想到要同步改 core。
   */
  test("描述提到释放租约时，实现里确实有清租约的代码", () => {
    const toolsSrc = readFileSync(join(ROOT, "src/mcp/tools.ts"), "utf8");
    const tasksSrc = readFileSync(join(ROOT, "src/core/tasks.ts"), "utf8");

    const claimsLeaseRelease = (TOOLS as Array<{ name: string; description: string }>)
      .filter((x) => /releases? the lease/i.test(x.description))
      .map((x) => x.name);
    // 本仓库当前只有 kanban_task_block 这么承诺
    expect(claimsLeaseRelease).toEqual(["kanban_task_block"]);

    // 实现里 transition 对 blocked 必须真的清租约
    const blockedBranch = /if \(to === "blocked"\) \{[\s\S]{0,600}?\n  \}/.exec(tasksSrc)?.[0] ?? "";
    expect(blockedBranch).toContain("lease_expires_at = NULL");
    expect(blockedBranch).toContain("assignee_session_id = NULL");
    void toolsSrc;
  });
});
