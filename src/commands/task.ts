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
  requirePositional,
} from "./args.ts";
import { closeCtx, openCtx, resolveSessionId, type Ctx } from "./context.ts";
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
      throw KanbanError.usage(`未知子命令：task ${sub}`, TASK_USAGE);
  }
}

function printTaskUsage(): ExitCodeValue {
  process.stdout.write(TASK_USAGE + "\n");
  return ExitCode.OK;
}

const TASK_USAGE = `用法：agent-kanban task <子命令> [参数] [选项]

读：
  list      列出任务          agent-kanban task list --status doing --ready
  show      查看任务详情      agent-kanban task show T-0007 --timeline
  ready     列出可认领任务     agent-kanban task ready

写（需会话上下文）：
  add       创建任务          agent-kanban task add "标题" -d "描述" -p 0 --check "步骤1,步骤2"
  claim     抢占为进行中      agent-kanban task claim T-0007
  start     claim 的别名
  progress  更新进度          agent-kanban task progress T-0007 --pct 60 --note "改完存储层"
  note      追加备注          agent-kanban task note T-0007 "发现依赖冲突"
  block     标记阻塞          agent-kanban task block T-0007 --reason "等 API key"
  unblock   解除阻塞          agent-kanban task unblock T-0007
  review    提交评审          agent-kanban task review T-0007
  done      完成任务          agent-kanban task done T-0007 --note "测试全绿"
  cancel    取消任务          agent-kanban task cancel T-0007 --reason "需求变更"
  reopen    重新打开          agent-kanban task reopen T-0007 --reason "回归失败"
  release   释放回待办        agent-kanban task release T-0007
  edit      改元信息          agent-kanban task edit T-0007 --title "新标题"
  dep       依赖维护          agent-kanban task dep add T-0007 T-0003
  rm        删除任务          agent-kanban task rm T-0007

通用选项：--json --session <id> --server <url> --project <key> --key <k>
常用：--ttl <时长> --force --pct <0-100> --reason <文本> --check "项1,项2"`;

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
  assertKnownOptions(args, [
    "json", "all", "mine", "ready", "help", "status", "label", "parent", "sort", "limit",
    "db", "session", "server", "project", "key",
  ]);
  const json = getBool(args, "json");
  const out = createOutput(json);
  const ctx = openCtx(ctxOptions(args, json));

  try {
    const statusArg = getString(args, "status");
    const statuses = statusArg
      ? (statusArg.split(",").map((s) => s.trim()) as TaskStatus[]).map((s) => {
          if (!TASK_STATUSES.includes(s)) {
            throw KanbanError.usage(`未知状态：${s}`, `可选：${TASK_STATUSES.join(", ")}`);
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
      out.line("（无匹配任务）");
      if (params.ready) out.line("  没有依赖已满足且无人持有的任务");
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
      "  " + "ID".padEnd(idWidth) + "标题".padEnd(titleWidth + 2) + "状态".padEnd(12) +
        "进度".padEnd(7) + "优先".padEnd(5) + "持有者",
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
  const ctx = openCtx(ctxOptions(args, json));
  const id = requirePositional(args, 0, "任务号", "用法：agent-kanban task show T-0007 [--timeline]");

  try {
    const { data } = await ctx.backend.executeWithHints({
      kind: "task.get",
      params: { task_id: id, timeline: getBool(args, "timeline"), tail: getInt(args, "tail") ?? 20 },
    });
    const task = data as Record<string, unknown>;

    if (json) {
      out.data(task);
      return ExitCode.OK;
    }

    const now = ctx.now();
    const status = style[statusColor(String(task.status)) as "cyan"](`[${statusLabel(String(task.status))}]`);
    out.line("");
    out.line(`${style.cyan(String(task.id))}  ${status}  ${style.bold(String(task.title))}`);
    if (task.started_at) {
      out.line(`  ${style.gray(`开始于 ${relativeTime(Number(task.started_at), now)}`)}`);
    }
    const pct = Number(task.progress ?? 0);
    if (pct > 0) {
      out.line(`  进度 ${padStartWidth(`${pct}%`, 4)}  ${style.cyan(progressBar(pct, 20))}`);
    }
    if (task.assignee_session_id) {
      const leaseLeft = task.lease_expires_at
        ? Math.max(0, Math.ceil((Number(task.lease_expires_at) - now) / 60000))
        : 0;
      out.line(`  持有 ${task.assignee_session_id} ${style.gray(`(租约剩 ${leaseLeft}m)`)}`);
    }
    if (task.status === "blocked" && task.block_reason) {
      out.line(`  ${style.red("⛔ 阻塞原因：")}${task.block_reason}`);
    }
    if (task.body && getBool(args, "body")) {
      out.line("");
      out.line("  描述：");
      for (const l of String(task.body).split("\n")) out.line(`    ${l}`);
    }
    if (task.plan_id) out.line(`  计划 ${style.magenta(String(task.plan_id))}`);

    const checklist = task.checklist as Array<{ text: string; done: boolean; by?: string | null }>;
    if (checklist && checklist.length > 0) {
      out.line("  检查项");
      for (const item of checklist) {
        out.line(`    ${item.done ? style.green("✅") : style.gray("⬜")} ${item.text}${item.done && item.by ? style.gray(` ${item.by}`) : ""}`);
      }
    }

    const deps = task.dependencies as Array<{ depends_on_id: string }>;
    if (deps && deps.length > 0) {
      out.line("  依赖");
      for (const d of deps) {
        out.line(`    ${style.gray("·")} ${d.depends_on_id}`);
      }
    }
    const timeline = task.timeline as Array<Record<string, unknown>> | undefined;
    if (timeline && timeline.length > 0) {
      out.line("  最近");
      for (const e of timeline) {
        out.line(`    ${style.gray(relativeTime(Number(e.ts), now).padEnd(8))} ${describeEventJson(e)}`);
      }
    }

    out.line("");
    out.line("  " + style.gray("可用操作：") + (task.next_actions as string[] | undefined ?? []).map((h) => style.gray(h)).join("  |  "));
    out.line("");
    return ExitCode.OK;
  } finally {
    closeCtx(ctx);
  }
}

/** 从事件 JSON 生成一行中文描述（不查库，CLI 侧直接渲染） */
function describeEventJson(e: Record<string, unknown>): string {
  const d = (e.data ?? {}) as Record<string, unknown>;
  switch (e.type) {
    case "task_created": return "创建任务";
    case "task_claimed": return d.prev_assignee ? `抢占（接手自 ${d.prev_assignee}）` : "抢占认领";
    case "task_released": return `释放${d.reason ? `：${d.reason}` : ""}`;
    case "task_reclaimed": return d.holder_crashed ? "持有者失联，已自动回收" : "强制回收";
    case "task_progress": return `进度 ${d.prev_pct ?? "?"}% → ${d.pct}%${d.note ? ` ${d.note}` : ""}`;
    case "task_note": return `备注：${d.text ?? ""}`;
    case "task_blocked": return `阻塞：${d.reason ?? ""}`;
    case "task_unblocked": return "自动解除阻塞";
    case "task_review": return "提交评审";
    case "task_done": return `完成${d.note ? `：${d.note}` : ""}`;
    case "task_cancelled": return `取消：${d.reason ?? ""}`;
    case "task_reopened": return `重新打开：${d.reason ?? ""}`;
    default: return String(e.type);
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
  const json = getBool(args, "json");
  const out = createOutput(json);
  const ctx = openCtx(ctxOptions(args, json));

  try {
    const title = getString(args, "title") ?? args.positionals[0];
    if (!title) {
      throw KanbanError.usage(
        "缺少任务标题",
        '用法：agent-kanban task add "实现存储层" [-d "描述"] [-p 0-4] [--check "步骤1,步骤2"]',
      );
    }
    const estimate = getString(args, "estimate");
    if (estimate && parseDuration(estimate) === null) {
      throw KanbanError.usage(`无法解析预估时长 "${estimate}"`, "支持：30m / 2h / 1d / 1h30m");
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

    out.line(`${style.green("✓")} 创建任务 ${style.cyan(String(task.id))} ${task.title}`);
    const checklist = task.checklist as Array<{ text: string; done: boolean; done_at: number | null; by: string | null }>;
    if (checklist && checklist.length > 0) {
      out.line(`  检查项：${checklist.map((c) => c.text).join(" / ")}`);
    }
    out.line("");
    out.line(style.gray("下一步："));
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
  const ctx = openCtx(ctxOptions(args, json));
  const id = requirePositional(args, 0, "任务号", "用法：agent-kanban task claim T-0007 [--ttl 2h]");

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
    out.line(`${style.green("✓")} 已认领 ${style.cyan(String(task.id))} ${task.title} ${style.gray(`(租约 ${leaseMin} 分钟)`)}`);
    if (task.took_over) {
      out.line(`  ${style.yellow("注意：")}这张卡此前由他人持有${Number(task.progress) > 0 ? `，进度 ${task.progress}% 已保留` : ""}`);
    }
    out.line("");
    out.line(style.gray("提示：每完成一步就跑一次 progress（会自动续租），收工前写 handoff"));
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
  const ctx = openCtx(ctxOptions(args, json));
  const id = requirePositional(args, 0, "任务号", '用法：agent-kanban task progress T-0007 --pct 60 --note "..."');

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
    out.line(`${style.green("✓")} ${style.cyan(String(task.id))} 进度 ${padStartWidth(`${pct}%`, 4)} ${style.cyan(progressBar(pct, 20))}`);
    if (params.note) out.line(`  备注：${params.note}`);
    const checklist = task.checklist as Array<{ text: string; done: boolean }>;
    if (checklist && checklist.length > 0) {
      const done = checklist.filter((c) => c.done).length;
      out.line(`  检查项：${done}/${checklist.length} 完成`);
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
  const ctx = openCtx(ctxOptions(args, json));
  const id = requirePositional(args, 0, "任务号", '用法：agent-kanban task note T-0007 "备注内容"');
  const text = args.positionals[1];
  if (!text) throw KanbanError.usage("缺少备注内容", '用法：agent-kanban task note T-0007 "备注内容"');

  try {
    requireSession(ctx, getString(args, "session"));
    const { data } = await ctx.backend.executeWithHints({ kind: "task.note", params: { task_id: id, text } });
    if (json) {
      out.data(data);
      return ExitCode.OK;
    }
    out.line(`${style.green("✓")} ${style.cyan(id)} 已记录备注`);
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
  const ctx = openCtx(ctxOptions(args, json));
  const id = requirePositional(args, 0, "任务号", opts.usage);

  try {
    requireSession(ctx, getString(args, "session"));
    const reason = getString(args, "reason") ?? args.positionals[1];
    if (opts.reasonRequired && !reason) {
      throw KanbanError.usage("该命令需要 --reason <原因>", opts.usage);
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
    if (reason) out.line(`  原因：${reason}`);
    const unblocked = (task.unblocked as string[] | undefined) ?? [];
    if (unblocked.length > 0) {
      out.line("");
      out.line(`${style.green("⤵")} 依赖它的任务现在可以开工了：${style.cyan(unblocked.join(", "))}`);
      out.line(style.gray(`  认领：agent-kanban task claim ${unblocked[0]}`));
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
  return taskTransition(argv, { kind: "task.block", usage: '用法：agent-kanban task block T-0007 --reason "等待什么"', reasonRequired: true });
}
async function taskUnblock(argv: string[]): Promise<ExitCodeValue> {
  return taskTransition(argv, { kind: "task.unblock", usage: "用法：agent-kanban task unblock T-0007" });
}
async function taskReview(argv: string[]): Promise<ExitCodeValue> {
  return taskTransition(argv, { kind: "task.review", usage: '用法：agent-kanban task review T-0007 [--note "..."]' });
}
async function taskDone(argv: string[]): Promise<ExitCodeValue> {
  return taskTransition(argv, { kind: "task.done", usage: '用法：agent-kanban task done T-0007 [--note "..."] [--force]' });
}
async function taskCancel(argv: string[]): Promise<ExitCodeValue> {
  return taskTransition(argv, { kind: "task.cancel", usage: '用法：agent-kanban task cancel T-0007 --reason "需求变更"', reasonRequired: true });
}
async function taskReopen(argv: string[]): Promise<ExitCodeValue> {
  return taskTransition(argv, { kind: "task.reopen", usage: '用法：agent-kanban task reopen T-0007 --reason "回归失败"', reasonRequired: true });
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
  const ctx = openCtx(ctxOptions(args, json));
  const id = requirePositional(args, 0, "任务号", '用法：agent-kanban task release T-0007 [--reason "..."]');

  try {
    requireSession(ctx, getString(args, "session"));
    const { data } = await ctx.backend.executeWithHints({ kind: "task.release", params: { task_id: id, reason: getString(args, "reason") } });
    const task = data as Record<string, unknown>;
    if (json) {
      out.data(data);
      return ExitCode.OK;
    }
    out.line(`${style.green("✓")} ${style.cyan(id)} 已释放（进度 ${task.progress}% 保留）`);
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
  const ctx = openCtx(ctxOptions(args, json));
  const id = requirePositional(args, 0, "任务号", '用法：agent-kanban task edit T-0007 --title "新标题"');

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
    out.line(`${style.green("✓")} ${style.cyan(id)} 已更新：${task.title}`);
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
      `未知依赖操作：dep ${action ?? ""}`,
      "用法：agent-kanban task dep add|remove|list T-0007 [T-0003]",
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
  const ctx = openCtx(ctxOptions(args, json));
  const id = requirePositional(args, 0, "任务号", "用法：agent-kanban task dep add T-0007 T-0003");

  try {
    let op: Op;
    if (action === "list") {
      op = { kind: "task.dep.list", params: { task_id: id } };
    } else {
      const target = args.positionals[1];
      if (!target) throw KanbanError.usage("缺少依赖的任务号", "用法：agent-kanban task dep add T-0007 T-0003");
      op = {
        kind: action === "add" ? "task.dep.add" : "task.dep.remove",
        params: { task_id: id, depends_on: target },
      };
    }
    const { data } = await ctx.backend.executeWithHints(op);
    const result = data as { dependencies: Array<{ depends_on_id: string }> };
    if (json) {
      out.data(data);
      return ExitCode.OK;
    }
    if (action === "list") {
      if (result.dependencies.length === 0) {
        out.line(`${id} 无依赖`);
        return ExitCode.OK;
      }
      for (const d of result.dependencies) out.line(`  ${d.depends_on_id}`);
      return ExitCode.OK;
    }
    out.line(`${style.green("✓")} ${style.cyan(id)} ${action === "add" ? "新增依赖" : "移除依赖"}（当前 ${result.dependencies.length} 项）`);
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
  const ctx = openCtx(ctxOptions(args, json));
  const id = requirePositional(args, 0, "任务号", "用法：agent-kanban task rm T-0007 [--force]");

  try {
    const { data } = await ctx.backend.executeWithHints({ kind: "task.remove", params: { task_id: id, force: getBool(args, "force") } });
    if (json) {
      out.data(data);
      return ExitCode.OK;
    }
    out.line(`${style.green("✓")} 已删除 ${style.cyan(id)}（事件与交接记录保留）`);
    return ExitCode.OK;
  } finally {
    closeCtx(ctx);
  }
}

// =============================================================================
// 共享工具
// =============================================================================

/** 从解析好的参数构造 CtxOptions（把 CLI 层的 --server/--project/--key 传下去） */
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

/** 需要会话的命令：校验会话标识存在（本地读文件/环境变量，远程靠 --session 头） */
function requireSession(ctx: Ctx, explicit?: string): string {
  return resolveSessionId(ctx, explicit);
}
