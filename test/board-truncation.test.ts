/**
 * 看板**不得静默截断**。
 *
 * ## 事故记录
 *
 * `board.ts` 的 `buildBoard` 硬编码 `limit: 500`，而 `counts` 来自全量
 * `countByStatus`。于是一个 620 张卡的 project：界面计数显示 **620**，
 * 但只渲染 **500**，**没有任何提示**——看着像「卡丢了」。
 *
 * 这类 bug 特别难在测试里发现：默认 fixture 十几张卡，远不到 500。
 * 必须真的造出 501+ 张才能看出问题，而那会让单元测试变慢。
 *
 * ## 本文件的两层守卫
 *
 * 1. **行为**：造 501 张卡，断言快照里带着 `truncated` 且 `truncated === true`；
 *    翻页后 `showing` 增长、`offset` 正确。
 * 2. **上限保护**：`limit` 必须被钳制。SQLite 里 `LIMIT -1` 是**不限长**，
 *    一个 `?limit=1e9` 就能把整库塞进一个 HTTP 响应。
 *
 * 另有一条接线守卫：Web 侧必须真的**用**了 `truncated` 字段
 * （不然就是「后端报出来了但界面还是不说」——那等于没修）。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BOARD_PAGE_SIZE, buildBoard } from "../src/core/board.ts";
import { executeOp, type OpContext } from "../src/core/ops.ts";
import { createTask } from "../src/core/tasks.ts";
import { withTx } from "../src/core/tx.ts";
import { createTestDb, type TestDb } from "./helpers/db.ts";

const ROOT = resolve(import.meta.dir, "..");
const PROJECT = "test";
/** 略超过默认页大小，好让「截断」必然发生又不至于造太多卡 */
const OVER = BOARD_PAGE_SIZE + 5;

let t: TestDb;
let clock: number;

beforeEach(() => {
  clock = 1_700_000_000_000;
  t = createTestDb({ projectKey: PROJECT, now: clock });
});

afterEach(() => {
  t.cleanup();
});

/** 一次事务里批量建卡（单条 withTx，避免 500 次事务的开销） */
function seedTasks(n: number): void {
  withTx(
    t.db,
    (c) => {
      for (let i = 1; i <= n; i++) createTask(c, { title: `卡 ${i}` });
    },
    { now: () => clock, projectKey: PROJECT },
  );
}

function opCtx(): OpContext {
  return { db: t.db, projectKey: PROJECT, sessionId: null, now: () => clock };
}

describe("buildBoard：截断必须可见", () => {
  test("卡数超过一页时，truncated 为真并报出总数", () => {
    seedTasks(OVER);
    const snap = buildBoard(t.scope, { now: clock, limit: BOARD_PAGE_SIZE });

    expect(snap.truncated.truncated).toBe(true);
    expect(snap.truncated.total).toBe(OVER);
    expect(snap.truncated.showing).toBe(BOARD_PAGE_SIZE);
    expect(snap.truncated.limit).toBe(BOARD_PAGE_SIZE);
    expect(snap.truncated.offset).toBe(0);
    // 关键：counts 本来就是全量的（所以以前才显得像「卡丢了」）
    expect(Object.values(snap.counts).reduce((a, b) => a + b, 0)).toBe(OVER);
  });

  test("卡数不足一页时，truncated 为假", () => {
    seedTasks(3);
    const snap = buildBoard(t.scope, { now: clock, limit: BOARD_PAGE_SIZE });
    expect(snap.truncated.truncated).toBe(false);
    expect(snap.truncated.showing).toBe(3);
    expect(snap.truncated.total).toBe(3);
  });

  test("翻页：offset 生效，且不把「正在翻页」误报成完整", () => {
    seedTasks(OVER);
    const page2 = buildBoard(t.scope, { now: clock, limit: BOARD_PAGE_SIZE, offset: BOARD_PAGE_SIZE });

    expect(page2.truncated.showing).toBe(OVER - BOARD_PAGE_SIZE);
    expect(page2.truncated.offset).toBe(BOARD_PAGE_SIZE);
    // offset > 0 时 truncated 恒为假：调用方是「主动在翻」，不是在看完整看板
    expect(page2.truncated.truncated).toBe(false);

    // 两页不重叠
    const p1 = buildBoard(t.scope, { now: clock, limit: BOARD_PAGE_SIZE });
    const ids1 = new Set(Object.values(p1.lanes).flatMap((l) => (l ?? []).map((t) => t.id)));
    const ids2 = new Set(Object.values(page2.lanes).flatMap((l) => (l ?? []).map((t) => t.id)));
    for (const id of ids2) expect(ids1.has(id)).toBe(false);
  });
});

