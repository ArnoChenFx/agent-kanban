/**
 * 前端文案本地化测试（建议区）。
 *
 * ## 这次修的是什么
 *
 * 侧栏「建议接下来」直接渲染后端 `context.next_actions` 里的中文串，
 * 英文界面下那个面板会安静地露出中文（截图里的两条「有 1 张卡阻塞中…」/「认领新任务…」）。
 *
 * ## 修法与守卫
 *
 * 后端改为同时给出 `next_action_items`（代号 + 参数），中文串由同一份数据渲染；
 * 前端按代号选词典条目。这里钉住四件事：
 *   1. 两侧的**代号联合类型不许漂移**（前端多一个/少一个都算破）
 *   2. 每个代号在 zh / en **两份词典里都必须有词条**，且英文词条里不许有中文
 *   3. 渲染行为：选词、单/复数、数组按语言拼接、摘要透传
 *   4. 三条降级路径：老服务端没发 items、运行时不认识的代号、尾部多出的建议
 *
 * ## 为什么用动态 import 而不是静态 import
 *
 * `web/` 有自己的 tsconfig（jsx + DOM lib），web 源码不在根 `tsc --noEmit` 的
 * 编译范围里。静态 import 会把 api.ts / i18n.tsx 连带拖进根程序（于是报
 * "Cannot use JSX"、"Cannot find name 'window'"）。变量形式的 specifier
 * 对类型检查器是不透明的，只在运行时解析——两边各得其所：
 * 类型归 `bun run web:typecheck`，行为归这里。
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const I18N_SRC = readFileSync(join(ROOT, "web", "src", "lib", "i18n.tsx"), "utf8");
/** en 词典的起点：zh 与 en 必须是两份各自完整的内容，不能互相引用 */
const EN_START = I18N_SRC.indexOf("const en: Record<MessageKey, string>");

/** 本测试用到的 web 侧函数签名（见 web/src/lib/next-actions.ts） */
type NextItem = { code: string; args?: Record<string, unknown> };
type TFn = (key: string, params?: Record<string, string | number | undefined>) => string;
let localizedNextActions: (ctx: unknown, t: TFn) => string[];
let keyFor: (item: NextItem) => string | null;
/** 错误解析层（web/src/lib/error-text.ts） */
type ErrLike = { code: number; name: string; message: string; details: Record<string, unknown> };
let errorText: (e: ErrLike, t?: TFn) => string;

beforeAll(async () => {
  // 变量 specifier：类型检查器不解析，bun 运行时会
  const specifier = "../web/src/lib/next-actions.ts";
  const mod = (await import(specifier)) as {
    localizedNextActions: typeof localizedNextActions
    keyFor: typeof keyFor
  };
  localizedNextActions = mod.localizedNextActions;
  keyFor = mod.keyFor;

  // 变量 specifier（与上面同一个理由：字面量 specifier 会被根 tsc 解析，
  // 把 i18n.tsx 连带拖进根程序，于是报 "Cannot use JSX" / "Cannot find name 'window'"）
  const errSpecifier = "../web/src/lib/error-text.ts";
  const errMod = (await import(errSpecifier)) as { errorText: typeof errorText };
  errorText = errMod.errorText;
});

/** 造一个能跑的 t：list.sep 走中文标点，其余直接把键名回显（便于断言选了哪一条） */
const tEcho: TFn = (key) => (key === "list.sep" ? "、" : key);

