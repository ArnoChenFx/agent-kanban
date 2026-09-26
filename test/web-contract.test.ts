/**
 * Web 看板与后端之间的**接口契约**测试。
 *
 * 为什么单独一个文件：Web 前端（web/src）不在 `tsc --noEmit` 的编译范围里，
 * 也没有前端测试运行器，所以前后端"形状漂移"没人拦。
 * 已经踩过一次：前端按 `{ task: {...} }` 拆 `task.get` 的返回值，
 * 而服务端（以及 CLI / MCP）一直返回**任务本体**，
 * 结果点开任务详情就抛 `Cannot read properties of undefined (reading 'plan_id')`。
 *
 * 这里钉住五件事：
 * 1. `task.get` 的 data 就是任务本体（不是包装对象），且带上前端要读的字段
 * 2. 前端 `web/src/lib/api.ts` 不能再出现 `data.task` 这种拆包装的写法
 * 3. `handoff.list` / `task.transition` 这类前端在调的 Op 必须真的存在（曾长期是"未实现"）
 * 4. 描述字段的参数名是 `description`（曾写成 `body` → 服务端静默忽略 → 填了等于没填）
 * 5. `task.get` 必须真的返回描述与检查项**明细**（详情抽屉概览区的数据源）
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate, openDb, setInitialConfig, type Db } from "../src/core/db.ts";
import { createProject } from "../src/core/projects.ts";
import { issueToken } from "../src/core/tokens.ts";
import { createSession } from "../src/core/sessions.ts";
import { withTx } from "../src/core/tx.ts";
import { startServer } from "../src/server/http.ts";
import type { Op } from "../src/core/ops.ts";

const FIXED_NOW = 1_767_225_600_000;
const PROJECT = "web-demo";
const ROOT = resolve(import.meta.dir, "..");

let dir: string;
let handle: Db;
let server: ReturnType<typeof startServer>;
let baseUrl: string;
let token: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "kanban-web-contract-"));
  const dbPath = join(dir, "server.db");
  handle = openDb(dbPath);
  migrate(handle);
  setInitialConfig(handle.raw, { projectName: "web-contract" });

  withTx(handle.raw, (tx) => {
    createProject(tx.db, { key: PROJECT, name: "Web 演示" });
    createSession(tx, { agentName: "pi-main", id: "s-aaaaaa" });
  });
  token = issueToken(
    handle.raw,
    { role: "project", projects: [PROJECT], name: "web 测试 token" },
    FIXED_NOW,
  ).plaintext;

  server = startServer({
    dbPath,
    host: "127.0.0.1",
    port: 0,
    reapIntervalSec: 3600,
    now: () => FIXED_NOW,
    noBootstrap: true,
  });
  baseUrl = server.url;
});

afterAll(() => {
  server.stop();
  handle.raw.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 走前端那条路：POST /api/op */
async function callOp<T = Record<string, unknown>>(
  op: Op,
  sessionId: string | null = "s-aaaaaa",
): Promise<{ status: number; ok: boolean; data: T; error?: { code: number; message: string } }> {
  const res = await fetch(`${baseUrl}/api/op`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Kanban-Key": token,
      ...(sessionId ? { "X-Kanban-Session": sessionId } : {}),
    },
    body: JSON.stringify({ project: PROJECT, op }),
  });
  const body = (await res.json()) as {
    ok: boolean;
    data?: T;
    error?: { code: number; message: string };
  };
  return { status: res.status, ok: body.ok, data: body.data as T, error: body.error };
}

