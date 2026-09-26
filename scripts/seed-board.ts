// 看板自举（dogfooding）脚本
//
// 把 docs/plan/003-实施计划.md 里的 M1-M6 里程碑导入看板，
// 让本项目自己的开发过程也由看板管理（自举）。
//
// 幂等：重复运行不会重复创建（先检查是否已存在同名任务）。
// 用法：bun run scripts/seed-board.ts

import { resolvePaths } from "../src/core/paths.ts";
import { openDb, migrate } from "../src/core/db.ts";
import { withTx, type TxContext } from "../src/core/tx.ts";
import { resolveLocalProject, type Project } from "../src/core/projects.ts";
import {
  addDependency,
  createTask,
  claimTask,
  requireTask,
  transition,
  updateProgress,
  type Scope,
} from "../src/core/tasks.ts";
import { createSession } from "../src/core/sessions.ts";
import type { TaskStatus } from "../src/core/types.ts";

const paths = resolvePaths({ mustExist: true });
const handle = openDb(paths.db);
migrate(handle);
const db = handle.raw;

// 复用本地 project 解析（与 CLI 完全一致的逻辑）
const project: Project = resolveLocalProject(db, { rootPath: paths.projectRoot });
const scope: Scope = { db, projectKey: project.key };
const now = Date.now();
const actor = { sessionId: "", now, ttlMs: 15 * 60 * 1000 };

/** 里程碑定义：标题、优先级、检查项、目标状态、依赖 */
interface MilestoneDef {
  key: string;
  title: string;
  desc: string;
  priority: number;
  status: TaskStatus;
  progress: number;
  checklist: string[];
  dependsOn: string[];
}

const MILESTONES: MilestoneDef[] = [
  {
    key: "M1",
    title: "M1 存储层与任务状态机",
    desc: "schema、事务封装、ID 分配、数据驱动转移表、抢占原子性、board 视图与 CLI 骨架",
    priority: 0,
    status: "done",
    progress: 100,
    checklist: [
      "工程骨架与错误码体系（退出码 0-7）",
      "schema.sql + PRAGMA + 迁移",
      "withTx：BEGIN IMMEDIATE + 同事务写事件 + 退避重试",
      "ID 分配：T-0007（per-project 计数器，永不复用）",
      "数据驱动状态机 + 条件 UPDATE 抢占 + 环检测",
      "CLI：init / session / task 全套 / board",
      "测试：状态机表驱动 + 8 进程并发抢占",
    ],
    dependsOn: [],
  },
  {
    key: "M2",
    title: "M2 崩溃恢复（核心价值）",
    desc: "租约 + 心跳 + 僵尸自动回收 + handoff 交接 + context/resume，让 agent 意外停止后能接上",
    priority: 0,
    status: "todo",
    progress: 0,
    checklist: [
      "会话租约：claim 写 lease_expires_at，写操作隐式续租",
      "心跳与僵尸判定：超 grace 未见心跳即 crashed",
      "回收保留 progress 与 checklist（恢复不用从头再来）",
      "handoff：主动写 + 崩溃自动合成 + consumed 标记",
      "agent-kanban context：看板概览 + 交接 + 时间线 + next_actions",
      "agent-kanban resume：一条命令完成接管与上下文注入",
      "agent-kanban doctor --deep：一致性自检与自动修复",
    ],
    dependsOn: ["M1"],
  },
  {
    key: "M3",
    title: "M3 计划版本化与事件重放",
    desc: "任务级/项目级计划版本链、diff、事件重放 rebuild、doctor 一致性校验",
    priority: 1,
    status: "todo",
    progress: 0,
    checklist: [
      "计划版本链：save 自动 version+1，旧版转 superseded",
      "plan list / show / diff / attach / archive",
      "事件重放器：从 events 重建投影（ADR-1 的正确性证明）",
      "agent-kanban rebuild：重放后与原投影逐字段比对",
      "agent-kanban doctor --deep：检测不一致并可自动修复",
    ],
    dependsOn: ["M2"],
  },
  {
    key: "M4",
    title: "M4 MCP Server",
    desc: "以 MCP 工具暴露看板能力，参数受 schema 约束，工具层只做 core 的薄封装",
    priority: 1,
    status: "todo",
    progress: 0,
    checklist: [
      "20 个工具定义（契约 §3.2）",
      "统一 ok/data/next_actions 包络",
      "长文本截断策略",
      "与 CLI 行为一致性测试",
    ],
    dependsOn: ["M3"],
  },
  {
    key: "M5",
    title: "M5 Web 看板",
    desc: "无框架前端：泳道、详情抽屉、会话面板、时间线、失联提示条、SSE 实时",
    priority: 2,
    status: "todo",
    progress: 0,
    checklist: [
      "前端：泳道 + 卡片 + 抽屉 + 会话面板 + 时间线",
      "SSE 断线续传",
      "安全：textContent 渲染，不做拖拽",
    ],
    dependsOn: ["M3"],
  },
  {
    key: "M6",
    title: "M6 集成收尾",
    desc: "agent 协作协议安装、journal 导出导入、快照、README 与文档",
    priority: 2,
    status: "todo",
    progress: 0,
    checklist: [
      "agent-kanban install-protocol：幂等写入 AGENTS.md 受管区块",
      "agent-kanban export / import：换机器完整恢复历史",
      "agent-kanban snapshot / compact",
      "README：安装、快速开始、agent 协议、常见问题",
    ],
    dependsOn: ["M4", "M5"],
  },
];

