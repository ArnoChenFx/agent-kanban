/**
 * 命令上下文：决定本地/远程模式，构建 Backend。
 *
 * ⚠ 文件名说明：这个模块叫 context.ts，但它管的是"命令执行的连接上下文"，
 * 与 core/context.ts（恢复现场组装）和 commands/recovery.ts（agent-kanban context 命令）
 * 是三件不同的事。改名前先想清楚命名。
 *
 * 优先级链（ADR-12）：
 *   --server/--project/--key > 环境变量 > .kanban/config.toml > 派生默认
 *   一旦命中任何 server 来源即进入远程模式，**不再看本地 .kanban/ 的业务数据**。
 */

import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { getConfig, migrate, openDb, type Db } from "../core/db.ts";
import { KanbanError } from "../core/errors.ts";
import { findKanbanDir, findKanbanDirLoose, resolvePaths, SESSION_FILENAME, type KanbanPaths } from "../core/paths.ts";
import { resolveLocalProject, validateProjectKey, type Project } from "../core/projects.ts";
import { reapZombies } from "../core/sessions.ts";
import type { Actor } from "../core/tasks.ts";
import { LocalBackend, type Backend } from "../core/backend.ts";
import { RemoteBackend } from "../core/backend-remote.ts";
import {
  CONFIG_FILE,
  normalizeServerUrl,
  readConfigFile,
  resolveConfig,
  type ConfigSourceInfo,
  type KanbanConfigFile,
} from "../core/config.ts";
import type { KanbanConfig } from "../core/types.ts";

/** 命令上下文 */
export interface Ctx {
  /** Backend：命令层通过它执行 Op（ADR-10） */
  backend: Backend;
  /** 本地模式的 db 句柄（远程模式为 null） */
  db: Database | null;
  /** 本地模式的 db 包装（用于 project 管理等直连操作） */
  handle: Db | null;
  paths: KanbanPaths;
  config: KanbanConfig;
  /** 当前 project（本地与远程都有） */
  project: Project;
  json: boolean;
  now: () => number;
  cwd: string;
  /** 生效的远程配置（本地模式为 null） */
  remote: { server: string; project: string; key: string } | null;
  /** 实际生效的配置（本地/远程都非空，来自 config.toml + CLI/env 合并） */
  effectiveConfig: KanbanConfigFile;
  /** 配置来源（供 `agent-kanban config show` 说明"这个值从哪来"） */
  configSources: ConfigSourceInfo;
}

/** 上下文构建选项（来自 CLI 全局选项与环境变量） */
export interface CtxOptions {
  json?: boolean;
  dbPath?: string | undefined;
  cwd?: string;
  now?: () => number;
  sessionId?: string | undefined;
  server?: string | undefined;
  project?: string | undefined;
  key?: string | undefined;
  /** 强制模式：'local' 会忽略配置里的 server；'remote' 则要求配置完整 */
  mode?: string | undefined;
  /** 显式指定 .kanban 目录（测试用） */
  kanbanDir?: string | undefined;
  /** 跳过隐式僵尸回收（测试里手工控制时间时需要） */
  skipReap?: boolean;
}

/**
 * 构建命令上下文：读配置 → 判断模式 → 打开连接/构造 Backend → 解析 project → 隐式回收僵尸。
 */
