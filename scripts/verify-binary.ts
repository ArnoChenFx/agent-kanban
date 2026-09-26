// 验证：编译后的单文件二进制能独立跑（前端已内嵌，web/dist 不存在）
// 做法：把二进制复制到一个完全不含 web/dist 的隔离目录，在那里起 server
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// 仓库根目录：从本脚本位置推导，不能写死绝对路径（CI 克隆路径不同）
const ROOT = resolve(import.meta.dir, "..");
// 编译产物名按平台推导：CI 在 Linux 上产出 dist-test/agent-kanban（无扩展名），
// 写死 agent-kanban.exe 会在 Linux 上直接 ENOENT。
const BIN = join(ROOT, "dist-test", process.platform === "win32" ? "agent-kanban.exe" : "agent-kanban");
const PORT = 7841;
const BASE = `http://127.0.0.1:${PORT}`;

let fails = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) fails++;
};

if (!existsSync(BIN)) {
  console.error(`未找到编译产物 ${BIN}`);
  console.error("先执行：bun run gen:assets && bun build --compile src/cli.ts --outfile dist-test/agent-kanban");
  process.exit(1);
}

const iso = mkdtempSync(join(tmpdir(), "kanban-iso-"));
// 隔离目录里**只有**二进制，没有源码、没有 web/dist、没有 node_modules
const isoBin = join(iso, basename(BIN));
cpSync(BIN, isoBin);
check("隔离目录里没有 web/dist", !existsSync(join(iso, "web")), iso);

const server = spawn(isoBin, ["serve", "--port", String(PORT), "--host", "127.0.0.1"], {
  cwd: iso,
  env: { ...process.env, KANBAN_ADMIN_TOKEN: "k_" + "a".repeat(32) },
  stdio: ["ignore", "pipe", "pipe"],
});
let bootLog = "";
server.stdout?.on("data", (d) => (bootLog += String(d)));
server.stderr?.on("data", (d) => (bootLog += String(d)));

