/**
 * `agent-kanban init` —— 初始化项目级看板（本地模式）。
 *
 * 幂等：已初始化时只补齐缺失的配置项，不覆盖用户已调过的 ttl/grace。
 * 远程模式下不需要 init —— 直接 `agent-kanban remote set` + `--server` 即可。
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { basename } from "node:path";
import { ExitCode, KanbanError, type ExitCodeValue } from "../core/errors.ts";
import {
  DEFAULT_GRACE_MS,
  DEFAULT_TTL_MS,
  getSchemaVersion,
  migrate,
  openDb,
  setInitialConfig,
} from "../core/db.ts";
import { resolvePaths } from "../core/paths.ts";
import { createProject, resolveLocalProject } from "../core/projects.ts";
import { withTx } from "../core/tx.ts";
import { assertKnownOptions, getBool, getInt, getString, parseArgs, rejectExtraPositionals } from "./args.ts";
import { createOutput } from "./output.ts";
import { style } from "../core/format.ts";
import { CONFIG_FILE, readConfigFile, writeConfigFile } from "../core/config.ts";

const USAGE = `Usage: agent-kanban init [--name <name>] [--project <key>] [--ttl <minutes>] [--grace <minutes>] [--force]

Options:
  --name      Display name (defaults to the current directory name)
  --project   project key (derived from the directory name by default; lowercase letters/digits/hyphens)
  --ttl       Default lease duration (minutes, default 15)
  --grace     Lost-contact grace (minutes, default 10)
  --force     **delete the existing database and rebuild** (loses all tasks and history, irreversible)

Notes:
  · Local mode: .kanban/ maps to exactly one project (ADR-9), zero configuration needed.
  · init also writes .kanban/config.toml (mode = "local"), so later commands need no arguments.
  · Change the config with \`agent-kanban config set\`; switch to remote with \`agent-kanban config set mode remote\`.`;

export async function cmdInit(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "force", "help"],
    strings: ["name", "project", "ttl", "grace", "db"],
    short: { j: "json", h: "help", n: "name" },
  });
  assertKnownOptions(args, ["json", "force", "help", "name", "project", "ttl", "grace", "db"]);
  rejectExtraPositionals(args, 0, "Usage: agent-kanban init [--name <name>] [--force]");
  const out = createOutput(getBool(args, "json"));

  if (getBool(args, "help")) {
    out.line(USAGE);
    return ExitCode.OK;
  }

  const cwd = process.cwd();
  const paths = resolvePaths({ db: getString(args, "db"), cwd, mustExist: false });
  const displayName = getString(args, "name") ?? basename(paths.projectRoot);
  const force = getBool(args, "force");

  const ttlMinutes = getInt(args, "ttl");
  const graceMinutes = getInt(args, "grace");
  if (ttlMinutes !== undefined && ttlMinutes <= 0) {
    throw KanbanError.usage("--ttl must be a positive integer (minutes)", USAGE);
  }
  if (graceMinutes !== undefined && graceMinutes <= 0) {
    throw KanbanError.usage("--grace must be a positive integer (minutes)", USAGE);
  }

  // ---- 幂等保护：已初始化时不重建，但会补齐缺失的配置项 ----
  // 为什么需要补齐：上一次 init 中途失败（例如 Ctrl+C）会留下
  // "库已建但 meta 不全"的半成品，只返回而不修复会让项目永远缺配置。
  const already = existsSync(paths.db);
  if (already && !force) {
    const handle = openDb(paths.db);
    const version = getSchemaVersion(handle);
    if (version > 0) {
      migrate(handle);
      withTx(handle.raw, () => {
        setInitialConfig(handle.raw, {
          projectName: displayName,
          ttlMs: ttlMinutes ? ttlMinutes * 60_000 : undefined,
          graceMs: graceMinutes ? graceMinutes * 60_000 : undefined,
        });
      });
      // 确保本地 project 存在（ADR-9：零配置）
      const project = resolveLocalProject(handle.raw, { rootPath: paths.projectRoot });
      handle.raw.close();

      out.line(`board already exists at ${paths.dir} (schema v${version}), nothing was changed`);
      out.line(`  project: ${style.cyan(project.key)} ${project.name}`);
      if (existsSync(paths.journalDir)) {
        out.line(`Hint: a journal directory was detected, run \`agent-kanban import <journal>/*.jsonl\` to recover from the events`);
      }
      out.data({ ok: true, already_initialized: true, dir: paths.dir, db: paths.db, project: project.key });
      return ExitCode.OK;
    }
    handle.raw.close();
  }

  // ---- --force：真正删掉旧库重建 ----
  // 之前 --force 只是跳过幂等分支，migrate 不会清表，结果是"新命令跑在旧数据上"，
  // 与 --force 的字面含义不符（旧任务、旧事件全部残留）。
  if (already && force) {
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(paths.db + suffix, { force: true });
    }
  }

  // ---- 创建目录与库 ----
  mkdirSync(paths.dir, { recursive: true });
  mkdirSync(paths.journalDir, { recursive: true });
  mkdirSync(paths.plansDir, { recursive: true });
  mkdirSync(paths.snapshotsDir, { recursive: true });

  const handle = openDb(paths.db);
  migrate(handle);

  let project!: import("../core/projects.ts").Project;
  withTx(handle.raw, (tx) => {
    setInitialConfig(handle.raw, {
      projectName: displayName,
      ttlMs: ttlMinutes ? ttlMinutes * 60_000 : DEFAULT_TTL_MS,
      graceMs: graceMinutes ? graceMinutes * 60_000 : DEFAULT_GRACE_MS,
    });
    // 本地 project：显式指定 --project 时用它，否则由目录名派生
    project = getString(args, "project")
      ? createProject(handle.raw, {
          key: getString(args, "project")!,
          name: displayName,
          rootPath: paths.projectRoot,
          // 本地模式不鉴权
          apiKeyHash: null,
        })
      : resolveLocalProject(handle.raw, { rootPath: paths.projectRoot });
    tx.emit({
      type: "system_notice",
      projectKey: project.key,
      data: { action: "init", project: project.key, db: paths.db },
      sessionId: "system",
    });
  });
  handle.raw.close();

  // ---- 生成 .kanban/config.toml（本地模式）----
  // 目的：让后续所有命令不必再传 --server/--project/--key。
  // 已存在则不动（绝不覆盖用户配置），只报告当前生效的模式。
  const configExisted = existsSync(`${paths.dir}/${CONFIG_FILE}`);
  if (!configExisted) {
    writeConfigFile(paths.dir, { mode: "local", project: project.key });
  }
  const effective = readConfigFile(paths.dir)?.config;

  out.line(`${style.green("✓")} board initialized: ${paths.dir}`);
  out.line(`  project : ${style.cyan(project.key)} ${project.name}`);
  out.line(`  lease   : ${ttlMinutes ?? DEFAULT_TTL_MS / 60000} min · lost-contact grace: ${graceMinutes ?? DEFAULT_GRACE_MS / 60000} min`);
  out.line(
    `  config  : ${style.cyan(`${paths.dir}/${CONFIG_FILE}`)}` +
      (configExisted
        ? style.gray(" (already existed, not overwritten)")
        : style.green(" (created, mode = local)")),
  );
  if (effective?.mode === "remote") {
    out.line(style.yellow(`  Note: the current config is mode = "remote" (${effective.server ?? "?"}); commands will actually go remote`));
  }
  out.line("");
  out.line("Next:");
  out.line("  1. Register a session: agent-kanban session start --agent pi-main --harness pi");
  out.line("  2. Read the situation before starting: agent-kanban context");
  out.line('  3. Create a task: agent-kanban task add "Implement the storage layer"');
  out.line("");
  out.line(style.gray("To share one board across machines (server side):"));
  out.line("  agent-kanban serve                              → start the server (an admin token is generated on first run)");
  out.line("  agent-kanban admin project add <key>            → create a project and issue its token");
  out.line(style.gray("Point the client at it:"));
  out.line("  agent-kanban config set mode remote");
  out.line("  agent-kanban config set server.url http://<host>:7788");
  out.line("  agent-kanban config set project.key <key>");
  out.line("  agent-kanban config set server.token k_xxx");

  out.data({
    ok: true,
    already_initialized: false,
    forced: force,
    dir: paths.dir,
    db: paths.db,
    config: `${paths.dir}/${CONFIG_FILE}`,
    config_created: !configExisted,
    project: project.key,
    project_name: project.name,
    ttl_ms: ttlMinutes ? ttlMinutes * 60_000 : DEFAULT_TTL_MS,
    grace_ms: graceMinutes ? graceMinutes * 60_000 : DEFAULT_GRACE_MS,
  });
  return ExitCode.OK;
}

