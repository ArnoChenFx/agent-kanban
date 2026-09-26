/**
 * `agent-kanban export / import / snapshot / compact` —— 备份与维护。
 *
 * 这组命令只碰本地库，不参与远程模式：导出的是本机数据，
 * 而远程模式的真身在 server 上（要备份请在 server 机器上跑）。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { KanbanError, ExitCode, type ExitCodeValue } from "../core/errors.ts";
import { style } from "../core/format.ts";
import {
  compactEvents,
  exportEvents,
  importEvents,
  listJournalFiles,
  requireJournalDir,
  verifyReadable,
  writeSnapshot,
} from "../core/backup.ts";
import { resolvePaths } from "../core/paths.ts";
import { closeDb, openDb, type Db } from "../core/db.ts";
import { resolveLocalProject } from "../core/projects.ts";
import { assertKnownOptions, getBool, getInt, getString, parseArgs } from "./args.ts";
import { createOutput } from "./output.ts";
import type { Scope } from "../core/tasks.ts";

const USAGE = `Usage: agent-kanban export | import | snapshot | compact

  export   [--out <dir>] [--since <ts>]          Export the event journal (one file per day)
  import   <file|dir>... [--dry-run]             Rebuild the database from a journal (idempotent, deduped by seq)
              [--project <key>] [--keep-project]
  snapshot [--out <file>]                        Write a board snapshot (human-readable JSON, cannot be imported)
  compact  [--keep-days 30]                      Trim old events (takes a snapshot first, then deletes)

Notes:
  · .kanban/kanban.db is not in git; cross-machine migration relies on export + import
  · events are the single source of truth, so replaying a journal fully restores the board
    and there is no need to back up the db file
  · the project key is derived from the directory name, so it differs between machines. import
    rewrites the events to the current project by default; pass --keep-project to keep the
    original key (multi-project migration)
  · compact is irreversible: it first writes a snapshot to .kanban/snapshots/
  · these commands only work in local mode (in remote mode the real data lives on the server)

Examples:
  agent-kanban export --out .kanban/journal
  agent-kanban import .kanban/journal --dry-run
  agent-kanban import .kanban/journal
  agent-kanban rebuild --write        # rebuild the projections after replaying
  agent-kanban compact --keep-days 30`;

/** 打开本地库并解析 project */
function openLocal(): { db: Db; scope: Scope; paths: ReturnType<typeof resolvePaths>; close: () => void } {
  const paths = resolvePaths({ cwd: process.cwd() });
  const db = openDb(paths.db, { createIfMissing: false });
  const project = resolveLocalProject(db.raw, { rootPath: paths.projectRoot, now: Date.now() });
  return {
    db,
    paths,
    scope: { db: db.raw, projectKey: project.key },
    close: () => closeDb(db),
  };
}

export async function cmdBackup(argv: string[]): Promise<ExitCodeValue> {
  const sub = argv[0];
  const rest = argv.slice(1);
  switch (sub) {
    case "export":
      return doExport(rest);
    case "import":
      return doImport(rest);
    case "snapshot":
      return doSnapshot(rest);
    case "compact":
      return doCompact(rest);
    case undefined:
    case "help":
    case "--help":
      process.stdout.write(USAGE + "\n");
      return ExitCode.OK;
    default:
      throw KanbanError.usage(`unknown command: ${sub}`, USAGE);
  }
}

function doExport(argv: string[]): ExitCodeValue {
  const args = parseArgs(argv, {
    booleans: ["json", "help"],
    strings: ["out", "since", "session", "db", "server", "project", "key"],
    short: { h: "help" },
  });
  assertKnownOptions(args, ["json", "help", "out", "since", "session", "db", "server", "project", "key"]);
  const out = createOutput(getBool(args, "json"));

  const local = openLocal();
  try {
    const dir = getString(args, "out") ?? join(local.paths.dir, "journal");
    const sinceRaw = getString(args, "since");
    if (sinceRaw !== undefined && Number.isNaN(Number(sinceRaw))) {
      throw KanbanError.usage("--since needs an epoch millisecond timestamp", `got: ${sinceRaw}`);
    }

    const result = exportEvents(local.db.raw, {
      outDir: dir,
      sinceTs: sinceRaw ? Number(sinceRaw) : undefined,
      now: Date.now(),
    });

    out.data({ files: result.files, events: result.events, projects: result.projects });
    if (result.events === 0) {
      out.line(`${style.yellow("no events to export")} (the database is empty, or --since filtered everything out)`);
      return ExitCode.OK;
    }
    out.line(
      `${style.green("✓")} exported ${result.events} events → ${style.gray(`${result.files.length} files`)}`,
    );
    for (const f of result.files) out.line(`  ${style.gray(f)}`);
    out.blank();
    out.line(style.gray("On a new machine: agent-kanban import <that dir> && agent-kanban rebuild --write"));
    return ExitCode.OK;
  } finally {
    local.close();
  }
}

