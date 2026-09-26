// 跨进程远程模式端到端验证：真实起一个 server 进程，用 CLI 连上去
//
// v3 改造：project 改由 `kanban admin project add` 创建，token 由
// `kanban admin token create` 签发（不再有 `project add` 自动发 key，
// 也不再用 remote.json 持久化连接——那些在 v3 已被 config.toml 取代）。
// 用法：bun run scripts/verify-remote.ts
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// 仓库根目录：从本脚本位置推导，不能写死绝对路径（CI 克隆路径不同）
const ROOT = resolve(import.meta.dir, "..");
const dir = mkdtempSync(join(tmpdir(), "kanban-remote-"));
const serverDb = join(dir, "server.db");
const workdir = join(dir, "client");

function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn("bun", ["run", "src/cli.ts", ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => resolve({ code: code ?? -1, out, err }));
  });
}

function step(n: string, text: string) {
  console.log(`\n${"=".repeat(60)}\n${n}. ${text}\n${"=".repeat(60)}`);
}

let serverProc: ReturnType<typeof spawn> | null = null;
let exitCode = 0;

try {
  // ---- 1. 建 project，拿管理员 token ----
  step(1, "初始化 server 库并创建 project（v3：admin 命令 + token 模型）");
  const init = await run(["init", "--db", serverDb, "--name", "remote-server"]);
  if (init.code !== 0) {
    console.error(init.err.trim());
    throw new Error("server 库初始化失败");
  }
  const add = await run(["admin", "project", "add", "demo-app", "--name", "演示项目", "--db", serverDb]);
  console.log(add.out.trim() || add.err.trim());

  // 用管理员 token 签发一个仅限 demo-app 的项目级 token
  const issue = await run([
    "admin", "token", "create", "--project", "demo-app", "--name", "ci-runner", "--db", serverDb,
  ]);
  console.log(issue.out.trim() || issue.err.trim());
  const keyMatch = /k_[0-9a-f]{32}/.exec(issue.out + issue.err);
  if (!keyMatch) {
    console.error("✗ 未能签发 project token");
    exitCode = 1;
  } else {
    const key = keyMatch[0];

    // ---- 2. 起 server ----
    step(2, "启动 kanban server（独立进程）");
    serverProc = spawn("bun", ["run", "src/cli.ts", "serve", "--db", serverDb, "--port", "7801", "--quiet"], {
      cwd: ROOT,
      stdio: "pipe",
    });
    serverProc.stderr?.on("data", (d) => process.stderr.write(`[server] ${d}`));
    await sleep(2500);

    const health = await fetch("http://127.0.0.1:7801/api/health").then((r) => r.json());
    console.log("健康检查:", JSON.stringify(health));

    // ---- 3. 远程 CLI 操作 ----
    step(3, "用远程 CLI 创建任务（--server + --project + --key）");
    const remoteEnv = { KANBAN_SERVER: "http://127.0.0.1:7801", KANBAN_PROJECT: "demo-app", KANBAN_KEY: key };
    const created = await run(["task", "add", "远程创建的任务", "-p", "0", "--check", "步骤A,步骤B"], remoteEnv);
    console.log(created.out.trim() || created.err.trim());
    if (created.code !== 0) exitCode = 1;

    // ---- 4. 验证 task list 走的是远程 ----
    step(4, "远程 task list（确认数据来自 server 而非本地）");
    const list = await run(["task", "list", "--json"], remoteEnv);
    const tasks = JSON.parse(list.out) as Array<Record<string, unknown>>;
    console.log(`远程看到 ${tasks.length} 个任务:`, tasks.map((t) => `${t.id}/${t.project}/${t.title}`).join(", "));
    if (tasks.length === 0 || tasks[0]?.project !== "demo-app") {
      console.error("✗ 远程数据不正确");
      exitCode = 1;
    }

    // ---- 5. 会话 + 认领 + 进度 ----
    step(5, "远程 session start → claim → progress");
    console.log((await run(["session", "start", "--agent", "remote-agent", "--harness", "pi"], remoteEnv)).out.trim());
    const sid = (await run(["session", "list", "--json"], remoteEnv));
    const sessions = JSON.parse(sid.out) as Array<Record<string, unknown>>;
    const sessionId = sessions[0]?.id as string;
    console.log("session_id =", sessionId);

    const taskId = tasks[0]?.id as string;
    console.log((await run(["task", "claim", taskId, "--session", sessionId], remoteEnv)).out.trim());
    console.log((await run(["task", "progress", taskId, "--pct", "60", "--check", "步骤A", "--note", "远程推进", "--session", sessionId], remoteEnv)).out.trim());

    // ---- 6. 冲突：另一个会话抢同一张卡（应退出码 3）----
    step(6, "另一个会话抢占（期望退出码 3 CONFLICT，错误信息带 holder）");
    const conflict = await run(["task", "claim", taskId, "--session", "s-other-session"], remoteEnv);
    console.log(`exit=${conflict.code}`);
    console.log((conflict.err || conflict.out).trim());
    if (conflict.code !== 3) {
      console.error("✗ 期望退出码 3，实际", conflict.code);
      exitCode = 1;
    }

    // ---- 7. 错误 key ----
    step(7, "错误 key（期望退出码 7 AUTH）");
    const badKey = await run(["task", "list"], { ...remoteEnv, KANBAN_KEY: "k_wrongkey" });
    console.log(`exit=${badKey.code}`);
    console.log((badKey.err || badKey.out).trim());
    if (badKey.code !== 7) {
      console.error("✗ 期望退出码 7，实际", badKey.code);
      exitCode = 1;
    }

    // ---- 8. 远程 board ----
    step(8, "远程 board 视图");
    const board = await run(["board"], remoteEnv);
    console.log(board.out.trim());

    // ---- 9. project 不存在 ----
    step(9, "访问不存在的 project（期望退出码 7，且不泄漏信息）");
    const noProject = await run(["task", "list"], { ...remoteEnv, KANBAN_PROJECT: "no-such-project" });
    console.log(`exit=${noProject.code}`);
    console.log((noProject.err || noProject.out).trim());
    if (noProject.code !== 7) {
      console.error("✗ 期望退出码 7，实际", noProject.code);
      exitCode = 1;
    }

    // ---- 10. config.toml 持久化连接（v3 取代 remote.json）----
    step(10, "写入 .kanban/config.toml 后无需再传环境变量");
    mkdirSync(join(workdir, ".kanban"), { recursive: true });
    writeFileSync(
      join(workdir, ".kanban", "config.toml"),
      [
        'mode = "remote"',
        "",
        "[server]",
        'url   = "http://127.0.0.1:7801"',
        `token = "${key}"`,
        "",
        "[project]",
        'key = "demo-app"',
        "",
      ].join("\n"),
      "utf8",
    );
    // 在 client 目录里跑（那里**没有** kanban.db，只有 config.toml）
    const viaConfig = await new Promise<{ code: number; out: string; err: string }>((resolve) => {
      // 用绝对路径：cwd 换成了 workdir
      const p = spawn("bun", ["run", join(ROOT, "src", "cli.ts"), "task", "list", "--json"], {
        cwd: workdir,
        env: { ...process.env, KANBAN_SERVER: "", KANBAN_PROJECT: "", KANBAN_KEY: "" },
      });
      let out = "";
      let err = "";
      p.stdout.on("data", (d) => (out += d.toString()));
      p.stderr.on("data", (d) => (err += d.toString()));
      p.on("close", (code) => resolve({ code: code ?? -1, out, err }));
    });
    const viaConfigTasks = viaConfig.code === 0 ? JSON.parse(viaConfig.out) as Array<Record<string, unknown>> : [];
    console.log(`仅靠 config.toml 读到 ${viaConfigTasks.length} 个任务（无本地数据库）`);
    if (viaConfigTasks.length === 0) {
      console.error("✗ config.toml 未生效");
      console.error("stdout:", viaConfig.out.trim().slice(0, 400));
      console.error("stderr:", viaConfig.err.trim().slice(0, 600));
      exitCode = 1;
    }
  }
} finally {
  if (serverProc) {
    serverProc.kill();
    await sleep(300);
  }
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${"=".repeat(60)}`);
console.log(exitCode === 0 ? "✓ 远程模式端到端验证全部通过" : "✗ 存在失败项");
process.exit(exitCode);
