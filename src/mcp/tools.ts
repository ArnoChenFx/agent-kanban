/**
 * MCP 工具层：把 core 的 Op 协议翻译成 MCP 工具。
 *
 * ## 为什么不直接调 core 函数
 *
 * 因为 Op 已经是「本地与远程一致」的那一层（ADR-10）。MCP 走 Op，
 * 就自动获得与 CLI 完全相同的行为，而不需要在第三个接入面上再实现一遍
 * 状态机、租约、交接。ADR-6 说工具是薄封装，这里就是字面意义上的薄封装：
 * 本文件不写任何业务分支，只做「参数改名 → 构造 Op → 取包络」。
 *
 * ## 契约对齐
 *
 * 工具名、参数名、包络结构见 docs/plan/002-接口契约.md §3.2 / §3.3。
 * 改动前先改契约。
 */

import type { Op } from "../core/ops.ts";
import { KanbanError, ExitCode, type ExitCodeValue } from "../core/errors.ts";
import { TASK_STATUSES, type TaskStatus } from "../core/types.ts";

/** 状态白名单：工具入口先拦一次，避免非法状态一路带到 SQL */
const TASK_STATUS_SET = new Set<string>(TASK_STATUSES);

/**
 * 毫秒 → 时长字符串（"2h" / "90m" / "3600s"），Op 的 ttl 收这种写法。
 *
 * 为什么保留换算而不是让 Op 直接收数字：CLI 那边 `--ttl 2h` 已经是成熟写法，
 * 改 Op 会连累 CLI；MCP 用毫秒是因为模型对数字更敏感。两边各自保持顺手。
 */
function msToTtl(ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined;
  if (!Number.isFinite(ms) || ms <= 0) {
    throw KanbanError.usage("ttl_ms must be a positive number of milliseconds");
  }
  const s = Math.round(ms / 1000);
  if (s % 3600 === 0) return `${s / 3600}h`;
  if (s % 60 === 0) return `${s / 60}m`;
  return `${s}s`;
}

/** MCP 工具的 JSON Schema（只写 MCP 需要的那部分，语义细节在 description） */
export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** 统一包络（契约 §3.3） */
export interface ToolEnvelope {
  ok: boolean;
  data?: unknown;
  error?: {
    code: number;
    name: string;
    message: string;
    hint?: string;
    holder?: unknown;
    legal_transitions?: unknown;
    [k: string]: unknown;
  };
  next_actions?: string[];
}

/** 执行工具所需的依赖（由 server 注入，本文件不关心它从哪来） */
export interface ToolDeps {
  /**
   * 执行一个 Op。
   *
   * 异步的原因：本地 Op 是同步的，但远程 Backend 走 HTTP。
   * 工具层不肯为了本地快而把远程降级成同步，所以统一 Promise。
   */
  execute(op: Op): Promise<{ data: unknown; nextActions: string[] }>;
}

// ---- 复用的 schema 片段，避免每个工具重复写 ----
const S = {
  sessionId: { type: "string", description: "session id returned by kanban_session_start" },
  taskId: { type: "string", description: "task id, e.g. T-0007" },
  planId: { type: "string", description: "plan id, e.g. PL-T-0007-03 or PL-0002" },
  agentName: { type: "string", description: "agent name, e.g. pi-main" },
  limit: { type: "number", description: "max cards to return (default 30)" },
} as const;

const REQUIRED_SESSION = ["session_id"];

