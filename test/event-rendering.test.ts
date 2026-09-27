/**
 * 事件 → 一句话描述：两个渲染函数都必须**穷尽** `EVENT_TYPES`。
 *
 * ## 事故记录
 *
 * `events.describeEvent` 里 `plan_superseded` 读的是 `d.old_plan_id`，
 * 而 `savePlan` 发的 data 里是 `id` —— 于是
 * `plan history` / `task show --timeline` 打出
 * 「plan **undefined** superseded by a new version」，
 * 直接违反仓库自己在 `test/cli-output.test.ts` 立的「输出里不许出现 undefined」规矩。
 *
 * 查开去发现更大的问题：两个渲染函数加起来**缺 17 个 case**
 * （`context.describeEventBrief` 缺 11 个）。缺一个的后果分两种：
 *   - 读错字段层级 → 渲染出字面量 `undefined`（最刺眼，也最难被当成 bug）
 *   - 根本没 case → `default: return event.type`，直接把 `plan_superseded`
 *     这种内部名字糊到 agent 面前。仓库自己的 cli-output 测试早就说过
 *     「dep_added 不是原始事件名」，但那是**逐个**发现的。
 *
 * ## 为什么用静态扫描而不是行为测试
 *
 * 行为测试只能覆盖「已经想到要测的那条路径」。而这里的失效模式是
 * 「新加一个事件类型时忘了加 case」——它**不会让任何现有测试变红**，
 * 只在有人恰好走到那条路径时才显形。
 *
 * 所以这里反向做：**枚举 `EVENT_TYPES`，断言每个都在两个 switch 里有 case**。
 * 新增事件类型而忘了加 case，`bun test` 立刻失败。
 *
 * `default: return event.type` 那个兜底**故意留着**（向前兼容：
 * 旧 CLI 遇到新服务端的事件类型时不该崩），但它不再意味着「漏了就悄悄退化」。
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EVENT_TYPES } from "../src/core/types.ts";
import { describeEvent } from "../src/core/events.ts";
import { buildContext } from "../src/core/context.ts";
import { describeEvent as describeEventWeb } from "../src/core/events.ts";

const ROOT = resolve(import.meta.dir, "..");

/**
 * 抽出**某个函数体内**的所有 `case "xxx":`。
 *
 * 不能全文扫：context.ts 里还有 renderNextAction 的 switch（NextActionCode），
 * 全文扫会把那些代号当成事件类型，误报「两个函数 case 集合不一致」。
 */
function casesInFunction(rel: string, fnName: string): Set<string> {
  const src = readFileSync(join(ROOT, rel), "utf8");
  const start = src.indexOf(`function ${fnName}(`);
  if (start === -1) return new Set();
  // 函数体到行首的 `}` 为止（本仓库的函数都是这个收尾风格）
  const end = src.indexOf("\n}", start);
  const body = src.slice(start, end === -1 ? undefined : end);
  return new Set([...body.matchAll(/case "([a-z_]+)"/g)].map((m) => m[1]!));
}

describe("事件渲染：必须穷尽 EVENT_TYPES", () => {
  test("events.describeEvent 覆盖全部事件类型", () => {
    const cases = casesInFunction("src/core/events.ts", "describeEvent");
    expect(EVENT_TYPES.filter((t) => !cases.has(t))).toEqual([]);
  });

  test("context.describeEventBrief 覆盖全部事件类型", () => {
    const cases = casesInFunction("src/core/context.ts", "describeEventBrief");
    expect(EVENT_TYPES.filter((t) => !cases.has(t))).toEqual([]);
  });

  test("两个函数的 case 集合一致（不能一个补了另一个没补）", () => {
    const a = casesInFunction("src/core/events.ts", "describeEvent");
    const b = casesInFunction("src/core/context.ts", "describeEventBrief");
    const onlyInA = [...a].filter((x) => !b.has(x)).sort();
    const onlyInB = [...b].filter((x) => !a.has(x)).sort();
    expect({ onlyInA, onlyInB }).toEqual({ onlyInA: [], onlyInB: [] });
  });
});

