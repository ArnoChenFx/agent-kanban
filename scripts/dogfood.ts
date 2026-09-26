// 用本项目自己的看板记录 M1-M6 的开发过程（M1 步骤 8 + M6 步骤 5）。
//
// 目的不是留档，而是**验证工具自己**：一个专门写给别人用的看板，
// 如果连自己的开发过程都记不下来，那它对 agent 也没用。
//
// 幂等：重复运行会复用已有的 project 与任务（按标题匹配），不产生重复卡。
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const CLI = join(ROOT, "src", "cli.ts");

let fails = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) fails++;
};

function kanban(args: string[]): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(["bun", "run", CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, NO_COLOR: "1" },
  });
  return {
    code: r.exitCode ?? -1,
    out: new TextDecoder().decode(r.stdout),
    err: new TextDecoder().decode(r.stderr),
  };
}

/** M1-M6 的实际开发内容：任务标题 + 描述 + 验收方式 */
const MILESTONES: Array<{ title: string; desc: string; labels: string[] }> = [
  {
    title: "M1 存储层与任务状态机",
    desc: "SQLite/WAL schema、BEGIN IMMEDIATE 事务、ID 分配、数据驱动状态机、事件流、CLI 骨架。\n验收：8 进程并发抢同一任务恰好 1 个成功。",
    labels: ["m1", "core"],
  },
  {
    title: "M2 崩溃恢复（核心里程碑）",
    desc: "会话租约、僵尸回收、handoff、context/resume。\n验收：模拟崩溃 → 回收 → 新会话 resume 拿到完整交接，进度与 checklist 不丢。",
    labels: ["m2", "core"],
  },
  {
    title: "M3 计划版本化与事件重放",
    desc: "计划 save 产生新版本、旧版转 superseded；rebuild 从事件重放并逐字段比对投影。\n验收：rebuild 后投影与原投影逐字段相等。",
    labels: ["m3", "core"],
  },
  {
    title: "M4 MCP Server",
    desc: "stdio 传输，20 个工具全部是 Op 的薄封装；长文本截断；统一 ok/data/next_actions 包络。\n验收：真子进程跑完契约 §3.4 的七步恢复流程。",
    labels: ["m4", "agent"],
  },
  {
    title: "M5 HTTP + SSE + Web 看板",
    desc: "契约 §4 全部路由、SSE 游标续传、shadcn 前端（7 泳道拖拽 + 详情抽屉 + 中性灰阶主题）。\n验收：真 serve 子进程 + HTTP/SSE 客户端端到端。",
    labels: ["m5", "web"],
  },
  {
    title: "M6 集成收尾",
    desc: "install-protocol 写 AGENTS.md 受管区块；export/import/snapshot/compact；四份双语文档含 FAQ。\n验收：新机器 clone 后 init + import 完整恢复历史。",
    labels: ["m6", "docs"],
  },
];

if (!existsSync(join(ROOT, ".kanban", "kanban.db"))) {
  check("看板已初始化", false, "先跑 `bun run kanban init`");
  process.exit(1);
}

console.log("=== 1. 开会话 ===");
const sid = (JSON.parse(kanban(["--json", "session", "start", "--agent", "pi-main", "--harness", "pi"]).out) as { id: string }).id;
check("session_start", typeof sid === "string", sid);
const S = ["--session", sid];

console.log("\n=== 2. 读现场 ===");
const ctx = kanban([...S, "context"]);
check("context 可用", ctx.code === 0, ctx.out.trim().split("\n")[0]?.slice(0, 60) ?? "");

console.log("\n=== 3. 记录 M1-M6（幂等）===");
// 必须用 board 而不是 task list：list 默认排除终态，已 done 的里程碑就“消失”了，
// 幂等判断会失效并重复建卡——这正是第一版脚本的问题。
const board = JSON.parse(kanban([...S, "--json", "board"]).out) as { lanes?: Record<string, Array<{ id: string; title: string }>> };
const all = Object.values(board.lanes ?? {}).flat();
const byTitle = new Map(all.map((t) => [t.title, t.id]));

const created: string[] = [];
for (const m of MILESTONES) {
  const hit = byTitle.get(m.title);
  if (hit) {
    console.log(`· ${hit} ${m.title}（已存在）`);
    continue;
  }
  const args = [...S, "--json", "task", "add", m.title, "-d", m.desc, "-p", "1"];
  for (const l of m.labels) args.push("-l", l);
  const r = kanban(args);
  if (r.code !== 0) {
    check(`建卡失败：${m.title}`, false, r.err.slice(0, 80));
    continue;
  }
  const id = (JSON.parse(r.out) as { id: string }).id;
  created.push(id);
  console.log(`✓ ${id} ${m.title}`);
}
check("M1-M6 六个里程碑已入库", MILESTONES.every((m) => byTitle.has(m.title)), `本轮新建 ${created.length} 张`);

