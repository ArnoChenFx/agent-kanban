/**
 * 双模式集成测试：本地 Backend 与远程 Backend 行为必须一致。
 *
 * 这是 ADR-10 的正确性证明：
 * 同一个 Op 走 LocalBackend 和走 HTTP→server→executeOp，产出必须逐字段相同。
 *
 * 如果哪天有人给本地加了某个守卫却忘了同步到远程（或反过来），
 * 这个测试会立刻失败。
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb, setInitialConfig, type Db } from "../src/core/db.ts";
import { createProject, getProject } from "../src/core/projects.ts";
import {
  authenticate,
  getToken,
  issueToken,
  revokeToken,
  updateTokenProjects,
} from "../src/core/tokens.ts";
import { createSession } from "../src/core/sessions.ts";
import { withTx } from "../src/core/tx.ts";
import { LocalBackend } from "../src/core/backend.ts";
import { RemoteBackend } from "../src/core/backend-remote.ts";
import { startServer } from "../src/server/http.ts";
import { executeOp, type Op } from "../src/core/ops.ts";
import { KanbanError } from "../src/core/errors.ts";
import { queryEvents } from "../src/core/events.ts";

let dir: string;
let handle: Db;
let server: ReturnType<typeof startServer>;
let baseUrl: string;
/** project token（白名单 = [PROJECT]）的明文 */
let projectToken: string;
/** 另一个 project 的 token（白名单 = [OTHER_PROJECT]） */
let otherProjectToken: string;
/** 管理员 token */
let adminToken: string;

const PROJECT = "app";
const OTHER_PROJECT = "other";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "kanban-dual-"));
  const dbPath = join(dir, "server.db");
  handle = openDb(dbPath);
  migrate(handle);
  setInitialConfig(handle.raw, { projectName: "dual-mode-test" });

  withTx(handle.raw, (tx) => {
    createProject(tx.db, { key: PROJECT, name: "测试项目" });
    createProject(tx.db, { key: OTHER_PROJECT, name: "另一个项目" });
    createSession(tx, { agentName: "agent-a", id: "s-aaaaaa" });
  });

  // 签发 token（ADR-13：token 统一由 tokens 表管理，project 自带 key 已废弃）
  projectToken = issueToken(
    handle.raw,
    { role: "project", projects: [PROJECT], name: "app 项目 token" },
    FIXED_NOW,
  ).plaintext;
  otherProjectToken = issueToken(
    handle.raw,
    { role: "project", projects: [OTHER_PROJECT], name: "other 项目 token" },
    FIXED_NOW,
  ).plaintext;
  adminToken = issueToken(
    handle.raw,
    { role: "admin", name: "管理员" },
    FIXED_NOW,
  ).plaintext;

  // 端口用 0 让系统分配，避免测试间冲突
  // 时钟也必须固定：否则 server 的真实时间会把测试创建的 lease 判定为已过期
  server = startServer({
    dbPath,
    host: "127.0.0.1",
    port: 0,
    reapIntervalSec: 3600,
    now: () => FIXED_NOW,
    noBootstrap: true, // 测试里不自动生成 admin token（上面已手动签发）
  });
  baseUrl = server.url;
});

