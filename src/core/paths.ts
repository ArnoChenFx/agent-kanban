/**
 * 路径发现：定位项目级数据目录 `.kanban/`。
 *
 * 发现规则（契约 §1.1，优先级从高到低）：
 *   1. 环境变量 KANBAN_DB —— 直接指定 db 文件路径（测试与特例场景用）
 *   2. 命令行 --db     —— 同上
 *   3. 从 cwd 向上逐级查找 `.kanban/kanban.db`，最多 5 层（支持 monorepo：
 *      在 packages/foo 下执行命令也能找到仓库根的看板）
 *
 * 为什么要向上查找：agent 的 cwd 常常是子目录，而看板属于整个项目。
 */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { KanbanError } from "./errors.ts";

/** 数据目录名 */
export const KANBAN_DIR = ".kanban";
/** 主库文件名 */
export const DB_FILENAME = "kanban.db";
/** 会话便捷文件名（**旧版单文件**，保留为兜底，见 resolveSessionKey 的说明） */
export const SESSION_FILENAME = "session";
/** 身份分片目录名：`.kanban/sessions/<key>`，一个 key 一个文件 */
export const SESSIONS_DIRNAME = "sessions";
/** 向上查找的最大层数 */
export const MAX_LOOKUP_DEPTH = 5;

// =============================================================================
// 身份 key：让同一目录里的多个 agent 能自动分开
// =============================================================================
//
// ## 要解决的问题
//
// 改造前，所有 agent 共用 `.kanban/session` **一个文件**存自己的 session id。
// 同目录跑两个 agent 时，第二个 `session start` 直接覆盖第一个，
// 于是两边的命令都被记到同一个 session 名下：租约互相看不见、`context` 看到的是
// 别人的进度、冲突信息指向一个根本不存在的"另一个人"。**不报错，只是静默错乱。**
//
// ## 为什么不用进程号
//
// - `process.pid`：CLI 每次调用都是新进程，pid 每次都变。schema 里存了 `pid`，
//   但注释自己就写明"诊断用（存活探测仅作提示，不作判据）"。
// - `process.ppid`（bun 1.4.2 实测可用）：同一交互式 shell 内稳定，但**每次调用
//   换一个 shell 的场景下每次都变**——agent 正是这种场景。按 ppid 自动登记会造出
//   一堆野会话，比共用单文件更糟。所以 ppid 连兜底都不做。
//
// ## 现在的做法
//
// 用 harness 自己注入的**每会话唯一**环境变量当 key，一个 key 一个文件。
// 三级来源：显式 KANBAN_SESSION_KEY > 下面这张核实过的表 > 按命名约定自动发现。
// 全都拿不到（无 harness、裸 shell）就退回旧单文件，行为与改造前一致，不退化。

/** 一个 harness 的会话环境变量 */
export interface HarnessSessionEnv {
  /** 写进 key 的前缀，同时也是 `--harness` 的建议值 */
  harness: string;
  /** 环境变量名 */
  envVar: string;
  /**
   * 怎么用这个值：
   *  - `id`   原样当 key（uuid / 短 id）
   *  - `path` **只取最后一段文件名**。目录部分对同目录并行的多个 agent 完全相同、
   *           没有区分度，而文件名里的时间戳+uuid 有。取完仍补哈希（见 makeSessionKey）。
   */
  kind: "id" | "path";
}

