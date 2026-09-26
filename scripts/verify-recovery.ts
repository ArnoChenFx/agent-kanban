// 崩溃恢复端到端验证（真实 CLI 进程）
// 流程：干活 → 主动交接 → 模拟崩溃（篡改心跳）→ 新会话 context → resume
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// 仓库根目录：从本脚本位置推导，不能写死绝对路径（CI 克隆路径不同）
const ROOT = resolve(import.meta.dir, "..");
const CLI = `${ROOT}/src/cli.ts`;

function run(args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number; out: string; err: string }>((resolve) => {
    const p = spawn("bun", ["run", CLI, ...args], {
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

const step = (n: string) => console.log(`\n${"=".repeat(64)}\n${n}\n${"=".repeat(64)}`);

// 清空重来
await run(["init", "--force", "--name", "agent-kanban"]);
const sess = await run(["session", "start", "--agent", "agent-a", "--harness", "pi"]);
const sidA = /s-[0-9a-z]{6}/.exec(sess.out)?.[0] ?? "";
console.log(`会话 A: ${sidA}`);

step("1. 会话 A 干活");
const addRes = await run(
  ["task", "add", "实现崩溃恢复", "--check", "租约续期,崩溃自动合成,resume 接管", "--priority", "0"],
  { KANBAN_SESSION: sidA },
);
console.log(addRes.out.trim() || addRes.err.trim());
// 任务号从输出里取，不硬编码（前面的手工验证可能已占用 T-0001）
const tid = /T-\d{4}/.exec(addRes.out)?.[0];
if (!tid) {
  console.error("无法解析任务号，退出");
  process.exit(1);
}
console.log(`任务号: ${tid}`);

for (const args of [
  ["task", "claim", tid],
  ["task", "progress", tid, "--pct", "60", "--check", "租约续期", "--note", "事务封装完成，20 个测试全绿"],
  ["handoff", "--task", tid, "--summary", "完成 WAL 事务层与退避重试", "--next", "实现崩溃自动合成 handoff", "--open", "租约默认时长要不要按任务类型区分？"],
]) {
  const r = await run(args, { KANBAN_SESSION: sidA });
  if (r.code !== 0) console.error(`✗ ${args.join(" ")}\n${r.err}`);
  else console.log(`✓ ${args.slice(0, 2).join(" ")}`);
}

step("2. 会话 A 写主动交接（见上）");

step("3. 模拟会话 A 崩溃（直接改库让心跳过期）");
{
  const dbPath = `${ROOT}/.kanban/kanban.db`;
  const { Database } = await import("bun:sqlite");
  const db = new Database(dbPath, { readwrite: true, create: false });
  const old = Date.now() - 30 * 60 * 1000;
  db.query("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(old, sidA);
  db.close();
  console.log(`已把会话 ${sidA} 的心跳改为 30 分钟前（模拟进程被 kill）`);
}

step("4. 会话 B 开工：kanban context");
const sessB = await run(["session", "start", "--agent", "agent-b", "--harness", "pi"]);
const sidB = /s-[0-9a-z]{6}/.exec(sessB.out)?.[0] ?? "";
console.log(`会话 B: ${sidB}\n`);
const ctx = await run(["context"], { KANBAN_SESSION: sidB });
console.log(ctx.out);

step("5. 会话 B 接管：kanban resume");
const res = await run(["resume", tid], { KANBAN_SESSION: sidB });
console.log(res.out);

step("6. 校验：进度保留 + 交接已消费");
const show = await run(["task", "show", tid, "--json"], { KANBAN_SESSION: sidB });
const task = JSON.parse(show.out) as Record<string, unknown>;
console.log(`进度: ${task.progress}%（应为 60）`);
console.log(`状态: ${task.status}（应为 doing）`);
console.log(`持有: ${task.assignee_session_id}（应为 ${sidB}）`);

const ctx2 = await run(["context", "--json"], { KANBAN_SESSION: sidB });
const c2 = JSON.parse(ctx2.out) as { pending_handoffs: unknown[]; my_tasks: unknown[] };
console.log(`\n待接手交接: ${c2.pending_handoffs.length} 条（消费后应为 0）`);

step("7. doctor 检查");
const doc = await run(["doctor"], { KANBAN_SESSION: sidB });
console.log(doc.out);

// 清理
void rmSync;
void sleep;
