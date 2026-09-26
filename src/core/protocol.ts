/**
 * 协作协议：把「agent 怎么用这个看板」写进项目根目录的 AGENTS.md。
 *
 * 为什么需要它（本项目存在的理由就是这个）：
 * 一个 agent 知道"有个 kanban 工具"和知道"开工第一步该 `agent-kanban context`"，
 * 是两件完全不同的事。没有这份协议，agent 大概率会绕过看板直接改代码，
 * 于是看板和现实再次脱节 —— 而看板一旦不真实，就再也没人信它了。
 *
 * ## 三个设计约束
 *
 * 1. **只管受管区块，区块外逐字不动。**
 *    AGENTS.md 是项目自己的文件，可能已经写了别的规范。命令只能替换
 *    `<!-- agent-kanban:begin -->` 到 `<!-- agent-kanban:end -->` 之间的内容，
 *    其余部分（含换行风格）必须原样保留。
 *
 * 2. **幂等。** 重复执行 N 次与执行 1 次结果相同。这是 agent 会反复跑的命令。
 *
 * 3. **内容随 CLI 版本演进，且版本写在区块里。**
 *    升级 kanban 之后，旧协议里可能写着已经不存在的命令。`--check` 与
 *    `agent-kanban doctor` 都靠区块内的版本标记判断“是否落后”。
 *
 * ## 为什么正文是英文
 *
 * 这段内容是给 agent 读的，agent 的工作语言不固定。除命令名外一律用英文，
 * 顺带避开非 ASCII 标点在不同 shell 与编码环境下的问题。
 *
 * ## 为什么不直接把命令写死在文档里
 *
 * 因为会漂。协议内容集中在这里生成，命令改名时只改一处；
 * 写进 README 的话，README 和实际实现迟早对不上。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readPackageVersion } from "./version.ts";

/** 受管区块的开始标记 */
export const PROTOCOL_BEGIN = "<!-- agent-kanban:begin -->";
/** 受管区块的结束标记 */
export const PROTOCOL_END = "<!-- agent-kanban:end -->";
/** 区块内的版本标记行，由本模块生成与解析 */
const VERSION_LINE_RE = /^<!--\s*agent-kanban:version\s+(\S+)\s*-->$/m;

/** 默认写入的文件名（相对项目根） */
export const DEFAULT_PROTOCOL_FILE = "AGENTS.md";

/** 检查结果里用的问题代码 */
export const PROTOCOL_ISSUE_MISSING = "protocol_missing";
export const PROTOCOL_ISSUE_OUTDATED = "protocol_outdated";

export type ProtocolStatus = "missing" | "up_to_date" | "outdated" | "no_block";

export interface ProtocolInspection {
  status: ProtocolStatus;
  /** 目标文件绝对路径 */
  file: string;
  /** 文件里记录的协议版本；无区块时为 null */
  installedVersion: string | null;
  /** 当前 CLI 版本 */
  currentVersion: string;
}

export interface ProtocolApplyResult extends ProtocolInspection {
  action: "created" | "appended" | "replaced" | "unchanged";
}

/**
 * 生成协议正文（英文）。
 *
 * 为什么用英文：这段内容是写给 agent 读的，而 agent 的工作语言不固定。
 * 除命令名外一律英文，顺带避开非 ASCII 标点在不同 shell 与编码环境下的问题。
 *
 * ⚠ 里面的命令名必须与 `src/cli.ts` 的实际子命令一致。
 *   设计文档 §12 写的是 `agent-kanban claim` / `agent-kanban hold`，
 *   实际实现是 `agent-kanban task claim`，且没有 hold —— 协议写错的话，
 *   agent 会照着执行然后失败，比没有协议更糟。
 */
export function renderProtocol(version: string = readPackageVersion()): string {
  return `## Task board (agent-kanban)

This project's task state lives in \`.kanban/kanban.db\` and is shared by every session.
**Do not work around it.** Changing code without updating the board leaves the board
describing a project that no longer exists.

### Start of every work session

\`\`\`bash
agent-kanban session start --agent <your-name> --harness pi   # 1. register the session
agent-kanban context                                          # 2. read the situation, do this first
agent-kanban task claim T-0007                                # 3. claim it, you get the lease
\`\`\`

\`agent-kanban context\` tells you whether anyone left you a handoff, which cards you already
hold, and what is free to claim right now. **Skipping it means working blind.**

### While working

\`\`\`bash
agent-kanban task progress T-0007 --pct 60 --note "rewrote the storage layer"   # renews your lease
agent-kanban task check T-0007 --item "add migration test"                      # checklist item
agent-kanban task note T-0007 "found a dependency conflict"                     # quick note
agent-kanban task block T-0007 --reason "waiting on API key"                    # releases the lease
\`\`\`

Tasks over 30 minutes long: \`agent-kanban task claim T-0007 --ttl 7200\` extends the lease.

### Before you stop

\`\`\`bash
agent-kanban handoff --task T-0007 --summary "what got done" --next "where to pick up"
agent-kanban task done T-0007 --note "tests green"                             # only when finished
agent-kanban session end
\`\`\`

**A handoff is written for whoever picks this up next, not for you.** Name the function,
the file, the test that fails. "The rest is straightforward" costs the next session a
full round trip.

### After a crash

\`\`\`bash
agent-kanban context              # whose lease expired, which cards are unattended
agent-kanban resume T-0007        # take over: handoff content plus the full timeline
\`\`\`

No scrolling through chat logs, no asking a human.

### Rules

- Never read or write \`kanban.db\` directly, and never hand-edit anything under \`.kanban/\`
- A rejected claim (exit code \`3\`) means another session holds the lease. The error names
  the holder and their last action. Pick a different card rather than forcing it
- Every command accepts \`--json\`. Use it in scripts, never parse the coloured output
- Plans are versioned: \`agent-kanban plan save\` writes a new version and keeps the old one
- \`agent-kanban doctor\` self-checks consistency, \`agent-kanban rebuild\` re-derives the board from the event log

### Exit codes

| Code | Meaning | What to do |
| --- | --- | --- |
| \`0\` | Success | — |
| \`1\` | Bad arguments | Read the usage hint, fix the command |
| \`2\` | State error | Task missing or transition not allowed; do not retry as-is |
| \`3\` | Conflict | Another session holds the lease; pick a different card |
| \`4\` | Database busy | Back off and retry, at most 3 times |
| \`5\` | Not initialised | Run \`agent-kanban init\` |
| \`6\` | Internal error | Treat as a bug and report it |
| \`7\` | Auth failed | Check the token and the project key |

<!-- agent-kanban:version ${version} -->`;
}

