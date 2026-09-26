/**
 * `kanban config ...` —— 项目配置管理。
 *
 * 设计目的（用户需求）：单个项目的配置是固定的，应该"配置一次、一直生效"，
 * 而不是每次敲 `kanban --server X --project Y --key Z task list`。
 */

import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { ExitCode, KanbanError, type ExitCodeValue } from "../core/errors.ts";
import { style } from "../core/format.ts";
import {
  CONFIG_FILE,
  readConfigFile,
  resolveConfig,
  writeConfigFile,
  type KanbanConfigFile,
  type KanbanMode,
} from "../core/config.ts";
import { slugifyProjectKey } from "../core/projects.ts";
import { findKanbanDir, findKanbanDirLoose } from "../core/paths.ts";
import { assertKnownOptions, getBool, getInt, getString, parseArgs } from "./args.ts";
import { createOutput } from "./output.ts";

const USAGE = `用法：kanban config <子命令>

  show        显示当前生效的配置及其来源（token 默认脱敏）
  init        生成/更新 .kanban/config.toml
  set         修改单个字段           kanban config set server.url https://kanban.corp
  use         切换本地/远程模式      kanban config use remote
  path        打印配置文件路径

优先级：命令行选项 > 环境变量 > config.toml

示例：
  # 首次配置远程模式
  kanban config init --server https://kanban.corp --project agent-kanban --key k_xxx
  kanban task list                 # 之后不用再带参数

  # 切回本地
  kanban config use local
  kanban task list`;

export async function cmdConfig(argv: string[]): Promise<ExitCodeValue> {
  const sub = argv[0];
  const rest = argv.slice(1);
  switch (sub) {
    case "show":
      return configShow(rest);
    case "init":
      return configInit(rest);
    case "set":
      return configSet(rest);
    case "use":
      return configUse(rest);
    case "path":
      return configPath(rest);
    case undefined:
    case "help":
    case "--help":
      process.stdout.write(USAGE + "\n");
      return ExitCode.OK;
    default:
      throw KanbanError.usage(`未知子命令：config ${sub}`, USAGE);
  }
}

/**
 * 定位 .kanban 目录（不存在则报错并提示 init）。
 *
 * 用**宽松版**查找：远程项目的本地没有 kanban.db（数据在 server），
 * 但仍然有 .kanban/config.toml，不能因为缺数据库就判定"未初始化"。
 */
function requireKanbanDir(cwd = process.cwd()): string {
  const found = findKanbanDirLoose(cwd);
  if (found) return found;
  const target = join(cwd, ".kanban");
  throw KanbanError.notInit(`未找到 ${CONFIG_FILE}`, {
    hint: `先初始化：kanban config init\n（会在 ${target} 下创建）`,
  });
}

/** 确保 .kanban 目录存在并返回路径（init 用） */
function ensureKanbanDir(cwd = process.cwd()): string {
  const found = findKanbanDir(cwd) ?? findKanbanDirLoose(cwd);
  const dir = found ?? join(cwd, ".kanban");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** 掩码 token：只显示前后几位 */
function maskToken(token: string | undefined): string {
  if (!token) return style.yellow("未配置");
  if (token.length <= 12) return token;
  return `${token.slice(0, 8)}…${token.slice(-4)}（${token.length} 字符）`;
}

/** config show：显示生效配置与来源 */
async function configShow(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "help", "reveal", "raw"],
    strings: ["db", "server", "project", "key"],
    short: { j: "json", h: "help" },
  });
  assertKnownOptions(args, ["json", "help", "reveal", "raw", "db", "server", "project", "key"]);
  const json = getBool(args, "json");
  const out = createOutput(json);

  const cwd = process.cwd();
  // 宽松查找：远程项目本地无数据库，但有 config.toml
  const kanbanDir = findKanbanDirLoose(cwd) ?? join(cwd, ".kanban");
  const resolved = resolveConfig({
    kanbanDir,
    cli: {
      server: getString(args, "server"),
      project: getString(args, "project"),
      key: getString(args, "key"),
      db: getString(args, "db"),
    },
  });
  const { config, sources } = resolved;
  const reveal = getBool(args, "reveal");

  if (json) {
    out.data({
      mode: config.mode,
      server: config.server ?? null,
      project: config.project ?? null,
      // 除非 --reveal，否则不输出 token 明文
      token: reveal ? (config.token ?? null) : config.token ? maskToken(config.token) : null,
      config_file: sources.configFile ?? null,
      sources: {
        mode: sources.modeSource,
        server: sources.serverSource,
        project: sources.projectSource,
        token: sources.tokenSource,
      },
    });
    return ExitCode.OK;
  }

  const mark = (source: string) => (source === "default" || source === "none" ? style.gray("(默认)") : style.cyan(`(${source})`));

  out.line("");
  out.line(`${style.bold("生效配置")}  ${style.gray("— 值后面的括号是来源")}`);
  out.line("");
  out.line(`  模式    ${config.mode === "remote" ? style.cyan("远程") : style.green("本地")}  ${mark(sources.modeSource)}`);
  out.line(`  server  ${config.server ?? style.gray("(未配置)")}  ${mark(sources.serverSource)}`);
  out.line(`  project ${config.project ?? style.gray("(未配置，本地模式按目录名自动派生)")}  ${mark(sources.projectSource)}`);
  out.line(`  token   ${maskToken(config.token)}  ${mark(sources.tokenSource)}`);
  out.line("");

  if (sources.configFile) {
    out.line(`  配置文件  ${sources.configFile}`);
  } else {
    out.line(`  配置文件  ${style.yellow("不存在")}  ${style.gray("用 `kanban config init` 生成")}`);
  }
  out.line("");

  // 给出下一步建议：让"配置不全"变成明确的行动指引
  if (config.mode === "remote") {
    const missing: string[] = [];
    if (!config.server) missing.push("server.url");
    if (!config.project) missing.push("project.key");
    if (!config.token) missing.push("server.token");
    if (missing.length > 0) {
      out.line(style.yellow(`  ⚠ 远程模式配置不完整，缺少：${missing.join("、")}`));
      out.line(style.gray("    这些命令会报错：task / board / session"));
      out.line("");
    }
  }

  out.line(style.gray("  提示：token 属于凭据，.kanban/config.toml 不要提交到公开仓库"));
  out.line("");
  return ExitCode.OK;
}

