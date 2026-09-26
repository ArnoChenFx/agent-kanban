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

const USAGE = `用法：
  agent-kanban handoff --task T-0007 --summary "完成了什么" [--next "接着做什么"]
                   [--blockers "卡点1,卡点2"] [--open "待确认问题"]
  agent-kanban handoff list --task T-0007        # 查看某任务的交接史
  agent-kanban handoff pending                    # 查看所有待接手的交接

说明：
  · --summary 必填：没有它交接就没有意义
  · --next 强烈建议：下一个 agent 最需要知道的就是"接下来干什么"
  · 不需要交接的卡（刚创建、已完成）不用写

示例：
  agent-kanban handoff --task T-0007 \\
    --summary "完成 WAL 事务层，store.ts 20 个测试全绿" \\
    --next "实现 handoff 崩溃自动合成，见实施计划 M2" \\
    --blockers "无" \\
    --open "WAL 文件要不要纳入 git 跟踪？倾向不纳入"`;

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
        "缺少任务号",
        '用法：agent-kanban handoff --task T-0007 --summary "完成了什么"',
      );
    }
    const summary = getString(args, "summary") ?? args.positionals[1];
    if (!summary) {
      throw KanbanError.usage(
        "缺少 --summary",
        '用法：agent-kanban handoff --task T-0007 --summary "完成了什么" --next "接着做什么"',
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

    out.line(`${style.green("✓")} 交接已记录 ${style.cyan(`#${handoff.id}`)} → ${handoff.task_id}`);
    if (handoff.next_step) out.line(`  下一步：${handoff.next_step}`);
    out.line("");
    out.line(style.gray("  下一个会话执行 `agent-kanban context` 就会看到这条交接"));
    out.line(style.gray("  或用 `agent-kanban session end` 收尾"));
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
      out.line(taskFilter ? `${taskFilter} 无待接手的交接` : "（没有待接手的交接）");
      return ExitCode.OK;
    }

    out.line("");
    out.line(`待接手的交接（${items.length}）`);
    for (const h of items) {
      out.line(
        `${style.cyan(`#${h.id}`)}  ${style.bold(h.task_id)}  ${h.task_title}  ` +
          style.gray(`${h.kind === "crash" ? "崩溃自动合成" : "主动"} · ${h.from_session} · ${h.created_relative}`),
      );
      out.line(`    ${h.summary}`);
      if (h.next_step) out.line(`    ${style.gray("下一步：")}${h.next_step}`);
    }
    out.line("");
    out.line(style.gray("  用 `agent-kanban resume <任务号>` 接管并注入这些交接"));
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