export function openCtx(opts: CtxOptions = {}): Ctx {
  const cwd = opts.cwd ?? process.cwd();
  const now = opts.now ?? Date.now;

  // ---- 0. 读项目配置（.kanban/config.toml）----
  // 配置让"同一个项目的设置固定下来"：用户不用每次传 --server/--project/--key
  // 用宽松查找：远程项目本地**没有** kanban.db（数据在 server），但有 config.toml
  const kanbanDir = opts.kanbanDir ?? findKanbanDirLoose(cwd) ?? join(cwd, ".kanban");
  const resolved = resolveConfig({
    kanbanDir,
    cli: {
      server: opts.server,
      project: opts.project,
      key: opts.key,
      mode: opts.mode,
      db: opts.dbPath,
    },
  });
  const cfg = resolved.config;

  // ---- 1. 判定模式（有 server 就是远程，与 ADR-12 一致）----
  const paths = resolvePathsLocalAware(cwd, cfg.db);
  const isRemote = cfg.mode === "remote" && Boolean(cfg.server);

  if (isRemote && cfg.server && cfg.project && cfg.token) {
    return openRemoteCtx({
      cwd,
      now,
      json: opts.json ?? false,
      paths,
      server: cfg.server,
      project: cfg.project,
      key: cfg.token,
      sessionId: opts.sessionId,
      effectiveConfig: cfg,
    });
  }

  // 远程模式但配置不完整：明确告诉用户缺什么（而不是含糊报"鉴权失败"）
  if (isRemote) {
    const missing: string[] = [];
    if (!cfg.server) missing.push("server.url（远程 server 地址）");
    if (!cfg.project) missing.push("project.key（project 标识）");
    if (!cfg.token) missing.push("server.token（访问 token）");
    throw KanbanError.usage(
      `远程模式配置不完整，缺少：${missing.join("、")}`,
      "补齐方式（任选其一）：\n" +
        "  1. 编辑 .kanban/config.toml 填上上述字段\n" +
        "  2. 用命令行参数覆盖：--server <url> --project <key> --key <token>\n" +
        "  3. 用环境变量：KANBAN_SERVER / KANBAN_PROJECT / KANBAN_KEY\n" +
        (resolved.sources.configFile
          ? `当前配置文件：${resolved.sources.configFile}`
          : `未找到配置文件（应在 ${paths.dir}/${CONFIG_FILE}）`),
    );
  }

  return openLocalCtx({
    cwd,
    now,
    json: opts.json ?? false,
    paths,
    opts,
    sessionId: opts.sessionId,
    resolvedSources: resolved.sources,
    effectiveConfig: cfg,
  });
}

/**
 * 路径发现（允许 .kanban 不存在，用于 remote set / init）。
 * 与 paths.resolvePaths 的区别：不抛 NOT_INIT。
 */
function resolvePathsLocalAware(cwd: string, dbPath?: string): KanbanPaths {
  if (dbPath) {
    return resolvePaths({ db: dbPath, cwd, mustExist: false });
  }
  const found = findKanbanDir(cwd);
  if (found) return resolvePaths({ cwd, mustExist: true });
  // .kanban 还不存在：按 cwd 推定将要创建的位置
  return resolvePaths({ db: undefined, cwd: resolvePath(cwd), mustExist: false });
}

/** 本地模式上下文 */
function openLocalCtx(input: {
  cwd: string;
  now: () => number;
  json: boolean;
  paths: KanbanPaths;
  opts: CtxOptions;
  sessionId?: string | undefined;
  resolvedSources: ConfigSourceInfo;
  effectiveConfig: KanbanConfigFile;
}): Ctx {
  const handle = openDb(input.paths.db);
  migrate(handle);
  const config = getConfig(handle.raw);

  // 自动确保存在一个本地 project（ADR-9：本地用户零配置）
  const project = resolveLocalProject(handle.raw, {
    rootPath: input.paths.projectRoot,
    now: input.now(),
  });

  if (!input.opts.skipReap) {
    // 回收是全局的（会话跳 project），所以不需要 projectKey
    reapZombies(handle.raw, { graceMs: project.graceMs ?? config.graceMs, now: input.now() });
  }

  // 会话解析（契约 §1.4）
  const sessionId =
    input.sessionId && input.sessionId.length > 0
      ? input.sessionId
      : process.env.KANBAN_SESSION ?? readSessionFile(input.paths.dir) ?? null;

  const backend = new LocalBackend({
    db: handle.raw,
    projectKey: project.key,
    sessionId,
    now: input.now,
    ttlMs: project.defaultTtlMs ?? config.defaultTtlMs,
    // doctor 用它检查 AGENTS.md 协作协议是否落后于当前 CLI
    projectRoot: input.paths.projectRoot,
  });

  return {
    backend,
    db: handle.raw,
    handle,
    paths: input.paths,
    config,
    project,
    json: input.json,
    now: input.now,
    cwd: input.cwd,
    remote: null,
    configSources: input.resolvedSources,
    effectiveConfig: input.effectiveConfig,
  };
}

