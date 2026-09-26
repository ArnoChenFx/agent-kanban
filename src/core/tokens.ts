/**
 * Token 领域逻辑与鉴权（ADR-13）。
 *
 * 权限模型（用户需求）：
 * - **项目级 token**：可查看/修改其白名单内的 project 与任务。
 *   一个 token 可授权多个 project，由管理员设置。
 * - **管理员 token**：可管理 project、签发/吊销 token、查看所有 project 的任务。
 * - server 首次启动必须有一个管理员 token。
 *
 * 设计要点：
 * 1. **库里只存哈希**，明文只在签发/轮换时返回一次。
 * 2. **401 vs 403 分工**：401 = token 无效/不存在/已吊销（调用方该去拿新 token）；
 *    403 = token 有效但无权访问该 project（调用方该换 token 或换 project）。
 *    两者不混淆，agent 能据此决定"重试"还是"改配置"。
 * 3. **不泄漏 project 是否存在**：对不存在的 project 与无权的 project 返回同样的 403。
 * 4. token 可以授权"当前不存在的 project"（预授权），admin 建完 project 即生效——
 *    这在"先发 token 再建 project"的运维顺序下很实用。
 */

import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { KanbanError } from "./errors.ts";
import { getProject, validateProjectKey } from "./projects.ts";

/** token 角色 */
export type TokenRole = "project" | "admin";

/** token 领域对象 */
export interface AccessToken {
  /** token id（k_ + 32 hex）。注意：这也是**明文** key 的一部分，
   *  但库里只存 hash；此字段仅在"刚签发"时可得 */
  id: string;
  /** 人类可读名（admin 界面与审计用） */
  name: string | null;
  role: TokenRole;
  /** role=project 时的 project 白名单 */
  projects: string[];
  /** SHA-256 十六进制哈希（不带前缀） */
  keyHash: string;
  createdAt: number;
  createdBy: string | null;
  lastUsedAt: number | null;
  /** 吊销时间；非空则不可用 */
  revokedAt: number | null;
  /** 过期时间；非空且已过则不可用 */
  expiresAt: number | null;
  note: string | null;
}

/** 鉴权结果 */
export type AuthResult =
  | { ok: true; token: AccessToken; role: TokenRole }
  | { ok: false; reason: "missing" | "invalid" | "revoked" | "expired" | "forbidden"; tokenId?: string };

/** token 前缀 */
export const TOKEN_PREFIX = "k_";

/** 生成 token 明文：k_ + 32 hex（128 bit 熵） */
export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(16).toString("hex");
}

/** 计算 token 哈希（SHA-256 十六进制） */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** 数据库行形状 */
interface TokenRow {
  id: string;
  name: string | null;
  role: string;
  projects: string | null;
  key_hash: string;
  created_at: number;
  created_by: string | null;
  last_used_at: number | null;
  revoked_at: number | null;
  expires_at: number | null;
  note: string | null;
}

function toToken(row: TokenRow): AccessToken {
  return {
    id: row.id,
    name: row.name,
    role: row.role as TokenRole,
    projects: parseProjects(row.projects),
    keyHash: row.key_hash,
    createdAt: row.created_at,
    createdBy: row.created_by,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    expiresAt: row.expires_at,
    note: row.note,
  };
}

