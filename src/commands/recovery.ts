/**
 * `agent-kanban context` 与 `agent-kanban resume` —— 恢复工作现场。
 *
 * 这是 agent 意外停止后（或换会话接手时）要用的两个命令：
 *   context  读：现在有什么、别人留下了什么、我该干什么
 *   resume   写：接管某张卡，并把该卡的交接与时间线一起注入
 *
 * 设计上它们是"读"与"写"的一对，agent 的恢复流程就是：
 *   1. agent-kanban context              了解全局
 *   2. agent-kanban resume T-0007        接管 + 拿到该卡的完整现场
 *   3. agent-kanban plan show PL-...     读计划全文（如果 resume 输出里有提示）
 */

import { ExitCode, KanbanError, type ExitCodeValue } from "../core/errors.ts";
import {
  padEndWidth,
  progressBar,
  relativeTime,
  style,
  truncate,
} from "../core/format.ts";
import type { Op } from "../core/ops.ts";
import { resolveSessionKey } from "../core/paths.ts";
import { assertKnownOptions, getBool, getInt, getString, parseArgs, rejectExtraPositionals, requirePositional } from "./args.ts";
import { closeCtx, currentSessionId, openCtx, resolveSessionId,
  ctxOptionsFromArgs,
} from "./context.ts";
import { createOutput, type Output } from "./output.ts";

const CONTEXT_USAGE = `Usage: agent-kanban context [options]

  agent-kanban context                      # read the situation (recommended first step of a session)
  agent-kanban context --task T-0007        # full file on one card
  agent-kanban context --no-consume         # preview only, do not mark handoffs as read
  agent-kanban context --json               # structured output

Output includes:
  board overview · stale session warnings · handoffs waiting for you · work in this session · blocked · claimable · suggested actions`;

const RESUME_USAGE = `Usage: agent-kanban resume <task-id> [--force] [--tail N]

  agent-kanban resume T-0007                # take over, injecting that card's handoff and timeline
  agent-kanban resume T-0007 --force        # grab a card whose holder still has a valid lease (needs human confirmation)

Output after taking over:
  · the previous holder, and whether crash recovery happened
  · the latest handoff (auto-composed after a crash, or written by hand)
  · remaining checklist items
  · a short timeline
  · what to do next`;

const DOCTOR_USAGE = `Usage: agent-kanban doctor [--deep] [--fix] [--json]

  agent-kanban doctor            # quick check (lease / blocked / progress consistency)
  agent-kanban doctor --deep     # additionally verify "the projection matches the event stream"
  agent-kanban doctor --fix      # auto-fix what can be fixed (reap stale tasks, clear expired blocks)

Notes:
  Light reaping (stale tasks) already runs automatically on every command; doctor only
  explicitly checks and repairs the remaining problems.`;

/** context / resume / doctor 三个相关命令的统一入口 */
export async function cmdContext(argv: string[]): Promise<ExitCodeValue> {
  const sub = argv[0];
  switch (sub) {
    case "resume":
      return resumeCommand(argv.slice(1));
    case "doctor":
      return doctorCommand(argv.slice(1));
    default:
      // cli.ts 把命令名自己塞在 argv[0]（`[command!, ...withGlobals()]`），
      // 这里必须剥掉，否则 "context" 会被当成位置参数
      return contextCommand(sub === undefined ? argv : argv.slice(1));
  }
}

// =============================================================================
// agent-kanban context
// =============================================================================

