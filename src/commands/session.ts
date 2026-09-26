/**
 * `kanban session ...` —— 会话生命周期命令。
 *
 * 与任务命令一样走 Op（ADR-10），因此本地/远程行为一致。
 * 失联判定与自动回收在 core/sessions.ts 的 reapZombies 中，
 * 由 openCtx 每次调用时隐式触发（见 ADR-4 L2）。
 */

import { ExitCode, KanbanError, type ExitCodeValue } from "../core/errors.ts";
import { assertKnownOptions, getBool, getString, parseArgs } from "./args.ts";
import {
  closeCtx,
  openCtx,
  resolveSessionId,
  writeSessionFile,
  type CtxOptions,
} from "./context.ts";
import { createOutput } from "./output.ts";

const USAGE = `用法：
  kanban session start --agent <名字> [--harness pi|claude-code|cursor|human] [--id s-xxx]
  kanban session list [--all] [--json]
  kanban session heartbeat [--session <id>]
  kanban session end [--summary "本次做了什么"] [--session <id>]

说明：
  start 会把 session_id 写入 .kanban/session，之后的命令无需再传 --session。
  远程模式下 session 仍然在 server 侧创建（--session 只影响身份传递）。`;

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
      throw KanbanError.usage(`未知子命令：session ${sub}`, USAGE);  }
}

/** 通用选项集合（所有 session 子命令共享） */
const COMMON_STRINGS = ["db", "session", "server", "project", "key"];

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
      "缺少 --agent <名字>",
      "用法：kanban session start --agent pi-main --harness pi\n名字会出现在看板与冲突提示里，用能区分用途的名字（如 pi-main / claude-fix）",
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

    // 本地模式：写便捷文件，后续命令免传 --session（远程模式不写本地状态）
    if (!getBool(args, "no-write") && ctx.backend.mode === "local") {
      writeSessionFile(ctx, String(session.id));
    }

    out.line(`${styleGreen("✓")} 会话已注册`);
    out.line(`  session_id : ${session.id}`);
    out.line(`  agent      : ${session.agent_name}${session.harness ? ` (${session.harness})` : ""}`);
    out.line(`  project    : ${ctx.project.key}`);
    out.line("");
    out.line(`接着执行 \`kanban context\` 读取当前现场：未消费的交接、正在做的卡、可认领任务。`);

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
      out.line("（暂无会话）用 `kanban session start --agent <名字>` 注册");
      return ExitCode.OK;
    }

    out.line(`会话（${views.length}）`.padEnd(10) + "ID".padEnd(13) + "状态".padEnd(12) + "心跳".padEnd(10) + "持有任务");
    for (const v of views) {
      const stale = v.stale === true && v.status !== "crashed";
      const status = stale ? "⚠ 疑似失联" : sessionStatusLabel(String(v.status));
      const tasks = (v.tasks as string[] | undefined) ?? [];
      out.line(
        "  ".padEnd(4) +
          String(v.id).padEnd(11) +
          padEnd(String(v.agent_name), 13) +
          status.padEnd(12) +
          String(v.fresh ?? "?").padEnd(10) +
          (tasks.length > 0 ? tasks.join(", ") : "-"),
      );
    }
    out.line("");
    out.line("说明：⚠ 疑似失联 = 超过宽限时间未见心跳；其任务将被自动回收（进度保留）");
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
    out.line(`${styleGreen("✓")} 会话心跳已刷新（续期任务：${result.renewed_tasks.length} 张）`);
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
    out.line(`${styleGreen("✓")} 会话 ${result.session_id} 已关闭`);
    if (result.released.length > 0) {
      out.line(`  释放任务（进度已保留）：${result.released.join(", ")}`);
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
      return "活跃";
    case "idle":
      return "空闲";
    case "closed":
      return "已关闭";
    case "crashed":
      return "已失联";
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