export const TOOLS: ToolSchema[] = [
  {
    name: "kanban_session_start",
    description:
      "Register this agent session. Call it once at the start of a work session and keep the returned session_id; every later tool call needs it. Also triggers zombie reaping, so tasks abandoned by crashed agents become claimable.",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: S.agentName,
        harness: { type: "string", description: "Which agent runtime, e.g. pi / claude-code" },
      },
      required: ["agent_name"],
    },
  },
  {
    name: "kanban_bootstrap",
    description:
      "FIRST tool call of every session. Returns: handoffs left for you, cards you already hold, cards nobody owns, and crashed sessions. Skipping this means working blind. Set consume_handoffs=false to look without marking them read.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: S.sessionId,
        consume_handoffs: { type: "boolean", description: "Mark returned handoffs as read (default true)" },
      },
      required: REQUIRED_SESSION,
    },
  },
  {
    name: "kanban_task_list",
    description:
      "List tasks. status filters by lane; ready=true returns only claimable cards; mine=true restricts to the ones this session holds.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: S.sessionId,
        status: { type: "array", items: { type: "string" }, description: "backlog/todo/doing/blocked/review/done/cancelled" },
        mine: { type: "boolean" },
        ready: { type: "boolean", description: "only cards whose dependencies are satisfied" },
        label: { type: "string" },
        limit: S.limit,
      },
      required: REQUIRED_SESSION,
    },
  },
  {
    name: "kanban_task_get",
    description:
      "Full detail for one task: description, checklist, dependencies, and optionally the event timeline and current plan.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: S.taskId,
        include_timeline: { type: "boolean", description: "default true" },
        timeline_tail: { type: "number", description: "last N events (default 20)" },
        include_plan: { type: "boolean", description: "attach the current plan body" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "kanban_task_create",
    description: "Create a task. Returns its id plus what to do next.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        priority: { type: "number", description: "0 highest, 4 lowest" },
        labels: { type: "array", items: { type: "string" } },
        checklist: { type: "array", items: { type: "string" } },
        blocked_by: { type: "array", items: { type: "string" }, description: "task ids this depends on" },
      },
      required: ["title"],
    },
  },
  {
    name: "kanban_task_claim",
    description:
      "Take the lease on a task. On conflict the error names the current holder and their last action, so you can pick a different card instead of forcing it.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: S.sessionId,
        task_id: S.taskId,
        ttl_ms: { type: "number", description: "lease length in ms (default 15 min)" },
        force: { type: "boolean", description: "steal an expired or yielding lease" },
      },
      required: [...REQUIRED_SESSION, "task_id"],
    },
  },
  {
    name: "kanban_task_progress",
    description:
      "Report progress. Renews your lease as a side effect, so a long task stays yours. Ticks checklist items with check_done.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: S.sessionId,
        task_id: S.taskId,
        pct: { type: "number", description: "0-100" },
        note: { type: "string" },
        check_done: { type: "string", description: "checklist item to tick" },
        check_uncheck: { type: "string", description: "checklist item to untick" },
      },
      required: [...REQUIRED_SESSION, "task_id", "pct"],
    },
  },
  {
    name: "kanban_task_note",
    description: "Append a note to a task without changing its status.",
    inputSchema: {
      type: "object",
      properties: { session_id: S.sessionId, task_id: S.taskId, text: { type: "string" } },
      required: [...REQUIRED_SESSION, "task_id", "text"],
    },
  },
  {
    name: "kanban_task_block",
    // ⚠ 描述必须与行为一致：blocking **does** release the lease（持卡人与租约一起清），
    //   这条描述以前就是这么写的，但实现不清——于是 blocked 卡上永远挂着一个
    //   没人回收的幽灵持卡人。以后改行为时记得连描述一起改。
    description:
      "Mark a task blocked with a reason. Releases the lease and the assignee, so the card stops showing a stale holder; unblock it later with kanban_task_unblock.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: S.sessionId,
        task_id: S.taskId,
        reason: { type: "string", description: "what you are waiting for" },
      },
      required: [...REQUIRED_SESSION, "task_id", "reason"],
    },
  },
  {
    name: "kanban_task_unblock",
    description: "Clear a blocked task back to todo.",
    inputSchema: {
      type: "object",
      properties: { session_id: S.sessionId, task_id: S.taskId },
      required: [...REQUIRED_SESSION, "task_id"],
    },
  },
  {
    name: "kanban_task_complete",
    description: "Mark a task done. Unblocks dependants and reports which ones moved.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: S.sessionId,
        task_id: S.taskId,
        note: { type: "string" },
        force: { type: "boolean" },
      },
      required: [...REQUIRED_SESSION, "task_id"],
    },
  },
  {
    name: "kanban_task_release",
    description:
      "Give up a card you are holding: doing → todo, keeping the progress and checklist so whoever picks it up continues from where you stopped. Use this when you are stopping work without finishing; use kanban_task_block when something outside your control is in the way.",
    inputSchema: {
      type: "object",
      properties: { session_id: S.sessionId, task_id: S.taskId, reason: { type: "string" } },
      required: [...REQUIRED_SESSION, "task_id"],
    },
  },
  {
    name: "kanban_task_cancel",
    description:
      "Cancel a task (needs a reason). Terminal: only kanban_task_reopen can bring it back.",
    inputSchema: {
      type: "object",
      properties: { session_id: S.sessionId, task_id: S.taskId, reason: { type: "string" } },
      required: [...REQUIRED_SESSION, "task_id", "reason"],
    },
  },
  {
    name: "kanban_task_reopen",
    description: "Bring a done or cancelled task back to todo, keeping its progress.",
    inputSchema: {
      type: "object",
      properties: { session_id: S.sessionId, task_id: S.taskId, reason: { type: "string" } },
      required: [...REQUIRED_SESSION, "task_id", "reason"],
    },
  },
  {
    name: "kanban_task_remove",
    description:
      "Delete a task outright. Only cancelled tasks can be deleted without force; the card and its history stop existing.",
    inputSchema: {
      type: "object",
      properties: { session_id: S.sessionId, task_id: S.taskId, force: { type: "boolean" } },
      required: [...REQUIRED_SESSION, "task_id"],
    },
  },
  {
    name: "kanban_task_dep_add",
    description:
      "Say task A can only start once task B is done. Refuses to create a cycle. Use kanban_task_list with ready=true to see what this unblocks.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: S.sessionId,
        task_id: { type: "string", description: "the task that waits" },
        depends_on: { type: "string", description: "the task that must finish first" },
      },
      required: [...REQUIRED_SESSION, "task_id", "depends_on"],
    },
  },
  {
    name: "kanban_task_dep_remove",
    description: "Drop a dependency edge (A waits for B).",
    inputSchema: {
      type: "object",
      properties: { session_id: S.sessionId, task_id: S.taskId, depends_on: S.taskId },
      required: [...REQUIRED_SESSION, "task_id", "depends_on"],
    },
  },
  {
    name: "kanban_task_dep_list",
    description: "List a task's dependencies and which of them are still unfinished.",
    inputSchema: {
      type: "object",
      properties: { session_id: S.sessionId, task_id: S.taskId },
      required: [...REQUIRED_SESSION, "task_id"],
    },
  },
  {
    name: "kanban_plan_list",
    description:
      "List plan versions. Use scope=task with task_id to see one card's plans, or omit for project-level plans. status defaults to active.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: S.sessionId,
        task_id: S.taskId,
        scope: { type: "string", enum: ["project", "task"] },
        status: { type: "string", enum: ["active", "superseded", "draft", "all"] },
        limit: { type: "number" },
      },
      required: [...REQUIRED_SESSION],
    },
  },
  {
    name: "kanban_plan_history",
    description:
      "Show the full version chain of a plan, newest first. Use this to find out how the approach changed and when.",
    inputSchema: {
      type: "object",
      properties: { session_id: S.sessionId, plan_id: S.planId },
      required: [...REQUIRED_SESSION, "plan_id"],
    },
  },
  {
    name: "kanban_task_review",
    description: "Move a task into review, waiting for a human to confirm.",
    inputSchema: {
      type: "object",
      properties: { session_id: S.sessionId, task_id: S.taskId, note: { type: "string" } },
      required: [...REQUIRED_SESSION, "task_id"],
    },
  },
  {
    name: "kanban_resume",
    description:
      "Take over a task that was abandoned. Injects the previous holder's handoff and the event timeline. Works without force when the holder left a handoff, because writing one means yielding.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: S.sessionId,
        task_id: S.taskId,
        force: { type: "boolean" },
      },
      required: [...REQUIRED_SESSION, "task_id"],
    },
  },
  {
    name: "kanban_handoff",
    description:
      "Leave a handoff before you stop. Written for whoever picks the card up next: name the function, the file, the failing test. Also frees the lease.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: S.sessionId,
        task_id: S.taskId,
        summary: { type: "string", description: "what got done" },
        next_step: { type: "string", description: "where to pick up" },
        blockers: { type: "array", items: { type: "string" } },
        open_questions: { type: "array", items: { type: "string" } },
      },
      required: [...REQUIRED_SESSION, "task_id", "summary"],
    },
  },
  {
    name: "kanban_plan_save",
    description:
      "Save a plan. Plans are never overwritten: every save creates a new version and supersedes the previous one. Read the current plan first so the new version is a diff, not a rewrite.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "attach the plan to this task; omit for a project-level plan" },
        title: { type: "string" },
        markdown: { type: "string", description: "the plan body; this is the part that carries the value" },
      },
      required: ["title", "markdown"],
    },
  },
  {
    name: "kanban_plan_show",
    description:
      "Read a plan in full. Pass task_id for the plan currently attached to a task. Long bodies are truncated; the response says so and how to get the rest.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: S.taskId,
        plan_id: { type: "string" },
        max_chars: { type: "number", description: "default 20000" },
      },
    },
  },
  {
    name: "kanban_plan_diff",
    description: "Diff two plan versions, so you can see what changed and why.",
    inputSchema: {
      type: "object",
      properties: {
        from_plan_id: { type: "string" },
        to_plan_id: { type: "string" },
      },
      required: ["from_plan_id", "to_plan_id"],
    },
  },
  {
    name: "kanban_session_end",
    description:
      "Close the session. Returns the cards it released, so the next session can pick them up.",
    inputSchema: {
      type: "object",
      properties: { session_id: S.sessionId, summary: { type: "string" } },
      required: REQUIRED_SESSION,
    },
  },
  {
    name: "kanban_board",
    description: "Read the whole board by lane, the same data the web UI shows.",
    inputSchema: {
      type: "object",
      properties: {
        // 注意：没有 include_ready —— board.get 不支持这个参数，
        // 声明了却不读会让模型以为传了就生效（静默失效最难查）
        include_done: { type: "boolean" },
      },
    },
  },
  {
    name: "kanban_doctor",
    description:
      "Consistency self-check: expired leases, stale blockers, long-running cards, projection drift. Use it when the board disagrees with reality.",
    inputSchema: {
      type: "object",
      properties: {
        deep: { type: "boolean", description: "also replay the event log (slower)" },
        fix: { type: "boolean", description: "repair what is safely repairable" },
      },
    },
  },
];

