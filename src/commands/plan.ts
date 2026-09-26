/**
 * `agent-kanban plan` —— 计划版本化。
 *
 * 为什么要这么啰嗦：一个 agent 做长任务时计划一定会变。如果只留最新计划，
 * 换个会话就说不清"当时为什么那么决定"。所以这里每次保存都产生一个新版本，
 * 旧版本留在链上可回溯。
 *
 * 典型用法：
 *   agent-kanban plan save --task T-0007 --title "拆成 4 个里程碑" --body-file plan.md
 *   agent-kanban plan show PL-T-0007-01        # 读全文
 *   agent-kanban plan history --task T-0007    # 这个计划改了几次
 *   agent-kanban plan list --all               # 含已被顶替的历史版本
 */

import { readFileSync } from "node:fs";
import { ExitCode, type ExitCodeValue } from "../core/errors.ts";
import { padEndWidth, relativeTime, style, truncate } from "../core/format.ts";
import type { Op } from "../core/ops.ts";
import { assertKnownOptions, getBool, getInt, getString, parseArgs, requirePositional } from "./args.ts";
import { closeCtx, openCtx, resolveSessionId } from "./context.ts";
import { createOutput, type Output } from "./output.ts";

const USAGE = `Usage:
  agent-kanban plan save --title "title" [--task T-0007] [--body-file <path> | --body "..."]
  agent-kanban plan show <plan id> [--json]
  agent-kanban plan list [--task T-0007] [--all] [--json]
  agent-kanban plan history <plan id> [--json]             # version chain: how many times this plan changed
  agent-kanban plan at --task T-0007 --ts <timestamp>      # the plan in effect at that moment
  agent-kanban plan attach <plan id> --task T-0007         # point a task at one version

Notes:
  · --body is required: the title is one line, the body is where the plan's value is
  · every save creates a new version, the old one turns superseded (nothing is lost)
  · a task-scoped plan (--task) is attached to that task automatically, same as attach

Example:
  agent-kanban plan save --task T-0007 \\
    --title "split into 4 milestones" \\
    --body-file .kanban/plans/T-0007.md`;

export async function cmdPlan(argv: string[]): Promise<ExitCodeValue> {
  const sub = argv[0];
  switch (sub) {
    case "save":
      return planSave(argv.slice(1));
    case "show":
      return planShow(argv.slice(1));
    case "list":
      return planList(argv.slice(1));
    case "history":
      return planHistoryCmd(argv.slice(1));
    case "at":
      return planAt(argv.slice(1));
    case "attach":
      return planAttach(argv.slice(1));
    case undefined:
    case "help":
    case "--help":
    case "-h": {
      process.stdout.write(USAGE + "\n");
      return ExitCode.OK;
    }
    default: {
      process.stdout.write(USAGE + "\n");
      return ExitCode.USAGE;
    }
  }
}

// =============================================================================
// plan save
// =============================================================================

async function planSave(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "help", "no-attach"],
    strings: ["title", "body", "body-file", "task", "session", "db", "server", "project", "key"],
    short: { j: "json", h: "help", t: "task" },
  });
  assertKnownOptions(args, [
    "json", "help", "no-attach", "title", "body", "body-file",
    "task", "session", "db", "server", "project", "key",
  ]);
  const json = getBool(args, "json");
  const out = createOutput(json);
  const ctx = openCtx(ctxOptions(args, json));

  try {
    if (getBool(args, "help")) {
      out.line(USAGE);
      return ExitCode.OK;
    }

    // 正文来源：--body-file（推荐，长文本不经过 shell）> --body > 位置参数
    const bodyFile = getString(args, "body-file");
    const body = bodyFile ? readFileSync(bodyFile, "utf8") : getString(args, "body") ?? args.positionals[0];
    const title = getString(args, "title") ?? args.positionals[1];
    const taskId = getString(args, "task");

    if (!body) {
      out.line("Error: missing plan body");
      out.line("");
      out.line("The body is where the plan's value is. Provide it in one of these ways:");
      out.line('  --body-file <path>    read from a file (recommended, long text avoids shell quoting hell)');
      out.line('  --body "..."          inline markdown');
      out.line("");
      out.line("A template to start from:");
      out.line("  ## Goal");
      out.line("  ## Steps");
      out.line("  1. ");
      out.line("  ## Risks / open questions");
      return ExitCode.USAGE;
    }

    const { data } = await ctx.backend.executeWithHints({
      kind: "plan.save",
      params: {
        scope: taskId ? "task" : "project",
        task_id: taskId ?? null,
        title: title ?? "",
        body,
        session_id: resolveSessionId(ctx, getString(args, "session")),
        attach: !getBool(args, "no-attach"),
      },
    });
    const plan = data as {
      id: string; version: number; title: string; status: string;
      task_id: string | null; supersedes_id: string | null;
    };

    if (json) {
      out.data(plan);
      return ExitCode.OK;
    }

    out.line(`${style.green("✓")} Plan saved ${style.cyan(plan.id)} ${style.gray(`v${plan.version}`)}`);
    out.line(`  ${plan.title}`);
    if (plan.supersedes_id) {
      out.line(`  ${style.gray(`supersedes the previous version ${plan.supersedes_id} (the old version is still readable)`)}`);
    }
    if (plan.task_id) {
      out.line(`  ${style.gray(`attached to ${plan.task_id}, agent resume will read it automatically`)}`);
    }
    out.line("");
    out.line(style.gray(`  Read the full text: agent-kanban plan show ${plan.id}`));
    out.line(style.gray(`  See history:       agent-kanban plan history ${plan.id}`));
    return ExitCode.OK;
  } finally {
    closeCtx(ctx);
  }
}

