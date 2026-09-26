#!/usr/bin/env bun
/**
 * 演示数据种子脚本（demo seed）
 * ============================
 *
 * 往一个 agent-kanban 库里灌一份**看起来像真的**研发看板：18 张卡、5 个会话、
 * 依赖图、父子任务、交接、计划版本、崩溃回收，时间线铺开在过去两周。
 *
 * 用途：给 README / 介绍文档 / 商店页面截图当素材。数据是**模拟的**，
 * 但完全通过 core API 写入（和 CLI / MCP 走同一条路径），所以事件流、
 * 投影、租约、rebuild 全部自洽 —— 截图里的看板不是手工改出来的假样子。
 *
 * 全部界面文案使用英文（截图文档面向英文读者），只有本脚本的注释是中文。
 *
 * 用法：
 *   bun run scripts/seed-demo.ts                     # 灌到 <repo>/.kanban/kanban.db
 *   bun run scripts/seed-demo.ts --db /tmp/demo.db   # 灌到任意库（截图脚本用）
 *   bun run scripts/seed-demo.ts --project demo --name "Demo Board"
 *   bun run scripts/seed-demo.ts --reset            # 目标库非空时先删库重建
 *
 * 安全约定：
 *   · 目标库已存在任务时**直接拒绝**，必须显式 --reset（会删库重建，不可逆）
 *   · --reset 只删 db 文件本身，不碰 .kanban/config.toml、journal、plans
 *   · 库初始化后会在 meta 里写 demo_seeded_at，重复运行会被识别并提示
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { getBool, getString, parseArgs } from "../src/commands/args.ts";
import { CONFIG_FILE, writeConfigFile } from "../src/core/config.ts";
import { getMeta, migrate, openDb, setInitialConfig, setMeta } from "../src/core/db.ts";
import { consumeHandoff, writeHandoff } from "../src/core/handoff.ts";
import { savePlan } from "../src/core/plans.ts";
import { createProject, slugifyProjectKey } from "../src/core/projects.ts";
import { createSession, closeSession, touchSession } from "../src/core/sessions.ts";
import {
  addDependency,
  addNote,
  claimTask,
  countByStatus,
  createTask,
  listTasks,
  renewLease,
  runTaskCommand,
  transition,
  updateProgress,
  type Actor,
  type CreateTaskInput,
} from "../src/core/tasks.ts";
import { withTx, type TxContext } from "../src/core/tx.ts";
import type { TaskStatus } from "../src/core/types.ts";

const ROOT = resolve(import.meta.dir, "..");

const USAGE = `用法：bun run scripts/seed-demo.ts [选项]

选项：
  --db <path>       目标数据库（默认 <repo>/.kanban/kanban.db）
  --project <key>   project key（默认由库所在目录名派生，如 agent-kanban）
  --name <显示名>   project 显示名（默认同 project key）
  --grace <分钟>   失联宽限（默认 30：演示数据要能放几天再截图而不被回收）
  --reset           目标库已存在时先删库重建（不可逆）
  --quiet           只输出结果，不打印任务清单
  -h, --help        显示本帮助

说明：
  · 库不存在时自动建库 + 建 project（等价于 \`agent-kanban init\`）
  · 目标库已有任务时会拒绝执行，避免污染真实看板
  · 数据全部为模拟内容，全英文；时间线铺在过去两周`;

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2), {
  booleans: ["reset", "quiet", "help"],
  strings: ["db", "project", "name", "grace"],
  short: { h: "help" },
});

if (args.unknown.length > 0) {
  console.error(`未知参数：${args.unknown.map((u) => `--${u}`).join(" ")}\n`);
  console.log(USAGE);
  process.exit(1);
}
if (getBool(args, "help")) {
  console.log(USAGE);
  process.exit(0);
}

const dbPath = resolve(ROOT, getString(args, "db") ?? join(".kanban", "kanban.db"));
const dbDir = dirname(dbPath);
const projectRoot = resolve(dbDir, "..");
const reset = getBool(args, "reset");
const quiet = getBool(args, "quiet");

/**
 * 失联宽限（分钟）。
 *
 * 为什么默认拉到 30 而不是 core 的 10：任何 CLI / HTTP 命令开头都会触发僵尸回收
 * （doctor、board、context 都会）。宽限是 10 分钟的话，演示数据放半小时后再看一眼，
 * 看板就变成"所有会话全判崩溃、卡全被退回"，而且崩溃交接是 core 硬编码中文的 ——
 * 全英文看板当场破功。截图前重跑一次本脚本最稳，拉宽限只是让它多放几天也长得一样。
 */
const GRACE_MIN = Number(getString(args, "grace") ?? 30);
const GRACE_MS = GRACE_MIN * 60_000;

