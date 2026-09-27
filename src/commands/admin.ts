/**
 * `agent-kanban admin ...` —— 管理员命令（ADR-13）。
 *
 * 两种执行路径（都能工作，按可用性自动选择）：
 * - **直连库**（server 所在机器，或本地 admin 库）：`--db <path>`
 * - **走 HTTP**（任意机器）：配置里是远程 server 时自动走远程 admin API
 *
 * 两种路径调用**同一份 core 逻辑**（或同一组 API 语义），行为一致。
 */

import { ExitCode, KanbanError, type ExitCodeValue } from "../core/errors.ts";
import { padEndWidth, parseDuration, relativeTime, style } from "../core/format.ts";
import { migrate, openDb, type Db } from "../core/db.ts";
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  renameProject,
  validateProjectKey,
} from "../core/projects.ts";
import {
  getToken,
  issueToken,
  listTokens,
  describeTokenRef,
  revokeToken,
  tokenToJson,
  updateTokenMeta,
  updateTokenProjects,
  type AccessToken,
  type TokenRole,
} from "../core/tokens.ts";
import { projectInfoForCli } from "./project.ts";
import { assertKnownOptions, getBool, getList, getString, parseArgs, rejectExtraPositionals, requirePositional } from "./args.ts";
import { closeCtx, openCtx, type Ctx } from "./context.ts";
import { createOutput } from "./output.ts";
import { RemoteBackend } from "../core/backend-remote.ts";

const USAGE = `Usage: agent-kanban admin <subcommand>

  project list                     List all projects
  project add <key> [--name N]     Create a project
  project delete <key> [--force]   Delete a project (its tasks go too, irreversible)
  project rename <key> --name N    Rename

  token list [--all]               List tokens (only unrevoked ones by default)
  token create --project A [--project B] [--role project|admin]
                [--name N] [--note N] [--expires-in 30d]
  token grant <token> --project A  Add project grants to an existing token
  token revoke <token>             Revoke a token (irreversible)
  token rename <token> --name N    Change the token name / note

Notes:
  · Admin operations need an **admin token**; without one, use admin_token from the server's .kanban/config.toml
  · The plaintext token is shown only once, at create time
  · On the machine hosting the server you can add --db <server db path> to operate directly (no HTTP)

Example:
  agent-kanban admin project add demo-app --name "demo project"
  agent-kanban admin token create --project demo-app --name "CI only"
  agent-kanban admin token grant k_xxx --project web-app
  agent-kanban admin token revoke k_xxx`;

export async function cmdAdmin(argv: string[]): Promise<ExitCodeValue> {
  const group = argv[0];
  const rest = argv.slice(1);
  switch (group) {
    case "project":
      return adminProject(rest);
    case "token":
      return adminToken(rest);
    case undefined:
    case "help":
    case "--help":
      process.stdout.write(USAGE + "\n");
      return ExitCode.OK;
    default:
      throw KanbanError.usage(`unknown command: admin ${group}`, USAGE);
  }
}

/**
 * 打开管理目标：优先直连 --db 指定/本地的库，否则走远程 admin API。
 *
 * 返回 null 表示走远程（由调用方用 RemoteBackend 调 API）。
 */
function openAdminDb(dbPath?: string): Db | null {
  if (!dbPath) return null;
  const handle = openDb(dbPath);
  migrate(handle);
  return handle;
}

/** 走远程 admin API 的调用器 */
class RemoteAdmin {
  constructor(private readonly ctx: Ctx) {}

