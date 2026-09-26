/**
 * `agent-kanban project ...` —— 项目查询与本机直连管理。
 *
 * 说明（ADR-12/ADR-13）：
 * - 远程连接配置已统一到 `.kanban/config.toml`（见 `agent-kanban config`），不再有 remote.json
 * - 创建 project / 签发 token 走 `agent-kanban admin`（需要管理员 token）
 * - 本命令保留的是**本机直连**场景：server 所在机器上用 `--db` 直连库查看
 *   （不含权限控制的场景；管理操作请用 `agent-kanban admin`）
 */

import { existsSync, mkdirSync } from "node:fs";
import { ExitCode, KanbanError, type ExitCodeValue } from "../core/errors.ts";
import { padEndWidth, style } from "../core/format.ts";
import { openDb, migrate } from "../core/db.ts";
import {
  createProject,
  generateApiKey,
  hashApiKey,
  listProjects,
  rotateApiKey,
  validateProjectKey,
} from "../core/projects.ts";
import { findKanbanDir, resolvePaths } from "../core/paths.ts";
import { assertKnownOptions, getBool, getString, parseArgs, requirePositional } from "./args.ts";
import { closeCtx, openCtx } from "./context.ts";
import { createOutput } from "./output.ts";

const PROJECT_USAGE = `用法：agent-kanban project <子命令>

  list              列出可见的 project
  show [key]        显示 project 详情
  add <key>         创建 project 并生成 API key（本地库上执行，远程需在 server 端）
  rename <key>      重命名
  key <key>         重新生成 API key（旧 key 立即失效）

选项：--name <名称> --root <路径> --json`;


/** project 概要信息（CLI 与 admin API 共用） */
export function projectInfoForCli(
  project: import("../core/projects.ts").Project,
  db: import("bun:sqlite").Database,
): Record<string, unknown> {
  const taskCount =
    db
      .query<{ c: number }, [string]>("SELECT COUNT(*) AS c FROM tasks WHERE project_key = ?")
      .get(project.key)?.c ?? 0;
  const tokenCount =
    db
      .query<{ c: number }, [string]>(
        `SELECT COUNT(*) AS c FROM tokens WHERE revoked_at IS NULL AND (role = 'admin' OR projects LIKE ?)`,
      )
      .get(`%"${project.key}"%`)?.c ?? 0;
  return {
    key: project.key,
    name: project.name,
    root_path: project.rootPath,
    task_count: taskCount,
    token_count: tokenCount,
    created_at: project.createdAt,
  };
}

/** project 命令入口 */
export async function cmdProject(argv: string[]): Promise<ExitCodeValue> {
  const sub = argv[0];
  const rest = argv.slice(1);
  switch (sub) {
    case "list":
      return projectList(rest);
    case "show":
      return projectShow(rest);
    case "add":
      return projectAdd(rest);
    case "rename":
      return projectRename(rest);
    case "key":
      return projectKey(rest);
    case undefined:
    case "help":
    case "--help":
      process.stdout.write(PROJECT_USAGE + "\n");
      return ExitCode.OK;
    default:
      throw KanbanError.usage(`未知子命令：project ${sub}`, PROJECT_USAGE);
  }
}

/** 本地 DB 直连（project 管理不走 Op，因为它是 server 端的管理操作） */
function openLocalDb(cwd: string, dbPath?: string): ReturnType<typeof openDb> {
  const paths = resolvePaths({ db: dbPath, cwd, mustExist: true });
  const handle = openDb(paths.db);
  migrate(handle);
  return handle;
}

/** project list */
async function projectList(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "help"],
    strings: ["db", "server", "project", "key"],
    short: { j: "json", h: "help" },
  });
  assertKnownOptions(args, ["json", "help", "db", "server", "project", "key"]);
  const json = getBool(args, "json");
  const out = createOutput(json);

  // 远程模式：project.list 走 Op
  if (getString(args, "server") || process.env.KANBAN_SERVER) {
    const ctx = openCtx({
      json,
      dbPath: getString(args, "db"),
      server: getString(args, "server"),
      project: getString(args, "project"),
      key: getString(args, "key"),
    });
    try {
      const { data } = await ctx.backend.executeWithHints({ kind: "project.list", params: {} });
      if (json) {
        out.data(data);
        return ExitCode.OK;
      }
      const list = data as Array<Record<string, unknown>>;
      out.line(`project（${list.length}）`.padEnd(14) + "名称".padEnd(20) + "任务数".padEnd(10) + "需要 key");
      for (const p of list) {
        out.line(
          padEndWidth(String(p.key), 14) +
            padEndWidth(String(p.name), 20) +
            padEndWidth("-", 10) +
            (p.requires_key ? "是" : "否"),
        );
      }
      return ExitCode.OK;
    } finally {
      closeCtx(ctx);
    }
  }

  // 本地模式
  const handle = openLocalDb(process.cwd(), getString(args, "db"));
  try {
    const projects = listProjects(handle.raw);
    if (json) {
      out.data(
        projects.map((p) => ({
          key: p.key,
          name: p.name,
          root_path: p.rootPath,
          requires_key: p.apiKeyHash !== null,
          created_at: p.createdAt,
        })),
      );
      return ExitCode.OK;
    }
    if (projects.length === 0) {
      out.line("（还没有 project）运行任意命令会自动创建本地 project");
      return ExitCode.OK;
    }
    out.line(`project（${projects.length}）`.padEnd(16) + "名称".padEnd(22) + "根目录");
    for (const p of projects) {
      out.line(
        padEndWidth(p.key, 16) + padEndWidth(p.name, 22) + (p.rootPath ?? "-"),
      );
    }
    if (projects.length === 1) {
      out.line("");
      out.line(style.gray("本地模式：`.kanban/` 目录对应这一个 project，无需传 --project"));
    }
    return ExitCode.OK;
  } finally {
    handle.raw.close();
  }
}

