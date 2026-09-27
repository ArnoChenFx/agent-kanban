/**
 * `agent-kanban session ...` —— 会话生命周期命令。
 *
 * 与任务命令一样走 Op（ADR-10），因此本地/远程行为一致。
 * 失联判定与自动回收在 core/sessions.ts 的 reapZombies 中，
 * 由 openCtx 每次调用时隐式触发（见 ADR-4 L2）。
 */

import { ExitCode, KanbanError, type ExitCodeValue } from "../core/errors.ts";
import { resolveSessionKey } from "../core/paths.ts";
import { assertKnownOptions, getBool, getString, parseArgs } from "./args.ts";
import {
  closeCtx,
  openCtx,
  resolveSessionId,
  writeSessionFile,
  type CtxOptions,
} from "./context.ts";
import { createOutput } from "./output.ts";

const USAGE = `Usage:
  agent-kanban session start --agent <name> [--harness <name>] [--id s-xxx] [--no-write]
  agent-kanban session list [--all] [--json]
  agent-kanban session heartbeat [--session <id>]
  agent-kanban session end [--summary "what you did"] [--session <id>]

Notes:
  start writes session_id into .kanban/sessions/<identity-key> (falling back to .kanban/session
  when no identity key can be derived), so later commands need no --session.
  That happens in remote mode too: the file records which agent this machine is, not board
  state (the server holds the board, and config.toml lives in the same local .kanban/).
  Pass --no-write to skip it when the caller already passes the session id itself.
  The identity key is resolved in this order:
    1. $KANBAN_SESSION_KEY                        (any stable unique value)
    2. the harness session variable, e.g. PI_SESSION_ID (pi), PI_SESSION_FILE (oh-my-pi),
       CLAUDE_CODE_SESSION_ID (claude-code), GROK_SESSION_ID (grok)
    3. any other <TOOL>_SESSION_ID found in the environment
  --harness is free-form and only labels the session on the board; it does not pick the key.
  Set $KANBAN_SESSION_KEY when your tool exports nothing usable (cursor-agent, codex).
  Agents sharing one directory therefore stay separate automatically.
  In remote mode the session is created on the server, and the same local identity file is
  written, so a remote project behaves exactly like a local one.`;

export async function cmdSession(argv: string[]): Promise<ExitCodeValue> {
  const sub = argv[0];
  const rest = argv.slice(1);

  switch (sub) {
    case "start":
      return sessionStart(rest);
    case "list":
      return sessionList(rest);
    case "heartbeat":
      return sessionHeartbeat(rest);
    case "end":
      return sessionEnd(rest);
    case undefined:
    case "help":
    case "--help":
      process.stdout.write(USAGE + "\n");
      return ExitCode.OK;
    default:
      throw KanbanError.usage(`unknown subcommand: session ${sub}`, USAGE);  }
}

/** 通用选项集合（所有 session 子命令共享） */
const COMMON_STRINGS = ["db", "session", "server", "project", "key"];

/**
 * Qoder 桌面端目前（2026-09）不向工具子进程注入任何会话变量（核实过程见
 * src/core/paths.ts 末尾），身份会退化到旧单文件。它唯一的对外通道是在 skill
 * 文本里替换 ${QODER_SESSION_ID}——这里提示一句，让只按 AGENTS.md 干活、
 * 没加载 skill 的 agent 也能发现。走 stderr：--json 模式 stdout 只能有单个 JSON。
 */
function qoderIdentityHint(): string | null {
  const inQoder = Object.keys(process.env).some(
    (k) => k.startsWith("QODER_") || k.startsWith("QODERCN_"),
  );
  if (!inQoder) return null;
  return (
    "note: Qoder injects no session-id env var; identity falls back to the shared .kanban/session file. " +
    'Inside a Qoder skill, "${QODER_SESSION_ID}" is substituted with this session\'s real UUID - ' +
    "prefix every command with KANBAN_SESSION_KEY=qoder-<that-uuid> for per-session identity."
  );
}