/**
 * 已核实的 harness → 会话环境变量。
 *
 * ⚠ 每一项都是**挖二进制**确认的，不是凭印象写的（核实办法见本文件末尾）。
 *   - `PI_SESSION_ID`         pi，本机实测存在（与 `PI_SESSION_FILE` 同名 UUID）
 *   - `PI_SESSION_FILE`       oh-my-pi（omp）：它的子进程 env 里注入的是**会话文件路径**，
 *                            不是 id——翻遍 `OMP_*` 也没找到 id 形状的变量
 *   - `CLAUDE_CODE_SESSION_ID` claude-code
 *   - `GROK_SESSION_ID`       grok（grok build）：与 `GROK_HOOK_EVENT` /
 *                            `GROK_HOOK_NAME` / `GROK_WORKSPACE_ROOT` 出现在
 *                            同一组“构造给子进程的 env”里
 *   - `CODEX_SESSION_ID`      codex：官方常量 `CODEX_SESSION_ID_ENV_VAR`，值是
 *                            **root session id**（见 codex-rs/core/src/exec_env.rs
 *                            的 `inject_session_env`）
 *   - `DSH_SESSION_ID`        DeepSeek Harness：值是 `agent.session.header.id`
 *                            （见 packages/shell/shell-env/src/index.ts 的 `collect`）。
 *                            ⚠ 前提：**仅 agent 发起的 shell 调用**才有它
 *                            （`if (execution.agent !== undefined)`），人手动敲的 shell 没有。
 *                            ⚠ 它其实也能被自动发现兼收到（`<TOOL>_SESSION_ID` 匹配，
 *                            前缀会是 `DSH`），进表是为了让 key 读起来是
 *                            `deepseek-harness-` 而不是 `dsh-`——`deepseek` 在 agent 生态里
 *                            更常见的含义是“模型/provider”（pi 的 auth.json 里就是），
 *                            而这一栏是给人看的，别让它被读成模型名
 *   - **cursor-agent 没有可用变量**（挖过：只有 `CURSOR_AGENT_SOCKET` 这类进程级变量）
 *     → 只能手动 `KANBAN_SESSION_KEY`
 *
 * ⚠ **codex 为什么用 `CODEX_SESSION_ID` 而不是 `CODEX_THREAD_ID`**：
 *   codex 后来（PR #10096，2026-02-03 合入 main）又加了 `CODEX_THREAD_ID`，
 *   本机实测 0.157.1 只有前者。选**更粗的 root session** 而不是 thread 是有意的：
 *   thread 是一个 agent 运行内部的子任务，一个 codex agent 起 3 个并行 thread 时，
 *   它们是**同一个 agent**，应该共用一个看板身份；按 thread 分片会让它们变成
 *   3 个“不同 agent”互相抢同一批卡。身份要按“一个 agent 进程/一次会话”切，
 *   不能切得比 agent 本身更细。
 *
 * ⚠ **顺序有意义**：pi 同时也设置 `PI_SESSION_FILE`（oh-my-pi 用的那个变量），
 *   所以 pi 的条目必须排在 oh-my-pi 前面，否则在 pi 里跑会顶着 oh-my-pi 的身份。
 */
const HARNESS_SESSION_ENV: readonly HarnessSessionEnv[] = [
  { harness: "pi", envVar: "PI_SESSION_ID", kind: "id" },
  { harness: "oh-my-pi", envVar: "PI_SESSION_FILE", kind: "path" },
  { harness: "claude-code", envVar: "CLAUDE_CODE_SESSION_ID", kind: "id" },
  { harness: "grok", envVar: "GROK_SESSION_ID", kind: "id" },
  { harness: "codex", envVar: "CODEX_SESSION_ID", kind: "id" },
  // 前缀写全 `deepseek-harness` 而不是 `dsh` 或 `deepseek`：这一栏会出现在文件名与
  // 看板标签上，而 `deepseek` 在 agent 生态里更常指模型/provider（pi 的 auth.json 里
  // deepseek 就是一个 provider 键），用全名可以避免被读成“用的哪个模型”。
  { harness: "deepseek-harness", envVar: "DSH_SESSION_ID", kind: "id" },
  // Qoder（QoderCN 桌面端 / @qoder-ai/qoder-cn-agent-sdk）。两个名字是**同一个配置**在
  // 国内版与国际版的两种前缀：SDK 源码里 `ENV_QODER_SESSION_ID` 常量按产品翻成
  // `QODER_SESSION_ID` 或 `QODERCN_SESSION_ID`（`km = Gs ? "QODERCN_" : "QODER_"`）。
  // ⚠ 与表里其它条目性质不同：**截至 2026-09-27 Qoder 尚不注入这两个变量**（本机 shell
  // 的真实 env、app.asar 与 worker runtime 全文扫描都没有）。它把 session id 只给到三处：
  //   1. skill/command/plugin 内容里的 `${QODER_SESSION_ID}` 模板替换（运行时替换成真 id）
  //   2. hook 子进程的 stdin JSON（`createCoreBaseInput`，字段名 `session_id`，CC 兼容格式）
  //   3. 这两个 env 名本身——SDK 的 loadCliConfig 会读它们作为 session 配置覆盖
  // 进表的意义：将来一旦注入（或用户手动设了）立即生效，且统一前缀 `qoder`
  // （自动发现也能收编这两个名字，但 QODERCN_ 的前缀会变成 `qodercn`）。
  { harness: "qoder", envVar: "QODER_SESSION_ID", kind: "id" },
  { harness: "qoder", envVar: "QODERCN_SESSION_ID", kind: "id" },
];