/** project show */
async function projectShow(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "help"],
    strings: ["db", "server", "project", "key"],
    short: { j: "json", h: "help" },
  });
  assertKnownOptions(args, ["json", "help", "db", "server", "project", "key"]);
  const json = getBool(args, "json");
  const out = createOutput(json);
  const ctx = openCtx({
    json,
    dbPath: getString(args, "db"),
    server: getString(args, "server"),
    project: getString(args, "project") ?? args.positionals[0],
    key: getString(args, "key"),
  });
  try {
    const { data } = await ctx.backend.executeWithHints({ kind: "project.get", params: {} });
    if (json) {
      out.data(data);
      return ExitCode.OK;
    }
    const p = data as Record<string, unknown>;
    out.line("");
    out.line(`${style.bold(String(p.name))}  ${style.cyan(`(${p.key})`)}`);
    out.line(`  根目录    ${p.root_path ?? "-"}`);
    out.line(`  任务数    ${p.task_count}`);
    out.line(`  事件数    ${p.event_count}`);
    out.line(`  需要 key  ${p.requires_key ? "是" : "否（本地模式）"}`);
    out.line(`  创建于    ${new Date(Number(p.created_at)).toISOString()}`);
    out.line("");
    return ExitCode.OK;
  } finally {
    closeCtx(ctx);
  }
}

/**
 * project add：创建 project 并生成 API key。
 *
 * 只在能直连库的机器上执行（本地模式，或 server 所在机器）。
 * key 明文**只在这里显示一次**，库里只存 SHA-256 哈希（ADR-11）。
 */
async function projectAdd(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "help", "no-key"],
    strings: ["name", "root", "db"],
    short: { j: "json", h: "help", n: "name", r: "root" },
  });
  assertKnownOptions(args, ["json", "help", "no-key", "name", "root", "db"]);
  const json = getBool(args, "json");
  const out = createOutput(json);
  const key = requirePositional(args, 0, "project key", "用法：agent-kanban project add <key> [--name <名称>] [--root <路径>]");

  const handle = openLocalDb(process.cwd(), getString(args, "db"));
  try {
    validateProjectKey(key);
    const apiKey = getBool(args, "no-key") ? null : generateApiKey();
    const project = createProject(handle.raw, {
      key,
      name: getString(args, "name") ?? key,
      rootPath: getString(args, "root") ?? null,
      apiKeyHash: apiKey ? hashApiKey(apiKey) : null,
    });

    if (json) {
      out.data({ ...project, api_key: apiKey });
      return ExitCode.OK;
    }
    out.line(`${style.green("✓")} project 已创建：${style.cyan(project.key)}`);
    out.line(`  名称：${project.name}`);
    if (project.rootPath) out.line(`  根目录：${project.rootPath}`);
    if (apiKey) {
      out.line("");
      out.line(`${style.yellow("API key（只显示这一次，请立即保存）：")}`);
      out.line(`  ${style.bold(apiKey)}`);
      out.line("");
      out.line(style.gray("客户端使用："));
      out.line(`  kanban --server http://<host>:7788 --project ${project.key} --key ${apiKey} task list`);
    } else {
      out.line(`  ${style.gray("未生成 key（--no-key）：该 project 不鉴权，仅建议本机使用")}`);
    }
    return ExitCode.OK;
  } finally {
    handle.raw.close();
  }
}

/** project rename */
async function projectRename(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "help"],
    strings: ["name", "db"],
    short: { j: "json", h: "help", n: "name" },
  });
  assertKnownOptions(args, ["json", "help", "name", "db"]);
  const out = createOutput(getBool(args, "json"));
  const key = requirePositional(args, 0, "project key", "用法：agent-kanban project rename <key> --name <新名>");
  const name = getString(args, "name");
  if (!name) throw KanbanError.usage("缺少 --name", "用法：agent-kanban project rename <key> --name <新名>");

  const handle = openLocalDb(process.cwd(), getString(args, "db"));
  try {
    handle.raw.query("UPDATE projects SET name = ? WHERE key = ?").run(name, key);
    out.line(`${style.green("✓")} ${style.cyan(key)} 重命名为 ${name}`);
    out.data({ key, name });
    return ExitCode.OK;
  } finally {
    handle.raw.close();
  }
}

/** project key：重新生成 API key */
async function projectKey(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "help", "rotate"],
    strings: ["db"],
    short: { j: "json", h: "help" },
  });
  assertKnownOptions(args, ["json", "help", "rotate", "db"]);
  const out = createOutput(getBool(args, "json"));
  const key = requirePositional(args, 0, "project key", "用法：agent-kanban project key <key>");

  const handle = openLocalDb(process.cwd(), getString(args, "db"));
  try {
    const { apiKey } = rotateApiKey(handle.raw, key);
    if (getBool(args, "json")) {
      out.data({ project: key, api_key: apiKey });
      return ExitCode.OK;
    }
    out.line(`${style.green("✓")} ${style.cyan(key)} 的 API key 已轮换`);
    out.line(`  ${style.bold(apiKey)}`);
    out.line(`  ${style.yellow("旧 key 已立即失效；此 key 只显示这一次")}`);
    return ExitCode.OK;
  } finally {
    handle.raw.close();
  }
}
