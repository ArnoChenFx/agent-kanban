/**
 * `agent-kanban rebuild` —— 从事件流重建投影。
 *
 * 这是本项目**自证一致**的命令：events 是唯一事实来源，
 * tasks/plans/handoffs 都只是投影。能从事件把它们完整重算出来，
 * 就说明写入路径没有隐藏 bug。
 *
 * 默认**只校验不写库**。真正的修复要显式 `--write`，
 * 避免一个手滑把辛苦攒的看板抹掉。
 */

import { ExitCode, type ExitCodeValue } from "../core/errors.ts";
import { style } from "../core/format.ts";
import type { FieldDrift } from "../core/rebuild.ts";
import { assertKnownOptions, getBool, getInt, parseArgs, rejectExtraPositionals } from "./args.ts";
import { closeCtx, openCtx,
  ctxOptionsFromArgs,
} from "./context.ts";
import { createOutput } from "./output.ts";

const USAGE = `Usage:
  agent-kanban rebuild                  # verify only: compare the projections with the event stream, change nothing
  agent-kanban rebuild --write          # overwrite the projections with the recomputed result (no drift required, or pair it with --force)
  agent-kanban rebuild --write --force  # force the overwrite even when there is drift
  agent-kanban rebuild --from-seq 100   # replay only the events with seq >= 100 (to isolate a local problem)
  agent-kanban rebuild --json

Notes:
  · Read-only by default, so it is safe to run at any time (including in CI)
  · \`lease_expires_at\` and \`updated_at\` are not compared: they move forward on
    heartbeat/lease renewal, and a renewal writes no event (otherwise the event
    stream would be flooded by heartbeats). This is expected by design.
  · Handoff events written before plans were versioned carry no full content; they are
    listed under "cannot be rebuilt" instead of being reported as drift`;

export async function cmdRebuild(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "help", "write", "force"],
    strings: ["from-seq", "session", "db", "server", "project", "key"],
    short: { j: "json", h: "help", w: "write", f: "force" },
  });
  assertKnownOptions(args, ["json", "help", "write", "force", "from-seq", "session", "db", "server", "project", "key"]);
  rejectExtraPositionals(args, 0, "Usage: agent-kanban rebuild [--write] [--force] [--from-seq N]");
  const json = getBool(args, "json");
  const out = createOutput(json);
  const ctx = openCtx(ctxOptionsFromArgs(args, json));

  try {
    if (getBool(args, "help")) {
      out.line(USAGE);
      return ExitCode.OK;
    }

    const write = getBool(args, "write");
    const force = getBool(args, "force");

    if (force && !write) {
      out.line("Error: --force requires --write");
      out.line("");
      out.line(USAGE);
      return ExitCode.USAGE;
    }

    const { data } = await ctx.backend.executeWithHints({
      kind: "rebuild.check",
      params: { write, force, from_seq: getInt(args, "from-seq") },
    });
    const report = data as {
      project_key: string;
      events_replayed: number;
      counts: { tasks: number; deps: number; plans: number; handoffs: number };
      drift: FieldDrift[];
      incomplete: Array<{ id: string; field: string; reason: string }>;
      ok: boolean;
      written: boolean;
      elapsed_ms: number;
    };

    if (json) return (out.data(report), ExitCode.OK);

    const c = report.counts;
    out.line("");
    out.line(
      `${style.bold(report.project_key)}  replayed ${style.cyan(report.events_replayed)} events ` +
        style.gray(`(${report.elapsed_ms}ms)`),
    );
    out.line(
      style.gray(
        `  Recomputed: tasks ${c.tasks} · deps ${c.deps} · plans ${c.plans} · handoffs ${c.handoffs}`,
      ),
    );

    if (report.ok && report.incomplete.length === 0) {
      out.line("");
      out.line(`${style.green("✓")} the projections match the event stream exactly`);
      out.line(style.gray("  this proves the write path has no hidden bugs (ADR-1 self-verification)"));
      if (report.written) out.line(style.green("  the projections have been overwritten with the recomputed result"));
      out.line("");
      return ExitCode.OK;
    }

    // ---- 漂移 ----
    if (report.drift.length > 0) {
      out.line("");
      out.line(
        `${style.red("✗")} found ${report.drift.length} drifts` +
          style.gray(" (the stored projections ≠ the result recomputed from the events)"),
      );
      for (const d of report.drift.slice(0, 20)) {
        out.line(
          `  ${style.yellow(d.table + "." + d.id)} ${style.gray("field " + d.field)}`,
        );
        out.line(`    ${style.gray("stored:     ")} ${formatValue(d.actual)}`);
        out.line(`    ${style.gray("recomputed: ")} ${formatValue(d.expected)}`);
      }
      if (report.drift.length > 20) {
        out.line(style.gray(`  ... and ${report.drift.length - 20} more`));
      }
      out.line("");
      if (!report.written) {
        out.line(style.gray(`  Fix: agent-kanban rebuild --write${report.drift.length > 0 ? " --force" : ""}`));
        out.line(style.gray("  (--write overwrites tasks/plans/handoffs/task_deps with the event stream)"));
      }
    }

    // ---- 无法重建（历史事件 payload 不足）----
    if (report.incomplete.length > 0) {
      out.line("");
      out.line(`${style.yellow("⚠")} ${report.incomplete.length} records cannot be rebuilt from the event stream`);
      for (const inc of report.incomplete.slice(0, 5)) {
        out.line(`   ${style.gray(inc.id)} ${inc.field}: ${inc.reason}`);
      }
      if (report.incomplete.length > 5) {
        out.line(style.gray(`   ... and ${report.incomplete.length - 5} more`));
      }
      out.line(style.gray("  this does not affect usage: these are historical records written by older versions"));
    }

    out.line("");

    // 有未修复漂移时用非零退出码，方便 CI 卡住
    return report.ok || report.written ? ExitCode.OK : ExitCode.STATE;
  } finally {
    closeCtx(ctx);
  }
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return style.gray("(none)");
  if (typeof v === "string") return v.length > 80 ? `${v.slice(0, 77)}…` : v;
  return JSON.stringify(v);
}

