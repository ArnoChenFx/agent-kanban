/**
 * 项目领域逻辑（ADR-9）：project 的创建、查找、鉴权密钥。
 *
 * 两种模式下的 project 解析策略：
 * - **本地模式**：`.kanban/` 目录对应**唯一一个** project，key 由目录名 slug 派生。
 *   用户永远不需要传 `--project`（ADR-9）。若库里已有 project 则复用。
 * - **远程模式**：project 由 `--project` / `KANBAN_PROJECT` 显式指定（ADR-12）。
 *   猜错 project 的代价（写到别人的看板上）远大于多打几个字，所以不按 cwd 猜。
 */

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { KanbanError } from "./errors.ts";
import { getMeta } from "./db.ts";
import { withTx } from "./tx.ts";

/** project 领域对象 */
export interface Project {
  key: string;
  name: string;
  rootPath: string | null;
  /** API key 的哈希；null = 本地模式不鉴权 */
  apiKeyHash: string | null;
  createdAt: number;
  defaultTtlMs: number | null;
  graceMs: number | null;
}

/**
 * 从任意字符串派生合法的 project key。
 * 规则：转小写 → 非字母数字替换为连字符 → 去除首尾连字符 → 最长 64 字符 → 空则 "default"。
 *
 * 例：
 *   "agent-kanban"  → "agent-kanban"
 *   "Agent Kanban!" → "agent-kanban"
 *   "我的项目"       → "default"（非 ASCII 全部被替换，剩下空串）
 */
export function slugifyProjectKey(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug.length > 0 ? slug : "default";
}

/** 校验 project key 格式，给出可操作的报错 */
export function validateProjectKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length === 0) {
    throw KanbanError.usage("project key must not be empty", "Example: --project agent-kanban");
  }
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(trimmed)) {
    throw KanbanError.usage(
      `invalid project key "${key}"`,
      "Only lowercase letters, digits and hyphens are allowed, and it must start with a letter or a digit, at most 64 characters.\n" +
        "Create it with `agent-kanban project add <key>`, or list the existing keys with `agent-kanban project list`",
      { reason: "invalid_project_key" },
    );
  }
  return trimmed;
}

/** 按 key 取 project；不存在返回 null */
export function getProject(db: Database, key: string): Project | null {  const row = db
    .query<ProjectRow, [string]>("SELECT * FROM projects WHERE key = ?")
    .get(key);
  return row ? toProject(row) : null;
}

/** 按 key 取 project；不存在抛 STATE(2)（"project 缺失"是状态错误，与"未初始化"是两回事） */
export function requireProject(db: Database, key: string): Project {
  const project = getProject(db, key);
  if (!project) {
    throw KanbanError.state(
      `project "${key}" not found`,
      {
        reason: "project_not_found",
        project: key,
        hint: "List the existing projects with `agent-kanban project list`; to create one run `agent-kanban project add <key>` on the server",
      },
    );
  }
  return project;
}

/** 列出所有 project */
export function listProjects(db: Database): Project[] {
  return db
    .query<ProjectRow, []>("SELECT * FROM projects ORDER BY created_at ASC")
    .all()
    .map(toProject);
}

