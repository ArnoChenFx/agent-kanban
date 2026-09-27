/**
 * HTTP + SSE server（Bun.serve）。
 *
 * 设计要点：
 * 1. **所有业务走 /api/op → executeOp**，server 端与本地端跑同一份 core（ADR-10）
 * 2. **token 鉴权**（ADR-13）：管理员 token 可访问全部 project，项目级 token 按白名单
 * 3. **SSE 按 project 隔离**：一个连接只收自己 project 的事件
 * 4. **默认只绑 127.0.0.1**：避免误把开发服务器暴露到公网
 * 5. 轮询而非 IPC 拉取事件：CLI（另一进程）写库时 serve 也能收到，实现最简且跨进程可靠
 * 6. **静态前端**：优先托管 `web/dist` 的构建产物，缺省退回内置占位页（会提示如何构建）
 */

import { existsSync, mkdirSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "bun:sqlite";
import { getConfig, migrate, openDb, type Db } from "../core/db.ts";
import { ExitCode, KanbanError, toKanbanError, type ExitCodeValue } from "../core/errors.ts";
import { findKanbanDirLoose, resolvePaths } from "../core/paths.ts";
import { clampInt, executeOp, type Op } from "../core/ops.ts";
import { BOARD_PAGE_SIZE, PAGE_LIMIT_MAX, PAGE_OFFSET_MAX } from "../core/board.ts";
import { getProject, type Project } from "../core/projects.ts";
import {
  authenticate,
  authenticateTokenOnly,
  authFailure,
  describeTokenRef,
  getToken,
  issueToken,
  listTokens,
  maskToken,
  revokeToken,
  tokenToJson,
  touchToken,
  updateTokenMeta,
  updateTokenProjects,
  type AccessToken,
} from "../core/tokens.ts";
import { createProject, generateApiKey, hashApiKey } from "../core/projects.ts";
import { ensureAdminToken, readConfigFile, writeConfigFile } from "../core/config.ts";
import { reapZombies } from "../core/sessions.ts";
import { queryEvents } from "../core/events.ts";
import { eventToJson, toEvent } from "../core/rows.ts";
import { style } from "../core/format.ts";
import { readPackageVersion } from "../core/version.ts";
import { renderAdminPage } from "../server/admin-page.ts";
import { EMBEDDED_ASSETS, EMBEDDED_BYTES, EMBEDDED_COUNT } from "./assets.generated.ts";

export interface ServeOptions {
  dbPath: string;
  host?: string;
  port?: number;
  /** 定期回收僵尸会话（秒），默认 30 */
  reapIntervalSec?: number;
  /**
   * 逻辑时钟。生产用 Date.now；测试注入固定时钟，
   * 否则测试里的 lease（按固定时钟计算）会被 server 的真实时钟判定为过期。
   */
  now?: () => number;
  /**
   * .kanban 目录（存 config.toml 的 admin_token）。默认从 dbPath 推导。
   */
  configDir?: string;
  /** 禁止自动生成 admin token（测试用） */
  noBootstrap?: boolean;
  /**
   * 前端构建产物目录（web/dist）。缺省时从包根推导。
   * 存在则把 `/` 及其静态资源交给它，不存在则退回内置占位页。
   */
  webDir?: string;
}

/** 启动 server，返回 server 实例与实际地址 */
export function startServer(opts: ServeOptions): {
  server: ReturnType<typeof Bun.serve>;
  url: string;
  stop: () => void;
  adminToken: string;
} {
  const handle: Db = openDb(opts.dbPath);
  migrate(handle);
  const db = handle.raw;
  const tickets = new SseTicketStore();
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 7788;
  // 单一真相：版本从 core/version.ts 读 package.json（与 `--version` 同源）。
  // ⚠ 不要在这里硬编码版本号，也不要为了「加个函数」而再包一层转发——
  //   曾经这里写着 `return "0.1.0"` 加一句「M5 阶段改为读 package.json」，
  //   而 package.json 早已是 0.1.x，于是 /api/health 一直报一个**假版本**。
  //   CI 在打 tag 时校验 package.json.version === tag，写第二份就多一个会漂移的真相。
  const version = readPackageVersion();
  const nowFn = opts.now ?? Date.now;
  // 前端构建产物：找不到时 `/` 会退回内置占位页（里面会提示如何构建）
  const webDir = resolveWebDir(opts.webDir);
  // config.toml 的存放位置：
  //   1. 优先 db 所在目录的 .kanban/（与 `agent-kanban init` 的默认布局一致）
  //   2. 找不到就用 db 同级目录（`--db /path/to/kanban.db` 的情况）
  const configDir =
    opts.configDir ??
    (() => {
      const dbDir = dirname(opts.dbPath);
      return findKanbanDirLoose(dbDir) ?? dbDir;
    })();

  // ---- 管理员 token 初始化（ADR-13：server 默认必须有一个管理员 token）----
  // ensureAdminToken 同时做三件事：
  //   1. 写入 config.toml（运维可读）—— 环境变量提供时不写
  //   2. 注册到 tokens 表（运行时鉴权的唯一依据）
  //   3. 校验格式（环境变量路径）
  let adminToken = "";
  if (!opts.noBootstrap) {
    const ensured = ensureAdminToken(configDir, { db, now: nowFn(), generate: generateApiKey });
    adminToken = ensured.token;

    if (ensured.source === "env") {
      // 环境变量路径：token 是外部注入的，不打印（避免进容器日志 = 泄露），
      // 只告诉用户“它生效了”以及去哪儿改
      process.stdout.write(
        `\n${style.gray("Admin token: ")}comes from the ${style.cyan("KANBAN_ADMIN_TOKEN")} environment variable (not written to the config file, plaintext not printed)\n\n`,
      );
    } else if (ensured.isNew) {
      process.stdout.write(
        `\n${style.yellow("An admin token was generated")} (shown only this once, stored in ${ensured.path})\n` +
          `  ${style.bold(ensured.token)}\n\n` +
          `${style.gray("What it does: ")}manage projects, issue/revoke tokens, view tasks across projects\n` +
          `${style.gray("Usage: ")}kanban --key ${ensured.token} admin project list\n` +
          `${style.gray("Containers: ")}you can preset it with the KANBAN_ADMIN_TOKEN environment variable (it must be k_ + 32 hex digits)\n\n`,
      );
    }
  }

  // ---- 定期回收僵尸会话 ----
  // 有了它，即使没有任何 agent 调用命令，server 也能自动把失联会话的卡收回来
  const reapTimer = setInterval(() => {
    try {
      reapZombies(db, { graceMs: getConfig(db).graceMs, now: nowFn() });
    } catch {
      // 回收失败不应弄垮 server
    }
  }, (opts.reapIntervalSec ?? 30) * 1000);

  const server = Bun.serve({
    hostname: host,
    port,
    idleTimeout: 0, // SSE 长连接需要关掉空闲超时
    async fetch(req) {
      try {
        return await handleRequest(req, db, version, nowFn, webDir, tickets);
      } catch (err) {
        const error = toKanbanError(err);
        return jsonError(error, statusForCode(error.code));
      }
    },
  });

  const url = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${server.port}`;

  return {
    server,
    url,
    adminToken,
    stop: () => {
      clearInterval(reapTimer);
      server.stop(true);
      try {
        db.close();
      } catch {
        // 已关闭则忽略
      }
    },
  };
}

/** 路由处理 */
async function handleRequest(
  req: Request,
  db: Database,
  version: string,
  nowFn: () => number,
  webDir: string | null = null,
  tickets: SseTicketStore = new SseTicketStore(),
): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const now = nowFn();

  // ---- 免鉴权：健康检查（用于探活/负载均衡）----
  if (path === "/api/health") {
    // ⚠ **只回 liveness 需要的字段。**
    //   这里曾是 `{ok, version, projects, head_seq}` —— projects 是全库 project 数、
    //   head_seq 是全局事件水位。两者都是**信息**而不是健康检查，而这是**免鉴权**端点：
    //   任何能碰到这个端口的人都能免费拿到「这台服务器管着几个项目、事件写到哪了」。
    //   消费方（compose healthcheck、verify-auth、verify-binary）只读 `ok`。
    return json({ ok: true, version });
  }

  // ---- 管理界面（页面本身不需鉴权，进去后所有数据请求都要管理员 token）----
  if (path === "/admin" || path === "/admin/") {
    return new Response(renderAdminPage(), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // ---- SSE 事件流 ----
  if (path === "/api/stream") {
    return handleSse(req, db, url, nowFn, tickets);
  }

  // ---- token 提取：只认 header，URL 里一律不收 ----
  //
  // ⚠ 这里曾经还有第三个来源 `url.searchParams.get("key")`，而它上面的注释
  //   写着「其次 query（SSE 用后者）」——**那句注释是错的**：SSE 已经在上面
  //   return 掉了，handleSse 自己解析凭据（一次性票或 header），根本走不到这里。
  //   于是那条 query 分支对 SSE 是死代码，对**其余每一个端点**却是活的：
  //   `/api/board?key=`、`/api/op?key=`、`/api/admin/tokens?key=` 实测都能鉴权。
  //   而它正是 #7 要消灭的那一类泄漏（URL 会进 access log、Referer、浏览器历史）——
  //   只删掉 SSE 那一条并不等于「凭据不进 URL」。
  //
  // 分享链接（`http://host:7788/?key=…&project=…`）不受影响：那是**根路径**的
  //   SPA 功能，前端读完就 `history.replaceState` 抹掉，之后所有 API 调用走 header。
  const providedToken =
    req.headers.get("X-Kanban-Key") ??
    req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ??
    undefined;

  // ---- admin 接口：需要管理员 token（ADR-13）----
  if (path.startsWith("/api/admin")) {
    return handleAdminApi(req, db, path, providedToken, now, url);
  }

  // ---- 不依赖 project 的只读端点 ----
  // ⚠ 必须放在下面那段“project 参数检查”**之前**：这类接口存在的意义就是
  //   “客户端还不知道自己要看哪个 project”，比如刚拿到 token 时列可选 project。
  // 之前它被挡在检查后面，导致不带 ?project= 永远 401，前端的 project 列表
  // 实际是坏的。鉴权只验 token 本身有效，不验 project 权限（因为还不知道要访问哪个）。
  if (path === "/api/projects" && req.method === "GET") {
    const auth = authenticateTokenOnly(db, providedToken, now);
    if (!auth.ok) {
      return jsonError(authFailure(auth, ""), 401);
    }
    touchToken(db, auth.token.id, now);
    const accessible =
      auth.role === "admin"
        ? db.query<{ key: string }, []>("SELECT key FROM projects ORDER BY created_at").all().map((r) => r.key)
        : auth.token.projects;
    return json({
      ok: true,
      data: accessible
        .map((key) => getProject(db, key))
        .filter((p): p is Project => p !== null)
        .map((p) => projectInfo(p, db, p.key)),
    });
  }

  // ---- 静态前端 ----
  if (!path.startsWith("/api/")) {
    return await serveStatic(path, webDir ?? null);
  }

  // ---- SSE 一次性 ticket（换取不带 token 的 SSE URL）----
  // 鉴权走常规流程（header 优先，所以 token 也不进 URL）。
  // 位置：必须在「静态前端」之后、「project 参数检查」之前——因为换票这一步
  // 用的是 **body 里的** project，而常规鉴权（authenticate）发生在它之后，
  // 靠 targetProject 鉴权会误判（body 说 A、URL 没 project 时 targetProject 就是 A，
  // 看似能过，但 URL 说 B 时就会被无谓地拒掉）。所以这里自己鉴权。
  if (path === "/api/stream-ticket" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { project?: string };
    const project = body.project ?? url.searchParams.get("project") ?? "";
    if (project.length === 0) {
      return jsonError(
        KanbanError.usage("the stream ticket requires a project", undefined, {
          reason: "sse_ticket_project_missing",
          hint: 'Usage: POST /api/stream-ticket with body {"project":"<key>"} and the X-Kanban-Key header',
        }),
        400,
      );
    }
    // 这个 token 是否真的有权访问该 project
    const ticketAuth = authenticate(db, providedToken, project, now);
    if (!ticketAuth.ok) return jsonError(authFailure(ticketAuth, project), 401);
    const value = tickets.issue(providedToken!, project, now);
    return json({
      ok: true,
      data: { ticket: value, expires_in_ms: TICKET_TTL_MS, project },
    });
  }

  // ---- 业务接口：从 URL 或 body 取 project（Op 路径下在 body 里）----
  let body: { project?: string; op?: Op } | null = null;
  if (path === "/api/op" && req.method === "POST") {
    try {
      body = (await req.json()) as { project?: string; op?: Op };
    } catch {
      return jsonError(KanbanError.usage("the request body is not valid JSON"), 400);
    }
    if (!body || typeof body.op !== "object" || typeof body.op.kind !== "string") {
      return jsonError(
        KanbanError.usage(
          'the request body must be { "project": "...", "op": { "kind": "...", "params": {...} } }',
          undefined,
          { reason: "invalid_request_body" },
        ),
        400,
      );
    }
  }

  const targetProject = url.searchParams.get("project") ?? body?.project ?? "";
  if (targetProject.length === 0) {
    return jsonError(
      KanbanError.auth("the request is missing the project parameter", {
        reason: "auth_project_missing",
        hint: "Every business endpoint needs ?project=<key> (or a project field in the body)",
      }),
      401,
    );
  }

  // ---- 鉴权：查 tokens 表（ADR-13）----
  const auth = authenticate(db, providedToken, targetProject, now);
  if (!auth.ok) {
    return jsonError(authFailure(auth, targetProject), 401);
  }
  // 审计：记录 token 使用（节流，见 touchToken）
  touchToken(db, auth.token.id, now);

  // body 的 project 必须与鉴权目标一致（防“用 A 的 token 操作 B”）
  if (body?.project && body.project !== targetProject) {
    return jsonError(
      KanbanError.auth("the project in the request body does not match the authenticated project", {
        reason: "auth_project_mismatch",
        url_project: targetProject,
        body_project: body.project,
      }),
      401,
    );
  }

  const project = getProject(db, targetProject);
  if (!project) {
    // 有权访问但 project 不存在：这是 STATE 而非 AUTH（调用方该确认名字）
    return jsonError(
      KanbanError.notInit(`project "${targetProject}" not found`, {
        reason: "project_not_found",
        project: targetProject,
        hint: "List the existing projects with an admin token: kanban --key <admin-token> project list",
      }),
      400,
    );
  }

  // ---- Op 执行：本地/远程一致性的核心 ----
  // （body 已在鉴权前解析并校验过结构，这里直接执行）
  if (path === "/api/op" && req.method === "POST" && body?.op) {
    const sessionId = req.headers.get("X-Kanban-Session");
    try {
      const { data, nextActions } = executeOp(body.op, {
        db,
        projectKey: targetProject,
        sessionId,
        now: nowFn,
        ttlMs: project.defaultTtlMs ?? getConfig(db).defaultTtlMs,
        // 客户端自己的工作目录：OpContext.cwd 的用途就是它（见 ops.ts 里 session.start 的注释）。
        // 远程模式下 process.cwd() 是 **server** 的目录，所以必须由客户端带上来。
        cwd: req.headers.get("X-Kanban-Cwd") ?? undefined,
      });
      return json({ ok: true, data, next_actions: nextActions });
    } catch (err) {
      const error = toKanbanError(err);
      // BUSY 时给 Retry-After，让客户端知道可以立刻重试
      const headers: Record<string, string> = {};
      if (error.code === ExitCode.BUSY) headers["Retry-After"] = "1";
      return jsonError(error, statusForCode(error.code), headers);
    }
  }

  // ---- 只读辅助接口（供 Web/调试；主路径仍是 /api/op）----
  // 注：`/api/projects` 已提前到 project 参数检查之前处理（它不需要指定 project）

  if (path === "/api/board") {
    // 分页参数（看板一次只取 limit 张，超出部分由前端「显示更多」拉取）。
    // 钳制**必须**走 core 的 clampInt 与同一组常量：这里曾经自己写了一套
    // Number/Math.min，于是上界与默认值各有两个真相，两边不同步时 REST 与 Op
    // 会对同一个 ?limit= 给出不同的解释。
    const limit = clampInt(url.searchParams.get("limit"), 1, PAGE_LIMIT_MAX, BOARD_PAGE_SIZE);
    const offset = clampInt(url.searchParams.get("offset"), 0, PAGE_OFFSET_MAX, 0);
    const { data } = executeOp(
      { kind: "board.get", params: { include_done: true, limit, offset } },
      {
        db,
        projectKey: targetProject,
        sessionId: null,
        now: nowFn,
      },
    );
    return json({ ok: true, data });
  }

  if (path === "/api/events") {
    const after = Number(url.searchParams.get("after") ?? "0");
    const limit = Number(url.searchParams.get("limit") ?? "200");
    const rows = queryEvents(db, { projectKey: targetProject, sinceSeq: after, order: "asc", limit });
    // eventToJson：与 Op 路径同源，保证 /api/events 和 /api/op 返回的事件形状一致
    return json({ ok: true, data: rows.map((r) => eventToJson(toEvent(r))) });
  }

  return jsonError(KanbanError.state(`unknown endpoint: ${path}`, { reason: "unknown_endpoint" }), 404);
}

/**
 * admin API（ADR-13）：项目管理 + token 管理。
 *
 * 鉴权：必须是 role=admin 的 token。项目级 token 访问一律 403。
 * 约定：除“创建 token”外，所有接口都不返回明文 token。
 */
async function handleAdminApi(
  req: Request,
  db: Database,
  path: string,
  providedToken: string | undefined,
  now: number,
  url: URL,
): Promise<Response> {
  // ---- 鉴权：必须是 admin ----
  //
  // 做法：用 "__admin__" 作为探测用的 project 名。管理员 token 天然放行全部 project；
  // 项目级 token 则会在白名单检查处得到 reason="forbidden"。
  //
  // 关键：**forbidden 与 invalid 必须区分**
  //   forbidden → token 有效，但不是管理员 → 403（“该换个 token”）
  //   invalid / missing / revoked / expired → 401（“该去拿个新 token”）
  // 两者的处置方式完全不同，agent 能据此决定重试还是改配置。
  const auth = authenticate(db, providedToken, "__admin__", now);
  if (!auth.ok) {
    if (auth.reason === "forbidden") {
      // token 有效但范围不含 __admin__ —— 即“不是管理员”
      return jsonError(
        KanbanError.auth("this operation requires an admin token", {
          reason: "auth_admin_required",
          token: maskToken(providedToken ?? ""),
          hint:
            "A project-scoped token can only reach the projects it was granted.\n" +
            "Use an admin token to manage projects and tokens (one is generated when the server first starts, and stored in .kanban/config.toml).\n" +
            "Usage: kanban --key <admin-token> admin project list",
        }),
        403,
      );
    }
    return jsonError(authFailure(auth, "__admin__"), 401);
  }
  if (auth.role !== "admin") {
    return jsonError(
      KanbanError.auth("this operation requires an admin token", {
        reason: "auth_admin_required",
        hint: "A project-scoped token can only reach the projects it was granted; use an admin token to manage projects and tokens",
      }),
      403,
    );
  }
  touchToken(db, auth.token.id, now);

  const method = req.method;
  const sub = path.replace("/api/admin", "") || "/";

  const allProjects = () =>
    db
      .query<{ key: string }, []>("SELECT key FROM projects ORDER BY created_at")
      .all()
      .map((r) => projectInfo(getProject(db, r.key)!, db, r.key));

  // ---- GET /api/admin/overview：管理页首屏 ----
  if (sub === "/overview" && method === "GET") {
    return json({
      ok: true,
      data: {
        projects: allProjects(),
        tokens: listTokens(db, { includeRevoked: true }).map((t) => tokenToJson(t, now)),
        server_time: now,
      },
    });
  }

  // ---- GET /api/admin/projects ----
  if (sub === "/projects" && method === "GET") {
    return json({ ok: true, data: allProjects() });
  }

  // ---- POST /api/admin/projects：创建 project ----
  if (sub === "/projects" && method === "POST") {
    const body = (await req.json().catch(() => ({}))) as {
      key?: string;
      name?: string;
      root_path?: string;
    };
    if (!body.key) {
      return jsonError(KanbanError.usage("missing key", undefined, { reason: "missing_project_key" }), 400);
    }
    const project = createProject(db, {
      key: body.key,
      name: body.name,
      rootPath: body.root_path ?? null,
      // 不再给 project 自带 key：token 统一由 tokens 表管理（ADR-13）
      apiKeyHash: null,
      now,
    });
    return json({ ok: true, data: projectInfo(project, db, project.key) });
  }

  // ---- DELETE /api/admin/projects/:key ----
  if (sub.startsWith("/projects/") && method === "DELETE") {
    const key = decodeURIComponent(sub.slice("/projects/".length));
    const existing = getProject(db, key);
    if (!existing) {
      return jsonError(
        KanbanError.state(`project not found: ${key}`, { reason: "project_not_found", project: key }),
        404,
      );
    }

    // 删除 project 会连带删除其任务（不可恢复）——必须显式确认
    if (url.searchParams.get("force") !== "1") {
      const taskCount =
        db
          .query<{ c: number }, [string]>("SELECT COUNT(*) AS c FROM tasks WHERE project_key = ?")
          .get(key)?.c ?? 0;
      return json(
        {
          ok: false,
          error: {
            code: 2,
            name: "STATE",
            message: `project "${key}" still has ${taskCount} task(s), deleting it is not recoverable`,
            details: {
              reason: "project_not_empty",
              project: key,
              task_count: taskCount,
              hint: "Pass ?force=1 to confirm the deletion",
            },
          },
        },
        409,
      );
    }

    // 先删依赖（子表），再删各表
    //
    // ⚠ task_deps 的删除必须带 project_key 谓词：子查询 `SELECT id FROM tasks
    //   WHERE project_key = ?` 返回的是**本 project 的 T 编号**，而 T 编号
    //   是 per-project 的（ADR-9），不写 `project_key = ?` 就会把别的 project
    //   里同号任务的依赖边一起删掉。
    db.query(
      `DELETE FROM task_deps
        WHERE project_key = ?
          AND (task_id IN (SELECT id FROM tasks WHERE project_key = ?)
               OR depends_on_id IN (SELECT id FROM tasks WHERE project_key = ?))`,
    ).run(key, key, key);
    for (const table of ["tasks", "events", "plans", "handoffs", "project_counters"]) {
      db.query(`DELETE FROM ${table} WHERE project_key = ?`).run(key);
    }
    db.query("DELETE FROM projects WHERE key = ?").run(key);
    // 清理 token 白名单里对该 project 的引用（自动生效，无需手工改 token）
    for (const t of listTokens(db, { role: "project" })) {
      if (t.projects.includes(key)) {
        try {
          updateTokenProjects(db, t.id, t.projects.filter((p) => p !== key));
        } catch {
          // 白名单被清空的 token 保持原样（后续可由管理员吊销）
        }
      }
    }
    return json({ ok: true, data: { deleted: key } });
  }

  // ---- GET /api/admin/tokens ----
  if (sub === "/tokens" && method === "GET") {
    const tokens = listTokens(db, {
      role: url.searchParams.get("role") as "admin" | "project" | undefined,
      includeRevoked: url.searchParams.get("include_revoked") === "1",
    }).map((t) => tokenToJson(t, now));
    return json({ ok: true, data: tokens });
  }

  // ---- POST /api/admin/tokens：签发（明文只返回这一次）----
  if (sub === "/tokens" && method === "POST") {
    const body = (await req.json().catch(() => ({}))) as {
      role?: string;
      projects?: string[];
      name?: string;
      note?: string;
      expires_in_ms?: number;
    };
    const issued = issueToken(
      db,
      {
        role: body.role === "admin" ? "admin" : "project",
        projects: body.projects ?? [],
        name: body.name ?? null,
        note: body.note ?? null,
        expiresInMs: body.expires_in_ms ?? null,
        createdBy: auth.token.id,
      },
      now,
    );
    // 明文只在这里出现：之后的任何接口都拿不到
    return json({
      ok: true,
      data: {
        ...tokenToJson(issued.token, now),
        token: issued.plaintext,
        warning: "this plaintext is shown only once, store it in the caller's configuration right now",
      },
    });
  }

  // ---- DELETE /api/admin/tokens/:id：吊销 token（契约 §4.2 写的就是这个）
  //
  // 契约里写的是 DELETE，实现曾经只有 `POST /api/admin/tokens/:id/revoke`
  // ——两边对不上，且**没有任何测试能发现**（文档类事实没有硬覆盖）。
  // 现在按契约实现 DELETE；POST /revoke 保留为别名（见下），两者共用同一段实现，
  // 并有测试断言它们行为一致，所以不会各自漂移。
  const isTokenTarget = sub.startsWith("/tokens/");
  if (isTokenTarget && (method === "DELETE" || sub.endsWith("/revoke"))) {
    const tokenId = decodeURIComponent(
      sub.replace("/revoke", "").slice("/tokens/".length),
    );
    const revoked = revokeToken(db, tokenId, now);
    return json({ ok: true, data: tokenToJson(revoked, now) });
  }

  // ---- GET /api/admin/tokens/:id：查单个 token（grant 前需要先读当前白名单）----
  if (isTokenTarget && method === "GET") {
    const tokenId = decodeURIComponent(sub.slice("/tokens/".length));
    const token = getToken(db, tokenId);
    if (!token) {
      return jsonError(
        KanbanError.state(`token not found: ${describeTokenRef(tokenId)}`, {
          reason: "token_not_found",
          token: describeTokenRef(tokenId),
        }),
        404,
      );
    }
    return json({ ok: true, data: tokenToJson(token, now) });
  }

  // ---- PATCH /api/admin/tokens/:id：改白名单/元信息 ----
  if (isTokenTarget && method === "PATCH") {
    const tokenId = decodeURIComponent(sub.slice("/tokens/".length));
    const existing = getToken(db, tokenId);
    if (!existing) {
      return jsonError(
        KanbanError.state(`token not found: ${describeTokenRef(tokenId)}`, {
          reason: "token_not_found",
          token: describeTokenRef(tokenId),
        }),
        404,
      );
    }
    // 显式标注类型：getToken 可能返回 null，而 patch 链会重新赋值
    let token: AccessToken = existing;
    const body = (await req.json().catch(() => ({}))) as {
      projects?: string[];
      name?: string;
      note?: string;
      expires_in_ms?: number | null;
    };
    try {
      if (body.projects) token = updateTokenProjects(db, tokenId, body.projects, now);
      if (body.name !== undefined || body.note !== undefined || body.expires_in_ms !== undefined) {
        token = updateTokenMeta(db, tokenId, {
          name: body.name,
          note: body.note,
          expiresAtMs: body.expires_in_ms === undefined ? undefined : body.expires_in_ms,
        }, now);
      }
    } catch (err) {
      const error = toKanbanError(err);
      return jsonError(error, statusForCode(error.code));
    }
    return json({ ok: true, data: tokenToJson(token, now) });
  }

  return jsonError(KanbanError.state(`unknown admin endpoint: ${path}`, { reason: "unknown_endpoint" }), 404);
}

/** project 概要信息 */
function projectInfo(project: Project, db: Database, projectKey: string): Record<string, unknown> {
  const tokenCount =
    db
      .query<{ c: number }, [string]>(
        `SELECT COUNT(*) AS c FROM tokens
          WHERE revoked_at IS NULL AND (projects LIKE ? OR role = 'admin')`,
      )
      .get(`%"${projectKey}"%`)?.c ?? 0;
  return {
    key: project.key,
    name: project.name,
    root_path: project.rootPath,
    /** 鉴权已改由 tokens 表负责，该字段保留兼容（恒为 false） */
    requires_key: false,
    token_count: tokenCount,
    created_at: project.createdAt,
    task_count:
      db
        .query<{ c: number }, [string]>("SELECT COUNT(*) AS c FROM tasks WHERE project_key = ?")
        .get(projectKey)?.c ?? 0,
  };
}

/**
 * SSE 一次性 ticket。
 *
 * ## 为什么需要它
 *
 * 浏览器的事件流只能用 `EventSource`，而它**不能设自定义 header**。
 * 于是 token 只能进 URL query——而 URL 会进浏览器历史、反代 access log、
 * 容器日志与 `Referer`。项目自己的 `consumeUrlLogin` 注释就很担心 token 泄漏，
 * 但 SSE 每条连接都在这么干。
 *
 * 做法：先用一个**普通的 header 鉴权**请求换一张 ticket，再用 ticket 连 SSE。
 * 于是 URL 里出现的是一个 60 秒后失效、且**只能用一次**的随机串——
 * 就算整条 URL 被记进日志，也换不到任何可用的凭据。
 *
 * ## 为什么不放数据库
 *
 * ticket 是纯易失的：进程重启后失效无害（客户端重新换一张即可），
 * 而放进 tokens 表会给免鉴权面开一个「读表即可拿到凭据」的新口子。
 * 所以只在内存里，并定期清理。
 */
interface SseTicket {
  /** 换取到的真 token（只在内存里） */
  token: string;
  /** 该 ticket 被限定在这个 project */
  projectKey: string;
  expiresAt: number;
}

const TICKET_TTL_MS = 60_000;
/** 内存里最多留多少张票（防「疯狂换票」把内存吃满） */
const TICKET_MAX = 1000;
/** 随机串长度（base64url，够长即可：它 60 秒后就作废） */
function newTicketValue(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * 签发并核销 ticket。
 *
 * 核销是**一次性**的：取出即删。这样即使 URL 被记录并重放，也只能用第一次。
 */
class SseTicketStore {
  private readonly map = new Map<string, SseTicket>();

  issue(token: string, projectKey: string, now: number): string {
    this.prune(now);
    // 满了就丢掉最早的一张（ticket 60 秒就过期，丢哪张都无所谓）
    if (this.map.size >= TICKET_MAX) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest) this.map.delete(oldest);
    }
    const value = newTicketValue();
    this.map.set(value, { token, projectKey, expiresAt: now + TICKET_TTL_MS });
    return value;
  }

  /** 取出并作废；无效/过期返回 null */
  redeem(value: string, now: number): SseTicket | null {
    const hit = this.map.get(value);
    if (!hit) return null;
    // 一次性：无论成功与否都从表里移除
    this.map.delete(value);
    if (hit.expiresAt <= now) return null;
    return hit;
  }

  private prune(now: number): void {
    for (const [k, v] of this.map) {
      if (v.expiresAt <= now) this.map.delete(k);
    }
  }
}