async function contextCommand(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "help", "no-consume"],
    strings: ["task", "session", "db", "server", "project", "key"],
    short: { j: "json", h: "help", t: "task" },
  });
  assertKnownOptions(args, ["json", "help", "no-consume", "task", "session", "db", "server", "project", "key"]);
  rejectExtraPositionals(args, 0, "Usage: agent-kanban context [--no-consume]");
  const json = getBool(args, "json");
  const out = createOutput(json);
  const ctx = openCtx(ctxOptionsFromArgs(args, json));

  try {
    if (getBool(args, "help")) {
      out.line(CONTEXT_USAGE);
      return ExitCode.OK;
    }

    const op: Op = {
      kind: "context.get",
      params: {
        // 默认**消费**交接（标记为已读）；--no-consume 只读预览
        consume: !getBool(args, "no-consume"),
      },
    };
    const { data } = await ctx.backend.executeWithHints(op);
    const context = data as RecoveryContextShape;

    if (json) {
      out.data(context);
      return ExitCode.OK;
    }

    // 没注册身份时必须说清楚，否则这块看板在**说谎**：
    // my_tasks 靠 session_id 匹配，而它是空的，于是**自己的卡会被列进
    // “Other sessions in progress”**，看上去像别人在干。
    // 升级到身份分片（.kanban/sessions/<key>）后的第一次 context 正好命中这个状态，
    // 而 context 又是协议里要求 agent 跑的第一条命令——这里不提示，agent 会直接被误导。
    const identity = currentSessionId(ctx.paths.dir, getString(args, "session"));
    if (!identity) {
      const key = resolveSessionKey();
      out.line(
        style.yellow("⚠ not registered as a session") +
          (key ? style.gray(`  (identity key: ${key})`) : ""),
      );
      out.line(
        style.gray("  Your own cards will show up under “Other sessions” until you register."),
      );
      out.line(
        style.gray("  Fix: agent-kanban session start --agent <name> --harness <harness>"),
      );
      out.line("");
    }

    renderContext(out, context, ctx.project.key);
    return ExitCode.OK;
  } finally {
    closeCtx(ctx);
  }
}

/** context 的 JSON 形状（与 core/context.ts 的 RecoveryContext 对应） */
interface RecoveryContextShape {
  project: { key: string; name: string };
  generated_at: number;
  counts: Record<string, number>;
  zombie_sessions: Array<{
    session_id: string;
    agent_name: string;
    silent_minutes: number;
    tasks: Array<{ id: string; title: string; progress: number }>;
    suggestion: string;
  }>;
  pending_handoffs: Array<{
    id: number;
    task_id: string;
    task_title: string;
    from_session: string;
    kind: string;
    summary: string;
    next_step: string | null;
    blockers: string[];
    open_questions: string[];
    created_relative: string;
    task_progress: number;
  }>;
  my_tasks: Array<{ id: string; title: string; progress: number; remaining_checklist: string[]; last_event: string | null; updated_relative: string }>;
  in_progress: Array<{ id: string; title: string; progress: number; assignee: string | null; assignee_agent: string | null; stale_holder: boolean }>;
  blocked: Array<{ id: string; title: string; reason: string | null }>;
  ready: Array<{ id: string; title: string; priority: number; reason: string }>;
  next_actions: string[];
  /** 本次读取已标记为已读的交接数（仅 consume=true 时出现） */
  consumed_count?: number;
}

