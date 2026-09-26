/**
 * 输出层：人类可读文本 与 JSON 两种模式。
 *
 * 规则（契约 §1.2）：
 * - `--json` 模式：stdout **只**输出一个 JSON 对象，错误走 stderr
 * - 人类模式：给人看，可以有颜色和排版
 *
 * 这样 agent 用 `--json` 解析时不会被任何装饰性输出污染。
 */

import { ExitCode, KanbanError, type ExitCodeValue } from "../core/errors.ts";

/** 输出接口：命令层不直接碰 console，便于测试断言 */
export interface Output {
  /** 人类可读正文（仅非 json 模式输出） */
  line(text: string): void;
  /** 空行 */
  blank(): void;
  /** 成功的 JSON 数据（仅 json 模式输出） */
  data(payload: unknown): void;
  /** 原始文本（不经 json 包装），用于 watch 这类流式输出 */
  raw(text: string): void;
}

/** 构造输出器 */
export function createOutput(json: boolean): Output {
  return {
    line(text: string) {
      if (!json) process.stdout.write(text + "\n");
    },
    blank() {
      if (!json) process.stdout.write("\n");
    },
    data(payload: unknown) {
      if (json) process.stdout.write(JSON.stringify(payload) + "\n");
    },
    raw(text: string) {
      // 无论哪种模式都输出：watch 的订阅者要的是原始事件流
      process.stdout.write(text);
    },
  };
}

/** 统一错误输出：人类模式打可读信息，json 模式打结构化对象 */
export function reportError(err: unknown, json: boolean): ExitCodeValue {
  const error = err instanceof KanbanError ? err : wrapUnknown(err);

  if (json) {
    process.stderr.write(JSON.stringify(error.toJSON()) + "\n");
  } else {
    // 人类模式：错误标题 + 提示 + 可操作建议
    process.stderr.write(`\nError[${error.name}]: ${error.message}\n`);
    const details = error.details;
    if (details.hint) {
      process.stderr.write(`Hint: ${String(details.hint)}\n`);
    }
    if (details.usage) {
      // USAGE 常量自身已经以 `Usage: ` 开头（它们同时被 `--help` 直接打印，
      // 必须自包含），这里再补一次表头就成了
      //   Usage:
      //   Usage: agent-kanban task claim <id>
      // ——这个重复是旧版就有的（中文时是「用法：」两遍），所以判断一下再决定要不要补表头。
      const usage = String(details.usage);
      process.stderr.write(usage.trimStart().startsWith("Usage:") ? `${usage}\n` : `Usage:\n${usage}\n`);
    }
    // legal_transitions 不用重复输出：KanbanError.illegalTransition 的 message
    // 已经把合法后继写在文案里了（agent 读文案比读字段更自然）
    if (details.holder) {
      const holder = details.holder as Record<string, unknown>;
      process.stderr.write(
        `Current holder: ${String(holder.session_id ?? "?")}` +
          `${holder.agent_name ? ` (${String(holder.agent_name)})` : ""}` +
          `  progress ${String(holder.progress ?? "?")}%\n`,
      );
    }
  }
  return error.code;
}

/** 非 KanbanError 的兜底包装（视为内部错误） */
function wrapUnknown(err: unknown): KanbanError {
  if (err instanceof KanbanError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new KanbanError(ExitCode.INTERNAL, "INTERNAL", message, {});
}
