/**
 * `context.get --consume`：只能消费**本次返回给 agent 的**那几条交接。
 *
 * ## 事故记录
 *
 * 旧实现（`ops.ts` 的 `context.get`）是：
 *
 * ```ts
 * const result = buildContext({ ..., consumeHandoffs: op.params.consume });  // 这个参数从未被用
 * if (op.params.consume) {
 *   const toConsume = pendingHandoffs(scope, { sessionId, limit: 20 });  // **第二次查询**
 *   for (const h of toConsume) consumeHandoff(tx, h.id, sessionId);
 * }
 * ```
 *
 * 两个毛病：
 *
 * 1. `consumeHandoffs` 传进 `buildContext` 却**从未被读**——签名上说有、实际没做。
 *    同样地 `tail` 也是死参数（`agent-kanban context --tail N` 一直是个空转的 flag）。
 * 2. **读与消费是两次独立查询**。两次之间新到的交接会被「消费掉但 agent 从没见过」——
 *    既没人读过，也不再挂着，等于凭空丢一条。
 *
 * 现在改成：消费 `result.pending_handoffs` 里的那几条。
 *
 * ## 为什么不把读+消费塞进同一个事务
 *
 * 因为**没必要**：真正的互斥靠租约，不靠交接的 `consumed_by`。
 * `consumeHandoff` 对已消费的交接是 no-op（不报错），所以两个 session 同时
 * `context --consume` 最多是「都以为自己消费了」；而真要动手时 `resume` 会走
 * `claimTask`，租约有效时后到的那位拿到 CONFLICT。
 * 交接的 `consumed_by` 只是「已有人看过」的提示，不承担排他职责——
 * 为它引入事务嵌套反而会让「读」变成写路径。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { executeOp, type OpContext } from "../src/core/ops.ts";
import { PENDING_HANDOFF_LIMIT, buildContext } from "../src/core/context.ts";
import { createSession, touchSession } from "../src/core/sessions.ts";
import { claimTask, createTask, updateProgress } from "../src/core/tasks.ts";
import { writeHandoff, pendingHandoffs, taskHandoffs } from "../src/core/handoff.ts";
import { withTx } from "../src/core/tx.ts";
import { createTestDb, type TestDb } from "./helpers/db.ts";

const ROOT = resolve(import.meta.dir, "..");
const PROJECT = "test";

let t: TestDb;
let clock: number;
/** 写交接的会话 */
const AUTHOR = "s-author";
/** 读 context 的会话（必须是另一个：pendingHandoffs 会排除「自己写的交接」） */
const READER = "s-reader";

beforeEach(() => {
  clock = 1_700_000_000_000;
  t = createTestDb({ projectKey: PROJECT, now: clock });
  withTx(
    t.db,
    (c) => {
      createSession(c, { agentName: "author", id: AUTHOR });
      createSession(c, { agentName: "reader", id: READER });
    },
    { now: () => clock, projectKey: "system" },
  );
});

afterEach(() => {
  t.cleanup();
});

function opCtx(sessionId: string | null = READER): OpContext {
  return { db: t.db, projectKey: PROJECT, sessionId, now: () => clock };
}

/** 造一张卡 + 一条主动交接（由 AUTHOR 写） */
function seed(taskTitle: string, summary: string): string {
  let id = "";
  withTx(
    t.db,
    (c) => {
      id = createTask(c, { title: taskTitle }).id;
      claimTask(c, id, { sessionId: AUTHOR, now: clock });
      updateProgress(c, id, { sessionId: AUTHOR, now: clock }, { pct: 50 });
      writeHandoff(c, { taskId: id, sessionId: AUTHOR, summary, nextStep: "继续" });
    },
    { now: () => clock, projectKey: PROJECT, sessionId: AUTHOR },
  );
  return id;
}

