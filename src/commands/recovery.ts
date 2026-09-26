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
import { assertKnownOptions, getBool, getInt, getString, parseArgs, requirePositional } from "./args.ts";
import { closeCtx, openCtx, resolveSessionId } from "./context.ts";
import { createOutput, type Output } from "./output.ts";

const CONTEXT_USAGE = `用法：agent-kanban context [选项]

  agent-kanban context                      # 读全局现场（推荐每个会话开工第一步）
  agent-kanban context --task T-0007        # 某张卡的完整档案
  agent-kanban context --no-consume         # 只读预览，不标记交接已读
  agent-kanban context --json               # 结构化输出

输出包含：
  看板概览 · 失联会话告警 · 待接手的交接 · 本会话正在做的 · 阻塞 · 可认领 · 建议动作`;

const RESUME_USAGE = `用法：agent-kanban resume <任务号> [--force] [--tail N]

  agent-kanban resume T-0007                # 接管并注入该卡的交接与时间线
  agent-kanban resume T-0007 --force        # 抢他人仍在有效租约内的卡（需人工确认）

接管后输出：
  · 原持有者与是否发生过崩溃回收
  · 最近的交接（崩溃自动合成 或 主动交接）
  · 剩余 checklist 项
  · 简短时间线
  · 接下来该做什么`;

const DOCTOR_USAGE = `用法：agent-kanban doctor [--deep] [--fix] [--json]

  agent-kanban doctor            # 快速核对（租约/阻塞/progress 一致性）
  agent-kanban doctor --deep     # 额外校验"投影与事件流是否一致"
  agent-kanban doctor --fix      # 自动修复可修复项（回收失联任务、解除过期阻塞）

说明：
  轻量回收（失联任务）其实每次命令调用都会自动执行，doctor 只是显式核对与修复其他问题。`;

/** context / resume / doctor 三个相关命令的统一入口 */
export async function cmdContext(argv: string[]): Promise<ExitCodeValue> {
  const sub = argv[0];
  switch (sub) {
    case "resume":
      return resumeCommand(argv.slice(1));
    case "doctor":
      return doctorCommand(argv.slice(1));
    case undefined:
    case "help":
    case "--help":
      return contextCommand(argv);
    default:
      return contextCommand(argv);
  }
}

// =============================================================================
// agent-kanban context
// =============================================================================

