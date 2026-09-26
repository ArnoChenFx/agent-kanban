/**
 * `kanban init` —— 初始化项目级看板（本地模式）。
 *
 * 幂等：已初始化时只补齐缺失的配置项，不覆盖用户已调过的 ttl/grace。
 * 远程模式下不需要 init —— 直接 `kanban remote set` + `--server` 即可。
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
import { assertKnownOptions, getBool, getInt, getString, parseArgs } from "./args.ts";
import { createOutput } from "./output.ts";
import { style } from "../core/format.ts";
import { CONFIG_FILE, readConfigFile, writeConfigFile } from "../core/config.ts";

const USAGE = `用法：kanban init [--name <项目名>] [--project <key>] [--ttl <分钟>] [--grace <分钟>] [--force]

选项：
  --name      显示名（默认取当前目录名）
  --project   project key（默认由目录名派生；小写字母/数字/连字符）
  --ttl       默认租约时长（分钟，默认 15）
  --grace     失联宽限时长（分钟，默认 10）
  --force     **删掉现有数据库重建**（会丢失全部任务与历史，不可逆）

说明：
  · 本地模式：.kanban/ 对应唯一一个 project（ADR-9），零配置可用。
  · init 会同时生成 .kanban/config.toml（mode = "local"），以后的命令不必再传参数。
  · 改配置用 \`kanban config set\`；改成远程用 \`kanban config set mode remote\`。`;

export async function cmdInit(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "force", "help"],
    strings: ["name", "project", "ttl", "grace", "db"],
    short: { j: "json", h: "help", n: "name" },
  });
  assertKnownOptions(args, ["json", "force", "help", "name", "project", "ttl", "grace", "db"]);
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
    throw KanbanError.usage("--ttl 必须为正整数（分钟）", USAGE);
  }
  if (graceMinutes !== undefined && graceMinutes <= 0) {
    throw KanbanError.usage("--grace 必须为正整数（分钟）", USAGE);
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

      out.line(`看板已存在于 ${paths.dir}（schema v${version}），未做修改`);
      out.line(`  project：${style.cyan(project.key)} ${project.name}`);
      if (existsSync(paths.journalDir)) {
        out.line(`提示：检测到 journal 目录，如需从事件恢复可运行 \`kanban import <journal>/*.jsonl\``);
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
      type: "board_exported",
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

  out.line(`${style.green("✓")} 看板已初始化：${paths.dir}`);
  out.line(`  project  ：${style.cyan(project.key)} ${project.name}`);
  out.line(`  租约：${ttlMinutes ?? DEFAULT_TTL_MS / 60000} 分钟 · 失联宽限：${graceMinutes ?? DEFAULT_GRACE_MS / 60000} 分钟`);
  out.line(
    `  配置    ：${style.cyan(`${paths.dir}/${CONFIG_FILE}`)}` +
      (configExisted
        ? style.gray("（已存在，未覆盖）")
        : style.green("（已生成，mode = local）")),
  );
  if (effective?.mode === "remote") {
    out.line(style.yellow(`  注意：现有配置是 mode = "remote"（${effective.server ?? "?"}），命令实际会走远程`));
  }
  out.line("");
  out.line("下一步：");
  out.line("  1. 注册会话：kanban session start --agent pi-main --harness pi");
  out.line("  2. 开工前读取现场：kanban context");
  out.line('  3. 创建任务：kanban task add "实现存储层"');
  out.line("");
  out.line(style.gray("要让多台机器共享同一份看板（server 端）："));
  out.line("  kanban serve                              → 启动服务（自动生成管理员 token）");
  out.line("  kanban admin project add <key>            → 创建 project 并签发 token");
  out.line(style.gray("客户端切到远程："));
  out.line("  kanban config set mode remote");
  out.line("  kanban config set server.url http://<host>:7788");
  out.line("  kanban config set project.key <key>");
  out.line("  kanban config set server.token k_xxx");

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