// ---- 注册/复用会话 ----
let sessionId = "";
withTx(
  db,
  (ctx) => {
    const existing = db
      .query<{ id: string }, []>("SELECT id FROM sessions ORDER BY started_at LIMIT 1")
      .get();
    sessionId =
      existing?.id ??
      createSession(ctx, { agentName: "pi-main", harness: "pi", cwd: paths.projectRoot }).id;
  },
  { now: () => now, projectKey: project.key },
);
(actor as { sessionId: string }).sessionId = sessionId;

/** 在当前 project 上跑一个写事务 */
function tx(fn: (t: TxContext) => void): void {
  withTx(db, fn, { now: () => Date.now(), sessionId, projectKey: project.key });
}

const createdIds = new Map<string, string>();

for (const m of MILESTONES) {
  const existing = db
    .query<{ id: string }, [string]>("SELECT id FROM tasks WHERE project_key = ? AND title = ?")
    .get(project.key, m.title);
  if (existing) {
    createdIds.set(m.key, existing.id);
    console.log(`- 跳过（已存在）${existing.id} ${m.title}`);
    continue;
  }

  let id = "";
  tx((t) => {
    // 注意：createTask 返回的是 Task 对象，这里要的是任务号
    id = createTask(t, {
      title: m.title,
      body: m.desc,
      priority: m.priority,
      checklist: m.checklist,
      status: "todo",
    }).id;
  });
  createdIds.set(m.key, id);
  console.log(`+ 创建 ${id} ${m.title}`);

  // 推进到目标状态（M1 标成已完成，体现真实进度）
  tx((t) => {
    const a = { sessionId, now: Date.now(), ttlMs: 15 * 60 * 1000 };
    if (m.status === "doing") claimTask(t, id, a);
    if (m.progress > 0) updateProgress(t, id, a, { pct: m.progress });
    if (m.status === "done") transition(t, id, "done", a, { force: true, note: "已实现并通过测试" });
  });
}

// ---- 建立里程碑依赖：M1 → M2 → M3 → {M4, M5} → M6 ----
tx((t) => {
  for (const m of MILESTONES) {
    const id = createdIds.get(m.key);
    if (!id) continue;
    for (const dep of m.dependsOn) {
      const depId = createdIds.get(dep);
      if (!depId) continue;
      try {
        addDependency(t, id, depId);
      } catch (e) {
        console.log(`  依赖 ${id}→${depId} 跳过：${(e as Error).message}`);
      }
    }
  }
});

console.log(`\n完成。当前看板（project: ${project.key}）：`);
for (const m of MILESTONES) {
  const t = requireTask(scope, createdIds.get(m.key)!);
  console.log(`  ${t.id}  [${t.status}] ${t.progress}%  ${t.title}`);
}
handle.raw.close();
