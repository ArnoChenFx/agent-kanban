// 看板视觉快照：用无头浏览器打开真实页面并截图
// 用法：bun run scripts/snapshot-web.ts [输出目录]
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = "E:/Project/agent-kanban";
const outDir = process.argv[2] ?? join(ROOT, "docs", "note", "images");
const dir = mkdtempSync(join(tmpdir(), "kanban-shot-"));
const serverDb = join(dir, "server.db");
const PORT = 7817;
const BASE = `http://127.0.0.1:${PORT}`;

function run(args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number; out: string; err: string }>((resolve) => {
    const p = spawn("bun", ["run", "src/cli.ts", ...args], { cwd: ROOT, env: { ...process.env, ...env } });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (c) => resolve({ code: c ?? -1, out, err }));
  });
}

mkdirSync(outDir, { recursive: true });

// ---- 准备：建 project + token（每步都检查返回码，否则后面截图白等）----
const init = await run(["init", "--db", serverDb, "--name", "kanban-demo"]);
if (init.code !== 0) {
  console.error("init 失败:", init.err);
  process.exit(1);
}
const added = await run(["admin", "project", "add", "agent-kanban", "--name", "agent-kanban", "--db", serverDb]);
if (added.code !== 0) {
  console.error("project add 失败:", added.err);
  process.exit(1);
}
const issue = await run(["admin", "token", "create", "--project", "agent-kanban", "--name", "shot", "--db", serverDb]);
if (issue.code !== 0) {
  console.error("token create 失败:", issue.err);
  process.exit(1);
}
void issue;

const server = spawn(
  "bun",
  ["run", "src/cli.ts", "serve", "--db", serverDb, "--port", String(PORT), "--quiet"],
  { cwd: ROOT, stdio: "pipe" },
);
// 抓 server 首次启动时打印的管理员 token（比外部签发的 project token 更稳）
let adminToken = "";
server.stdout?.on("data", (d) => {
  const s = String(d);
  const m = /k_[0-9a-f]{32}/.exec(s);
  if (m) adminToken = m[0];
});
server.stderr?.on("data", (d) => {
  const s = String(d);
  if (!s.includes("token")) process.stderr.write(`[server] ${s}`);
});
await sleep(2500);
if (!adminToken) {
  console.error("未能从 server 启动输出中取得管理员 token");
  server.kill();
  process.exit(1);
}
console.log(`project: agent-kanban · admin token: ${adminToken.slice(0, 10)}…`);

const token = adminToken;
const env = { KANBAN_SERVER: BASE, KANBAN_PROJECT: "agent-kanban", KANBAN_KEY: token };
await run(["session", "start", "--agent", "pi-main", "--harness", "pi"], env);
const sessB = await run(["session", "start", "--agent", "claude-fix", "--harness", "claude-code"], env);
const sidB = /s-[0-9a-z]{6}/.exec(sessB.out)?.[0];

// 造一份贴近真实的看板
const setup: string[][] = [
  ["task", "add", "实现 handoff 崩溃自动合成", "-p", "0", "--check", "从事件流合成,保留未完成项,标注失联时长", "-d", "agent 崩了以后下一个怎么接上"],
  ["task", "add", "补 task_deps 的 project 隔离", "-p", "0", "--label", "schema"],
  ["task", "add", "写 rebuild 一致性测试", "--check", "逐字段相等,幂等性,删除不复活"],
  ["task", "add", "设计 Web 看板主题", "--label", "design", "-d", "自定义语义色令牌"],
  ["task", "add", "接 SSE 实时刷新", "--label", "web"],
  ["task", "add", "写 MCP Server", "--blocked-by", "T-0001"],
  ["task", "add", "MCP 工具薄封装 core"],
  ["task", "add", "看板截图脚本", "--priority", "3"],
];
for (const args of setup) await run(args, env);