/**
 * 工具名 → 处理器。
 *
 * 每个 handler 只做三件事：把 MCP 参数名翻译成 Op 参数名、调 Op、把 nextActions 塞进包络。
 * 任何业务判断出现在这里都说明分层破了。
 */
export type ToolHandler = (args: Record<string, unknown>, deps: ToolDeps) => Promise<ToolEnvelope>;

const ok = (data: unknown, nextActions: string[]): ToolEnvelope => ({
  ok: true,
  data,
  next_actions: nextActions,
});

/** 把 KanbanError 转成 MCP 包络（契约 §3.3 的失败形态） */
export function errorEnvelope(err: unknown): ToolEnvelope {
  if (err instanceof KanbanError) {
    const details = err.details as Record<string, unknown>;
    return {
      ok: false,
      error: {
        code: err.code,
        name: err.name,
        message: err.message,
        ...(details.hint !== undefined ? { hint: String(details.hint) } : {}),
        ...(details.holder !== undefined ? { holder: details.holder } : {}),
        ...(details.legal_transitions !== undefined
          ? { legal_transitions: details.legal_transitions }
          : {}),
      },
    };
  }
  return {
    ok: false,
    error: {
      code: ExitCode.INTERNAL,
      name: "INTERNAL",
      message: err instanceof Error ? err.message : String(err),
    },
  };
}