describe("task.get 的返回形状（前端点开任务详情走这条）", () => {
  let taskId = "";

  test("先建一张卡、认领、写交接（造出有 plan/时间线/交接的数据）", async () => {
    const created = await callOp<{ id: string }>({
      kind: "task.create",
      params: { title: "打开任务详情的卡", priority: 1, checklist: ["第一步", "第二步"] },
    });
    expect(created.ok).toBe(true);
    taskId = created.data.id;

    await callOp({ kind: "task.claim", params: { task_id: taskId } });
    await callOp({ kind: "task.progress", params: { task_id: taskId, pct: 50, note: "改到一半" } });
    await callOp({
      kind: "handoff.create",
      params: { task_id: taskId, summary: "前半段做完了", next_step: "收尾" },
    });
  });

  test("data 就是任务本体，不带 { task } 包装", async () => {
    const res = await callOp<Record<string, unknown>>({
      kind: "task.get",
      params: { task_id: taskId, timeline: true, tail: 20 },
    });
    expect(res.ok).toBe(true);

    // 前端就是按"顶层即任务"来读字段的：任何一层少字段都会在页面上崩或空白
    expect(res.data.id).toBe(taskId);
    expect(res.data.title).toBe("打开任务详情的卡");
    expect(typeof res.data.status).toBe("string");
    expect(typeof res.data.progress).toBe("number");
    expect("plan_id" in res.data).toBe(true);
    expect(Array.isArray(res.data.labels)).toBe(true);
    expect(Array.isArray(res.data.checklist)).toBe(true);

    // 关键回归点：如果哪天服务端又改成包装返回，这里会看到 data.task 有值
    expect("task" in res.data).toBe(false);
  });

  test("timeline: true 时事件与任务在同一次响应里", async () => {
    const res = await callOp<Record<string, unknown>>({
      kind: "task.get",
      params: { task_id: taskId, timeline: true, tail: 20 },
    });
    expect(Array.isArray(res.data.timeline)).toBe(true);
    // 至少要有认领/进度/交接这几条事件
    expect((res.data.timeline as unknown[]).length).toBeGreaterThan(0);
  });

  test("任务不存在时给的是 state 错误，不是空对象", async () => {
    const res = await callOp({ kind: "task.get", params: { task_id: "T-9999" } });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe(2);
  });
});

