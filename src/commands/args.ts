/**
 * 极简参数解析器。
 *
 * 不引三方库的原因：CLI 参数解析是本项目最稳定的部分，自己实现能精确控制
 * 错误信息（agent 依赖 usage 提示自我修正，见契约 §1.3）。
 *
 * 支持的写法：
 *   --flag            布尔开关
 *   --key value       字符串值
 *   --key=value       同上（等号形式）
 *   --no-flag         布尔取反
 *   -k value          短选项
 *   -abc              短选项组合（皆布尔）
 *
 * 未识别参数不会被静默忽略，而是收进 unknown，由命令层决定是否报错 ——
 * agent 拼错参数时必须被告知，否则会以为操作成功了。
 */

import { KanbanError } from "../core/errors.ts";

export interface ParsedArgs {
  /** 位置参数 */
  positionals: string[];
  /** 长选项（已把 -- 去掉，kebab-case 保持原样） */
  options: Record<string, string | boolean>;
  /** 未识别的选项名（供命令层校验） */
  unknown: string[];
}

export interface ParseSpec {
  /** 布尔选项名列表 */
  booleans?: string[];
  /** 字符串选项名列表 */
  strings?: string[];
  /** 短选项映射：单字符 → 长选项名 */
  short?: Record<string, string>;
}

/**
 * 解析 argv。
 *
 * @param argv 不含可执行文件名与子命令名的参数数组
 * @param spec 声明哪些选项是布尔、哪些是字符串；未声明的按"有值则字符串、无值则布尔"处理
 */
export function parseArgs(argv: string[], spec: ParseSpec = {}): ParsedArgs {
  const booleans = new Set(spec.booleans ?? []);
  const strings = new Set(spec.strings ?? []);
  const short = spec.short ?? {};

  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};
  const unknown: string[] = [];

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;

    // ---- 长选项 ----
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      if (body.length === 0) {
        // "--" 之后全部视为位置参数
        positionals.push(...argv.slice(i + 1));
        break;
      }
      const eq = body.indexOf("=");
      const name = eq >= 0 ? body.slice(0, eq) : body;
      const inlineValue = eq >= 0 ? body.slice(eq + 1) : undefined;

      if (inlineValue !== undefined) {
        options[name] = inlineValue;
        i++;
        continue;
      }
      if (booleans.has(name)) {
        options[name] = true;
        i++;
        continue;
      }
      if (strings.has(name)) {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith("-")) {
          throw KanbanError.usage(`option --${name} needs a value`, `Usage: --${name} <value>`);
        }
        options[name] = value;
        i += 2;
        continue;
      }
      // 未声明的选项：先按"有下一个非选项参数就取之"处理
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        options[name] = next;
        i += 2;
      } else {
        options[name] = true;
        i++;
      }
      unknown.push(name);
      continue;
    }

    // ---- 短选项 ----
    if (arg.startsWith("-") && arg.length > 1) {
      const chars = arg.slice(1);
      for (let c = 0; c < chars.length; c++) {
        const ch = chars[c]!;
        const long = short[ch];
        if (long === undefined) {
          throw KanbanError.usage(`unknown short option -${ch}`, `Usage: available short options: ${Object.keys(short).join(" ")}`);
        }
        if (booleans.has(long)) {
          options[long] = true;
          continue;
        }
        // 字符串型短选项：剩余字符作为值，或取下一个参数
        const rest = chars.slice(c + 1);
        if (rest.length > 0) {
          options[long] = rest.startsWith("=") ? rest.slice(1) : rest;
          break;
        }
        const value = argv[i + 1];
        if (value === undefined || value.startsWith("-")) {
          throw KanbanError.usage(`option -${ch} needs a value`, `-${ch} <value>`);
        }
        options[long] = value;
        i++;
        break;
      }
      i++;
      continue;
    }

    // ---- 位置参数 ----
    positionals.push(arg);
    i++;
  }

  return { positionals, options, unknown };
}

/** 读取字符串选项 */
export function getString(args: ParsedArgs, name: string): string | undefined {
  const value = args.options[name];
  return typeof value === "string" ? value : undefined;
}

/** 读取布尔选项（--flag / --no-flag 都支持） */
export function getBool(args: ParsedArgs, name: string, defaultValue = false): boolean {
  const value = args.options[name];
  if (value === true) return true;
  if (value === false) return false;
  const neg = args.options[`no-${name}`];
  if (neg === true) return false;
  return defaultValue;
}

/** 读取数字选项 */
export function getNumber(args: ParsedArgs, name: string): number | undefined {
  const value = getString(args, name);
  if (value === undefined) return undefined;
  const num = Number(value);
  if (Number.isNaN(num)) {
    throw KanbanError.usage(`option --${name} needs a number, got "${value}"`);
  }
  return num;
}

/** 读取整数选项 */
export function getInt(args: ParsedArgs, name: string): number | undefined {
  const num = getNumber(args, name);
  if (num === undefined) return undefined;
  if (!Number.isInteger(num)) {
    throw KanbanError.usage(`option --${name} needs an integer, got ${num}`);
  }
  return num;
}

/** 读取逗号分隔列表选项（--label a,b → ["a","b"]） */
export function getList(args: ParsedArgs, name: string): string[] | undefined {
  const value = getString(args, name);
  if (value === undefined) return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 全局选项：对**所有**命令生效。
 *
 * 为什么单列一份：cli.ts 的 withGlobals() 会把命令行上的全局选项注入到子命令 argv，
 * 所以每个命令的 assertKnownOptions 都得把它们列入白名单。漏列一个，那个命令就会
 * 在“带了个完全合法的 --session”时报“未知选项”——已经踩过一次（backup 系列）。
 * 把集合收在这里，漏列就不可能发生。
 */
export const GLOBAL_OPTIONS = ["json", "session", "db", "server", "project", "key", "no-color"] as const;

/** 校验未知选项：命令层调用，spec 之外的选项直接报错而不是忽略 */
export function assertKnownOptions(args: ParsedArgs, allowed: string[]): void {
  const allowedSet = new Set([...allowed, ...GLOBAL_OPTIONS]);
  const bad = Object.keys(args.options).filter((k) => !allowedSet.has(k));
  if (bad.length > 0) {
    throw KanbanError.usage(
      `unknown option: ${bad.map((b) => `--${b}`).join(" ")}`,
      `available options: ${allowed.map((a) => `--${a}`).join(" ")}`,
    );
  }
}

/** 取第 n 个位置参数，不存在则报用法错误 */
export function requirePositional(args: ParsedArgs, index: number, name: string, usage: string): string {
  const value = args.positionals[index];
  if (value === undefined || value.length === 0) {
    throw KanbanError.usage(`missing argument <${name}>`, usage);
  }
  return value;
}