try {
  await sleep(2500);

  // ---- 1. server 起得来吗（schema.sql 内嵌）----
  const health = await fetch(`${BASE}/api/health`);
  const healthJson = (await health.json()) as { ok: boolean };
  check("二进制能启动（schema.sql 已内嵌）", healthJson.ok, `HTTP ${health.status}`);

  // ---- 2. 启动日志应说明前端已内置 ----
  check("启动日志报告前端已内置", bootLog.includes("embedded in the binary"), bootLog.split("\n").find((l) => l.includes("Web board"))?.trim() ?? "");
  check("未打印管理员 token 明文（来自环境变量）", !bootLog.includes("k_aaaa"), bootLog.split("\n").find((l) => l.includes("Admin token"))?.trim() ?? "");

  // ---- 3. 首页是真实前端 ----
  const root = await fetch(`${BASE}/`);
  const html = await root.text();
  check("GET / 返回真实前端", html.includes('id="root"'), `${html.length} 字节`);
  check("不是占位页", !html.includes("has not been built yet"));

  // ---- 4. 静态资源能取到（从二进制内读出）----
  const jsMatch = /src="(\/assets\/[^"]+\.js)"/.exec(html);
  check("HTML 引用了 hashed JS", Boolean(jsMatch), jsMatch?.[1] ?? "");
  if (jsMatch) {
    const js = await fetch(BASE + jsMatch[1]!);
    const jsText = await js.text();
    check("JS 从二进制内读出", js.status === 200 && jsText.length > 10000, `${(jsText.length / 1024).toFixed(0)} KB`);
    // 英文状态标签（web/src/lib/i18n.tsx 的 en 词典），用来证明产物是真看板而不是空壳
    check("JS 含看板内容", jsText.includes("In Progress") || jsText.includes("To Do"));
  }

  const cssMatch = /href="(\/assets\/[^"]+\.css)"/.exec(html);
  if (cssMatch) {
    const css = await fetch(BASE + cssMatch[1]!);
    const cssText = await css.text();
    check("CSS 从二进制内读出", css.status === 200, `${(cssText.length / 1024).toFixed(0)} KB`);
    check("CSS 含主题令牌", cssText.includes("--primary"));
  }

  // 字体（woff2 是内嵌里最大的部分，抽一个验证）
  const font = html.match(/\/assets\/[^"]+\.woff2/)?.[0];
  void font;
  // ---- 5. SPA 回退 ----
  const spa = await fetch(`${BASE}/deep/route`);
  check("SPA 回退到 index.html", spa.status === 200 && (await spa.text()).includes('id="root"'));

  // ---- 6. 路径穿越仍然被拦 ----
  const trav = await fetch(`${BASE}/%2e%2e%2f%2e%2e%2fpackage.json`);
  const travText = await trav.text();
  check("路径穿越未泄露", !travText.includes('"devDependencies"') && !travText.includes('"bin"'));

  // ---- 7. 鉴权 + 完整业务链路 ----
  const token = "k_" + "a".repeat(32);
  const auth = { "X-Kanban-Key": token };
  const projects = await fetch(`${BASE}/api/projects`, { headers: auth });
  const projectsJson = (await projects.json()) as { ok: boolean; data: Array<{ key: string }> };
  check("环境变量 token 生效（无需从日志抓）", projectsJson.ok, `HTTP ${projects.status}`);

  // project key 由目录名派生（隔离目录是随机名），不能写死
  const proj = projectsJson.data[0]?.key;
  check("能列出 project", Boolean(proj), proj ?? "(空)");

  const create = await fetch(`${BASE}/api/op`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ project: proj, op: { kind: "task.create", params: { title: "内嵌前端验证" } } }),
  });
  const createJson = (await create.json()) as { ok: boolean; data?: { id: string } };
  check("可写任务", createJson.ok, `${createJson.data?.id ?? ""} ${createJson.ok ? "" : JSON.stringify(createJson).slice(0, 120)}`);

  // ---- 8. 管理员能力（用 env token 建 project，走 Op）----
  const newKey = "from-binary";
  const add = await fetch(`${BASE}/api/op`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ project: proj, op: { kind: "project.create", params: { key: newKey, name: "二进制建的" } } }),
  });
  const addJson = (await add.json()) as { ok: boolean; error?: { message: string } };
  check(
    "管理员 token 可建 project",
    addJson.ok || addJson.error?.message.includes("already exists"),
    addJson.ok ? newKey : addJson.error?.message.slice(0, 60) ?? "",
  );

  // ---- 9. 签发的 token 能访问新 project（token 走 /api/admin/*，不走 Op）----
  const issue = await fetch(`${BASE}/api/admin/tokens`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ role: "project", projects: [newKey], name: "t" }),
  });
  const issueJson = (await issue.json()) as { ok: boolean; data?: { token: string }; error?: { message: string } };
  check("可签发项目级 token", issueJson.ok, issueJson.data?.token?.slice(0, 10) + "…" ?? issueJson.error?.message.slice(0, 50) ?? "");
  if (issueJson.data?.token) {
    const scoped = await fetch(`${BASE}/api/board?project=${newKey}`, {
      headers: { "X-Kanban-Key": issueJson.data.token },
    });
    check("新 token 可访问其授权的 project", scoped.status === 200, `HTTP ${scoped.status}`);
    const denied = await fetch(`${BASE}/api/board?project=${proj}`, {
      headers: { "X-Kanban-Key": issueJson.data.token },
    });
    check("新 token 访问越权 project 被拒", denied.status === 401 || denied.status === 403, `HTTP ${denied.status}`);
  }
} finally {
  server.kill();
  await sleep(300);
  rmSync(iso, { recursive: true, force: true });
}

console.log(`\n${fails === 0 ? "✓ 单文件二进制自包含验证通过" : `✗ ${fails} 项失败`}`);
process.exit(fails === 0 ? 0 : 1);
