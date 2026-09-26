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

const USAGE = `用法：
  agent-kanban plan save --title "标题" [--task T-0007] [--body-file <路径> | --body "..."]
  agent-kanban plan show <计划号> [--json]
  agent-kanban plan list [--task T-0007] [--all] [--json]
  agent-kanban plan history <计划号> [--json]        # 版本链：这个计划改了几次
  agent-kanban plan at --task T-0007 --ts <时间戳>   # 那时生效的计划是什么
  agent-kanban plan attach <计划号> --task T-0007    # 把任务指向某个版本

说明：
  · --body 必填：标题只是一句话，正文才是计划的价值
  · 每次 save 都产生新版本，旧版本转 superseded（不会丢）
  · 任务级计划（--task）保存后会自动挂到该任务上，等价于 attach

示例：
  agent-kanban plan save --task T-0007 \\
    --title "拆成 4 个里程碑" \\
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
      out.line("错误：缺少计划正文");
      out.line("");
      out.line("正文是计划的价值所在。用下面任一方式提供：");
      out.line('  --body-file <路径>     从文件读（推荐，长文本不经过 shell 引号地狱）');
      out.line('  --body "..."           直接给 markdown');
      out.line("");
      out.line("模板可以先这样起：");
      out.line("  ## 目标");
      out.line("  ## 步骤");
      out.line("  1. ");
      out.line("  ## 风险 / 待确认");
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

    out.line(`${style.green("✓")} 计划已保存 ${style.cyan(plan.id)} ${style.gray(`v${plan.version}`)}`);
    out.line(`  ${plan.title}`);
    if (plan.supersedes_id) {
      out.line(`  ${style.gray(`顶替了旧版本 ${plan.supersedes_id}（旧版本仍可查）`)}`);
    }
    if (plan.task_id) {
      out.line(`  ${style.gray(`已挂到 ${plan.task_id}，agent resume 时会自动读到`)}`);
    }
    out.line("");
    out.line(style.gray(`  读全文：agent-kanban plan show ${plan.id}`));
    out.line(style.gray(`  看历史：agent-kanban plan history ${plan.id}`));
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
  const planId = requirePositional(args, 0, "计划号", "用法：agent-kanban plan show PL-T-0007-01");

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
    if (plan.task_id) out.line(style.gray(`任务 ${plan.task_id} · ${relativeTime(plan.created_at, ctx.now())}`));
    if (plan.supersedes_id) out.line(style.gray(`顶替 ${plan.supersedes_id}`));
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
      out.line("（没有计划。用 `agent-kanban plan save --title \"...\" --body-file <路径>` 创建）");
      return ExitCode.OK;
    }

    out.line("");
    out.line(`${style.bold("计划")} ${style.gray(`(${plans.length})`)}`);
    for (const p of plans) {
      const statusMark = p.status === "active" ? style.green("●") : style.gray("○");
      out.line(
        `  ${statusMark} ${style.cyan(padEndWidth(p.id, 16))} ${style.gray(`v${p.version}`)} ` +
          `${padEndWidth(truncate(p.title, 34), 36)} ${style.gray(relativeTime(p.created_at, ctx.now()))}`,
      );
    }
    out.line("");
    out.line(style.gray("  ● 当前生效    ○ 已被顶替（--all 才显示）"));
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
  const planId = requirePositional(args, 0, "计划号", "用法：agent-kanban plan history PL-T-0007-01");

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
      out.line(`${planId} 不存在或没有历史`);
      return ExitCode.OK;
    }

    out.line("");
    out.line(`${style.bold(`${planId} 的版本链`)} ${style.gray(`(共 ${chain.length} 版)`)}`);
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
    out.line(style.gray(`  读某版全文：agent-kanban plan show ${chain[0]!.id}`));
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
      out.line("错误：缺少 --ts <epoch 毫秒>");
      out.line('提示：用 `agent-kanban plan at --task T-0007 --ts ' + String(ctx.now() - 3600_000) + '` 表示一小时前');
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
      out.line(`该时刻（${relativeTime(ts, ctx.now())}）还没有计划`);
      return ExitCode.OK;
    }

    out.line("");
    out.line(`${style.gray("该时刻生效的计划：")} ${style.cyan(plan.id)} ${plan.title}`);
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
  const planId = requirePositional(args, 0, "计划号", "用法：agent-kanban plan attach PL-T-0007-01 --task T-0007");
  const taskId = getString(args, "task");

  try {
    if (!taskId) {
      out.line("错误：缺少 --task");
      return ExitCode.USAGE;
    }

    const { data } = await ctx.backend.executeWithHints({
      kind: "plan.attach",
      params: { task_id: taskId, plan_id: planId, session_id: resolveSessionId(ctx, getString(args, "session")) },
    });
    const plan = data as { id: string; title: string; version: number };

    if (json) return (out.data(plan), ExitCode.OK);
    out.line(`${style.green("✓")} ${style.cyan(taskId)} 的当前计划已指向 ${style.cyan(plan.id)} ${style.gray(`v${plan.version}`)}`);
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
