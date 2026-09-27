/**
 * 身份分片：让同一目录里的多个 agent 自动分开（回归测试）。
 *
 * ## 要防的是哪一类事故
 *
 * 改造前所有 agent 共用 `.kanban/session` **一个文件**。同目录跑两个 agent 时，
 * 第二个 `session start` 直接覆盖第一个，于是两边的命令都被记到同一个 session 名下：
 * 租约互相看不见、冲突信息指向一个不存在的"另一个人"、事件流分不清谁做的。
 * **全程不报错**，只有等到两张卡互相踩才看得出来——最难查的那一类。
 *
 * 修法是用 harness 注入的每会话唯一环境变量当 identity key，一个 key 一个文件
 * （`.kanban/sessions/<key>`），见 `src/core/paths.ts` 的 `resolveSessionKey`。
 * 怎么给某个工具找出那个变量名，写在 paths.ts 文件末尾（别凭印象写）。
 *
 * ## 四条不能破的规则（各有对应测试）
 *
 *   1. key 解析不出来时，行为必须与改造前**逐字一致**（读旧单文件）
 *   2. key 解析得出来时，**绝不能**回退读旧单文件——那等于让 B 冒充 A
 *   3. keyful 侧**不写**旧单文件——否则等于在新机制旁边留了个冒充后门
 *   4. 身份粒度不能比 agent 本身更细（codex 的 thread ≠ session，见下面那条测试）
 *   5. **远程模式也写身份文件**——写入与读取必须对称，见第五个 describe
 *
 * 用法：真的 spawn `bun run src/cli.ts`，因为要证明的正是"两个进程在同一目录"的真实行为。
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  pruneStaleSessionKeys,
  resolveSessionKey,
  SESSION_KEY_ENV,
  SESSION_KEY_TTL_MS,
  sessionKeyFilePath,
} from "../src/core/paths.ts";
import { readSessionFile, writeSessionFile, type Ctx } from "../src/commands/context.ts";
import { migrate, openDb, setInitialConfig } from "../src/core/db.ts";
import { createProject } from "../src/core/projects.ts";
import { issueToken } from "../src/core/tokens.ts";
import { withTx } from "../src/core/tx.ts";
import { startServer } from "../src/server/http.ts";

const ROOT = resolve(import.meta.dir, "..");

// 造几个假 UUID（只要求"稳定 + 唯一"）
const KEY_A = "11111111-2222-3333-4444-555555555555";
const KEY_B = "66666666-7777-8888-9999-000000000000";
const KEY_C = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

// =============================================================================
// 一、key 解析（纯函数，不需要 fs）
// =============================================================================

describe("身份 key 解析", () => {
  test("没有任何 harness 变量时返回 null（调用方退回旧单文件）", () => {
    expect(resolveSessionKey({})).toBeNull();
  });

  test("PI_SESSION_ID → pi- 前缀，文件名能直接认出是哪个 agent", () => {
    expect(resolveSessionKey({ PI_SESSION_ID: KEY_A })).toBe(`pi-${KEY_A}`);
  });

  test(`${SESSION_KEY_ENV} 压过 harness 表（未列入表的 harness 的逃生口）`, () => {
    const key = resolveSessionKey({ PI_SESSION_ID: KEY_A, [SESSION_KEY_ENV]: "my-stable-key" });
    expect(key).toBe("custom-my-stable-key");
  });

  test("空串与纯空白一律当没设（否则两个进程会共用一个空 key）", () => {
    expect(resolveSessionKey({ PI_SESSION_ID: "" })).toBeNull();
    expect(resolveSessionKey({ PI_SESSION_ID: "   " })).toBeNull();
    expect(resolveSessionKey({ PI_SESSION_ID: "", [SESSION_KEY_ENV]: " " })).toBeNull();
  });

  test("环境变量值两端空白被裁掉（harness 偶尔带尾随空格）", () => {
    expect(resolveSessionKey({ PI_SESSION_ID: `  ${KEY_A}  ` })).toBe(`pi-${KEY_A}`);
  });

  test("非法字符被清洗，且清洗后同形的两个原值不会撞成同一个 key", () => {
    // "a/b" 与 "a\\b" 清洗后都是 "a_b"；不加哈希就会静默共用身份 —— 正是这次要消灭的 bug
    const k1 = resolveSessionKey({ PI_SESSION_ID: "a/b" });
    const k2 = resolveSessionKey({ PI_SESSION_ID: "a\\b" });
    expect(k1).not.toBeNull();
    expect(k2).not.toBeNull();
    expect(k1).not.toBe(k2);
    expect(k1).toMatch(/^pi-a_b-[0-9a-z]+$/);
  });

  test("超长值截断并加哈希后缀，不同原值仍然互不相同", () => {
    const long1 = "x".repeat(80);
    const long2 = `${"x".repeat(79)}y`;
    const k1 = resolveSessionKey({ PI_SESSION_ID: long1 });
    const k2 = resolveSessionKey({ PI_SESSION_ID: long2 });
    expect(k1).not.toBe(k2);
    // 文件名长度有上限，否则在 Windows 上会撞 260 字符路径限制
    expect((k1 as string).length).toBeLessThanOrEqual(70);
  });

  test("点号不是安全字符（否则能拼出 .. / ... 这类怪文件名）", () => {
    const key = resolveSessionKey({ PI_SESSION_ID: ".." });
    expect(key).not.toBeNull();
    expect(key).not.toContain("..");
    expect((key as string).startsWith("pi-")).toBe(true);
  });
});

// =============================================================================
// 一之二、其它 harness（每一项都经过核实，不是凭印象；办法见 paths.ts 末尾）
// =============================================================================

describe("其它 harness 的身份变量", () => {
  test("grok：GROK_SESSION_ID", () => {
    expect(resolveSessionKey({ GROK_SESSION_ID: KEY_B })).toBe(`grok-${KEY_B}`);
  });

  test("claude-code：CLAUDE_CODE_SESSION_ID", () => {
    expect(resolveSessionKey({ CLAUDE_CODE_SESSION_ID: KEY_B })).toBe(`claude-code-${KEY_B}`);
  });

  test("codex：CODEX_SESSION_ID（root session）", () => {
    expect(resolveSessionKey({ CODEX_SESSION_ID: KEY_B })).toBe(`codex-${KEY_B}`);
  });

  test("deepseek：DSH_SESSION_ID，key 前缀写全 deepseek-harness（避免被读成模型名）", () => {
    expect(resolveSessionKey({ DSH_SESSION_ID: KEY_B })).toBe(`deepseek-harness-${KEY_B}`);
  });

  test("qoder：QODER_SESSION_ID / QODERCN_SESSION_ID（同一配置的两种产品前缀）", () => {
    // 名字核实自 SDK 源码（ENV_QODER_SESSION_ID 常量按产品翻成 QODER_/QODERCN_）。
    // 截至 2026-09-27 Qoder 尚不注入，进表是让"一旦注入/手动设置"立即生效且前缀统一。
    expect(resolveSessionKey({ QODER_SESSION_ID: KEY_A })).toBe(`qoder-${KEY_A}`);
    expect(resolveSessionKey({ QODERCN_SESSION_ID: KEY_B })).toBe(`qoder-${KEY_B}`);
  });

  test("qoder：两个前缀同时出现时按表内顺序，结果必须确定", () => {
    const key = resolveSessionKey({ QODER_SESSION_ID: KEY_A, QODERCN_SESSION_ID: KEY_B });
    expect(key).toBe(`qoder-${KEY_A}`);
  });

  test("qoder：SESSION_TYPE 这类非 id 变量不算身份", () => {
    // Qoder 真实注入的只有 QODERCN_SESSION_TYPE=app（常量类型，所有会话都一样）
    expect(resolveSessionKey({ QODERCN_SESSION_TYPE: "app" })).toBeNull();
  });

  test("codex：thread 与 session 同时存在时取 session（更粗的粒度才对）", () => {
    // 规则 4：一个 codex agent 内部的并行 thread 是**同一个 agent**，应该共用一个看板身份。
    // 按 thread 分片会把它们变成 N 个"不同 agent"互相抢同一批卡。
    // 身份要按"一次 agent 会话"切，不能切得比 agent 本身更细。
    const key = resolveSessionKey({ CODEX_SESSION_ID: KEY_A, CODEX_THREAD_ID: KEY_B });
    expect(key).toBe(`codex-${KEY_A}`);
  });

  test("oh-my-pi：PI_SESSION_FILE 是**路径**，只取文件名、不带目录", () => {
    // omp 注入给子进程的是会话 jsonl 的路径，不是 id
    const file =
      "C:\\Users\\me\\.omp\\sessions\\2026-09-27T01-24-00-725Z_01a0debe-ca55-752e-895f-c20eb141ac19.jsonl";
    const key = resolveSessionKey({ PI_SESSION_FILE: file }) as string;
    expect(key.startsWith("oh-my-pi-")).toBe(true);
    expect(key).toContain("2026-09-27T01-24-00-725Z_01a0debe");
    // 目录部分不能出现：它对同目录并行的每个 agent 都一样，没有区分度
    expect(key).not.toContain("Users");
    expect(key).not.toContain(".omp");
  });

  test("oh-my-pi：POSIX 路径同样只取最后一段", () => {
    const key = resolveSessionKey({
      PI_SESSION_FILE: "/home/me/.omp/sessions/2026-09-27T01-24-00-725Z_abcdef01.jsonl",
    }) as string;
    expect(key).not.toContain("home");
    expect(key).toContain("abcdef01");
  });

  test("oh-my-pi：两个目录下**同名**文件不会共用身份（哈希取的是完整原值）", () => {
    const a = resolveSessionKey({ PI_SESSION_FILE: "/home/alice/.omp/sessions/run.jsonl" });
    const b = resolveSessionKey({ PI_SESSION_FILE: "/home/bob/.omp/sessions/run.jsonl" });
    expect(a).not.toBe(b);
  });

  test("pi 优先于 oh-my-pi：pi 同时设置了两个变量，表里的顺序不能弄错", () => {
    // 少了这条，在 pi 里跑会顶着 oh-my-pi 的身份（key 前缀变成 oh-my-pi）
    const key = resolveSessionKey({
      PI_SESSION_ID: KEY_A,
      PI_SESSION_FILE: "C:\\Users\\me\\.omp\\sessions\\x.jsonl",
    });
    expect(key).toBe(`pi-${KEY_A}`);
  });

  test("codex：只有配置类变量时解析不出身份", () => {
    // 这些是真的配置项，不能被误当成会话身份
    expect(
      resolveSessionKey({
        CODEX_HOME: "C:\\Users\\me\\.codex",
        CODEX_ROLLOUT_TRACE_ROOT: "C:\\Users\\me\\.codex\\log",
        CODEX_API_KEY: "sk-something",
        CODEX_SANDBOX_NETWORK_DISABLED: "1",
      }),
    ).toBeNull();
  });
});

// =============================================================================
// 一之三、按命名约定自动发现
// =============================================================================

describe("自动发现 <TOOL>_SESSION_ID", () => {
  test("表里没有的工具也能直接用上（key 前缀取自变量名）", () => {
    expect(resolveSessionKey({ ZEBRA_SESSION_ID: KEY_B })).toBe(`zebra-${KEY_B}`);
  });

  test("claude 的另一个变量名 CLAUDE_SESSION_ID 也能被收编", () => {
    expect(resolveSessionKey({ CLAUDE_SESSION_ID: KEY_B })).toBe(`claude-${KEY_B}`);
  });

  test("终端/遥测/API 层的同名变量一律排除（它们不是 agent 会话身份）", () => {
    // 这几个名字都是扫描本机已装工具的二进制时**实际看到**的
    for (const name of [
      "TERM_SESSION_ID",
      "ITERM_SESSION_ID",
      "OTEL_METRICS_INCLUDE_SESSION_ID",
      "ANTHROPIC_SESSION_ID",
      "SERVER_ECHOED_INVALID_SESSION_ID",
    ]) {
      expect(resolveSessionKey({ [name]: KEY_B })).toBeNull();
    }
  });

  test("多个候选时按变量名排序取第一个，且与 env 枚举顺序无关", () => {
    const one = resolveSessionKey({ ZEBRA_SESSION_ID: KEY_A, ALPHA_SESSION_ID: KEY_B });
    const two = resolveSessionKey({ ALPHA_SESSION_ID: KEY_B, ZEBRA_SESSION_ID: KEY_A });
    // env 的枚举顺序不保证稳定；结果必须只取决于变量名，否则同一台机器两次调用
    // 可能给出不同身份——那比选错更糟（选错至少是稳定的）
    expect(one).toBe(`alpha-${KEY_B}`);
    expect(one).toBe(two);
  });

  test("表里的 harness 永远压过自动发现", () => {
    const key = resolveSessionKey({ PI_SESSION_ID: KEY_A, ZEBRA_SESSION_ID: KEY_B });
    expect(key).toBe(`pi-${KEY_A}`);
  });

  test("太短的值当噪音滤掉（SESSION_ID=1 不是身份）", () => {
    expect(resolveSessionKey({ ZEBRA_SESSION_ID: "1" })).toBeNull();
    expect(resolveSessionKey({ ZEBRA_SESSION_ID: "" })).toBeNull();
    expect(resolveSessionKey({ ZEBRA_SESSION_ID: "x".repeat(300) })).toBeNull();
  });

  test("不匹配的形状不碰（只认 <TOOL>_SESSION_ID）", () => {
    expect(resolveSessionKey({ ZEBRA_SESSION: KEY_B })).toBeNull();
    expect(resolveSessionKey({ ZEBRA_ID: KEY_B })).toBeNull();
    expect(resolveSessionKey({ zebra_session_id: KEY_B })).toBeNull();
  });
});

// =============================================================================
// 二、身份文件读写（需要 fs）
// =============================================================================

describe("身份文件的读写与隔离", () => {
  let dir: string;

  /** 只用到 paths.dir 与 now()，为测一个 fs 函数去开真库不划算 */
  function fakeCtx(d: string): Ctx {
    return { paths: { dir: d }, now: () => Date.now() } as unknown as Ctx;
  }

  /** 临时改环境变量，测试结束自动还原 */
  function withEnv(vars: Record<string, string>, fn: () => void): void {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  /** 清掉所有可能影响 key 解析的变量 */
  function noKeyEnv(): Record<string, string> {
    return {
      PI_SESSION_ID: "",
      PI_SESSION_FILE: "",
      CLAUDE_CODE_SESSION_ID: "",
      GROK_SESSION_ID: "",
      CODEX_SESSION_ID: "",
      DSH_SESSION_ID: "",
      QODER_SESSION_ID: "",
      QODERCN_SESSION_ID: "",
      [SESSION_KEY_ENV]: "",
    };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kanban-identity-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("写进去读得回来", () => {
    withEnv({ ...noKeyEnv(), PI_SESSION_ID: KEY_A }, () => {
      writeSessionFile(fakeCtx(dir), "s-aaaaaa");
      expect(readSessionFile(dir)).toBe("s-aaaaaa");
    });
  });

  test("核心回归：换一个人的 key，绝不能读到上一个人写的身份", () => {
    withEnv({ ...noKeyEnv(), PI_SESSION_ID: KEY_A }, () => {
      writeSessionFile(fakeCtx(dir), "s-aaaaaa");
    });
    withEnv({ ...noKeyEnv(), PI_SESSION_ID: KEY_B }, () => {
      // B 没注册过 → null，而不是 "s-aaaaaa"
      expect(readSessionFile(dir)).toBeNull();
    });
  });

  test("核心回归：key 解析得出来时，即使旧单文件在也不回退（不许冒充）", () => {
    // 造一个"别人留下的"旧单文件，正是改造前会出事的场景
    writeFileSync(join(dir, "session"), "s-someone-else", "utf8");
    withEnv({ ...noKeyEnv(), PI_SESSION_ID: KEY_B }, () => {
      expect(readSessionFile(dir)).toBeNull();
    });
  });

  test("规则一：无 key 时行为与改造前一致，读旧单文件", () => {
    writeFileSync(join(dir, "session"), "s-legacy", "utf8");
    withEnv(noKeyEnv(), () => {
      expect(readSessionFile(dir)).toBe("s-legacy");
    });
  });

  test("规则三：有 key 时不写旧单文件（不给 keyless 进程留冒充后门）", () => {
    withEnv({ ...noKeyEnv(), PI_SESSION_ID: KEY_A }, () => {
      writeSessionFile(fakeCtx(dir), "s-aaaaaa");
    });
    expect(existsSync(join(dir, "session"))).toBe(false);
    expect(existsSync(sessionKeyFilePath(dir, `pi-${KEY_A}`))).toBe(true);
  });

  test("规则一（写侧）：无 key 时只写旧单文件，不建 sessions 目录", () => {
    withEnv(noKeyEnv(), () => {
      writeSessionFile(fakeCtx(dir), "s-legacy");
    });
    expect(existsSync(join(dir, "session"))).toBe(true);
    expect(existsSync(join(dir, "sessions"))).toBe(false);
  });

  test("两个 key 各写各的文件，互不覆盖", () => {
    withEnv({ ...noKeyEnv(), PI_SESSION_ID: KEY_A }, () => {
      writeSessionFile(fakeCtx(dir), "s-aaaaaa");
    });
    withEnv({ ...noKeyEnv(), GROK_SESSION_ID: KEY_B }, () => {
      writeSessionFile(fakeCtx(dir), "s-bbbbbb");
    });
    expect(existsSync(sessionKeyFilePath(dir, `pi-${KEY_A}`))).toBe(true);
    expect(existsSync(sessionKeyFilePath(dir, `grok-${KEY_B}`))).toBe(true);
    withEnv({ ...noKeyEnv(), PI_SESSION_ID: KEY_A }, () => {
      expect(readSessionFile(dir)).toBe("s-aaaaaa");
    });
    withEnv({ ...noKeyEnv(), GROK_SESSION_ID: KEY_B }, () => {
      expect(readSessionFile(dir)).toBe("s-bbbbbb");
    });
  });

  test("oh-my-pi 的 key 文件名不含目录分隔符（能安全当文件名用）", () => {
    withEnv({ ...noKeyEnv(), PI_SESSION_FILE: "/home/me/.omp/sessions/run-42.jsonl" }, () => {
      writeSessionFile(fakeCtx(dir), "s-omp");
      const files = readdirSync(join(dir, "sessions"));
      expect(files.length).toBe(1);
      expect((files[0] as string).startsWith("oh-my-pi-")).toBe(true);
      expect((files[0] as string)).not.toContain("/");
      expect((files[0] as string)).not.toContain("\\");
    });
  });
});

