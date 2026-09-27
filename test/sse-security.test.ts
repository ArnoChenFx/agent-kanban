/**
 * 凭据不进 URL；长连接要复验；免鉴权端点只回 liveness。
 *
 * ## 三条都来自同一批审查发现
 *
 * 1. **SSE 的 token 走 query**（`/api/stream?...&key=k_xxx`）。浏览器的
 *    `EventSource` 不能设 header，所以曾经「只能」这么干——而 URL 会进浏览器历史、
 *    反代 access log、容器日志与 `Referer`。项目自己的 `consumeUrlLogin` 注释
 *    就很担心 token 泄漏，但 SSE 每条连接都在写。
 *    现在：浏览器先换一张 **60 秒一次性**的票；能设 header 的客户端直接用 header。
 *    **服务端的 `?key=` 已删除**（不留后角）：不只 SSE，其余每个端点也都不收
 *    —— URL 会进 access log / Referer / 浏览器历史，只堵 SSE 那一条等于漏洞还在。
 *
 * 2. **长连接不重新鉴权**：token 中途被吊销，已建立的连接会继续推事件直到客户端重连。
 *    现在 pump 里定期重验，失效就推 `auth_expired` 并关流。
 *
 * 3. **`/api/health` 免鉴权却回 `projects` 数量与全局 `head_seq`**——
 *    那是信息不是健康检查，而任何能碰到端口的人都能免费拿到。
 *    现在只回 `{ok, version}`（消费方只读 `ok`）。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDb, migrate, setInitialConfig } from "../src/core/db.ts";
import { createProject } from "../src/core/projects.ts";
import { issueToken, revokeToken } from "../src/core/tokens.ts";
import { startServer } from "../src/server/http.ts";
import { TOOLS } from "../src/mcp/tools.ts";
import { executeOp, type OpContext } from "../src/core/ops.ts";
import { createTask } from "../src/core/tasks.ts";
import { withTx } from "../src/core/tx.ts";

const ROOT = resolve(import.meta.dir, "..");

/**
 * 读源码并**剥掉注释**。
 *
 * 为什么必须剥：本文件的好几条断言是「代码里不该再出现旧写法」，
 * 而**解释为什么去掉它的注释里必然要提到那个旧写法**（例如
 * 「以前是 `&key=k_xxx`」）。不剥注释的话，守卫会被自己的说明书绊倒——
 * 那样的守卫要么被放宽成「等于没查」，要么逼着后人把注释删干净。
 *
 * 守卫该看**代码**，不该看解说。
 */
function code(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8")
    // 块注释（含 /** */ 的 JSDoc）
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // 行注释
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const PROJECT = "p1";
const NOW = 1_700_000_000_000;

let dir: string;
let stop: () => void;
let base: string;
let token: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "kanban-sse-"));
  const dbPath = join(dir, "s.db");
  const handle = openDb(dbPath);
  migrate(handle);
  setInitialConfig(handle.raw, { projectName: "sse", now: NOW });
  createProject(handle.raw, { key: PROJECT, name: "p1", rootPath: dir, apiKeyHash: null });
  createProject(handle.raw, { key: "other", name: "other", rootPath: dir, apiKeyHash: null });
  handle.raw.close();

  const started = startServer({ dbPath, port: 0, configDir: dir, reapIntervalSec: 3600 });
  stop = started.stop;
  base = started.url;
  token = started.adminToken;
});