/** 创建 project；已存在同名 key 时抛 STATE */
export function createProject(
  db: Database,
  input: { key: string; name?: string; rootPath?: string | null; apiKeyHash?: string | null; now?: number },
): Project {
  const key = validateProjectKey(input.key);
  if (getProject(db, key)) {
    throw KanbanError.state(`project "${key}" already exists`, {
      reason: "project_exists",
      project: key,
      hint: `To rotate its API key: agent-kanban project key ${key} --rotate`,
    });
  }
  // INSERT 与审计事件在同一事务（withTx 可重入：被包在调用方的事务里就加入它）。
  // ⚠ 事件里**不写 api_key_hash / 明文 key**（理由见 tokens.ts 的 auditWrite）
  //
  // projectKey 用 **这个 project 自己**而不是 "system"：它确实归属某个 project，
  // 这样它的审计事件会跟着那个 project 一起被 compact；
  // 丢进 'system' 桶就意味着永远不会被裁剪。
  withTx(
    db,
    (ctx) => {
      const now = ctx.now();
      ctx.db
        .query(
          `INSERT INTO projects (key, name, root_path, api_key_hash, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(key, input.name ?? key, input.rootPath ?? null, input.apiKeyHash ?? null, now);
      ctx.emit({
        type: "project_created",
        projectKey: key,
        sessionId: "system",
        data: { key, name: input.name ?? key, root_path: input.rootPath ?? null },
      });
    },
    { now: () => input.now ?? Date.now(), sessionId: "system", projectKey: key },
  );
  return requireProject(db, key);
}

/**
 * 解析本地模式应使用的 project。
 *
 * 规则：
 * 1. 库里只有一个 project → 直接用它
 * 2. 库里多个 project → 优先用 key 与目录名 slug 一致的那个
 * 3. 都没有 → 创建一个（name 取 meta.project_name 或目录名，api_key_hash=NULL 即不鉴权）
 *
 * 这是"本地用户零配置"的实现：任何 `agent-kanban task list` 都不需要知道 project 概念。
 */
export function resolveLocalProject(
  db: Database,
  opts: { rootPath: string; now?: number },
): Project {
  const existing = listProjects(db);
  const fromDir = slugifyProjectKey(basenameOf(opts.rootPath));

  if (existing.length === 1) return existing[0]!;

  const matched = existing.find((p) => p.key === fromDir);
  if (matched) return matched;

  // 一个都没有：创建本地默认 project
  const name = getMeta(db, "project_name") ?? basenameOf(opts.rootPath);
  return createProject(db, {
    key: fromDir,
    name,
    rootPath: opts.rootPath,
    // 本地模式不鉴权：api_key_hash 留空
    apiKeyHash: null,
    now: opts.now,
  });
}

/** 重命名 project（仅改显示名，key 不变——key 变了会破坏所有引用） */
export function renameProject(db: Database, key: string, name: string): Project {
  const project = requireProject(db, key);
  db.query("UPDATE projects SET name = ? WHERE key = ?").run(name, project.key);
  return requireProject(db, project.key);
}

/**
 * 删除 project 及其全部数据（tasks/events/plans/handoffs/deps）。
 *
 * 危险操作：任务与历史事件不可恢复。调用方必须先确认（CLI 层面检查 force）。
 * 顺带清理 token 白名单里对它的引用，避免留下失效授权。
 */
export function deleteProject(db: Database, key: string, force = false): { key: string; taskCount: number } {
  const project = getProject(db, key);
  if (!project) {
    throw KanbanError.state(`project not found: ${key}`, {
      reason: "project_not_found",
      project: key,
    });
  }
  const taskCount =
    db.query<{ c: number }, [string]>("SELECT COUNT(*) AS c FROM tasks WHERE project_key = ?").get(key)?.c ?? 0;
  if (taskCount > 0 && !force) {
    throw KanbanError.state(`project "${key}" still has ${taskCount} task(s), deleting it is not recoverable`, {
      reason: "project_not_empty",
      project: key,
      task_count: taskCount,
      hint: "Pass --force to confirm the deletion",
    });
  }

  return withTx(
    db,
    (tx) => {
      // task_deps 自 v4 起就带 project_key（老注释说没有是错的——按编号反查
      // 反而会误删别的 project 里同号卡的边，T 编号是 per-project 的）
      tx.db.query("DELETE FROM task_deps WHERE project_key = ?").run(key);
      for (const table of ["tasks", "events", "plans", "handoffs", "project_counters"]) {
        tx.db.query(`DELETE FROM ${table} WHERE project_key = ?`).run(key);
      }
      tx.db.query("DELETE FROM projects WHERE key = ?").run(key);
      tx.emit({
        type: "project_deleted",
        projectKey: "system",
        data: { key, task_count: taskCount },
        sessionId: "system",
      });
      return { key, taskCount };
    },
    { projectKey: "system" },
  );
}

/** project 行 → 领域对象 */
export interface ProjectRow {
  key: string;
  name: string;
  root_path: string | null;
  api_key_hash: string | null;
  created_at: number;
  default_ttl_ms: number | null;
  grace_ms: number | null;
}

function toProject(row: ProjectRow): Project {
  return {
    key: row.key,
    name: row.name,
    rootPath: row.root_path,
    apiKeyHash: row.api_key_hash,
    createdAt: row.created_at,
    defaultTtlMs: row.default_ttl_ms,
    graceMs: row.grace_ms,
  };
}

// =============================================================================
// per-project API key（ADR-11）
// =============================================================================

/** key 前缀，便于在日志与 UI 里一眼识别 */
export const API_KEY_PREFIX = "k_";

/** 生成新的 API key 明文：k_ + 32 hex（128 bit 熵） */
export function generateApiKey(randomBytes?: Uint8Array): string {
  const bytes = randomBytes ?? crypto.getRandomValues(new Uint8Array(16));
  return API_KEY_PREFIX + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 计算 key 的 SHA-256 十六进制哈希（库里只存哈希，不存明文）。
 *
 * 用 node:crypto 的同步接口而不是 WebCrypto：
 * WebCrypto 的 digest() 是异步的，而鉴权在请求处理的热路径上（每个请求都要算一次），
 * 异步会污染整个处理链；同步 API 更直白。
 * （实测 Bun 1.4 没有 crypto.subtle.digestSync 这个扩展，别指望它。）
 */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/**
 * 校验请求携带的 key 是否匹配该 project。
 *
 * 本地模式（api_key_hash 为空）：直接放行——调用方已经拥有文件系统权限，
 * 再要求 key 只是制造摩擦。
 */
export function verifyProjectKey(project: Project, provided: string | undefined | null): boolean {
  if (project.apiKeyHash === null || project.apiKeyHash === "") {
    return true; // 本地 project 不鉴权
  }
  if (!provided) return false;
  return hashApiKey(provided) === project.apiKeyHash;
}

/**
 * 鉴权失败时构造的���误（退出码 7）。
 *
 * 错误文案**故意不区分"key 错"与"project 不存在"**：
 * 区分开等于给 key 猜解提供了 oracle（枚举 project 名）。
 */
export function authError(projectKey: string | undefined): KanbanError {
  return new KanbanError(
    7,
    "AUTH",
    projectKey
      ? `the API key for project "${projectKey}" is missing or incorrect`
      : "remote mode requires both a project and an API key",
    {
      reason: "auth_failed",
      project: projectKey,
      hint:
        "How to set it (pick one, highest priority first):\n" +
        "  1. Command line: --project <key> --key k_xxx\n" +
        "  2. Environment variables: KANBAN_PROJECT / KANBAN_KEY\n" +
        "  3. Persisted: agent-kanban remote set <server> --project <key> --key k_xxx",
    },
  );
}

/** 轮换 project 的 API key，返回新 key 明文（只此一次可见） */
export function rotateApiKey(db: Database, projectKey: string, now?: number): { project: Project; apiKey: string } {
  const project = requireProject(db, projectKey);
  const apiKey = generateApiKey();
  db.query("UPDATE projects SET api_key_hash = ? WHERE key = ?").run(hashApiKey(apiKey), projectKey);
  void now;
  return { project: requireProject(db, projectKey), apiKey };
}

/** 跨平台的 basename（避免为一个函数引 node:path） */
function basenameOf(p: string): string {
  const normalized = p.replace(/[\\/]+$/, "");
  const idx = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}
