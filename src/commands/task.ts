/**
 * `agent-kanban task ...` —— 任务命令全集。
 *
 * 关键设计：命令层**不直接调 core**，而是构造一个 Op 交给 Backend（ADR-10）。
 * 本地与远程因此走同一条代码路径，行为一致性是结构保证。
 *
 * 命令层的职责仅限于：
 *   1. 解析命令行参数
 *   2. 构造 Op（纯 JSON）
 *   3. 调用 backend.executeWithHints(op)
 *   4. 把返回的 data 格式化成人类可读文本
 */

import { ExitCode, KanbanError, type ExitCodeValue } from "../core/errors.ts";
import { describeEvent } from "../core/events.ts";
import type { KanbanEvent } from "../core/types.ts";
import {
  padEndWidth,
  padStartWidth,
  parseDuration,
  progressBar,
  relativeTime,
  statusColor,
  statusLabel,
  statusMark,
  style,
  truncate,
} from "../core/format.ts";
import type { Op, CreateTaskParams, ProgressParams, ListTaskParams } from "../core/ops.ts";
import type { Task, TaskStatus } from "../core/types.ts";
import { TASK_STATUSES } from "../core/types.ts";
import {
  assertKnownOptions,
  getBool,
  getInt,
  getList,
  getString,
  parseArgs,
  rejectExtraPositionals,
  requirePositional,
} from "./args.ts";
import { closeCtx, openCtx, resolveSessionId, type Ctx,
  ctxOptionsFromArgs,
} from "./context.ts";
import { createOutput, type Output } from "./output.ts";

export async function cmdTask(argv: string[]): Promise<ExitCodeValue> {
  const sub = argv[0];
  const rest = argv.slice(1);

  switch (sub) {
    case "add":
      return await taskAdd(rest);
    case "list":
      return await taskList(rest);
    case "show":
      return await taskShow(rest);
    case "claim":
    case "start":
      return await taskClaim(rest);
    case "progress":
      return await taskProgress(rest);
    case "note":
      return await taskNote(rest);
    case "block":
      return await taskBlock(rest);
    case "unblock":
      return await taskUnblock(rest);
    case "review":
      return await taskReview(rest);
    case "done":
    case "complete":
      return await taskDone(rest);
    case "cancel":
      return await taskCancel(rest);
    case "reopen":
      return await taskReopen(rest);
    case "release":
      return await taskRelease(rest);
    case "edit":
      return await taskEdit(rest);
    case "dep":
      return await taskDep(rest);
    case "rm":
      return await taskRemove(rest);
    case "ready":
      return await taskList([...rest, "--ready"]);
    case undefined:
    case "help":
    case "--help":
      return printTaskUsage();
    default:
      throw KanbanError.usage(`unknown command: task ${sub}`, TASK_USAGE);
  }
}

function printTaskUsage(): ExitCodeValue {
  process.stdout.write(TASK_USAGE + "\n");
  return ExitCode.OK;
}

const TASK_USAGE = `Usage: agent-kanban task <subcommand> [args] [options]

Read:
  list     List tasks                 agent-kanban task list --status doing --ready
  show     Show task details          agent-kanban task show T-0007 --timeline
           Body / checklist items / dependencies (id + title + status), then the available actions
  ready    List claimable tasks       agent-kanban task ready

Write (requires a session):
  add      Create a task              agent-kanban task add "title" -d "description" -p 0 --check "step1,step2"
  claim    Claim (set to doing)       agent-kanban task claim T-0007
  start    Alias of claim
  progress Update progress            agent-kanban task progress T-0007 --pct 60 --note "rewrote the storage layer"
  note     Append a note              agent-kanban task note T-0007 "found a dependency conflict"
  block    Mark blocked               agent-kanban task block T-0007 --reason "waiting for the API key"
  unblock  Unblock                    agent-kanban task unblock T-0007
  review   Submit for review          agent-kanban task review T-0007
  done     Complete the task          agent-kanban task done T-0007 --note "tests all green"
  cancel   Cancel the task            agent-kanban task cancel T-0007 --reason "requirement changed"
  reopen   Reopen the task            agent-kanban task reopen T-0007 --reason "regression"
  release  Release back to todo       agent-kanban task release T-0007
  edit     Edit metadata              agent-kanban task edit T-0007 --title "new title"
  dep      Dependency maintenance     agent-kanban task dep add T-0007 T-0003
  rm       Delete a task              agent-kanban task rm T-0007

Common options: --json --session <id> --server <url> --project <key> --key <k>
Frequent: --ttl <duration> --force --pct <0-100> --reason <text> --check "item1,item2"`;