afterEach(() => {
  stop();
  // 先关掉本用例 open 的连接，否则 Windows 上删临时目录会 EBUSY
  for (const db of opened.splice(0)) {
    try {
      db.close();
    } catch {
      // 已关闭
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

/** 本文件 open 过的本地连接（afterEach 要先关掉，否则 Windows 上 rmSync 会 EBUSY） */
const opened: Database[] = [];

/** 打开 server 正在用的那个库（本地 Op 用例） */
function openServerDb(): Database {
  const db = new Database(join(dir, "s.db"));
  opened.push(db);
  return db;
}

/** 本地 Op 上下文（给 validateOp 那些用例用；直接用 server 那个库） */
function opCtx(): OpContext {
  return { db: openServerDb(), projectKey: PROJECT, sessionId: null, now: () => Date.now() };
}

/** 读一段 SSE 流直到超时（用来验证连接确实建立了 / 收到了某个事件） */
async function readSse(
  url: string,
  init: RequestInit,
  ms: number,
): Promise<{ status: number; body: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  let status = -1;
  let out = "";
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    status = res.status;
    const reader = res.body?.getReader();
    if (!reader) return { status, body: out };
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
      if (out.length > 4000) break;
    }
    return { status, body: out };
  } catch {
    // 超时 abort 会让 read() 抛 —— 这是**预期**的（流本来就不结束），
    // 所以要带着已收到的内容与状态码返回，而不是当成失败。
    return { status, body: out };
  } finally {
    clearTimeout(timer);
  }
}

describe("health：免鉴权端点只回 liveness", () => {
  test("只回 ok 与 version，不带 project 数量 / 事件水位", async () => {
    const res = await fetch(`${base}/api/health`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe("string");
    // 这两个曾经在这里，等于免费告诉别人「这台 server 管着几个项目、事件写到哪了」
    expect(body).not.toHaveProperty("projects");
    expect(body).not.toHaveProperty("head_seq");
  });

  test("源码里不再查 projects / events 计数", () => {
    const src = code("src/server/http.ts");
    const start = src.indexOf('path === "/api/health"');
    const body = src.slice(start, src.indexOf("}", start));
    expect(body).not.toContain("projects");
    expect(body).not.toContain("head_seq");
  });
});

describe("SSE：URL 里不再有 token", () => {
  test("?key= 已被彻底移除（不带任何凭据连 SSE → 401）", async () => {
    const res = await fetch(`${base}/api/stream?project=${PROJECT}&key=${token}&after=0`);
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });

  test("其余端点同样不认 ?key=（只删 SSE 那一条等于没删）", async () => {
    // 这几个端点就是本文件头里那个「已删除」曾经只对 SSE 成立的地方：
    // handleSse 自己在函数体里解析凭据，而 handleRequest 的全局提取里
    // 还有一个 `url.searchParams.get("key")`，对下面每个端点都是活的。
    const probes: Array<[string, RequestInit]> = [
      [`/api/board?project=${PROJECT}&key=${token}`, {}],
      [
        `/api/op?key=${token}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // 凭据只在 query 里，body 里连 project 都不给：必须 401
          body: JSON.stringify({ op: { kind: "task.list", params: {} } }),
        },
      ],
      [`/api/admin/tokens?key=${token}`, {}],
      [`/api/projects?key=${token}`, {}],
    ];
    for (const [path, init] of probes) {
      const res = await fetch(`${base}${path}`, init);
      expect({ path, status: res.status }).toEqual({ path, status: 401 });
      await res.body?.cancel();
    }
  });

  test("header 鉴权在普通端点上照常可用（不是把门焊死了）", async () => {
    const res = await fetch(`${base}/api/board?project=${PROJECT}`, {
      headers: { "X-Kanban-Key": token },
    });
    expect(res.status).toBe(200);
    await res.body?.cancel();
  });

  test("header 鉴权可以连上 SSE（fetch 客户端的路径）", async () => {
    const r = await readSse(
      `${base}/api/stream?project=${PROJECT}&after=0`,
      { headers: { "X-Kanban-Key": token, Accept: "text/event-stream" } },
      1200,
    );
    expect(r.status).toBe(200);
    expect(r.body).toContain("retry:");
  });

  test("票据：换一张 → 能连上 → 只能用一次", async () => {
    const tRes = await fetch(`${base}/api/stream-ticket`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Kanban-Key": token },
      body: JSON.stringify({ project: PROJECT }),
    });
    expect(tRes.status).toBe(200);
    const { data } = (await tRes.json()) as { data: { ticket: string; expires_in_ms: number } };
    expect(data.ticket).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    // 票里不含 token 本身
    expect(data.ticket).not.toContain(token);
    // 短时效
    expect(data.expires_in_ms).toBeGreaterThan(0);
    expect(data.expires_in_ms).toBeLessThanOrEqual(120_000);

    // 第一次能用
    const first = await readSse(
      `${base}/api/stream?project=${PROJECT}&after=0&ticket=${encodeURIComponent(data.ticket)}`,
      {},
      1200,
    );
    expect(first.status).toBe(200);
    expect(first.body).toContain("retry:");

    // 第二次（重放 URL）必须失败 —— 这就是「URL 被记进日志也换不到凭据」的原因
    const replay = await fetch(
      `${base}/api/stream?project=${PROJECT}&after=0&ticket=${encodeURIComponent(data.ticket)}`,
    );
    expect(replay.status).toBe(401);
    await replay.body?.cancel();
  });

  test("票与 project 绑定：拿 A 的票连 B 会被拒", async () => {
    const tRes = await fetch(`${base}/api/stream-ticket`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Kanban-Key": token },
      body: JSON.stringify({ project: PROJECT }),
    });
    const { data } = (await tRes.json()) as { data: { ticket: string } };
    const res = await fetch(
      `${base}/api/stream?project=other&after=0&ticket=${encodeURIComponent(data.ticket)}`,
    );
    expect(res.status).toBe(403);
    await res.body?.cancel();
  });

  test("换票需要有效 token", async () => {
    const res = await fetch(`${base}/api/stream-ticket`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Kanban-Key": "k_deadbeef" },
      body: JSON.stringify({ project: PROJECT }),
    });
    expect(res.status).toBe(401);
  });

  test("源码里不再有把 token 拼进 URL 的地方", () => {
    // Web 端
    const api = code("web/src/lib/api.ts");
    expect(api).not.toMatch(/api\/stream\?[^"']*key=/);
    expect(api).not.toMatch(/searchParams\.set\("key"/);
    // 远程 backend（fetch，可以直接用 header）
    const remote = code("src/core/backend-remote.ts");
    expect(remote).not.toMatch(/searchParams\.set\("key"/);
    // 服务端：整个 http.ts 都不该再从 query 里取凭据。
    //
    // ⚠ 曾经的守卫只切 `handleSse(` 到 `return new Response(stream` 之间的**函数体**，
    //   所以它永远看不见 handleRequest 里那个全局的 `url.searchParams.get("key")`——
    //   而那才是让 `/api/op?key=`、`/api/admin/*?key=` 全部可用的那一处。
    //   判据必须是「整个文件里没有从 query 取凭据」，不是「某个函数体里没有」。
    const http = code("src/server/http.ts");
    expect(http).not.toMatch(/searchParams\.get\(\s*["'`]key["'`]\s*\)/);
  });
});

describe("SSE：长连接要复验凭据", () => {
  test("源码里有复验逻辑，且失效时推 auth_expired 再关流", () => {
    const http = code("src/server/http.ts");
    const start = http.indexOf("function handleSse(");
    const body = http.slice(start, http.indexOf("\n  return new Response(stream", start));
    // 定期重验（不是只在建连时验一次）
    expect(body).toMatch(/reauthIfDue/);
    expect(body).toMatch(/authenticate\(db, token, projectKey, now\)/);
    // 失效时明确通知客户端
    expect(body).toContain("auth_expired");
  });

  test("Web 端收到 auth_expired 后会清掉登录态（否则界面显示在线却收不到事件）", () => {
    const api = code("web/src/lib/api.ts");
    expect(api).toContain("auth_expired");
    const board = code("web/src/components/board.tsx");
    // 订阅时传的**最后一个**回调里清了 token（位置参数，不按名字传）
    expect(board).toMatch(
      /subscribeEventsWithTicket\([\s\S]{0,900}?setTokenState\(null\)[\s\S]{0,120}?setToken\(null\)/,
    );
  });
});

describe("MCP 工具集：宣称的与实际的必须一致（#19）", () => {
  /**
   * 哪些 Op **故意**不通过 MCP 暴露。
   *
   * 曾经 ADR-6 / ADR-10 宣称「三端一致」，而实际 40+ 个 Op 里 MCP 只暴露了 20 个：
   * agent 用 MCP **无法取消任务、无法删除任务、无法管理依赖、无法看计划历史**。
   *
   * 现在的取舍（不是「全补」也不是「全不做」）：
   *   - **补上工作流必需的那批**（release / cancel / reopen / remove / dep.* /
   *     plan.list / plan.history）——它们每一个都对应一个「agent 做不到就会卡住」的场景。
   *   - **剩下的显式列出**并说明走 CLI。管理面（project.* / tokens / rebuild）与
   *     调试面（events.* / doctor --fix）本来就不该由 agent 随手调。
   *
   * 这条测试的作用：**两份清单不许漂移**。将来有人加了工具却忘了更新这份列表，
   * 或者把一个「故意不暴露」的 Op 悄悄补上了，这里会红。
   */
  const DELIBERATELY_NOT_EXPOSED = [
    "project.create",
    "project.rename",
    "project.rotate_key",
    "plan.at",
    "plan.attach",
    "rebuild.check",
    "events.list",
    "events.tail",
    "task.transition",
  ] as const;

  const toolNames = (TOOLS as Array<{ name: string }>).map((t) => t.name);

  test("每个工具都有描述（模型只读描述来推断行为）", () => {
    const noDesc = (TOOLS as Array<{ name: string; description?: string }>).filter((t) => !t.description);
    expect(noDesc.map((t) => t.name)).toEqual([]);
  });

  test("工具名不重复", () => {
    const seen = new Set<string>();
    const dup = toolNames.filter((n) => (seen.has(n) ? true : (seen.add(n), false)));
    expect(dup).toEqual([]);
  });

  test("工作流必需的工具都在（release/cancel/reopen/remove/dep/plan 链）", () => {
    for (const need of [
      "kanban_task_release",
      "kanban_task_cancel",
      "kanban_task_reopen",
      "kanban_task_remove",
      "kanban_task_dep_add",
      "kanban_task_dep_remove",
      "kanban_task_dep_list",
      "kanban_plan_list",
      "kanban_plan_history",
    ]) {
      expect({ tool: need, present: toolNames.includes(need) }).toEqual({ tool: need, present: true });
    }
  });

  test("「故意不暴露」的 Op 确实没有对应的 MCP 工具", () => {
    // 反向：别让 DELIBERATELY_NOT_EXPOSED 变成一份过期的「待办」
    for (const op of DELIBERATELY_NOT_EXPOSED) {
      const guess = `kanban_${op.replace(".", "_")}`;
      expect({ op, tool: guess, present: toolNames.includes(guess) }).toEqual({
        op,
        tool: guess,
        present: false,
      });
    }
  });

  test("README 的 MCP 工具清单与实际工具集一致（文档不许漂移）", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const missing = toolNames.filter((n) => !readme.includes(n));
    // README 只列了主要工具组，所以只要求「列出来的都真实存在」，
    // 而不是「每个工具都在 README 里出现过」——后者会把 README 变成工具清单的副本。
    const documented = [...readme.matchAll(/kanban_[a-z_]+/g)].map((m) => m[0]);
    const phantom = [...new Set(documented)].filter((n) => !toolNames.includes(n));
    expect({ phantom, missingHint: missing.length }).toEqual({ phantom: [], missingHint: missing.length });
  });
});

describe("DELETE /api/admin/tokens/:id：契约要求的那个方法存在（#6）", () => {
  test("DELETE 能吊销 token", async () => {
    const { Database } = await import("bun:sqlite");
    const db = new Database(join(dir, "s.db"));
    const issued = issueToken(db, { role: "project", projects: [PROJECT] }, Date.now());
    db.close();

    const res = await fetch(`${base}/api/admin/tokens/${issued.token.id}`, {
      method: "DELETE",
      headers: { "X-Kanban-Key": token },
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { id: string; revoked_at: number | null } };
    expect(data.id).toBe(issued.token.id);
    expect(data.revoked_at).not.toBeNull();
  });

  test("POST /revoke 别名与 DELETE 行为一致（不会各自漂移）", async () => {
    const { Database } = await import("bun:sqlite");
    const db = new Database(join(dir, "s.db"));
    const a = issueToken(db, { role: "project", projects: [PROJECT] }, Date.now());
    const b = issueToken(db, { role: "project", projects: [PROJECT] }, Date.now());
    db.close();

    const viaPost = await fetch(`${base}/api/admin/tokens/${a.token.id}/revoke`, {
      method: "POST",
      headers: { "X-Kanban-Key": token },
    });
    const viaDelete = await fetch(`${base}/api/admin/tokens/${b.token.id}`, {
      method: "DELETE",
      headers: { "X-Kanban-Key": token },
    });
    expect(viaPost.status).toBe(200);
    expect(viaDelete.status).toBe(200);
    const j1 = (await viaPost.json()) as { data: { revoked_at: number | null } };
    const j2 = (await viaDelete.json()) as { data: { revoked_at: number | null } };
    expect(Boolean(j1.data.revoked_at)).toBe(Boolean(j2.data.revoked_at));
    expect(j1.data.revoked_at).not.toBeNull();
    expect(j2.data.revoked_at).not.toBeNull();
  });

  test("契约文档里写的就是 DELETE（代码与文档不许对不上）", () => {
    const doc = readFileSync(join(ROOT, "docs/plan/002-接口契约.md"), "utf8");
    expect(doc).toMatch(/DELETE\s*\|\s*`\/api\/admin\/tokens\/:id`/);
  });
});

describe("Op 边界校验：validateOp 说清楚做到了什么（#13）", () => {
  /** 造两张卡，好让 limit 钳制有东西可数 */
  function seedTwo(): void {
    const db = openServerDb();
    withTx(
      db,
      (c) => {
        createTask(c, { title: "被数的卡" });
        createTask(c, { title: "第二张" });
      },
      { now: () => Date.now(), projectKey: PROJECT },
    );
    db.close();
  }

  /** 批量造卡（要区分「退回默认页大小 200」与「不限长」时用） */
  function seedOne(title: string): void {
    const db = openServerDb();
    withTx(db, (c) => createTask(c, { title }), { now: () => Date.now(), projectKey: PROJECT });
    db.close();
  }

  test("task.list 的 limit 被钳制（-1 在 SQLite 里是不限长）", () => {
    // ⚠ 这条曾断言「-1 钳到下界 1」。而 `?limit=`（空串）/ `0` / `-1` 全在同一路径上：
    //   「没给页大小」不应该变成「只给 1 条」——那看起来像个合法请求。
    //   现在的契约是：非正数与非数字一样按「没给」处理（用默认页大小 200）。
    // 断言必须能区分「退回默认」与「不限长」，所以造的卡要比默认页大小多。
    for (let i = 0; i < 250; i++) seedOne(`t-${String(i).padStart(4, "0")}`);
    const { data } = executeOp({ kind: "task.list", params: { limit: -1 } }, opCtx());
    // 有界（200），而不是「全部 252 条」；也不是 1
    expect((data as unknown[]).length).toBe(200);
  });

  test("task.list 的非法 status 明确报错，而不是静默返回空列表", () => {
    seedTwo();
    let caught: { code?: number; details?: { reason?: string } } | null = null;
    try {
      executeOp({ kind: "task.list", params: { status: "不存在的状态" as never } }, opCtx());
    } catch (e) {
      caught = e as { code?: number; details?: { reason?: string } };
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe(1);
    expect(caught!.details?.reason).toBe("invalid_status");
  });

  test("合法 status 仍然照常工作（别把闸门关过头）", () => {
    seedTwo();
    const { data } = executeOp({ kind: "task.list", params: { status: "todo" } }, opCtx());
    expect((data as unknown[]).length).toBe(2);
  });

  test("task.transition 的非法 to 明确报错（§13 的另一半）", () => {
    seedTwo();
    let caught: { code?: number; message?: string; details?: Record<string, unknown> } | null = null;
    try {
      executeOp(
        { kind: "task.transition", params: { task_id: "T-0001", to: "nonexistent" as never } },
        opCtx(),
      );
    } catch (e) {
      caught = e as typeof caught;
    }
    expect(caught).not.toBeNull();
    // USAGE（1）而不是 STATE（2）：这是「参数写错了」，不是「转移不合法」
    expect(caught!.code).toBe(1);
    expect(caught!.details?.reason).toBe("invalid_status");
    // 关键：不能附上 legal_transitions —— 那个列表里没有 "nonexistent"，
    // 给了就是一份自相矛盾的建议（详见 ops.ts 里那条注释）
    expect(caught!.details?.legal_transitions).toBeUndefined();
  });

  test("task.transition 的合法 to 仍然放行", () => {
    seedTwo();
    // ⚠ 不用 todo → doing：那条**不在** TRANSITIONS 表里（由 claimTask 特殊处理，
    //   需要原子抢占 + 允许接管僵死持有者）。这里用表里真实存在的 todo → cancelled。
    const { data } = executeOp(
      { kind: "task.transition", params: { task_id: "T-0001", to: "cancelled", reason: "测试" } },
      opCtx(),
    );
    expect((data as { status?: string }).status).toBe("cancelled");
  });

  test("params 必须是对象（数组也不行）", () => {
    expect(() => executeOp({ kind: "task.list", params: [] as never }, opCtx())).toThrow();
  });

  test("注释里的「没做什么」清单与代码一致（不许再漂移）", () => {
    const ops = code("src/core/ops.ts");
    const start = ops.indexOf("function validateOp(");
    const body = ops.slice(start, ops.indexOf("\n}", start));
    // 清单里提到的几项，代码里确实有对应处理
    expect(body).toMatch(/clampInt\(p\.limit/);
    // status 与 to 各一处（§13）：前者拦 task.list，后者拦 task.transition
    expect((body.match(/TASK_STATUSES\.includes/g) ?? []).length).toBe(2);
    // 而「没有」的那些就不该出现（防止清单变成许愿单）
    expect(body).not.toMatch(/title\.length/);
  });
});

describe("文档漂移四处（#12）", () => {
  test("readVersion 读 package.json，不再硬编码", () => {
    const http = code("src/server/http.ts");
    // ⚠ 这里曾断言 `function readVersion()…readPackageVersion()`——那是**实现形状**。
    //   而 `readVersion` 当时已是纯转发（Middle Man），包一层只为留住一段历史注释；
    //   断言形状就会把「该不该存在这个函数」锁死。改判真正的目标：
    //   ① 用的是 core 的单一真相 ② 没有任何硬编码版本号 ③ 别把转发包装加回来。
    expect(http).toMatch(/const version = readPackageVersion\(\)/);
    // 旧版本号不许再出现
    expect(http).not.toMatch(/return "0\.1\.0"/);
    expect(http).not.toMatch(/function readVersion/);
  });

  test("serve --help 里的命令真实存在（admin project add / config init）", () => {
    const cli = code("src/cli.ts");
    // 曾经写着 `agent-kanban project add` 与 `agent-kanban remote set`——两者都不存在
    expect(cli).not.toMatch(/agent-kanban project add/);
    expect(cli).not.toMatch(/agent-kanban remote set/);
    expect(cli).toMatch(/agent-kanban admin project add/);
    expect(cli).toMatch(/agent-kanban config init/);
  });

  test("rebuild 不再写那条事务内无效的 PRAGMA（注释说的是实话）", () => {
    const rb = code("src/core/rebuild.ts");
    expect(rb).not.toMatch(/PRAGMA foreign_keys/);
  });

  test("session.start 不再把 server 的 cwd 当成 agent 的（ternary 两边一样已删）", () => {
    const ops = code("src/core/ops.ts");
    expect(ops).not.toMatch(/ctx\.db \? process\.cwd\(\) : process\.cwd\(\)/);
    // 改成「调用方带自己的 cwd，缺省就不填」。
    // ⚠ 这里曾断言 `reqCwd(ctx)` 出现——那是实现形状，那个函数当时已是单调用点的
    //   纯转发。判语义：优先取 params（本地 CLI 传），否则取 OpContext（远程由
    //   `X-Kanban-Cwd` 头带上来），两者都没有就 undefined（**绝不**退回 process.cwd()）。
    expect(ops).toMatch(/cwd: op\.params\.cwd \|\| ctx\.cwd \|\| undefined/);
  });
});

describe("buildContext / Web canMove 的行为（#10 / #11）", () => {
  test("Web 的 canMove 允许 review → doing（评审打回），但仍禁止其它 → doing", () => {
    const status = readFileSync(join(ROOT, "web/src/lib/status.ts"), "utf8");
    // 闸门拆得准：doing 只能由 claim 进入，唯独 review 打回是合法的
    expect(status).toMatch(/if \(to === "doing"\) \{\s*if \(from === "review"\) return \{ ok: true \}/);
  });

  test("后端确实支持 review → doing（前端放行不是放了个空档）", () => {
    const tasks = readFileSync(join(ROOT, "src/core/tasks.ts"), "utf8");
    // 锚点用「待评审」那段注释而不是 `review: {`——后者在 doing 块里也出现过一次，
    // 会切错区间（第一版就这么写错了，报了个看不懂的失败）。
    const start = tasks.indexOf("// 待评审");
    const review = tasks.slice(start, tasks.indexOf("// 终态", start));
    expect(review).toMatch(/doing: \{ to: "doing", event: "task_reopened" \}/);
  });
});

describe("session cwd：不再把 server 的目录当成 agent 的（#12 附带）", () => {
  test("OpContext.cwd 一路传到 session.start，且缺省时不猜", () => {
    const ops = code("src/core/ops.ts");
    // ⚠ 这里曾断言 `function reqCwd` 存在——同样是实现形状。它当时已是单调用点的
    //   纯转发（Middle Man），删掉后语义一行没变。改判 session.start 分支本身。
    const start = ops.indexOf('case "session.start"');
    expect(start).toBeGreaterThan(-1);
    const body = ops.slice(start, ops.indexOf('case "', start + 10));
    // 真正的目标：远程时 process.cwd() 是 **server** 的目录，绝不能进这个字段
    expect(body).not.toMatch(/process\.cwd/);
    // cwd 已写进 Op 联合类型，所以不需要也不该有「as { cwd?: string }」的逃逸
    expect(body).not.toMatch(/as \{ cwd\?: string \}/);
    expect(body).toMatch(/cwd: op\.params\.cwd \|\| ctx\.cwd \|\| undefined/);

    // 调用方都把 cwd 传上来了
    const ctx = code("src/commands/context.ts");
    expect(ctx).toMatch(/cwd: input\.cwd/);
    const http = code("src/server/http.ts");
    expect(http).toMatch(/X-Kanban-Cwd/);
  });

  test("createSession 不再拿 process.cwd() 猜（那一层是上一条守卫的盲区）", () => {
    // ⚠ 上一条只查了 ops.ts 与 http.ts，而**真正把 server 目录写进库的是
    //   sessions.ts 的 `input.cwd ?? process.cwd()`：ops.ts 已经老老实实传了
    //   undefined，却在下一层被猜回来。探针实测：不带 X-Kanban-Cwd 调 session.start，
    //   库里与响应 JSON 都是 server 进程目录。
    const sessions = code("src/core/sessions.ts");
    expect(sessions).not.toMatch(/input\.cwd\s*\?\?\s*process\.cwd\(\)/);
    // 反向：缺省必须是空串（列是 NOT NULL，空串是这里唯一诚实的“未知”）
    expect(sessions).toMatch(/input\.cwd\s*\?\?\s*""/);
  });

  test("远程 backend 真的把 X-Kanban-Cwd 发出去（这条通道以前是死的）", () => {
    const remote = code("src/core/backend-remote.ts");
    expect(remote).toMatch(/"X-Kanban-Cwd"/);
    // 缺省取**本机** process.cwd()，不是某个写死的值
    expect(remote).toMatch(/this\.cwd = opts\.cwd \?\? process\.cwd\(\)/);
    // withSession 重建时也要带着它（否则换会话身份就把 cwd 丢了）
    expect(remote).toMatch(/cwd: this\.cwd/);
  });

  test("远程 session.start 记的是客户端目录；客户端不带时是空串（行为层）", async () => {
    const start = async (cwd?: string) => {
      const res = await fetch(`${base}/api/op`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Kanban-Key": token,
          ...(cwd ? { "X-Kanban-Cwd": cwd } : {}),
        },
        body: JSON.stringify({
          project: PROJECT,
          op: { kind: "session.start", params: { agent_name: "probe", harness: "test" } },
        }),
      });
      return (await res.json()) as { data?: { id?: string; cwd?: string } };
    };

    const withCwd = await start("C:\\client\\side");
    expect(withCwd.data?.cwd).toBe("C:\\client\\side");
    const without = await start();
    expect(without.data?.cwd).toBe("");
    // 关键：绝不是 server 进程的目录
    expect(without.data?.cwd).not.toBe(process.cwd());
  });
});

describe("真实闭环：签发 → 吊销 → 长连接被切断", () => {
  test("项目级 token 被吊销后，SSE 推 auth_expired（而不是继续推事件）", async () => {
    // 用一个「能通过校验但很快会被吊销」的 token
    const { Database } = await import("bun:sqlite");
    const db = new Database(join(dir, "s.db"));
    const issued = issueToken(db, { role: "project", projects: [PROJECT], name: "tmp" }, NOW);
    db.close();

    // 连上（用票，模拟浏览器路径）
    const tRes = await fetch(`${base}/api/stream-ticket`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Kanban-Key": issued.plaintext },
      body: JSON.stringify({ project: PROJECT }),
    });
    expect(tRes.status).toBe(200);
    const { data } = (await tRes.json()) as { data: { ticket: string } };

    // 起一个读取任务，然后把 token 吊销
    const reading = readSse(
      `${base}/api/stream?project=${PROJECT}&after=0&ticket=${encodeURIComponent(data.ticket)}`,
      {},
      45_000,
    );
    await new Promise((r) => setTimeout(r, 300));

    const db2 = new Database(join(dir, "s.db"));
    revokeToken(db2, issued.token.id, Date.now());
    db2.close();

    const r = await reading;
    // 复验周期是 30s，这个用例最多等 45s；收到 auth_expired 即达标
    expect(r.body).toContain("auth_expired");
  }, 60_000);
});
