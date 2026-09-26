/**
 * `agent-kanban handoff` —— 写交接。
 *
 * 这是 agent 收工前的最后一步，也是下一个 agent 恢复工作的主要依据。
 * 写得越具体，下一个 agent 越不需要猜：
 *   summary   做了什么（必填）
 *   --next    建议下一步（强烈建议填）
 *   --blockers 已知卡点
 *   --open    留给人的问题
 */

import { ExitCode, KanbanError, type ExitCodeValue } from "../core/errors.ts";
import { padEndWidth, style } from "../core/format.ts";
import type { Op } from "../core/ops.ts";
import { assertKnownOptions, getBool, getList, getString, parseArgs } from "./args.ts";
import { closeCtx, openCtx, resolveSessionId } from "./context.ts";
import { createOutput } from "./output.ts";

const USAGE = `Usage:
  agent-kanban handoff --task T-0007 --summary "what you did" [--next "what to do next"]
                   [--blockers "blocker1,blocker2"] [--open "open question"]
  agent-kanban handoff list --task T-0007        # show the handoff history of a task
  agent-kanban handoff pending                    # show every handoff waiting to be picked up

Notes:
  · --summary is required: without it the handoff means nothing
  · --next is strongly recommended: what to do next is what the next agent most needs to know
  · cards that need no handoff (just created, already done) need none

Example:
  agent-kanban handoff --task T-0007 \\
    --summary "finished the WAL transaction layer, all 20 store.ts tests green" \\
    --next "implement crash auto-composed handoffs, see implementation plan M2" \\
    --blockers "none" \\
    --open "should WAL files be tracked in git? leaning no"`;

export async function cmdHandoff(argv: string[]): Promise<ExitCodeValue> {
  const sub = argv[0];
  if (sub === "list" || sub === "pending") {
    return handoffQuery(sub, argv.slice(1));
  }
  if (sub === "--help" || sub === "-h" || sub === undefined) {
    process.stdout.write(USAGE + "\n");
    return ExitCode.OK;
  }

  const args = parseArgs(argv, {
    booleans: ["json", "help"],
    strings: ["task", "summary", "next", "blockers", "open", "db", "session", "server", "project", "key"],
    short: { j: "json", h: "help", t: "task", s: "summary", n: "next" },
  });
  assertKnownOptions(args, [
    "json", "help", "task", "summary", "next", "blockers", "open",
    "db", "session", "server", "project", "key",
  ]);
  const json = getBool(args, "json");
  const out = createOutput(json);
  const ctx = openCtx(ctxOptions(args, json));

  try {
    // 任务号：--task 优先，位置参数作为写法宽容
    const taskId = getString(args, "task") ?? args.positionals[0];
    if (!taskId) {
      throw KanbanError.usage(
        "missing task id",
        'Usage: agent-kanban handoff --task T-0007 --summary "what you did"',
      );
    }
    const summary = getString(args, "summary") ?? args.positionals[1];
    if (!summary) {
      throw KanbanError.usage(
        "missing --summary",
        'Usage: agent-kanban handoff --task T-0007 --summary "what you did" --next "what to do next"',
      );
    }

    const op: Op = {
      kind: "handoff.create",
      params: {
        task_id: taskId,
        summary,
        next_step: getString(args, "next") ?? args.positionals[2],
        blockers: getList(args, "blockers") ?? [],
        open_questions: getList(args, "open") ?? [],
      },
    };

    const { data, nextActions } = await ctx.backend.executeWithHints(op);
    const handoff = data as { id: number; task_id: string; kind: string; next_step: string | null };

    if (json) {
      out.data({ ...handoff, next_actions: nextActions });
      return ExitCode.OK;
    }

    out.line(`${style.green("✓")} Handoff recorded ${style.cyan(`#${handoff.id}`)} → ${handoff.task_id}`);
    if (handoff.next_step) out.line(`  Next: ${handoff.next_step}`);
    out.line("");
    out.line(style.gray("  the next session sees this handoff when it runs `agent-kanban context`"));
    out.line(style.gray("  or wrap up with `agent-kanban session end`"));
    return ExitCode.OK;
  } finally {
    closeCtx(ctx);
  }
}

/** handoff list / pending */
async function handoffQuery(sub: string, argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "help"],
    strings: ["task", "db", "session", "server", "project", "key"],
    short: { j: "json", h: "help", t: "task" },
  });
  assertKnownOptions(args, ["json", "help", "task", "db", "session", "server", "project", "key"]);
  const json = getBool(args, "json");
  const out = createOutput(json);
  const ctx = openCtx(ctxOptions(args, json));

  try {
    // 复用 context.get 的交接数据，避免重复实现查询
    const { data } = await ctx.backend.executeWithHints({
      kind: "context.get",
      params: { consume: false },
    });
    const context = data as {
      pending_handoffs: Array<{ id: number; task_id: string; task_title: string; from_session: string; kind: string; summary: string; next_step: string | null; created_relative: string }>;
      project: { key: string };
    };

    const taskFilter = getString(args, "task");
    const items = context.pending_handoffs.filter(
      (h) => (taskFilter ? h.task_id === taskFilter : true),
    );

    if (json) {
      out.data(items);
      return ExitCode.OK;
    }

    if (items.length === 0) {
      out.line(taskFilter ? `${taskFilter} has no handoff waiting` : "(no handoff waiting)");
      return ExitCode.OK;
    }

    out.line("");
    out.line(`Handoffs waiting (${items.length})`);
    for (const h of items) {
      out.line(
        `${style.cyan(`#${h.id}`)}  ${style.bold(h.task_id)}  ${h.task_title}  ` +
          style.gray(`${h.kind === "crash" ? "auto-composed" : "manual"} · ${h.from_session} · ${h.created_relative}`),
      );
      out.line(`    ${h.summary}`);
      if (h.next_step) out.line(`    ${style.gray("Next:")} ${h.next_step}`);
    }
    out.line("");
    out.line(style.gray("  use `agent-kanban resume <task-id>` to take over and inject these handoffs"));
    out.line("");
    return ExitCode.OK;
  } finally {
    closeCtx(ctx);
  }
}

function ctxOptions(args: { options: Record<string, string | boolean> }, json: boolean) {
  return {
    json,
    dbPath: getString(args as never, "db"),
    sessionId: getString(args as never, "session"),
    server: getString(args as never, "server"),
    project: getString(args as never, "project"),
    key: getString(args as never, "key"),
  };
}