/** 后端 NextActionCode 联合类型的成员（从源码里抠出来，不手抄一份） */
function backendCodes(): string[] {
  const src = readFileSync(join(ROOT, "src", "core", "context.ts"), "utf8");
  const block = src.slice(src.indexOf("export type NextActionCode"), src.indexOf("export interface NextActionArgs"));
  return [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
}

/** 前端 NextActionCode 的成员（web/src/lib/api.ts） */
function frontendCodes(): string[] {
  const src = readFileSync(join(ROOT, "web", "src", "lib", "api.ts"), "utf8");
  const block = src.slice(src.indexOf("export type NextActionCode"), src.indexOf("export interface NextActionItem"));
  return [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
}

/** RecoveryContext 的最小骨架（只填本测试用得到的字段） */
function ctxOf(items: NextItem[] | undefined, texts: string[]): unknown {
  return {
    project: { key: "demo", name: "demo" },
    counts: {},
    zombie_sessions: [],
    pending_handoffs: [],
    my_tasks: [],
    in_progress: [],
    blocked: [],
    ready: [],
    next_actions: texts,
    next_action_items: items,
  };
}

const item = (code: string, args: Record<string, unknown> = {}): NextItem => ({ code, args });

describe("建议区：代号契约两侧不许漂移", () => {
  test("前端 NextActionCode 与后端一致", () => {
    const back = backendCodes();
    expect(back.length).toBeGreaterThan(0);
    expect(frontendCodes().sort()).toEqual([...back].sort());
  });

  test("每个代号在 zh / en 两份词典里都有词条", () => {
    // n=1 与 n=2 各取一次：带计数的代号会选到 .one / .many 两个不同的键
    const keys = new Set<string>();
    for (const code of backendCodes()) {
      for (const n of [1, 2]) {
        const key = keyFor({ code, args: { n } });
        expect(`${code} → ${String(key)}`).not.toContain("null");
        keys.add(key!);
      }
    }
    const missingZh: string[] = [];
    const missingEn: string[] = [];
    for (const key of keys) {
      if (!I18N_SRC.slice(0, EN_START).includes(`"${key}":`)) missingZh.push(key);
      if (!I18N_SRC.slice(EN_START).includes(`"${key}":`)) missingEn.push(key);
    }
    expect({ missingZh, missingEn }).toEqual({ missingZh: [], missingEn: [] });
  });

  test("英文词条里不许有中文（中文串是后端给的，界面不该自己写死）", () => {
    const en = I18N_SRC.slice(EN_START);
    let hits: string[] = [];
    for (const m of en.matchAll(/"([\w.]+)":\s*"([^"]*)"/g)) {
      if (/[一-鿿]/.test(m[2]!)) hits.push(m[1]!);
    }
    expect(hits).toEqual([]);
  });
});

describe("建议区：本地化渲染", () => {
  test("按代号选词条，不再显示后端中文串", () => {
    const out = localizedNextActions(
      ctxOf(
        [item("blocked_needs_human", { n: 2, tasks: ["T-0013", "T-0014"] }), item("idle")],
        ["有 2 张卡阻塞中（可能需要人介入）：T-0013, T-0014", "没有待办任务。…"],
      ),
      tEcho,
    );
    expect(out).toEqual(["sidebar.next.blocked.many", "sidebar.next.idle"]);
    // 一条中文都不该漏到界面上
    expect(out.join("")).not.toMatch(/[一-鿿]/);
  });

  test("带计数的代号按数量选单/复数两条", () => {
    const one = localizedNextActions(ctxOf([item("crash_handoffs", { n: 1, tasks: ["T-0007"] })], ["x"]), tEcho);
    const many = localizedNextActions(ctxOf([item("crash_handoffs", { n: 3, tasks: ["T-0007"] })], ["x"]), tEcho);
    expect(one).toEqual(["sidebar.next.crashHandoffs.one"]);
    expect(many).toEqual(["sidebar.next.crashHandoffs.many"]);
  });

  test("任务号按语言标点列举，命令行之间用斜杠", () => {
    let captured: Record<string, string | number | undefined> = {};
    const tSpy: TFn = (key, params) => {
      if (key !== "list.sep") captured = params ?? {};
      return key === "list.sep" ? "、" : key;
    };
    localizedNextActions(
      ctxOf([item("continue_mine", { tasks: ["T-0001(40%)", "T-0002(10%)"] })], ["x"]),
      tSpy,
    );
    // 顿号/逗号才是语言的一部分
    expect(captured.tasks).toBe("T-0001(40%)、T-0002(10%)");
    localizedNextActions(
      ctxOf([item("takeover", { commands: ["agent-kanban resume T-0013", "agent-kanban resume T-0014"] })], ["x"]),
      tSpy,
    );
    // 斜杠两边都是代码，不随语言变
    expect(captured.commands).toBe("agent-kanban resume T-0013 / agent-kanban resume T-0014");
  });

  test("交接摘要原样透传（那是上一个 agent 写的内容，不是界面文案）", () => {
    let captured: Record<string, string | number | undefined> = {};
    const tSpy: TFn = (_key, params) => {
      captured = params ?? {};
      return "read";
    };
    localizedNextActions(ctxOf([item("read_handoff", { id: 12, task: "T-0007", summary: "前半段做完了" })], ["x"]), tSpy);
    expect(captured.summary).toBe("前半段做完了");
    expect(captured.id).toBe(12);
  });

  test("老服务端没发 next_action_items 时退回中文串（不白屏）", () => {
    const texts = ["接管失联会话留下的任务（进度已保留）：agent-kanban resume T-0013"];
    expect(localizedNextActions(ctxOf(undefined, texts), tEcho)).toEqual(texts);
    expect(localizedNextActions(ctxOf([], texts), tEcho)).toEqual(texts);
  });

  test("运行时不认识的代号退回同一序号的中文串（前端旧 + 服务端新）", () => {
    const texts = ["后端未来的新建议", "认领新任务：agent-kanban task claim T-0005"];
    const out = localizedNextActions(
      ctxOf([item("brand_new_code_2030"), item("claim_new", { commands: ["agent-kanban task claim T-0005"] })], texts),
      tEcho,
    );
    expect(out).toEqual(["后端未来的新建议", "sidebar.next.claim"]);
  });

  test("服务端多给的建议不会被丢掉", () => {
    const out = localizedNextActions(ctxOf([item("idle")], ["没有待办任务。…", "多出来的一条"]), tEcho);
    expect(out).toEqual(["sidebar.next.idle", "多出来的一条"]);
  });
});

// ---------------------------------------------------------------------------
// 错误文案：CLI 英文化之后，中文界面靠 details.reason 查词典
// ---------------------------------------------------------------------------

/** 从一段词典源码里抠出 key → value（值里不含转义引号，两个词典都不需要处理那种情况） */
function parseEntries(src: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of src.matchAll(/"([\w.]+)":\s*"([^"]*)"/g)) map.set(m[1]!, m[2]!);
  return map;
}

