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
  renameProject,
  rotateApiKey,
  validateProjectKey,
} from "../core/projects.ts";
import { findKanbanDir, resolvePaths } from "../core/paths.ts";
import { assertKnownOptions, getBool, getString, parseArgs, rejectExtraPositionals, requirePositional } from "./args.ts";
import { closeCtx, openCtx } from "./context.ts";
import { createOutput } from "./output.ts";

const PROJECT_USAGE = `Usage: agent-kanban project <subcommand>

  list              list the visible projects
  show [key]        show project details
  add <key>         create a project and generate its API key (runs on the local db; remotely it must run on the server)
  rename <key>      rename
  key <key>         regenerate the API key (the old key stops working immediately)

Options: --name <name> --root <path> --json`;


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
      throw KanbanError.usage(`unknown subcommand: project ${sub}`, PROJECT_USAGE);
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
  rejectExtraPositionals(args, 0, "Usage: agent-kanban project list");
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
      out.line(
        "  " + `project (${list.length})`.padEnd(12) + "Name".padEnd(20) + "Tasks".padEnd(10) + "Requires key",
      );
      for (const p of list) {
        out.line(
          padEndWidth(String(p.key), 14) +
            padEndWidth(String(p.name), 20) +
            padEndWidth("-", 10) +
            (p.requires_key ? "yes" : "no"),
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
      out.line("(no project yet) running any command creates a local project automatically");
      return ExitCode.OK;
    }
    out.line("  " + `project (${projects.length})`.padEnd(14) + "Name".padEnd(22) + "Root path");
    for (const p of projects) {
      out.line(
        padEndWidth(p.key, 16) + padEndWidth(p.name, 22) + (p.rootPath ?? "-"),
      );
    }
    if (projects.length === 1) {
      out.line("");
      out.line(style.gray("Local mode: the `.kanban/` directory maps to this single project; no --project needed"));
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
  // project key 可以用位置参数给
  rejectExtraPositionals(args, 1, "Usage: agent-kanban project show [key]");
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
    out.line(`  Root path     ${p.root_path ?? "-"}`);
    out.line(`  Tasks         ${p.task_count}`);
    out.line(`  Events        ${p.event_count}`);
    out.line(`  Requires key  ${p.requires_key ? "yes" : "no (local mode)"}`);
    out.line(`  Created at    ${new Date(Number(p.created_at)).toISOString()}`);
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
  rejectExtraPositionals(args, 1, "Usage: agent-kanban project add <key> [--name <name>] [--root <path>]");
  const json = getBool(args, "json");
  const out = createOutput(json);
  const key = requirePositional(args, 0, "project key", "Usage: agent-kanban project add <key> [--name <name>] [--root <path>]");

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
    out.line(`${style.green("✓")} project created: ${style.cyan(project.key)}`);
    out.line(`  Name: ${project.name}`);
    if (project.rootPath) out.line(`  Root path: ${project.rootPath}`);
    if (apiKey) {
      out.line("");
      out.line(`${style.yellow("API key (shown only once, save it now):")}`);
      out.line(`  ${style.bold(apiKey)}`);
      out.line("");
      out.line(style.gray("Client usage:"));
      out.line(`  kanban --server http://<host>:7788 --project ${project.key} --key ${apiKey} task list`);
    } else {
      out.line(`  ${style.gray("No key generated (--no-key): this project is not authenticated, local machine use only")}`);
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
  rejectExtraPositionals(args, 1, "Usage: agent-kanban project rename <key> --name <new-name>");
  const out = createOutput(getBool(args, "json"));
  const key = requirePositional(args, 0, "project key", "Usage: agent-kanban project rename <key> --name <new-name>");
  const name = getString(args, "name");
  if (!name) throw KanbanError.usage("missing --name", "Usage: agent-kanban project rename <key> --name <new-name>");

  const handle = openLocalDb(process.cwd(), getString(args, "db"));
  try {
    // 走 core 而不是裸 UPDATE：不存在的 key 要报错，曾经不存在的 key 也报"renamed"
    const project = renameProject(handle.raw, key, name);
    out.line(`${style.green("✓")} ${style.cyan(key)} renamed to ${project.name}`);
    out.data({ key: project.key, name: project.name });
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
  rejectExtraPositionals(args, 1, "Usage: agent-kanban project key <key>");
  const out = createOutput(getBool(args, "json"));
  const key = requirePositional(args, 0, "project key", "Usage: agent-kanban project key <key>");

  const handle = openLocalDb(process.cwd(), getString(args, "db"));
  try {
    const { apiKey } = rotateApiKey(handle.raw, key);
    if (getBool(args, "json")) {
      out.data({ project: key, api_key: apiKey });
      return ExitCode.OK;
    }
    out.line(`${style.green("✓")} API key of ${style.cyan(key)} rotated`);
    out.line(`  ${style.bold(apiKey)}`);
    out.line(`  ${style.yellow("The old key stopped working immediately; this key is shown only once")}`);
    return ExitCode.OK;
  } finally {
    handle.raw.close();
  }
}