describe("前端在调、服务端必须存在的 Op", () => {
  test("handoff.list 返回交接数组（详情页“交接”页签的数据源）", async () => {
    const list = await callOp<{ kind: "task.list"; params: { limit: number } }>({
      kind: "task.list",
      params: { limit: 1 },
    });
    const taskId = (list.data as unknown as Array<{ id: string }>)[0]!.id;

    const res = await callOp<Array<Record<string, unknown>>>({
      kind: "handoff.list",
      params: { task_id: taskId },
    });
    expect(res.ok).toBe(true);
    expect(Array.isArray(res.data)).toBe(true);
    // Handoffs 组件读的字段
    for (const h of res.data) {
      expect(typeof h.id).toBe("number");
      expect(typeof h.summary).toBe("string");
      expect(typeof h.from_session).toBe("string");
      expect(typeof h.created_at).toBe("number");
      expect(Array.isArray(h.blockers)).toBe(true);
      expect(Array.isArray(h.open_questions)).toBe(true);
      expect("consumed_by" in h).toBe(true);
    }
  });

  test("task.transition 能改状态（看板拖拽/菜单改状态走这条）", async () => {
    const created = await callOp<{ id: string }>({
      kind: "task.create",
      params: { title: "改状态的卡", priority: 2 },
    });
    const id = created.data.id;

    const ok = await callOp<{ status: string; unblocked: string[] }>({
      kind: "task.transition",
      params: { task_id: id, to: "blocked", reason: "等接口定稿" },
    });
    expect(ok.ok).toBe(true);
    expect(ok.data.status).toBe("blocked");
    expect(Array.isArray(ok.data.unblocked)).toBe(true);

    // 非法转移必须报 state（exit 2），而不是被放行
    const bad = await callOp({ kind: "task.transition", params: { task_id: id, to: "done" } });
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe(2);
  });

  test("未知 Op 仍然是明确报错，不会被当成成功", async () => {
    const res = await callOp({ kind: "task.definitely-not-real" } as unknown as Op);
    expect(res.ok).toBe(false);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("描述与检查项：写得进也要读得回（Web 概览区的两端）", () => {
  test("task.create 的参数名是 description，写进去后 task.get 用 body 返回", async () => {
    const created = await callOp<{ id: string }>({
      kind: "task.create",
      params: {
        title: "带描述的卡",
        description: "背景、约束、验收标准",
        checklist: ["写实现", "补测试"],
      },
    });
    expect(created.ok).toBe(true);

    const res = await callOp<Record<string, unknown>>({
      kind: "task.get",
      params: { task_id: created.data.id },
    });
    // 库里的列名是 body，对外的字段名是 description——两边都要钉住，
    // 否则前端就会像上次那样拿 body 去创建（静默丢数据）
    expect(res.data.body).toBe("背景、约束、验收标准");

    // 概览区要逐项渲染检查项，所以必须是带 text/done 的数组，不能只有计数
    const checklist = res.data.checklist as Array<{ text: string; done: boolean }>;
    expect(Array.isArray(checklist)).toBe(true);
    expect(checklist.map((c) => c.text)).toEqual(["写实现", "补测试"]);
    expect(checklist.every((c) => c.done === false)).toBe(true);
  });

  test("参数名写成 body 不会报错，但也存不进去（这正是那次静默丢数据）", async () => {
    // 这条不是期望行为，而是把坑钉死：多余字段被忽略，调用方不会收到任何提示，
    // 所以前端那边必须有静态守卫（见下一个 describe）盯着参数名。
    const created = await callOp<{ id: string }>({
      kind: "task.create",
      params: { title: "参数名写错的卡", body: "这段描述会被丢掉" } as unknown as { title: string },
    });
    expect(created.ok).toBe(true);

    const res = await callOp<Record<string, unknown>>({
      kind: "task.get",
      params: { task_id: created.data.id },
    });
    expect(res.data.body ?? null).toBeNull();
  });

  test("task.get 返回依赖列表（概览区的“关联任务”）", async () => {
    const upstream = await callOp<{ id: string }>({ kind: "task.create", params: { title: "上游" } });
    const downstream = await callOp<{ id: string }>({ kind: "task.create", params: { title: "下游" } });
    const added = await callOp<{ ok: boolean }>({
      kind: "task.dep.add",
      params: { task_id: downstream.data.id, depends_on: upstream.data.id },
    });
    expect(added.ok).toBe(true);

    const res = await callOp<Record<string, unknown>>({
      kind: "task.get",
      params: { task_id: downstream.data.id },
    });
    // 形状陷阱：dependencies 是 TaskDep 对象数组（前端要抽 dependsOnId），
    // 而 unfinished_dependencies 已经是 id 数组。曾按“都是字符串”过滤，一个依赖都留不下。
    const deps = res.data.dependencies as Array<{ taskId: string; dependsOnId: string }>;
    expect(Array.isArray(deps)).toBe(true);
    expect(deps.map((d) => d.dependsOnId)).toEqual([upstream.data.id]);
    expect(res.data.unfinished_dependencies).toEqual([upstream.data.id]);

    // dependency_details 是三个接入面（Web 概览 / CLI show / 未来其它客户端）共用的那份：
    // 带标题与完成状态，省得各自去猜 TaskDep 的字段名（CLI 就猜错过，输出过 undefined）。
    const details = res.data.dependency_details as Array<{
      id: string;
      title: string;
      status: string | null;
      done: boolean;
    }>;
    expect(details).toEqual([{ id: upstream.data.id, title: "上游", status: "todo", done: false }]);
  });

  test("上游完成后 dependency_details 的 done 翻成 true", async () => {
    const list = await callOp<Array<{ id: string; title: string }>>({ kind: "task.list", params: {} });
    const upstream = list.data.find((t) => t.title === "上游")!;
    const downstream = list.data.find((t) => t.title === "下游")!;
    await callOp({ kind: "task.transition", params: { task_id: upstream.id, to: "done", force: true } });

    const res = await callOp<Record<string, unknown>>({
      kind: "task.get",
      params: { task_id: downstream.id },
    });
    expect(res.data.unfinished_dependencies).toEqual([]);
    const details = res.data.dependency_details as Array<{ id: string; done: boolean }>;
    expect(details.map((d) => d.done)).toEqual([true]);
  });
});

describe("前端源码不得再拆 { task } 包装（本次 bug 的静态守卫）", () => {
  /** web/src 下的所有源码（前端不在根 tsc 编译范围，只能静态扫） */
  function readWebSources(): Array<[string, string]> {
    const dir = join(ROOT, "web", "src");
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && /\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts"))
      .map((e) => [join(e.parentPath, e.name), readFileSync(join(e.parentPath, e.name), "utf8")] as [string, string]);
  }

  test("web 源码里没有 data.task 取值", () => {
    for (const [file, src] of readWebSources()) {
      // 曾经的写法：const task = data.task → 运行时 undefined → 读 plan_id 崩
      expect(`${file}: ${/data\s*\.\s*task\b/.test(src)}`).toContain("false");
    }
  });

  test("web 调用的每个 Op 都在服务端 Op 联合类型里有实现", () => {
    const opsSrc = readFileSync(join(ROOT, "src", "core", "ops.ts"), "utf8");

    // Op 名都是 `领域.动作`，因此只取带点的字面量
    // （HandoffItem 里的 kind: "voluntary" 这类枚举值不带点，会被自然排除）
    const kinds = new Set<string>();
    for (const [file, src] of readWebSources()) {
      for (const m of src.matchAll(/kind:\s*"([a-z]+\.[a-z.]+)"/g)) kinds.add(m[1]!);
    }
    expect(kinds.size).toBeGreaterThan(0);

    // 未实现的 Op 会让整段交互静默失效（前端 .catch 吞掉），所以这里逐个钉住
    const missing = [...kinds].filter((k) => !opsSrc.includes(`case "${k}":`));
    expect(missing).toEqual([]);
  });

  test("task.create 传的是 description，不是 body（写错会被服务端静默忽略）", () => {
    const sources = readWebSources();
    const opsSrc = readFileSync(join(ROOT, "src", "core", "ops.ts"), "utf8");
    // 契约字段名以服务端 CreateTaskParams 为准，改契约时这条会一起提醒改前端
    expect(opsSrc).toContain("description?: string | null");

    // 取每个 `kind: "task.create"` 之后紧跟的那段 params 字面量
    const blocks: string[] = [];
    for (const [, src] of sources) {
      for (const m of src.matchAll(/kind:\s*"task\.create"/g)) {
        blocks.push(src.slice(m.index!, m.index! + 600));
      }
    }
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block).toContain("description:");
      // params 里出现 body: 只会让描述丢失，且没有任何报错
      expect(/\bbody:/.test(block)).toBe(false);
    }
  });

  test("界面不得直接渲染后端的 next_actions（那是给 agent 看的中文串）", () => {
    // 曾经的写法：`context.next_actions.map(...)` → 英文界面的建议区漏出中文。
    // 现在必须走 localizedNextActions（web/src/lib/next-actions.ts）按代号选词典。
    //
    // 只扫组件层：lib/api.ts 作为传输层读 `env.next_actions` 解析整个包络是应该的，
    // 它不渲染任何东西。禁令针对的是「把中文串画到界面上」。
    const offenders: string[] = [];
    for (const [file, src] of readWebSources()) {
      if (!/components[\\/]/.test(file)) continue;
      if (src.includes("next-actions")) continue; // 映射表自身不算
      if (/\.next_actions\b/.test(src)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  test("改选 project 必须落盘（下拉框不能直接 onValueChange={setProject}）", () => {
    // 曾经的写法：<Select onValueChange={setProject}>，只改内存里的 state。
    // 页面里看一切正常，刷新一下就弹回上一个 project——"记住最后选择"完全没生效，
    // 而且没有任何报错。改选必须走 selectProject（state + localStorage 双写）。
    const src = readFileSync(join(ROOT, "web", "src", "components", "board.tsx"), "utf8");
    expect(src).not.toMatch(/onValueChange=\{setProject\}/);
    expect(src).toMatch(/onValueChange=\{selectProject\}/);
  });

  test("每个 setProject 调用点都配一次落盘（少一次就等于没记住）", () => {
    // 不变量：改内存里的 project 有几处，就得有几处写/清 localStorage。
    // 正则只认 `setProject(`，不会误伤 `setProjects(`（列表）和 `setProjectState`。
    const src = readFileSync(join(ROOT, "web", "src", "components", "board.tsx"), "utf8");
    const count = (re: RegExp) => (src.match(re) ?? []).length;
    expect(count(/\bsetProject\(/g)).toBe(
      count(/\bsetLastProject\(/g) + count(/\bclearLastProject\(/g),
    );
    expect(count(/\bsetProject\(/g)).toBeGreaterThan(0);
  });
});
