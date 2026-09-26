/**
 * TOML 解析与序列化的薄封装。
 *
 * 为什么不用自己写：Bun 1.2+ 内置 `Bun.TOML.parse` / `Bun.TOML.stringify`，
 * 完整支持 TOML 规范（含多行字符串、数组表、日期时间），比手写子集可靠。
 * 最初我写了一个 200 行的手写子集解析器，探针验证后发现内置能力更完整，已废弃。
 *
 * 保留这个模块的价值在于**统一错误信息**：
 * 内置抛出的错误信息是英文的，而配置文件是用户直接编辑的，
 * 需要在错误里带上文件路径与可操作提示（见 `parseTomlFile`）。
 *
 * 实测要点（docs/note/2026-02-19-TOML-选型.md）：
 *   - `Bun.TOML.parse` 是**同步**函数，可直接传 readFileSync 的结果
 *   - `stringify` 会把标量放前面、表放后面，符合人读习惯
 *   - 不保留注释（配置是程序生成的，可接受；我们靠头部注释由本模块手写补上）
 *   - 支持 `[[array_table]]`、多行字符串、日期时间等完整规范
 */

import { readFileSync } from "node:fs";
import { KanbanError } from "./errors.ts";

/** TOML 值类型（与 Bun.TOML 的输出结构一致） */
export type TomlValue = string | number | boolean | TomlValue[] | TomlObject;
export interface TomlObject {
  [key: string]: TomlValue;
}

/**
 * 解析 TOML 文本。
 *
 * 失败时抛 KanbanError（而不是原生 Error），
 * 这样 CLI 能以退出码 2 + 可读提示呈现，而不是 INTERNAL(6)。
 */
export function parseToml(text: string, sourceName = "config.toml"): TomlObject {
  try {
    return Bun.TOML.parse(text) as TomlObject;
  } catch (err) {
    throw KanbanError.state(`failed to parse ${sourceName}: ${(err as Error).message}`, {
      reason: "toml_parse_failed",
      file: sourceName,
      hint:
        "Check the TOML syntax. Common mistakes:\n" +
        "  - string values must be quoted (e.g. key = 'value')\n" +
        "  - spaces around = are optional, but a bare value other than key=value is not allowed\n" +
        "  - a table header is written [server], not [server]]",
    });
  }
}

/** 读取并解析文件；文件不存在返回 null（不报错，"没配置"是正常状态） */
export function parseTomlFile(path: string): TomlObject | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return parseToml(text, path);
}

/** 序列化为 TOML 文本 */
export function stringifyToml(obj: TomlObject): string {
  return Bun.TOML.stringify(obj as never) ?? "";
}

/**
 * 序列化并**前置注释头**。
 *
 * Bun.TOML.stringify 本身不支持注释（TOML 规范也没有），
 * 但配置文件是给人读的，开头一段说明能省掉大量"这个字段什么意思"的提问。
 */
export function stringifyTomlWithHeader(obj: TomlObject, header: string): string {
  const headerLines = header
    .split("\n")
    .map((line) => (line.length > 0 ? `# ${line}` : "#"))
    .join("\n");
  return `${headerLines}\n\n${stringifyToml(obj)}`;
}

/** 安全取子表（不存在返回空对象，避免到处写 ?? 和类型断言） */
export function table(value: TomlValue | undefined): TomlObject {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as TomlObject;
  }
  return {};
}

/** 安全取字符串 */
export function str(value: TomlValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 安全取数字 */
export function num(value: TomlValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