// =============================================================================
// plan show
// =============================================================================

async function planShow(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "help", "raw"],
    strings: ["session", "db", "server", "project", "key"],
    short: { j: "json", h: "help" },
  });
  assertKnownOptions(args, ["json", "help", "raw", "session", "db", "server", "project", "key"]);
  const json = getBool(args, "json");
  const out = createOutput(json);
  const ctx = openCtx(ctxOptions(args, json));
  const planId = requirePositional(args, 0, "plan id", "Usage: agent-kanban plan show PL-T-0007-01");

  try {
    const { data } = await ctx.backend.executeWithHints({ kind: "plan.show", params: { plan_id: planId } });
    const plan = data as {
      id: string; title: string; body: string; version: number; status: string;
      task_id: string | null; created_at: number; supersedes_id: string | null;
    };

    if (json) return (out.data(plan), ExitCode.OK);
    if (getBool(args, "raw")) {
      out.line(plan.body);
      return ExitCode.OK;
    }

    out.line("");
    out.line(
      `${style.cyan(plan.id)} ${style.bold(plan.title)} ${style.gray(`v${plan.version} · ${plan.status}`)}`,
    );
    if (plan.task_id) out.line(style.gray(`task ${plan.task_id} · ${relativeTime(plan.created_at, ctx.now())}`));
    if (plan.supersedes_id) out.line(style.gray(`supersedes ${plan.supersedes_id}`));
    out.line(style.gray("─".repeat(60)));
    out.line(plan.body);
    out.line("");
    return ExitCode.OK;
  } finally {
    closeCtx(ctx);
  }
}

// =============================================================================
// plan list
// =============================================================================

async function planList(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "help", "all"],
    strings: ["task", "session", "db", "server", "project", "key", "scope"],
    short: { j: "json", h: "help", t: "task" },
  });
  assertKnownOptions(args, ["json", "help", "all", "task", "scope", "session", "db", "server", "project", "key"]);
  const json = getBool(args, "json");
  const out = createOutput(json);
  const ctx = openCtx(ctxOptions(args, json));

  try {
    const { data } = await ctx.backend.executeWithHints({
      kind: "plan.list",
      params: {
        task_id: getString(args, "task") ?? null,
        scope: getString(args, "scope") as "project" | "task" | undefined,
        status: getBool(args, "all") ? "all" : "active",
        limit: getInt(args, "limit") ?? 50,
      },
    });
    const plans = data as Array<{
      id: string; title: string; version: number; status: string;
      task_id: string | null; created_at: number;
    }>;

    if (json) return (out.data(plans), ExitCode.OK);
    if (plans.length === 0) {
      out.line('(no plans yet. Create one with `agent-kanban plan save --title "..." --body-file <path>`)');
      return ExitCode.OK;
    }

    out.line("");
    out.line(`${style.bold("Plans")} ${style.gray(`(${plans.length})`)}`);
    for (const p of plans) {
      const statusMark = p.status === "active" ? style.green("●") : style.gray("○");
      out.line(
        `  ${statusMark} ${style.cyan(padEndWidth(p.id, 16))} ${style.gray(`v${p.version}`)} ` +
          `${padEndWidth(truncate(p.title, 34), 36)} ${style.gray(relativeTime(p.created_at, ctx.now()))}`,
      );
    }
    out.line("");
    out.line(style.gray("  ● active     ○ superseded (only shown with --all)"));
    out.line("");
    return ExitCode.OK;
  } finally {
    closeCtx(ctx);
  }
}

// =============================================================================
// plan history
// =============================================================================