/** 注册会话 */
async function sessionStart(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "help", "no-write"],
    strings: ["agent", "harness", "id", ...COMMON_STRINGS],
    short: { j: "json", h: "help", a: "agent" },
  });
  assertKnownOptions(args, ["json", "help", "no-write", "agent", "harness", "id", ...COMMON_STRINGS]);
  const out = createOutput(getBool(args, "json"));

  const agentName = getString(args, "agent");
  if (!agentName) {
    throw KanbanError.usage(
      "missing --agent <name>",
      "Usage: agent-kanban session start --agent pi-main --harness pi\n" +
        "The name shows up on the board and in conflict messages; use a name that tells purposes apart (e.g. pi-main / claude-fix)",
    );
  }

  const ctx = openCtx(ctxOpts(args));
  try {
    const { data } = await ctx.backend.executeWithHints({
      kind: "session.start",
      params: {
        agent_name: agentName,
        harness: getString(args, "harness"),
        id: getString(args, "id"),
      },
    });
    const session = data as Record<string, unknown>;

    // 写本机身份文件，让后续命令免传 --session。
    //
    // ⚠ **本地与远程都要写**。曾经的实现是 `&& ctx.backend.mode === "local"`，
    // 理由大概是“远程模式下状态在 server，别碰本地”。但**读的一侧没跟着改**：
    // `currentSessionId()` 不分模式，照样去读 `.kanban/sessions/<key>`。于是
    // 远程模式下 `session start` 报告成功、打印 session_id 与 identity key，
    // 却一个字节都没落地（`.kanban` 目录甚至没被创建），紧接着的
    // `task claim` 报 `missing session id, cannot tell who is operating`。
    //
    // 身份文件记的是**“这台机器上我是谁”**，不是看板状态：远程模式下
    // config.toml 同样在本机 `.kanban/` 里，身份文件放这儿毫无矛盾。
    // 真正该跳过的场合是显式的 `--no-write`（调用方自己管身份，
    // 比如脚本里已经在用 KANBAN_SESSION）。
    const wroteFile = !getBool(args, "no-write");
    if (wroteFile) {
      writeSessionFile(ctx, String(session.id));
    }
    // 反映实际结果（ops.ts 里曾硬编码 false —— 本地模式下明明写了却说没写）
    session.written_session_file = wroteFile;

    out.line(`${styleGreen("✓")} Session registered`);
    out.line(`  session_id : ${session.id}`);
    out.line(`  agent      : ${session.agent_name}${session.harness ? ` (${session.harness})` : ""}`);
    out.line(`  project    : ${ctx.project.key}`);
    // 打出 identity key：同目录并行时这是唯一能确认"我到底是谁"的凭据，
    // 排查串号时第一件事就是对比两个 agent 的这一行
    const key = resolveSessionKey();
    if (key) out.line(`  identity   : ${key}`);
    else {
      out.line(`  identity   : (none — sharing .kanban/session with every other agent in this directory)`);
      const hint = qoderIdentityHint();
      if (hint) process.stderr.write(hint + "\n");
    }
    out.line("");
    out.line(`Next run \`agent-kanban context\` to read the situation: unconsumed handoffs, in-progress cards, claimable tasks.`);

    out.data(session);
    return ExitCode.OK;
  } finally {
    closeCtx(ctx);
  }
}