async function contextCommand(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "help", "no-consume"],
    strings: ["task", "session", "tail", "db", "server", "project", "key"],
    short: { j: "json", h: "help", t: "task" },
  });
  assertKnownOptions(args, ["json", "help", "no-consume", "task", "session", "tail", "db", "server", "project", "key"]);
  const json = getBool(args, "json");
  const out = createOutput(json);
  const ctx = openCtx(ctxOptions(args, json));

  try {
    if (getBool(args, "help")) {
      out.line(CONTEXT_USAGE);
      return ExitCode.OK;
    }

    const op: Op = {
      kind: "context.get",
      params: {
        tail: getInt(args, "tail") ?? 20,
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
      style.cyan(`${c.doing ?? 0} 进行中`) + style.gray(" · ") +
      style.yellow(`${c.blocked ?? 0} 阻塞`) + style.gray(" · ") +
      `${c.todo ?? 0} 待办` + style.gray(" · ") +
      style.green(`${c.done ?? 0} 已完成`),
  );

  // ---- 失联会话（最高优先级）----
  if (context.zombie_sessions.length > 0) {
    out.line("");
    out.line(`${style.yellow("⚠ 失联会话")}`);
    for (const z of context.zombie_sessions) {
      for (const t of z.tasks) {
        out.line(
          `  ${z.session_id} ${style.gray(`(${z.agent_name}，${z.silent_minutes} 分钟无心跳)`)} 持有 ` +
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
      `${style.magenta("▶ 交给你的交接")} ${style.gray(`(${context.pending_handoffs.length} 条)`)}` +
        (consumed > 0 ? style.gray(` · 已标记 ${consumed} 条为已读`) : ""),
    );
    for (const h of context.pending_handoffs) {
      const kindLabel = h.kind === "crash" ? style.yellow("崩溃自动合成") : style.green("主动交接");
      out.line("");
      out.line(
        `  ${style.cyan(h.task_id)} ${padEndWidth(truncate(h.task_title, 28), 30)} ` +
          style.gray(`${kindLabel} · ${h.from_session} · ${h.created_relative}`),
      );
      out.line(`    ${h.summary}`);
      if (h.next_step) out.line(`    ${style.gray("下一步：")}${h.next_step}`);
      if (h.blockers.length > 0) out.line(`    ${style.red("卡点：")}${h.blockers.join("、")}`);
      for (const q of h.open_questions) out.line(`    ${style.yellow("待确认：")}${q}`);
    }
  }

  // ---- 本会话正在做的 ----
  if (context.my_tasks.length > 0) {
    out.line("");
    out.line(`${style.blue("⏱ 你正在做的")}`);
    for (const t of context.my_tasks) {
      out.line(
        `  ${style.cyan(t.id)} ${padEndWidth(truncate(t.title, 30), 32)} ` +
          style.cyan(progressBar(t.progress, 10)) + ` ${padEndWidth(`${t.progress}%`, 5)} ` +
          style.gray(t.updated_relative),
      );
      if (t.remaining_checklist.length > 0) {
        out.line(`    ${style.gray("未完成：")}${t.remaining_checklist.join("、")}`);
      }
      if (t.last_event) out.line(`    ${style.gray("最后：")}${truncate(t.last_event, 60)}`);
    }
  }

  // ---- 全部进行中（不含自己的）----
  const othersInProgress = context.in_progress.filter(
    (t) => !context.my_tasks.some((m) => m.id === t.id),
  );
  if (othersInProgress.length > 0) {
    out.line("");
    out.line(style.gray("其他会话在做"));
    for (const t of othersInProgress) {
      const staleMark = t.stale_holder ? style.yellow(" ⚠失联") : "";
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
    out.line(`${style.red("⛔ 阻塞")} ${style.gray("（需要人介入）")}`);
    for (const b of context.blocked) {
      out.line(`  ${style.cyan(b.id)} ${padEndWidth(truncate(b.title, 28), 30)} ${style.red(b.reason ?? "未填原因")}`);
    }
  }

  // ---- 可认领 ----
  if (context.ready.length > 0) {
    out.line("");
    out.line(`${style.green("✅ 可以认领")}`);
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
    out.line(style.bold("建议接下来："));
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
  const ctx = openCtx(ctxOptions(args, json));
  const taskId = requirePositional(args, 0, "任务号", RESUME_USAGE);

  try {
    if (getBool(args, "help")) {
      out.line(RESUME_USAGE);
      return ExitCode.OK;
    }

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
      ? style.yellow("（原持有者崩溃，系统已自动回收，进度保留）")
      : result.previous_holder
        ? style.gray(`（接替 ${result.previous_holder.session_id}${result.previous_holder.agent_name ? ` (${result.previous_holder.agent_name})` : ""}）`)
        : "";
    out.line(
      `${style.green("✓")} 已接管 ${style.cyan(result.task.id)} ${style.bold(result.task.title)} ` +
        style.cyan(progressBar(result.task.progress, 12)) + ` ${result.task.progress}%${reclaimNote}`,
    );

    // ---- 交接 ----
    if (result.handoff) {
      out.line("");
      const kindLabel = result.handoff.kind === "crash" ? style.yellow("崩溃自动合成") : style.green("主动交接");
      out.line(`  ${style.bold("交接")} ${style.gray(`(#${result.handoff.id}, ${kindLabel})`)}`);
      out.line(`    ${result.handoff.summary}`);
      if (result.handoff.next_step) out.line(`    ${style.gray("下一步：")}${result.handoff.next_step}`);
      for (const b of result.handoff.blockers) out.line(`    ${style.red("卡点：")}${b}`);
      for (const q of result.handoff.open_questions) out.line(`    ${style.yellow("待确认：")}${q}`);
    }

    // ---- 剩余工作 ----
    if (result.task.remaining_checklist.length > 0) {
      out.line("");
      out.line(`  ${style.bold("剩余工作")}`);
      for (const item of result.task.remaining_checklist) {
        out.line(`    ⬜ ${item}`);
      }
    }

    // ---- 计划 ----
    if (result.plan) {
      out.line("");
      out.line(`  ${style.gray("计划：")}${style.magenta(result.plan.id)} ${result.plan.title}`);
      out.line(`    ${style.gray(`读全文：agent-kanban plan show ${result.plan.id}`)}`);
    }

    // ---- 时间线 ----
    if (result.timeline.length > 0) {
      out.line("");
      out.line(style.gray("  最近动态"));
      for (const e of result.timeline.slice(-6)) {
        out.line(`    ${style.gray(relativeTime(e.ts, ctx.now()).padEnd(8))}${truncate(e.text, 56)}`);
      }
    }

    // ---- 建议 ----
    if (nextActions.length > 0) {
      out.line("");
      out.line(style.bold("  接下来："));
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
  const json = getBool(args, "json");
  const out = createOutput(json);
  const ctx = openCtx(ctxOptions(args, json));

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
      `${style.bold(ctx.project.name)}  任务 ${Object.values(s.tasks).reduce((a, b) => a + b, 0)} · ` +
        `事件 ${s.events} · 会话 ${s.active_sessions}/${s.sessions} 活跃` +
        (s.stale_sessions > 0 ? style.yellow(`（${s.stale_sessions} 失联）`) : "") +
        (s.pending_handoffs > 0 ? style.magenta(` · 待接手交接 ${s.pending_handoffs}`) : ""),
    );

    if (report.issues.length === 0) {
      out.line("");
      out.line(`${style.green("✓")} 未发现问题${report.deep ? "（含深度检查）" : ""}`);
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