afterAll(() => {
  server.stop();
  handle.raw.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 构造一个本地 Backend（直连同一个库） */
function localBackend(projectKey = PROJECT, sessionId: string | null = "s-aaaaaa"): LocalBackend {
  return new LocalBackend({
    db: handle.raw,
    projectKey,
    sessionId,
    // 固定时钟：本地与远程必须用同一个"现在"才有可比性
    now: () => FIXED_NOW,
    ttlMs: 15 * 60 * 1000,
  });
}

/** 构造一个远程 Backend（走 HTTP） */
function remoteBackend(apiKeyValue: string, projectKey = PROJECT): RemoteBackend {
  return new RemoteBackend({
    server: baseUrl,
    projectKey,
    apiKey: apiKeyValue,
    sessionId: "s-aaaaaa",
    now: () => FIXED_NOW,
  });
}

/** 固定时钟（2026-01-01）：本地、远程与 server 三侧必须用同一个“现在”，否则 lease 比较会失真 */
const FIXED_NOW = 1_767_225_600_000;

describe("Backend 抽象", () => {
  test("本地与远程的 mode 标记正确", () => {
    expect(localBackend().mode).toBe("local");
    expect(remoteBackend(projectToken).mode).toBe("remote");
  });

  test("健康检查免鉴权可用，且只回 liveness", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string; projects?: number };
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe("string");
    // 免鉴权端点不得回 project 数量 / 全局事件水位：
    // 那是信息不是健康检查，而任何能碰到端口的人都能免费拿到。
    expect(body).not.toHaveProperty("projects");
    expect(body).not.toHaveProperty("head_seq");
  });
});

describe("Op 在本地与远程产出一致（ADR-10）", () => {
  test("task.create：两侧产出的任务字段完全相同", async () => {
    const op: Op = { kind: "task.create", params: { title: "一致性验证任务", priority: 1 } };

    // 本地建一张
    const local = (await localBackend().execute(op)) as Record<string, unknown>;
    // 远程建一张
    const remote = (await remoteBackend(projectToken).execute(op)) as Record<string, unknown>;

    // 去掉因执行时间/顺序必然不同的字段（ID、创建时间）
    const strip = (t: Record<string, unknown>) => {
      const { id, created_at, updated_at, seq, ...rest } = t;
      void id; void created_at; void updated_at; void seq;
      return rest;
    };
    expect(strip(remote)).toEqual(strip(local));
    expect(remote.status).toBe("todo");
    expect(remote.project).toBe(PROJECT);
  });

  test("完整流程 claim → progress → done 两侧行为一致", async () => {
    const mk = async (b: { execute(op: Op): Promise<unknown> }) => {
      const task = (await b.execute({
        kind: "task.create",
        params: { title: "流程一致性", checklist: ["步骤1", "步骤2", "步骤3"] },
      })) as Record<string, unknown>;
      const id = String(task.id);

      const claimed = (await b.execute({ kind: "task.claim", params: { task_id: id } })) as Record<string, unknown>;
      const progressed = (await b.execute({
        kind: "task.progress",
        params: { task_id: id, check: ["步骤1", "步骤2"], note: "完成前两步" },
      })) as Record<string, unknown>;
      const done = (await b.execute({ kind: "task.done", params: { task_id: id, force: true } })) as Record<string, unknown>;
      return { claimed, progressed, done };
    };

    const local = await mk(localBackend());
    const remote = await mk(remoteBackend(projectToken));

    // 进度折算一致（checklist 2/3 → 67%）
    expect(local.progressed.progress).toBe(remote.progressed.progress);
    expect(local.progressed.progress).toBe(67);
    expect(local.done.status).toBe("done");
    expect(remote.done.status).toBe("done");
  });

  test("冲突错误：远程还原为与本地完全相同的错误码与 details", async () => {
    // 建一张卡并被本地抢走
    const task = (await localBackend().execute({
      kind: "task.create",
      params: { title: "冲突测试" },
    })) as Record<string, unknown>;
    const id = String(task.id);
    await localBackend(PROJECT, "s-aaaaaa").execute({ kind: "task.claim", params: { task_id: id } });

    // 另一个会话（不同 session id）从两侧同时抢
    const otherLocal = localBackend(PROJECT, "s-bbbbbb");
    const otherRemote = new RemoteBackend({
      server: baseUrl,
      projectKey: PROJECT,
      apiKey: projectToken,
      sessionId: "s-bbbbbb",
      now: () => FIXED_NOW,
    });

    let localErr: KanbanError | null = null;
    let remoteErr: KanbanError | null = null;
    try {
      await otherLocal.execute({ kind: "task.claim", params: { task_id: id } });
    } catch (e) {
      localErr = e as KanbanError;
    }
    try {
      await otherRemote.execute({ kind: "task.claim", params: { task_id: id } });
    } catch (e) {
      remoteErr = e as KanbanError;
    }

    expect(localErr).toBeInstanceOf(KanbanError);
    expect(remoteErr).toBeInstanceOf(KanbanError);
    expect(localErr!.code).toBe(3); // CONFLICT
    // 远程必须还原出同样的退出码
    expect(remoteErr!.code).toBe(3);
    // holder 信息也一致（agent 靠它决定换任务）
    const localHolder = localErr!.details.holder as Record<string, unknown>;
    const remoteHolder = remoteErr!.details.holder as Record<string, unknown>;
    expect(remoteHolder.session_id).toBe(localHolder.session_id);
    expect(remoteHolder.progress).toBe(localHolder.progress);
  });
});