// ---- 参数读取小工具：类型不符时给可执行的错误，而不是静默吞掉 ----
function str(args: Record<string, unknown>, key: string, fallback?: string): string {
  const v = args[key];
  if (v === undefined || v === null) {
    if (fallback !== undefined) return fallback;
    throw KanbanError.usage(`missing required parameter: ${key}`, `tool parameter ${key} is a required string`);
  }
  if (typeof v !== "string") {
    throw KanbanError.usage(`parameter ${key} must be a string`, `received ${typeof v}`);
  }
  return v;
}

/**
 * 可选字符串：没传就是 undefined，不报错。
 *
 * ⚠ 不能用 `str(args, key, undefined as unknown as string)` 代替：
 *   那个 fallback 运行时就是 undefined，str 会当成“未给 fallback”而抛
 *   “缺少必填参数”——一个本该可选的参数会变成硬性要求。
 */
function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    throw KanbanError.usage(`parameter ${key} must be a string`, `received ${typeof v}`);
  }
  return v;
}
function num(args: Record<string, unknown>, key: string, fallback?: number): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "number" || Number.isNaN(v)) {
    throw KanbanError.usage(`parameter ${key} must be a number`, `received ${typeof v}`);
  }
  return v;
}
function bool(args: Record<string, unknown>, key: string, fallback?: boolean): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "boolean") {
    throw KanbanError.usage(`parameter ${key} must be a boolean`, `received ${typeof v}`);
  }
  return v;
}
function strArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw KanbanError.usage(`parameter ${key} must be an array of strings`);
  }
  return v as string[];
}