describe("context.get --consume 只消费返回给 agent 的那几条", () => {
  test("正常路径：返回的都被消费掉", () => {
    const id = seed("卡 A", "交接 A");
    const { data } = executeOp({ kind: "context.get", params: { consume: true } }, opCtx());
    const ctx = data as { pending_handoffs: Array<{ id: number }>; consumed_count?: number };

    expect(ctx.pending_handoffs).toHaveLength(1);
    expect(ctx.consumed_count).toBe(1);
    expect(taskHandoffs(t.scope, id)[0]!.consumedBy).toBe(READER);
  });

  test("--no-consume（consume=false）只读不消费", () => {
    const id = seed("卡 A", "交接 A");
    const { data } = executeOp({ kind: "context.get", params: { consume: false } }, opCtx());
    const ctx = data as { pending_handoffs: unknown[]; consumed_count?: number };

    expect(ctx.pending_handoffs).toHaveLength(1);
    expect(ctx.consumed_count).toBeUndefined();
    expect(taskHandoffs(t.scope, id)[0]!.consumedBy).toBeNull();
  });

  test("第二次跑 context：已消费的不会再出现", () => {
    seed("卡 A", "交接 A");
    executeOp({ kind: "context.get", params: { consume: true } }, opCtx());
    const { data } = executeOp({ kind: "context.get", params: { consume: true } }, opCtx());
    const ctx = data as { pending_handoffs: unknown[]; consumed_count?: number };
    expect(ctx.pending_handoffs).toHaveLength(0);
    expect(ctx.consumed_count).toBe(0);
  });

  test("消费范围与返回范围一致：超出上限的交接不会被顺手消费掉", () => {
    // 造超过上限的交接，验证「没返回的就不消费」
    for (let i = 0; i < PENDING_HANDOFF_LIMIT + 3; i++) seed(`卡 ${i}`, `交接 ${i}`);
    const allBefore = pendingHandoffs(t.scope, { sessionId: READER, limit: 1000 }).length;
    expect(allBefore).toBe(PENDING_HANDOFF_LIMIT + 3);

    const { data } = executeOp({ kind: "context.get", params: { consume: true } }, opCtx());
    const ctx = data as { pending_handoffs: Array<{ id: number }>; consumed_count?: number };

    // 只返回上限那么多，只消费那么多
    expect(ctx.pending_handoffs).toHaveLength(PENDING_HANDOFF_LIMIT);
    expect(ctx.consumed_count).toBe(PENDING_HANDOFF_LIMIT);
    // 没返回的那几条仍然挂着（没被凭空消费掉）
    const stillPending = pendingHandoffs(t.scope, { sessionId: READER, limit: 1000 }).length;
    expect(stillPending).toBe(3);
  });

  /**
   * 结构性守卫（本文件最关键的一条）。
   *
   * 上面那条行为用例**抓不住**「消费没返回的交接」这个 bug：无竞态时，
   * 「按 context 返回的 id 消费」与「再查一次 pendingHandoffs 消费」拿到的是
   * **同一批**（同样的查询、同样的 limit、同样的排序）。两者只在**两次查询之间
   * 新到交接**时才分岔，而那是竞态，无法确定性复现。
   *
   * 所以改成钉住不变量本身：`context.get` 分支**不得自己再查一次** `pendingHandoffs`
   * ——buildContext 已经查过了，消费必须从它的返回值推导。
   */
  test("context.get 不得自己再查一次 pendingHandoffs（必须是 buildContext 的返回值）", () => {
    const opsSrc = readFileSync(join(ROOT, "src/core/ops.ts"), "utf8");
    const start = opsSrc.indexOf('case "context.get"');
    expect(start).toBeGreaterThan(-1);
    // 取到下一个 case 为止
    const end = opsSrc.indexOf('case "handoff.list"', start);
    const body = opsSrc.slice(start, end === -1 ? undefined : end);
    // buildContext 内部会查（在另一个文件），ops 这一段不允许再查
    expect(body.match(/pendingHandoffs\(/g) ?? []).toHaveLength(0);
    // 并且必须从 result.pending_handoffs 推导 id
    expect(body).toMatch(/result\.pending_handoffs\.map\(\(h\) => h\.id\)/);
  });
});

describe("buildContext 的入参：没有「声明了却从不使用」的开关", () => {
  test("ContextInput 只有 4 个字段，全都被 buildContext 真正使用", () => {
    // 反向做法太脆（改名就红）。改用「每个声明的字段都得在函数体里被读过」：
    // 取 ContextInput 的字段名，逐个确认 buildContext 的函数体里有引用。
    const ctxSrc = readFileSync(join(ROOT, "src/core/context.ts"), "utf8");
    const iface = /export interface ContextInput \{([\s\S]*?)\n\}/.exec(ctxSrc)?.[1] ?? "";
    const fields = [...iface.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]!);
    expect(fields.length).toBeGreaterThan(0);

    const bodyStart = ctxSrc.indexOf("export function buildContext(");
    const body = ctxSrc.slice(bodyStart, ctxSrc.indexOf("\n}", bodyStart));
    for (const f of fields) {
      // 字段要么在解构里、要么被 input.xxx 读过
      const used = new RegExp(`\\b${f}\\b`).test(body);
      expect({ field: f, used }).toEqual({ field: f, used: true });
    }
  });

  test("context.get 的 Op 参数只有 consume（不再有那个空转的 tail）", () => {
    const opsSrc = readFileSync(join(ROOT, "src/core/ops.ts"), "utf8");
    const line = /\| \{ kind: "context\.get"; params: \{([^}]*)\} \}/.exec(opsSrc)?.[1] ?? "";
    expect(line.replace(/\s/g, "")).toBe("consume?:boolean");
  });

  test("CLI 的 context 不再接受 --tail（之前是空转的 flag）", () => {
    const recSrc = readFileSync(join(ROOT, "src/commands/recovery.ts"), "utf8");
    const start = recSrc.indexOf("async function contextCommand(");
    const body = recSrc.slice(start, recSrc.indexOf("async function resumeCommand(", start));
    // resume --tail 是活的（时间线条数），context --tail 已删
    expect(body).not.toContain('"tail"');
  });
});

void touchSession;
