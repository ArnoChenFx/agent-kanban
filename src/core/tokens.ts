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
import { withTx, type TxContext } from "./tx.ts";
import { KanbanError } from "./errors.ts";
import { getProject, validateProjectKey } from "./projects.ts";

/** token 角色 */
export type TokenRole = "project" | "admin";

/** token 领域对象 */
export interface AccessToken {
  /**
   * token 的引用标识（`t_` + 32 hex），**不是密钥本身**。
   *
   * ⚠ 曾经这里是**明文 key 本身**（`const id = plaintext;`），
   *   而文件头与 schema.sql 都写着「库里只存 key_hash」——于是任何能读到
   *   kanban.db 的人（备份、export 产物、误提交、只读挂载的运维脚本）
   *   都拿到全部在用的 token。现在 id 是独立的随机值，鉴权一律走 key_hash。
   *
   * 它是 admin API 的寻址依据（`/api/admin/tokens/:id/...`），所以可以安全地
   * 显示在界面与日志里。
   */
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

/** token 前缀（**密钥**用这个） */
export const TOKEN_PREFIX = "k_";

/** token 引用前缀（**非密钥**，是 admin API 的寻址依据） */
export const TOKEN_REF_PREFIX = "t_";

/** 生成 token 明文：k_ + 32 hex（128 bit 熵） */
export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(16).toString("hex");
}

/**
 * 生成 token 引用（库里存的那一列）：`t_` + 32 hex。
 *
 * 为什么需要它：明文不能进库，但 admin 界面需要一个稳定的句柄去
 * 「吊销这个 token」「改它的白名单」。这个引用不承担鉴权职责
 * （鉴权一律按 key_hash 查），所以它可以明晃晃地显示。
 */
