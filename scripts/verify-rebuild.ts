// rebuild 自证端到端验证：真实 CLI 进程做一堆操作，然后核对投影与事件流
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// 仓库根目录：从本脚本位置推导，不能写死绝对路径（CI 克隆路径不同）
const ROOT = resolve(import.meta.dir, "..");
const CLI = `${ROOT}/src/cli.ts`;

/**
 * ⚠ 必须在临时目录里跑，不能跑在仓库根。
 *
 * 本脚本会对看板做**破坏性**操作：开头 `init --force` 重置投影、中间建夹具卡、
 * 第 6 步**故意改坏投影**（改标题/状态、错改进度、删依赖）再 rebuild 修复。
 * 如果 cwd 是仓库根，这些全部作用在**开发者自己的真实看板**上：
 * 卡被冲掉、计划被重建、投影被短暂弄脏。
 *
 * AGENTS.md 记过这个坑（「别让验收脚本的 CLI 跑在仓库根」）并修了 verify-web-ui.ts，
 * 但本脚本与 verify-recovery.ts 当时漏了。改成与 verify-web-ui.ts 同一做法：
 * cwd 换成临时目录 + 显式 --db，同时也就不会覆盖开发者的 `.kanban/sessions/<key>` 身份文件。
 */
const dir = mkdtempSync(join(tmpdir(), "kanban-rebuild-"));
const DB = ["--db", join(dir, "rebuild.db")];

function run(args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number; out: string; err: string }>((resolve) => {
    // cwd: dir 而不是 ROOT —— 见上方说明
    const p = spawn("bun", ["run", CLI, ...args], { cwd: dir, env: { ...process.env, ...env } });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => resolve({ code: code ?? -1, out, err }));
  });
}
/** 带 --db 跑一条命令 */
const cli = (args: string[], env: Record<string, string> = {}) => run([...args, ...DB], env);
const step = (n: string) => console.log(`\n${"=".repeat(60)}\n${n}\n${"=".repeat(60)}`);

// 全新库
await cli(["init", "--force", "--name", "agent-kanban"]);
const s = await cli(["session", "start", "--agent", "pi-main", "--harness", "pi"]);
const sid = /s-[0-9a-z]{6}/.exec(s.out)?.[0] ?? "";
const env = { KANBAN_SESSION: sid };
console.log(`会话 ${sid}`);

step("1. 建卡 + 依赖 + 各种状态流转");
const cmds: string[][] = [
  ["task", "add", "实现 rebuild", "-d", "从事件流重建投影", "--check", "补齐事件字段,写 rebuild,写测试", "--label", "core"],
  ["task", "add", "补 task_deps 的 project 隔离", "--priority", "0"],
  ["task", "add", "写一致性测试", "--blocked-by", "T-0001"],
  ["task", "claim", "T-0001"],
  ["task", "progress", "T-0001", "--pct", "60", "--check", "补齐事件字段", "--note", "事件 payload 补全"],
  ["task", "block", "T-0002", "--reason", "要等 schema 迁移定稿"],
  ["task", "unblock", "T-0002"],
  ["task", "edit", "T-0003", "--title", "写 rebuild 一致性测试", "--priority", "1"],
];
for (const c of cmds) {
  const r = await cli(c, env);
  console.log(`${r.code === 0 ? "✓" : "✗"} ${c.slice(0, 3).join(" ")}${r.code === 0 ? "" : "  " + r.err.split("\n")[1] ?? ""}`);
}

step("2. 计划版本化（3 个版本）");
const bodies = [
  ["v1", "## 步骤\n1. 补齐事件 payload\n2. 写 rebuild"],
  ["v2", "## 步骤\n1. 补齐事件 payload\n2. 写 rebuild（内存重放）\n3. 先算再比"],
  ["v3", "## 步骤\n1. 补齐事件 payload（含 body/checklist）\n2. 写 rebuild（内存重放）\n3. 先算再比，默认只校验\n4. 写一致性测试"],
];
for (const [tag, body] of bodies) {
  const r = await cli(["plan", "save", "--task", "T-0001", "--title", `方案 ${tag}`, "--body", body], env);
  console.log(`${r.code === 0 ? "✓" : "✗"} plan ${tag} ${r.code === 0 ? r.out.split("\n")[0].replace(/\x1b\[[0-9;]*m/g, "") : r.err.split("\n")[1] ?? ""}`);
}