// =============================================================================
// 读命令
// =============================================================================

/** task list / task ready */
async function taskList(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "all", "mine", "ready", "help"],
    strings: ["status", "label", "parent", "sort", "limit", "db", "session", "server", "project", "key"],
    short: { j: "json", a: "all", m: "mine", s: "status", l: "label", h: "help" },
  });
  assertKnownOptions(args, ["json", "all", "mine", "ready", "help", "status", "label", "parent", "sort", "limit",
    "db", "session", "server", "project", "key",
  ]);
  rejectExtraPositionals(args, 0, "Usage: agent-kanban task list [--status doing] [--ready]");
  const json = getBool(args, "json");
  const out = createOutput(json);
  const ctx = openCtx(ctxOptionsFromArgs(args, json));

  try {
    const statusArg = getString(args, "status");
    const statuses = statusArg
      ? (statusArg.split(",").map((s) => s.trim()) as TaskStatus[]).map((s) => {
          if (!TASK_STATUSES.includes(s)) {
            throw KanbanError.usage(`unknown status: ${s}`, `Allowed: ${TASK_STATUSES.join(", ")}`);
          }
          return s;
        })
      : undefined;

    const mine = getBool(args, "mine");
    const params: ListTaskParams = {
      status: statuses,
      mine,
      ready: getBool(args, "ready"),
      label: getString(args, "label"),
      parent_id: getString(args, "parent"),
      include_terminal: getBool(args, "all"),
      sort: getString(args, "sort") as ListTaskParams["sort"],
      limit: getInt(args, "limit") ?? 200,
    };

    const { data } = await ctx.backend.executeWithHints({ kind: "task.list", params });
    const tasks = data as Array<Record<string, unknown>>;

    if (json) {
      out.data(tasks);
      return ExitCode.OK;
    }
    if (tasks.length === 0) {
      out.line("(no matching tasks)");
      if (params.ready) out.line("  no task has all dependencies satisfied and no holder");
      return ExitCode.OK;
    }
    renderTaskTable(out, tasks, ctx.now());
    return ExitCode.OK;
  } finally {
    closeCtx(ctx);
  }
}

/** 任务表格渲染（人类模式）。输入是 taskToJson 后的对象 */
function renderTaskTable(out: Output, tasks: Array<Record<string, unknown>>, now: number): void {
  const idWidth = 8;
  const titleWidth = 40;
  out.line(
    style.gray(
      "  " + "ID".padEnd(idWidth) + "Title".padEnd(titleWidth) + "Status".padEnd(12) +
        "Progress".padEnd(13) + "Pri".padEnd(5) + "Holder",
    ),
  );
  for (const raw of tasks) {
    const status = style[statusColor(String(raw.status)) as "cyan"](
      padEndWidth(`${statusMark(String(raw.status))} ${statusLabel(String(raw.status))}`, 10),
    );
    const pct = Number(raw.progress ?? 0);
    const progressText = pct > 0 ? `${padStartWidth(`${pct}%`, 4)} ${progressBar(pct, 6)}` : style.gray("   -  ");
    const holder = raw.assignee_session_id ? String(raw.assignee_session_id) : style.gray("-");
    const blockedHint =
      raw.status === "blocked" && raw.block_reason
        ? style.red(`  ⛔ ${truncate(String(raw.block_reason), 30)}`)
        : "";
    out.line(
      "  " +
        style.cyan(String(raw.id).padEnd(idWidth)) +
        padEndWidth(String(raw.title), titleWidth) +
        status + "  " +
        padEndWidth(progressText, 13) +
        padStartWidth(`p${raw.priority}`, 3) + "  " +
        padEndWidth(holder, 18) +
        blockedHint,
    );
  }
}