/**
 * 工具实现表。
 *
 * 每个 handler 只做三件事：把 MCP 参数名翻译成 Op 参数名、调 Op、把 nextActions 塞进包络。
 * 任何业务判断出现在这里都说明分层破了。
 */
export const HANDLERS: Record<string, ToolHandler> = {
  kanban_session_start: async (a, d) => {
    const { data, nextActions } = await d.execute({
      kind: "session.start",
      params: { agent_name: str(a, "agent_name"), harness: str(a, "harness", "mcp") },
    });
    return ok(data, [
      `Store the returned session_id and pass it to every later tool call`,
      `Next: kanban_bootstrap(session_id="...")`,
    ].concat(nextActions));
  },

  kanban_bootstrap: async (a, d) => {
    const { data, nextActions } = await d.execute({
      kind: "context.get",
      params: { consume: bool(a, "consume_handoffs", true) },
    });
    return ok(data, nextActions);
  },

  kanban_task_list: async (a, d) => {
    // status 要先窄化到 TaskStatus，否则一个拼错的状态会直接落到数据库查询里
    const raw = strArray(a, "status");
    const status = raw
      ? (raw.map((s) => {
          if (!TASK_STATUS_SET.has(s)) {
            throw KanbanError.usage(
              `unknown task status: ${s}`,
              `valid values: ${[...TASK_STATUS_SET].join(", ")}`,
            );
          }
          return s as TaskStatus;
        }) as TaskStatus[])
      : undefined;
    const { data, nextActions } = await d.execute({
      kind: "task.list",
      params: {
        status,
        mine: bool(a, "mine"),
        ready: bool(a, "ready"),
        label: optStr(a, "label"),
        limit: num(a, "limit", 30),
      },
    });
    return ok(data, nextActions);
  },

  kanban_task_get: async (a, d) => {
    const taskId = str(a, "task_id");
    const includePlan = bool(a, "include_plan", false);
    const { data, nextActions } = await d.execute({
      kind: "task.get",
      params: {
        task_id: taskId,
        timeline: bool(a, "include_timeline", true),
        tail: num(a, "timeline_tail", 20),
      },
    });
    const hints = includePlan
      ? [`Full plan for this task: kanban_plan_show(task_id="${taskId}")`]
      : [];
    return ok(data, hints.concat(nextActions));
  },

  kanban_task_create: async (a, d) => {
    const { data, nextActions } = await d.execute({
      kind: "task.create",
      params: {
        title: str(a, "title"),
        description: optStr(a, "description"),
        priority: num(a, "priority"),
        labels: strArray(a, "labels"),
        checklist: strArray(a, "checklist"),
        blocked_by: strArray(a, "blocked_by"),
      },
    });
    return ok(data, nextActions);
  },

  kanban_task_claim: async (a, d) => {
    const { data, nextActions } = await d.execute({
      kind: "task.claim",
      params: {
        task_id: str(a, "task_id"),
        force: bool(a, "force"),
        // MCP 侧用 ttl_ms（数字，对模型更自然），Op 侧用 ttl（时长字符串）。
        // 转换放在这一层，两种接入面各自的表达习惯都不被迫改。
        ttl: msToTtl(num(a, "ttl_ms")),
      },
    });
    return ok(data, nextActions);
  },

  kanban_task_progress: async (a, d) => {
    const checkDone = optStr(a, "check_done");
    const checkUncheck = optStr(a, "check_uncheck");
    const { data, nextActions } = await d.execute({
      kind: "task.progress",
      params: {
        task_id: str(a, "task_id"),
        pct: num(a, "pct", 0),
        note: optStr(a, "note"),
        // Op 收的是数组，工具收的是单个项名——一次只勾一项是 agent 的真实粒度
        check: checkDone ? [checkDone] : undefined,
        uncheck: checkUncheck ? [checkUncheck] : undefined,
      },
    });
    return ok(data, nextActions);
  },

  kanban_task_note: async (a, d) => {
    const { data, nextActions } = await d.execute({
      kind: "task.note",
      params: { task_id: str(a, "task_id"), text: str(a, "text") },
    });
    return ok(data, nextActions);
  },

  kanban_task_block: async (a, d) => {
    const { data, nextActions } = await d.execute({
      kind: "task.block",
      params: { task_id: str(a, "task_id"), reason: str(a, "reason") },
    });
    return ok(data, nextActions);
  },

  kanban_task_unblock: async (a, d) => {
    const { data, nextActions } = await d.execute({
      kind: "task.unblock",
      params: { task_id: str(a, "task_id") },
    });
    return ok(data, nextActions);
  },

  kanban_task_complete: async (a, d) => {
    const { data, nextActions } = await d.execute({
      kind: "task.done",
      params: { task_id: str(a, "task_id"), note: optStr(a, "note"), force: bool(a, "force") },
    });
    return ok(data, nextActions);
  },

  kanban_task_review: async (a, d) => {
    const { data, nextActions } = await d.execute({
      kind: "task.review",
      params: { task_id: str(a, "task_id"), note: optStr(a, "note") },
    });
    return ok(data, nextActions);
  },

  kanban_resume: async (a, d) => {
    const { data, nextActions } = await d.execute({
      kind: "resume.task",
      params: { task_id: str(a, "task_id"), force: bool(a, "force"), tail: num(a, "tail", 20) },
    });
    return ok(data, nextActions);
  },

  kanban_handoff: async (a, d) => {
    const { data, nextActions } = await d.execute({
      kind: "handoff.create",
      params: {
        task_id: str(a, "task_id"),
        summary: str(a, "summary"),
        next_step: optStr(a, "next_step"),
        blockers: strArray(a, "blockers"),
        open_questions: strArray(a, "open_questions"),
      },
    });
    return ok(data, nextActions);
  },

  kanban_plan_save: async (a, d) => {
    const { data, nextActions } = await d.execute({
      kind: "plan.save",
      params: {
        scope: a.task_id ? "task" : "project",
        task_id: optStr(a, "task_id") ?? null,
        title: str(a, "title"),
        body: str(a, "markdown"),
      },
    });
    return ok(data, nextActions);
  },

  kanban_plan_show: async (a, d) => {
    const planId = optStr(a, "plan_id");
    const taskId = optStr(a, "task_id");
    if (!planId && !taskId) {
      throw KanbanError.usage("plan_show requires either plan_id or task_id");
    }
    // task_id 走 plan.list 找当前生效版本；plan_id 直取
    if (planId) {
      const { data } = await d.execute({ kind: "plan.show", params: { plan_id: planId } });
      return ok(truncatePlan(data, num(a, "max_chars", 20000) ?? 20000), []);
    }
    // task_id 路径：先查当前生效的版本，再取全文
    // plan.list 的 data 直接是数组（契约 §4.0），不是 { plans: [...] }
    const listed = await d.execute({
      kind: "plan.list",
      params: { task_id: taskId, scope: "task", status: "active", limit: 1 },
    });
    const first = Array.isArray(listed.data)
      ? (listed.data[0] as { id?: string } | undefined)
      : undefined;
    if (!first?.id) {
      return ok(
        { plans: [] },
        [`This task has no plan yet: kanban_plan_save(task_id="${taskId}", title="...", markdown="...")`],
      );
    }
    const { data } = await d.execute({ kind: "plan.show", params: { plan_id: first.id } });
    return ok(truncatePlan(data, num(a, "max_chars", 20000) ?? 20000), []);
  },

  kanban_plan_diff: async (a, d) => {
    const { data } = await d.execute({
      kind: "plan.diff",
      params: { from_plan_id: str(a, "from_plan_id"), to_plan_id: str(a, "to_plan_id") },
    });
    return ok(data, []);
  },

  kanban_session_end: async (a, d) => {
    const { data, nextActions } = await d.execute({
      kind: "session.end",
      params: { summary: optStr(a, "summary") },
    });
    return ok(data, nextActions);
  },

  kanban_task_release: async (a, d) => {
    const { data, nextActions } = await d.execute({
      kind: "task.release",
      params: { task_id: str(a, "task_id"), reason: optStr(a, "reason") },
    });
    return ok(data, nextActions);
  },

  kanban_task_cancel: async (a, d) => {
    const { data, nextActions } = await d.execute({
      kind: "task.cancel",
      params: { task_id: str(a, "task_id"), reason: str(a, "reason") },
    });
    return ok(data, nextActions);
  },

  kanban_task_reopen: async (a, d) => {
    const { data, nextActions } = await d.execute({
      kind: "task.reopen",
      params: { task_id: str(a, "task_id"), reason: str(a, "reason") },
    });
    return ok(data, nextActions);
  },

  kanban_task_remove: async (a, d) => {
    const { data, nextActions } = await d.execute({
      kind: "task.remove",
      params: { task_id: str(a, "task_id"), force: bool(a, "force") },
    });
    return ok(data, nextActions);
  },

  kanban_task_dep_add: async (a, d) => {
    const { data, nextActions } = await d.execute({
      kind: "task.dep.add",
      params: { task_id: str(a, "task_id"), depends_on: str(a, "depends_on") },
    });
    return ok(data, nextActions);
  },

  kanban_task_dep_remove: async (a, d) => {
    const { data, nextActions } = await d.execute({
      kind: "task.dep.remove",
      params: { task_id: str(a, "task_id"), depends_on: str(a, "depends_on") },
    });
    return ok(data, nextActions);
  },

  kanban_task_dep_list: async (a, d) => {
    const { data, nextActions } = await d.execute({
      kind: "task.dep.list",
      params: { task_id: str(a, "task_id") },
    });
    return ok(data, nextActions);
  },

  kanban_plan_list: async (a, d) => {
    // enum 在 inputSchema 里已经约束过，但 TS 不知道；这里显式收窄，
    // 免得以后有人把 enum 改了而这边静默传一个非法值进 SQL。
    const scope = optStr(a, "scope");
    const status = optStr(a, "status");
    const { data, nextActions } = await d.execute({
      kind: "plan.list",
      params: {
        task_id: optStr(a, "task_id") ?? null,
        scope: scope === "project" || scope === "task" ? scope : undefined,
        status:
          status === "active" || status === "superseded" || status === "draft" || status === "all"
            ? status
            : undefined,
        limit: num(a, "limit", 50),
      },
    });
    return ok(data, nextActions);
  },

  kanban_plan_history: async (a, d) => {
    const { data, nextActions } = await d.execute({
      kind: "plan.history",
      params: { plan_id: str(a, "plan_id") },
    });
    return ok(data, nextActions);
  },

  kanban_board: async (a, d) => {
    const { data, nextActions } = await d.execute({
      kind: "board.get",
      params: { include_done: bool(a, "include_done") },
    });
    return ok(data, nextActions);
  },

  kanban_doctor: async (a, d) => {
    const { data, nextActions } = await d.execute({
      kind: "doctor.check",
      params: { deep: bool(a, "deep", false), fix: bool(a, "fix", false) },
    });
    return ok(data, nextActions);
  },
};

