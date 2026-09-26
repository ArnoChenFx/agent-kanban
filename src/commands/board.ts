/**
 * `agent-kanban board` —— 终端泳道视图。
 *
 * 与其他命令一致走 Op（ADR-10）：看板数据从 `board.get` 拿，
 * 因此本地与远程渲染出完全一样的画面。
 *
 * 布局原则：需要人（或恢复中的 agent）立刻行动的信息置顶且醒目：
 * 失联会话 > 阻塞任务 > 可认领任务。
 */

import { ExitCode, type ExitCodeValue } from "../core/errors.ts";
import {
  padEndWidth,
  padStartWidth,
  progressBar,
  relativeTime,
  statusColor,
  statusLabel,
  style,
  truncate,
} from "../core/format.ts";
import type { TaskStatus } from "../core/types.ts";
import { assertKnownOptions, getBool, getInt, getString, parseArgs } from "./args.ts";
import { closeCtx, openCtx } from "./context.ts";
import { createOutput, type Output } from "./output.ts";

const USAGE = `Usage: agent-kanban board [--ready] [--mine] [--all] [--json]

Options:
  --ready   only claimable tasks (dependencies met, nobody holds them)
  --mine    only tasks held by / owned by the current session
  --all     include cancelled tasks
  --json    structured output (same shape as /api/board)

Modes:
  Local:   agent-kanban board
  Remote:  kanban --server https://kanban.corp --project app --key k_xxx board`;

/** board 泳道顺序：与人的心智模型一致 */
const LANES: Array<{ status: TaskStatus; title: string; hint: string }> = [
  { status: "todo", title: "Todo", hint: "dependencies met, claim it to start" },
  { status: "doing", title: "Doing", hint: "a session holds the lease" },
  { status: "blocked", title: "Blocked", hint: "waiting on an external condition, needs a human" },
  { status: "review", title: "Review", hint: "output waiting for confirmation" },
  { status: "done", title: "Done", hint: "recently completed" },
];

export async function cmdBoard(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "ready", "mine", "all", "help"],
    strings: ["db", "session", "server", "project", "key", "limit"],
    short: { j: "json", r: "ready", m: "mine", a: "all", h: "help" },
  });
  assertKnownOptions(args, ["json", "ready", "mine", "all", "help", "db", "session", "server", "project", "key", "limit"]);
  const json = getBool(args, "json");
  const out = createOutput(json);
  const ctx = openCtx({
    json,
    dbPath: getString(args, "db"),
    sessionId: getString(args, "session"),
    server: getString(args, "server"),
    project: getString(args, "project"),
    key: getString(args, "key"),
  });

  try {
    if (getBool(args, "help")) {
      out.line(USAGE);
      return ExitCode.OK;
    }
    const now = ctx.now();
    const { data } = await ctx.backend.executeWithHints({
      kind: "board.get",
      params: { include_done: true },
    });
    const snapshot = data as {
      project: { key: string; name: string };
      counts: Record<TaskStatus, number>;
      lanes: Record<TaskStatus, Array<Record<string, unknown>>>;
      sessions: Array<Record<string, unknown>>;
    };

    if (json) {
      out.data(snapshot);
      return ExitCode.OK;
    }

    renderBoard(out, snapshot, now, {
      readyOnly: getBool(args, "ready"),
      mineOnly: getBool(args, "mine"),
      sessionId: getString(args, "session") ?? null,
      limit: getInt(args, "limit"),
    });
    return ExitCode.OK;
  } finally {
    closeCtx(ctx);
  }
}