/** task show */
async function taskShow(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "timeline", "body", "help"],
    strings: ["tail", "db", "session", "server", "project", "key"],
    short: { j: "json", t: "timeline", h: "help" },
  });
  assertKnownOptions(args, ["json", "timeline", "body", "help", "tail", "db", "session", "server", "project", "key"]);
  const json = getBool(args, "json");
  const out = createOutput(json);
  // help 必须先于 requirePositional：否则 `task show --help` 报的是"缺 task id"
  if (getBool(args, "help")) {
    out.line("Usage: agent-kanban task show <task-id> [--timeline] [--body] [--tail N]");
    return ExitCode.OK;
  }
  const ctx = openCtx(ctxOptionsFromArgs(args, json));
  rejectExtraPositionals(args, 1, "Usage: agent-kanban task show T-0007 [--timeline]");
  const id = requirePositional(args, 0, "task id", "Usage: agent-kanban task show T-0007 [--timeline]");

  try {
    // nextActions 要单独取：executeWithHints 把它放在 data 之外，
    // 早先这里只解构了 data，于是末尾的“可用操作”永远是空的。
    const { data, nextActions } = await ctx.backend.executeWithHints({
      kind: "task.get",
      params: { task_id: id, timeline: getBool(args, "timeline"), tail: getInt(args, "tail") ?? 20 },
    });
    const task = data as Record<string, unknown>;

    if (json) {
      out.data({ ...task, next_actions: nextActions });
      return ExitCode.OK;
    }

    const now = ctx.now();
    const status = style[statusColor(String(task.status)) as "cyan"](`[${statusLabel(String(task.status))}]`);
    out.line("");
    out.line(`${style.cyan(String(task.id))}  ${status}  ${style.bold(String(task.title))}`);
    if (task.started_at) {
      out.line(`  ${style.gray(`started ${relativeTime(Number(task.started_at), now)}`)}`);
    }
    const pct = Number(task.progress ?? 0);
    if (pct > 0) {
      out.line(`  progress ${padStartWidth(`${pct}%`, 4)}  ${style.cyan(progressBar(pct, 20))}`);
    }
    if (task.assignee_session_id) {
      const leaseLeft = task.lease_expires_at
        ? Math.max(0, Math.ceil((Number(task.lease_expires_at) - now) / 60000))
        : 0;
      out.line(`  assignee ${task.assignee_session_id} ${style.gray(`(lease left ${leaseLeft}m)`)}`);
    }
    if (task.status === "blocked" && task.block_reason) {
      out.line(`  ${style.red("⛔ Blocked: ")}${task.block_reason}`);
    }
    // 描述默认全文显示（与 Web 详情抽屉一致）：它回答的是“这活儿到底是干什么的”，
    // 而 `task show` 就是看这个的。`--body` 保留为**兼容参数**（传了不报错、不改变行为），
    // 免得老的脚本/别名里写了它就直接 usage error。
    if (task.body) {
      out.line("");
      out.line("  Description:");
      for (const l of String(task.body).split("\n")) out.line(`    ${l}`);
    }
    if (task.plan_id) out.line(`  plan ${style.magenta(String(task.plan_id))}`);

    const checklist = task.checklist as Array<{ text: string; done: boolean; by?: string | null }>;
    if (checklist && checklist.length > 0) {
      out.line("  Checklist");
      for (const item of checklist) {
        out.line(`    ${item.done ? style.green("✅") : style.gray("⬜")} ${item.text}${item.done && item.by ? style.gray(` ${item.by}`) : ""}`);
      }
    }

    // 依赖：优先读 dependency_details（id + 标题 + 完成状态）。
    // 退化路径留给老服务端：dependencies 是 TaskDep 对象数组（字段是 dependsOnId，
    // 不是 depends_on_id —— 早先读错这个名字，输出直接变成 "· undefined"）。
    const depDetails = task.dependency_details as Array<{ id: string; title?: string; done?: boolean }> | undefined;
    const deps = depDetails
      ? depDetails
      : ((task.dependencies as Array<{ dependsOnId?: string; depends_on_id?: string }> | undefined) ?? []).map((d) => ({
          id: d.dependsOnId ?? d.depends_on_id ?? "",
          title: "",
          done: false,
        }));
    if (deps.length > 0) {
      out.line("  Dependencies");
      for (const d of deps) {
        if (!d.id) continue;
        const state = d.done ? "Done" : "Not done";
        out.line(`    ${style.gray("·")} ${style.cyan(d.id)}${d.title ? ` ${d.title}` : ""} (${d.done ? style.green(state) : style.yellow(state)})`);
      }
    }
    const timeline = task.timeline as KanbanEvent[] | undefined;
    if (timeline && timeline.length > 0) {
      out.line("  Recent");
      for (const e of timeline) {
        // 时间列宽 10：相对时间英文化后最长是 "just now"（8 字符），原来的 padEnd(8)
        // 恰好占满整列，拼出来是 “just now created task (p2)” —— 读起来像“刚刚创建”的动词短语。
        // 留两格空隙让事件文本始终与时间列分开。
        out.line(`    ${style.gray(relativeTime(Number(e.ts), now).padEnd(10))} ${describeEvent(e)}`);
      }
    }

    out.line("");
    out.line("  " + style.gray("Available actions: ") + nextActions.map((h) => style.gray(h)).join("  |  "));
    out.line("");
    return ExitCode.OK;
  } finally {
    closeCtx(ctx);
  }
}