/** 列出会话 */
async function sessionList(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "all", "help"],
    strings: COMMON_STRINGS,
    short: { j: "json", a: "all", h: "help" },
  });
  assertKnownOptions(args, ["json", "all", "help", ...COMMON_STRINGS]);
  const json = getBool(args, "json");
  const out = createOutput(json);
  const ctx = openCtx(ctxOpts(args));

  try {
    const { data } = await ctx.backend.executeWithHints({
      kind: "session.list",
      params: { include_closed: getBool(args, "all") },
    });
    const views = data as Array<Record<string, unknown>>;

    if (json) {
      out.data(views);
      return ExitCode.OK;
    }
    if (views.length === 0) {
      out.line("(no sessions yet) register one with `agent-kanban session start --agent <name>`");
      return ExitCode.OK;
    }

    // 表头列宽对齐下面的行：2 缩进 + id(12) / agent(13) / status(12) / heartbeat(10)
    out.line(
      "  " + `Sessions (${views.length})`.padEnd(14) + "ID".padEnd(13) + "Status".padEnd(12) + "Heartbeat".padEnd(10) + "Tasks held",
    );
    for (const v of views) {
      const stale = v.stale === true && v.status !== "crashed";
      const status = stale ? "⚠ possibly stale" : sessionStatusLabel(String(v.status));
      const tasks = (v.tasks as string[] | undefined) ?? [];
      out.line(
        "  ".padEnd(4) +
          String(v.id).padEnd(12) +
          padEnd(String(v.agent_name), 13) +
          status.padEnd(12) +
          String(v.fresh ?? "?").padEnd(10) +
          (tasks.length > 0 ? tasks.join(", ") : "-"),
      );
    }
    out.line("");
    out.line("Note: ⚠ possibly stale = no heartbeat within the grace period; its tasks are reaped automatically (progress preserved)");
    return ExitCode.OK;
  } finally {
    closeCtx(ctx);
  }
}

/** 心跳续期 */
async function sessionHeartbeat(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "help"],
    strings: COMMON_STRINGS,
    short: { j: "json", h: "help" },
  });
  assertKnownOptions(args, ["json", "help", ...COMMON_STRINGS]);
  const out = createOutput(getBool(args, "json"));
  const ctx = openCtx(ctxOpts(args));

  try {
    // 心跳需要明确的 session 身份
    resolveSessionId(ctx, getString(args, "session"));
    const { data } = await ctx.backend.executeWithHints({
      kind: "session.heartbeat",
      params: {},
    });
    const result = data as { renewed_tasks: string[] };
    out.line(`${styleGreen("✓")} Session heartbeat refreshed (leases renewed: ${result.renewed_tasks.length})`);
    out.data(data);
    return ExitCode.OK;
  } finally {
    closeCtx(ctx);
  }
}

/** 结束会话 */
async function sessionEnd(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "help"],
    strings: [...COMMON_STRINGS, "summary"],
    short: { j: "json", h: "help", s: "summary" },
  });
  assertKnownOptions(args, ["json", "help", ...COMMON_STRINGS, "summary"]);
  const out = createOutput(getBool(args, "json"));
  const ctx = openCtx(ctxOpts(args));

  try {
    const { data } = await ctx.backend.executeWithHints({
      kind: "session.end",
      params: { summary: getString(args, "summary") },
    });
    const result = data as { session_id: string; released: string[] };
    out.line(`${styleGreen("✓")} Session ${result.session_id} closed`);
    if (result.released.length > 0) {
      out.line(`  released tasks (progress preserved): ${result.released.join(", ")}`);
    }
    out.data(data);
    return ExitCode.OK;
  } finally {
    closeCtx(ctx);
  }
}

// ---- 本地小工具 ----

/** 绿色勾选标记（避免为一个字符引入整个 format 模块） */
function styleGreen(text: string): string {
  return process.env.NO_COLOR ? text : `\x1b[32m${text}\x1b[0m`;
}

/** 简单左对齐补空格（会话列表内容都是 ASCII/中文混排，够用） */
function padEnd(text: string, width: number): string {
  let w = 0;
  let out = "";
  for (const ch of text) {
    w += /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1;
    out += ch;
  }
  return out + " ".repeat(Math.max(0, width - w));
}

function sessionStatusLabel(status: string): string {
  switch (status) {
    case "active":
      return "Active";
    case "idle":
      return "Idle";
    case "closed":
      return "Closed";
    case "crashed":
      return "Crashed";
    default:
      return status;
  }
}

function ctxOpts(args: { options: Record<string, string | boolean> }): CtxOptions {
  return {
    json: getBool(args as never, "json"),
    dbPath: getString(args as never, "db"),
    sessionId: getString(args as never, "session"),
    server: getString(args as never, "server"),
    project: getString(args as never, "project"),
    key: getString(args as never, "key"),
  };
}