function renderContext(out: Output, context: RecoveryContextShape, projectKey: string): void {
  const c = context.counts;

  // ---- 概览 ----
  out.line("");
  out.line(
    `${style.bold(context.project.name)} ${style.gray(`(${projectKey})`)}   ` +
      style.cyan(`${c.doing ?? 0} Doing`) + style.gray(" · ") +
      style.yellow(`${c.blocked ?? 0} Blocked`) + style.gray(" · ") +
      `${c.todo ?? 0} Todo` + style.gray(" · ") +
      style.green(`${c.done ?? 0} Done`),
  );

  // ---- 失联会话（最高优先级）----
  if (context.zombie_sessions.length > 0) {
    out.line("");
    out.line(`${style.yellow("⚠ Stale sessions")}`);
    for (const z of context.zombie_sessions) {
      for (const t of z.tasks) {
        out.line(
          `  ${z.session_id} ${style.gray(`(${z.agent_name}, no heartbeat for ${z.silent_minutes} min)`)} holds ` +
            `${style.cyan(t.id)} ${truncate(t.title, 24)} ${style.gray(`${t.progress}%`)}`,
        );
        out.line(`    ${style.bold(z.suggestion)}`);
      }
    }
  }

  // ---- 待接手的交接 ----
  if (context.pending_handoffs.length > 0) {
    const consumed = context.consumed_count ?? 0;
    out.line("");
    out.line(
      `${style.magenta("▶ Handoffs for you")} ${style.gray(`(${context.pending_handoffs.length})`)}` +
        (consumed > 0 ? style.gray(` · ${consumed} marked as read`) : ""),
    );
    for (const h of context.pending_handoffs) {
      const kindLabel = h.kind === "crash" ? style.yellow("auto-composed") : style.green("manual");
      out.line("");
      out.line(
        `  ${style.cyan(h.task_id)} ${padEndWidth(truncate(h.task_title, 28), 30)} ` +
          style.gray(`${kindLabel} · ${h.from_session} · ${h.created_relative}`),
      );
      out.line(`    ${h.summary}`);
      if (h.next_step) out.line(`    ${style.gray("Next:")} ${h.next_step}`);
      if (h.blockers.length > 0) out.line(`    ${style.red("Blockers:")} ${h.blockers.join(", ")}`);
      for (const q of h.open_questions) out.line(`    ${style.yellow("Open:")} ${q}`);
    }
  }

  // ---- 本会话正在做的 ----
  if (context.my_tasks.length > 0) {
    out.line("");
    out.line(`${style.blue("⏱ Your work in progress")}`);
    for (const t of context.my_tasks) {
      out.line(
        `  ${style.cyan(t.id)} ${padEndWidth(truncate(t.title, 30), 32)} ` +
          style.cyan(progressBar(t.progress, 10)) + ` ${padEndWidth(`${t.progress}%`, 5)} ` +
          style.gray(t.updated_relative),
      );
      if (t.remaining_checklist.length > 0) {
        out.line(`    ${style.gray("Remaining:")} ${t.remaining_checklist.join(", ")}`);
      }
      if (t.last_event) out.line(`    ${style.gray("Last:")} ${truncate(t.last_event, 60)}`);
    }
  }

  // ---- 全部进行中（不含自己的）----
  const othersInProgress = context.in_progress.filter(
    (t) => !context.my_tasks.some((m) => m.id === t.id),
  );
  if (othersInProgress.length > 0) {
    out.line("");
    out.line(style.gray("Other sessions in progress"));
    for (const t of othersInProgress) {
      const staleMark = t.stale_holder ? style.yellow(" ⚠stale") : "";
      out.line(
        `  ${style.cyan(t.id)} ${padEndWidth(truncate(t.title, 30), 32)} ` +
          style.cyan(progressBar(t.progress, 8)) + ` ${padEndWidth(`${t.progress}%`, 5)}` +
          style.gray(` ${t.assignee_agent ?? t.assignee ?? "-"}${staleMark}`),
      );
    }
  }

  // ---- 阻塞 ----
  if (context.blocked.length > 0) {
    out.line("");
    out.line(`${style.red("⛔ Blocked")} ${style.gray("(needs a human)")}`);
    for (const b of context.blocked) {
      out.line(`  ${style.cyan(b.id)} ${padEndWidth(truncate(b.title, 28), 30)} ${style.red(b.reason ?? "no reason given")}`);
    }
  }

  // ---- 可认领 ----
  if (context.ready.length > 0) {
    out.line("");
    out.line(`${style.green("✅ Claimable")}`);
    for (const r of context.ready.slice(0, 8)) {
      out.line(
        `  ${style.cyan(r.id)} p${r.priority} ${padEndWidth(truncate(r.title, 34), 36)} ` +
          style.gray(r.reason),
      );
    }
  }

  // ---- 建议动作 ----
  if (context.next_actions.length > 0) {
    out.line("");
    out.line(style.bold("Suggested next steps:"));
    for (const action of context.next_actions) {
      out.line(`  ${action}`);
    }
  }
  out.line("");
}

