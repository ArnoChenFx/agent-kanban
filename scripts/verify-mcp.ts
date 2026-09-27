/**
 * 端到端验证：真起一个 `agent-kanban mcp` 子进程，走 stdio JSON-RPC，
 * 跑一遍契约 §3.4 的恢复流程。
 *
 * 为什么不用 SDK 的 in-memory transport：它会绕开进程边界，
 * 而 stdio 通道最容易出的两类问题（stdout 被日志污染、启动时机）只有真进程能暴露。
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const CLI = join(ROOT, "src", "cli.ts");

let fails = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) fails++;
};

const dir = mkdtempSync(join(tmpdir(), "kanban-mcp-"));
const db = join(dir, "kanban.db");
const env = { ...process.env, KANBAN_DB: db, NO_COLOR: "1" };

/** 用 CLI 预置一张被崩溃丢下的卡，这样 MCP 接手流程才有东西可接 */
function cli(args: string[]): { code: number; out: string } {
  const r = Bun.spawnSync(["bun", "run", CLI, ...args], { env, cwd: dir });
  return { code: r.exitCode, out: new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr) };
}

console.log("=== 0. 预置数据（用 CLI，和真实使用顺序一致）===");
const init = cli(["init"]);
check("init 成功", init.code === 0, init.out.trim().split("\n")[0] ?? "");

const sidA = JSON.parse(cli(["--json", "session", "start", "--agent", "pi-main"]).out);
const taskId = JSON.parse(cli(["--json", "task", "add", "实现 MCP 工具", "-d", "契约 §3.4 流程"]).out);
check("建卡成功", typeof taskId.id === "string", taskId.id);

cli(["--session", sidA.id, "task", "claim", taskId.id]);
cli(["--session", sidA.id, "task", "progress", taskId.id, "--pct", "40", "--note", "先做了工具定义"]);
cli([
  "--session", sidA.id, "handoff", "--task", taskId.id,
  "--summary", "工具层写完，server 没接",
  "--next", "从 runMcpServer 接 transport 开始",
]);
check("预置完成：卡处于 doing + 有主动交接", true, taskId.id);

console.log("\n=== 1. 启动 MCP 子进程 ===");
const child = spawn("bun", ["run", CLI, "mcp"], { env, cwd: dir, stdio: ["pipe", "pipe", "pipe"] });

let stdoutBuf = "";
let badLines = 0;
let jsonLines = 0;
const pending = new Map<number, (v: unknown) => void>();
child.stdout.on("data", (chunk) => {
  stdoutBuf += String(chunk);
  let idx: number;
  while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
    const line = stdoutBuf.slice(0, idx).trim();
    stdoutBuf = stdoutBuf.slice(idx + 1);
    if (!line) continue;
    let msg: { id?: number };
    try {
      msg = JSON.parse(line);
      jsonLines++;
    } catch {
      badLines++;
      console.log(`✗ stdout 不是纯 JSON-RPC: ${line.slice(0, 60)}`);
      continue;
    }
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
  }
});
let stderrBuf = "";
child.stderr.on("data", (c) => (stderrBuf += String(c)));