/** 解析文件内容中的受管区块 */
function extractBlock(text: string): { body: string | null; installedVersion: string | null } {
  const begin = text.indexOf(PROTOCOL_BEGIN);
  if (begin === -1) return { body: null, installedVersion: null };
  const after = begin + PROTOCOL_BEGIN.length;
  const end = text.indexOf(PROTOCOL_END, after);
  // 有 begin 无 end：区块被手工破坏了。此时不猜，直接当作没有区块，
  // 由调用方决定是追加还是报错（append 会补一个干净的区块）。
  if (end === -1) return { body: null, installedVersion: null };

  const body = text.slice(after, end);
  const m = VERSION_LINE_RE.exec(body);
  return { body, installedVersion: m?.[1] ?? null };
}

/**
 * 只看不改：文件里有没有区块、有没有落后于当前 CLI。
 *
 * `agent-kanban doctor` 靠它报警，`--check` 靠它决定退出码。
 */
export function inspectProtocol(file: string): ProtocolInspection {
  const currentVersion = readPackageVersion();

  if (!existsSync(file)) {
    return { status: "missing", file, installedVersion: null, currentVersion };
  }

  const text = readFileSync(file, "utf8");
  const { installedVersion } = extractBlock(text);

  if (installedVersion === null) {
    // 有文件但没有区块：可能没装过，也可能装到别的文件去了
    return { status: "no_block", file, installedVersion: null, currentVersion };
  }
  if (installedVersion !== currentVersion) {
    return { status: "outdated", file, installedVersion, currentVersion };
  }
  return { status: "up_to_date", file, installedVersion, currentVersion };
}

/**
 * 幂等写入 / 更新受管区块。
 *
 * 幂等性来自两处：区块已存在且内容一致时**不写文件**（避免无谓的 mtime 变化，
 * 否则 git 会把一次空操作变成一次 diff）；内容变了才替换。
 */
export function applyProtocol(file: string): ProtocolApplyResult {
  const currentVersion = readPackageVersion();
  const body = renderProtocol(currentVersion);
  const block = `${PROTOCOL_BEGIN}\n${body}\n${PROTOCOL_END}`;

  if (!existsSync(file)) {
    writeFileSync(file, `${block}\n`, "utf8");
    return {
      action: "created",
      status: "up_to_date",
      file,
      installedVersion: currentVersion,
      currentVersion,
    };
  }

  const original = readFileSync(file, "utf8");
  const { body: existing } = extractBlock(original);

  // ---- 情况 1：区块已存在，替换它 ----
  if (existing !== null) {
    const begin = original.indexOf(PROTOCOL_BEGIN);
    const after = begin + PROTOCOL_BEGIN.length;
    // ⚠ end 指的是 END 标记**之后**的位置，所以拼回去时必须显式补上
    //   PROTOCOL_END，否则下一次读取会认为区块被破坏（少了收尾标记）。
    const endMarker = original.indexOf(PROTOCOL_END, after);
    const end = endMarker + PROTOCOL_END.length;

    // 连区块外的换行风格一起比对，避免“内容没变却改了文件”
    const next = original.slice(0, after) + `\n${body}\n` + PROTOCOL_END + original.slice(end);
    if (next === original) {
      return {
        action: "unchanged",
        status: "up_to_date",
        file,
        installedVersion: currentVersion,
        currentVersion,
      };
    }
    writeFileSync(file, next, "utf8");
    return {
      action: "replaced",
      status: "up_to_date",
      file,
      installedVersion: currentVersion,
      currentVersion,
    };
  }

  // ---- 情况 2：没有区块，追加到文件末尾 ----
  // 前面加一个空行做视觉分隔；若原文已以换行结尾则不重复补。
  const sep = original.length === 0 || original.endsWith("\n\n") ? "" : original.endsWith("\n") ? "\n" : "\n\n";
  writeFileSync(file, `${original}${sep}${block}\n`, "utf8");
  return {
    action: "appended",
    status: "up_to_date",
    file,
    installedVersion: currentVersion,
    currentVersion,
  };
}

/** 供 doctor 与命令层复用：把问题翻译成一句话（不带路径，路径由调用方单独输出） */
export function describeProtocol(insp: ProtocolInspection): string {
  switch (insp.status) {
    case "missing":
      return "the file does not exist";
    case "no_block":
      return "the file has no kanban protocol block";
    case "outdated":
      return `version ${insp.installedVersion}, the current CLI is ${insp.currentVersion}`;
    case "up_to_date":
      return "up to date";
  }
}

/** 目标文件的绝对路径：显式 --file 优先，否则项目根下的 AGENTS.md */
export function resolveProtocolFile(projectRoot: string, fileOpt?: string | undefined): string {
  return fileOpt && fileOpt.length > 0 ? join(projectRoot, fileOpt) : join(projectRoot, DEFAULT_PROTOCOL_FILE);
}