function die(message: string, hint?: string): never {
  console.error(`✗ ${message}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 建库 / 复用库
// ---------------------------------------------------------------------------

const existed = existsSync(dbPath);
if (existed && reset) {
  // 只删主库三件套；config.toml / journal / plans 目录一律不动
  for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
  console.log(`· 已删除旧库：${dbPath}`);
}

mkdirSync(dbDir, { recursive: true });
const handle = openDb(dbPath);
const raw = handle.raw;
migrate(handle);

const existingProjects = raw
  .query<{ key: string }, []>("SELECT key FROM projects ORDER BY created_at ASC")
  .all();
/** 复用已有库时沿用库里的 project，避免同一份数据被挂到两个 project 下 */
const projectKey =
  getString(args, "project") ??
  (existed && existingProjects.length > 0
    ? existingProjects[0]!.key
    : slugifyProjectKey(basename(projectRoot)));
const displayName = getString(args, "name") ?? projectKey;

// ---- 防污染：已有任务就不许直接灌 ----
const seededAt = getMeta(raw, "demo_seeded_at");
const taskCount =
  raw
    .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM tasks WHERE project_key = ?")
    .get(projectKey)?.n ?? 0;
if (taskCount > 0 && !reset) {
  die(
    `目标库已有 ${taskCount} 张任务（project "${projectKey}"），拒绝灌入模拟数据`,
    seededAt
      ? `这份库在 ${new Date(Number(seededAt)).toISOString()} 灌过一次演示数据；重来请加 --reset`
      : "确认要覆盖请加 --reset（会删库重建，不可逆）；或用 --db 指定一个空库",
  );
}

withTx(raw, () => {
  setInitialConfig(raw, { projectName: displayName });
  // setInitialConfig 不会覆盖已存在的键，所以这里显式写：演示数据要能放几天
  setMeta(raw, "grace_ms", String(GRACE_MS));
  const exists = raw.query<{ key: string }, [string]>("SELECT key FROM projects WHERE key = ?").get(projectKey);
  if (!exists) {
    // 本地模式不鉴权（apiKeyHash = null），与 `agent-kanban init` 一致
    createProject(raw, { key: projectKey, name: displayName, rootPath: projectRoot, apiKeyHash: null });
  }
});

// 本地 .kanban 目录且还没有配置文件时补一份（与 `agent-kanban init` 行为一致）
if (basename(dbDir) === ".kanban" && !existsSync(join(dbDir, CONFIG_FILE))) {
  writeConfigFile(dbDir, { mode: "local", project: projectKey });
}

// ---------------------------------------------------------------------------
// 时间轴：以脚本运行时刻为"现在"，往前铺两周
// ---------------------------------------------------------------------------

const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** 租约时长：demo 里统一用默认的 15 分钟，让"租约剩余"看起来正常 */
const TTL = 15 * MIN;

/** daysAgo(3, 4) = 3 天 4 小时前 */
function daysAgo(days: number, hours = 0, minutes = 0): number {
  return NOW - days * DAY - hours * HOUR - minutes * MIN;
}
/** 毫秒 → 小时（estimate 用） */
const hours = (n: number): number => n * HOUR;

// ---------------------------------------------------------------------------
// 会话（5 个 agent，其中 1 个崩溃）
// ---------------------------------------------------------------------------

interface SeedSession {
  id: string;
  agent: string;
  harness: string;
  /** 几天前开始 */
  startedDaysAgo: number;
  /** 最后一次心跳：几分钟前；null = 稍后由"崩溃"段统一回填 */
  lastSeenMinutesAgo: number | null;
  /**
   * 收工方式：active = 还在看板上（心跳新鲜，不会被回收）；
   * closed = 已经 `session end` 干活去了（不再出现在会话列表里，也不会被回收）。
   *
   * 为什么必须区分：core 会在每次命令时回收心跳超时的会话。真实看板里"干完活"
   * 的 agent 都会显式 session end，所以演示数据也得这样 —— 否则过一会儿
   * 四个会话全被判崩溃，卡全被退回，卡片上的中文自动交接还会污染全英文看板。
   */
  state: "active" | "closed";
}

const SESSIONS: SeedSession[] = [
  { id: "s-a1b2c3", agent: "pi-main", harness: "pi", startedDaysAgo: 14, lastSeenMinutesAgo: 3, state: "active" },
  { id: "s-g7h8i9", agent: "codex-tests", harness: "codex", startedDaysAgo: 11, lastSeenMinutesAgo: null, state: "closed" },
  { id: "s-j1k2l3", agent: "cursor-ui", harness: "cursor", startedDaysAgo: 10.5, lastSeenMinutesAgo: 7, state: "active" },
  { id: "s-d4e5f6", agent: "claude-web", harness: "claude-code", startedDaysAgo: 8.5, lastSeenMinutesAgo: 5, state: "active" },
  { id: "s-m4n5o6", agent: "gpt-nightly", harness: "codex", startedDaysAgo: 5.2, lastSeenMinutesAgo: null, state: "active" },
];

for (const s of SESSIONS) {
  const startedAt = daysAgo(s.startedDaysAgo);
  withTx(
    raw,
    (ctx) =>
      createSession(ctx, { agentName: s.agent, harness: s.harness, id: s.id, cwd: projectRoot, pid: null }),
    { now: () => startedAt, projectKey: "system" },
  );
  if (s.lastSeenMinutesAgo !== null) touchSession(raw, s.id, NOW - s.lastSeenMinutesAgo * MIN);
}

// 收工的会话：codex 昨天把 MCP 的活干完就 session end 了（它名下两张卡都是 todo，
// closeSession 不会动它们）。closed 的会话不再出现在 board / context 的会话列表。
withTx(
  raw,
  (ctx) => {
    for (const s of SESSIONS) {
      if (s.state === "closed") closeSession(ctx, s.id, "MCP work queued up, handing the board back");
    }
  },
  { now: () => daysAgo(1, 0), sessionId: "system", projectKey: "system" },
);

// ---------------------------------------------------------------------------
// 任务
// ---------------------------------------------------------------------------

/** key → 真实任务号（T-00xx 由计数器分配，不写死） */
const id: Record<string, string> = {};

/**
 * 以某个会话的身份、在某个时刻跑一段 core 写操作。
 *
 * 逻辑时钟（actor.now）在这里注入：core 的所有写函数都从 ctx.now()/actor.now
 * 取时间，所以把时间拨到过去就能造出"两周前建的卡、三小时前推的进度"，
 * 而不是一堆全部是 now 的时间戳。
 */
function as(
  sessionId: string | null,
  at: number,
): { actor: Actor; run: <T>(fn: (ctx: TxContext) => T) => T } {
  const actor: Actor = { sessionId, now: at, ttlMs: TTL };
  return { actor, run: (fn) => runTaskCommand(raw, actor, projectKey, fn) };
}

/**
 * 建一张卡。
 *
 * 依赖直接写进 createTask 的 blockedBy：这样 dep_added 事件的时间戳与建卡一致，
 * 不会留下一堆"所有依赖都在 3 小时前加上"的假痕迹。
 * 因此**建卡顺序必须保证依赖在前面**（下面每个 dependsOn 的目标都更早创建）。
 */
function add(
  key: string,
  input: CreateTaskInput,
  at: number,
  by: string | null,
  deps: string[] = [],
): string {
  const { run } = as(by, at);
  const task = run((ctx) => createTask(ctx, { ...input, blockedBy: deps.map((d) => id[d]!) }));
  id[key] = task.id;
  return task.id;
}

// ---- 1) 里程碑父卡 ------------------------------------------------------
add(
  "epic",
  {
    title: "Ship v0.2: crash recovery & multi-harness support",
    body: [
      "The board only earns its keep once a dead agent can hand its card over without a human reading chat",
      "logs, and once Claude Code / Codex / Cursor sessions can all claim from the same board.",
      "",
      "Exit criteria: zombie reclaim, crash handoff synthesis, a published MCP server, and a recovery",
      "workflow documented well enough that somebody else can run it.",
    ].join("\n"),
    priority: 0,
    labels: ["release", "meta"],
    checklist: [
      "Zombie reclaim preserves progress",
      "Crash handoff synthesis",
      "MCP server published to npm",
      "Recovery workflow documented",
    ],
  },
  daysAgo(14),
  "s-a1b2c3",
);

// ---- 2) 存储迁移（已完结，后面隔离改造的前置） ----------------------------
add(
  "deps-schema",
  {
    title: "Backfill project_key onto task_deps (schema v4)",
    body: [
      "The v1→v2 migration added project_key to tasks, events, plans and handoffs — and quietly skipped",
      "task_deps. With a single project nobody notices. With two, INSERT OR IGNORE treats the second",
      "project's dependency edges as duplicates and drops them, and every dependency query leaks across",
      "projects because the predicate never mentions project_key.",
      "",
      "Fix: rebuild the table with a (project_key, task_id, depends_on_id) primary key, backfill by",
      "looking each task's project up from the tasks table.",
    ].join("\n"),
    priority: 0,
    labels: ["storage", "migration", "security"],
    checklist: [
      "Put project_key in the primary key",
      "Backfill from the tasks table",
      "Add idx_deps_project",
      "Multi-project regression test",
    ],
    estimateMs: hours(6),
  },
  daysAgo(13, 2),
  "s-a1b2c3",
);

// ---- 3) 崩溃交接合成（已完结） -------------------------------------------
add(
  "crash-handoff",
  {
    title: "Synthesize a crash handoff from the event journal",
    body: [
      "A crashed agent cannot write a handoff — it is already dead. The server has to reconstruct one from",
      "the events it already wrote.",
      "",
      "Rules: the summary is machine-generated from the last few actions, the next step is the open",
      "checklist, and unanswered questions get pulled out of recent notes. Everything comes from the",
      "journal; nothing is guessed.",
    ].join("\n"),
    priority: 0,
    labels: ["core", "recovery"],
    checklist: [
      "Replay the last 12 events for the task",
      "Map unfinished checklist items to next step",
      "Surface unanswered questions from recent notes",
      "Cover the empty-journal case in tests",
    ],
    estimateMs: hours(8),
  },
  daysAgo(12, 1),
  "s-a1b2c3",
);

// ---- 4) 僵尸回收（已完结，依赖崩溃交接） ---------------------------------
add(
  "reclaim",
  {
    title: "Reclaim zombie-held tasks without losing progress",
    body: [
      "Leases expire; agents do not always notice. When a session misses its grace window, the cards it",
      "held go back to todo — with progress and the checked-off checklist items intact, so the next agent",
      "resumes instead of starting over.",
      "",
      "Two things must NOT be reclaimed: blocked cards (a blocker is a fact about the work, not about the",
      "holder) and review cards (that is a human gate).",
    ].join("\n"),
    priority: 1,
    labels: ["core", "recovery"],
    checklist: [
      "Reap inside a write transaction",
      "Skip blocked and review cards",
      "Reclaim across every project",
      "Attach a crash handoff to each reclaimed card",
    ],
    estimateMs: hours(5),
  },
  daysAgo(11, 6),
  "s-a1b2c3",
  ["crash-handoff"],
);

// ---- 5) MCP 工具层（待办，前置是崩溃交接的语义） -------------------------
add(
  "mcp-tools",
  {
    title: "MCP tools: thin wrappers over the core ops",
    body: [
      "One tool per op kind, zero business logic of its own. The MCP layer validates arguments, calls the",
      "same runTaskCommand the CLI uses, and returns the op envelope verbatim — so CLI, HTTP and MCP",
      "cannot drift apart.",
      "",
      "next_actions is the part that matters most: an agent that just claimed a card should be told what to",
      "do next without having to guess.",
    ].join("\n"),
    priority: 0,
    labels: ["mcp", "core"],
    checklist: [
      "Map every op in ops.ts to a tool schema",
      "Return next_actions verbatim",
      "Cover the error envelopes",
    ],
    estimateMs: hours(16),
  },
  daysAgo(11, 0),
  "s-g7h8i9",
  ["crash-handoff"],
);

// ---- 6) 暗色主题 token（评审中，带计划版本链） ---------------------------
add(
  "dark-theme",
  {
    title: "Dark theme: replace ad-hoc greys with semantic tokens",
    body: [
      "Every component picked its own shade of grey, so the dark theme was really nine slightly different",
      "blacks. Define the tokens once (surface, surface-muted, border, text-muted) in index.css and let the",
      "components read those.",
      "",
      "Also raise muted text to 4.5:1 — it was 3.1:1 and failed AA on the card subtitles.",
    ].join("\n"),
    priority: 2,
    labels: ["web", "design", "a11y"],
    checklist: [
      "Define surface / border / text tokens",
      "Replace hard-coded hex values",
      "Check contrast on muted text",
      "Screenshot both themes",
    ],
    estimateMs: hours(4),
  },
  daysAgo(10, 3),
  "s-j1k2l3",
);

// ---- 7) 查询隔离（进行中，带任务级计划） ---------------------------------
add(
  "isolation",
  {
    title: "Enforce per-project isolation on every query path",
    body: [
      "Every read goes through a Scope { db, projectKey } object, so a cross-project query cannot be written",
      "by accident. Grep for SELECT ... FROM tasks without a project_key predicate — there should be none",
      "left, including in the rebuild and export paths.",
      "",
      "The dependency migration found the first one; this is the sweep that makes it impossible to add",
      "another.",
    ].join("\n"),
    priority: 0,
    labels: ["storage", "security", "core"],
    checklist: [
      "Scope object for all reads",
      "Rebuild path filters by project",
      "doctor flags mixed projects",
      "Backfill script for existing databases",
    ],
    estimateMs: hours(10),
  },
  daysAgo(9, 2),
  "s-a1b2c3",
  ["deps-schema"],
);

// ---- 8) MCP 发包（待办，依赖工具层与隔离改造） ---------------------------
add(
  "mcp-pkg",
  {
    title: "Publish the MCP server as a separate package",
    body: [
      "Agents should be able to talk to the board without shelling out to the CLI. Ship agent-kanban-mcp",
      "as its own npm package with the CLI as a pinned dependency, so version skew shows up in the",
      "lockfile instead of being guessed at runtime.",
    ].join("\n"),
    priority: 1,
    labels: ["mcp", "release"],
    checklist: ["Split the package out of src/mcp", "Pin the CLI version range", "Smoke test over stdio"],
    estimateMs: hours(8),
  },
  daysAgo(9, 0),
  "s-g7h8i9",
  ["mcp-tools", "isolation"],
);

// ---- 9) 冷启动优化（已取消） ---------------------------------------------
add(
  "cold-start",
  {
    title: "Cut the cold-start latency of `context`",
    body: [
      "`context` walked the whole event journal to rebuild the handoff block — 400ms on a board with 20k",
      "events. Tried sharding the reads per project and caching the head sequence.",
    ].join("\n"),
    priority: 3,
    labels: ["perf"],
    checklist: ["Shard reads by project", "Cache the head sequence"],
    estimateMs: hours(3),
  },
  daysAgo(8, 4),
  "s-a1b2c3",
);

// ---- 10) SSE 实时推送（进行中） ------------------------------------------
add(
  "sse",
  {
    title: "Web: live board updates over SSE",
    body: [
      "The board polls once on load, so a claim made by another agent stays invisible until you hit reload.",
      "Push every project-filtered event over SSE and an open board reflects it within a second.",
      "",
      "The cursor is the per-project event seq, and the client has to drop anything older than what it",
      "already applied — after a reconnect the server replays from Last-Event-ID.",
    ].join("\n"),
    priority: 1,
    labels: ["web", "realtime"],
    checklist: [
      "Stream project-filtered events",
      "Resume from Last-Event-ID",
      "Show a reconnect banner",
      "Back off on repeated failures",
    ],
    estimateMs: hours(12),
  },
  daysAgo(8, 0),
  "s-d4e5f6",
);

// ---- 11) Docker 镜像（评审中，带交接与消费记录） ------------------------
add(
  "docker",
  {
    title: "Docker image: slim runtime, non-root user",
    body: [
      "The published image shipped the whole toolchain and ran as root. Strip it to the compiled binary",
      "plus web/dist, add a non-root user, and pin the base image by digest so a rebuild months from now",
      "produces the same layers.",
    ].join("\n"),
    priority: 2,
    labels: ["ci", "docker", "release"],
    checklist: [
      "Compile a single-file binary",
      "Drop the toolchain from the runtime layer",
      "Run as a non-root user",
      "Pin the base image digest",
    ],
    estimateMs: hours(5),
  },
  daysAgo(7, 5),
  "s-d4e5f6",
);

// ---- 12) 文案（backlog：还没想清楚，不该被认领） -------------------------
add(
  "copy-deck",
  {
    title: "Write the copy deck for billing and quota strings",
    body: [
      "Quota warnings and billing states are the only strings in the product that were written by an",
      "engineer at 2am. Needs a voice, an error-message pattern, and a decision on whether hitting the",
      "limit is a hard stop or a warning.",
    ].join("\n"),
    priority: 3,
    labels: ["docs", "i18n", "design"],
    status: "backlog",
    checklist: [],
  },
  daysAgo(7, 2),
  "s-j1k2l3",
);

// ---- 13) 管理页 i18n（阻塞中，等文案） -----------------------------------
add(
  "admin-i18n",
  {
    title: "Localize the strings on the admin page",
    body: [
      "The admin page reads the same token dictionary as the board, and one localStorage key",
      "(kanban.locale) drives both — the two surfaces can never disagree about the language.",
      "",
      "Static copy is marked with data-i18n; anything built at runtime goes through the inline t() helper.",
    ].join("\n"),
    priority: 2,
    labels: ["web", "i18n"],
    checklist: [
      "Mark static copy with data-i18n",
      "Wire the locale toggle",
      "Cover both languages in verify:web",
    ],
    estimateMs: hours(6),
  },
  daysAgo(7, 0),
  "s-j1k2l3",
  ["copy-deck"],
);

// ---- 14) 接口限流（待办） ------------------------------------------------
add(
  "ratelimit",
  {
    title: "Rate-limit the /api/ops endpoint",
    body: [
      "One project token is enough to write the entire board, and a runaway agent can burn through",
      "thousands of writes. Token bucket per project key, 240 requests a minute, with Retry-After on the",
      "429 so a well-behaved client backs off instead of retry-storming.",
    ].join("\n"),
    priority: 1,
    labels: ["server", "security"],
    checklist: [
      "Token bucket per project key",
      "Retry-After on 429",
      "Expose the remaining quota in response headers",
    ],
    estimateMs: hours(6),
  },
  daysAgo(5, 6),
  "s-d4e5f6",
  ["isolation"],
);

// ---- 15) SSE 重连（**持有者崩溃 → 被回收**，演示崩溃恢复） ---------------
add(
  "sse-reconnect",
  {
    title: "SSE reconnect with exponential backoff",
    body: [
      "When the server restarts mid-session the browser reconnects immediately, and a flapping proxy turns",
      "that into a reconnect storm. Back off 1s → 2s → 4s → 8s, cap at 30s, reset the counter on the first",
      "frame that actually arrives.",
      "",
      "The stream also has to survive a resume: the client sends Last-Event-ID and the server replays",
      "everything after it.",
    ].join("\n"),
    priority: 1,
    labels: ["web", "realtime", "bug"],
    checklist: [
      "Backoff schedule with a 30s cap",
      "Reset the counter on the first frame",
      "Cover the replay path in tests",
      "Show the retry countdown in the UI",
    ],
    estimateMs: hours(4),
  },
  daysAgo(5, 0),
  "s-m4n5o6",
  ["sse"],
);

// ---- 16) README 恢复流程（待办） ----------------------------------------
add(
  "readme-recovery",
  {
    title: "Document the recovery workflow in the README",
    body: [
      "The recovery story is the reason this project exists and it is currently buried in a note file.",
      "README section: what happens when an agent dies, what the next agent sees in `context`, and how to",
      "reclaim a card by hand.",
    ].join("\n"),
    priority: 3,
    labels: ["docs"],
    checklist: [
      "README: crash → reclaim walkthrough",
      "README: the handoff fields",
      "README: `resume` vs `context`",
    ],
    estimateMs: hours(3),
  },
  daysAgo(3, 4),
  "s-a1b2c3",
  ["crash-handoff", "sse-reconnect"],
);

// ---- 17) 发版（待办，被 4 张卡挡着） ------------------------------------
add(
  "release",
  {
    title: "Cut v0.2.0-rc.1 and publish to the registries",
    body: [
      "Release checklist: CHANGELOG in user-facing language, binaries for the four release platforms, npm",
      "publish for both packages, signed tag. Nothing ships while the recovery workflow is undocumented —",
      "that is the headline feature of this release.",
    ].join("\n"),
    priority: 0,
    labels: ["release"],
    checklist: [
      "Generate the changelog",
      "Build the release binaries",
      "Publish both npm packages",
      "Sign and push the tag",
    ],
    estimateMs: hours(6),
  },
  daysAgo(2, 6),
  "s-a1b2c3",
  ["dark-theme", "mcp-pkg", "docker", "readme-recovery"],
);

// ---- 18) 快捷键（待办，刚建的卡） --------------------------------------
add(
  "shortcuts",
  {
    title: "Keyboard shortcuts for the board",
    body: [
      "Claiming a card should not need the mouse. j/k to move, c to claim, d to drop, / to filter, ? for",
      "the shortcut sheet. The shortcuts have to keep working while the card detail drawer is open, which",
      "means a small focus-trap refactor first.",
    ].join("\n"),
    priority: 4,
    labels: ["web", "design", "dx"],
    checklist: ["Focus trap in the detail drawer", "j/k navigation", "c / d / / / ? bindings"],
    estimateMs: hours(3),
  },
  daysAgo(1, 2),
  "s-j1k2l3",
);

// ---------------------------------------------------------------------------
// 计划：project 级一份 + 任务级三份（其中一张卡有版本链）
//
// 顺序说明：这段刻意排在"剧情"**之前**。core 的写操作一律把 updated_at 设成
// 当前逻辑时钟，所以如果先干活、后补计划，那条更早时间戳的计划写入会把卡片的
// updated_at 拉回过去 —— doctor 立刻报"超过 4 小时没有更新进度"，
// rebuild 也解释不了这张卡到底动过没有。按真实时间线排列就没这个问题。
// ---------------------------------------------------------------------------

// project 级：v0.2 里程碑
as("s-a1b2c3", daysAgo(13, 18)).run((ctx) =>
  savePlan(ctx, {
    scope: "project",
    title: "v0.2 milestone plan: recovery first, packaging second",
    sessionId: "s-a1b2c3",
    body: [
      "## Why this order",
      "",
      "Recovery is the product, packaging is distribution. Nobody cares about an npm package that loses",
      "work when an agent dies, so the recovery path lands first and the release follows it.",
      "",
      "## Milestones",
      "",
      "1. **Storage correctness** — task_deps gains project_key, every read goes through a Scope.",
      "2. **Recovery** — zombie reclaim keeps progress, crash handoffs are synthesized from the journal.",
      "3. **Interfaces** — MCP tools over the same ops, SSE push for the web board.",
      "4. **Distribution** — MCP package, slim Docker image, rc.1.",
      "",
      "## Non-goals for v0.2",
      "",
      "- Multi-writer conflict resolution beyond the conditional-UPDATE claim",
      "- A GUI beyond the web board",
      "- Plan diffing (the history exists, diffing does not)",
    ].join("\n"),
  }),
);

// 任务级：暗色主题（v1 → v2，截图里能看到版本链）
as("s-j1k2l3", daysAgo(10, 2)).run((ctx) =>
  savePlan(ctx, {
    scope: "task",
    taskId: id["dark-theme"]!,
    title: "v1: hand-pick a dark palette per component",
    sessionId: "s-j1k2l3",
    body: [
      "## Approach",
      "",
      "Walk the components and pick a dark value for each one by eye. Fastest path to a dark theme that",
      "does not look broken.",
      "",
      "## Risk",
      "",
      "Every component ends up with its own grey, so the next theme tweak is another sweep. Accepted for now.",
    ].join("\n"),
  }),
);
as("s-j1k2l3", daysAgo(8, 9)).run((ctx) =>
  savePlan(ctx, {
    scope: "task",
    taskId: id["dark-theme"]!,
    title: "v2: semantic tokens, then components read them",
    sessionId: "s-j1k2l3",
    body: [
      "## Supersedes",
      "",
      "The per-component approach in v1. It worked, but it turned the AA fix into a nine-file change",
      "instead of a one-line token change.",
      "",
      "## Approach",
      "",
      "1. Define `--surface`, `--surface-muted`, `--border`, `--text-muted` in `index.css`.",
      "2. Replace every hard-coded hex in `web/src` with a token.",
      "3. Re-check muted text against 4.5:1 — it was failing at 3.1:1.",
      "4. Screenshot both themes so the next person can see what changed.",
      "",
      "## Out of scope",
      "",
      "Dark mode for the terminal board — different surface, different problem.",
    ].join("\n"),
  }),
);

// 任务级：查询隔离（v1）
as("s-a1b2c3", daysAgo(6, 15)).run((ctx) =>
  savePlan(ctx, {
    scope: "task",
    taskId: id.isolation!,
    title: "Sweep every query for a missing project_key predicate",
    sessionId: "s-a1b2c3",
    body: [
      "## Plan",
      "",
      "1. Introduce `Scope { db, projectKey }` and move the reads onto it.",
      "2. Grep for `FROM tasks` / `FROM events` / `FROM handoffs` without a project predicate.",
      "3. Rebuild and export replay the journal without a Scope — handle those separately.",
      "4. Make `doctor` fail loudly when one project holds rows that reference another.",
      "",
      "## Why a Scope object and not a parameter",
      "",
      "Passing `(db, projectKey)` around is one forgotten argument away from a cross-project read. A single",
      "object makes the safe form the only form that type-checks.",
    ].join("\n"),
  }),
);

// ---------------------------------------------------------------------------
// 剧情：把每张卡推到它该在的状态
// ---------------------------------------------------------------------------

/** 认领 → 若干次推进 → 评审 → 完成 */
function carryToDone(
  key: string,
  by: string,
  steps: Array<{ at: number; pct?: number; note?: string; check?: string[] }>,
  finish: { at: number; note: string },
): void {
  const taskId = id[key]!;
  const claimAt = steps[0]!.at - 30 * MIN;
  as(by, claimAt).run((ctx) => claimTask(ctx, taskId, { sessionId: by, now: claimAt, ttlMs: TTL }));
  for (const step of steps) {
    const at = step.at;
    as(by, at).run((ctx) =>
      updateProgress(
        ctx,
        taskId,
        { sessionId: by, now: at, ttlMs: TTL },
        {
          ...(step.pct !== undefined ? { pct: step.pct } : {}),
          ...(step.note ? { note: step.note } : {}),
          ...(step.check ? { check: step.check } : {}),
        },
      ),
    );
  }
  const at = finish.at;
  as(by, at).run((ctx) =>
    transition(ctx, taskId, "review", { sessionId: by, now: at }, { note: "Ready for review" }),
  );
  as(by, at + 12 * MIN).run((ctx) =>
    transition(ctx, taskId, "done", { sessionId: by, now: at + 12 * MIN }, { note: finish.note }),
  );
}

// ---- T-0002 存储迁移：完整走一遍，note 里留下"静默丢数据"的教训 ---------
carryToDone(
  "deps-schema",
  "s-a1b2c3",
  [
    {
      at: daysAgo(13, 0),
      pct: 40,
      check: ["Put project_key in the primary key", "Backfill from the tasks table"],
    },
    {
      at: daysAgo(12, 20),
      pct: 75,
      note: "The silent drop is why this mattered: project B's edges were discarded as duplicates, so the board cheerfully reported 'no dependencies'.",
      check: ["Add idx_deps_project"],
    },
    { at: daysAgo(12, 2), pct: 100, check: ["Multi-project regression test"] },
  ],
  { at: daysAgo(12, 1), note: "Migration is idempotent; schema v4 shipped in 0.1.2" },
);

// ---- T-0003 崩溃交接合成 -------------------------------------------------
carryToDone(
  "crash-handoff",
  "s-a1b2c3",
  [
    { at: daysAgo(12, 0), pct: 30, check: ["Replay the last 12 events for the task"] },
    {
      at: daysAgo(11, 18),
      pct: 70,
      note: "The open-questions heuristic only fires on notes that end in a question mark — kept it that way on purpose, better to miss than to invent.",
      check: [
        "Map unfinished checklist items to next step",
        "Surface unanswered questions from recent notes",
      ],
    },
    { at: daysAgo(11, 2), pct: 100, check: ["Cover the empty-journal case in tests"] },
  ],
  { at: daysAgo(11, 1), note: "All four synthesis rules covered" },
);

// ---- T-0004 僵尸回收 -----------------------------------------------------
carryToDone(
  "reclaim",
  "s-a1b2c3",
  [
    { at: daysAgo(11, 4), pct: 50, check: ["Reap inside a write transaction", "Skip blocked and review cards"] },
    {
      at: daysAgo(10, 20),
      pct: 85,
      note: "Found the real bug while testing: heartbeats were scoped per project, so an agent working in two repos was never reaped.",
      check: ["Reclaim across every project"],
    },
    { at: daysAgo(10, 3), pct: 100, check: ["Attach a crash handoff to each reclaimed card"] },
  ],
  { at: daysAgo(10, 2), note: "Reclaims now cross project boundaries" },
);

// ---- T-0009 冷启动：做到 30% 后取消 --------------------------------------
{
  const sid = "s-a1b2c3";
  as(sid, daysAgo(8, 3)).run((ctx) =>
    claimTask(ctx, id["cold-start"]!, { sessionId: sid, now: daysAgo(8, 3), ttlMs: TTL }),
  );
  as(sid, daysAgo(8, 2)).run((ctx) =>
    updateProgress(
      ctx,
      id["cold-start"]!,
      { sessionId: sid, now: daysAgo(8, 2), ttlMs: TTL },
      {
        pct: 50,
        note: "Sharding got us from 400ms to 210ms; the rest is index work, not caching.",
        check: ["Shard reads by project"],
      },
    ),
  );
  as(sid, daysAgo(4, 5)).run((ctx) =>
    transition(
      ctx,
      id["cold-start"]!,
      "cancelled",
      { sessionId: sid, now: daysAgo(4, 5) },
      {
        reason:
          "Superseded by the project-scoped indexes in the isolation sweep — the query plan already makes this fast enough. Reopen if p95 regresses past 200ms.",
      },
    ),
  );
}

// ---- T-0006 暗色主题：100% 进评审（评审者不是持有者） --------------------
{
  const sid = "s-j1k2l3";
  as(sid, daysAgo(9, 6)).run((ctx) => claimTask(ctx, id["dark-theme"]!, { sessionId: sid, now: daysAgo(9, 6), ttlMs: TTL }));
  as(sid, daysAgo(8, 8)).run((ctx) =>
    updateProgress(
      ctx,
      id["dark-theme"]!,
      { sessionId: sid, now: daysAgo(8, 8), ttlMs: TTL },
      { pct: 45, check: ["Define surface / border / text tokens", "Replace hard-coded hex values"] },
    ),
  );
  as(sid, daysAgo(6, 2)).run((ctx) =>
    updateProgress(
      ctx,
      id["dark-theme"]!,
      { sessionId: sid, now: daysAgo(6, 2), ttlMs: TTL },
      {
        pct: 80,
        note: "Muted text was 3.1:1 — bumped the token, not the component, so every surface inherits the fix.",
        check: ["Check contrast on muted text"],
      },
    ),
  );
  as(sid, daysAgo(5, 4)).run((ctx) =>
    updateProgress(
      ctx,
      id["dark-theme"]!,
      { sessionId: sid, now: daysAgo(5, 4), ttlMs: TTL },
      { pct: 100, check: ["Screenshot both themes"] },
    ),
  );
  as(sid, daysAgo(5, 3)).run((ctx) =>
    transition(ctx, id["dark-theme"]!, "review", { sessionId: sid, now: daysAgo(5, 3) }, { note: "Both themes screenshotted, AA pass" }),
  );
  // 评审者留一条 note（评审不是持有者也能写 note）
  as("s-d4e5f6", daysAgo(5, 1)).run((ctx) =>
    addNote(
      ctx,
      id["dark-theme"]!,
      { sessionId: "s-d4e5f6", now: daysAgo(5, 1), ttlMs: TTL },
      "Looks right in both themes. Approving once the card subtitle is re-checked at 200% zoom.",
    ),
  );
}

// ---- T-0011 Docker：评审中，中途留了交接并被评审者消费 --------------------
{
  const sid = "s-d4e5f6";
  as(sid, daysAgo(6, 20)).run((ctx) => claimTask(ctx, id.docker!, { sessionId: sid, now: daysAgo(6, 20), ttlMs: TTL }));
  as(sid, daysAgo(6, 12)).run((ctx) =>
    updateProgress(
      ctx,
      id.docker!,
      { sessionId: sid, now: daysAgo(6, 12), ttlMs: TTL },
      { pct: 50, check: ["Compile a single-file binary", "Drop the toolchain from the runtime layer"] },
    ),
  );
  // 主动交接：写给下一个可能接手的人（含 blockers / open question）
  const handoffId = as(sid, daysAgo(6, 2)).run((ctx) =>
    writeHandoff(ctx, {
      taskId: id.docker!,
      sessionId: sid,
      summary:
        "Runtime image is down from 1.4 GB to 96 MB — the binary is statically linked, so the runtime layer needs nothing but glibc.",
      nextStep: "Add the non-root user, pin the base image by digest, then run the image through verify:deploy.",
      blockers: ["The base image tag moved twice this week — pinning by digest is not optional"],
      openQuestions: ["Do we keep a shell in the image for debugging, or ship a separate debug target?"],
    }),
  ).id;
  as(sid, daysAgo(5, 22)).run((ctx) =>
    updateProgress(
      ctx,
      id.docker!,
      { sessionId: sid, now: daysAgo(5, 22), ttlMs: TTL },
      { pct: 100, check: ["Run as a non-root user", "Pin the base image digest"] },
    ),
  );
  as(sid, daysAgo(5, 20)).run((ctx) =>
    transition(ctx, id.docker!, "review", { sessionId: sid, now: daysAgo(5, 20) }, { note: "Ready for review — image is 96 MB" }),
  );
  // 评审者先读交接再标记消费（截图里能看到"已消费"角标）
  as("s-j1k2l3", daysAgo(5, 19)).run((ctx) => {
    consumeHandoff(ctx, handoffId, "s-j1k2l3");
    return addNote(
      ctx,
      id.docker!,
      { sessionId: "s-j1k2l3", now: daysAgo(5, 19), ttlMs: TTL },
      "Read the handoff first, then the diff. Shipping a separate debug target instead of keeping a shell in the runtime image.",
    );
  });
}

// ---- T-0008 隔离改造：进行中，带任务级计划 ------------------------------
{
  const sid = "s-a1b2c3";
  as(sid, daysAgo(6, 14)).run((ctx) => claimTask(ctx, id.isolation!, { sessionId: sid, now: daysAgo(6, 14), ttlMs: TTL }));
  as(sid, daysAgo(6, 10)).run((ctx) =>
    updateProgress(
      ctx,
      id.isolation!,
      { sessionId: sid, now: daysAgo(6, 10), ttlMs: TTL },
      { pct: 25, check: ["Scope object for all reads"] },
    ),
  );
  as(sid, daysAgo(4, 3)).run((ctx) =>
    addNote(
      ctx,
      id.isolation!,
      { sessionId: sid, now: daysAgo(4, 3), ttlMs: TTL },
      "The rebuild path was the interesting one: it replays the journal without a Scope, so it was the last place a cross-project row could leak in.",
    ),
  );
  as(sid, daysAgo(0, 2)).run((ctx) =>
    updateProgress(
      ctx,
      id.isolation!,
      { sessionId: sid, now: daysAgo(0, 2), ttlMs: TTL },
      {
        pct: 50,
        note: "Rebuild path filtered; the doctor check is next.",
        check: ["Rebuild path filters by project"],
      },
    ),
  );
}

// ---- T-0010 SSE：进行中，刚推过进度（时间线上最新的一条） ---------------
{
  const sid = "s-d4e5f6";
  as(sid, daysAgo(2, 6)).run((ctx) => claimTask(ctx, id.sse!, { sessionId: sid, now: daysAgo(2, 6), ttlMs: TTL }));
  as(sid, daysAgo(1, 8)).run((ctx) =>
    updateProgress(
      ctx,
      id.sse!,
      { sessionId: sid, now: daysAgo(1, 8), ttlMs: TTL },
      { pct: 45, check: ["Stream project-filtered events", "Resume from Last-Event-ID"] },
    ),
  );
  as(sid, daysAgo(0, 6)).run((ctx) =>
    updateProgress(
      ctx,
      id.sse!,
      { sessionId: sid, now: daysAgo(0, 6), ttlMs: TTL },
      {
        pct: 70,
        note: "For whoever writes the screenshot script: --virtual-time-budget never fires with an open SSE connection — pass static=1 to skip the stream.",
        check: ["Show a reconnect banner"],
      },
    ),
  );
}

// ---- T-0001 里程碑父卡：进行中，勾了一半 -------------------------------
{
  const sid = "s-a1b2c3";
  as(sid, daysAgo(13, 20)).run((ctx) => claimTask(ctx, id.epic!, { sessionId: sid, now: daysAgo(13, 20), ttlMs: TTL }));
  as(sid, daysAgo(10, 1)).run((ctx) =>
    updateProgress(
      ctx,
      id.epic!,
      { sessionId: sid, now: daysAgo(10, 1), ttlMs: TTL },
      { pct: 45, check: ["Zombie reclaim preserves progress", "Crash handoff synthesis"] },
    ),
  );
  as(sid, daysAgo(0, 1)).run((ctx) =>
    addNote(
      ctx,
      id.epic!,
      { sessionId: sid, now: daysAgo(0, 1), ttlMs: TTL },
      "Two of four done. The MCP package is the long pole; the README section is the one people will actually read.",
    ),
  );
}

// ---- T-0012 管理页 i18n：阻塞中 -----------------------------------------
as("s-j1k2l3", daysAgo(3, 1)).run((ctx) =>
  transition(
    ctx,
    id["admin-i18n"]!,
    "blocked",
    { sessionId: "s-j1k2l3", now: daysAgo(3, 1) },
    { reason: "Waiting on the copy deck for the billing and quota strings — @design owes us a pass by Friday." },
  ),
);

// ---------------------------------------------------------------------------
// 崩溃回收：gpt-nightly 失联 → 卡回到待办（进度保留）→ 同事接手并留交接
// ---------------------------------------------------------------------------

/**
 * 这里手工复刻 reapZombies 的前两步，**不**调用它本身。
 *
 * 原因：reapZombies 会在同一个事务里调用 synthesizeCrashHandoff，而合成出来的
 * 交接文案是硬编码中文（"原持有者 … 失联"）。本脚本要造的是全英文看板，
 * 所以走等价的 SQL + 事件，但不生成那条自动交接；改由接手方写一条英文的
 * reclaim 交接 —— 这也更贴近真实的接手场景。
 *
 * SQL 与事件字段与 reapZombies 逐字对齐，保证 rebuild 重放的结果一致。
 */
const CRASH_SESSION = "s-m4n5o6";
const CRASH_TASK = id["sse-reconnect"]!;
const CRASH_AT = daysAgo(0, 5); // 5 小时前失联
const CRASH_LAST_SEEN = daysAgo(0, 5, 30);

// 1) 崩溃前它做到 40%：两张检查项已勾
as(CRASH_SESSION, daysAgo(0, 9)).run((ctx) =>
  claimTask(ctx, CRASH_TASK, { sessionId: CRASH_SESSION, now: daysAgo(0, 9), ttlMs: TTL }),
);
as(CRASH_SESSION, daysAgo(0, 6)).run((ctx) =>
  updateProgress(
    ctx,
    CRASH_TASK,
    { sessionId: CRASH_SESSION, now: daysAgo(0, 6), ttlMs: TTL },
    { pct: 40, check: ["Backoff schedule with a 30s cap", "Reset the counter on the first frame"] },
  ),
);
as(CRASH_SESSION, CRASH_LAST_SEEN).run((ctx) =>
  addNote(
    ctx,
    CRASH_TASK,
    { sessionId: CRASH_SESSION, now: CRASH_LAST_SEEN, ttlMs: TTL },
    "Should the countdown keep running while the tab is in the background, or pause it?",
  ),
);
touchSession(raw, CRASH_SESSION, CRASH_LAST_SEEN);

// 2) 失联判定：会话标记 crashed，卡回到 todo（进度与 checklist 原样保留）
withTx(
  raw,
  (ctx) => {
    ctx.db.query("UPDATE sessions SET status = 'crashed' WHERE id = ?").run(CRASH_SESSION);
    ctx.emit({
      type: "session_crashed",
      sessionId: CRASH_SESSION,
      projectKey: "system",
      data: { grace_ms: 10 * MIN, last_seen_at: CRASH_LAST_SEEN, silent_ms: 5 * HOUR },
    });
    ctx.db
      .query(
        `UPDATE tasks
            SET status = 'todo', assignee_session_id = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE id = ? AND status = 'doing'`,
      )
      .run(CRASH_AT, CRASH_TASK);
    ctx.emit({
      type: "task_reclaimed",
      taskId: CRASH_TASK,
      data: { holder_crashed: true, crashed_session: CRASH_SESSION, prev_progress: 40, silent_ms: 5 * HOUR },
    });
  },
  { now: () => CRASH_AT, sessionId: "system", projectKey },
);

// 3) 接手方（claude-web）留下英文交接：卡还在 todo，等一个会话来认领
as("s-d4e5f6", daysAgo(0, 4)).run((ctx) =>
  writeHandoff(ctx, {
    taskId: CRASH_TASK,
    sessionId: "s-d4e5f6",
    kind: "reclaim",
    summary:
      "Picked this up after the nightly agent went silent. It left the backoff schedule and the counter reset done, at 40% — the replay path and the countdown UI are untouched.",
    nextStep:
      "Start from the replay path: assert that a reconnect carrying Last-Event-ID replays every event after the cursor, then decide the background-tab behaviour the nightly agent left as an open question.",
    blockers: [
      "The original holder is gone, so there is nobody to ask about the background-tab question — treat it as an open design call",
    ],
    openQuestions: ["Should the reconnect countdown keep running while the tab is in the background?"],
  }),
);

// ---------------------------------------------------------------------------
// 给"进行中"的卡补一次心跳续租
// ---------------------------------------------------------------------------

/**
 * doing 的卡必须在租约有效期内才有意义：租约是"认领时间 + 15 分钟"，
 * 而剧情里的认领发生在几小时 / 几天前，直接看会显示"租约已过期"。
 *
 * 真实运行时这由 agent 每隔几分钟的 progress/note 调用隐式完成
 * （updateProgress 会顺手续租），所以这里显式补一次 —— 语义完全一致：
 * 持有者刚刚还活着。renewLease 不写事件（租约续租按设计不进事件流），
 * 所以时间线与 rebuild 结果都不受影响。
 */
for (const task of listTasks({ db: raw, projectKey }, { status: "doing" })) {
  as(task.assigneeSessionId, NOW - 90 * 1000).run((ctx) =>
    renewLease(ctx, task.id, { sessionId: task.assigneeSessionId, now: NOW - 90 * 1000, ttlMs: TTL }, TTL),
  );
}

// ---------------------------------------------------------------------------
// 收尾：把 core 自动生成的中文备注换成英文（保持"全英文看板"）
// ---------------------------------------------------------------------------

/**
 * updateProgress 在勾选 checklist 后会自动追加一条 task_note，文案是硬编码中文
 * （"检查项更新（2/4 完成）"）。Web 时间线直接渲染 data.text，所以英文看板里会
 * 混进中文。这里只改事件里的展示文本，不碰任何投影字段，因此 rebuild 重放
 * 结果不变（note 的 text 不参与投影）。
 *
 * 注意两段替换的切分点：原文是 "检查项更新（" + "2/4" + " 完成）"，
 * 所以第二段要连前导空格一起换掉，否则会拼出 "(2/4  done)" 的双空格。
 *
 * 之所以不绕开勾选功能：带勾选状态的 checklist 正是截图里最想看到的东西。
 */
const localized = raw
  .query<{ n: number }, [string, string, string, string, string]>(
    `UPDATE events
        SET data = replace(replace(data, ?, ?), ?, ?)
      WHERE type = 'task_note' AND data LIKE ?`,
  )
  .run("检查项更新（", "Checklist updated (", " 完成）", " done)", "%检查项更新（%");

setMeta(raw, "demo_seeded_at", String(NOW));
setMeta(raw, "demo_seeded_count", String(Object.keys(id).length));

// ---- 全英文自检：任何一处中文残留都直接失败 ----

/**
 * 上面已经把已知的两处中文（checklist 备注、崩溃交接）处理掉了，但 core 里
 * 以后可能再添新的自动文案。与其等到截图拍完才发现看板里有一行中文，
 * 不如灌完数据当场扫一遍：事件 data、卡标题/描述/阻塞理由、交接、计划正文。
 */
const CJK = /[\u4e00-\u9fff]/;
const residue: string[] = [];
for (const row of raw
  .query<{ task_id: string | null; type: string; data: string | null }, [string]>(
    "SELECT task_id, type, data FROM events WHERE project_key = ?",
  )
  .all(projectKey)) {
  if (row.data && CJK.test(row.data)) residue.push(`event ${row.type} ${row.task_id ?? ""}: ${row.data.slice(0, 80)}`);
}
for (const t of listTasks({ db: raw, projectKey }, { includeTerminal: true })) {
  for (const value of [t.title, t.body, t.blockReason ?? ""]) {
    if (CJK.test(value)) residue.push(`task ${t.id}: ${value.slice(0, 80)}`);
  }
}
for (const h of raw
  .query<{ summary: string; next_step: string | null }, [string]>(
    "SELECT summary, next_step FROM handoffs WHERE project_key = ?",
  )
  .all(projectKey)) {
  if (CJK.test(h.summary) || (h.next_step && CJK.test(h.next_step))) {
    residue.push(`handoff: ${h.summary.slice(0, 80)}`);
  }
}
if (residue.length > 0) {
  die(
    `数据里有 ${residue.length} 处中文，会污染英文截图：\n    ${residue.slice(0, 5).join("\n    ")}`,
    "多半是 core 又新增了硬编码中文的自动文案，需要在脚本里像 checklist 备注那样处理掉",
  );
}

// ---------------------------------------------------------------------------
// 汇总输出
// ---------------------------------------------------------------------------

const counts = countByStatus({ db: raw, projectKey });
const all = listTasks({ db: raw, projectKey }, { includeTerminal: true, sort: "id" });
const depCount =
  raw
    .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM task_deps WHERE project_key = ?")
    .get(projectKey)?.n ?? 0;
const planCount =
  raw.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM plans WHERE project_key = ?").get(projectKey)?.n ?? 0;

console.log(`✓ 模拟数据已写入 ${dbPath}`);
console.log(`  project  ${projectKey}  (${displayName})`);
console.log(
  `  任务 ${all.length} 张 · 会话 ${SESSIONS.length} 个（3 活跃 · 1 收工 · 1 崩溃） · 依赖 ${depCount} 条 · 计划 ${planCount} 份`,
);
console.log(`  失联宽限 ${GRACE_MIN} 分钟（--grace 可改；改回 10 即 core 默认值）`);
console.log(
  `  状态分布  ${(Object.keys(counts) as TaskStatus[])
    .filter((s) => counts[s] > 0)
    .map((s) => `${s}=${counts[s]}`)
    .join("  ")}`,
);
console.log(`  checklist 备注本地化：${localized.changes ?? 0} 条事件`);

if (!quiet) {
  console.log("");
  for (const t of all) {
    const pct = t.status === "done" || t.status === "cancelled" ? "" : ` ${String(t.progress).padStart(3)}%`;
    const checks =
      t.checklist.length > 0 ? ` [${t.checklist.filter((c) => c.done).length}/${t.checklist.length}]` : "";
    const who = t.assigneeSessionId ? ` @${t.assigneeSessionId}` : "";
    console.log(`  ${t.id}  p${t.priority}  ${t.status.padEnd(9)}${pct}${checks}${who}  ${t.title}`);
  }
}

console.log("");
console.log("下一步：");
console.log(`  bun run src/cli.ts --db ${dbPath} board`);
console.log(`  bun run src/cli.ts --db ${dbPath} context`);
console.log(`  bun run src/cli.ts --db ${dbPath} task list --ready`);
console.log(`  bun run src/cli.ts --db ${dbPath} serve --port 7788   # 浏览器看板`);

raw.close();