/**
 * 自动发现：形如 `<TOOL>_SESSION_ID` 的变量。
 *
 * ## 为什么要自动发现
 *
 * 表是写死的，而符合这个命名约定的工具会越来越多。与其每加一个工具就改一次代码
 * （改了还得重新核实一遍），不如按约定收编：**任何导出 `<TOOL>_SESSION_ID` 的工具
 * 都能直接用上**。codex 将来真加了这个变量，这里立刻生效。
 *
 * ## 代价与边界
 *
 * - 失败模式是“选错身份”→ 两个 agent 共用一个 key，也就是我们刚修掉的那个静默 bug。
 *   所以排除名单必须认真维护；而且 `session start` 会把选中的 key 打印出来，
 *   选错了一眼能看见（不报错地错才是真的找不到）。
 * - 多个候选时**按变量名排序取第一个**，不能按 env 的枚举顺序：那样同一台机器上
 *   两次调用可能给出不同身份，那就彻底乱了。
 */
const DISCOVERY_RE = /^([A-Z][A-Z0-9_]{1,24})_SESSION_ID$/;

/**
 * 自动发现的排除前缀：这些 `<X>_SESSION_ID` **不是** agent 会话身份。
 *
 * 每一条都是扫描本机已装工具的二进制时**实际看到**的，不是猜的：
 *   TERM / ITERM           终端模拟器的窗口/标签 id（Terminal.app、iTerm2）——
 *                          同一窗口里起的两个 agent 会撞车，而且它与 agent 无关
 *   OTEL                   遥测开关（`OTEL_METRICS_INCLUDE_SESSION_ID`）不是 id
 *   ANTHROPIC              API 层会话，不是 agent 会话
 *   SERVER_ECHOED / INVALID 服务端错误串里的常量（`SERVER_ECHOED_INVALID_SESSION_ID`）
 */
const DISCOVERY_EXCLUDE_PREFIXES: readonly string[] = [
  "TERM",
  "ITERM",
  "OTEL",
  "ANTHROPIC",
  "SERVER_ECHOED",
  "INVALID",
];

/** 自动发现时，值的长度的合理区间（滤掉 `SESSION_ID=1` 这类无意义值） */
const DISCOVERY_VALUE_MIN = 8;
const DISCOVERY_VALUE_MAX = 200;

/**
 * 显式指定身份 key 的环境变量。
 *
 * 存在的意义是给**表里没有的 harness**（cursor-agent、codex，或将来的新工具）
 * 一个不改代码就能分流的出口：设成任意稳定唯一值即可。
 */
export const SESSION_KEY_ENV = "KANBAN_SESSION_KEY";

/** key 里原样保留的最大长度，超出部分截断并加哈希后缀 */
const KEY_MAX_LEN = 48;

/** 文件名不安全的字符。刻意**不含点**：`.` 会让 `--no-write` 之外的路径拼出 `..`/`...` 这类怪文件名 */
const KEY_UNSAFE_RE = /[^A-Za-z0-9_-]/;
/** 同上，但用于全局替换（`RegExp` 带 /g 时 `test()` 有 lastIndex 状态，必须分开写） */
const KEY_UNSAFE_RE_G = /[^A-Za-z0-9_-]/g;

/**
 * 解析当前进程的身份 key；解析不出来返回 null（调用方退回旧单文件）。
 *
 * 优先级：
 *   1. 显式 `KANBAN_SESSION_KEY`
 *   2. 已核实的 harness 表（按声明顺序命中第一个）
 *   3. 自动发现：唯一像样的 `<TOOL>_SESSION_ID`
 */