describe("凭据 / 项目的审计事件（#18）", () => {
  /** 剥掉注释的源码——本文件的断言全是「代码里不该出现什么」，而注释必然提到那些东西 */
  function src(rel: string): string {
    return readFileSync(join(ROOT, rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
  }

  test("六类事件都进了 EVENT_TYPES", () => {
    for (const t of [
      "token_issued",
      "token_revoked",
      "token_updated",
      "project_created",
      "project_renamed",
      "project_key_rotated",
    ]) {
      expect({ event: t, inTypes: (EVENT_TYPES as readonly string[]).includes(t) }).toEqual({
        event: t,
        inTypes: true,
      });
    }
  });

  test("审计事件**不写凭据**（key / key_hash / 明文）", () => {
    const tokens = src("src/core/tokens.ts");
    for (const emit of tokens.matchAll(/ctx\.emit\(\{[\s\S]*?\}\);/g)) {
      expect(emit[0]).not.toMatch(/key_hash\s*:/);
      expect(emit[0]).not.toMatch(/plaintext\s*:/);
    }
    // ops.ts 的 rotate_key 也不许把明文写进事件
    const ops = src("src/core/ops.ts");
    const rotate = ops.slice(ops.indexOf('case "project.rotate_key"'), ops.indexOf('case "project.create"'));
    const start = rotate.indexOf("tx.emit(");
    const emitBlock = rotate.slice(start, rotate.indexOf("});", start));
    expect(emitBlock).not.toMatch(/apiKey/);
  });

  test("rebuild 刻意**不**消费这些事件（它们是审计，不是投影）", () => {
    const rb = src("src/core/rebuild.ts");
    const start = rb.indexOf("function applyEvent(");
    const body = rb.slice(start, rb.indexOf("\n}", start));
    for (const t of ["token_issued", "token_revoked", "project_created", "project_renamed"]) {
      expect({ event: t, handledByRebuild: body.includes(`"${t}"`) }).toEqual({
        event: t,
        handledByRebuild: false,
      });
    }
    // 并且 types.ts 把这个取舍写下来了（下一个人的直觉是「事件里有就该重建」）
    expect(readFileSync(join(ROOT, "src/core/types.ts"), "utf8")).toMatch(/审计，不是投影|不是 rebuild 的输入/);
  });

  test("token 的写操作都在事务里（mutation 与事件同一事务）", () => {
    const tokens = src("src/core/tokens.ts");
    for (const fn of ["issueToken", "updateTokenProjects", "revokeToken", "updateTokenMeta"]) {
      const start = tokens.indexOf(`export function ${fn}(`);
      const body = tokens.slice(start, tokens.indexOf("\n}", start));
      expect({ fn, usesAuditTx: body.includes("auditWrite(") }).toEqual({ fn, usesAuditTx: true });
    }
  });

  test("project 的写操作都在事务里（曾经是裸 UPDATE，没有任何痕迹）", () => {
    const projects = src("src/core/projects.ts");
    const start = projects.indexOf("export function createProject(");
    const create = projects.slice(start, projects.indexOf("\n}", start));
    expect(create).toContain("withTx(");
    expect(create).toContain('type: "project_created"');

    const ops = src("src/core/ops.ts");
    for (const fn of ["project.rename", "project.rotate_key"]) {
      const s2 = ops.indexOf(`case "${fn}"`);
      const body = ops.slice(s2, ops.indexOf("\n    }", s2));
      expect({ fn, inTx: body.includes("withTx("), emits: body.includes("tx.emit(") }).toEqual({
        fn,
        inTx: true,
        emits: true,
      });
    }
    // project.create 不再借用 board_exported 事件类型（那是类型复用，读事件的人会困惑）
    expect(ops).not.toMatch(/type: "board_exported"[\s\S]{0,200}project_created/);
  });
});

describe("describeEvent 不得渲染出字面量 undefined", () => {
  /**
   * 用**真实形状**的事件 payload 逐个过一遍。
   *
   * 为什么要真实形状：payload 是各写入点手写的，字段名会漂。
   * 这里直接从源码里读不到 payload，所以用「最小合法 payload」——
   * 缺字段时 `d.x ?? 默认值` 应该给出可读文本，而不是 `undefined`。
   */
  test("每个事件类型在空 payload 下也不出现 undefined / null 字面量", () => {
    const offenders: string[] = [];
    for (const type of EVENT_TYPES) {
      const out = describeEvent({
        seq: 1,
        ts: 0,
        sessionId: null,
        type,
        taskId: null,
        planId: null,
        projectKey: null,
        data: {},
      });
      if (/\bundefined\b|\bnull\b|\[object Object\]/.test(out)) {
        offenders.push(`${type} → "${out}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("plan_superseded 用的是 id 而不是 old_plan_id", () => {
    const out = describeEvent({
      seq: 1,
      ts: 0,
      sessionId: null,
      type: "plan_superseded",
      taskId: "T-0001",
      planId: "PL-T-0001-01",
      projectKey: null,
      // savePlan 实际发的形状
      data: {
        id: "PL-T-0001-01",
        scope: "task",
        task_id: "T-0001",
        version: 1,
        title: "v1",
        body: "…",
        status: "superseded",
        author_session_id: null,
        created_at: 0,
        supersedes_id: null,
      },
    });
    expect(out).toContain("PL-T-0001-01");
    expect(out).not.toContain("undefined");
  });

  test("项目级计划也带出版本号（id 只是 PL-0001，区分版本靠 version）", () => {
    const out = describeEvent({
      seq: 1,
      ts: 0,
      sessionId: null,
      type: "plan_superseded",
      taskId: null,
      planId: "PL-0001",
      projectKey: null,
      data: { id: "PL-0001", scope: "project", version: 2, status: "superseded" },
    });
    expect(out).toContain("PL-0001");
    expect(out).toContain("v2");
  });
});

// buildContext / describeEventWeb 只是为了确保这两个 import 真的被用到（它们本身就是
// 被本文件守护的消费方）；空 payload 用例已经覆盖真正的风险。
void buildContext;
void describeEventWeb;