function doImport(argv: string[]): ExitCodeValue {
  const args = parseArgs(argv, {
    booleans: ["json", "help", "dry-run", "keep-project"],
    strings: ["dir", "project", "session", "db", "server", "key"],
    short: { h: "help" },
  });
  assertKnownOptions(args, ["json", "help", "dry-run", "keep-project", "dir", "project", "session", "db", "server", "key"]);

  const json = getBool(args, "json");
  const dryRun = getBool(args, "dry-run", false);
  const out = createOutput(json);

  const dirOpt = getString(args, "dir");
  if (args.positionals.length === 0 && !dirOpt) {
    throw KanbanError.usage("import needs at least one file or directory", USAGE);
  }

  const local = openLocal();
  try {
    // 位置参数可能是目录也可能���文件：目录则展开成其下的全部 journal
    const targets: string[] = [];
    for (const p of args.positionals) {
      const expanded = listJournalFiles(p);
      targets.push(...(expanded.length > 0 ? expanded : [p]));
    }
    if (dirOpt) {
      requireJournalDir(dirOpt);
      targets.push(...listJournalFiles(dirOpt));
    }

    const unreadable = verifyReadable(targets);
    if (unreadable.length > 0) {
      throw KanbanError.state(`${unreadable.length} files could not be read`, {
        hint: `check the paths and permissions: ${unreadable.join(", ")}`,
      });
    }

    const result = importEvents(local.db.raw, targets, {
      dryRun,
      now: Date.now(),
      targetProjectKey: getString(args, "project") ?? local.scope.projectKey,
      keepProject: getBool(args, "keep-project", false),
    });
    out.data({
      applied: result.applied,
      plans: result.plans,
      dry_run: dryRun,
      remapped: result.remapped,
    });

    // project 重映射必须显式告知：它改了事件归属，事后很难自己看出来
    for (const r of result.remapped) {
      out.line(`${style.yellow("↻")} project remapped: ${style.gray(`${r.from} → ${r.to}`)}`);
    }
    if (result.remapped.length === 0 && getBool(args, "keep-project", false)) {
      out.line(style.gray("the original project_key from the journal is kept (--keep-project)"));
    }

    for (const p of result.plans) {
      if (p.error) {
        out.line(`${style.red("✗")} ${p.file}  ${p.error}`);
      } else {
        const dup = p.duplicates > 0 ? style.gray(` (${p.duplicates} already present, will be skipped)`) : "";
        out.line(`${style.green("✓")} ${p.file}  ${p.lines} events${dup}`);
      }
    }

    const hasError = result.plans.some((p) => p.error);
    out.blank();
    if (dryRun) {
      out.line(style.yellow("This is a --dry-run, nothing was written."));
      out.line(style.gray("Drop --dry-run to import for real, then run `agent-kanban rebuild --write` to rebuild the projections."));
    } else {
      out.line(
        `${style.green("✓")} imported ${result.applied} events.` +
          style.gray(" The projections are still stale, run `agent-kanban rebuild --write` to recompute them from the events."),
      );
    }
    return hasError ? ExitCode.STATE : ExitCode.OK;
  } finally {
    local.close();
  }
}

function doSnapshot(argv: string[]): ExitCodeValue {
  const args = parseArgs(argv, {
    booleans: ["json", "help"],
    strings: ["out", "session", "db", "server", "project", "key"],
    short: { h: "help" },
  });
  assertKnownOptions(args, ["json", "help", "out", "session", "db", "server", "project", "key"]);

  const out = createOutput(getBool(args, "json"));
  const local = openLocal();
  try {
    const now = Date.now();
    const snap = writeSnapshot(local.db.raw, local.scope, now);
    const file = getString(args, "out") ?? join(local.paths.dir, "snapshots", `board-${now}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(snap, null, 2), "utf8");

    out.data({ file, tasks: snap.tasks.length, counts: snap.counts });
    out.line(`${style.green("✓")} board snapshot written to ${style.gray(file)}  ${snap.tasks.length} tasks`);
    return ExitCode.OK;
  } finally {
    local.close();
  }
}

function doCompact(argv: string[]): ExitCodeValue {
  const args = parseArgs(argv, {
    booleans: ["json", "help"],
    strings: ["keep-days", "session", "db", "server", "project", "key"],
    short: { h: "help" },
  });
  assertKnownOptions(args, ["json", "help", "keep-days", "session", "db", "server", "project", "key"]);

  const out = createOutput(getBool(args, "json"));
  const local = openLocal();
  try {
    const keepDays = getInt(args, "keep-days") ?? 30;
    const now = Date.now();
    const result = compactEvents(local.db.raw, {
      keepDays,
      snapshotOut: join(local.paths.dir, "snapshots", `pre-compact-${now}.json`),
      now,
      projectKey: local.scope.projectKey,
      scope: local.scope,
    });

    out.data(result);
    out.line(
      `${style.green("✓")} events ${result.before} → ${result.after} (removed ${result.removed}; ` +
        `kept the last ${keepDays} days, the events of in-progress tasks, and a floor of 1000)`,
    );
    out.line(`  ${style.gray("snapshot before trimming: " + result.snapshotFile)}`);
    if (result.removed > 0) {
      out.blank();
      out.line(style.gray("Note: trimmed events cannot be replayed from the journal, that history only lives in the snapshot above."));
    }
    return ExitCode.OK;
  } finally {
    local.close();
  }
}