export function resolveSessionKey(env: NodeJS.ProcessEnv = process.env): string | null {
  // 空字符串 / 纯空白一律当“没设”：设了但为空是配置错误，不该让两个进程共用一个空 key
  const explicit = env[SESSION_KEY_ENV]?.trim();
  if (explicit) return makeSessionKey("custom", explicit, "id");

  for (const entry of HARNESS_SESSION_ENV) {
    const raw = env[entry.envVar]?.trim();
    if (raw) return makeSessionKey(entry.harness, raw, entry.kind);
  }

  const found = discoverSessionKey(env);
  if (found) return makeSessionKey(found.harness, found.raw, "id");

  return null;
}

/**
 * 按命名约定发现会话变量：找唯一/最靠前的 `<TOOL>_SESSION_ID`。
 *
 * 例外：claude-code 还会导出 `CLAUDE_SESSION_ID`（表里那个是 `CLAUDE_CODE_SESSION_ID`），
 * 所以老版本的 claude 也能被收编到，key 前缀是 `claude`。
 */
function discoverSessionKey(env: NodeJS.ProcessEnv): { harness: string; raw: string } | null {
  const hits: Array<{ harness: string; raw: string }> = [];

  for (const [name, value] of Object.entries(env)) {
    const matched = DISCOVERY_RE.exec(name);
    if (!matched) continue;
    const prefix = matched[1] as string;
    if (DISCOVERY_EXCLUDE_PREFIXES.some((bad) => prefix === bad || prefix.startsWith(bad))) {
      continue;
    }
    const raw = value?.trim();
    if (!raw || raw.length < DISCOVERY_VALUE_MIN || raw.length > DISCOVERY_VALUE_MAX) continue;
    hits.push({ harness: prefix.toLowerCase(), raw });
  }

  if (hits.length === 0) return null;
  // 排序后再取第一个：env 的枚举顺序不保证稳定，直接取第一个会让同一台机器上的
  // 两次调用可能给出不同身份——那比选错更糟（选错至少是稳定的）
  hits.sort((a, b) => a.harness.localeCompare(b.harness));
  return hits[0] ?? null;
}

/**
 * 拼出身份 key（同时也是文件名）。
 *
 * 常见情况（UUID、短 id）原样保留，文件名要能被人一眼认出是哪个 agent；
 * 含非法字符或过长时截断 + 哈希——因为 `"a/b"` 与 `"a\\b"` 清洗后会长得一模一样，
 * 不加哈希就会静默共用同一个身份，正好是这次要消灭的那类 bug。
 *
 * `kind === "path"` 时**一律**补哈希，不因为“看起来安全”就省：
 * 不同 harness 的会话文件可能同名规则，basename 撞车时哈希是唯一的区分手段。
 * 哈希取的是**完整原值**（含目录），所以两个目录下同名的文件也不会共用身份。
 */
function makeSessionKey(harness: string, raw: string, kind: "id" | "path"): string {
  const prefix = harness.replace(KEY_UNSAFE_RE_G, "_");
  const value = kind === "path" ? lastPathSegment(raw) : raw;

  if (kind === "id" && value.length <= KEY_MAX_LEN && !KEY_UNSAFE_RE.test(value)) {
    return `${prefix}-${value}`;
  }
  const head = value.replace(KEY_UNSAFE_RE_G, "_").slice(0, KEY_MAX_LEN);
  return `${prefix}-${head}-${shortHash(raw)}`;
}

/**
 * 取路径的最后一段。
 *
 * 不用 `node:path` 的 basename：那个函数认的是**本机**的分隔符，
 * 而这里处理的是别人（harness）写进环境变量的字符串，测试也可能在 Windows 上喂 POSIX 路径。
 * 两种分隔符都认，简单且无歧义。
 */
function lastPathSegment(value: string): string {
  const cut = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  return cut === -1 ? value : value.slice(cut + 1);
}

/** FNV-1a 32 位哈希（base36 输出），只用于给 key 加区分后缀，不承担安全职责 */
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, "0");
}

/** 身份分片文件的绝对路径：`<.kanban>/sessions/<key>` */
export function sessionKeyFilePath(dir: string, key: string): string {
  return join(dir, SESSIONS_DIRNAME, key);
}