/**
 * 计划正文截断（契约 §3.1：默认截断并告诉 agent 怎么取全文）。
 *
 * 为什么不直接给全文：计划正文可以很长，一次灌进来就吃掉 agent 大半个上下文，
 * 而它多半只看得到前几行。给出总长度与取全文的办法，agent 自己决定要不要花这个钱。
 */
function truncatePlan(data: unknown, maxChars: number): unknown {
  if (typeof data !== "object" || data === null) return data;
  const row = data as Record<string, unknown>;
  const body = typeof row.body === "string" ? row.body : undefined;
  if (body === undefined || body.length <= maxChars) return data;

  const kept = body.slice(0, maxChars);
  const planId = String(row.id ?? "");
  return {
    ...row,
    body: kept,
    truncated: true,
    total_chars: body.length,
    next_actions: [
      `Body truncated (${body.length} → ${maxChars} chars). Raise max_chars and call again for the rest`,
      `Or search for what you need: kanban_plan_diff(from_plan_id="${planId}", ...)`,
    ],
  };
}

/** 调度：按工具名分发，未知工具给可读错误 */
export async function callTool(name: string, args: Record<string, unknown>, deps: ToolDeps): Promise<ToolEnvelope> {
  const handler = HANDLERS[name];
  if (!handler) {
    return {
      ok: false,
      error: {
        code: ExitCode.USAGE,
        name: "USAGE",
        message: `unknown tool: ${name}`,
        hint: `available tools: ${TOOLS.map((t) => t.name).join(", ")}`,
      },
    };
  }
  try {
    return await handler(args, deps);
  } catch (err) {
    return errorEnvelope(err);
  }
}