function renderBoard(
  out: Output,
  snapshot: {
    project: { key: string; name: string };
    counts: Record<TaskStatus, number>;
    lanes: Record<TaskStatus, Array<Record<string, unknown>>>;
    sessions: Array<Record<string, unknown>>;
  },
  now: number,
  opts: { readyOnly: boolean; mineOnly: boolean; sessionId: string | null; limit?: number },
): void {
  const c = snapshot.counts;
  const active = c.doing + c.todo + c.blocked + c.review;

  // ---- 顶部概览 ----
  out.line("");
  out.line(
    `${style.bold(snapshot.project.name)}  ${style.gray(`(${snapshot.project.key})`)}  ` +
      style.cyan(`${c.doing} Doing`) + style.gray(" · ") +
      style.yellow(`${c.blocked} Blocked`) + style.gray(" · ") +
      `${c.todo} Todo` + style.gray(" · ") +
      style.green(`${c.done} Done`),
  );

  // ---- 失联会话告警：最高优先级信息 ----
  const zombies = snapshot.sessions.filter(
    (s) => s.stale === true && (s.status === "active" || s.status === "idle") && ((s.tasks as string[]) ?? []).length > 0,
  );
  if (zombies.length > 0) {
    out.line("");
    for (const z of zombies) {
      out.line(`${style.yellow("⚠ Stale session")} ${z.id} ${style.gray(`(${z.agent_name}, last heartbeat ${z.fresh})`)}`);
      for (const taskId of (z.tasks as string[]) ?? []) {
        out.line(
          `    holds ${style.cyan(taskId)} ${style.gray("→ ")}${style.bold("agent-kanban resume " + taskId)}` +
            style.gray("  take over (progress is preserved automatically)"),
        );
      }
    }
  }

  // ---- 泳道 ----
  let renderedAny = false;
  for (const lane of LANES) {
    let tasks = snapshot.lanes[lane.status] ?? [];
    if (opts.mineOnly && opts.sessionId) {
      tasks = tasks.filter((t) => t.assignee_session_id === opts.sessionId);
    }
    if (opts.readyOnly) {
      // ready 的完整判据在 core（依赖满足 + 未被持有），
      // 这里用可读的近似：未被持有且无阻塞
      tasks = tasks.filter((t) => !t.assignee_session_id);
    }
    if (opts.limit && tasks.length > opts.limit) tasks = tasks.slice(0, opts.limit);
    if (tasks.length === 0) continue;

    renderedAny = true;
    out.line("");
    out.line(
      `${style[statusColor(lane.status) as "cyan"](style.bold(lane.title))} ${style.gray(`(${tasks.length})`)}  ${style.gray(lane.hint)}`,
    );
    for (const t of tasks) out.line("  " + renderCard(t, now, snapshot.sessions));
  }

  if (active === 0) {
    out.line("");
    out.line(style.gray('  (the board is empty) create the first card with `agent-kanban task add "title"`'));
  } else if (opts.readyOnly && !renderedAny) {
    out.line("");
    out.line(style.gray("  (no claimable tasks: the remaining todo tasks still have unfinished dependencies, or another session already holds them)"));
  }

  // ---- 会话区 ----
  const live = snapshot.sessions.filter((s) => s.status !== "closed");
  if (live.length > 0) {
    out.line("");
    out.line(style.gray(`Sessions (${live.length})`));
    for (const s of live) {
      const mark = s.stale ? style.yellow("⚠") : style.green("●");
      const tasks = (s.tasks as string[]) ?? [];
      out.line(
        `  ${mark} ${padEndWidth(String(s.id), 10)} ${padEndWidth(String(s.agent_name), 16)} ` +
          style.gray(`${String(s.fresh ?? "?").padEnd(8)} ${tasks.length > 0 ? tasks.join(", ") : "-"}`),
      );
    }
  }
  out.line("");
}

/** 单张卡片的一行渲染（列宽固定，保证中英混排对齐） */
function renderCard(
  task: Record<string, unknown>,
  now: number,
  sessions: Array<Record<string, unknown>>,
): string {
  const idPart = style.cyan(padEndWidth(String(task.id), 8));
  const pColor = Number(task.priority) <= 1 ? "red" : Number(task.priority) <= 2 ? "yellow" : "gray";
  const pPart = style[pColor](`p${task.priority}`.padStart(2));
  const titlePart = padEndWidth(truncate(String(task.title), 32), 32);

  const pct = Number(task.progress ?? 0);
  const progressPart =
    pct > 0
      ? style.cyan(padEndWidth(`${padStartWidth(`${pct}%`, 4)} ${progressBar(pct, 8)}`, 13))
      : style.gray(padEndWidth("     -       ", 13));

  const check = task.checklist as { total?: number; done?: number } | undefined;
  const checkPart =
    check && check.total && check.total > 0
      ? style.gray(padEndWidth(`☑${check.done ?? 0}/${check.total}`, 7))
      : " ".repeat(7);

  let holderPart = " ".repeat(16);
  if (task.assignee_session_id) {
    const holder = sessions.find((s) => s.id === task.assignee_session_id);
    const raw = holder?.stale
      ? `${task.assignee_session_id} ⚠stale`
      : `${task.assignee_session_id} ${relativeTime(Number(task.updated_at), now)}`;
    holderPart = padEndWidth(holder?.stale ? style.yellow(raw) : style.gray(raw), 16);
  }

  // 尾部标记：阻塞原因 / 依赖未满足 / 可认领
  let tailPart = "";
  if (task.status === "blocked" && task.block_reason) {
    tailPart = style.red(`⛔ ${truncate(String(task.block_reason), 36)}`);
  } else if (task.status === "todo" && !task.assignee_session_id) {
    const unfinished = (task.unfinished_dependencies as string[] | undefined) ?? [];
    tailPart = unfinished.length > 0
      ? style.gray(`⏳ waiting for ${unfinished.join(",")}`)
      : style.cyan("claimable");
  }

  return `${idPart}${pPart}  ${titlePart}  ${progressPart}  ${checkPart}  ${holderPart}${tailPart}`;
}