/**
 * SSE：按 project 推送事件。
 *
 * 实现：轮询 events 表（1s 间隔），游标 = seq。
 * 为什么不用 EventEmitter/IPC：CLI 往往在**另一个进程**里写库，
 * 轮询是唯一跨进程都可靠的方案，且实现最简。
 *
 * ## 鉴权
 *
 * 两种方式，**都不接受 URL 里的 token**：
 *   1. `?ticket=` —— 浏览器 `EventSource` 专用（不能设 header），票 60 秒一次性。
 *      换取方式：`POST /api/stream-ticket`（正常 header 鉴权）。
 *   2. `X-Kanban-Key` / `Authorization` header —— 能设 header 的客户端
 *      （如 core/backend-remote.ts 的 `streamEvents`）直接用，不必换票。
 *
 * 以前这里接受 `?key=k_xxx`，那等于把 token 写进日志，已删除。
 *
 * ## 复验
 *
 * 长连接建立后**不再重新鉴权**——token 中途被吊销，已建立的连接会继续推事件
 * 直到客户端重连。所以 pump 里定期（默认 30s）重验一次，失效就通知客户端并关流。
 */
function handleSse(
  req: Request,
  db: Database,
  url: URL,
  nowFn: () => number,
  tickets: SseTicketStore,
): Response {
  const projectKey = url.searchParams.get("project") ?? "";
  const now0 = nowFn();

  // 解析凭据：先换票（浏览器路径），再试 header（fetch 路径）
  const ticketValue = url.searchParams.get("ticket");
  let token: string | undefined;
  let tokenProject = projectKey;
  if (ticketValue) {
    const redeemed = tickets.redeem(ticketValue, now0);
    if (redeemed) {
      token = redeemed.token;
      // 票与 project 绑定：拿 A 的票去连 B 会被这里挡住
      tokenProject = redeemed.projectKey;
    }
  } else {
    token =
      req.headers.get("X-Kanban-Key") ??
      req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ??
      undefined;
  }
  if (tokenProject !== projectKey) {
    return jsonError(
      KanbanError.auth("this ticket is for a different project", {
        reason: "sse_ticket_project_mismatch",
        hint: "Request a new ticket with POST /api/stream-ticket for the project you want to watch",
      }),
      403,
    );
  }

  // 鉴权：走与普通接口同一套（未吊销 / 未过期 / project 白名单）
  const auth = authenticate(db, token, projectKey, now0);
  if (!auth.ok) {
    return jsonError(authFailure(auth, projectKey), 401);
  }

  // 断线续传：优先用 Last-Event-ID（EventSource 自动带），其次 after 参数
  const lastEventId = req.headers.get("Last-Event-ID");
  let cursor = Number(lastEventId ?? url.searchParams.get("after") ?? "0");
  if (!Number.isFinite(cursor) || cursor < 0) cursor = 0;

  const encoder = new TextEncoder();
  /** 多久重验一次凭据（秒） */
  const REAUTH_INTERVAL_S = 30;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (text: string) => {
        if (!closed) {
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            closed = true;
          }
        }
      };

      // 先告诉客户端断线后多久重连
      send("retry: 3000\n\n");

      let lastAuthCheckAt = now0;
      const reauthIfDue = () => {
        const now = nowFn();
        // 用墙钟而非 tick 计数：机器卡顿时也不至于把复验窗口拉长
        if (now - lastAuthCheckAt < REAUTH_INTERVAL_S * 1000) return true;
        lastAuthCheckAt = now;
        const again = authenticate(db, token, projectKey, now);
        if (again.ok) return true;
        // 凭据已失效：明确告诉客户端「重连也没用，先重新登录」
        send(
          `event: auth_expired\ndata: ${JSON.stringify({ reason: again.reason })}\n\n`,
        );
        cleanup();
        return false;
      };

      const pump = () => {
        if (closed) return;
        if (!reauthIfDue()) return;
        try {
          const rows = queryEvents(db, { projectKey, sinceSeq: cursor, order: "asc", limit: 100 });
          for (const row of rows) {
            // 游标用 row.seq（与领域对象同一个值），推送体走 eventToJson 转成 snake_case
            cursor = row.seq;
            const event = eventToJson(toEvent(row));
            send(
              `id: ${row.seq}\n` +
                `event: ${row.type}\n` +
                `data: ${JSON.stringify(event)}\n\n`,
            );
          }
        } catch {
          send(`event: error\ndata: ${JSON.stringify({ message: "event polling failed" })}\n\n`);
        }
        // 15s 一次 keepalive 注释帧，防中间设备断连
        send(`: keepalive ${Date.now()}\n\n`);
      };

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        clearInterval(keepaliveTimer);
        try {
          controller.close();
        } catch {
          // 已关闭
        }
      };

      pump();
      const timer = setInterval(pump, 1000);
      // 心跳注释帧单独发（15s）
      const keepaliveTimer = setInterval(() => send(`: keepalive ${Date.now()}\n\n`), 15_000);

      req.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // 防 nginx 缓冲
    },
  });
}