export function generateTokenRef(): string {
  return TOKEN_REF_PREFIX + randomBytes(16).toString("hex");
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

/**
 * 在写事务里执行一次 token / project 变更，并记一条**审计**事件。
 *
 * ## 为什么这两类东西要包事务
 *
 * ADR-1 的核心不变量是「改投影 + 写事件在同一事务里」，而 tokens / projects
 * 曾经是**裸 db.query**：无事务、无事件。后果不是「数据错了」而是
 * 「没人知道发生过」——吊销了一个 token，事件流里没有痕迹；
 * 改了白名单，那次变更无法回溯。
 *
 * 用法：`auditWrite(db, now, (ctx) => { /* 改 *\/ ctx.emit({...}) })`
 * ——mutation 与 emit 都在同一个 BEGIN IMMEDIATE 里，所以不会出现
 * 「改了但没记」或「记了但没改」的中间态。
 *
 * ## 为什么事件只是审计，不是 rebuild 的输入
 *
 * 见 `types.ts` 里 `EVENT_TYPES` 下方那段注释：`key_hash` 不能进事件流
 * （事件表会被 export / 备份 / 重放），而 `rebuild --write` 也不能拿
 * 一条缺哈希的事件去重建 token 行。
 *
 * `projectKey` 固定用 `"system"`：一个 admin token 可以跨全部 project，
 * 一个 project 级的也可能同时管几个，归属不到某一个看板——与
 * `session_*` 事件同一个理由。
 */
function auditWrite<T>(db: Database, now: number, fn: (ctx: TxContext) => T): T {
  return withTx(db, fn, { now: () => now, sessionId: "system", projectKey: "system" });
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
      "a project-scoped token must authorize at least one project",
      "Usage: agent-kanban admin token create --project demo-app --project web-app\nUse --role admin for an admin token",
      { reason: "token_requires_project" },
    );
  }
  if (input.role === "admin" && projects.length > 0) {
    throw KanbanError.usage(
      "an admin token already has full access to every project, so it cannot be given a project list",
      "Drop the --project argument, or use --role project instead",
      { reason: "admin_token_with_projects" },
    );
  }

  const plaintext = generateToken();
  // ⚠ 库里存的必须是**引用**，不是明文。见 AccessToken.id 的说明。
  const id = generateTokenRef();
  const keyHash = hashToken(plaintext);
  const expiresAt = input.expiresInMs ? now + input.expiresInMs : null;

  // INSERT 与审计事件在同一事务：不会出现「发了 token 但没记」或反之。
  // ⚠ 事件里**不写 key / key_hash**（见 auditWrite 的注释）
  auditWrite(db, now, (ctx) => {
    ctx.db
      .query(
        `INSERT INTO tokens (id, name, role, projects, key_hash, created_at, created_by, last_used_at,
                              revoked_at, expires_at, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      )
      .run(
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
    ctx.emit({
      type: "token_issued",
      projectKey: "system",
      sessionId: "system",
      data: {
        token_ref: id,
        role: input.role,
        projects,
        name: input.name ?? null,
        expires_at: expiresAt,
        by: input.createdBy ?? null,
      },
    });
  });

  return {
    token: toToken(
      db.query<TokenRow, [string]>("SELECT * FROM tokens WHERE id = ?").get(id)!,
    ),
    plaintext,
  };
}

/** 按 id（= 引用）取 token。仅供 admin API 寻址，**不能用来鉴权**。 */
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
    throw KanbanError.state(`token not found: ${describeTokenRef(tokenId)}`, {
      reason: "token_not_found",
      token: describeTokenRef(tokenId),
      hint: "Run `agent-kanban admin token list` to see the existing tokens",
    });
  }
  if (token.role === "admin") {
    throw KanbanError.usage(
      "the scope of an admin token cannot be restricted (it has access to every project)",
      undefined,
      { reason: "admin_token_scope_fixed" },
    );
  }
  const validated = projects.map((p) => validateProjectKey(p));
  if (validated.length === 0) {
    throw KanbanError.usage(
      "a project-scoped token must keep at least one project (or revoke the token instead)",
      undefined,
      { reason: "token_requires_project" },
    );
  }
  // 白名单变更：UPDATE 与审计事件在同一事务（只记引用与新范围，不记 token）
  auditWrite(db, now, (ctx) => {
    ctx.db.query("UPDATE tokens SET projects = ? WHERE id = ?").run(JSON.stringify(validated), tokenId);
    ctx.emit({
      type: "token_updated",
      projectKey: "system",
      sessionId: "system",
      data: { token_ref: tokenId, field: "projects", value: validated },
    });
  });
  return getToken(db, tokenId)!;
}

/** 吊销 token（不可恢复，只能新建） */
export function revokeToken(db: Database, tokenId: string, now: number = Date.now()): AccessToken {
  const token = getToken(db, tokenId);
  if (!token) {
    throw KanbanError.state(`token not found: ${describeTokenRef(tokenId)}`, {
      reason: "token_not_found",
      token: describeTokenRef(tokenId),
    });
  }
  if (token.revokedAt !== null) {
    throw KanbanError.state(`token already revoked (${new Date(token.revokedAt).toISOString()})`, {
      reason: "token_already_revoked",
      token: describeTokenRef(tokenId),
      hint: "Revoking cannot be undone; issue a new token if you need access back",
    });
  }
  // 吊销是安全事件，必须有痕迹：UPDATE 与审计事件在同一事务
  auditWrite(db, now, (ctx) => {
    ctx.db.query("UPDATE tokens SET revoked_at = ? WHERE id = ?").run(now, tokenId);
    ctx.emit({
      type: "token_revoked",
      projectKey: "system",
      sessionId: "system",
      data: { token_ref: tokenId, role: token.role, projects: token.projects },
    });
  });
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
  if (!token) {
    throw KanbanError.state(`token not found: ${describeTokenRef(tokenId)}`, {
      reason: "token_not_found",
      token: describeTokenRef(tokenId),
    });
  }

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
  // 元信息变更的审计（名字/备注/有效期）。与上面三条 UPDATE 同事务。
  auditWrite(db, now, (ctx) => {
    const changed: string[] = [];
    if (patch.name !== undefined) changed.push("name");
    if (patch.note !== undefined) changed.push("note");
    if (patch.expiresAtMs !== undefined) changed.push("expires_at");
    if (changed.length === 0) return;
    ctx.emit({
      type: "token_updated",
      projectKey: "system",
      sessionId: "system",
      data: { token_ref: tokenId, field: changed.join(","), role: token.role },
    });
  });
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

  // ⚠ **只按 key_hash 查**。库里不存明文（见 issueToken），所以拿明文去匹配 id
  //   是不可能的；而反过来若先按 id 查，就会出现「拿 token 的**引用**也能鉴权」
  //   ——引用是给 admin 界面寻址用的，不是凭据。
  //
  //   「id 与 key 不一致的旧数据」那条兼容分支已删：旧行的 key_hash 本来就是对的，
  //   所以旧 token **继续可用**——这就是本改动不需要迁移的原因。
  const row = db
    .query<TokenRow, [string]>("SELECT * FROM tokens WHERE key_hash = ?")
    .get(hashToken(tokenId));
  if (!row) return { ok: false, reason: "invalid" };
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
  // result.tokenId 是**引用**（t_…），不是密钥，直接显示有助于排查
  const tokenLabel = result.tokenId ? describeTokenRef(result.tokenId) : "";

  switch (result.reason) {
    case "missing":
      return new KanbanError(7, "AUTH", "missing access token", {
        reason: "auth_token_missing",
        hint:
          "This project runs in remote mode; three ways to configure the token:\n" +
          "  1. Edit server.token in .kanban/config.toml\n" +
          "  2. Set the KANBAN_KEY environment variable\n" +
          "  3. Pass --key k_xxx on the command line\n" +
          "Tokens are issued by an admin: agent-kanban admin token create --project <key>",
      });

    case "revoked":
      return new KanbanError(7, "AUTH", `token has been revoked (${tokenLabel})`, {
        reason: "auth_token_revoked",
        token: tokenLabel,
        hint: "Revoking cannot be undone, ask an admin to issue a new token",
      });

    case "expired":
      return new KanbanError(7, "AUTH", `token has expired (${tokenLabel})`, {
        reason: "auth_token_expired",
        token: tokenLabel,
        hint: "Ask an admin to issue a new token, or adjust the expiry",
      });

    case "invalid":
      return new KanbanError(7, "AUTH", "invalid token", {
        reason: "auth_token_invalid",
        token: tokenLabel,
        hint:
          "Check whether the token was mistyped or truncated; run `agent-kanban config show` to see where the effective token comes from " +
          "(CLI > environment variable > .kanban/config.toml). When it is not set, store one with `agent-kanban config set server.token <token>`.",
      });

    case "forbidden":
    default:
      // 故意不区分"project 不存在"与"无权限"：区分开等于泄漏 project 是否存在
      return new KanbanError(7, "AUTH", "this token is not allowed to access the project", {
        reason: "auth_project_forbidden",
        project: projectKey,
        token: tokenLabel,
        hint: "The current token is not scoped to that project. Ask an admin to run:\n" +
          "  agent-kanban admin token grant <token> --project <key>\n" +
          "or use an admin token instead:\n" +
          "  kanban --key <admin-token> task list",
      });
  }
}

/**
 * 掩码**密钥**（`k_…`）：避免在日志/admin 列表里泄漏完整 token。
 *
 * ⚠ 只对密钥用。token 的**引用**（`t_…`）不承担鉴权职责，可以直接显示——
 *   曾经 admin 页把掩码后的 id 发回给 `/api/admin/tokens/:id/revoke`，
 *   于是「吊销」与「移除授权」两个按钮 100% 失败（见 tokenToJson）。
 */
export function maskToken(tokenId: string): string {
  if (!tokenId.startsWith(TOKEN_PREFIX) || tokenId.length <= 12) {
    return tokenId.slice(0, 4) + "…";
  }
  return `${tokenId.slice(0, 6)}…${tokenId.slice(-4)}`;
}

/**
 * 回显一个 token 标识（引用或密钥）到错误信息里。
 *
 * 规则：**看着像密钥（`k_` 开头）就掩码，否则原样显示。**
 * 因为 admin API 的 `:id` 段理论上该收引用，但如果有人误把密钥塞进去，
 * 原样回显就会把它写进日志与浏览器控制台。
 */
export function describeTokenRef(value: string): string {
  return value.startsWith(TOKEN_PREFIX) ? maskToken(value) : value;
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
    // 引用不是密钥，直接给全——admin 界面要靠它做吊销/改白名单，掩码了就用不了。
    // （曾经这里返回 maskToken(id)，而那时 id 就是明文密钥；
    //   改成引用后如果还掩码，admin 页的按钮会继续 100% 失败。）
    id: token.id,
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
    throw KanbanError.state(`project not found: ${missing.join(", ")}`, {
      reason: "project_not_found",
      missing,
      hint: `Create it first: agent-kanban admin project add ${missing[0]}\n` +
        "(you can also issue the token up front to pre-authorize, then create the project later)",
    });
  }
}