// =============================================================================
// 写命令
// =============================================================================

/** task add */
async function taskAdd(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "backlog", "help"],
    strings: ["desc", "priority", "parent", "label", "blocked-by", "check", "estimate", "db", "session", "title", "server", "project", "key"],
    short: { j: "json", d: "desc", p: "priority", l: "label", c: "check", h: "help" },
  });
  assertKnownOptions(args, [
    "json", "backlog", "help", "desc", "priority", "parent", "label", "blocked-by",
    "check", "estimate", "db", "session", "title", "server", "project", "key",
  ]);
  // 标题可以用位置参数给，但只允许一个
  rejectExtraPositionals(args, 1, 'Usage: agent-kanban task add "title" -d "description"');
  const json = getBool(args, "json");
  const out = createOutput(json);
  const ctx = openCtx(ctxOptionsFromArgs(args, json));

  try {
    const title = getString(args, "title") ?? args.positionals[0];
    if (!title) {
      throw KanbanError.usage(
        "missing task title",
        'Usage: agent-kanban task add "title" [-d "description"] [-p 0-4] [--check "step1,step2"]',
      );
    }
    const estimate = getString(args, "estimate");
    if (estimate && parseDuration(estimate) === null) {
      throw KanbanError.usage(`cannot parse estimate "${estimate}"`, "Supported: 30m / 2h / 1d / 1h30m");
    }

    const params: CreateTaskParams = {
      title,
      description: getString(args, "desc") ?? null,
      status: getBool(args, "backlog") ? "backlog" : "todo",
      priority: getInt(args, "priority"),
      labels: getList(args, "label"),
      parent_id: getString(args, "parent") ?? null,
      blocked_by: getList(args, "blocked-by") ?? [],
      checklist: getList(args, "check") ?? [],
      estimate_ms: estimate ? parseDuration(estimate) : null,
    };

    const { data, nextActions } = await ctx.backend.executeWithHints({ kind: "task.create", params });
    const task = data as Record<string, unknown>;

    if (json) {
      out.data({ ...task, next_actions: nextActions });
      return ExitCode.OK;
    }

    out.line(`${style.green("✓")} Created task ${style.cyan(String(task.id))} ${task.title}`);
    const checklist = task.checklist as Array<{ text: string; done: boolean; done_at: number | null; by: string | null }>;
    if (checklist && checklist.length > 0) {
      out.line(`  Checklist: ${checklist.map((c) => c.text).join(" / ")}`);
    }
    out.line("");
    out.line(style.gray("Next:"));
    for (const action of nextActions) out.line(`  ${action}`);
    return ExitCode.OK;
  } finally {
    closeCtx(ctx);
  }
}