await run(["task", "claim", "T-0001"], env);
await run(["task", "progress", "T-0001", "--pct", "60", "--check", "从事件流合成", "--note", "reapZombies 里已接上"], env);
if (sidB) {
  await run(["task", "claim", "T-0003"], { ...env, KANBAN_SESSION: sidB });
  await run(["task", "progress", "T-0003", "--pct", "30"], { ...env, KANBAN_SESSION: sidB });
}
await run(["task", "block", "T-0005", "--reason", "等 SSE 端点定稿，且要确认心跳间隔"], env);
await run(["task", "claim", "T-0002"], env);
await run(["task", "progress", "T-0002", "--pct", "100", "--note", "迁移已写好"], env);
await run(["task", "review", "T-0002"], env);
await run(["task", "done", "T-0001", "--note", "核心逻辑完成，剩下写测试"], env);
await run(["handoff", "--task", "T-0004", "--summary", "主题定稿：中性灰 + 白底，状态色保留彩色", "--next", "确认暗色灰阶是否够分层", "--open", "字体用衬线标题还是全无衬线？"], env);

// ---- 浏览器截图 ----
const chromePaths = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];
const { existsSync } = await import("node:fs");
const browser = chromePaths.find((p) => existsSync(p));
if (!browser) {
  console.error("未找到 Chrome/Edge，跳过截图");
  server.kill();
  rmSync(dir, { recursive: true, force: true });
  process.exit(2);
}

const profile = join(dir, "chrome-profile");
const wait = (ms: number) => sleep(ms);

/**
 * 截图辅助。
 *
 * 两个关键约束（都是踩过的坑）：
 * 1. **必须用 ?key= 直连看板**，不能用“先写 localStorage 的种子页再跳转”的方案：
 *    headless Chrome 里 localStorage 在跨页面导航后读不回来（写成功、读为 null）。
 *    同一页面内写+读则完全正常，所以分享链接方案反而更可靠。
 * 2. **必须带 static=1**：SSE 长连接会让 Chrome 的 virtual-time 永远等不到
 *    “网络空闲”，导致 --screenshot 永不触发。
 */
async function shot(name: string, query: string, budget = 6000) {
  await new Promise<void>((resolve) => {
    const p = spawn(
      browser!,
      [
        "--headless=new",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--disable-gpu",
        "--hide-scrollbars",
        "--force-device-scale-factor=1",
        "--window-size=1680,1050",
        `--screenshot=${join(outDir, `${name}.png`)}`,
        `--virtual-time-budget=${budget}`,
        `${BASE}/?${query}`,
      ],
      { stdio: "ignore" },
    );
    // 保险：headless 偶尔不退出，到点就杀
    const killer = setTimeout(() => p.kill(), 25_000);
    p.on("close", () => {
      clearTimeout(killer);
      resolve();
    });
  });
  console.log(`✓ ${name}.png`);
}

const creds = `key=${encodeURIComponent(token!)}&project=agent-kanban&static=1`;

// 截图前先确认凭据真的能用：不然截出来的会是登录页，还白等一轮截图
const probe = await fetch(`${BASE}/api/projects`, { headers: { "X-Kanban-Key": token } });
const probeJson = (await probe.json()) as { ok: boolean; data?: Array<{ key: string }> };
if (!probeJson.ok) {
  // 用 CLI 交叉验证：CLI 也失败 = token 真无效；CLI 成功 = fetch 侧的问题
  const cliCheck = await run(["--server", BASE, "--key", token, "project", "list"]);
  console.error(`✗ token 无效（HTTP ${probe.status}）`);
  console.error(`   CLI 交叉验证：exit=${cliCheck.code} ${cliCheck.out.trim() || cliCheck.err.trim()}`);
  console.error(`   token 长度 ${token.length}，前 12 字符 "${token.slice(0, 12)}"`);
  server.kill();
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}
console.log(`凭据自检通过，可见 project：${probeJson.data?.map((p) => p.key).join(", ")}`);

// 登录页：先截一张（无凭据）
await shot("01-login", "static=1", 3000);
await sleep(400);

// 亮色看板 / 暗色看板
await shot("02-board-light", creds);
await sleep(400);
await shot("03-board-dark", `${creds}&theme=dark`);

server.kill();
await sleep(200);
rmSync(dir, { recursive: true, force: true });
console.log(`\n截图已保存到 ${outDir}`);