/** 静态资源：优先服务 `web/dist` 的构建产物，缺省退回内置占位页 */
/**
 * 静态资源：二进制内嵌 → 磁盘目录 → 占位页。
 *
 * 查找优先级：
 *   1. **内嵌资源**（`bun build --compile` 打进二进制的 web/dist）
 *      —— 单文件分发时唯一可用的来源，也是发布产物的默认路径
 *   2. 磁盘目录（`KANBAN_WEB_DIR` 或包根下的 web/dist）
 *      —— 开发模式、以及“二进制 + 旁边放一份前端”的部署方式
 *   3. 内置占位页（含构建指引）
 *
 * 两者都提供时内嵌优先：发布出去的二进制就是自包含的，不该再受外部文件影响
 * （否则“改了旁边的文件导致线上行为变化”会变得不可预测）。
 */
async function serveStatic(path: string, webDir: string | null): Promise<Response> {
  // 归一化请求路径：`/` → index.html，并阻断路径穿越
  const rel = path === "/" ? "index.html" : decodeURIComponent(path).replace(/^\/+/, "");

  // `..` 会在归一化后暴露，必须拦掉（即使最终仍指向 web 目录内，
  // 也没必要支持这种写法——前端不会产生它）
  if (rel.includes("..")) return new Response("Forbidden", { status: 403 });

  // ---- 1. 内嵌资源 ----
  const embedded = EMBEDDED_ASSETS[rel];
  if (embedded) {
    return new Response(await embedded(), {
      headers: {
        "Content-Type": contentTypeFor(rel),
        "Cache-Control": cacheControlFor(rel),
      },
    });
  }
  // SPA 回退（命中 index.html）
  const embeddedIndex = EMBEDDED_ASSETS["index.html"];
  if (embeddedIndex) {
    return new Response(await embeddedIndex(), {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
    });
  }

  // ---- 2. 磁盘目录 ----
  if (webDir) {
    const target = resolve(webDir, rel);
    const inside = target.startsWith(webDir) ? target : null;
    if (inside && existsSync(inside) && statSync(inside).isFile()) {
      return new Response(Bun.file(inside), {
        headers: { "Content-Type": contentTypeFor(inside), "Cache-Control": cacheControlFor(inside) },
      });
    }
    // SPA 回退到磁盘上的 index.html
    const indexFile = join(webDir, "index.html");
    if (existsSync(indexFile)) {
      return new Response(Bun.file(indexFile), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
      });
    }
  }

  // ---- 3. 都没有 ----
  if (path === "/" || path === "/index.html") {
    return new Response(PLACEHOLDER_HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  return new Response("Not Found", { status: 404 });
}

/**
 * 缓存头：带内容哈希的资源可长缓存；html 必须每次校验。
 *
 * 为什么 index.html 不能长缓存：它引用的是带 hash 的资源文件名，
 * 发版后 index.html 会指向新 hash 但 URL 不变——长缓存会让用户永远拿旧壳，
 * 表现为“明明更新了但页面还是老的，且刷新没用”。
 */
function cacheControlFor(file: string): string {
  return file.endsWith(".html")
    ? "no-cache"
    : "public, max-age=31536000, immutable"
}

/** 极简 MIME 映射（够用即可，不引入依赖） */
function contentTypeFor(file: string): string {
  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    html: "text/html; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    css: "text/css; charset=utf-8",
    json: "application/json; charset=utf-8",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    webp: "image/webp",
    ico: "image/x-icon",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    map: "application/json; charset=utf-8",
  };
  return map[ext] ?? "application/octet-stream";
}