  async call(path: string, init: RequestInit = {}): Promise<unknown> {
    const backend = this.ctx.backend as RemoteBackend;
    const server = (backend as unknown as { server: string }).server;
    const token = this.ctx.effectiveConfig.token ?? "";
    const res = await fetch(`${server}/api/admin${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-Kanban-Key": token,
        ...(init.headers ?? {}),
      },
    });
    const body = (await res.json()) as {
      ok: boolean;
      data?: unknown;
      error?: { code: number; name: string; message: string; details?: Record<string, unknown> };
    };
    if (!res.ok || !body.ok) {
      const err = body.error;
      throw new KanbanError(
        (err?.code ?? 6) as never,
        (err?.name ?? "INTERNAL") as never,
        err?.message ?? `HTTP ${res.status}`,
        err?.details ?? {},
      );
    }
    return body.data;
  }
}

// =============================================================================
// admin project
// =============================================================================

async function adminProject(argv: string[]): Promise<ExitCodeValue> {
  const sub = argv[0];
  const rest = argv.slice(1);

  switch (sub) {
    case "list":
      return projectList(rest);
    case "add":
      return projectAdd(rest);
    case "delete":
    case "rm":
      return projectDelete(rest);
    case "rename":
      return projectRename(rest);
    default:
      throw KanbanError.usage(
        `unknown command: admin project ${sub ?? ""}`,
        USAGE,
      );
  }
}

async function projectList(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "help"],
    strings: ["db", "server", "project", "key"],
    short: { j: "json", h: "help" },
  });
  assertKnownOptions(args, ["json", "help", "db", "server", "project", "key"]);
  rejectExtraPositionals(args, 0, "Usage: agent-kanban admin project list");
  const json = getBool(args, "json");
  const out = createOutput(json);

  const handle = openAdminDb(getString(args, "db"));
  if (handle) {
    try {
      const rows = listProjects(handle.raw).map((p) => projectInfoForCli(p, handle.raw));
      if (json) {
        out.data(rows);
        return ExitCode.OK;
      }
      if (rows.length === 0) {
        out.line('(no projects yet. Create one with `agent-kanban admin project add <key>`)');
        return ExitCode.OK;
      }
      out.line(`project (${rows.length})`.padEnd(13) + "Name".padEnd(22) + "Tasks".padEnd(8) + "token".padEnd(8) + "Created");
      for (const r of rows) {
        out.line(
          padEndWidth(String(r.key), 8) +
            padEndWidth(String(r.name), 22) +
            padEndWidth(String(r.task_count), 8) +
            padEndWidth(String(r.token_count), 8) +
            style.gray(relativeTime(Number(r.created_at))),
        );
      }
      return ExitCode.OK;
    } finally {
      handle.raw.close();
    }
  }

  // 远程
  const remote = openRemoteAdmin(args, json);
  const data = (await remote.call("/projects")) as Array<Record<string, unknown>>;
  if (json) {
    out.data(data);
    return ExitCode.OK;
  }
  out.line(`project (${data.length})`.padEnd(13) + "Name".padEnd(22) + "Tasks".padEnd(8) + "token");
  for (const r of data) {
    out.line(
      padEndWidth(String(r.key), 8) +
        padEndWidth(String(r.name), 22) +
        padEndWidth(String(r.task_count), 8) +
        String(r.token_count ?? "-"),
    );
  }
  return ExitCode.OK;
}

async function projectAdd(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "help"],
    strings: ["name", "root", "db", "server", "project", "key"],
    short: { j: "json", h: "help", n: "name", r: "root" },
  });
  assertKnownOptions(args, ["json", "help", "name", "root", "db", "server", "project", "key"]);
  rejectExtraPositionals(args, 1, "Usage: agent-kanban admin project add <key> [--name <name>]");
  const json = getBool(args, "json");
  const out = createOutput(json);
  const key = requirePositional(args, 0, "project key", "Usage: agent-kanban admin project add <key> [--name <name>]");

  const handle = openAdminDb(getString(args, "db"));
  if (handle) {
    try {
      const project = createProject(handle.raw, {
        key,
        name: getString(args, "name") ?? key,
        rootPath: getString(args, "root") ?? null,
        // v3：鉴权由 tokens 表统一管理，project 不再自带 key
        apiKeyHash: null,
      });
      if (json) {
        out.data(project);
        return ExitCode.OK;
      }
      out.line(`${style.green("✓")} project created: ${style.cyan(project.key)}  ${project.name}`);
      out.line("");
      out.line(style.gray("Next: issue an access token"));
      out.line(`  agent-kanban admin token create --project ${project.key} --name "team token"`);
      return ExitCode.OK;
    } finally {
      handle.raw.close();
    }
  }

  const remote = openRemoteAdmin(args, json);
  const data = (await remote.call("/projects", {
    method: "POST",
    body: JSON.stringify({ key, name: getString(args, "name") ?? key, root_path: getString(args, "root") }),
  })) as Record<string, unknown>;
  if (json) {
    out.data(data);
    return ExitCode.OK;
  }
  out.line(`${style.green("✓")} project created: ${style.cyan(String(data.key))}  ${data.name}`);
  out.line("");
  out.line(style.gray("Next: issue an access token"));
  out.line(`  agent-kanban admin token create --project ${key} --name "team token"`);
  return ExitCode.OK;
}

async function projectDelete(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "help", "force"],
    strings: ["db", "server", "project", "key"],
    short: { j: "json", h: "help", f: "force" },
  });
  assertKnownOptions(args, ["json", "help", "force", "db", "server", "project", "key"]);
  rejectExtraPositionals(args, 1, "Usage: agent-kanban admin project delete <key> --force");
  const json = getBool(args, "json");
  const out = createOutput(json);
  const key = requirePositional(args, 0, "project key", "Usage: agent-kanban admin project delete <key> --force");

  const handle = openAdminDb(getString(args, "db"));
  if (handle) {
    try {
      const existing = getProject(handle.raw, key);
      if (!existing) throw KanbanError.state(`project not found: ${key}`);
      const taskCount =
        handle.raw
          .query<{ c: number }, [string]>("SELECT COUNT(*) AS c FROM tasks WHERE project_key = ?")
          .get(key)?.c ?? 0;
      if (taskCount > 0 && !getBool(args, "force")) {
        throw KanbanError.state(
          `project "${key}" still has ${taskCount} task(s), deletion is irreversible`,
          { task_count: taskCount, hint: "add --force to confirm the deletion" },
        );
      }
      deleteProject(handle.raw, key, getBool(args, "force"));
      if (json) {
        out.data({ ok: true, deleted: key, task_count: taskCount });
        return ExitCode.OK;
      }
      out.line(`${style.green("✓")} Deleted project ${style.cyan(key)} (including ${taskCount} tasks)`);
      return ExitCode.OK;
    } finally {
      handle.raw.close();
    }
  }

  const remote = openRemoteAdmin(args, json);
  const force = getBool(args, "force") ? "?force=1" : "";
  const data = (await remote.call(`/projects/${encodeURIComponent(key)}${force}`, { method: "DELETE" })) as {
    deleted: string;
  };
  if (json) {
    out.data(data);
    return ExitCode.OK;
  }
  out.line(`${style.green("✓")} Deleted project ${style.cyan(data.deleted)}`);
  return ExitCode.OK;
}

async function projectRename(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "help"],
    strings: ["name", "db", "server", "project", "key"],
    short: { j: "json", h: "help", n: "name" },
  });
  assertKnownOptions(args, ["json", "help", "name", "db", "server", "project", "key"]);
  rejectExtraPositionals(args, 1, "Usage: agent-kanban admin project rename <key> --name <new name>");
  const json = getBool(args, "json");
  const out = createOutput(json);
  const key = requirePositional(args, 0, "project key", "Usage: agent-kanban admin project rename <key> --name <new name>");
  const name = getString(args, "name");
  if (!name) throw KanbanError.usage("missing --name", "Usage: agent-kanban admin project rename <key> --name <new name>");

  const handle = openAdminDb(getString(args, "db"));
  if (handle) {
    try {
      const project = renameProject(handle.raw, key, name);
      if (json) {
        out.data(project);
        return ExitCode.OK;
      }
      out.line(`${style.green("✓")} ${style.cyan(project.key)} renamed to ${project.name}`);
      return ExitCode.OK;
    } finally {
      handle.raw.close();
    }
  }

  // 远程：走 project.rename Op
  const ctx = openCtx({ json, server: getString(args, "server"), project: getString(args, "project"), key: getString(args, "key") });
  try {
    const { data } = await ctx.backend.executeWithHints({
      kind: "project.rename",
      params: { key, name },
    });
    if (json) {
      out.data(data);
      return ExitCode.OK;
    }
    out.line(`${style.green("✓")} ${style.cyan(key)} renamed to ${name}`);
    return ExitCode.OK;
  } finally {
    closeCtx(ctx);
  }
}

// =============================================================================
// admin token
// =============================================================================

async function adminToken(argv: string[]): Promise<ExitCodeValue> {
  const sub = argv[0];
  const rest = argv.slice(1);

  switch (sub) {
    case "list":
      return tokenList(rest);
    case "create":
    case "new":
      return tokenCreate(rest);
    case "grant":
      return tokenGrant(rest);
    case "revoke":
    case "rm":
      return tokenRevoke(rest);
    case "rename":
      return tokenRename(rest);
    default:
      throw KanbanError.usage(`unknown command: admin token ${sub ?? ""}`, USAGE);
  }
}

async function tokenList(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "help", "all"],
    strings: ["role", "db", "server", "project", "key"],
    short: { j: "json", h: "help", a: "all" },
  });
  assertKnownOptions(args, ["json", "help", "all", "role", "db", "server", "project", "key"]);
  rejectExtraPositionals(args, 0, "Usage: agent-kanban admin token list [--all] [--role project|admin]");
  const json = getBool(args, "json");
  const out = createOutput(json);

  const handle = openAdminDb(getString(args, "db"));
  const now = Date.now();

  if (handle) {
    try {
      const tokens = listTokens(handle.raw, {
        role: getString(args, "role") as TokenRole | undefined,
        includeRevoked: getBool(args, "all"),
      });
      if (json) {
        out.data(tokens.map((t) => tokenToJson(t, now)));
        return ExitCode.OK;
      }
      if (tokens.length === 0) {
        out.line('(no tokens yet. Issue one with `agent-kanban admin token create --project <key>`)');
        return ExitCode.OK;
      }
      out.line(
        `token (${tokens.length})`.padEnd(20) + "Name".padEnd(18) + "Role".padEnd(10) +
          "Projects".padEnd(24) + "Status".padEnd(10) + "Last used",
      );
      for (const t of tokens) {
        const json2 = tokenToJson(t, now);
        out.line(
          padEndWidth(String(json2.id), 20) +
            padEndWidth(String(json2.name ?? "-"), 18) +
            padEndWidth(t.role === "admin" ? "admin" : "project", 10) +
            padEndWidth(t.role === "admin" ? "all" : t.projects.join(","), 24) +
            padEndWidth(String(json2.status), 10) +
            style.gray(t.lastUsedAt ? relativeTime(t.lastUsedAt, now) : "never"),
        );
      }
      return ExitCode.OK;
    } finally {
      handle.raw.close();
    }
  }

  const remote = openRemoteAdmin(args, json);
  const query = getBool(args, "all") ? "?include_revoked=1" : "";
  const tokens = (await remote.call(`/tokens${query}`)) as Array<Record<string, unknown>>;
  if (json) {
    out.data(tokens);
    return ExitCode.OK;
  }
  out.line(`token (${tokens.length})`.padEnd(20) + "Name".padEnd(18) + "Role".padEnd(10) + "Projects".padEnd(24) + "Status");
  for (const t of tokens) {
    const projects = t.role === "admin" ? "all" : (t.projects as string[] | null)?.join(",") ?? "-";
    out.line(
      padEndWidth(String(t.id), 20) +
        padEndWidth(String(t.name ?? "-"), 18) +
        padEndWidth(t.role === "admin" ? "admin" : "project", 10) +
        padEndWidth(projects, 24) +
        String(t.status),
    );
  }
  return ExitCode.OK;
}

/**
 * 解析 --expires-in（如 30d / 12h / 4w）→ 毫秒。
 * 单位换算走 format.parseDuration（曾经这里另抄一份单位表）；这里只负责
 * 到期时长自己的约束：单个单位、必须显式带单位（"30" 是 30 分钟还是 30 天？模糊的
 * 过期时间宁可拒绝）。
 */
function parseExpiresIn(value: string | undefined): number | null {
  if (!value) return null;
  const m = /^(\d+)\s*([dhmsw])$/.exec(value.trim().toLowerCase());
  if (!m) {
    throw KanbanError.usage(`cannot parse expiry "${value}"`, "Supported: 30d (days) / 12h / 7d / 4w (weeks)");
  }
  return parseDuration(value);
}

async function tokenCreate(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "help"],
    strings: ["project", "name", "note", "role", "expires-in", "db", "server", "key"],
    short: { j: "json", h: "help", p: "project", n: "name", r: "role" },
  });
  assertKnownOptions(args, ["json", "help", "project", "name", "note", "role", "expires-in", "db", "server", "key"]);
  rejectExtraPositionals(args, 0, 'Usage: agent-kanban admin token create --project <key> --name "CI runner"');
  const json = getBool(args, "json");
  const out = createOutput(json);

  const role = (getString(args, "role") ?? "project") as TokenRole;
  if (role !== "project" && role !== "admin") {
    throw KanbanError.usage(`--role must be project or admin, got "${role}"`);
  }
  const projects = getList(args, "project") ?? [];
  const expiresInMs = parseExpiresIn(getString(args, "expires-in"));
  const name = getString(args, "name");
  const note = getString(args, "note");

  const handle = openAdminDb(getString(args, "db"));
  const issued = handle
    ? (() => {
        try {
          return issueToken(
            handle.raw,
            { role, projects, name: name ?? null, note: note ?? null, expiresInMs, createdBy: "cli" },
          );
        } finally {
          handle.raw.close();
        }
      })()
    : null;

  let data: Record<string, unknown>;
  if (issued) {
    data = { ...tokenToJson(issued.token), token: issued.plaintext, warning: "this plaintext is shown only once" };
  } else {
    const remote = openRemoteAdmin(args, json);
    data = (await remote.call("/tokens", {
      method: "POST",
      body: JSON.stringify({ role, projects, name, note, expires_in_ms: expiresInMs }),
    })) as Record<string, unknown>;
  }

  if (json) {
    out.data(data);
    return ExitCode.OK;
  }

  // 明文展示：这是唯一一次能看到它的地方
  out.line(`${style.green("✓")} Token issued`);
  if (name) out.line(`  Name     ${name}`);
  out.line(`  Role     ${role === "admin" ? "admin (can reach every project)" : `project (${projects.join(", ")})`}`);
  if (expiresInMs) {
    out.line(`  Expires  ${getString(args, "expires-in")} (expires ${new Date(Date.now() + expiresInMs).toLocaleString("en-US")})`);
  }
  out.line("");
  out.line(`${style.yellow("token (shown only once, save it now)")}`);
  out.line(`  ${style.bold(String(data.token))}`);
  out.line("");
  // 打印引用：吊销/改白名单要的是它（库里不存明文，所以不能用 token 明文当句柄）。
  // 不打印的话，用户只能去 `token list` 或 admin 页把它找回来。
  if (data.id) {
    out.line(style.gray("  Ref (for revoke / grant — not a secret):"));
    out.line(`    ${style.cyan(String(data.id))}`);
    out.line("");
  }
  if (role === "project") {
    out.line(style.gray("  Write it into the client config:"));
    out.line(style.gray(`    agent-kanban config set server.token ${data.token}`));
    out.line(style.gray(`    (or edit server.token in .kanban/config.toml)`));
  }
  return ExitCode.OK;
}

async function tokenGrant(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "help", "replace"],
    strings: ["project", "db", "server", "key"],
    short: { j: "json", h: "help", p: "project" },
  });
  assertKnownOptions(args, ["json", "help", "replace", "project", "db", "server", "key"]);
  rejectExtraPositionals(args, 1, "Usage: agent-kanban admin token grant <token> --project <key>");
  const json = getBool(args, "json");
  const out = createOutput(json);
  const tokenId = requirePositional(args, 0, "token", "Usage: agent-kanban admin token grant <token> --project <key>");
  const addProjects = getList(args, "project") ?? [];
  if (addProjects.length === 0) {
    throw KanbanError.usage(
      "missing --project",
      "Usage: agent-kanban admin token grant <token> --project app1 --project app2\n" +
        "(--replace replaces the whole allowlist instead of appending)",
    );
  }

  const handle = openAdminDb(getString(args, "db"));
  if (handle) {
    try {
      const token = getToken(handle.raw, tokenId);
      if (!token) throw KanbanError.state(`token not found: ${describeTokenRef(tokenId)}`);
      const next = getBool(args, "replace")
        ? addProjects
        : Array.from(new Set([...token.projects, ...addProjects]));
      const updated = updateTokenProjects(handle.raw, tokenId, next);
      if (json) {
        out.data(tokenToJson(updated));
        return ExitCode.OK;
      }
      out.line(`${style.green("✓")} grants of token ${describeTokenRef(tokenId)} updated`);
      out.line(`  Current grants: ${updated.projects.join(", ")}`);
      return ExitCode.OK;
    } finally {
      handle.raw.close();
    }
  }

  const remote = openRemoteAdmin(args, json);
  const current = (await remote.call(`/tokens/${encodeURIComponent(tokenId)}`)) as { projects?: string[] } | null;
  const next = getBool(args, "replace")
    ? addProjects
    : Array.from(new Set([...(current?.projects ?? []), ...addProjects]));
  const data = (await remote.call(`/tokens/${encodeURIComponent(tokenId)}`, {
    method: "PATCH",
    body: JSON.stringify({ projects: next }),
  })) as Record<string, unknown>;
  if (json) {
    out.data(data);
    return ExitCode.OK;
  }
  out.line(`${style.green("✓")} grants of token ${describeTokenRef(tokenId)} updated`);
  out.line(`  Current grants: ${(data.projects as string[]).join(", ")}`);
  return ExitCode.OK;
}

async function tokenRevoke(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "help", "yes"],
    strings: ["db", "server", "project", "key"],
    short: { j: "json", h: "help" },
  });
  assertKnownOptions(args, ["json", "help", "yes", "db", "server", "project", "key"]);
  rejectExtraPositionals(args, 1, "Usage: agent-kanban admin token revoke <token>");
  const json = getBool(args, "json");
  const out = createOutput(json);
  const tokenId = requirePositional(args, 0, "token", "Usage: agent-kanban admin token revoke <token>");

  const handle = openAdminDb(getString(args, "db"));
  if (handle) {
    try {
      const revoked = revokeToken(handle.raw, tokenId);
      if (json) {
        out.data(tokenToJson(revoked));
        return ExitCode.OK;
      }
      out.line(`${style.green("✓")} token ${describeTokenRef(tokenId)} revoked (irreversible)`);
      return ExitCode.OK;
    } finally {
      handle.raw.close();
    }
  }

  const remote = openRemoteAdmin(args, json);
  const data = (await remote.call(`/tokens/${encodeURIComponent(tokenId)}/revoke`, { method: "POST" })) as Record<string, unknown>;
  if (json) {
    out.data(data);
    return ExitCode.OK;
  }
  out.line(`${style.green("✓")} token ${describeTokenRef(tokenId)} revoked (irreversible)`);
  return ExitCode.OK;
}

async function tokenRename(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "help"],
    strings: ["name", "note", "db", "server", "project", "key"],
    short: { j: "json", h: "help", n: "name" },
  });
  assertKnownOptions(args, ["json", "help", "name", "note", "db", "server", "project", "key"]);
  rejectExtraPositionals(args, 1, "Usage: agent-kanban admin token rename <token> --name <new name>");
  const json = getBool(args, "json");
  const out = createOutput(json);
  const tokenId = requirePositional(args, 0, "token", "Usage: agent-kanban admin token rename <token> --name <new name>");
  const name = getString(args, "name");
  const note = getString(args, "note");
  if (!name && !note) {
    throw KanbanError.usage("missing --name or --note", "Usage: agent-kanban admin token rename <token> --name <new name>");
  }

  const handle = openAdminDb(getString(args, "db"));
  if (handle) {
    try {
      const updated = updateTokenMeta(handle.raw, tokenId, { name, note });
      if (json) {
        out.data(tokenToJson(updated));
        return ExitCode.OK;
      }
      out.line(`${style.green("✓")} token ${describeTokenRef(tokenId)} updated`);
      return ExitCode.OK;
    } finally {
      handle.raw.close();
    }
  }

  const remote = openRemoteAdmin(args, json);
  const data = (await remote.call(`/tokens/${encodeURIComponent(tokenId)}`, {
    method: "PATCH",
    body: JSON.stringify({ name, note }),
  })) as Record<string, unknown>;
  if (json) {
    out.data(data);
    return ExitCode.OK;
  }
  out.line(`${style.green("✓")} token ${describeTokenRef(tokenId)} updated`);
  return ExitCode.OK;
}

/** 构造远程 admin 调用器（需要配置里有 server + 管理员 token） */
function openRemoteAdmin(
  args: { options: Record<string, string | boolean> },
  _json: boolean,
): RemoteAdmin {
  const ctx = openCtx({
    server: getString(args as never, "server"),
    project: getString(args as never, "project"),
    key: getString(args as never, "key"),
  });
  if (ctx.backend.mode !== "remote") {
    closeCtx(ctx);
    throw KanbanError.usage(
      "a remote server and an admin token are required",
      "Two ways:\n" +
        "  1. Direct connection on the machine hosting the server: agent-kanban admin token create --db /path/to/server.db ...\n" +
        "  2. Via the API from any machine:\n" +
        "     kanban --server https://kanban.corp --key <admin-token> admin token create ...",
    );
  }
  return new RemoteAdmin(ctx);
}