/** config init：生成配置文件 */
async function configInit(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "help", "force", "local", "remote"],
    strings: ["server", "project", "key", "name", "host", "port", "db"],
    short: { j: "json", h: "help" },
  });
  assertKnownOptions(args, ["json", "help", "force", "local", "remote", "server", "project", "key", "name", "host", "port", "db"]);
  const json = getBool(args, "json");
  const out = createOutput(json);

  const dir = ensureKanbanDir();
  const existing = readConfigFile(dir);

  if (existing && !getBool(args, "force")) {
    // 不覆盖已有配置（避免手滑把 server 改错）
    out.line(`${style.yellow("配置已存在")}：${existing.path}`);
    out.line(style.gray("  如需修改用 `kanban config set <字段> <值>`，或加 --force 覆盖"));
    if (json) {
      out.data({ ok: true, already_exists: true, path: existing.path, config: existing.config });
      return ExitCode.OK;
    }
    out.line("");
    return ExitCode.OK;
  }

  const cwd = process.cwd();
  const server = getString(args, "server");
  const projectInput = getString(args, "project");
  const project = projectInput ? slugifyProjectKey(projectInput) : slugifyProjectKey(basename(cwd));
  const key = getString(args, "key");

  // mode：显式指定优先；否则有 server 就是远程
  const mode: KanbanMode = getBool(args, "local")
    ? "local"
    : getBool(args, "remote") || server
      ? "remote"
      : "local";

  const config: KanbanConfigFile = {
    mode,
    server: server ? (server.startsWith("http") ? server : `https://${server}`) : undefined,
    token: key,
    project: mode === "remote" ? project : project,
    db: getString(args, "db"),
    host: getString(args, "host"),
    port: getInt(args, "port"),
  };

  // 保留已有的 server 端字段（admin_token 等）—— init 不该抹掉管理员凭据
  if (existing) {
    config.adminToken = existing.config.adminToken;
    config.adminTokenHash = existing.config.adminTokenHash;
    config.adminTokenGeneratedAt = existing.config.adminTokenGeneratedAt;
  }

  const path = writeConfigFile(dir, config);

  if (json) {
    out.data({ ok: true, path, config });
    return ExitCode.OK;
  }

  out.line(`${style.green("✓")} 配置已写入 ${style.cyan(path)}`);
  out.line("");
  out.line(`  模式    ${config.mode}`);
  out.line(`  project ${config.project ?? "-"}`);
  if (config.server) out.line(`  server  ${config.server}`);
  if (config.token) out.line(`  token   ${maskToken(config.token)}`);
  out.line("");
  if (mode === "remote" && (!config.server || !config.token)) {
    out.line(style.yellow("  ⚠ 远程模式还需要 server.url 与 server.token："));
    out.line(style.gray("     kanban config set server.url https://kanban.corp"));
    out.line(style.gray("     kanban config set server.token k_xxx"));
    out.line("");
  }
  out.line(style.gray("  之后直接运行 `kanban task list` 即可，无需再带参数"));
  out.line("");
  return ExitCode.OK;
}