let nextId = 1;
let rpcCount = 0;
function rpc(method: string, params: unknown): Promise<any> {
  const id = nextId++;
  rpcCount++;
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`${method} 超时`)), 15_000);
    pending.set(id, (v) => {
      clearTimeout(timer);
      res(v);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

async function callTool(name: string, args: Record<string, unknown>): Promise<any> {
  const r = await rpc("tools/call", { name, arguments: args });
  const text = r?.result?.content?.[0]?.text;
  if (typeof text !== "string") return r;
  try {
    return JSON.parse(text);
  } catch {
    // SDK 在分发前拒掉的请求（未知工具、参数不符 schema）会直接给一段
    // 协议层错误文本，而不是我们的包络。包成同样的形状，断言才能统一。
    return { ok: false, error: { code: -32601, name: "PROTOCOL", message: text } };
  }
}

async function main() {
  const initRes = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "verify", version: "1" },
  });
  check("initialize 握手成功", initRes?.result?.serverInfo?.name === "agent-kanban", initRes?.result?.serverInfo?.name);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const list = await rpc("tools/list", {});
  const tools = list?.result?.tools ?? [];
  // 工具数量写死是故意的：**加工具时这条会红**，提醒你同时更新 MCP 文档
  // （README / docs/plan/002 §3.2 列了工具清单）与下面的 CANCELLED 集合。
  // 曾经它写的是 20，而实际有 20 个；现在补了 9 个工作流必需的工具。
  check("tools/list 返回 29 个工具", tools.length === 29, `${tools.length} 个`);

  // ---- Op 覆盖率：每个 Op 要么有工具，要么在契约里被点名 ----
  // 只钉「29 个工具」不够：它管住了“有没有少写工具”，却管不住
  // “新增了一个 Op 卻没想好要不要做成工具”。而那种沉默的缺口，下一个读代码的人
  // 会当成“漏了”去补一个，恰好把「project.* 故意不给 agent」这类决定推翻。
  // 判据就是契约 §3.2.1 的那张表。
  const opKinds = (src: string): Set<string> =>
    new Set([...src.matchAll(/kind:\s*"([a-z]+\.[a-z_]+)"/g)].map((m) => m[1]!));
  const allOps = opKinds(await Bun.file(join(ROOT, "src", "core", "ops.ts")).text());
  const toolOps = opKinds(await Bun.file(join(ROOT, "src", "mcp", "tools.ts")).text());
  const contract = await Bun.file(join(ROOT, "docs", "plan", "002-接口契约.md")).text();
  // 只认 **§3.2.1 小节**里表格**第一列**的反引号项。两个限定都是被误报逼出来的：
  //  · 全文扫反引号 → 把 `http.ts`、`tasks.id`、`params.session_id` 当成 Op；
  //    全文扫表格 → 别的表（如 §7.1 的主键表）第一列也有 `tasks.id`。
  //  · 只取 `|` 后的第一项 → 写成「`session.list` / `session.heartbeat`」的行会丢掉后半。
  const section = contract.split("### 3.2.1")[1]?.split(/\n#{2,3} /)[0] ?? "";
  if (!section) {
    check("002 里有 §3.2.1「刻意不暴露的 Op」小节", false, "小节不见了");
  }
  const listed = new Set(
    [...section.matchAll(/^\|\s*([^|]+?)\s*\|/gm)]
      .map((m) => m[1]!)
      .flatMap((cell) => [...cell.matchAll(/`([a-z]+\.[a-z_]+)`/g)].map((m) => m[1]!)),
  );
  // 通配条目（`project.*`）表示“整个前缀都不暴露”
  const wildcards = [...section.matchAll(/`([a-z]+)\.\*`/g)].map((m) => m[1]!);
  const isListed = (op: string): boolean =>
    listed.has(op) || wildcards.some((w) => op.startsWith(w + "."));

  const uncovered = [...allOps].filter((op) => !toolOps.has(op) && !isListed(op)).sort();
  check(
    "没有 MCP 工具的 Op 都在 002 §3.2.1 里被点名",
    uncovered.length === 0,
    uncovered.length > 0 ? `未点名：${uncovered.join(", ")}` : `${allOps.size} 个 Op 全覆盖`,
  );
  // 反向：逐个列出的 Op 必须真的存在（改名后表格不能变成谎言）。
  // 通配条目不查——`project.*` 本身不是 Op 名。
  const phantom = [...listed].filter((op) => !allOps.has(op) && !toolOps.has(op)).sort();
  check("契约里点名的 Op 都真实存在", phantom.length === 0, phantom.join(", "));

  // 每个工具都必须有描述与 schema——没有描述的模型不会用
  const noDesc = tools.filter((t: { description?: string }) => !t.description);
  check("所有工具都有 description", noDesc.length === 0, noDesc.map((t: { name: string }) => t.name).join(","));
  const noSchema = tools.filter((t: { inputSchema?: unknown }) => !t.inputSchema);
  check("所有工具都有 inputSchema", noSchema.length === 0);

  console.log("\n=== 2. 契约 §3.4 的恢复流程 ===");
  // 1) session_start
  const s = await callTool("kanban_session_start", { agent_name: "pi-fix" });
  check("1. session_start 拿到 session_id", typeof s.data?.id === "string", s.data?.id);
  const sid = s.data.id;
  check("   包络含 next_actions", Array.isArray(s.next_actions) && s.next_actions.length > 0);

  // 2) bootstrap：应当看到别人留下的交接
  const boot = await callTool("kanban_bootstrap", { session_id: sid });
  check("2. bootstrap 成功", boot.ok === true);
  const bootText = JSON.stringify(boot.data);
  check("   看到了那张卡", bootText.includes(taskId.id), taskId.id);
  check("   看到了交接内容", bootText.includes("runMcpServer") || bootText.includes("工具层写完"));
  const pending = (boot.data?.pending_handoffs ?? []) as unknown[];
  check("   报出了交接待接手", pending.length > 0, `${pending.length} 条`);

  // 调试：确认交接真的被标记为 sid 消费了（这是 resume 能否免 force 的前提）
  const afterBoot = cli(["--json", "task", "show", taskId.id]);
  const taskRow = JSON.parse(afterBoot.out) as Record<string, unknown>;
  check("   调试：任务仍归原持有者", taskRow.assignee_session_id !== sid, String(taskRow.assignee_session_id));

  // 3) resume：接管（持有者已留下交接，且本会话刚消费过，无需 force）
  const res = await callTool("kanban_resume", { session_id: sid, task_id: taskId.id });
  check("3. resume 接管成功（无需 force）", res.ok === true, res.error?.message ?? "");
  check("   注入了交接全文", JSON.stringify(res.data ?? {}).includes("runMcpServer"));
  check("   进度保留 40%", JSON.stringify(res.data ?? {}).includes("40"));

  // 4) plan_save + plan_show + plan_diff
  const saved = await callTool("kanban_plan_save", {
    task_id: taskId.id,
    title: "拆成三步",
    markdown: "1. 工具层\n2. server 层\n3. 契约测试",
  });
  check("4. plan_save 返回 plan_id 与 version", typeof saved.data?.id === "string" && saved.data?.version === 1, saved.data?.id);

  const v2 = await callTool("kanban_plan_save", {
    task_id: taskId.id,
    title: "拆成三步（修订）",
    markdown: "1. 工具层\n2. server 层\n3. 契约测试\n4. 补远程模式测试",
  });
  check("   第二次 save 产生 v2", v2.data?.version === 2 && typeof v2.data?.supersedes_id === "string");

  const shown = await callTool("kanban_plan_show", { task_id: taskId.id });
  check("   plan_show 拿的是当前生效版本", shown.data?.version === 2, `v${shown.data?.version}`);
  check("   正文未截断时不含 truncated", shown.data?.truncated === undefined);

  const diff = await callTool("kanban_plan_diff", {
    from_plan_id: saved.data.id,
    to_plan_id: v2.data.id,
  });
  check("   plan_diff 检出标题变化", diff.data?.title_changed === true);
  check("   plan_diff 检出正文增行", diff.data?.added === 1, `+${diff.data?.added} -${diff.data?.removed}`);

  // 5) progress
  const prog = await callTool("kanban_task_progress", { session_id: sid, task_id: taskId.id, pct: 80, note: "跑通 stdio" });
  check("5. progress 成功", prog.ok === true, prog.error?.message ?? "");

  // 6) handoff
  const ho = await callTool("kanban_handoff", {
    session_id: sid,
    task_id: taskId.id,
    summary: "MCP 通了",
    next_step: "补 doctor 工具",
  });
  check("6. handoff 成功", ho.ok === true && ho.data?.id !== undefined, `handoff #${ho.data?.id}`);

  // 7) session_end
  const end = await callTool("kanban_session_end", { session_id: sid, summary: "收工" });
  check("7. session_end 成功", end.ok === true, ho.error?.message ?? "");

  console.log("\n=== 3. 错误路径（包络必须可读）===");
  const bad = await callTool("kanban_task_get", { task_id: "T-9999" });
  check("不存在的任务 → ok:false", bad.ok === false);
  check("   错误带 code/name/message", bad.error?.code === 2 && bad.error?.name === "STATE", JSON.stringify(bad.error).slice(0, 120));
  check("   isError 也置位", bad.ok === false);

  // 未知工具：由 SDK 在分发前就拦下（它只认注册过的工具），
  // 返回的是 MCP 协议层错误而不是我们的包络——这是正确行为，agent 照样能读懂。
  const unknown = await callTool("kanban_nope", {});
  check("未知工具被拒（SDK 层）", unknown.ok === false, `code=${unknown.error?.code}`);
  check(
    "   错误文本可读",
    /not found|unknown|MCP error|Tool/i.test(String(unknown.error?.message ?? "")),
    String(unknown.error?.message ?? "").slice(0, 80),
  );

  const badArg = await callTool("kanban_task_list", { session_id: sid, status: ["不存在的状态"] });
  check("非法 status 被拦下（不落到 SQL）", badArg.ok === false && badArg.error?.name === "USAGE", badArg.error?.message);

  const missingParam = await callTool("kanban_task_claim", { task_id: taskId.id });
  check("缺 session_id 被 SDK schema 拦下", missingParam.ok === false || /session_id/.test(JSON.stringify(missingParam)));

  console.log("\n=== 4. 与 CLI 的行为等价 ===");
  // 同一个 Op，CLI 与 MCP 的 data 应当一致
  const cliBoard = JSON.parse(cli(["--json", "board"]).out);
  const mcpBoard = await callTool("kanban_board", {});
  const cliCounts = JSON.stringify(cliBoard).match(/"(\w+)":\s*(\d+)/g)?.length ?? 0;
  check("board 工具可调用", mcpBoard.ok === true, `CLI 输出 ${cliCounts} 个字段`);
  check("两边都看到同一批卡", JSON.stringify(mcpBoard.data).includes(taskId.id));

  console.log("\n=== 5. 通道卫生 ===");
  check("stderr 有就绪提示", stderrBuf.includes("MCP server ready"), stderrBuf.split("\n")[0] ?? "(空)");
  // 真正的检查：stdout 上一行非 JSON 都不能有。日志写进 stdout 会让客户端解析失败，
  // 而且报错出现在客户端那边，极难定位。
  check("stdout 未被日志污染", badLines === 0, `${jsonLines} 行合法 JSON-RPC，${badLines} 行污染`);
  check("收到的响应数与请求数一致", jsonLines >= rpcCount, `${jsonLines} ≥ ${rpcCount}`);
}

main()
  .catch((e) => {
    console.error("失败：", e);
    fails++;
  })
  .finally(async () => {
    child.kill();
    await new Promise((r) => setTimeout(r, 200));
    console.log(`\n${fails === 0 ? "✓ MCP 端到端验证通过" : `✗ ${fails} 项失败`}`);
    rmSync(dir, { recursive: true, force: true });
    process.exit(fails === 0 ? 0 : 1);
  });