/** task claim / start */
async function taskClaim(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "force", "help"],
    strings: ["ttl", "db", "session", "server", "project", "key"],
    short: { j: "json", f: "force", h: "help" },
  });
  assertKnownOptions(args, ["json", "force", "help", "ttl", "db", "session", "server", "project", "key"]);
  const json = getBool(args, "json");
  const out = createOutput(json);
  rejectExtraPositionals(args, 1, "Usage: agent-kanban task claim T-0007 [--ttl 2h]");
  const ctx = openCtx(ctxOptionsFromArgs(args, json));
  const id = requirePositional(args, 0, "task id", "Usage: agent-kanban task claim T-0007 [--ttl 2h]");

  try {
    requireSession(ctx, getString(args, "session"));
    const { data, nextActions } = await ctx.backend.executeWithHints({
      kind: "task.claim",
      params: { task_id: id, force: getBool(args, "force"), ttl: getString(args, "ttl") },
    });
    const task = data as Record<string, unknown>;

    if (json) {
      out.data({ ...task, next_actions: nextActions });
      return ExitCode.OK;
    }
    const leaseMin = task.lease_expires_at ? Math.round((Number(task.lease_expires_at) - ctx.now()) / 60000) : 0;
    out.line(`${style.green("✓")} Claimed ${style.cyan(String(task.id))} ${task.title} ${style.gray(`(lease ${leaseMin}m)`)}`);
    if (task.took_over) {
      out.line(`  ${style.yellow("Note: ")}this card was held by another session${Number(task.progress) > 0 ? `, progress ${task.progress}% preserved` : ""}`);
    }
    out.line("");
    out.line(style.gray("Hint: run progress after every step (it renews the lease automatically), write a handoff before wrapping up"));
    return ExitCode.OK;
  } finally {
    closeCtx(ctx);
  }
}

/** task progress */
async function taskProgress(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "help"],
    strings: ["pct", "note", "check", "uncheck", "add-check", "db", "session", "server", "project", "key"],
    short: { j: "json", p: "pct", n: "note", c: "check", h: "help" },
  });
  assertKnownOptions(args, ["json", "help", "pct", "note", "check", "uncheck", "add-check", "db", "session", "server", "project", "key"]);
  const json = getBool(args, "json");
  const out = createOutput(json);
  rejectExtraPositionals(args, 2, 'Usage: agent-kanban task progress T-0007 --pct 60 --note "..."');
  const ctx = openCtx(ctxOptionsFromArgs(args, json));
  const id = requirePositional(args, 0, "task id", 'Usage: agent-kanban task progress T-0007 --pct 60 --note "..."');

  try {
    requireSession(ctx, getString(args, "session"));
    const params: ProgressParams = {
      task_id: id,
      pct: getInt(args, "pct"),
      note: getString(args, "note") ?? args.positionals[1],
      check: getList(args, "check"),
      uncheck: getList(args, "uncheck"),
      add_check: getList(args, "add-check"),
    };
    const { data, nextActions } = await ctx.backend.executeWithHints({ kind: "task.progress", params });
    const task = data as Record<string, unknown>;

    if (json) {
      out.data({ ...task, next_actions: nextActions });
      return ExitCode.OK;
    }
    const pct = Number(task.progress);
    out.line(`${style.green("✓")} ${style.cyan(String(task.id))} progress ${padStartWidth(`${pct}%`, 4)} ${style.cyan(progressBar(pct, 20))}`);
    if (params.note) out.line(`  Note: ${params.note}`);
    const checklist = task.checklist as Array<{ text: string; done: boolean }>;
    if (checklist && checklist.length > 0) {
      const done = checklist.filter((c) => c.done).length;
      out.line(`  Checklist: ${done}/${checklist.length} done`);
      for (const item of checklist.filter((c) => !c.done)) out.line(`    ${style.gray("⬜")} ${item.text}`);
    }
    if (nextActions.length > 0) {
      out.line("");
      for (const a of nextActions) out.line(style.gray(a));
    }
    return ExitCode.OK;
  } finally {
    closeCtx(ctx);
  }
}

