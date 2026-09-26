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

const USAGE = `用法：agent-kanban export | import | snapshot | compact

  export   [--out <目录>] [--since <ts>]   导出事件 journal（按天分文件）
  import   <文件|目录>... [--dry-run]      从 journal 重建库（按 seq 幂等去重）
              [--project <key>] [--keep-project]
  snapshot [--out <文件>]                  写看板快照（人可读 JSON，不可 import）
  compact  [--keep-days 30]                裁剪旧事件（先自动快照再删）

说明：
  · .kanban/kanban.db 不入 git，跨机器迁移靠 export + import
  · events 是唯一事实来源，所以重放 journal 能完整恢复，不需要备份 db 文件
  · project key 由目录名派生，新旧机器不同。import 默认把事件改写到当前 project；
    要保留原 key（多 project 迁移）用 --keep-project
  · compact 不可逆：它会先写一份快照到 .kanban/snapshots/
  · 这几个命令只在本地模式可用（远程模式的真身在 server 上）

示例：
  agent-kanban export --out .kanban/journal
  agent-kanban import .kanban/journal --dry-run
  agent-kanban import .kanban/journal
  agent-kanban rebuild --write        # 重放后重建投影
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
      throw KanbanError.usage(`未知子命令：${sub}`, USAGE);
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
      throw KanbanError.usage("--since 需要 epoch 毫秒时间戳", `收到：${sinceRaw}`);
    }

    const result = exportEvents(local.db.raw, {
      outDir: dir,
      sinceTs: sinceRaw ? Number(sinceRaw) : undefined,
      now: Date.now(),
    });

    out.data({ files: result.files, events: result.events, projects: result.projects });
    if (result.events === 0) {
      out.line(`${style.yellow("没有可导出的事件")}（库是空的，或 --since 把范围筛空了）`);
      return ExitCode.OK;
    }
    out.line(
      `${style.green("✓")} 已导出 ${result.events} 个事件 → ${style.gray(`${result.files.length} 个文件`)}`,
    );
    for (const f of result.files) out.line(`  ${style.gray(f)}`);
    out.blank();
    out.line(style.gray("在新机器上：agent-kanban import <该目录> && agent-kanban rebuild --write"));
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
    throw KanbanError.usage("import 需要至少一个文件或目录", USAGE);
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
      throw KanbanError.state(`${unreadable.length} 个文件读不了`, {
        hint: `检查路径与权限：${unreadable.join(", ")}`,
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
      out.line(`${style.yellow("↻")} project 重映射：${style.gray(`${r.from} → ${r.to}`)}`);
    }
    if (result.remapped.length === 0 && getBool(args, "keep-project", false)) {
      out.line(style.gray("已保留 journal 里的原始 project_key（--keep-project）"));
    }

    for (const p of result.plans) {
      if (p.error) {
        out.line(`${style.red("✗")} ${p.file}  ${p.error}`);
      } else {
        const dup = p.duplicates > 0 ? style.gray(`（${p.duplicates} 条已存在，将跳过）`) : "";
        out.line(`${style.green("✓")} ${p.file}  ${p.lines} 条${dup}`);
      }
    }

    const hasError = result.plans.some((p) => p.error);
    out.blank();
    if (dryRun) {
      out.line(style.yellow("这是 --dry-run，没有写入任何东西。"));
      out.line(style.gray("去掉 --dry-run 真正导入，然后跑 `agent-kanban rebuild --write` 重建投影。"));
    } else {
      out.line(
        `${style.green("✓")} 已导入 ${result.applied} 个事件。` +
          style.gray(" 投影还是旧的，跑 `agent-kanban rebuild --write` 用事件重算。"),
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
    out.line(`${style.green("✓")} 看板快照已写入 ${style.gray(file)}  ${snap.tasks.length} 个任务`);
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
      `${style.green("✓")} 事件 ${result.before} → ${result.after}（删除 ${result.removed} 条；` +
        `保留最近 ${keepDays} 天、进行中任务的相关事件，以及保底 1000 条）`,
    );
    out.line(`  ${style.gray("裁剪前快照：" + result.snapshotFile)}`);
    if (result.removed > 0) {
      out.blank();
      out.line(style.gray("注意：被裁掉的事件无法从 journal 重放，那段历史只存在于上面的快照里。"));
    }
    return ExitCode.OK;
  } finally {
    local.close();
  }
}