// =============================================================================
// agent-kanban resume
// =============================================================================

async function resumeCommand(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "help", "force"],
    strings: ["tail", "session", "db", "server", "project", "key"],
    short: { j: "json", h: "help", f: "force" },
  });
  assertKnownOptions(args, ["json", "help", "force", "tail", "session", "db", "server", "project", "key"]);
  const json = getBool(args, "json");
  const out = createOutput(json);
  // help 必须先于 requirePositional：否则 `resume --help` 报的是"缺 task id"
  if (getBool(args, "help")) {
    out.line(RESUME_USAGE);
    return ExitCode.OK;
  }
  rejectExtraPositionals(args, 1, "Usage: agent-kanban resume <task-id> [--force]");
  const ctx = openCtx(ctxOptionsFromArgs(args, json));
  const taskId = requirePositional(args, 0, "task id", RESUME_USAGE);

  try {

    // resume 需要明确的会话身份（否则无法记录是谁接手的）
    resolveSessionId(ctx, getString(args, "session"));

    const { data, nextActions } = await ctx.backend.executeWithHints({
      kind: "resume.task",
      params: {
        task_id: taskId,
        force: getBool(args, "force"),
        tail: getInt(args, "tail") ?? 10,
      },
    });
    const result = data as ResumeShape;

    if (json) {
      out.data(result);
      return ExitCode.OK;
    }

    // ---- 接管结果 ----
    out.line("");
    const reclaimNote = result.reclaimed
      ? style.yellow("(the previous holder crashed and was already reaped; progress preserved)")
      : result.previous_holder
        ? style.gray(`(took over from ${result.previous_holder.session_id}${result.previous_holder.agent_name ? ` (${result.previous_holder.agent_name})` : ""})`)
        : "";
    out.line(
      `${style.green("✓")} Took over ${style.cyan(result.task.id)} ${style.bold(result.task.title)} ` +
        style.cyan(progressBar(result.task.progress, 12)) + ` ${result.task.progress}%${reclaimNote}`,
    );

    // ---- 交接 ----
    if (result.handoff) {
      out.line("");
      const kindLabel = result.handoff.kind === "crash" ? style.yellow("auto-composed") : style.green("manual");
      out.line(`  ${style.bold("Handoff")} ${style.gray(`(#${result.handoff.id}, ${kindLabel})`)}`);
      out.line(`    ${result.handoff.summary}`);
      if (result.handoff.next_step) out.line(`    ${style.gray("Next:")} ${result.handoff.next_step}`);
      for (const b of result.handoff.blockers) out.line(`    ${style.red("Blockers:")} ${b}`);
      for (const q of result.handoff.open_questions) out.line(`    ${style.yellow("Open:")} ${q}`);
    }

    // ---- 剩余工作 ----
    if (result.task.remaining_checklist.length > 0) {
      out.line("");
      out.line(`  ${style.bold("Remaining work")}`);
      for (const item of result.task.remaining_checklist) {
        out.line(`    ⬜ ${item}`);
      }
    }

    // ---- 计划 ----
    if (result.plan) {
      out.line("");
      out.line(`  ${style.gray("Plan:")} ${style.magenta(result.plan.id)} ${result.plan.title}`);
      out.line(`    ${style.gray(`read the full plan: agent-kanban plan show ${result.plan.id}`)}`);
    }

    // ---- 时间线 ----
    if (result.timeline.length > 0) {
      out.line("");
      out.line(style.gray("  Recent activity"));
      for (const e of result.timeline.slice(-6)) {
        // padEnd(10) 与 task.ts 的时间线列保持一致；英文化后相对时间最长是 "just now"（8 字符），
        // 用原来的 8 会让时间与文本粘在一起。
        out.line(`    ${style.gray(relativeTime(e.ts, ctx.now()).padEnd(10))}${truncate(e.text, 56)}`);
      }
    }

    // ---- 建议 ----
    if (nextActions.length > 0) {
      out.line("");
      out.line(style.bold("  Next:"));
      for (const action of nextActions) {
        out.line(`    ${action}`);
      }
    }
    out.line("");
    return ExitCode.OK;
  } finally {
    closeCtx(ctx);
  }
}

interface ResumeShape {
  task: { id: string; title: string; progress: number; status: string; remaining_checklist: string[] };
  reclaimed: boolean;
  previous_holder: { session_id: string; agent_name?: string | null } | null;
  handoff: {
    id: number;
    kind: string;
    summary: string;
    next_step: string | null;
    blockers: string[];
    open_questions: string[];
  } | null;
  timeline: Array<{ ts: number; type: string; text: string }>;
  plan: { id: string; title: string; version: number } | null;
  next_actions: string[];
}

// =============================================================================
// agent-kanban doctor
// =============================================================================

async function doctorCommand(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "help", "deep", "fix"],
    strings: ["session", "db", "server", "project", "key"],
    short: { j: "json", h: "help", d: "deep", f: "fix" },
  });
  assertKnownOptions(args, ["json", "help", "deep", "fix", "session", "db", "server", "project", "key"]);
  rejectExtraPositionals(args, 0, "Usage: agent-kanban doctor [--deep] [--fix]");
  const json = getBool(args, "json");
  const out = createOutput(json);
  const ctx = openCtx(ctxOptionsFromArgs(args, json));

  try {
    if (getBool(args, "help")) {
      out.line(DOCTOR_USAGE);
      return ExitCode.OK;
    }

    const { data } = await ctx.backend.executeWithHints({
      kind: "doctor.check",
      params: { deep: getBool(args, "deep"), fix: getBool(args, "fix") },
    });
    const report = data as {
      ok: boolean;
      issues: Array<{ code: string; message: string; subjects: string[]; fixed: boolean; hint: string; severity: string }>;
      stats: Record<string, unknown>;
      deep: boolean;
    };

    if (json) {
      out.data(report);
      return ExitCode.OK;
    }

    const s = report.stats as {
      tasks: Record<string, number>;
      events: number;
      active_sessions: number;
      sessions: number;
      stale_sessions: number;
      pending_handoffs: number;
    };
    out.line("");
    out.line(
      `${style.bold(ctx.project.name)}  tasks ${Object.values(s.tasks).reduce((a, b) => a + b, 0)} · ` +
        `events ${s.events} · sessions ${s.active_sessions}/${s.sessions} active` +
        (s.stale_sessions > 0 ? style.yellow(` (${s.stale_sessions} stale)`) : "") +
        (s.pending_handoffs > 0 ? style.magenta(` · ${s.pending_handoffs} handoffs waiting`) : ""),
    );

    if (report.issues.length === 0) {
      out.line("");
      out.line(`${style.green("✓")} No problems found${report.deep ? " (including deep checks)" : ""}`);
      out.line("");
      return ExitCode.OK;
    }

    out.line("");
    for (const issue of report.issues) {
      const mark = issue.fixed ? style.green("✓") : issue.severity === "error" ? style.red("✗") : style.yellow("⚠");
      out.line(`${mark} ${issue.message}`);
      if (issue.subjects.length > 0) {
        const subjects = issue.subjects.slice(0, 8).join(" ");
        const more = issue.subjects.length > 8 ? " ..." : "";
        out.line(`   ${style.gray(subjects + more)}`);
      }
      if (issue.hint) out.line(`   ${style.gray(issue.hint)}`);
    }
    out.line("");
    return ExitCode.OK;
  } finally {
    closeCtx(ctx);
  }
}