/** task note */
async function taskNote(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "help"],
    strings: ["db", "session", "server", "project", "key"],
    short: { j: "json", h: "help" },
  });
  assertKnownOptions(args, ["json", "help", "db", "session", "server", "project", "key"]);
  const json = getBool(args, "json");
  const out = createOutput(json);
  rejectExtraPositionals(args, 2, 'Usage: agent-kanban task note T-0007 "note text"');
  const ctx = openCtx(ctxOptionsFromArgs(args, json));
  const id = requirePositional(args, 0, "task id", 'Usage: agent-kanban task note T-0007 "note text"');
  const text = args.positionals[1];
  if (!text) throw KanbanError.usage("missing note text", 'Usage: agent-kanban task note T-0007 "note text"');

  try {
    requireSession(ctx, getString(args, "session"));
    const { data } = await ctx.backend.executeWithHints({ kind: "task.note", params: { task_id: id, text } });
    if (json) {
      out.data(data);
      return ExitCode.OK;
    }
    out.line(`${style.green("✓")} ${style.cyan(id)} note recorded`);
    return ExitCode.OK;
  } finally {
    closeCtx(ctx);
  }
}

/** 状态转移命令的通用实现 */
async function taskTransition(
  argv: string[],
  opts: { kind: Op["kind"]; usage: string; reasonRequired?: boolean },
): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "force", "help"],
    strings: ["reason", "note", "db", "session", "server", "project", "key"],
    short: { j: "json", f: "force", r: "reason", n: "note", h: "help" },
  });
  assertKnownOptions(args, ["json", "force", "help", "reason", "note", "db", "session", "server", "project", "key"]);
  const json = getBool(args, "json");
  const out = createOutput(json);
  rejectExtraPositionals(args, 2, opts.usage);
  const ctx = openCtx(ctxOptionsFromArgs(args, json));
  const id = requirePositional(args, 0, "task id", opts.usage);

  try {
    requireSession(ctx, getString(args, "session"));
    const reason = getString(args, "reason") ?? args.positionals[1];
    if (opts.reasonRequired && !reason) {
      throw KanbanError.usage("this command requires --reason <text>", opts.usage);
    }
    const { data, nextActions } = await ctx.backend.executeWithHints({
      kind: opts.kind,
      params: { task_id: id, reason, note: getString(args, "note"), force: getBool(args, "force") },
    } as Op);
    const task = data as Record<string, unknown>;

    if (json) {
      out.data({ ...task, next_actions: nextActions });
      return ExitCode.OK;
    }
    out.line(`${style.green("✓")} ${style.cyan(String(task.id))} → ${style[statusColor(String(task.status)) as "cyan"](statusLabel(String(task.status)))} ${task.title}`);
    if (reason) out.line(`  Reason: ${reason}`);
    const unblocked = (task.unblocked as string[] | undefined) ?? [];
    if (unblocked.length > 0) {
      out.line("");
      out.line(`${style.green("⤵")} these tasks can start now: ${style.cyan(unblocked.join(", "))}`);
      out.line(style.gray(`  Claim: agent-kanban task claim ${unblocked[0]}`));
    }
    if (nextActions.length > 0) {
      out.line("");
      for (const a of nextActions) out.line(style.gray(a));
    }
    return ExitCode.OK;
  } finally {
    closeCtx(ctx);
  }
}

