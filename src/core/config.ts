/**
 * 项目配置：`.kanban/config.toml`。
 *
 * 设计目的（用户需求）：单个项目的这些配置是**固定**的，所以应该"配置一次、一直生效"，
 * 而不是每次敲 `kanban --server X --project Y --key Z task list`。
 *
 * 配置优先级（高 → 低）：
 *   1. 命令行选项     --server / --project / --key / --mode
 *   2. 环境变量       KANBAN_SERVER / KANBAN_PROJECT / KANBAN_KEY / KANBAN_MODE
 *   3. 项目配置       <项目>/.kanban/config.toml
 *   4. 派生默认       本地模式：project key 由目录名派生
 *
 * 关键性质：**配置可以指向远程 server，此时本地仍不需要数据库**。
 * 所以 config.toml 存在 ≠ 本地有数据。
 *
 * 典型文件（客户端项目）：
 *   mode = "remote"
 *   [server]
 *   url = "https://kanban.corp"
 *   token = "k_xxx"
 *   [project]
 *   key = "agent-kanban"
 *
 * 典型文件（server 本机）：
 *   [server]
 *   host = "0.0.0.0"
 *   port = 7788
 *   admin_token = "k_admin_xxx"        # 明文，方便运维/容器读取
 *   admin_token_hash = "sha256:..."   # 校验用
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { KanbanError } from "./errors.ts";
import {
  num,
  parseTomlFile,
  str,
  stringifyTomlWithHeader,
  table,
  type TomlObject,
} from "./toml.ts";
import { hashApiKey } from "./projects.ts";
import { generateTokenRef } from "./tokens.ts";

/**
 * 归一化 server URL：补全协议、去掉尾部斜杠。
 *
 * 容忍用户手写 `kanban.corp:7788` 这类省略协议的地址：
 * - localhost / 127.0.0.1 / [::1] 默认 http（本地开发）
 * - 其他默认 https（避免明文传输凭据）
 */
export function normalizeServerUrl(url: string): string {
  let normalized = url.trim();
  if (!/^https?:\/\//i.test(normalized)) {
    const isLocalhost = /^localhost|^127\.0\.0\.1|^\[::1\]/i.test(normalized);
    normalized = `${isLocalhost ? "http" : "https"}://${normalized}`;
  }
  return normalized.replace(/\/+$/, "");
}

/** 配置文件名 */
export const CONFIG_FILE = "config.toml";

/** 运行模式 */
export type KanbanMode = "local" | "remote";

/** 项目配置 */
export interface KanbanConfigFile {
  /** 运行模式 */
  mode: KanbanMode;
  /** 远程 server 地址（mode=remote 时必需） */
  server?: string;
  /** 访问 token（项目级或管理员级；server URL 相同即可） */
  token?: string;
  /** project key */
  project?: string;
  /** 本地模式：数据库路径（相对项目根或绝对） */
  db?: string;
  /** server 端：监听配置 */
  host?: string;
  port?: number;
  /** server 端：管理员 token（明文） */
  adminToken?: string;
  /** server 端：管理员 token 哈希 */
  adminTokenHash?: string;
  /** 首次启动时是否已提醒过 admin token */
  adminTokenGeneratedAt?: number;
}

/** 配置来源（用于 `agent-kanban config show` 说明"这个值从哪来"） */
export interface ConfigSourceInfo {
  mode: KanbanMode;
  modeSource: "cli" | "env" | "config" | "default";
  server?: string;
  serverSource: "cli" | "env" | "config" | "none";
  project?: string;
  projectSource: "cli" | "env" | "config" | "derived" | "none";
  token?: string;
  tokenSource: "cli" | "env" | "config" | "none";
  configFile?: string;
}

/** 解析后的完整配置 + 来源信息 */
export interface ResolvedConfig {
  config: KanbanConfigFile;
  sources: ConfigSourceInfo;
}