step("3. 交接 + 回收 + 消费");
await cli(["handoff", "--task", "T-0001", "--summary", "事件 payload 已补齐", "--next", "写 rebuild", "--blockers", "task_deps 缺 project_key", "--open", "lease 要不要参与比较？"], env);
await cli(["task", "release", "T-0001"], env);
await cli(["task", "claim", "T-0001"], env);
await cli(["task", "done", "T-0001", "--note", "rebuild 核心逻辑完成", "--force"], env);

step("4. 计划：项目级 + 时间旅行");
await cli(["plan", "save", "--title", "v3 路线图", "--body", "## M3\n计划版本化 + rebuild"], env);

step("5. rebuild 校验（关键：应报完全一致）");
const check = await cli(["rebuild"], env);
console.log(check.out.trim());
console.log(`退出码 ${check.code}（0 = 一致）`);

step("6. 故意弄脏投影：直接改库绕过 core");
const { Database } = await import("bun:sqlite");
const db = new Database(join(dir, "rebuild.db"), { readwrite: true, create: false });
db.query("UPDATE tasks SET title = '被偷偷改过的标题', status = 'doing' WHERE id = 'T-0002'").run();
db.query("UPDATE tasks SET progress = 99 WHERE id = 'T-0003'").run();
// project_key 不可省：T 编号是 per-project 的，这脚本跑在真实 .kanban 库上，
// 不加过滤会连带删掉别的 project 的同号依赖边
const projectKey =
  db.query<{ key: string }, []>("SELECT key FROM projects ORDER BY created_at LIMIT 1").get()?.key ??
  "";
db.query("DELETE FROM task_deps WHERE project_key = ? AND task_id = 'T-0003'").run(projectKey);
db.close();
console.log("已直接改库：改标题/状态、错改进度、删掉一条依赖");

const dirty = await cli(["rebuild"], env);
console.log(dirty.out.trim());
console.log(`退出码 ${dirty.code}（非 0 = 检测到漂移）`);

step("7. 修复：rebuild --write --force");
const fix = await cli(["rebuild", "--write", "--force"], env);
console.log(fix.out.trim());

const after = await cli(["rebuild"], env);
console.log(after.out.trim());
console.log(`修复后退出码 ${after.code}（应为 0）`);

step("8. 修复后功能仍正常");
const t2 = await cli(["task", "show", "T-0002", "--json"], env);
const task = JSON.parse(t2.out) as Record<string, unknown>;
console.log(`T-0002 标题：${task.title}（应为原标题）`);
console.log(`T-0002 状态：${task.status}（应为 todo）`);
const t3 = await cli(["task", "show", "T-0003", "--json"], env);
const task3 = JSON.parse(t3.out) as Record<string, unknown>;
console.log(`T-0003 标题：${task3.title}（应为 edit 后的）`);
console.log(`T-0003 进度：${task3.progress}%（应为 0）`);
const deps = await cli(["task", "show", "T-0003", "--json"], env);
console.log(`T-0003 依赖数：${(deps && JSON.parse(deps.out).dependencies)?.length ?? "?"}（应为 1）`);

const newTask = await cli(["task", "add", "重建后新建的任务"], env);
console.log(`\n重建后新建：${newTask.out.split("\n")[0].replace(/\x1b\[[0-9;]*m/g, "")}（计数器已推高，不能撞号）`);

step("9. 计划链仍然完整");
const hist = await cli(["plan", "history", "PL-T-0001-03"], env);
console.log(hist.out.trim());

// 临时目录清掉（含上面那个被故意弄脏又修好的库）
rmSync(dir, { recursive: true, force: true });
