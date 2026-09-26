/**
 * CLI **文本输出**的回归测试（`task show` / `task dep list`）。
 *
 * 为什么单独一个文件：前面那些测试要么走 Op（证明的是数据对），
 * 要么验的是 core 的纯函数。"命令行把字段读错"这类 bug 只有真的把命令跑起来、
 * 看它打印了什么才暴露得出来。三条已发生的事故：
 *   1. 依赖打印成 `· undefined`——CLI 读 `depends_on_id`，而 TaskDep 的字段是 `dependsOnId`
 *   2. `task show` 末尾的"可用操作"永远是空的——`nextActions` 在 data 之外，代码却读 `task.next_actions`
 *   3. 描述必须加 `--body` 才显示（与 Web 不一致，已改成默认显示）
 *
 * 用法：真的 spawn `bun run src/cli.ts`，不是 mock——渲染 bug 就在这一层。
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
let dir: string;
let dbPath: string;

interface RunResult {
  code: number;
  out: string;
}

/** 跑一次真实 CLI。走 --json 时用 json 通道拿数据，走人读格式时看 stdout。 */
async function cli(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  const proc = Bun.spawn(["bun", "run", join(ROOT, "src", "cli.ts"), ...args], {
    cwd: ROOT,
    env: { ...process.env, KANBAN_DB: dbPath, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { code, out: out + (code !== 0 ? err : "") };
}

/**
 * 去掉 ANSI 颜色码。
 *
 * 必要：style.* 不管 stdout 是不是 TTY 都上色，于是 id 与标题之间夹着 `\x1b[0m`，
 * 直接用正则匹配 "T-0001 上游" 会因为中间那串转义序列而失败。
 */
function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kanban-cli-out-"));
  dbPath = join(dir, "cli.db");
  await cli(["init", "--db", dbPath, "--name", "cli-out"]);
  // 造数据：上游（先建）→ 下游（带描述 + 检查项 + 依赖上游）
  await cli(["task", "add", "上游", "--db", dbPath]);
  await cli(["task", "add", "下游卡", "-d", "背景第一行\n第二行", "--check", "步骤1,步骤2", "--db", dbPath]);
  await cli(["task", "dep", "add", "T-0002", "T-0001", "--db", dbPath]);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("task show 的文本输出", () => {
  let show = "";

  beforeAll(async () => {
    show = strip((await cli(["task", "show", "T-0002", "--db", dbPath])).out);
  });

  test("命令成功", () => {
    expect(show).toContain("下游卡");
  });

  test("描述默认显示（不必再加 --body）", () => {
    expect(show).toContain("描述");
    expect(show).toContain("背景第一行");
  });

  test("描述保留换行", () => {
    // 逐行缩进打印：两行都在，且不是挤成一行
    const lines = show.split("\n").filter((l) => l.includes("背景第一行") || l.includes("第二行"));
    expect(lines.length).toBe(2);
  });

  test("检查项逐项列出", () => {
    expect(show).toContain("检查项");
    expect(show).toContain("步骤1");
    expect(show).toContain("步骤2");
  });

  test("依赖显示 id + 标题 + 状态", () => {
    expect(show).toContain("依赖");
    expect(show).toMatch(/T-0001\s+上游/);
    expect(show).toContain("未完成");
  });

  test("末尾的「可用操作」不是空的", () => {
    const line = show.split("\n").find((l) => l.includes("可用操作")) ?? "";
    expect(line).toContain("task claim T-0002");
  });

  // 一次兜住整类 bug：字段名读错时打印出来的是 undefined
  test("输出里没有 undefined", () => {
    expect(show).not.toContain("undefined");
  });

  test("加 --body 仍然被接受（兼容参数，不报 usage）", async () => {
    const r = await cli(["task", "show", "T-0002", "--body", "--db", dbPath]);
    expect(r.code).toBe(0);
    expect(strip(r.out)).toContain("描述");
  });

  test("时间线里的 dep_added 不是原始事件名", async () => {
    const r = await cli(["task", "show", "T-0002", "--timeline", "--db", dbPath]);
    // 曾经 CLI 侧有一份 describeEvent 的副本，漏了 dep_added，直接打出 "dep_added"
    expect(strip(r.out)).toContain("新增依赖 T-0001");
  });
});

describe("task dep list 的输出", () => {
  test("打印真实 id，不是 undefined", async () => {
    const r = await cli(["task", "dep", "list", "T-0002", "--db", dbPath]);
    expect(r.code).toBe(0);
    expect(strip(r.out)).toContain("T-0001");
    expect(r.out).not.toContain("undefined");
  });
});

describe("task show --json", () => {
  test("带 next_actions（与其它命令一致）", async () => {
    const r = await cli(["task", "show", "T-0002", "--json", "--db", dbPath]);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.out.trim()) as {
      body: string;
      checklist: Array<{ text: string }>;
      dependency_details: Array<{ id: string; title: string; done: boolean }>;
      next_actions: string[];
    };
    expect(data.body).toContain("背景第一行");
    expect(data.checklist.map((c) => c.text)).toEqual(["步骤1", "步骤2"]);
    expect(data.dependency_details[0]).toMatchObject({ id: "T-0001", title: "上游", done: false });
    // 早先这里读 task.next_actions（恒不存在）→ --json 也没有建议
    expect(data.next_actions.length).toBeGreaterThan(0);
  });
});