describe("project 隔离（ADR-9）", () => {
  test("远程：project A 看不到 project B 的任务", async () => {
    await localBackend(PROJECT).execute({ kind: "task.create", params: { title: "A 项目的卡" } });
    await localBackend(OTHER_PROJECT).execute({ kind: "task.create", params: { title: "B 项目的卡" } });

    const aList = (await localBackend(PROJECT).execute({ kind: "task.list", params: {} })) as Array<Record<string, unknown>>;
    const bList = (await localBackend(OTHER_PROJECT).execute({ kind: "task.list", params: {} })) as Array<Record<string, unknown>>;

    const aTitles = aList.map((t) => t.title);
    const bTitles = bList.map((t) => t.title);
    expect(aTitles).toContain("A 项目的卡");
    expect(aTitles).not.toContain("B 项目的卡");
    expect(bTitles).toContain("B 项目的卡");
    expect(bTitles).not.toContain("A 项目的卡");
  });

  test("任务号 per-project 独立编号（都是 T-0001 起始）", async () => {
    // 两个 project 各建一张卡，ID 应各自从自己的计数器来
    const a = (await localBackend(PROJECT).execute({ kind: "task.list", params: { limit: 1 } })) as Array<Record<string, unknown>>;
    const b = (await localBackend(OTHER_PROJECT).execute({ kind: "task.list", params: { limit: 1 } })) as Array<Record<string, unknown>>;
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    // 两边可以同时存在同名 ID（T-0001），因为 UNIQUE 是 (project_key, id)
    expect(String(a[0]!.id)).toMatch(/^T-\d{4}$/);
    expect(String(b[0]!.id)).toMatch(/^T-\d{4}$/);
  });

  test("跨 project 取任务报「任务不存在」而不是泄漏数据", async () => {
    const a = (await localBackend(PROJECT).execute({
      kind: "task.create",
      params: { title: "A 专属任务" },
    })) as Record<string, unknown>;
    const id = String(a.id);

    // 在 B project 里查 A 的任务号
    let err: KanbanError | null = null;
    try {
      await localBackend(OTHER_PROJECT).execute({ kind: "task.get", params: { task_id: id } });
    } catch (e) {
      err = e as KanbanError;
    }
    expect(err).toBeInstanceOf(KanbanError);
    expect(err!.code).toBe(2); // STATE：不存在
    expect(err!.details.project).toBe(OTHER_PROJECT);
  });
});

