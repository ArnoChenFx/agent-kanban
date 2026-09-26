/**
 * RemoteBackend：把 Op 发到云端 server 执行（ADR-10）。
 *
 * 关键点：它**不含任何业务逻辑**。所有判断（状态机、守卫、project 隔离、鉴权）
 * 都在 server 端由 executeOp + 鉴权中间件完成。所以本地/远程行为一致是结构性的。
 *
 * 错误映射：server 返回的 { ok:false, error:{code,...} } 会被还原成同名的 KanbanError，
 * 因此远程模式下 agent 看到的错误码、details、退出码与本地完全相同。
 */

import { ExitCode, ErrorName, KanbanError, type ExitCodeValue } from "./errors.ts";
import type { Backend } from "./backend.ts";
import type { Op } from "./ops.ts";

/** server 响应包络（与契约 §4.0 一致） */
interface OpResponse<T = unknown> {
  ok: boolean;
  data?: T;
  next_actions?: string[];
  error?: { code: number; name: string; message: string; details?: Record<string, unknown> };
}

export interface RemoteBackendOptions {
  server: string;
  projectKey: string;
  apiKey: string;
  sessionId?: string | null;
  now?: () => number;
  /** 请求超时（毫秒），默认 30s */
  timeoutMs?: number;
}

export class RemoteBackend implements Backend {
  readonly mode = "remote" as const;
  readonly projectKey: string;
  private readonly server: string;
  private readonly apiKey: string;
  private readonly sessionId: string | null;
  private readonly nowFn: () => number;
  private readonly timeoutMs: number;

  constructor(opts: RemoteBackendOptions) {
    this.server = opts.server.replace(/\/+$/, "");
    this.projectKey = opts.projectKey;
    this.apiKey = opts.apiKey;
    this.sessionId = opts.sessionId ?? null;
    this.nowFn = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /** 执行 Op：POST /api/op */
  async execute<T = unknown>(op: Op): Promise<T> {
    const response = await this.request<T>("/api/op", {
      method: "POST",
      body: JSON.stringify({ project: this.projectKey, op }),
    });
    return response;
  }

  /**
   * 执行 Op 并取回 next_actions（给 agent 的建议）。
   * 本地版有 executeWithHints，远程版对齐这个能力，否则两种模式输出会不一致。
   */
  async executeWithHints(op: Op): Promise<{ data: unknown; nextActions: string[] }> {
    const result = await this.rawRequest<unknown>("/api/op", {
      method: "POST",
      body: JSON.stringify({ project: this.projectKey, op }),
    });
    return { data: result.data, nextActions: result.next_actions ?? [] };
  }

  /** SSE 事件流（Web 看板与 `kanban watch` 用） */
  async streamEvents(opts: { afterSeq?: number; signal?: AbortSignal } = {}): Promise<ReadableStream<Uint8Array>> {
    const url = new URL(`${this.server}/api/stream`);
    url.searchParams.set("project", this.projectKey);
    url.searchParams.set("key", this.apiKey);
    if (opts.afterSeq !== undefined) url.searchParams.set("after", String(opts.afterSeq));
    return await this.fetchStream(url.toString(), opts.signal);
  }

  close(): void {
    // HTTP 是无状态的，无需关闭
  }

  // ---- 内部 ----

  /** 发请求并解包 data（出错时抛 KanbanError） */
  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const { data } = await this.rawRequest<T>(path, init);
    return data;
  }

  /** 发请求并解包整个包络（保留 next_actions） */
  private async rawRequest<T>(
    path: string,
    init: RequestInit,
  ): Promise<{ data: T; next_actions: string[] }> {
    // project 必须同时出现在 URL 与 body：
    // server 从 URL 读它做鉴权路由（§4.1），并用 body 里的做一致性交叉校验（防"用 A 的 key 操作 B"）
    const url = new URL(`${this.server}${path}`);
    url.searchParams.set("project", this.projectKey);

    const response = await this.fetchWithTimeout(url.toString(), {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-Kanban-Key": this.apiKey,
        ...(this.sessionId ? { "X-Kanban-Session": this.sessionId } : {}),
        ...(init.headers ?? {}),
      },
    });

    const text = await response.text();
    let body: OpResponse<T>;
    try {
      body = JSON.parse(text) as OpResponse<T>;
    } catch {
      // server 返回了非 JSON：通常是反代/网关错误页
      throw KanbanError.state(
        `server 返回了非 JSON 响应（HTTP ${response.status}）`,
        {
          server: this.server,
          status: response.status,
          body_preview: text.slice(0, 300),
          hint: "确认 --server 指向的是 kanban server 而不是反向代理的 404 页面",
        },
      );
    }

    if (!response.ok || !body.ok) {
      throw toKanbanErrorFromResponse(body, response.status, this.server);
    }
    return { data: body.data as T, next_actions: body.next_actions ?? [] };
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw KanbanError.busy(`请求 server 超时（${this.timeoutMs}ms）`, {
          server: this.server,
          hint: "server 可能负载过高或网络不通；可重试",
        });
      }
      // 网络层错误（连不上、DNS 失败）→ 归为 BUSY 让 agent 重试
      throw KanbanError.busy(`无法连接 server：${(err as Error).message}`, {
        server: this.server,
        hint: "确认 --server 地址与网络可达性（浏览器能打开吗）",
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchStream(url: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const response = await fetch(url, { signal, headers: { "X-Kanban-Key": this.apiKey } });
    if (!response.ok || !response.body) {
      throw KanbanError.state(`SSE 连接失败（HTTP ${response.status}）`, {
        server: this.server,
        status: response.status,
      });
    }
    return response.body;
  }
}

/**
 * 把 server 返回的错误还原成同码的 KanbanError。
 *
 * 关键：还原的是**同样的 code 与 details**，所以远程模式下 agent 的分支逻辑
 * （退出码 3 = 冲突该换任务）与本地完全一致。
 */
function toKanbanErrorFromResponse(body: OpResponse, status: number, server: string): KanbanError {
  if (body.error) {
    // 注意：不能用 `code in ExitCode` 判断有效性——ExitCode 的 key 是名字（"USAGE"），
    // 不是数字，`3 in ExitCode` 永远为 false，会把所有错误都降级成 INTERNAL。
    // 这里改为校验数字是否落在已知范围。
    const VALID_CODES: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 7];
    const code = VALID_CODES.includes(body.error.code)
      ? (body.error.code as ExitCodeValue)
      : ExitCode.INTERNAL;
    const KNOWN_NAMES: readonly string[] = [
      "USAGE", "STATE", "CONFLICT", "BUSY", "NOT_INIT", "INTERNAL", "AUTH",
    ];
    const name = (KNOWN_NAMES.includes(body.error.name)
      ? body.error.name
      : "INTERNAL") as keyof typeof ErrorName;
    return new KanbanError(code, name, body.error.message, {
      ...(body.error.details ?? {}),
      server,
    });
  }
  // 没有 error 字段但 HTTP 非 2xx：按状态码兜底
  if (status === 401 || status === 404) {
    return KanbanError.auth("鉴权失败或 project 不存在", { server, status });
  }
  if (status === 503) {
    return KanbanError.busy("server 繁忙，请稍后重试", { server, status });
  }
  return KanbanError.state(`server 返回 HTTP ${status}`, { server, status, body: body as never });
}