/**
 * 定位前端构建产物。
 *
 * 查找顺序：
 *   1. 显式传入的 webDir
 *   2. 相对于本文件（src/server/）往包根找 `web/dist`
 *   3. 环境变量 KANBAN_WEB_DIR
 * 找不到返回 null（调用方退回占位页）。
 */
function resolveWebDir(explicit?: string): string | null {
  const candidates = [
    explicit,
    process.env.KANBAN_WEB_DIR,
    // src/server/http.ts → ../../web/dist
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist"),
  ].filter((v): v is string => Boolean(v));
  for (const c of candidates) {
    if (existsSync(join(c, "index.html"))) return c;
  }
  return null;
}

/** 退出码 → HTTP 状态码（契约 §4.0） */
export function statusForCode(code: number): number {  switch (code) {
    case ExitCode.OK:
      return 200;
    case ExitCode.USAGE:
      return 400;
    case ExitCode.STATE:
    case ExitCode.CONFLICT:
      return 409;
    case ExitCode.BUSY:
      return 503;
    case ExitCode.NOT_INIT:
      return 400;
    case ExitCode.INTERNAL:
      return 500;
    case ExitCode.AUTH:
      return 401;
    default:
      return 500;
  }
}

function json(payload: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

function jsonError(error: KanbanError, status: number, extraHeaders: Record<string, string> = {}): Response {
  const payload = error.toJSON() as { error: unknown };
  return json({ ok: false, error: payload.error }, status, extraHeaders);
}

/** 临时占位页（未构建前端时使用）
   *
   * 什么时候会看到它：仓库刚 clone 还没跑过 `bun run build:web`。
   * 页面里直接给出构建命令，不让用户对着一句 “Not Found” 猜。
   */
const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>agent-kanban</title>
<style>body{font-family:ui-serif,Georgia,"Songti SC",serif;background:#FBF8F2;color:#2B2825;padding:48px;line-height:1.7}
code{background:#EFE9DC;padding:2px 7px;border-radius:4px;font-family:ui-monospace,monospace;font-size:.9em}
.card{background:#fff;border:1px solid #E7E0D2;border-radius:10px;padding:20px 24px;max-width:640px;box-shadow:0 1px 3px rgba(43,40,37,.06)}
h1{margin:0 0 4px;font-size:20px} .sub{color:#7A746B;font-size:13px;margin-bottom:18px}
li{margin:5px 0}</style></head>
<body><div class="card">
<h1>agent-kanban server</h1>
<p class="sub">The backend is ready, but the frontend has not been built yet.</p>
<p>Build the board page:</p>
<ul>
<li><code>cd web &amp;&amp; bun install &amp;&amp; bun run build</code></li>
<li>then reload this page (<code>http://127.0.0.1:7788/</code>)</li>
</ul>
<p>Development mode (hot reload): <code>cd web &amp;&amp; bun run dev</code>; Vite proxies <code>/api</code> to this server.</p>
<p>The API works without the frontend too:</p>
<ul>
<li><code>GET /api/health</code> health check (no auth)</li>
<li><code>POST /api/op</code> run an op (needs <code>X-Kanban-Key</code>)</li>
<li><code>POST /api/stream-ticket</code> then <code>GET /api/stream</code> SSE event stream</li>
<li><code>/admin</code> admin page (projects and tokens)</li>
</ul>
</div></body></html>`;

/** 供 `agent-kanban serve` 使用的入口封装 */
export function runServe(opts: ServeOptions & { quiet?: boolean }): ExitCodeValue {
  const handle = openDb(opts.dbPath);
  migrate(handle);
  const projectCount = handle.raw
    .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM projects")
    .get()?.c ?? 0;
  handle.raw.close();

  // 容器友好：允许用环境变量配 host/port，不用改镜像的 CMD。
  // 优先级：CLI 参数 > 环境变量 > 默认值（与项目整体的配置优先级一致）。
  const envHost = process.env.KANBAN_HOST?.trim();
  const envPort = Number(process.env.KANBAN_PORT);
  const effective: ServeOptions = {
    ...opts,
    host: opts.host ?? (envHost && envHost.length > 0 ? envHost : undefined),
    port: opts.port ?? (Number.isInteger(envPort) && envPort > 0 ? envPort : undefined),
  };

  const { url, stop } = startServer(effective);

  if (!opts.quiet) {
    process.stdout.write(`${style.green("✓")} kanban server started: ${style.cyan(url)}\n`);
    process.stdout.write(`  database: ${opts.dbPath}\n`);
    process.stdout.write(`  projects: ${projectCount}\n`);
    if ((effective.host ?? "127.0.0.1") === "0.0.0.0") {
      process.stdout.write(
        `  ${style.yellow("Warning")}: bound to 0.0.0.0, make sure a TLS reverse proxy sits in front of it (https on an internal network is recommended)\n`,
      );
    }
    if (process.env.KANBAN_WEB_DIR) {
      process.stdout.write(`  Web asset directory: ${style.cyan(process.env.KANBAN_WEB_DIR)}\n`);
    }
    // 前端来源：内嵌（单文件二进制）还是磁盘（开发 / 旁挂）
    if (EMBEDDED_COUNT > 0) {
      process.stdout.write(
        `  Web board: ${style.green("embedded in the binary")} ${style.gray(`(${EMBEDDED_COUNT} files, ${(EMBEDDED_BYTES / 1024).toFixed(0)} KB)`)}\n`,
      );
    } else if (effective.webDir) {
      process.stdout.write(`  Web board: ${style.gray("read from disk")} ${style.cyan(effective.webDir)}\n`);
    } else {
      process.stdout.write(
        `  Web board: ${style.yellow("not available")} ${style.gray("(rebuild the binary after building the frontend: bun run web:build && bun run gen:assets)")}\n`,
      );
    }
    process.stdout.write(`\n  To use it from another machine or another project:\n`);
    process.stdout.write(`    kanban --server ${url} --project <key> --key k_xxx task list\n`);
    process.stdout.write(`\n  Web board: ${url}/\n  ${style.gray("Ctrl+C to stop")}\n`);
  }

  // 阻塞主线程直到被中断
  process.on("SIGINT", () => {
    process.stdout.write("\nstopping the server…\n");
    stop();
    process.exit(0);
  });

  return ExitCode.OK;
}