/** config set：修改单个字段 */
async function configSet(argv: string[]): Promise<ExitCodeValue> {
  const field = argv[0];
  const value = argv[1];
  const args = parseArgs(argv.slice(2), {
    booleans: ["json", "help"],
    strings: ["db", "server", "project", "key"],
    short: { j: "json", h: "help" },
  });
  assertKnownOptions(args, ["json", "help", "db", "server", "project", "key"]);
  const json = getBool(args, "json");
  const out = createOutput(json);

  if (!field) {
    throw KanbanError.usage(
      "缺少字段名",
      "用法：kanban config set <字段> <值>\n可用字段：server.url, server.token, project.key, mode, db",
    );
  }

  const dir = requireKanbanDir();
  const current = readConfigFile(dir)?.config ?? { mode: "local" as KanbanMode };

  const FIELDS: Record<string, (cfg: KanbanConfigFile, value: string) => void> = {
    "server.url": (cfg, v) => {
      cfg.server = v.startsWith("http") ? v : `https://${v}`;
      if (cfg.mode !== "local") cfg.mode = "remote";
    },
    "server.token": (cfg, v) => {
      cfg.token = v;
    },
    "project.key": (cfg, v) => {
      cfg.project = slugifyProjectKey(v);
    },
    mode: (cfg, v) => {
      if (v !== "local" && v !== "remote") {
        throw KanbanError.usage(`mode 只能是 "local" 或 "remote"，收到 "${v}"`);
      }
      cfg.mode = v;
    },
    db: (cfg, v) => {
      cfg.db = v;
    },
    "server.host": (cfg, v) => {
      cfg.host = v;
    },
    "server.port": (cfg, v) => {
      cfg.port = Number(v);
      if (Number.isNaN(cfg.port)) {
        throw KanbanError.usage(`端口必须是数字，收到 "${v}"`);
      }
    },
  };

  const apply = FIELDS[field];
  if (!apply) {
    throw KanbanError.usage(
      `未知字段：${field}`,
      `可用字段：\n${Object.keys(FIELDS).map((f) => `  ${f}`).join("\n")}`,
    );
  }
  if (value === undefined) {
    throw KanbanError.usage(`字段 ${field} 需要一个值`, `用法：kanban config set ${field} <值>`);
  }

  apply(current, value);
  const path = writeConfigFile(dir, current);

  if (json) {
    out.data({ ok: true, path, field, value, config: current });
    return ExitCode.OK;
  }
  out.line(`${style.green("✓")} ${field} = ${field.includes("token") ? maskToken(value) : value}`);
  out.line(style.gray(`  已写入 ${path}`));

  // 提醒配置完整性：避免"改了一半然后命令报错"
  if (current.mode === "remote") {
    const missing: string[] = [];
    if (!current.server) missing.push("server.url");
    if (!current.project) missing.push("project.key");
    if (!current.token) missing.push("server.token");
    if (missing.length > 0) {
      out.line("");
      out.line(style.yellow(`  ⚠ 还缺：${missing.join("、")}（远程模式的命令会报错）`));
    }
  }
  return ExitCode.OK;
}

/** config use：切换本地/远程 */
async function configUse(argv: string[]): Promise<ExitCodeValue> {
  const mode = argv[0];
  const args = parseArgs(argv.slice(1), {
    booleans: ["json", "help"],
    strings: ["db", "server", "project", "key"],
    short: { j: "json", h: "help" },
  });
  assertKnownOptions(args, ["json", "help", "db", "server", "project", "key"]);
  const json = getBool(args, "json");
  const out = createOutput(json);

  if (mode !== "local" && mode !== "remote") {
    throw KanbanError.usage("用法：kanban config use local | remote", "示例：kanban config use local");
  }

  const dir = requireKanbanDir();
  const current = readConfigFile(dir)?.config ?? { mode: "local" as KanbanMode };
  current.mode = mode;

  if (mode === "remote" && !current.server) {
    // 切到远程但没有地址：提示怎么补
    const path = writeConfigFile(dir, current);
    throw KanbanError.usage(
      "切到远程模式还需要 server.url",
      `补上后即可使用：\n` +
        `  kanban config set server.url https://kanban.corp\n` +
        `  kanban config set project.key <项目>\n` +
        `  kanban config set server.token <token>\n` +
        `（配置已写入 ${path}）`,
    );
  }

  const path = writeConfigFile(dir, current);
  if (json) {
    out.data({ ok: true, path, mode, config: current });
    return ExitCode.OK;
  }
  out.line(`${style.green("✓")} 已切换到 ${style.bold(mode === "remote" ? "远程" : "本地")} 模式`);
  out.line(style.gray(`  ${path}`));
  return ExitCode.OK;
}

/** config path：打印配置路径 */
async function configPath(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "help"],
    strings: ["db"],
    short: { j: "json", h: "help" },
  });
  assertKnownOptions(args, ["json", "help", "db"]);
  const json = getBool(args, "json");
  const out = createOutput(json);

  const cwd = process.cwd();
  const dir = findKanbanDirLoose(cwd);
  const path = join(dir ?? join(cwd, ".kanban"), CONFIG_FILE);
  if (json) {
    out.data({ path, exists: existsSync(path) });
    return ExitCode.OK;
  }
  process.stdout.write(path + "\n");
  return ExitCode.OK;
}
