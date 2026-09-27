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
import { join, dirname, resolve as resolvePath } from "node:path";
import { getConfig, migrate, openDb, type Db } from "../core/db.ts";
import { KanbanError } from "../core/errors.ts";
import {
  findKanbanDir,
  findKanbanDirLoose,
  pruneStaleSessionKeys,
  resolvePaths,
  resolveSessionKey,
  SESSION_FILENAME,
  SESSION_KEY_ENV,
  sessionKeyFilePath,
  type KanbanPaths,
} from "../core/paths.ts";
import { resolveLocalProject, validateProjectKey, type Project } from "../core/projects.ts";
import { reapZombies, touchSession } from "../core/sessions.ts";
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
import { getString } from "./args.ts";


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
    if (!cfg.server) missing.push("server.url (remote server address)");
    if (!cfg.project) missing.push("project.key (project identifier)");
    if (!cfg.token) missing.push("server.token (access token)");
    throw KanbanError.usage(
      `remote mode is not fully configured, missing: ${missing.join(", ")}`,
      "How to fix (pick one):\n" +
        "  1. edit .kanban/config.toml and fill in the fields above\n" +
        "  2. override on the command line: --server <url> --project <key> --key <token>\n" +
        "  3. use environment variables: KANBAN_SERVER / KANBAN_PROJECT / KANBAN_KEY\n" +
        (resolved.sources.configFile
          ? `current config file: ${resolved.sources.configFile}`
          : `no config file found (expected at ${paths.dir}/${CONFIG_FILE})`),
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
    // ---- 心跳必须**先于**回收 ----
    //
    // 顺序是硬要求，不是风格问题：reapZombies 在**每条命令开头**都跑，
    // 而它的判据是「last_seen_at 超过宽限期 → 判 crashed → 回收它持有的卡」。
    // 如果先回收后刷新，一个连续工作超过宽限期（默认 10 分钟）的 agent
    // 会被**自己这条命令**判成失联：卡回到 todo、还凭空合成一条 crash 交接
    // 说「持有者失联 12 分钟」。agent 用来证明自己活着的命令正是杀死它的命令。
    //
    // touchSession 自带节流，所以大多数命令这里不产生写。
    const sid = currentSessionId(input.paths.dir, input.sessionId);
    if (sid) touchSession(handle.raw, sid, input.now());

    // 回收是全局的（会话跳 project），所以不需要 projectKey
    reapZombies(handle.raw, { graceMs: project.graceMs ?? config.graceMs, now: input.now() });
  }

  // 会话解析（契约 §1.4）
  const sessionId = currentSessionId(input.paths.dir, input.sessionId);

  const backend = new LocalBackend({
    db: handle.raw,
    projectKey: project.key,
    sessionId,
    now: input.now,
    ttlMs: project.defaultTtlMs ?? config.defaultTtlMs,
    // session.start 会记下 cwd（“agent 从哪个目录发起”），所以必须传本机的。
    // 远程模式没有本地库，那边由 HTTP 头的 X-Kanban-Cwd 带上来。
    cwd: input.cwd,
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
    throw KanbanError.auth("remote mode requires a project", {
      server,
      hint:
        "Usage: kanban --server <url> --project <key> --key k_xxx <command>\n" +
        "or save the config first: agent-kanban config set server.url <url> / project.key <key> / server.token <token>",
    });
  }
  const projectKey = validateProjectKey(input.project);

  if (!input.key || input.key.length === 0) {
    throw KanbanError.auth(`project "${projectKey}" requires an access token`, {
      project: projectKey,
      server,
      hint: "save it with `agent-kanban config set server.token <token>`, or pass --key for one call",
    });
  }

  const sessionId = currentSessionId(input.paths.dir, input.sessionId);

  const backend = new RemoteBackend({
    server,
    projectKey,
    apiKey: input.key,
    sessionId,
    now: input.now,
    // 本机工作目录：session.start 会把它记进 sessions.cwd，而 server 端
    // 拿不到客户端的 cwd（它只有 process.cwd()，那是 server 的目录）。
    cwd: input.cwd,
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
 * 取当前会话 ID，取不到返回 **null**（不报错）。优先级见契约 §1.4。
 *
 * ⚠ 三处都判**非空字符串**，而不是判“存在”。这不是吹毛求疵：
 *   `process.env.KANBAN_SESSION ?? readSessionFile(...)` 看上去等价，实际上不是——
 *   `KANBAN_SESSION=`（shell 里给变量赋空，最常见的“取消设置”写法）不是 nullish，
 *   `??` 会让它**直接胜出**，于是 sessionId 变成空串：身份文件被忽略、
 *   事件流记成空 session_id、所有 `claim` 都以空身份互相续租。
 *   症状是“两个 agent 抢同一张卡不报错、看板 holder 栏空白”，而且全程不报错。
 *   把空串当“没设”，才与 resolveSessionKey 对空值的处理一致。
 *
 * 取参数而不是 Ctx：`openCtx` 在构造出 Ctx **之前**就要用到它。
 *
 * 调用方分两种：
 *   - 只读探测（`agent-kanban context`）：拿到 null 就该**说清楚自己没注册**，
 *     而不是硬报错——看板上有什么是可以看的，不该因为缺身份就拒绝服务。
 *   - 身份相关命令：包一层 `resolveSessionId`，把 null 变成一句可操作的报错。
 */
export function currentSessionId(dir: string, explicit?: string): string | null {
  if (explicit && explicit.length > 0) return explicit;

  const fromEnv = process.env.KANBAN_SESSION;
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  return readSessionFile(dir);
}

/**
 * 解析当前会话 ID（契约 §1.4）。
 *
 * 优先级：显式 --session > KANBAN_SESSION > 身份分片文件 > 旧单文件。
 * 都拿不到就报错而不是自动建会话：自动创建会产生“野会话”，污染看板且无法区分是人还是 agent。
 */
export function resolveSessionId(ctx: Ctx, explicit?: string): string {
  const id = currentSessionId(ctx.paths.dir, explicit);
  if (id && id.length > 0) return id;

  throw KanbanError.usage(
    "missing session id, cannot tell who is operating",
    missingSessionHint(),
  );
}

/**
 * 身份缺失时的可操作提示。
 *
 * 分两种情况给不同的话，因为**建议的动作不一样**：
 *   - 身份 key 能解析出来（说明人知道你是谁，只是没注册过会话）
 *     → 跑一次 `session start` 即可，并且要说明重注册是安全的
 *   - key 解析不出来（裸 shell / 没装 harness）
 *     → 只能手动传 `--session` 或导出 `KANBAN_SESSION`
 */
function missingSessionHint(): string {
  const key = resolveSessionKey();
  if (key) {
    return (
      `Your identity key is \`${key}\` (from ${SESSION_KEY_ENV} or a harness session variable), ` +
      `but no session is registered for it yet.\n\n` +
      `Fix: run \`agent-kanban session start --agent <name> --harness <harness>\` once, then keep using the board normally.\n` +
      `This is safe to do even if you already held cards: the old session goes stale after the grace period, ` +
      `its cards return to todo with progress and checklist intact.`
    );
  }
  return (
    "Pick one of three:\n" +
      "  1. add --session <id> on the command line\n" +
      "  2. set the KANBAN_SESSION environment variable\n" +
      "  3. run `agent-kanban session start --agent <name>` first to write the default session\n" +
      `Running several agents in one directory? Give each one a stable identity key via ${SESSION_KEY_ENV}=<value> ` +
      "so they stop sharing a single session file."
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

/**
 * 把会话 ID 写入本机的身份文件。
 *
 * ## 只写一个地方，取决于能不能解析出身份 key
 *
 * - **有 key** → 只写分片 `.kanban/sessions/<key>`，**绝不碰旧单文件**。
 *   若此时还顺手写旧单文件，同目录里没 key 的进程（裸 shell、cursor-agent、codex）
 *   就会读到它、以这个身份操作看板——**正是这次改造要消灭的静默串号**，
 *   等于在新机制上留了个后门。
 * - **无 key** → 退回改造前的 `.kanban/session` 单文件，行为逐字不变。
 *
 * 代价：keyful 与 keyless 混用时，keyless 侧会**明确报错**（而不是冒充），
 * 提示里已经写清修复动作。这是有意的取舍：宁可退出码 1，不要静默写错人。
 *
 * ## 关于旧版 CLI
 *
 * 旧二进制只认 `.kanban/session`，共存时它会因为没有该文件而报 "missing session id"，
 * 跑一次旧版 `session start` 即可自愈（它会写旧单文件，而 keyful 一侧压根不读它）。
 *
 * 顺手清一遍过期分片（见 pruneStaleSessionKeys）：写新身份是唯一适合做这件事的时刻。
 */
export function writeSessionFile(ctx: Ctx, sessionId: string): void {
  const dir = ctx.paths.dir;

  const key = resolveSessionKey();
  if (key) {
    const file = sessionKeyFilePath(dir, key);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, sessionId, "utf8");
  } else {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, SESSION_FILENAME), sessionId, "utf8");
  }

  pruneStaleSessionKeys(dir, { now: ctx.now() });
}

/**
 * 读本机记录的身份文件里的会话 ID（不存在返回 null）。接受目录路径或 Ctx。
 *
 * ⚠ 关键规则：**能解析出身份 key 时，绝不回退到旧单文件。**
 *
 *   假设 A、B 两个 agent 同目录，A 先 `session start`（旧单文件 = A），
 *   B 从没注册过。此时若允许 B 读旧单文件，B 就会以 A 的身份操作看板——
 *   正是这次改造要消灭的静默串号。
 *   B 的 key 明明解析得出来（它是另一个真实的 agent），所以让它**大声报错**、
 *   并在提示里直接给出 `session start` 这条修复动作，比让它安静地冒充 A 强得多。
 *   改造前没有分片，B 也会冒充 A；现在只是从静默错乱变成一句明确的退出码 1。
 */
export function readSessionFile(ctxOrDir: Ctx | string): string | null {
  const dir = typeof ctxOrDir === "string" ? ctxOrDir : ctxOrDir.paths.dir;

  const key = resolveSessionKey();
  if (key) return readSessionIdFile(sessionKeyFilePath(dir, key));

  // 无 key（裸 shell / 未列入表的 harness）：退回改造前的行为
  return readSessionIdFile(join(dir, SESSION_FILENAME));
}

/** 读单个身份文件；空文件当不存在 */
function readSessionIdFile(file: string): string | null {
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

/**
 * 从解析好的 CLI 参数构造 CtxOptions —— 六个命令文件曾经的本地复制品，
 * 收在这里之后"全局选项怎么进 ctx"只有一个出处。
 * 入参用结构类型而不是 ParsedArgs，避免 commands 层的循环依赖表象。
 */
export function ctxOptionsFromArgs(
  args: { options: Record<string, string | boolean> },
  json = false,
): CtxOptions {
  return {
    json,
    dbPath: getString(args as never, "db"),
    sessionId: getString(args as never, "session"),
    server: getString(args as never, "server"),
    project: getString(args as never, "project"),
    key: getString(args as never, "key"),
  };
}