function parseProjects(text: string | null): string[] {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

// =============================================================================
// 签发与查询
// =============================================================================

export interface IssueTokenInput {
  role: TokenRole;
  /** role=project 时必填：授权的 project 白名单 */
  projects?: string[];
  name?: string | null;
  note?: string | null;
  /** 有效期（毫秒），不传 = 永不过期 */
  expiresInMs?: number | null;
  /** 由谁签发（审计） */
  createdBy?: string | null;
}

/** 签发结果：token 对象 + **明文 key（只此一次可见）** */
export interface IssuedToken {
  token: AccessToken;
  /** 明文 key；**只在创建时可得**，库里不存 */
  plaintext: string;
}

/** 签发新 token */
export function issueToken(
  db: Database,
  input: IssueTokenInput,
  now: number = Date.now(),
): IssuedToken {
  // ---- 参数校验（白名单里的 project key 必须合法）----
  const projects = (input.projects ?? []).map((p) => validateProjectKey(p));
  if (input.role === "project" && projects.length === 0) {
    throw KanbanError.usage(
      "项目级 token 必须至少授权一个 project",
      '用法：kanban admin token create --project demo-app --project web-app\n管理员 token 用 --role admin',
    );
  }
  if (input.role === "admin" && projects.length > 0) {
    throw KanbanError.usage(
      "管理员 token 天然拥有全部 project 权限，不能指定 project 列表",
      "去掉 --project 参数，或改用 --role project",
    );
  }

  const plaintext = generateToken();
  const id = plaintext; // token 的 id 就是 key 本身（便于用 key 直接查）
  const keyHash = hashToken(plaintext);
  const expiresAt = input.expiresInMs ? now + input.expiresInMs : null;

  db.query(
    `INSERT INTO tokens (id, name, role, projects, key_hash, created_at, created_by, last_used_at,
                          revoked_at, expires_at, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
  ).run(
    id,
    input.name ?? null,
    input.role,
    JSON.stringify(projects),
    keyHash,
    now,
    input.createdBy ?? null,
    expiresAt,
    input.note ?? null,
  );

  return {
    token: toToken(
      db.query<TokenRow, [string]>("SELECT * FROM tokens WHERE id = ?").get(id)!,
    ),
    plaintext,
  };
}

/** 按 id（= key）取 token */
export function getToken(db: Database, tokenId: string): AccessToken | null {
  const row = db.query<TokenRow, [string]>("SELECT * FROM tokens WHERE id = ?").get(tokenId);
  return row ? toToken(row) : null;
}

/** 列出 token（不返回明文——库里也没有） */
export function listTokens(
  db: Database,
  opts: { role?: TokenRole; includeRevoked?: boolean } = {},
): AccessToken[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.role) {
    where.push("role = ?");
    params.push(opts.role);
  }
  if (!opts.includeRevoked) where.push("revoked_at IS NULL");
  const sql = `SELECT * FROM tokens ${where.length > 0 ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC`;
  return db
    .query<TokenRow, Array<string | number>>(sql)
    .all(...(params as string[]))
    .map(toToken);
}

/** 修改 token 的 project 白名单（admin 操作） */
export function updateTokenProjects(
  db: Database,
  tokenId: string,
  projects: string[],
  now: number = Date.now(),
): AccessToken {
  const token = getToken(db, tokenId);
  if (!token) {
    throw KanbanError.state(`token 不存在：${maskToken(tokenId)}`, {
      token: maskToken(tokenId),
      hint: "用 `kanban admin token list` 查看现有 token",
    });
  }
  if (token.role === "admin") {
    throw KanbanError.usage("管理员 token 的权限不可限制（它拥有全部 project）");
  }
  const validated = projects.map((p) => validateProjectKey(p));
  if (validated.length === 0) {
    throw KanbanError.usage("项目级 token 至少要保留一个 project（或直接吊销该 token）");
  }
  db.query("UPDATE tokens SET projects = ? WHERE id = ?").run(JSON.stringify(validated), tokenId);
  void now;
  return getToken(db, tokenId)!;
}

/** 吊销 token（不可恢复，只能新建） */
export function revokeToken(db: Database, tokenId: string, now: number = Date.now()): AccessToken {
  const token = getToken(db, tokenId);
  if (!token) {
    throw KanbanError.state(`token 不存在：${maskToken(tokenId)}`);
  }
  if (token.revokedAt !== null) {
    throw KanbanError.state(`token 已被吊销（${new Date(token.revokedAt).toISOString()}）`, {
      token: maskToken(tokenId),
      hint: "吊销不可恢复；如需恢复访问请签发新 token",
    });
  }
  db.query("UPDATE tokens SET revoked_at = ? WHERE id = ?").run(now, tokenId);
  return getToken(db, tokenId)!;
}

/** 修改 token 元信息（名称/备注/有效期） */
export function updateTokenMeta(
  db: Database,
  tokenId: string,
  patch: { name?: string | null; note?: string | null; expiresAtMs?: number | null },
  now: number = Date.now(),
): AccessToken {
  const token = getToken(db, tokenId);
  if (!token) throw KanbanError.state(`token 不存在：${maskToken(tokenId)}`);

  if (patch.name !== undefined) {
    db.query("UPDATE tokens SET name = ? WHERE id = ?").run(patch.name, tokenId);
  }
  if (patch.note !== undefined) {
    db.query("UPDATE tokens SET note = ? WHERE id = ?").run(patch.note, tokenId);
  }
  if (patch.expiresAtMs !== undefined) {
    const expiresAt = patch.expiresAtMs === null ? null : now + patch.expiresAtMs;
    db.query("UPDATE tokens SET expires_at = ? WHERE id = ?").run(expiresAt, tokenId);
  }
  return getToken(db, tokenId)!;
}

/**
 * 记录 token 使用（审计 + 闲置检测）。
 * 单独写而非放在鉴权路径里：鉴权是热路径，每请求一次 UPDATE 会明显拖慢 server。
 * 改为按"每分钟最多更新一次"节流。
 */
export function touchToken(db: Database, tokenId: string, now: number = Date.now()): void {
  const row = db.query<{ last_used_at: number | null }, [string]>(
    "SELECT last_used_at FROM tokens WHERE id = ?",
  ).get(tokenId);
  if (!row) return;
  if (row.last_used_at !== null && now - row.last_used_at < 60_000) return;
  db.query("UPDATE tokens SET last_used_at = ? WHERE id = ?").run(now, tokenId);
}

// =============================================================================
// 鉴权
// =============================================================================

/**
 * 鉴权：校验 token 并检查它是否有权访问目标 project。
 *
 * @param tokenId 请求携带的 token（X-Kanban-Key 头或 ?key=）
 * @param projectKey 目标 project
 * @returns ok=true 时 role 决定权限范围
 */
export function authenticate(
  db: Database,
  tokenId: string | undefined | null,
  projectKey: string,
  now: number = Date.now(),
): AuthResult {
  return authenticateInternal(db, tokenId, projectKey, now, true);
}

/**
 * 只验证 token 本身（**不**校验 project 权限）。
 *
 * 场景：`GET /api/projects` —— 客户端刚拿到 token、还不知道自己能看哪些 project，
 * 这时根本没有“目标 project”可校验。之前的实现里这个端点被 project 参数检查
 * 挡在前面，导致前端永远拿不到 project 列表。
 *
 * 注意：返回的 role 仍可用于后续决定（admin 看全部，project 看白名单）。
 */
export function authenticateTokenOnly(
  db: Database,
  tokenId: string | undefined | null,
  now: number = Date.now(),
): AuthResult {
  return authenticateInternal(db, tokenId, "", now, false);
}

function authenticateInternal(
  db: Database,
  tokenId: string | undefined | null,
  projectKey: string,
  now: number,
  checkProject: boolean,
): AuthResult {
  if (!tokenId || tokenId.length === 0) return { ok: false, reason: "missing" };

  const row = db.query<TokenRow, [string]>("SELECT * FROM tokens WHERE id = ?").get(tokenId);
  if (!row) {
    // 用哈希兜底查：兼容"id 与 key 不一致"的旧数据
    const byHash = db
      .query<TokenRow, [string]>("SELECT * FROM tokens WHERE key_hash = ?")
      .get(hashToken(tokenId));
    if (!byHash) return { ok: false, reason: "invalid" };
    return evaluate(byHash, projectKey, now, checkProject);
  }
  return evaluate(row, projectKey, now, checkProject);
}

function evaluate(
  row: TokenRow,
  projectKey: string,
  now: number,
  checkProject = true,
): AuthResult {
  const token = toToken(row);

  // 已吊销
  if (token.revokedAt !== null) return { ok: false, reason: "revoked", tokenId: token.id };

  // 已过期
  if (token.expiresAt !== null && now >= token.expiresAt) {
    return { ok: false, reason: "expired", tokenId: token.id };
  }

  // 管理员：放行全部 project
  if (token.role === "admin") return { ok: true, token, role: "admin" };

  // 项目级：必须在白名单里
  // checkProject=false 时跳过（调用方还没决定看哪个 project）
  if (checkProject && !token.projects.includes(projectKey)) {
    return { ok: false, reason: "forbidden", tokenId: token.id };
  }
  return { ok: true, token, role: "project" };
}

/** 鉴权失败 → HTTP 错误（401 无效 / 403 无权） */
export function authFailure(result: Extract<AuthResult, { ok: false }>, projectKey?: string): KanbanError {
  const tokenLabel = result.tokenId ? maskToken(result.tokenId) : "";

  switch (result.reason) {
    case "missing":
      return new KanbanError(7, "AUTH", "缺少访问 token", {
        hint:
          "本项目在远程模式下，配置 token 的方式（三选一）：\n" +
          "  1. 编辑 .kanban/config.toml 的 server.token\n" +
          "  2. 设置环境变量 KANBAN_KEY\n" +
          "  3. 命令行临时指定 --key k_xxx\n" +
          "token 由管理员签发：kanban admin token create --project <key>",
      });

    case "revoked":
      return new KanbanError(7, "AUTH", `token 已被吊销（${tokenLabel}）`, {
        token: tokenLabel,
        hint: "吊销不可恢复，请找管理员签发新 token",
      });

    case "expired":
      return new KanbanError(7, "AUTH", `token 已过期（${tokenLabel}）`, {
        token: tokenLabel,
        hint: "请找管理员签发新 token，或调整有效期",
      });

    case "invalid":
      return new KanbanError(7, "AUTH", "token 无效", {
        token: tokenLabel,
        hint:
          "确认 token 是否输错/被截断；用 `kanban config show` 看当前生效的 token 来自哪里" +
          "（CLI > 环境变量 > .kanban/config.toml）。未配置时用 `kanban config set server.token <token>` 保存。",
      });

    case "forbidden":
    default:
      // 故意不区分"project 不存在"与"无权限"：区分开等于泄漏 project 是否存在
      return new KanbanError(7, "AUTH", "token 无权访问该项目", {
        project: projectKey,
        token: tokenLabel,
        hint: "当前 token 的授权范围不包含该项目。请管理员执行：\n" +
          "  kanban admin token grant <token> --project <key>\n" +
          "或用管理员 token 操作：\n" +
          "  kanban --key <admin-token> task list",
      });
  }
}

/** 掩码 token：k_1a2b…（避免在日志/admin 列表里泄漏完整 token） */
export function maskToken(tokenId: string): string {
  if (!tokenId.startsWith(TOKEN_PREFIX) || tokenId.length <= 12) {
    return tokenId.slice(0, 4) + "…";
  }
  return `${tokenId.slice(0, 6)}…${tokenId.slice(-4)}`;
}

/** token → 对外 JSON（admin 列表/界面用；不含明文 key） */
export function tokenToJson(token: AccessToken, now: number = Date.now()): Record<string, unknown> {
  const status =
    token.revokedAt !== null
      ? "revoked"
      : token.expiresAt !== null && now >= token.expiresAt
        ? "expired"
        : "active";
  return {
    id: maskToken(token.id),
    name: token.name,
    role: token.role,
    // 项目级 token 才有限制；admin 为 null 表示"全部"
    projects: token.role === "admin" ? null : token.projects,
    status,
    created_at: token.createdAt,
    created_by: token.createdBy,
    last_used_at: token.lastUsedAt,
    revoked_at: token.revokedAt,
    expires_at: token.expiresAt,
    note: token.note,
  };
}

/** 该 project 是否至少有一个可用 token（admin 删除 project 前检查） */
export function projectHasTokens(db: Database, projectKey: string): boolean {
  const row = db
    .query<{ c: number }, []>(
      "SELECT COUNT(*) AS c FROM tokens WHERE revoked_at IS NULL",
    )
    .get();
  if (!row || row.c === 0) return false;
  // 白名单包含该 project 的 token
  const tokens = listTokens(db, { role: "project" });
  return tokens.some((t) => t.projects.includes(projectKey));
}

/** 校验 project 存在（admin 建 token 时给出更好提示，但不强制——
 *  允许"预授权"：先发 token 再建 project 也能用） */
export function assertProjectExistsForToken(db: Database, projectKeys: string[]): void {
  const missing = projectKeys.filter((k) => !getProject(db, k));
  if (missing.length > 0) {
    throw KanbanError.state(`project 不存在：${missing.join(", ")}`, {
      missing,
      hint: `先创建：kanban admin project add ${missing[0]}\n` +
        "（也可以先签发 token 预授权，之后再建 project）",
    });
  }
}