console.log("\n=== 4. 走一遍完整状态流转（用一张专门的演示卡）===");
// 不用里程碑卡做流转：它已经是终态，重复运行时 claim/review/done 都会失败。
// 流转演示要可重复，所以单独一张自检卡，每次先 reopen 回到 todo。
const DEMO = "dogfood 自检：走一遍完整状态流转";
// 建卡时就把 checklist 建好：--check 在 task add 是**新增**，
// 在 task progress 才是**勾选**。建卡时不带，勾选那步会报“没有未完成的 claim”。
const DEMO_CHECKS = "claim,progress,plan,review,done";
let demoId = byTitle.get(DEMO);
if (!demoId) {
  const r = kanban([
    ...S, "--json", "task", "add", DEMO,
    "-d", "建卡时带 checklist，然后 claim → progress → plan → review → done；重跑前 reopen 以保证可重复。",
    "--check", DEMO_CHECKS,
  ]);
  demoId = (JSON.parse(r.out) as { id: string }).id;
  byTitle.set(DEMO, demoId);
  console.log(`✓ ${demoId} ${DEMO}`);
}

const demoState = (JSON.parse(kanban([...S, "--json", "task", "show", demoId]).out) as { status: string });
if (demoState.status === "done") {
  const ro = kanban([...S, "task", "reopen", demoId, "--reason", "dogfood 重跑"]);
  check("reopen（重跑前回 todо）", ro.code === 0, ro.out.trim().split("\n")[0]?.slice(0, 50) ?? "");
}

const claim = kanban([...S, "task", "claim", demoId]);
check("claim", claim.code === 0, claim.out.trim().split("\n")[0]?.slice(0, 50) ?? "");

// --check 是**勾选**已存在的检查项，所以重跑时得先把已勾的取消，
// 否则第二次会报“没有未完成的 claim”。顺便把 uncheck 也演示一遍。
const demoNow = (JSON.parse(kanban([...S, "--json", "task", "show", demoId]).out) as {
  checklist: Array<{ done: boolean }>;
});
if (demoNow.checklist.some((c) => c.done)) {
  const un = kanban([...S, "task", "progress", demoId, "--uncheck", DEMO_CHECKS]);
  check("uncheck（重跑时先取消勾选）", un.code === 0, un.out.trim().split("\n")[0]?.slice(0, 40) ?? "");
}

const prog = kanban([...S, "task", "progress", demoId, "--pct", "100", "--note", "每一步都跑通了", "--check", DEMO_CHECKS]);
check("progress 100%", prog.code === 0, prog.out.trim().split("\n")[0]?.slice(0, 50) ?? "");

const plan = kanban([...S, "plan", "save", "--task", demoId, "--title", "dogfood 流转顺序", "--body", "1. claim 拿租约\n2. progress 推进并续租\n3. plan save 存新版本\n4. review 交人审\n5. done 终态"]);
check("plan save", plan.code === 0, plan.out.trim().split("\n")[0]?.slice(0, 50) ?? "");

const review = kanban([...S, "task", "review", demoId]);
check("review", review.code === 0);
const done = kanban([...S, "task", "done", demoId, "--note", "状态机走完一轮"]);
check("done", done.code === 0, done.out.trim().split("\n")[0]?.slice(0, 50) ?? "");

console.log("\n=== 5. 留交接（dogfood 的意义：让下一个会话能接上）===");
const ho = kanban([
  ...S, "handoff", "--task", demoId,
  "--summary", "M1-M6 全部实现并通过验证，CI 已接入 MCP / 备份 / 文档三组新门禁",
  "--next", "打第一个 tag v0.1.0：先确认 package.json.version，跑完整回归",
  "--open", "首次 release 前，Docker 实际构建仍需在有 Docker 的机器上验证",
]);
check("handoff", ho.code === 0, ho.out.trim().split("\n")[0]?.slice(0, 50) ?? "");

console.log("\n=== 6. 自证一致（事件流 vs 投影）===");
const rb = kanban([...S, "rebuild"]);
check("rebuild 零漂移", rb.code === 0, rb.out.trim().split("\n").slice(0, 2).join(" ").slice(0, 80));

console.log("\n=== 7. 导出 journal（跨机器迁移的验证）===");
const exp = kanban([...S, "export"]);
check("export", exp.code === 0, exp.out.trim().split("\n")[0]?.slice(0, 60) ?? "");

console.log("\n=== 8. 协作协议同步 ===");
const proto = kanban(["install-protocol"]);
check("install-protocol", proto.code === 0, proto.out.trim().split("\n")[0]?.slice(0, 60) ?? "");

console.log("\n=== 9. 收工 ===");
const doctor = kanban([...S, "doctor"]);
const okLine = doctor.out.includes("没有发现问题") || doctor.code === 0;
check("doctor", okLine, doctor.out.trim().split("\n").slice(0, 2).join(" ").slice(0, 80));
kanban([...S, "session", "end"]);

console.log(`\n${fails === 0 ? "✓ dogfood 通过：工具能记录自己的开发过程" : `✗ ${fails} 项失败`}`);
process.exit(fails === 0 ? 0 : 1);