async function planHistoryCmd(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "help"],
    strings: ["session", "db", "server", "project", "key"],
    short: { j: "json", h: "help" },
  });
  assertKnownOptions(args, ["json", "help", "session", "db", "server", "project", "key"]);
  const json = getBool(args, "json");
  const out = createOutput(json);
  const ctx = openCtx(ctxOptions(args, json));
  const planId = requirePositional(args, 0, "plan id", "Usage: agent-kanban plan history PL-T-0007-01");

  try {
    const { data } = await ctx.backend.executeWithHints({
      kind: "plan.history",
      params: { plan_id: planId },
    });
    const chain = data as Array<{
      id: string; version: number; title: string; status: string;
      created_at: number; body: string;
    }>;

    if (json) return (out.data(chain), ExitCode.OK);
    if (chain.length === 0) {
      out.line(`${planId} does not exist or has no history`);
      return ExitCode.OK;
    }

    out.line("");
    out.line(`${style.bold(`version chain of ${planId}`)} ${style.gray(`(${chain.length} versions)`)}`);
    for (const p of chain) {
      const mark = p.status === "active" ? style.green("●") : style.gray("○");
      out.line(
        `  ${mark} ${style.gray(`v${p.version}`)} ${padEndWidth(truncate(p.title, 30), 32)} ` +
          style.gray(relativeTime(p.created_at, ctx.now())),
      );
      // 每版给一行摘要，让"改了什么"一眼可见
      const firstLine = p.body.split("\n").find((l) => l.trim().length > 0 && !l.startsWith("#")) ?? "";
      if (firstLine) out.line(`      ${style.gray(truncate(firstLine.trim(), 56))}`);
    }
    out.line("");
    out.line(style.gray(`  Read the full text of a version: agent-kanban plan show ${chain[0]!.id}`));
    out.line("");
    return ExitCode.OK;
  } finally {
    closeCtx(ctx);
  }
}

// =============================================================================
// plan at（时间旅行）
// =============================================================================

async function planAt(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "help"],
    strings: ["task", "ts", "scope", "session", "db", "server", "project", "key"],
    short: { j: "json", h: "help", t: "task" },
  });
  assertKnownOptions(args, ["json", "help", "task", "ts", "scope", "session", "db", "server", "project", "key"]);
  const json = getBool(args, "json");
  const out = createOutput(json);
  const ctx = openCtx(ctxOptions(args, json));

  try {
    const ts = getInt(args, "ts");
    if (ts === undefined) {
      out.line("Error: missing --ts <epoch milliseconds>");
      out.line('Hint: use `agent-kanban plan at --task T-0007 --ts ' + String(ctx.now() - 3600_000) + '` for one hour ago');
      return ExitCode.USAGE;
    }

    const { data } = await ctx.backend.executeWithHints({
      kind: "plan.at",
      params: {
        task_id: getString(args, "task") ?? null,
        scope: getString(args, "scope") as "project" | "task" | undefined,
        ts,
      },
    });
    const plan = data as { id: string; title: string; body: string; created_at: number } | null;

    if (json) return (out.data(plan), ExitCode.OK);
    if (!plan) {
      out.line(`no plan at that moment (${relativeTime(ts, ctx.now())})`);
      return ExitCode.OK;
    }

    out.line("");
    out.line(`${style.gray("plan in effect at that moment:")} ${style.cyan(plan.id)} ${plan.title}`);
    out.line(style.gray("─".repeat(60)));
    out.line(plan.body);
    out.line("");
    return ExitCode.OK;
  } finally {
    closeCtx(ctx);
  }
}

// =============================================================================
// plan attach
// =============================================================================

async function planAttach(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "help"],
    strings: ["task", "session", "db", "server", "project", "key"],
    short: { j: "json", h: "help", t: "task" },
  });
  assertKnownOptions(args, ["json", "help", "task", "session", "db", "server", "project", "key"]);
  const json = getBool(args, "json");
  const out = createOutput(json);
  const ctx = openCtx(ctxOptions(args, json));
  const planId = requirePositional(args, 0, "plan id", "Usage: agent-kanban plan attach PL-T-0007-01 --task T-0007");
  const taskId = getString(args, "task");

  try {
    if (!taskId) {
      out.line("Error: missing --task");
      return ExitCode.USAGE;
    }

    const { data } = await ctx.backend.executeWithHints({
      kind: "plan.attach",
      params: { task_id: taskId, plan_id: planId, session_id: resolveSessionId(ctx, getString(args, "session")) },
    });
    const plan = data as { id: string; title: string; version: number };

    if (json) return (out.data(plan), ExitCode.OK);
    out.line(`${style.green("✓")} the current plan of ${style.cyan(taskId)} now points to ${style.cyan(plan.id)} ${style.gray(`v${plan.version}`)}`);
    return ExitCode.OK;
  } finally {
    closeCtx(ctx);
  }
}

function ctxOptions(args: { options: Record<string, string | boolean> }, json: boolean): {
  json: boolean;
  dbPath: string | undefined;
  sessionId: string | undefined;
  server: string | undefined;
  project: string | undefined;
  key: string | undefined;
} {
  return {
    json,
    dbPath: getString(args as never, "db"),
    sessionId: getString(args as never, "session"),
    server: getString(args as never, "server"),
    project: getString(args as never, "project"),
    key: getString(args as never, "key"),
  };
}
