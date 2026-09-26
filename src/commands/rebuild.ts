/**
 * `kanban rebuild` —— 从事件流重建投影。
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
import { assertKnownOptions, getBool, getInt, getString, parseArgs } from "./args.ts";
import { closeCtx, openCtx } from "./context.ts";
import { createOutput } from "./output.ts";

const USAGE = `用法：
  kanban rebuild                  # 只校验：比对投影与事件流，不改任何数据
  kanban rebuild --write          # 用事件流重算结果覆盖投影（需无漂移，或配合 --force）
  kanban rebuild --write --force  # 有漂移也强制覆盖
  kanban rebuild --from-seq 100   # 只重放 seq >= 100 的事件（排查局部问题）
  kanban rebuild --json

说明：
  · 默认只读，可以放心随时跑（CI 里也可以跑）
  · \`lease_expires_at\` 与 \`updated_at\` 不参与比较：它们由心跳/续租前移，
    而续租不写事件（否则事件量会被心跳淹没）。这是设计上的正常现象。
  · 升级到计划版本化之前的历史交接事件不带完整内容，会被列进"无法重建"而不是误报漂移`;

export async function cmdRebuild(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "help", "write", "force"],
    strings: ["from-seq", "session", "db", "server", "project", "key"],
    short: { j: "json", h: "help", w: "write", f: "force" },
  });
  assertKnownOptions(args, ["json", "help", "write", "force", "from-seq", "session", "db", "server", "project", "key"]);
  const json = getBool(args, "json");
  const out = createOutput(json);
  const ctx = openCtx(ctxOptions(args, json));

  try {
    if (getBool(args, "help")) {
      out.line(USAGE);
      return ExitCode.OK;
    }

    const write = getBool(args, "write");
    const force = getBool(args, "force");

    if (force && !write) {
      out.line("错误：--force 需要与 --write 一起用");
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
      `${style.bold(report.project_key)}  重放 ${style.cyan(report.events_replayed)} 个事件 ` +
        style.gray(`(${report.elapsed_ms}ms)`),
    );
    out.line(
      style.gray(
        `  重算结果：任务 ${c.tasks} · 依赖 ${c.deps} · 计划 ${c.plans} · 交接 ${c.handoffs}`,
      ),
    );

    if (report.ok && report.incomplete.length === 0) {
      out.line("");
      out.line(`${style.green("✓")} 投影与事件流完全一致`);
      out.line(style.gray("  这证明写入路径没有隐藏 bug（ADR-1 的自证）"));
      if (report.written) out.line(style.green("  已用重算结果覆盖投影"));
      out.line("");
      return ExitCode.OK;
    }

    // ---- 漂移 ----
    if (report.drift.length > 0) {
      out.line("");
      out.line(
        `${style.red("✗")} 发现 ${report.drift.length} 处漂移` +
          style.gray("（库里现有投影 ≠ 从事件重算的结果）"),
      );
      for (const d of report.drift.slice(0, 20)) {
        out.line(
          `  ${style.yellow(d.table + "." + d.id)} ${style.gray("字段 " + d.field)}`,
        );
        out.line(`    ${style.gray("库里:")} ${formatValue(d.actual)}`);
        out.line(`    ${style.gray("重算:")} ${formatValue(d.expected)}`);
      }
      if (report.drift.length > 20) {
        out.line(style.gray(`  ... 还有 ${report.drift.length - 20} 处`));
      }
      out.line("");
      if (!report.written) {
        out.line(style.gray(`  修复：kanban rebuild --write${report.drift.length > 0 ? " --force" : ""}`));
        out.line(style.gray("  （--write 会用事件流覆盖 tasks/plans/handoffs/task_deps）"));
      }
    }

    // ---- 无法重建（历史事件 payload 不足）----
    if (report.incomplete.length > 0) {
      out.line("");
      out.line(`${style.yellow("⚠")} ${report.incomplete.length} 条记录无法从事件流重建`);
      for (const inc of report.incomplete.slice(0, 5)) {
        out.line(`   ${style.gray(inc.id)} ${inc.field}：${inc.reason}`);
      }
      if (report.incomplete.length > 5) {
        out.line(style.gray(`   ... 还有 ${report.incomplete.length - 5} 条`));
      }
      out.line(style.gray("  这不影响使用：这些是旧版本写入的历史数据"));
    }

    out.line("");

    // 有未修复漂移时用非零退出码，方便 CI 卡住
    return report.ok || report.written ? ExitCode.OK : ExitCode.STATE;
  } finally {
    closeCtx(ctx);
  }
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return style.gray("(无)");
  if (typeof v === "string") return v.length > 80 ? `${v.slice(0, 77)}…` : v;
  return JSON.stringify(v);
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