/** 读取项目配置文件；不存在返回 null */
export function readConfigFile(kanbanDir: string): { config: KanbanConfigFile; path: string } | null {
  const path = join(kanbanDir, CONFIG_FILE);
  const parsed = parseTomlFile(path);
  if (parsed === null) return null;

  const server = table(parsed.server);
  const project = table(parsed.project);

  return {
    path,
    config: {
      mode: (str(parsed.mode) ?? "local") as KanbanMode,
      server: str(server.url),
      token: str(server.token),
      project: str(project.key),
      db: str(parsed.db),
      host: str(server.host),
      port: num(server.port),
      adminToken: str(server.admin_token),
      adminTokenHash: str(server.admin_token_hash),
      adminTokenGeneratedAt: num(server.admin_token_generated_at),
    },
  };
}

/**
 * 合并配置：CLI > 环境变量 > 配置文件 > 默认。
 *
 * 注意 mode 的判定顺序：不能只看 mode 字段，
 * 因为用户可能只写了 `server = "..."` 而忘了写 `mode = "remote"`。
 * 实际规则：**有 server 地址就是远程模式**（与 ADR-12 一致）。
 */
export function resolveConfig(input: {
  kanbanDir: string;
  cli?: { server?: string; project?: string; key?: string; mode?: string; db?: string };
  env?: Record<string, string | undefined>;
}): ResolvedConfig {
  const env = input.env ?? process.env;
  const file = readConfigFile(input.kanbanDir);
  // 显式给类型：否则 `file?.config ?? {}` 会被推断为 {}，后续取字段报错
  const fileConfig: KanbanConfigFile = file?.config ?? { mode: "local" };
  const cli = input.cli ?? {};

  // ⚠ 空字符串必须当作“未设置”，否则会静默屏蔽配置文件。
  // 这是真实踩过的坑：`export KANBAN_SERVER=`（把变量清空）后，
  // `env.KANBAN_SERVER ?? fileConfig.server` 因为 `??` 不跳过 ""，
  // 结果 server 变成空 → 判为本地模式 → 配置好的远程连接被无视，
  // 命令悄悄在本地新建了一个空库，没有任何报错。
  // 典型触发：CI 里 `env: { KANBAN_KEY: undefined }` 被序列化成空串；
  // 或 shell 脚本里 `KANBAN_SERVER=$VAR` 而 VAR 为空。
  const nonEmpty = (v: string | undefined | null): string | undefined => {
    const trimmed = typeof v === "string" ? v.trim() : "";
    return trimmed.length > 0 ? trimmed : undefined;
  };

  // ---- server ----
  const cliServer = nonEmpty(cli.server);
  const envServer = nonEmpty(env.KANBAN_SERVER);
  const fileServer = nonEmpty(fileConfig.server);
  const serverRaw = cliServer ?? envServer ?? fileServer;
  const server = serverRaw ? normalizeServerUrl(serverRaw) : undefined;
  const serverSource: ConfigSourceInfo["serverSource"] = cliServer
    ? "cli"
    : envServer
      ? "env"
      : fileServer
        ? "config"
        : "none";

  // ---- token ----
  // 注意：cli.key 才是用户传的 token（命令行 --key），不是"是否给了 key"
  const cliKey = nonEmpty(cli.key);
  const envKey = nonEmpty(env.KANBAN_KEY);
  const fileToken = nonEmpty(fileConfig.token);
  const token = cliKey ?? envKey ?? fileToken;
  const tokenSource: ConfigSourceInfo["tokenSource"] = cliKey
    ? "cli"
    : envKey
      ? "env"
      : fileToken
        ? "config"
        : "none";

  // ---- project ----
  const cliProject = nonEmpty(cli.project);
  const envProject = nonEmpty(env.KANBAN_PROJECT);
  const fileProject = nonEmpty(fileConfig.project);
  const projectRaw = cliProject ?? envProject ?? fileProject;
  const projectSource: ConfigSourceInfo["projectSource"] = cliProject
    ? "cli"
    : envProject
      ? "env"
      : fileProject
        ? "config"
        : "none";

  // ---- mode：有 server 就是远程 ----
  const explicitMode = nonEmpty(cli.mode) ?? nonEmpty(env.KANBAN_MODE);
  const mode: KanbanMode = explicitMode === "remote" || explicitMode === "local"
    ? explicitMode
    : server
      ? "remote"
      : "local";
  const modeSource: ConfigSourceInfo["modeSource"] = cli.mode
    ? "cli"
    : nonEmpty(env.KANBAN_MODE)
      ? "env"
      : server
        ? "config"
        : "default";

  return {
    config: {
      mode,
      server,
      token,
      project: projectRaw,
      db: nonEmpty(cli.db) ?? nonEmpty(env.KANBAN_DB) ?? nonEmpty(fileConfig.db),
    },
    sources: {
      mode,
      modeSource,
      server,
      serverSource,
      project: projectRaw,
      projectSource,
      token,
      tokenSource,
      configFile: file?.path,
    },
  };
}