// =============================================================================
// 三、过期分片清理
// =============================================================================

describe("过期身份分片清理", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kanban-prune-"));
    mkdirSync(join(dir, "sessions"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const NOW = 1_700_000_000_000;

  /** 写一个 mtime 在 now - ageMs 的分片文件 */
  function shard(key: string, ageMs: number, now: number): string {
    const file = sessionKeyFilePath(dir, key);
    writeFileSync(file, "s-x", "utf8");
    const past = new Date(now - ageMs);
    utimesSync(file, past, past);
    return file;
  }

  test("超过 TTL 的被删掉，未超期的留下", () => {
    const stale = shard("pi-stale", SESSION_KEY_TTL_MS + 1000, NOW);
    const fresh = shard("pi-fresh", 1000, NOW);
    const removed = pruneStaleSessionKeys(dir, { now: NOW });
    expect(removed).toEqual(["pi-stale"]);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  test("目录不存在时安静返回空（首次 session start 就是空的）", () => {
    const missing = join(dir, "does-not-exist");
    expect(pruneStaleSessionKeys(missing, { now: NOW })).toEqual([]);
  });

  test("临时目录本身不存在也不报错", () => {
    expect(pruneStaleSessionKeys(join(tmpdir(), "kanban-never-created-xyz"), { now: NOW })).toEqual([]);
  });

  test("只删文件，不动子目录", () => {
    mkdirSync(sessionKeyFilePath(dir, "subdir"), { recursive: true });
    const past = new Date(NOW - SESSION_KEY_TTL_MS - 1000);
    utimesSync(sessionKeyFilePath(dir, "subdir"), past, past);
    pruneStaleSessionKeys(dir, { now: NOW });
    expect(existsSync(sessionKeyFilePath(dir, "subdir"))).toBe(true);
  });
});

// =============================================================================
// 四、端到端：同目录两个真进程
// =============================================================================

describe("同目录两个 agent 的真实行为（spawn CLI）", () => {
  let dir: string;
  let dbPath: string;
  /** 两个 agent 各自的 session id，由 session start --json 取回 */
  let sessionA = "";
  let sessionB = "";
  /** 无 key 进程自己注册的会话（它用的是旧单文件，文件名不同） */
  let bareShellSession = "";

  interface RunResult {
    code: number;
    stdout: string;
    stderr: string;
  }

  /**
   * 跑一次真实 CLI。
   *
   * `key` 传空串表示"这个进程解析不出身份 key"（无 harness 变量的裸 shell）——
   * 之所以能用空串而不是删变量，是因为 resolveSessionKey 把空串当没设，
   * 这样就不必去动 Bun.spawn 的 env 继承语义。
   *
   * `extraEnv` 用来覆盖单个变量，验证优先级链的边界（见下面空 KANBAN_SESSION 那条）。
   */
  async function cli(
    args: string[],
    key = "",
    extraEnv: Record<string, string> = {},
  ): Promise<RunResult> {
    const proc = Bun.spawn(["bun", "run", join(ROOT, "src", "cli.ts"), ...args, "--db", dbPath], {
      cwd: ROOT,
      env: {
        ...process.env,
        KANBAN_DB: dbPath,
        PI_SESSION_ID: key,
        PI_SESSION_FILE: "",
        CLAUDE_CODE_SESSION_ID: "",
        GROK_SESSION_ID: "",
        CODEX_SESSION_ID: "",
        DSH_SESSION_ID: "",
        QODER_SESSION_ID: "",
        QODERCN_SESSION_ID: "",
        [SESSION_KEY_ENV]: "",
        // 父进程（跑测试的这台机器）自己可能就在某个 harness 里，别让它泄进来
        KANBAN_SESSION: "",
        ...extraEnv,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  }

  /** 按标题查任务 ID：避免把 ID 硬编码成"第几张卡"（测试顺序一变就错） */
  async function idOf(title: string): Promise<string> {
    const r = await cli(["task", "list", "--json"], KEY_A);
    const tasks = JSON.parse(r.stdout) as Array<{ id: string; title: string }>;
    const hit = tasks.find((t) => t.title === title);
    if (!hit) throw new Error(`task not found: ${title}`);
    return hit.id;
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "kanban-e2e-identity-"));
    dbPath = join(dir, "e2e.db");

    await cli(["init", "--name", "identity-e2e"]);
    await cli(["task", "add", "card-one"]);
    await cli(["task", "add", "card-two"]);

    const a = await cli(["session", "start", "--agent", "agent-a", "--harness", "pi", "--json"], KEY_A);
    const b = await cli(
      ["session", "start", "--agent", "agent-b", "--harness", "grok", "--json"],
      "",
      { GROK_SESSION_ID: KEY_B },
    );
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    sessionA = (JSON.parse(a.stdout) as { id: string }).id;
    sessionB = (JSON.parse(b.stdout) as { id: string }).id;
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("两个 session start（一个 pi、一个 grok）拿到不同的 session id", () => {
    expect(sessionA).not.toBe(sessionB);
  });

  test("各自认领各自的卡，Holder 互不干扰", async () => {
    const ra = await cli(["task", "claim", "T-0001", "--json"], KEY_A);
    const rb = await cli(["task", "claim", "T-0002", "--json"], "", { GROK_SESSION_ID: KEY_B });
    expect(ra.code).toBe(0);
    expect(rb.code).toBe(0);
  });

  test("A 去抢 B 的卡：退出码 3，且错误里指名 B —— 冲突信息终于指向真实的人", async () => {
    const r = await cli(["task", "claim", "T-0002", "--json"], KEY_A);
    expect(r.code).toBe(3);
    // --json 的错误走 stderr，包一层 { error: { code, name, message, details } }
    const err = JSON.parse(r.stderr) as {
      error?: { details?: { holder?: { session_id?: string; agent_name?: string } } };
    };
    expect(err.error?.details?.holder?.session_id).toBe(sessionB);
    expect(err.error?.details?.holder?.agent_name).toBe("agent-b");
  });

  test("C 有身份 key 但从未注册：退出码 1，且提示里给出修复动作（而不是冒充 A）", async () => {
    const r = await cli(["task", "claim", "T-0001", "--json"], KEY_C);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("missing session id");
    // 提示必须可直接照做：指名身份 key，并给出 session start
    expect(r.stderr).toContain(`pi-${KEY_C}`);
    expect(r.stderr).toContain("session start");
    // 关键：绝不能是 CONFLICT（说明它没去抢 A 的卡），也不能悄悄成功
    expect(r.stderr).not.toContain("CONFLICT");
  });

  test("无 key 的进程不会冒充任何人：注册前报错，注册后拿到自己的身份", async () => {
    // 每次用新卡：复用已持有的卡会让 exit 3（正确的冲突）盖住真正要验的东西
    await cli(["task", "add", "card-bare-shell"]);
    const card = await idOf("card-bare-shell");

    const before = await cli(["task", "claim", card, "--json"], "");
    expect(before.code).toBe(1);
    expect(before.stderr).toContain("missing session id");

    const start = await cli(["session", "start", "--agent", "bare-shell", "--json"], "");
    expect(start.code).toBe(0);
    const mine = (JSON.parse(start.stdout) as { id: string }).id;
    bareShellSession = mine;
    expect([sessionA, sessionB]).not.toContain(mine);

    const after = await cli(["task", "claim", card, "--json"], "");
    expect(after.code).toBe(0);
    const claimed = JSON.parse(after.stdout) as { assignee_session_id: string };
    expect(claimed.assignee_session_id).toBe(mine);
  });

  test("看板上的会话列表里三个身份各自独立", async () => {
    const r = await cli(["session", "list", "--all", "--json"], KEY_A);
    const views = JSON.parse(r.stdout) as Array<{ id: string; agent_name: string }>;
    const ids = views.map((v) => v.id);
    expect(ids).toContain(sessionA);
    expect(ids).toContain(sessionB);
    // 同一个 session id 不会挂着两个 agent 名
    const byId = new Map(views.map((v) => [v.id, v.agent_name]));
    expect(byId.get(sessionA)).toBe("agent-a");
    expect(byId.get(sessionB)).toBe("agent-b");
  });

  test("身份分片目录里确实落了独立文件（证明不是靠巧合跑通的）", () => {
    const files = readdirSync(join(dir, "sessions"));
    expect(files).toContain(`pi-${KEY_A}`);
    expect(files).toContain(`grok-${KEY_B}`);
  });

  /**
   * 回归：**空** `KANBAN_SESSION` 不能压掉身份文件。
   *
   * 这条守的是一个先于身份分片就已存在的坑：原优先级链写成
   * `process.env.KANBAN_SESSION ?? readSessionFile(...)`，而 `KANBAN_SESSION=`
   * （shell 里给变量赋空，最常见的"取消设置"写法）**不是 nullish**，
   * 于是空串直接胜出，身份文件被忽略、sessionId 变成空串。
   *
   * 后果静默到没法查：两个 agent 都以空身份跑，A 再 claim B 的卡会被当成
   * "自己已持有 → 续租"而成功退出 0，看板 holder 栏是空白。
   * （写这个测试时真的先撞上了：期望 exit 3，实测 exit 0，holder 是空串。）
   */
  test("回归：KANBAN_SESSION 为空串时，仍按身份文件认人（不能变成空身份）", async () => {
    await cli(["task", "add", "card-empty-env"]);
    const card = await idOf("card-empty-env");

    const ra = await cli(["task", "claim", card, "--json"], KEY_A, { KANBAN_SESSION: "" });
    expect(ra.code).toBe(0);
    const claimed = JSON.parse(ra.stdout) as { assignee_session_id: string };
    expect(claimed.assignee_session_id).toBe(sessionA);

    // 关键断言：空串环境下 B 去抢 A 的卡必须报冲突。
    // 修复前这里会 exit 0（两个都是空身份 → 认成自己持有 → 续租）
    const rb = await cli(["task", "claim", card, "--json"], "", {
      GROK_SESSION_ID: KEY_B,
      KANBAN_SESSION: "",
    });
    expect(rb.code).toBe(3);
  });

  test("收尾：每张被认领的卡都只有一个持有者，没有两个身份撞在一起", async () => {
    const r = await cli(["task", "list", "--json"], KEY_A);
    const tasks = JSON.parse(r.stdout) as Array<{ id: string; assignee_session_id: string | null }>;
    const holders = tasks.map((t) => t.assignee_session_id).filter((h): h is string => Boolean(h));

    // 看板是一行一卡，物理上不可能重复；这条实际守的是"没有空串持有者"——
    // 空身份会让所有持有者坍缩成同一个值，而那正是本次修掉的静默故障
    expect(holders).not.toContain("");

    // 四张卡全被认领（A 两张、B 一张、裸 shell 一张）
    expect(holders.length).toBe(4);
    // 恰好三个不同身份。注意不能断言 distinct === holders.length：
    // A 合法地持两张卡，那是正常的，不是撞车
    expect(new Set(holders).size).toBe(3);
    expect(new Set(holders)).toEqual(new Set([sessionA, sessionB, bareShellSession]));
  });

  test("Qoder 环境（有 QODER_* 标记、无会话 id）身份退化时 stderr 给修复提示", async () => {
    await cli(["task", "add", "card-qoder-hint"]);
    const card = await idOf("card-qoder-hint");
    const r = await cli(["session", "start", "--agent", "qoder-agent", "--json"], "", {
      QODERCN_SESSION_TYPE: "app",
    });
    expect(r.code).toBe(0);
    // 提示走 stderr：--json 模式 stdout 只能有单个 JSON
    expect(r.stderr).toContain("Qoder injects no session-id env var");
    expect(r.stderr).toContain("KANBAN_SESSION_KEY=qoder-<that-uuid>");
    // 拿到身份的进程不需要提示
    const ok = await cli(["task", "claim", card, "--json"], KEY_A, {
      QODERCN_SESSION_TYPE: "app",
    });
    expect(ok.code).toBe(0);
    expect(ok.stderr).not.toContain("KANBAN_SESSION_KEY");
  });
});

// =============================================================================
// 五、远程模式：身份文件照样要写
// =============================================================================

describe("远程模式下 session start 同样写身份文件（写入与读取必须对称）", () => {
  let dir: string;
  let server: ReturnType<typeof startServer>;
  let token: string;
  let sessionId = "";
  let project = "";
  /** session start 所在的工作目录；后续命令必须复用它（换个目录就是换了个身份） */
  let work = "";

  const NOW = 1_767_225_600_000;

  /**
   * 跑真实 CLI。
   *
   * `work` 为空时新建一个干净目录；**同一个序列里的后续命令必须复用它**——
   * 身份文件写在 `.kanban/sessions/<key>`，换个目录就等于换了个身份。
   * （写这条测试时先踩了这个坑：每条命令各自 mkdtemp，结果 claim 跑在
   * 一个从没 session start 过的目录里，报 missing session id，
   * 看起来像是修复没生效。）
   */
  async function remoteCli(args: string[], work = "", extraEnv: Record<string, string> = {}) {
    const cwd = work || mkdtempSync(join(tmpdir(), "kanban-remote-identity-"));
    if (!work) madeDirs.push(cwd);
    const proc = Bun.spawn(["bun", "run", join(ROOT, "src", "cli.ts"), ...args], {
      cwd,
      env: {
        ...process.env,
        KANBAN_SERVER: server.url,
        KANBAN_PROJECT: project,
        KANBAN_KEY: token,
        // 关键：不能继承本机的 KANBAN_DB / KANBAN_SESSION，
        // 否则测的就不是远程模式了（父进程可能正在本仓库里跑 agent）
        KANBAN_DB: "",
        KANBAN_SESSION: "",
        PI_SESSION_ID: KEY_A,
        PI_SESSION_FILE: "",
        CLAUDE_CODE_SESSION_ID: "",
        GROK_SESSION_ID: "",
        CODEX_SESSION_ID: "",
        DSH_SESSION_ID: "",
        QODER_SESSION_ID: "",
        QODERCN_SESSION_ID: "",
        [SESSION_KEY_ENV]: "",
        ...extraEnv,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    // 留下工作目录给断言查（身份文件在里面），测完统一删
    return { code, stdout, stderr, work: cwd };
  }

  const madeDirs: string[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "kanban-remote-identity-db-"));
    const dbPath = join(dir, "server.db");
    const handle = openDb(dbPath);
    migrate(handle);
    setInitialConfig(handle.raw, { projectName: "remote-identity" });
    project = "remote-identity";
    withTx(handle.raw, (tx) => {
      createProject(tx.db, { key: project, name: "远程身份测试" });
    });
    token = issueToken(
      handle.raw,
      { role: "project", projects: [project], name: "test" },
      NOW,
    ).plaintext;
    // now 要跟着真时钟走：CLI 子进程用 Date.now()，
    // 固定成 2026-01 会让 server 端把刚建的 session 判成“早就失联”。
    server = startServer({
      dbPath,
      host: "127.0.0.1",
      port: 0,
      reapIntervalSec: 3600,
      now: () => Date.now(),
      noBootstrap: true,
    });
  });

  afterAll(() => {
    server.stop();
    rmSync(dir, { recursive: true, force: true });
    for (const d of madeDirs) rmSync(d, { recursive: true, force: true });
  });

  /**
   * 真实事故：`session start` 里有 `&& ctx.backend.mode === "local"`，
   * 远程模式下**不写**身份文件；但读取端 `currentSessionId()` 不分模式，
   * 照样去读它。于是：
   *
   *   ✓ Session registered          ← 报告成功
   *   session_id : s-ky1roy          ← 打印了 id
   *   identity   : pi-...            ← 连身份 key 都打印了
   *   （.kanban 目录根本没被创建）
   *   $ task claim T-0001
   *   Error[USAGE]: missing session id, cannot tell who is operating
   *
   * 症状与“用户忘了跑 session start”一模一样，提示还反过来叫人去跑
   * `session start` —— 已经跑过了。`verify:web` 就是这么红的三项。
   */
  test("session start 在远程模式下真的落盘了身份文件", async () => {
    const start = await remoteCli(["session", "start", "--agent", "pi-fix", "--harness", "pi", "--json"]);
    expect(start.code).toBe(0);
    sessionId = (JSON.parse(start.stdout) as { id: string }).id;
    work = start.work;

    // 关键：文件必须存在，且内容就是刚拿到的 session id
    const keyFile = sessionKeyFilePath(join(start.work, ".kanban"), `pi-${KEY_A}`);
    expect(existsSync(keyFile)).toBe(true);
    expect(readFileSync(keyFile, "utf8").trim()).toBe(sessionId);
  });

  test("written_session_file 如实反映（曾经硬编码 false，本地模式写却说没写）", async () => {
    const work = mkdtempSync(join(tmpdir(), "kanban-remote-identity-"));
    madeDirs.push(work);
    const proc = Bun.spawn(
      ["bun", "run", join(ROOT, "src", "cli.ts"), "session", "start", "--agent", "a", "--json", "--no-write"],
      {
        cwd: work,
        env: {
          ...process.env,
          KANBAN_SERVER: server.url,
          KANBAN_PROJECT: project,
          KANBAN_KEY: token,
          KANBAN_DB: "",
          KANBAN_SESSION: "",
          PI_SESSION_ID: KEY_B,
          PI_SESSION_FILE: "",
          [SESSION_KEY_ENV]: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    expect(code).toBe(0);
    expect((JSON.parse(stdout) as { written_session_file?: boolean }).written_session_file).toBe(false);
    // --no-write 确实不落盘
    expect(existsSync(join(work, ".kanban", "sessions", `pi-${KEY_B}`))).toBe(false);
  });

  test("后续命令免传 --session：claim / progress / end 全部成功", async () => {
    // 整个远程目录里一条 KANBAN_SESSION 都没有，只能靠身份文件认人。
    // 修复前这一条就报 missing session id。
    // 注意全部复用 session start 那个 work —— 身份文件是写在里面的。
    const add = await remoteCli(["task", "add", "远程卡", "--json"], work);
    expect(add.code).toBe(0);
    const id = (JSON.parse(add.stdout) as { id: string }).id;

    const claim = await remoteCli(["task", "claim", id, "--json"], work);
    expect(claim.code).toBe(0);
    expect((JSON.parse(claim.stdout) as { assignee_session_id: string }).assignee_session_id).toBe(sessionId);

    const progress = await remoteCli(["task", "progress", id, "--pct", "50", "--json"], work);
    expect(progress.code).toBe(0);
    expect((JSON.parse(progress.stdout) as { progress: number }).progress).toBe(50);

    const end = await remoteCli(["session", "end", "--summary", "收工", "--json"], work);
    expect(end.code).toBe(0);
  });

  test("还没 session start 就来认领：仍然报 missing session id（不是别的错）", async () => {
    // 修的是“写”，不是把报错吞掉。没注册过就该明确报错。
    const work = mkdtempSync(join(tmpdir(), "kanban-remote-identity-"));
    madeDirs.push(work);
    const proc = Bun.spawn(["bun", "run", join(ROOT, "src", "cli.ts"), "task", "claim", "T-0001", "--json"], {
      cwd: work,
      env: {
        ...process.env,
        KANBAN_SERVER: server.url,
        KANBAN_PROJECT: project,
        KANBAN_KEY: token,
        KANBAN_DB: "",
        KANBAN_SESSION: "",
        PI_SESSION_ID: KEY_C,
        PI_SESSION_FILE: "",
        [SESSION_KEY_ENV]: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(1);
    expect(stderr).toContain("missing session id");
    expect(stderr).toContain(`pi-${KEY_C}`);
  });
});