/** 远程模式上下文 */
function openRemoteCtx(input: {
  cwd: string;
  now: () => number;
  json: boolean;
  paths: KanbanPaths;
  server: string;
  project: string | undefined;
  key: string | undefined;
  sessionId?: string | undefined;
  effectiveConfig: KanbanConfigFile;
}): Ctx {
  const server = normalizeServerUrl(input.server);

  // 远程模式必须显式指定 project（ADR-12：猜错 project 的代价大于多打几个字）
  if (!input.project || input.project.length === 0) {
    throw KanbanError.auth("远程模式需要指定 project", {
      server,
      hint:
        "用法：kanban --server <url> --project <key> --key k_xxx <命令>\n" +
        "或先保存配置：agent-kanban config set server.url <url> / project.key <key> / server.token <token>",
    });
  }
  const projectKey = validateProjectKey(input.project);

  if (!input.key || input.key.length === 0) {
    throw KanbanError.auth(`project "${projectKey}" 需要访问 token`, {
      project: projectKey,
      server,
      hint: "用 `agent-kanban config set server.token <token>` 保存，或用 --key 临时指定",
    });
  }

  const sessionId =
    input.sessionId && input.sessionId.length > 0
      ? input.sessionId
      : process.env.KANBAN_SESSION ?? readSessionFile(input.paths.dir) ?? null;

  const backend = new RemoteBackend({
    server,
    projectKey,
    apiKey: input.key,
    sessionId,
    now: input.now,
  });

  // 远程模式没有本地 db；config 用默认值（真实配置在 server 上）
  return {
    backend,
    db: null,
    handle: null,
    paths: input.paths,
    config: {
      schemaVersion: 0,
      projectName: projectKey,
      createdAt: 0,
      defaultTtlMs: 15 * 60 * 1000,
      graceMs: 10 * 60 * 1000,
    },
    project: {
      key: projectKey,
      name: projectKey,
      rootPath: null,
      apiKeyHash: null,
      createdAt: 0,
      defaultTtlMs: null,
      graceMs: null,
    },
    json: input.json,
    now: input.now,
    cwd: input.cwd,
    remote: { server, project: projectKey, key: input.key },
    effectiveConfig: input.effectiveConfig,
    // 远程模式下配置来源已在 resolveConfig 中判定（cli/env/config）
    configSources: {
      mode: "remote",
      modeSource: "config",
      server,
      serverSource: "config",
      project: projectKey,
      projectSource: "config",
      token: input.key,
      tokenSource: "config",
    },
  };
}

/**
 * 解析当前会话 ID（契约 §1.4）。
 *
 * 优先级：显式 --session > KANBAN_SESSION > .kanban/session 文件。
 * 都拿不到就报错而不是自动建会话：自动创建会产生"野会话"，污染看板且无法区分是人还是 agent。
 */
export function resolveSessionId(ctx: Ctx, explicit?: string): string {
  if (explicit && explicit.length > 0) return explicit;

  const fromEnv = process.env.KANBAN_SESSION;
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  const fromFile = readSessionFile(ctx.paths.dir);
  if (fromFile && fromFile.length > 0) return fromFile;

  throw KanbanError.usage(
    "缺少会话标识，无法确定是谁在操作",
    "三种方式任选其一：\n" +
      "  1. 命令行加 --session <id>\n" +
      "  2. 设置环境变量 KANBAN_SESSION\n" +
      "  3. 先运行 `agent-kanban session start --agent <名字>` 写入默认会话",
  );
}

/** 构造 core 层需要的 Actor（仅本地模式直调 core 时用） */
export function makeActor(ctx: Ctx, sessionId: string | null): Actor {
  return {
    sessionId,
    now: ctx.now(),
    ttlMs: ctx.project.defaultTtlMs ?? ctx.config.defaultTtlMs,
  };
}

/** 把会话 ID 写入 .kanban/session 便捷文件 */
export function writeSessionFile(ctx: Ctx, sessionId: string): void {
  mkdirSync(ctx.paths.dir, { recursive: true });
  writeFileSync(join(ctx.paths.dir, SESSION_FILENAME), sessionId, "utf8");
}

/** 读便捷文件里的会话 ID（不存在返回 null）。接受目录路径或 Ctx */
export function readSessionFile(ctxOrDir: Ctx | string): string | null {
  const dir = typeof ctxOrDir === "string" ? ctxOrDir : ctxOrDir.paths.dir;
  const file = join(dir, SESSION_FILENAME);
  if (!existsSync(file)) return null;
  const content = readFileSync(file, "utf8").trim();
  return content.length > 0 ? content : null;
}

/** 关闭上下文（关本地连接） */
export function closeCtx(ctx: Ctx): void {
  ctx.backend.close();
  if (ctx.handle) {
    try {
      ctx.handle.raw.close();
    } catch {
      // 已关闭则忽略
    }
  }
}