/** 把配置写回文件（固定字段顺序 + 注释头，便于人读与 diff） */
export function writeConfigFile(kanbanDir: string, config: KanbanConfigFile): string {
  const path = join(kanbanDir, CONFIG_FILE);
  // 目录可能不存在：用 --db 指定非 .kanban/ 路径时，config.toml 旁边没有目录
  mkdirSync(dirname(path), { recursive: true });

  // 手动构造对象以控制字段顺序（Bun.TOML.stringify 按插入顺序输出）
  const obj: TomlObject = {};
  obj.mode = config.mode;

  const server: TomlObject = {};
  if (config.server) server.url = config.server;
  if (config.token) server.token = config.token;
  if (config.host) server.host = config.host;
  if (config.port !== undefined) server.port = config.port;
  if (config.adminToken) server.admin_token = config.adminToken;
  if (config.adminTokenHash) server.admin_token_hash = config.adminTokenHash;
  if (config.adminTokenGeneratedAt) {
    server.admin_token_generated_at = config.adminTokenGeneratedAt;
  }
  if (Object.keys(server).length > 0) obj.server = server;

  if (config.project) {
    obj.project = { key: config.project };
  }
  if (config.db) obj.db = config.db;

  // 文件头注释：写进用户项目的文档，所以跟着 CLI 文风一起英文化
  // （中文协议正文在 src/core/protocol.ts，那是另一类内容，由 install-protocol 落盘）
  const header = [
    "agent-kanban project configuration",
    "",
    "This file pins a project's settings so you don't have to pass --server/--project/--key every time.",
    "",
    "Precedence: command-line options > environment variables > this file",
    "",
    "Fields:",
    '  mode = "local" | "remote"    treated as remote automatically when server.url is set',
    "  server.url                   Remote server address, e.g. https://kanban.corp:7788",
    "  server.token                 Access token (issue one with `agent-kanban admin token create`)",
    "  project.key                  Project key (one token can authorize several projects)",
    "",
    "None of these are needed in local mode: the data lives in .kanban/kanban.db by default.",
    "",
    "⚠ This file contains a token — **do not commit it to a public repository**.",
  ].join("\n");

  writeFileSync(path, stringifyTomlWithHeader(obj, header), "utf8");
  return path;
}

/**
 * 读取（必要时生成）server 端的管理员 token，**并确保它已注册到 tokens 表**。
 *
 * 为什么要两步（config.toml + tokens 表）：
 * - `tokens` 表是**运行时鉴权的唯一依据**（ADR-13）：authenticate 只查它
 * - `config.toml` 是**运维可见的备份**：容器重建、人忘了怎么办时能找回
 *
 * 两者必须一致：如果只在 config.toml 里写了 token 而没注册到表，
 * server 会把所有请求都拒为“token 无效”（这个坑踩过一次）。
 *
 * 优先级：环境变量 KANBAN_ADMIN_TOKEN > config.toml 里已有的 > 新生成
 */