describe("board.get：limit/offset 必须被钳制", () => {
  test("limit=-1 不会变成「不限长」", () => {
    seedTasks(20);
    const { data } = executeOp({ kind: "board.get", params: { limit: -1 } }, opCtx());
    const snap = data as { lanes: Record<string, unknown[]>; truncated: { limit: number; showing: number } };
    // 被钳到下界 1，而不是「返回全部」
    expect(snap.truncated.limit).toBe(1);
    expect(snap.truncated.showing).toBe(1);
  });

  test("limit=1e9 被钳到上限（否则等于把整库塞进一个响应）", () => {
    seedTasks(20);
    const { data } = executeOp({ kind: "board.get", params: { limit: 1e9 } }, opCtx());
    const snap = data as { truncated: { limit: number; showing: number } };
    expect(snap.truncated.limit).toBe(2000);
    expect(snap.truncated.showing).toBe(20); // 只有 20 张可取
  });

  test("非数字的 limit 退回默认，而不是崩或放行", () => {
    seedTasks(5);
    for (const bad of ["abc", null, {}, Number.NaN]) {
      const { data } = executeOp(
        { kind: "board.get", params: { limit: bad as unknown as number } },
        opCtx(),
      );
      const snap = data as { truncated: { limit: number; showing: number } };
      // 认不出来 → 用默认 500，于是 5 张全给
      expect({ bad: String(bad), limit: snap.truncated.limit, showing: snap.truncated.showing }).toEqual({
        bad: String(bad),
        limit: 500,
        showing: 5,
      });
    }
  });

  test("小于 1 的 limit 钳到下界 1（不是回默认，也不是「全给」）", () => {
    seedTasks(5);
    const { data } = executeOp({ kind: "board.get", params: { limit: -5 } }, opCtx());
    const snap = data as { truncated: { limit: number; showing: number } };
    expect(snap.truncated.limit).toBe(1);
    expect(snap.truncated.showing).toBe(1);
  });

  test("truncated 字段原样出现在 Op 的返回里（Web 靠它）", () => {
    seedTasks(OVER);
    const { data } = executeOp({ kind: "board.get", params: {} }, opCtx());
    expect((data as { truncated?: unknown }).truncated).toBeDefined();
  });
});

describe("接线守卫：Web 侧必须真的用了 truncated", () => {
  test("board.tsx 依据 truncated 渲染提示条", () => {
    const src = readFileSync(join(ROOT, "web/src/components/board.tsx"), "utf8");
    // 有条件渲染
    expect(src).toMatch(/board\.truncated\?\.truncated/);
    // 真的去拉下一页（而不是只显示一句提示）
    expect(src).toMatch(/fetchBoard\(token, project, \{ offset \}\)/);
    // 合并而不是整页重建（否则滚动位置与展开状态全丢）。
    // ⚠ 判的是**实际的状态更新那一行**，不能只判 `mergeBoardPages` 出现过——
    //   import 语句里就有这个名字，只判「出现过」的话，把调用换成 setBoard(next)
    //   也能蒙混过关（第一版探针就是这样报「没抓住」的）。
    expect(src).toMatch(
      /setBoard\(\(prev\) => \(prev \? mergeBoardPages\(prev, next\) : next\)\)/,
    );
  });

  test("提示条的三条文案在 zh / en 两份词典里都在", () => {
    const src = readFileSync(join(ROOT, "web/src/lib/i18n.tsx"), "utf8");
    for (const key of ["board.truncated.hint", "board.truncated.more", "board.truncated.loading"]) {
      const hits = src.split(`"${key}"`).length - 1;
      // zh + en 各一次
      expect({ key, hits }).toEqual({ key, hits: 2 });
    }
  });

  test("/api/board 也接受并钳制 limit/offset（Web 首屏走这条路）", () => {
    const src = readFileSync(join(ROOT, "src/server/http.ts"), "utf8");
    const start = src.indexOf('path === "/api/board"');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('path === "/api/events"', start));
    expect(body).toMatch(/limit/);
    expect(body).toMatch(/offset/);
    // 必须有上界，不是直接 Number() 透传
    expect(body).toMatch(/Math\.min\(/);
  });
});