async function taskBlock(argv: string[]): Promise<ExitCodeValue> {
  return taskTransition(argv, { kind: "task.block", usage: 'Usage: agent-kanban task block T-0007 --reason "waiting for what"', reasonRequired: true });
}
async function taskUnblock(argv: string[]): Promise<ExitCodeValue> {
  return taskTransition(argv, { kind: "task.unblock", usage: "Usage: agent-kanban task unblock T-0007" });
}
async function taskReview(argv: string[]): Promise<ExitCodeValue> {
  return taskTransition(argv, { kind: "task.review", usage: 'Usage: agent-kanban task review T-0007 [--note "..."]' });
}
async function taskDone(argv: string[]): Promise<ExitCodeValue> {
  return taskTransition(argv, { kind: "task.done", usage: 'Usage: agent-kanban task done T-0007 [--note "..."] [--force]' });
}
async function taskCancel(argv: string[]): Promise<ExitCodeValue> {
  return taskTransition(argv, { kind: "task.cancel", usage: 'Usage: agent-kanban task cancel T-0007 --reason "requirement changed"', reasonRequired: true });
}
async function taskReopen(argv: string[]): Promise<ExitCodeValue> {
  return taskTransition(argv, { kind: "task.reopen", usage: 'Usage: agent-kanban task reopen T-0007 --reason "regression"', reasonRequired: true });
}

/** task release */
async function taskRelease(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "help"],
    strings: ["reason", "db", "session", "server", "project", "key"],
    short: { j: "json", r: "reason", h: "help" },
  });
  assertKnownOptions(args, ["json", "help", "reason", "db", "session", "server", "project", "key"]);
  const json = getBool(args, "json");
  const out = createOutput(json);
  rejectExtraPositionals(args, 1, 'Usage: agent-kanban task release T-0007 [--reason "..."]');
  const ctx = openCtx(ctxOptionsFromArgs(args, json));
  const id = requirePositional(args, 0, "task id", 'Usage: agent-kanban task release T-0007 [--reason "..."]');

  try {
    requireSession(ctx, getString(args, "session"));
    const { data } = await ctx.backend.executeWithHints({ kind: "task.release", params: { task_id: id, reason: getString(args, "reason") } });
    const task = data as Record<string, unknown>;
    if (json) {
      out.data(data);
      return ExitCode.OK;
    }
    out.line(`${style.green("✓")} ${style.cyan(id)} released (progress ${task.progress}% preserved)`);
    return ExitCode.OK;
  } finally {
    closeCtx(ctx);
  }
}

/** task edit */
async function taskEdit(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "help"],
    strings: ["title", "desc", "priority", "label", "estimate", "db", "session", "server", "project", "key"],
    short: { j: "json", d: "desc", p: "priority", l: "label", h: "help" },
  });
  assertKnownOptions(args, ["json", "help", "title", "desc", "priority", "label", "estimate", "db", "session", "server", "project", "key"]);
  const json = getBool(args, "json");
  const out = createOutput(json);
  rejectExtraPositionals(args, 1, 'Usage: agent-kanban task edit T-0007 --title "new title"');
  const ctx = openCtx(ctxOptionsFromArgs(args, json));
  const id = requirePositional(args, 0, "task id", 'Usage: agent-kanban task edit T-0007 --title "new title"');

  try {
    const estimate = getString(args, "estimate");
    const { data } = await ctx.backend.executeWithHints({
      kind: "task.edit",
      params: {
        task_id: id,
        title: getString(args, "title"),
        description: getString(args, "desc"),
        priority: getInt(args, "priority"),
        labels: getList(args, "label"),
        estimate_ms: estimate ? parseDuration(estimate) : undefined,
      },
    });
    if (json) {
      out.data(data);
      return ExitCode.OK;
    }
    const task = data as Record<string, unknown>;
    out.line(`${style.green("✓")} ${style.cyan(id)} updated: ${task.title}`);
    return ExitCode.OK;
  } finally {
    closeCtx(ctx);
  }
}

