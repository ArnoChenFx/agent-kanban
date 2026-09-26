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
import { padEndWidth, relativeTime, style } from "../core/format.ts";
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
  maskToken,
  revokeToken,
  tokenToJson,
  updateTokenMeta,
  updateTokenProjects,
  type AccessToken,
  type TokenRole,
} from "../core/tokens.ts";
import { projectInfoForCli } from "./project.ts";
import { assertKnownOptions, getBool, getList, getString, parseArgs, requirePositional } from "./args.ts";
import { closeCtx, openCtx, type Ctx } from "./context.ts";
import { createOutput } from "./output.ts";
import { RemoteBackend } from "../core/backend-remote.ts";

const USAGE = `用法：agent-kanban admin <子命令>

  project list                     列出所有 project
  project add <key> [--name N]     新建 project
  project delete <key> [--force]   删除 project（会连带删任务，不可恢复）
  project rename <key> --name N    重命名

  token list [--all]               列出 token（默认只列未吊销）
  token create --project A [--project B] [--role project|admin]
                [--name N] [--note N] [--expires-in 30d]
  token grant <token> --project A  给已有 token 增加 project 授权
  token revoke <token>             吊销 token（不可恢复）
  token rename <token> --name N    修改 token 名称/备注

说明：
  · 管理操作需要**管理员 token**；未配置时用 server 的 .kanban/config.toml 里的 admin_token
  · token 明文只在 create 时显示一次
  · 在 server 所在机器上可加 --db <server库路径> 直连操作（不走 HTTP）

示例：
  agent-kanban admin project add demo-app --name "演示项目"
  agent-kanban admin token create --project demo-app --name "CI 专用"
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
      throw KanbanError.usage(`未知子命令：admin ${group}`, USAGE);
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

  private get server(): string {
    return (this.ctx.backend as unknown as { server: string }).server;
  }

  token(): string {
    return this.ctx.effectiveConfig.token ?? "";
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
        `未知子命令：admin project ${sub ?? ""}`,
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
        out.line("（还没有 project）用 `agent-kanban admin project add <key>` 创建");
        return ExitCode.OK;
      }
      out.line(`project（${rows.length}）`.padEnd(8) + "名称".padEnd(22) + "任务".padEnd(8) + "token".padEnd(8) + "创建于");
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
  out.line(`project（${data.length}）`.padEnd(8) + "名称".padEnd(22) + "任务".padEnd(8) + "token");
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
  const json = getBool(args, "json");
  const out = createOutput(json);
  const key = requirePositional(args, 0, "project key", "用法：agent-kanban admin project add <key> [--name <名称>]");

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
      out.line(`${style.green("✓")} project 已创建：${style.cyan(project.key)}  ${project.name}`);
      out.line("");
      out.line(style.gray("下一步：签发访问 token"));
      out.line(`  agent-kanban admin token create --project ${project.key} --name "团队 token"`);
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
  out.line(`${style.green("✓")} project 已创建：${style.cyan(String(data.key))}  ${data.name}`);
  out.line("");
  out.line(style.gray("下一步：签发访问 token"));
  out.line(`  agent-kanban admin token create --project ${key} --name "团队 token"`);
  return ExitCode.OK;
}

async function projectDelete(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "help", "force"],
    strings: ["db", "server", "project", "key"],
    short: { j: "json", h: "help", f: "force" },
  });
  assertKnownOptions(args, ["json", "help", "force", "db", "server", "project", "key"]);
  const json = getBool(args, "json");
  const out = createOutput(json);
  const key = requirePositional(args, 0, "project key", "用法：agent-kanban admin project delete <key> --force");

  const handle = openAdminDb(getString(args, "db"));
  if (handle) {
    try {
      const existing = getProject(handle.raw, key);
      if (!existing) throw KanbanError.state(`project 不存在：${key}`);
      const taskCount =
        handle.raw
          .query<{ c: number }, [string]>("SELECT COUNT(*) AS c FROM tasks WHERE project_key = ?")
          .get(key)?.c ?? 0;
      if (taskCount > 0 && !getBool(args, "force")) {
        throw KanbanError.state(
          `project "${key}" 下还有 ${taskCount} 个任务，删除不可恢复`,
          { task_count: taskCount, hint: "确认删除请加 --force" },
        );
      }
      deleteProject(handle.raw, key, getBool(args, "force"));
      if (json) {
        out.data({ ok: true, deleted: key, task_count: taskCount });
        return ExitCode.OK;
      }
      out.line(`${style.green("✓")} 已删除 project ${style.cyan(key)}（含 ${taskCount} 个任务）`);
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
  out.line(`${style.green("✓")} 已删除 project ${style.cyan(data.deleted)}`);
  return ExitCode.OK;
}

async function projectRename(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "help"],
    strings: ["name", "db", "server", "project", "key"],
    short: { j: "json", h: "help", n: "name" },
  });
  assertKnownOptions(args, ["json", "help", "name", "db", "server", "project", "key"]);
  const json = getBool(args, "json");
  const out = createOutput(json);
  const key = requirePositional(args, 0, "project key", "用法：agent-kanban admin project rename <key> --name <新名>");
  const name = getString(args, "name");
  if (!name) throw KanbanError.usage("缺少 --name", "用法：agent-kanban admin project rename <key> --name <新名>");

  const handle = openAdminDb(getString(args, "db"));
  if (handle) {
    try {
      const project = renameProject(handle.raw, key, name);
      if (json) {
        out.data(project);
        return ExitCode.OK;
      }
      out.line(`${style.green("✓")} ${style.cyan(project.key)} 重命名为 ${project.name}`);
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
    out.line(`${style.green("✓")} ${style.cyan(key)} 重命名为 ${name}`);
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
      throw KanbanError.usage(`未知子命令：admin token ${sub ?? ""}`, USAGE);
  }
}

async function tokenList(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "help", "all"],
    strings: ["role", "db", "server", "project", "key"],
    short: { j: "json", h: "help", a: "all" },
  });
  assertKnownOptions(args, ["json", "help", "all", "role", "db", "server", "project", "key"]);
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
        out.line("（还没有 token）用 `agent-kanban admin token create --project <key>` 签发");
        return ExitCode.OK;
      }
      out.line(
        `token（${tokens.length}）`.padEnd(20) + "名称".padEnd(18) + "角色".padEnd(10) +
          "授权 project".padEnd(24) + "状态".padEnd(10) + "最后使用",
      );
      for (const t of tokens) {
        const json2 = tokenToJson(t, now);
        out.line(
          padEndWidth(String(json2.id), 20) +
            padEndWidth(String(json2.name ?? "-"), 18) +
            padEndWidth(t.role === "admin" ? "管理员" : "项目级", 10) +
            padEndWidth(t.role === "admin" ? "全部" : t.projects.join(","), 24) +
            padEndWidth(String(json2.status), 10) +
            style.gray(t.lastUsedAt ? relativeTime(t.lastUsedAt, now) : "从未"),
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
  out.line(`token（${tokens.length}）`.padEnd(20) + "名称".padEnd(18) + "角色".padEnd(10) + "授权 project".padEnd(24) + "状态");
  for (const t of tokens) {
    const projects = t.role === "admin" ? "全部" : (t.projects as string[] | null)?.join(",") ?? "-";
    out.line(
      padEndWidth(String(t.id), 20) +
        padEndWidth(String(t.name ?? "-"), 18) +
        padEndWidth(t.role === "admin" ? "管理员" : "项目级", 10) +
        padEndWidth(projects, 24) +
        String(t.status),
    );
  }
  return ExitCode.OK;
}

/** 解析 --expires-in（如 30d / 12h / 7d）→ 毫秒 */
function parseExpiresIn(value: string | undefined): number | null {
  if (!value) return null;
  const m = /^(\d+)\s*([dhmsw])$/.exec(value.trim().toLowerCase());
  if (!m) {
    throw KanbanError.usage(`无法解析有效期 "${value}"`, "支持：30d（天）/ 12h / 7d / 4w（周）");
  }
  const n = Number(m[1]);
  switch (m[2]) {
    case "d": return n * 86_400_000;
    case "w": return n * 7 * 86_400_000;
    case "h": return n * 3_600_000;
    case "m": return n * 60_000;
    default: return n * 1000;
  }
}

async function tokenCreate(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "help"],
    strings: ["project", "name", "note", "role", "expires-in", "db", "server", "key"],
    short: { j: "json", h: "help", p: "project", n: "name", r: "role" },
  });
  assertKnownOptions(args, ["json", "help", "project", "name", "note", "role", "expires-in", "db", "server", "key"]);
  const json = getBool(args, "json");
  const out = createOutput(json);

  const role = (getString(args, "role") ?? "project") as TokenRole;
  if (role !== "project" && role !== "admin") {
    throw KanbanError.usage(`--role 只能是 project 或 admin，收到 "${role}"`);
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
    data = { ...tokenToJson(issued.token), token: issued.plaintext, warning: "此明文只显示这一次" };
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
  out.line(`${style.green("✓")} token 已签发`);
  if (name) out.line(`  名称    ${name}`);
  out.line(`  角色    ${role === "admin" ? "管理员（可访问全部 project）" : `项目级（${projects.join(", ")}）`}`);
  if (expiresInMs) {
    out.line(`  有效期  ${getString(args, "expires-in")}（${new Date(Date.now() + expiresInMs).toLocaleString("zh-CN")} 过期）`);
  }
  out.line("");
  out.line(`${style.yellow("token（只显示这一次，请立即保存）")}`);
  out.line(`  ${style.bold(String(data.token))}`);
  out.line("");
  if (role === "project") {
    out.line(style.gray("  写入客户端配置："));
    out.line(style.gray(`    agent-kanban config set server.token ${data.token}`));
    out.line(style.gray(`    （或编辑 .kanban/config.toml 的 server.token）`));
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
  const json = getBool(args, "json");
  const out = createOutput(json);
  const tokenId = requirePositional(args, 0, "token", "用法：agent-kanban admin token grant <token> --project <key>");
  const addProjects = getList(args, "project") ?? [];
  if (addProjects.length === 0) {
    throw KanbanError.usage(
      "缺少 --project",
      "用法：agent-kanban admin token grant <token> --project app1 --project app2\n" +
        "（--replace 表示替换整个白名单，而不是追加）",
    );
  }

  const handle = openAdminDb(getString(args, "db"));
  if (handle) {
    try {
      const token = getToken(handle.raw, tokenId);
      if (!token) throw KanbanError.state(`token 不存在：${maskToken(tokenId)}`);
      const next = getBool(args, "replace")
        ? addProjects
        : Array.from(new Set([...token.projects, ...addProjects]));
      const updated = updateTokenProjects(handle.raw, tokenId, next);
      if (json) {
        out.data(tokenToJson(updated));
        return ExitCode.OK;
      }
      out.line(`${style.green("✓")} token ${maskToken(tokenId)} 的授权已更新`);
      out.line(`  当前授权：${updated.projects.join(", ")}`);
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
  out.line(`${style.green("✓")} token ${maskToken(tokenId)} 的授权已更新`);
  out.line(`  当前授权：${(data.projects as string[]).join(", ")}`);
  return ExitCode.OK;
}

async function tokenRevoke(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "help", "yes"],
    strings: ["db", "server", "project", "key"],
    short: { j: "json", h: "help" },
  });
  assertKnownOptions(args, ["json", "help", "yes", "db", "server", "project", "key"]);
  const json = getBool(args, "json");
  const out = createOutput(json);
  const tokenId = requirePositional(args, 0, "token", "用法：agent-kanban admin token revoke <token>");

  const handle = openAdminDb(getString(args, "db"));
  if (handle) {
    try {
      const revoked = revokeToken(handle.raw, tokenId);
      if (json) {
        out.data(tokenToJson(revoked));
        return ExitCode.OK;
      }
      out.line(`${style.green("✓")} token ${maskToken(tokenId)} 已吊销（不可恢复）`);
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
  out.line(`${style.green("✓")} token ${maskToken(tokenId)} 已吊销（不可恢复）`);
  return ExitCode.OK;
}

async function tokenRename(argv: string[]): Promise<ExitCodeValue> {
  const args = parseArgs(argv, {
    booleans: ["json", "help"],
    strings: ["name", "note", "db", "server", "project", "key"],
    short: { j: "json", h: "help", n: "name" },
  });
  assertKnownOptions(args, ["json", "help", "name", "note", "db", "server", "project", "key"]);
  const json = getBool(args, "json");
  const out = createOutput(json);
  const tokenId = requirePositional(args, 0, "token", "用法：agent-kanban admin token rename <token> --name <新名>");
  const name = getString(args, "name");
  const note = getString(args, "note");
  if (!name && !note) {
    throw KanbanError.usage("缺少 --name 或 --note", "用法：agent-kanban admin token rename <token> --name <新名>");
  }

  const handle = openAdminDb(getString(args, "db"));
  if (handle) {
    try {
      const updated = updateTokenMeta(handle.raw, tokenId, { name, note });
      if (json) {
        out.data(tokenToJson(updated));
        return ExitCode.OK;
      }
      out.line(`${style.green("✓")} token ${maskToken(tokenId)} 已更新`);
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
  out.line(`${style.green("✓")} token ${maskToken(tokenId)} 已更新`);
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
      "需要指定远程 server 与管理员 token",
      "两种用法：\n" +
        "  1. 在 server 所在机器上直连：agent-kanban admin token create --db /path/to/server.db ...\n" +
        "  2. 从任意机器走 API：\n" +
        "     kanban --server https://kanban.corp --key <admin-token> admin token create ...",
    );
  }
  return new RemoteAdmin(ctx);
}
