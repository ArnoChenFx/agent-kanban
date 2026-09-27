/**
 * MCP server：把看板暴露成 agent 可调用的工具。
 *
 * 传输方式是 stdio（契约 §3）——agent harness 把它当子进程启动，
 * 双向 JSON-RPC。这里不监听端口、不引入 HTTP。
 *
 * 分层（ADR-6）：本文件只做协议握手与工具注册，所有行为在 core/ops。
 * 想知道某个工具到底做了什么，去看它对应的 Op。
 *
 * ## 一条硬约束：stdout 是协议通道
 *
 * MCP 走 stdio，stdout 上跑的是 JSON-RPC。任何一行日志写进去都会让
 * 客户端解析失败，而且报错通常出现在客户端而不是服务端，极难定位。
 * 所以本文件与它调用的链路上，**诊断信息一律走 stderr**。
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Backend } from "../core/backend.ts";
import type { Op } from "../core/ops.ts";
import { closeCtx, openCtx } from "../commands/context.ts";
import { readPackageVersion } from "../core/version.ts";
import { TOOLS, callTool, type ToolEnvelope } from "./tools.ts";

/**
 * 持有"当前会话身份"的执行器。
 *
 * 为什么要可变：CLI 每次调用是独立进程，sessionId 从参数读就够了；
 * MCP server 是**长驻进程**，agent 先 session_start 拿到 id，之后二十个工具
 * 都要带这个身份。身份存在构造参数里就没法中途换。
 *
 * 用 backend.withSession() 换而不是直接改字段：Backend 允许并发调用，
 * 就地改 sessionId 会让另一个在飞中的请求用错身份。
 */
class SessionRunner {
  private backend: Backend;

  constructor(backend: Backend) {
    this.backend = backend;
  }

  /**
   * 当前会话 id。
   *
   * 从 backend 内部字段读：LocalBackend/RemoteBackend 都把 sessionId 存成
   * 私有字段，接口不暴露。诊断时需要它，所以用一次运行期断言拿。
   */
  get sessionId(): string | null {
    return (this.backend as unknown as { sessionId: string | null }).sessionId;
  }

  setSession(sessionId: string | null): void {
    this.backend = this.backend.withSession(sessionId);
  }

  async execute(op: Op): Promise<{ data: unknown; nextActions: string[] }> {
    return this.backend.executeWithHints(op);
  }
}

/**
 * 启动 stdio MCP server。
 *
 * @param opts 与 CLI 同名参数；实际取值仍走 openCtx（配置文件 > 环境变量 > 参数）
 */
export async function runMcpServer(
  opts: {
    db?: string | undefined;
    project?: string | undefined;
    server?: string | undefined;
    key?: string | undefined;
  } = {},
): Promise<void> {
  const ctx = openCtx({
    json: true,
    dbPath: opts.db,
    server: opts.server,
    project: opts.project,
    key: opts.key,
  });

  const runner = new SessionRunner(ctx.backend);
  const server = new McpServer(
    { name: "agent-kanban", version: readPackageVersion() },
    { capabilities: { tools: {} } },
  );

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: zodFromJsonSchema(tool.inputSchema),
      },
      // MCP SDK 的 handler 是 async；工具层是同步的（本地直调 Op），
      // 这里包一层 Promise 即可，不必把整个工具层改成异步。
      async (args: Record<string, unknown>) => {
        // zod 会把未声明的键**静默剥离**，模型拼错参数名时调用照常成功、
        // 参数却被丢掉——CLI 端的规矩是“拼错参数必须被告知”，这里对齐：
        // 先对照契约 schema 把陌生键显式拒掉。
        const declared = new Set(Object.keys(tool.inputSchema.properties));
        const stray = Object.keys(args ?? {}).filter((k) => !declared.has(k));
        if (stray.length > 0) {
          return toMcpResult({
            ok: false,
            error: {
              code: 1,
              name: "USAGE",
              message: `unknown argument(s) for ${tool.name}: ${stray.map((s) => JSON.stringify(s)).join(", ")}`,
            },
          });
        }
        return toMcpResult(await runOne(tool.name, args, runner));
      },
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // 诊断走 stderr（见文件头的硬约束）
  process.stderr.write(
    [
      `agent-kanban MCP server ready — ${TOOLS.length} tools`,
      `project: ${ctx.project.key} · mode: ${ctx.remote ? "remote" : "local"}`,
      `start with: kanban_session_start → kanban_bootstrap`,
      "",
    ].join("\n"),
  );

  const shutdown = () => {
    closeCtx(ctx);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  transport.onclose = shutdown;
}

/**
 * 执行单个工具，并把 session_start 的结果绑到后续调用上。
 *
 * 放在这里而不是 handler 里，是因为"新会话"是跨调用的状态变化，
 * 每个 handler 各自处理一遍会漏掉某个工具。
 */
async function runOne(
  name: string,
  args: Record<string, unknown>,
  runner: SessionRunner,
): Promise<ToolEnvelope> {
  const envelope = await callTool(name, args, { execute: (op) => runner.execute(op) });
  if (name === "kanban_session_start") {
    const id = (envelope.data as { id?: string } | undefined)?.id;
    if (id) runner.setSession(id);
  }
  return envelope;
}

/** 调试用：把内部状态写成一条 stderr 注释（不进协议通道） */
export function debugState(runner: SessionRunner): string {
  return `sessionId=${String(runner.sessionId)}`;
}

/** 包络 → MCP content 形态 */
function toMcpResult(envelope: ToolEnvelope) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(envelope) }],
    isError: !envelope.ok,
  };
}

/**
 * 把契约里的 JSON Schema 转成 zod（MCP SDK 接受 zod）。
 *
 * 为什么要转：契约 §3.2 写的是 JSON Schema（人类可读、跨语言），
 * SDK 要 zod。两份手写必然漂，所以从 JSON Schema 单向生成。
 *
 * 只处理契约实际用到的关键字：properties / type / items / description / enum。
 * enum 不转的话（曾经漏了）`plan.list` 的 scope/status 降级成任意 string，
 * 非法值被 tools.ts 静默归为 undefined 而不是报错——正是 CLI 端
 * “拼错参数必须被告知”规矩在 MCP 面的缺口。
 */
function zodFromJsonSchema(schema: {
  properties: Record<string, unknown>;
  required?: string[];
}): z.ZodRawShape {
  // 先用可变对象攒，最后一次性转成 SDK 要的只读 shape
  const shape: Record<string, z.ZodTypeAny> = {};
  const required = new Set(schema.required ?? []);
  for (const [key, raw] of Object.entries(schema.properties)) {
    const prop = raw as {
      type?: string; items?: { type?: string }; description?: string; enum?: string[];
    };
    let zodType: z.ZodTypeAny;
    if (prop.enum && prop.enum.length > 0) {
      zodType = z.enum(prop.enum as [string, ...string[]]);
    } else {
      switch (prop.type) {
        case "number":
          zodType = z.number();
          break;
        case "boolean":
          zodType = z.boolean();
          break;
        case "array":
          zodType = z.array(prop.items?.type === "number" ? z.number() : z.string());
          break;
        default:
          zodType = z.string();
      }
    }
    if (prop.description) zodType = zodType.describe(prop.description);

    // ⚠ zod 的 object 默认**所有字段必填**。不加 .optional() 的话，
    //   agent 每次调用都会因为“少传一个可选参数”被 SDK 拒掉。
    //   required 数组才是唯一可信的必填依据。
    if (!required.has(key)) zodType = zodType.optional();

    shape[key] = zodType;
  }
  return shape as z.ZodRawShape;
}
