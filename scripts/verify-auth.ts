// 配置 + token 权限端到端验证：真实 server 进程 + 真实 CLI
// 用法：bun run scripts/verify-auth.ts
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// 仓库根目录：从本脚本位置推导，不能写死绝对路径（CI 克隆路径不同）
const ROOT = resolve(import.meta.dir, "..");
/** CLI 入口的绝对路径：客户端在临时目录，不能用相对路径 */
const CLI = join(ROOT, "src", "cli.ts");
const dir = mkdtempSync(join(tmpdir(), "kanban-auth-"));
const serverDb = join(dir, "server", "kanban.db");
const clientDir = join(dir, "client");
mkdirSync(join(dir, "server"), { recursive: true });
mkdirSync(clientDir, { recursive: true });

function run(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  return new Promise<{ code: number; out: string; err: string }>((resolve) => {
    const p = spawn("bun", ["run", CLI, ...args], {
      cwd: opts.cwd ?? ROOT,
      env: { ...process.env, ...opts.env },
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => resolve({ code: code ?? -1, out, err }));
  });
}

const step = (n: number, text: string) =>
  console.log(`\n${"=".repeat(62)}\n${n}. ${text}\n${"=".repeat(62)}`);

let serverProc: ChildProcess | null = null;
let failures = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label} ${detail}`);
  }
}

try {
  // ---- 1. server 端：初始化库并起 server（自动生成 admin token）----
  step(1, "初始化 server 库并启动（应自动生成管理员 token）");
  await run(["init", "--db", serverDb, "--name", "server"]);
  serverProc = spawn("bun", ["run", CLI, "serve", "--db", serverDb, "--port", "7802"], {
    cwd: ROOT,
    stdio: "pipe",
  });
  let serverLog = "";
  serverProc.stdout?.on("data", (d) => (serverLog += d.toString()));
  serverProc.stderr?.on("data", (d) => (serverLog += d.toString()));
  await sleep(2500);

  const keyMatch = /k_[0-9a-f]{32}/.exec(serverLog);
  check("server 启动并生成管理员 token", Boolean(keyMatch));
  const adminToken = keyMatch?.[0] ?? "";
  console.log(`  管理员 token: ${adminToken.slice(0, 10)}…`);

  // 管理员 token 应已写入 config.toml
  const configPath = join(dir, "server", ".kanban", "config.toml");
  const health = await fetch("http://127.0.0.1:7802/api/health").then((r) => r.json());
  check("健康检查可用", (health as { ok: boolean }).ok === true);

  // ---- 2. 客户端：写 config.toml 指向远程 server ----
  step(2, "客户端配置：只写 config.toml，之后不传任何参数");
  const initCfg = await run(
    ["config", "init", "--server", "http://127.0.0.1:7802", "--project", "demo", "--key", adminToken],
    { cwd: clientDir },
  );
  check("config init 成功", initCfg.code === 0, initCfg.err);
  const cfgText = await Bun.file(join(clientDir, ".kanban", "config.toml")).text();
  check("config.toml 已生成", cfgText.includes("[server]") && cfgText.includes("demo"));
  console.log("  配置文件片段：");
  console.log(cfgText.split("\n").filter((l) => !l.startsWith("#") || l.includes("⚠")).map((l) => "    " + l).join("\n"));

  // ---- 3. 无参数调用：应走远程（先建好 project，否则会报 project 不存在）----
  step(3, "管理员建 project（远程）");
  const addProj0 = await run(["admin", "project", "add", "demo", "--name", "演示项目"], { cwd: clientDir });
  check("admin project add 成功", addProj0.code === 0, addProj0.err);

  step(4, "无参数调用 task list（应自动走远程 server，无需任何参数）");
  const list = await run(["task", "list", "--json"], { cwd: clientDir });
  check("无参数 task list 成功（退出码 0）", list.code === 0, list.err);
  const remoteTasks = JSON.parse(list.out || "[]") as Array<Record<string, unknown>>;
  check("返回空列表（项目刚建好）", Array.isArray(remoteTasks) && remoteTasks.length === 0);

  // 顺带验证写入也能走远程
  const addTask = await run(["task", "add", "远程创建的任务"], { cwd: clientDir });
  check("无参数 task add 成功", addTask.code === 0, addTask.err);

  // ---- 5. 签发项目级 token ----
  step(5, "签发项目级 token");
  const issued = await run(
    ["admin", "token", "create", "--project", "demo", "--name", "团队 token"],
    { cwd: clientDir },
  );
  check("admin token create 成功", issued.code === 0, issued.err);
  const projectToken = /k_[0-9a-f]{32}/.exec(issued.out)?.[0] ?? "";
  check("拿到项目级 token 明文", Boolean(projectToken));
  // 库里不存明文，admin 的吊销/grant 靠**引用**（t_…）寻址，所以要把引用也抽出来。
  // （曾经这里直接拿明文当 tokenId —— 那只在「id 就是明文」的老模型下成立。）
  const projectTokenRef = /t_[0-9a-f]{32}/.exec(issued.out)?.[0] ?? "";
  check("拿到项目级 token 引用", Boolean(projectTokenRef), issued.out.slice(0, 200));

  // ---- 6. 多 project token ----
  step(6, "一个 token 授权多个 project");
  await run(["admin", "project", "add", "web"], { cwd: clientDir });
  const multi = await run(
    ["admin", "token", "create", "--project", "demo", "--project", "web", "--name", "双项目"],
    { cwd: clientDir },
  );
  const multiToken = /k_[0-9a-f]{32}/.exec(multi.out)?.[0] ?? "";
  const multiTokenRef = /t_[0-9a-f]{32}/.exec(multi.out)?.[0] ?? "";
  check("签发多项目 token 成功", Boolean(multiToken));
  check("拿到多项目 token 引用", Boolean(multiTokenRef), multi.out.slice(0, 200));

  // 验证它能访问 web
  const webList = await run(["task", "list", "--json"], {
    cwd: clientDir,
    env: { KANBAN_PROJECT: "web", KANBAN_KEY: multiToken },
  });
  check("多项目 token 可访问第二个 project", webList.code === 0, webList.err);

  // ---- 7. 权限隔离 ----
  step(7, "权限隔离：demo 的 token 不能访问 web");
  await run(["config", "set", "server.token", projectToken], { cwd: clientDir });
  const denied = await run(["task", "list"], {
    cwd: clientDir,
    env: { KANBAN_PROJECT: "web" },
  });
  check("越权访问被拒（退出码 7）", denied.code === 7, `实际 ${denied.code}`);
  check("错误信息提示找管理员加权限", denied.err.includes("admin token grant"), denied.err.slice(0, 120));

  // ---- 8. admin 才能管理 ----
  step(8, "项目级 token 访问 admin 接口 → 403");
  const adminDenied = await run(["admin", "project", "list"], { cwd: clientDir });
  check("项目级 token 不能管理（退出码 7 或 403）", adminDenied.code === 7 || adminDenied.code === 3, `实际 ${adminDenied.code}`);

  // ---- 9. 吊销 ----
  step(9, "吊销 token 后立即失效");
  const revoke = await run(["admin", "token", "revoke", projectTokenRef], {
    cwd: clientDir,
    env: { KANBAN_KEY: adminToken, KANBAN_PROJECT: "demo" },
  });
  check("吊销成功", revoke.code === 0, revoke.err);
  const afterRevoke = await run(["task", "list"], { cwd: clientDir });
  check("吊销后请求被拒（退出码 7）", afterRevoke.code === 7, `实际 ${afterRevoke.code}`);

  // ---- 10. grant 加权限 ----
  step(10, "grant 给已有 token 增加 project 授权");
  const grant = await run(["admin", "token", "grant", multiTokenRef, "--project", "demo"], {
    cwd: clientDir,
    env: { KANBAN_KEY: adminToken, KANBAN_PROJECT: "demo" },
  });
  check("grant 成功", grant.code === 0, grant.err);

  // ---- 11. config show ----
  step(11, "config show：显示生效配置与来源");
  const show = await run(["config", "show"], { cwd: clientDir });
  console.log(show.out.split("\n").map((l) => "  " + l).join("\n"));
  check("config show 显示远程模式", show.out.includes("remote"));

  // ---- 12. 管理页面 ----
  step(12, "管理页面 /admin");
  const adminPage = await fetch("http://127.0.0.1:7802/admin");
  const pageHtml = await adminPage.text();
  check("/admin 返回 HTML", adminPage.status === 200 && pageHtml.includes("agent-kanban"));
  check("页面含 token 登录框", pageHtml.includes("tokenInput"));

  // ---- 13. config.toml 确实存了 admin_token ----
  step(13, "server 的 config.toml 存有管理员 token");
  // config.toml 与 db 同级（在 .kanban/ 或 db 旁）
  const candidates = [
    join(dir, "server", ".kanban", "config.toml"),
    join(dir, "server", "config.toml"),
  ];
  let serverCfg = "";
  for (const c of candidates) {
    const text = await Bun.file(c).text().catch(() => "");
    if (text) { serverCfg = text; break; }
  }
  check("config.toml 含 admin_token", serverCfg.includes("admin_token"), serverCfg.slice(0, 200));
} finally {
  serverProc?.kill();
  await sleep(300);
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${"=".repeat(62)}`);
console.log(failures === 0 ? "✓ 配置与权限模型端到端验证全部通过" : `✗ ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