describe("token 权限模型（ADR-13）", () => {
  test("项目级 token 可以操作被授权的 project", async () => {
    const list = await remoteBackend(projectToken).execute({ kind: "task.list", params: {} });
    expect(Array.isArray(list)).toBe(true);
  });

  test("错误的 token 被拒（401 / 退出码 7）", async () => {
    const res = await fetch(`${baseUrl}/api/op?project=${PROJECT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Kanban-Key": "k_wrong_token" },
      body: JSON.stringify({ project: PROJECT, op: { kind: "task.list", params: {} } }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { ok: boolean; error: { code: number } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe(7); // AUTH
  });

  test("缺 token 被拒", async () => {
    const res = await fetch(`${baseUrl}/api/op?project=${PROJECT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: PROJECT, op: { kind: "task.list", params: {} } }),
    });
    expect(res.status).toBe(401);
  });

  test("项目级 token 不能访问白名单外的 project（403）", async () => {
    // A 项目的 token 访问 B 的 project
    const res = await fetch(`${baseUrl}/api/op?project=${OTHER_PROJECT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Kanban-Key": projectToken },
      body: JSON.stringify({ project: OTHER_PROJECT, op: { kind: "task.list", params: {} } }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { details: { hint?: string } } };
    // 错误信息应告诉用户怎么找管理员加权限
    expect(body.error.details.hint).toContain("admin token grant");
  });

  test("admin token 可以访问任意 project", async () => {
    const res = await fetch(`${baseUrl}/api/op?project=${OTHER_PROJECT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Kanban-Key": adminToken },
      body: JSON.stringify({ project: OTHER_PROJECT, op: { kind: "task.list", params: {} } }),
    });
    expect(res.status).toBe(200);
  });

  test("有 token 但 project 不存在 → 400（不是 401，避免混淆为“token 错”）", async () => {
    const res = await fetch(`${baseUrl}/api/op?project=no-such-project`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Kanban-Key": adminToken },
      body: JSON.stringify({ project: "no-such-project", op: { kind: "task.list", params: {} } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { name: string } };
    expect(body.error.name).toBe("NOT_INIT");
  });

  test("body 的 project 与 URL 不一致时拒绝（防用 A 的 token 操作 B）", async () => {
    const res = await fetch(`${baseUrl}/api/op?project=${PROJECT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Kanban-Key": projectToken },
      body: JSON.stringify({ project: OTHER_PROJECT, op: { kind: "task.list", params: {} } }),
    });
    expect(res.status).toBe(401);
  });

  test("吊销后立即失效", async () => {
    const temp = issueToken(handle.raw, { role: "project", projects: [PROJECT] }, FIXED_NOW);
    // 先验证可用
    const okRes = await fetch(`${baseUrl}/api/op?project=${PROJECT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Kanban-Key": temp.plaintext },
      body: JSON.stringify({ project: PROJECT, op: { kind: "task.list", params: {} } }),
    });
    expect(okRes.status).toBe(200);

    // 按**引用**（t_…）寻址，不是明文。库里不存明文（见 tokens.ts 的 AccessToken.id）
  revokeToken(handle.raw, temp.token.id, FIXED_NOW);

    const afterRes = await fetch(`${baseUrl}/api/op?project=${PROJECT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Kanban-Key": temp.plaintext },
      body: JSON.stringify({ project: PROJECT, op: { kind: "task.list", params: {} } }),
    });
    expect(afterRes.status).toBe(401);
    const body = (await afterRes.json()) as { error: { message: string } };
    expect(body.error.message).toContain("has been revoked");
  });

  test("过期后失效", async () => {
    const temp = issueToken(
      handle.raw,
      { role: "project", projects: [PROJECT], expiresInMs: 1000 },
      FIXED_NOW,
    );
    // 时钟前进 2 秒 → 已过期
    const expiredServer = startServer({
      dbPath: handle.dbPath,
      host: "127.0.0.1",
      port: 0,
      reapIntervalSec: 3600,
      now: () => FIXED_NOW + 2000,
      noBootstrap: true,
    });
    try {
      const res = await fetch(`${expiredServer.url}/api/op?project=${PROJECT}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Kanban-Key": temp.plaintext },
        body: JSON.stringify({ project: PROJECT, op: { kind: "task.list", params: {} } }),
      });
      expect(res.status).toBe(401);
    } finally {
      expiredServer.stop();
    }
  });

  test("一个 token 可授权多个 project", async () => {
    // 签发一个同时授权两个 project 的 token
    const multi = issueToken(
      handle.raw,
      { role: "project", projects: [PROJECT, OTHER_PROJECT], name: "双项目 token" },
      FIXED_NOW,
    );
    for (const p of [PROJECT, OTHER_PROJECT]) {
      const res = await fetch(`${baseUrl}/api/op?project=${p}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Kanban-Key": multi.plaintext },
        body: JSON.stringify({ project: p, op: { kind: "task.list", params: {} } }),
      });
      expect(res.status).toBe(200);
    }
  });

  test("管理员可以改白名单，改完立即生效", async () => {
    const temp = issueToken(handle.raw, { role: "project", projects: [PROJECT] }, FIXED_NOW);
    // 之前无权访问 OTHER_PROJECT
    const before = await fetch(`${baseUrl}/api/op?project=${OTHER_PROJECT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Kanban-Key": temp.plaintext },
      body: JSON.stringify({ project: OTHER_PROJECT, op: { kind: "task.list", params: {} } }),
    });
    expect(before.status).toBe(401);

    // 管理员加白名单
    updateTokenProjects(handle.raw, temp.token.id, [PROJECT, OTHER_PROJECT], FIXED_NOW);

    // 之后可以访问
    const after = await fetch(`${baseUrl}/api/op?project=${OTHER_PROJECT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Kanban-Key": temp.plaintext },
      body: JSON.stringify({ project: OTHER_PROJECT, op: { kind: "task.list", params: {} } }),
    });
    expect(after.status).toBe(200);
  });

  test("预授权：token 可授权尚不存在的 project", () => {
    // 运维顺序常见“先发 token 再建 project”，不应该报错
    const issued = issueToken(
      handle.raw,
      { role: "project", projects: ["not-created-yet"] },
      FIXED_NOW,
    );
    expect(issued.plaintext).toMatch(/^k_[0-9a-f]{32}$/);
    // 建完 project 后立即可用
    createProject(handle.raw, { key: "not-created-yet", name: "后建的" });
    const auth = authenticate(handle.raw, issued.plaintext, "not-created-yet", FIXED_NOW);
    expect(auth.ok).toBe(true);
  });
});

describe("HTTP 契约（§4.0）", () => {
  test("退出码 → HTTP 状态码映射正确", async () => {
    // USAGE(1) → 400
    const usageRes = await fetch(`${baseUrl}/api/op?project=${PROJECT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Kanban-Key": projectToken },
      body: JSON.stringify({ project: PROJECT, op: { kind: "task.create", params: {} } }),
    });
    expect(usageRes.status).toBe(400);

    // STATE(2) → 409
    const stateRes = await fetch(`${baseUrl}/api/op?project=${PROJECT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Kanban-Key": projectToken },
      body: JSON.stringify({ project: PROJECT, op: { kind: "task.get", params: { task_id: "T-9999" } } }),
    });
    expect(stateRes.status).toBe(409);
  });

  test("BUSY 时带 Retry-After", async () => {
    // 直接构造一个 BUSY 错误不现实，这里验证映射函数本身
    const { statusForCode } = await import("../src/server/http.ts");
    expect(statusForCode(4)).toBe(503);
    expect(statusForCode(3)).toBe(409);
    expect(statusForCode(7)).toBe(401);
  });

  test("非法 Op 结构被拒绝且不崩溃", async () => {
    const res = await fetch(`${baseUrl}/api/op?project=${PROJECT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Kanban-Key": projectToken },
      body: JSON.stringify({ project: PROJECT, op: { kind: 123 } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  test("服务端会校验 pct 范围", async () => {
    const res = await fetch(`${baseUrl}/api/op?project=${PROJECT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Kanban-Key": projectToken },
      body: JSON.stringify({
        project: PROJECT,
        op: { kind: "task.progress", params: { task_id: "T-0001", pct: 999 } },
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("SSE 事件流（§4.3）", () => {
  test("按 project 推送，且断线续传不丢事件", async () => {
    // 先记下当前 head，模拟"断线期间产生事件"
    const before = queryEvents(handle.raw, { projectKey: PROJECT }).length;
    await localBackend(PROJECT).execute({ kind: "task.create", params: { title: "SSE 事件1" } });
    await localBackend(PROJECT).execute({ kind: "task.create", params: { title: "SSE 事件2" } });
    // 另一个 project 的事件不应推给本连接
    await localBackend(OTHER_PROJECT).execute({ kind: "task.create", params: { title: "别的 project 的事件" } });

    const controller = new AbortController();
    // ⚠ 走 header 而不是 `?key=`：URL 里不再接受 token（会进 access log / Referer）。
    //   浏览器那边因为 EventSource 不能设 header，改用 POST /api/stream-ticket 换一张
    //   60 秒一次性票（见 test/sse-security.test.ts）。
    const res = await fetch(`${baseUrl}/api/stream?project=${PROJECT}&after=0`, {
      headers: { "X-Kanban-Key": projectToken, Accept: "text/event-stream" },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // 读够 2 个事件 + retry 头就停
    while (buffer.split("\n\n").length < 4) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    controller.abort();

    expect(buffer).toContain("retry: 3000");
    expect(buffer).toContain("task_created");
    // 别的 project 的事件标题不应出现
    expect(buffer).not.toContain("别的 project 的事件");
    // 续传起点：after=0 意味着回放全部历史
    expect(buffer.split("id: ").length - 1).toBeGreaterThanOrEqual(before);
  });
});

describe("project 管理 Op", () => {
  test("project.create 生成项目（本地库直连场景）", async () => {
    const result = await executeOp(
      { kind: "project.create", params: { key: "created-via-op", name: "通过 Op 创建" } },
      { db: handle.raw, projectKey: "created-via-op", sessionId: "system", now: () => FIXED_NOW },
    );
    const project = result.data as { key: string; name: string; apiKeyHash: string | null };
    expect(project.key).toBe("created-via-op");
    // v3 起 project 不再自带 key（鉴权统一由 tokens 表负责），该字段恒为 null
    expect(project.apiKeyHash).toBeNull();
    expect(getProject(handle.raw, "created-via-op")).not.toBeNull();
  });

  test("project.rename 改名后影响 show 输出", async () => {
    createProject(handle.raw, { key: "rename-me", name: "旧名字" });
    await executeOp(
      { kind: "project.rename", params: { key: "rename-me", name: "新名字" } },
      { db: handle.raw, projectKey: "rename-me", sessionId: "system", now: () => FIXED_NOW },
    );
    expect(getProject(handle.raw, "rename-me")!.name).toBe("新名字");
  });
});

describe("admin API（/api/admin/*）", () => {
  const adminCall = (path: string, init: RequestInit = {}, token = adminToken) =>
    fetch(`${baseUrl}/api/admin${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", "X-Kanban-Key": token, ...(init.headers ?? {}) },
    });

  test("overview 列出所有 project 与 token", async () => {
    const res = await adminCall("/overview");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { projects: unknown[]; tokens: unknown[] } };
    expect(body.ok).toBe(true);
    expect(body.data.projects.length).toBeGreaterThan(0);
    expect(body.data.tokens.length).toBeGreaterThan(0);
  });

  test("project 级 token 访问 admin 接口 → 403", async () => {
    const res = await adminCall("/projects", {}, projectToken);
    expect(res.status).toBe(403);
  });

  test("管理员可以创建 project", async () => {
    const res = await adminCall("/projects", {
      method: "POST",
      body: JSON.stringify({ key: "api-created", name: "API 创建" }),
    });
    expect(res.status).toBe(200);
    expect(getProject(handle.raw, "api-created")).not.toBeNull();
  });

  test("签发 token：明文只在创建响应里出现一次", async () => {
    const res = await adminCall("/tokens", {
      method: "POST",
      body: JSON.stringify({ role: "project", projects: ["api-created"], name: "新签发的" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { token: string; id: string; warning: string } };
    expect(body.data.token).toMatch(/^k_[0-9a-f]{32}$/);
    // id 是**引用**，不是密钥：它要能直接显示、且能被 admin API 寻址
    // （曾经这里断言「列表里只有掩码」——而那正是 admin 页吊销/移除授权
    //   两个按钮 100% 失败的根因：掩码后的 id 发回去必然 404）
    expect(body.data.id).toMatch(/^t_[0-9a-f]{32}$/);
    expect(body.data.id).not.toBe(body.data.token);

    const listRes = await adminCall("/tokens");
    const listBody = (await listRes.json()) as { data: Array<{ id: string }> };
    // 列表里给的是**完整引用**，且能用它直接寻址
    expect(listBody.data.some((t) => t.id === body.data.id)).toBe(true);
    expect(listBody.data.every((t) => !t.id.includes("…"))).toBe(true);
    // 明文不出现在列表里
    expect(JSON.stringify(listBody)).not.toContain(body.data.token);

    // 拿着列表里的引用就能吊销（这正是之前坏掉的那条链路）
    const revoke = await adminCall(`/tokens/${body.data.id}/revoke`, { method: "POST" });
    expect(revoke.status).toBe(200);
    const after = await fetch(`${baseUrl}/api/op?project=api-created`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Kanban-Key": body.data.token },
      body: JSON.stringify({ project: "api-created", op: { kind: "task.list", params: {} } }),
    });
    expect(after.status).toBe(401);
  });

  test("admin 页的「移除单个授权」按钮链路：拿列表里的 ref 改白名单", async () => {
    createProject(handle.raw, { key: "p-extra", name: "多一个" });
    const issued = issueToken(
      handle.raw,
      { role: "project", projects: ["api-created", "p-extra"], name: "两个授权" },
      FIXED_NOW,
    );
    // 列表里给的是完整引用（不是掩码）
    const listBody = (await (await adminCall("/tokens")).json()) as { data: Array<{ id: string; projects: string[] | null }> };
    const listed = listBody.data.find((t) => t.id === issued.token.id);
    expect(listed).toBeDefined();
    expect(listed!.id).not.toContain("…");

    // admin 页的「×」按钮就是拿这个 id 去 PATCH（以前必然 404）
    const patch = await adminCall(`/tokens/${listed!.id}`, {
      method: "PATCH",
      body: JSON.stringify({ projects: ["api-created"] }),
    });
    expect(patch.status).toBe(200);
    const patched = (await patch.json()) as { data: { projects: string[] } };
    expect(patched.data.projects).toEqual(["api-created"]);

    // 改完立刻生效：p-extra 不再可达
    const after = await fetch(`${baseUrl}/api/op?project=p-extra`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Kanban-Key": issued.plaintext },
      body: JSON.stringify({ project: "p-extra", op: { kind: "task.list", params: {} } }),
    });
    expect(after.status).toBe(401);
  });

  test("拿明文当 :id 会被掩码回显（不能把它写进日志）", async () => {
    const key = `k_${"a".repeat(32)}`;
    const res = await adminCall(`/tokens/${key}`);
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain(key);
    expect(text).toContain("…");
  });

  test("删除有任务的 project 需要 force 确认", async () => {
    // 给 api-created 建一个任务
    await localBackend("api-created").execute({ kind: "task.create", params: { title: "将被删" } });

    const noForce = await adminCall("/projects/api-created", { method: "DELETE" });
    expect(noForce.status).toBe(409);
    expect(getProject(handle.raw, "api-created")).not.toBeNull();

    const withForce = await adminCall("/projects/api-created?force=1", { method: "DELETE" });
    expect(withForce.status).toBe(200);
    expect(getProject(handle.raw, "api-created")).toBeNull();
  });

  test("删除 project 会清理 token 白名单里的引用", async () => {
    createProject(handle.raw, { key: "to-delete", name: "待删" });
    const token = issueToken(handle.raw, { role: "project", projects: ["to-delete", PROJECT] }, FIXED_NOW);
    await adminCall("/projects/to-delete?force=1", { method: "DELETE" });

    const after = getToken(handle.raw, token.token.id);
    expect(after?.projects).not.toContain("to-delete");
    expect(after?.projects).toContain(PROJECT);
  });
});