const errorZh = [...parseEntries(I18N_SRC.slice(0, EN_START))].filter(([k]) => k.startsWith("error."));
const errorEn = new Map([...parseEntries(I18N_SRC.slice(EN_START))].filter(([k]) => k.startsWith("error.")));

/**
 * 后端源码里出现过的对象键名（词典占位符必须对得上其中之一）。
 *
 * 不锚定行首：details 常写成单行对象字面量
 * （`{ reason: "x", db_version: from }`），行首锚定会漏掉后半段。
 * 因此会多收一些非 details 的键（类型注解、别处的对象），宁可放宽——
 * 这个集合只用来判断「占位符名有没有写错」，不是用来做白名单。
 */
function backendDetailKeys(): Set<string> {
  const keys = new Set<string>();
  const files = [
    ...Array.from(new Bun.Glob("*.ts").scanSync(join(ROOT, "src", "core"))).map((f) => join("src", "core", f)),
    join("src", "server", "http.ts"),
  ];
  for (const rel of files) {
    const src = readFileSync(join(ROOT, rel), "utf8");
    for (const m of src.matchAll(/[{,\s]([a-z_][a-z0-9_]*)\s*:/g)) keys.add(m[1]!);
  }
  return keys;
}

const errOf = (message: string, details: Record<string, unknown>): ErrLike => ({
  code: 2,
  name: "STATE",
  message,
  details,
});

describe("错误文案：reason slug → error.* 词典", () => {
  test("error.* 在 zh / en 两份词典里都存在，且 en 刻意留空", () => {
    expect(errorZh.length).toBeGreaterThan(20);
    expect(errorZh.filter(([k]) => !errorEn.has(k)).map(([k]) => k)).toEqual([]);
    // en 留空 = “直接用后端英文原文”。抄一份具体英文进去就多出一份会漂移的第二真相。
    expect(errorZh.filter(([k]) => errorEn.get(k) !== "").map(([k]) => k)).toEqual([]);
    // zh 必须是真文案，不能也留空
    expect(errorZh.filter(([, v]) => v.trim() === "").map(([k]) => k)).toEqual([]);
  });

  test("zh 模板的占位符在后端 details 里真的存在（{taskId} 拼错会渲染出字面量）", () => {
    const known = backendDetailKeys();
    const bad: string[] = [];
    for (const [key, value] of errorZh) {
      for (const m of value.matchAll(/\{(\w+)\}/g)) {
        if (!known.has(m[1]!)) bad.push(`${key} → {${m[1]!}}`);
      }
    }
    expect(bad).toEqual([]);
  });

  test("命中词典则按 details 插值", () => {
    const t: TFn = (k) => (k === "error.task_not_found" ? "任务 {task_id} 不存在" : k);
    expect(errorText(errOf("task T-0009 not found", { reason: "task_not_found", task_id: "T-0009" }), t)).toBe(
      "任务 T-0009 不存在",
    );
  });

  test("缺参数时保留占位符，而不是渲染成空串或 undefined", () => {
    const t: TFn = (k) => (k === "error.task_not_found" ? "任务 {task_id} 不存在" : k);
    // 保留 {task_id} 能直接暴露缺哪个字段；渲染成空串会让人以为信息不完整
    expect(errorText(errOf("task not found", { reason: "task_not_found" }), t)).toBe("任务 {task_id} 不存在");
  });

  test("没有 reason / 词典查不到 → 回退后端原文（英文）", () => {
    expect(errorText(errOf("task not found", {}), tEcho)).toBe("task not found");
    expect(errorText(errOf("something new", { reason: "a_reason_from_2030" }), tEcho)).toBe("something new");
  });

  test("英文词典留空 → 同样回退后端原文，而不是显示空错误框", () => {
    // 英文界面里 error.* 一律是空串，i18n 的 lookup 会把它原样返回
    const blankEn: TFn = (k) => (k.startsWith("error.") ? "" : k);
    expect(errorText(errOf("task T-0009 not found", { reason: "task_not_found" }), blankEn)).toBe(
      "task T-0009 not found",
    );
  });
});