/** task dep add/remove/list */
async function taskDep(argv: string[]): Promise<ExitCodeValue> {
  const action = argv[0];
  if (action !== "add" && action !== "remove" && action !== "list") {
    throw KanbanError.usage(
      `unknown dependency action: dep ${action ?? ""}`,
      "Usage: agent-kanban task dep add|remove|list T-0007 [T-0003]",
    );
  }
  const args = parseArgs(argv.slice(1), {
    booleans: ["json", "help"],
    strings: ["db", "session", "server", "project", "key"],
    short: { j: "json", h: "help" },
  });
  assertKnownOptions(args, ["json", "help", "db", "session", "server", "project", "key"]);
  const json = getBool(args, "json");
  const out = createOutput(json);
  rejectExtraPositionals(args, 2, "Usage: agent-kanban task dep add T-0007 T-0003");
  const ctx = openCtx(ctxOptionsFromArgs(args, json));
  const id = requirePositional(args, 0, "task id", "Usage: agent-kanban task dep add T-0007 T-0003");

  try {
    let op: Op;
    if (action === "list") {
      op = { kind: "task.dep.list", params: { task_id: id } };
    } else {
      const target = args.positionals[1];
      if (!target) throw KanbanError.usage("missing dependency task id", "Usage: agent-kanban task dep add T-0007 T-0003");
      op = {
        kind: action === "add" ? "task.dep.add" : "task.dep.remove",
        params: { task_id: id, depends_on: target },
      };
    }
    const { data } = await ctx.backend.executeWithHints(op);
    const result = data as { dependencies: Array<{ dependsOnId?: string; depends_on_id?: string }> };
    if (json) {
      out.data(data);
      return ExitCode.OK;
    }
    if (action === "list") {
      if (result.dependencies.length === 0) {
        out.line(`${id} has no dependencies`);
        return ExitCode.OK;
      }
      // TaskDep 的字段是 dependsOnId（不是 depends_on_id）——读错会打印 undefined
      for (const d of result.dependencies) out.line(`  ${d.dependsOnId ?? d.depends_on_id ?? "(unknown)"}`);
      return ExitCode.OK;
    }
    out.line(`${style.green("✓")} ${style.cyan(id)} ${action === "add" ? "dependency added" : "dependency removed"} (${result.dependencies.length} total)`);
    return ExitCode.OK;
  } finally {
    closeCtx(ctx);
  }
}

/** task rm */
async function taskRemove(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "force", "help"],
    strings: ["db", "session", "server", "project", "key"],
    short: { j: "json", f: "force", h: "help" },
  });
  assertKnownOptions(args, ["json", "force", "help", "db", "session", "server", "project", "key"]);
  const json = getBool(args, "json");
  const out = createOutput(json);
  rejectExtraPositionals(args, 1, "Usage: agent-kanban task rm T-0007 [--force]");
  const ctx = openCtx(ctxOptionsFromArgs(args, json));
  const id = requirePositional(args, 0, "task id", "Usage: agent-kanban task rm T-0007 [--force]");

  try {
    const { data } = await ctx.backend.executeWithHints({ kind: "task.remove", params: { task_id: id, force: getBool(args, "force") } });
    if (json) {
      out.data(data);
      return ExitCode.OK;
    }
    out.line(`${style.green("✓")} Deleted ${style.cyan(id)} (events and handoffs are kept)`);
    return ExitCode.OK;
  } finally {
    closeCtx(ctx);
  }
}

// =============================================================================
// 共享工具
// =============================================================================

/** 需要会话的命令：校验会话标识存在（本地读文件/环境变量，远程靠 --session 头） */
function requireSession(ctx: Ctx, explicit?: string): string {
  return resolveSessionId(ctx, explicit);
}