/**
 * 分片文件的清理阈值：30 天。
 *
 * 为什么需要清理：identity key 来自 harness 的会话 UUID，**每开一个 agent 会话就多一个文件**。
 * 本项目自己 dogfood 时一天能开十几个会话，不清理的话 `.kanban/sessions/` 会无声地长到几千个文件。
 *
 * 为什么 30 天是安全的：判据是文件的 mtime（= `session start` 的时刻），
 * 而 30 天比任何合理的失联宽限（默认 10 分钟）长三个数量级——一个 30 天没敲过命令的
 * agent，它的 session 早被僵尸回收判成 crashed 了（卡也早回到 todo、进度保留），
 * 那份身份文件留着也没用，删掉与看板自身的语义一致。
 */
export const SESSION_KEY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 清理过期的身份分片文件，返回被删掉的文件名。
 *
 * 只在 `session start` 时调用（写新身份的那一刻顺手收拾），读路径不做任何清理——
 * 读路径一旦有副作用，测试和并发推理都会变麻烦。
 *
 * 目录不存在直接返回空：首次 `session start` 时它就是空的，不该报错。
 */
export function pruneStaleSessionKeys(
  dir: string,
  opts: { ttlMs?: number; now?: number } = {},
): string[] {
  const ttl = opts.ttlMs ?? SESSION_KEY_TTL_MS;
  const now = opts.now ?? Date.now();
  const sessionsDir = join(dir, SESSIONS_DIRNAME);

  let names: string[];
  try {
    names = readdirSync(sessionsDir);
  } catch {
    return [];
  }

  const removed: string[] = [];
  for (const name of names) {
    const file = join(sessionsDir, name);
    try {
      if (!statSync(file).isFile()) continue;
      if (now - statSync(file).mtimeMs <= ttl) continue;
      rmSync(file, { force: true });
      removed.push(name);
    } catch {
      // 竞态：别的进程刚写完/刚删掉。清理失败不影响本次 session start，直接跳过
    }
  }
  return removed;
}

export interface KanbanPaths {
  /** .kanban 目录绝对路径 */
  dir: string;
  /** 主库绝对路径 */
  db: string;
  /** 事件 journal 目录（入 git，跨机器恢复用） */
  journalDir: string;
  /** 计划归档目录（入 git，人可读） */
  plansDir: string;
  /** 看板快照目录（入 git，DB 丢失可参考） */
  snapshotsDir: string;
  /** 身份分片目录：`<dir>/sessions/<key>`，见 resolveSessionKey */
  sessionsDir: string;
  /** 项目根目录（.kanban 的父目录） */
  projectRoot: string;
}

/**
 * 从给定起点向上查找 .kanban 目录。
 * 返回 null 表示在 MAX_LOOKUP_DEPTH 层内没找到（调用方决定是否报错）。
 */