export function ensureAdminToken(
  kanbanDir: string,
  opts: {
    /** 必需的：用于注册到 tokens 表 */
    db: import("bun:sqlite").Database;
    env?: Record<string, string | undefined>;
    now?: number;
    generate: () => string;
  },
): { token: string; isNew: boolean; path: string; source: "env" | "config" | "generated" } {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();
  const path = join(kanbanDir, CONFIG_FILE);

  // ---- 1. 确定 token 明文 ----
  const fromEnv = env.KANBAN_ADMIN_TOKEN;
  const existing = readConfigFile(kanbanDir);
  let token: string;
  let isNew = false;
  let source: "env" | "config" | "generated";

  if (fromEnv && fromEnv.length > 0) {
    // 必须校验格式：否则 `KANBAN_ADMIN_TOKEN=admin` 也能登录，
    // 而调用方会以为自己配了一个受保护的凭据。
    // 直接报错而不是降级/警告——“看起来配了但没生效”比“启动失败”危险得多。
    if (!/^k_[0-9a-f]{32}$/.test(fromEnv)) {
      throw KanbanError.usage(
        "the KANBAN_ADMIN_TOKEN environment variable is malformed",
        "It must be k_ followed by 32 hex digits, for example:\n" +
          "  k_0123456789abcdef0123456789abcdef\n" +
          "Generate one with: openssl rand -hex 16",
        { reason: "invalid_admin_token_format" },
      );
    }
    token = fromEnv;
    source = "env";
  } else if (existing?.config.adminToken) {
    token = existing.config.adminToken;
    source = "config";
  } else {
    token = opts.generate();
    isNew = true;
    source = "generated";
  }

  // ---- 2. 写入 config.toml（仅当需要持久化时）----
  // 环境变量提供的 token 不写文件（容器场景不该因配置文件而失效）
  if (source !== "env") {
    writeConfigFile(kanbanDir, {
      ...(existing?.config ?? { mode: "local" }),
      adminToken: token,
      adminTokenHash: `sha256:${hashApiKey(token)}`,
      adminTokenGeneratedAt: now,
    });
  }

  // ---- 3. 注册到 tokens 表（幂等）----
  // 这是关键一步：没注册的话所有请求都会 401 “token 无效”
  ensureAdminTokenRegistered(opts.db, token, now, source);

  return { token, isNew, path, source };
}

/** 确保 tokens 表里有这条 admin 记录（已存在则不动） */
function ensureAdminTokenRegistered(
  db: import("bun:sqlite").Database,
  token: string,
  now: number,
  source: "env" | "config" | "generated",
): void {
  // ⚠ 幂等判据从「id = 明文」改成「key_hash = 该 token 的哈希」：
  //   库里不再存明文，所以不能再拿 token 去匹配 id。
  const hash = hashApiKey(token);
  const existing = db
    .query<{ id: string }, [string]>("SELECT id FROM tokens WHERE key_hash = ?")
    .get(hash);
  if (existing) return;

  // id 是**引用**（随机值），不是密钥；明文只留在 config.toml / 环境变量里
  db.query(
    `INSERT INTO tokens (id, name, role, projects, key_hash, created_at, created_by,
                         last_used_at, revoked_at, expires_at, note)
     VALUES (?, ?, 'admin', NULL, ?, ?, NULL, NULL, NULL, NULL, ?)`,
  ).run(
    generateTokenRef(),
    "server admin",
    hash,
    now,
    `first created by ${source === "generated" ? "auto-generation" : source}`,
  );
}

/** 校验 admin token 是否匹配（支持 env / 明文 / 哈希三种来源） */
export function verifyAdminToken(
  candidate: string | undefined | null,
  stored: { token?: string; hash?: string },
): boolean {
  if (!candidate) return false;
  if (stored.token) return candidate === stored.token;
  if (stored.hash) return `sha256:${hashApiKey(candidate)}` === stored.hash;
  return false;
}