export function findKanbanDir(startDir: string = process.cwd()): string | null {
  let current = resolve(startDir);
  for (let depth = 0; depth <= MAX_LOOKUP_DEPTH; depth++) {
    const candidate = join(current, KANBAN_DIR);
    if (existsSync(join(candidate, DB_FILENAME))) return candidate;
    const parent = dirname(current);
    // 已到文件系统根仍未命中
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * 宽松版目录发现：**只要 `.kanban` 目录存在**就算命中，不要求里面有数据库。
 *
 * 什么时候需要它：远程模式的项目，本地**没有** kanban.db（数据在 server 上），
 * 但仍然需要 `.kanban/config.toml` 存放 server 地址与 token。
 * 如果用严格版查找，远程项目会被当成“没初始化过”，导致 config set/show 报错。
 */
export function findKanbanDirLoose(startDir: string = process.cwd()): string | null {
  let current = resolve(startDir);
  for (let depth = 0; depth <= MAX_LOOKUP_DEPTH; depth++) {
    const candidate = join(current, KANBAN_DIR);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * 解析出完整路径集合。
 *
 * @param opts.db 显式指定的 db 路径（来自 --db 或 KANBAN_DB）
 * @param opts.cwd 查找起点，默认 process.cwd()
 * @param opts.mustExist 为 true 时找不到就抛 NOT_INIT(5)；`agent-kanban init` 传 false
 */
export function resolvePaths(
  opts: { db?: string | undefined; cwd?: string; mustExist?: boolean } = {},
): KanbanPaths {
  const { db: explicitDb, cwd = process.cwd(), mustExist = true } = opts;

  // ---- 情形 1：显式指定 db 路径 ----
  if (explicitDb && explicitDb.length > 0) {
    const dbPath = isAbsolute(explicitDb) ? explicitDb : resolve(cwd, explicitDb);
    const dir = dirname(dbPath);
    return buildPaths(dir, dbPath);
  }

  // ---- 情形 2：向上查找 ----
  const found = findKanbanDir(cwd);
  if (!found) {
    if (!mustExist) {
      // init 场景：按 cwd 推定将要创建的位置
      return buildPaths(join(resolve(cwd), KANBAN_DIR), join(resolve(cwd), KANBAN_DIR, DB_FILENAME));
    }
    throw KanbanError.notInit(
      `board data directory not found (no ${KANBAN_DIR}/${DB_FILENAME} within ${MAX_LOOKUP_DEPTH} levels above ${cwd})`,
      {
        reason: "kanban_dir_not_found",
        hint: "Run `agent-kanban init` in the project root to create the board; if a journal already exists you can restore it with `agent-kanban import`",
        cwd: resolve(cwd),
      },
    );
  }
  return buildPaths(found, join(found, DB_FILENAME));
}

/** 组装完整路径集合，并确保子目录已创建 */
function buildPaths(dir: string, dbPath: string): KanbanPaths {
  return {
    dir,
    db: dbPath,
    journalDir: join(dir, "journal"),
    plansDir: join(dir, "plans"),
    snapshotsDir: join(dir, "snapshots"),
    sessionsDir: join(dir, SESSIONS_DIRNAME),
    projectRoot: dirname(dir),
  };
}

// =============================================================================
// 附：核实一个新 harness 的会话环境变量（改 HARNESS_SESSION_ENV 之前先读这段）
// =============================================================================
//
// 本表里的每一项都是这么查出来的，**不要凭印象写变量名**——写错了不会报错，
// 只是那个变量永远不存在，自动分流静默失效，你却以为已经支持了。
//
// ```powershell
//   # 1. 找到真正的可执行文件（scoop 的 shim 只是转发壳）
//   Get-Content D:\Library\scoop\shims\<name>.shim | Select-String 'path\s*='
//
//   # 2. 在二进制里搜候选变量名
//   rg -a -o -N --no-filename '\b[A-Z][A-Z0-9_]{2,28}_SESSION_ID\b' <exe> | Sort-Object -Unique
//   #    以及该工具自己的前缀，确认没有遗漏
//   rg -a -o -N --no-filename '\b<NAME>_[A-Z0-9_]{2,40}\b' <exe> | Sort-Object -Unique
//
//   # 3. 看命中处的上下文，判断它到底是“注入给子进程的 env”还是只是错误串常量
//   #    （最有用的一步：多个变量名挨在一起出现，就是一组 env）
// ```
//
// 判定标准：**看到多个变量名在同一段二进制里挨在一起**（像
// `GROK_HOOK_EVENT / GROK_HOOK_NAME / GROK_SESSION_ID / GROK_WORKSPACE_ROOT`），
// 基本就是“构造给子进程的环境变量”那一步；孤零零一个命中很可能只是常量池里的字符串。
//
// 本机实际结果（2026-09-27，`bun 1.4.2` / Windows）：
//
// | 工具          | 可执行文件                                  | 结果 |
// |---|---|---|
// | pi            | `scoop/apps/pi-coding-agent`                  | `PI_SESSION_ID` + `PI_SESSION_FILE`（本机实测） |
// | oh-my-pi      | `scoop/apps/oh-my-pi/omp.exe`                | `PI_SESSION_FILE`（**路径**，非 id） |
// | claude-code   | `scoop/apps/claude-code`                      | `CLAUDE_CODE_SESSION_ID`、`CLAUDE_SESSION_ID` |
// | grok          | `scoop/apps/grok-cli/grok.exe`               | `GROK_SESSION_ID` |
// | codex         | `scoop/apps/codex/bin/codex.exe` (0.157.1)    | `CODEX_SESSION_ID` ✅（另有 `CODEX_THREAD_ID`，仅新版） |
// | DeepSeek Harness | 本地 checkout（npm/TS，非编译二进制）        | `DSH_SESSION_ID` ✅（读源码；**仅 agent 调用**注入） |
// | Qoder            | 本地 checkout（obf.mjs，可读字符串）         | `QODER_SESSION_ID` / `QODERCN_SESSION_ID` ⚠（名字真实存在，读源码核实；
// |                  |                                              |   但**截至 2026-09-27 不注入**——见表上方注释的三条通道） |
//
// Qoder 核实过程补记（2026-09-27，QoderCN 1.0.72 / SDK 1.0.50，为什么敢断言"不注入"）：
//   - 最硬的证据是**本机真实 env**：Qoder 的 Bash 工具子进程里只有
//     `QODER_*/QODERCN_*` 的产品与配置类变量（SESSION_TYPE=app 是常量类型、无区分度），
//     没有任何会话 id。子进程 env 由 worker 继承而来，worker 里没有就是没有。
//   - app.asar 全文搜 `QODER_SESSION_ID|QODERCN_SESSION_ID` 零命中——桌面端没在
//     任何地方拼这个名字。
//   - obf.mjs 里 `ENV_QODER_SESSION_ID`/`ENV_QODER_SESSION_NAME` 是**导出的配置常量**
//     （loadCliConfig 用 `${km}SESSION_ID` 读 env 覆盖 session 配置），是输入不是注入。
//   - 顺带查过并排除的旁路：shell-snapshots（纯 PATH 快照）、`~/.qoder-cn/session-env/`
//     （每会话目录里只有空的 hook 快照脚本）、MCP stdio 配置的 env 展开
//     （`expandMcpEnvVars` 只对 process.env 展开，拿不到 session id）。
//   - 若将来想接上：hook stdin JSON 里有 `session_id`（CC 兼容），skill 文本可用
//     `${QODER_SESSION_ID}` 替换——这两条是 Qoder 官方留给外部进程拿会话 id 的口子。
// | cursor-agent  | `%LOCALAPPDATA%/cursor-agent`                 | ❌ 只有 `CURSOR_AGENT_SOCKET` 这类进程级变量 |
//
// ⚠ **扫描方法本身也有坑**：`rg '\bCODEX_[A-Z_]+\b'` 这种带 `\b` 的正则会**漏**。
//   Rust 编译出的 rodata 里字符串是**紧挨着排的**（没有 NUL 分隔），
//   前一个字符串的末尾字母会让下一个字符串的 `\b` 判定失败。
//   本机实测：`CODEX_SESSION_ID` 用 `--fixed-strings` 数出 1 处，
//   用带 `\b` 的正则却在清单里**完全不出现**。所以：
//   **先不带 `\b` 的宽松正则列候选，再用 `--fixed-strings` 逐个确认，最后 dump 上下文。**
//   另外别用 `Select-Object -First N` 截断清单——我就是这么得出“codex 没有会话变量”
//   的错误结论的，截断后的清单看起来完整得很。
//
// 另外三个坑：
//   - 值是**路径**而不是 id 时要标 `kind: "path"`（否则 key 会变成一串被清洗过的目录）
//   - 一个工具可能设置**多个**候选变量（如 pi 同时有 `PI_SESSION_ID` 和 `PI_SESSION_FILE`），
//     表里的顺序必须让更“准”的那个先命中，否则会顶着另一个工具的身份。
//   - 官方文档/源码比翻二进制更权威：codex 的 `CODEX_SESSION_ID` 是先翻二进制没找到、
//     后查 `codex-rs/core/src/exec_env.rs` 才确认的。**两条路都要走。**
//   - **有源码就别用搜索结果**：DeepSeek Harness 的网页搜索摘要还在说 `DSH_SESSION_JSONL`，
//     而仓库里的决策笔记（`.agents/notes/archived/simplification/2026-08-27-*.md`）
//     明确写着该变量**已移除**。环境变量这种事实，搜索摘要会过期，源码不会。
