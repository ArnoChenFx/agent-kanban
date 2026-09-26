/**
 * `agent-kanban install-protocol` 的行为测试。
 *
 * 重点不在“能不能写进去”，而在四条容易被忽略的约束：
 *   1. 区块外的内容必须逐字保留（AGENTS.md 往往还写着别的规范）
 *   2. 幂等（agent 会反复跑这个命令）
 *   3. 版本漂移要能被发现（升级了 CLI 但没更新协议 = agent 照旧执行）
 *   4. 受管区块的标记名必须与文档一致（两边曾经各写各的，见下方 describe）
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  applyProtocol,
  inspectProtocol,
  PROTOCOL_BEGIN,
  PROTOCOL_END,
  renderProtocol,
  resolveProtocolFile,
} from "../src/core/protocol.ts";
import { readPackageVersion } from "../src/core/version.ts";

/** 仓库根：用于核对文档里的标记名 */
const ROOT = resolve(import.meta.dir, "..");

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kanban-proto-"));
  file = resolveProtocolFile(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 取文件里受管区块之外的正文 */
function outsideBlock(text: string): string {
  const begin = text.indexOf(PROTOCOL_BEGIN);
  if (begin === -1) return text;
  const end = text.indexOf(PROTOCOL_END, begin);
  if (end === -1) return text;
  return text.slice(0, begin) + text.slice(end + PROTOCOL_END.length);
}

/**
 * 把区块里的版本号改成一个很老的值，模拟“CLI 升级了但协议没更新”。
 *
 * ⚠ 正则必须带 `agent-` 前缀。写成 `/kanban:version [\d.]+/` 也能“跑通”，
 *   因为它匹配的是 `agent-kanban:version` 里的子串——替换后前缀 `agent-`
 *   还在，于是断言照样成立，但测的其实已经是新标记了。
 *   那种用例一旦被人“顺手清理”就会静默失效，所以这里显式写全。
 */
function downgradeVersion(text: string): string {
  return text.replace(/agent-kanban:version [\d.]+/, "agent-kanban:version 0.0.1");
}

describe("renderProtocol", () => {
  test("内容与实际命令一致（agent 照着执行不能失败）", () => {
    const body = renderProtocol("9.9.9");
    // 这些是设计文档 §12 里写成 agent-kanban claim / agent-kanban progress 的形式，
    // 但实际实现挂在 task 子命令下。协议写错比没有协议更糟。
    expect(body).toContain("agent-kanban task claim");
    expect(body).toContain("agent-kanban task progress");
    expect(body).toContain("agent-kanban context");
    expect(body).toContain("agent-kanban handoff");
    expect(body).toContain("agent-kanban resume");
    expect(body).toContain("agent-kanban session start");
    // 不存在的命令不能出现
    expect(body).not.toMatch(/kanban (claim|progress|hold)\b/);
  });

  test("退出码表与 ExitCode 枚举一致", () => {
    const body = renderProtocol("9.9.9");
    // 0..7 全部出现且带反引号，避免 agent 读到裸数字
    for (const code of ["0", "1", "2", "3", "4", "5", "6", "7"]) {
      expect(body).toContain(`\`${code}\``);
    }
  });

  test("版本号写进区块，可被解析回来", () => {
    expect(renderProtocol("1.2.3")).toContain("<!-- agent-kanban:version 1.2.3 -->");
  });
});

/**
 * 受管区块的标记名。
 *
 * 背景：0.1.x 代码发的是 `<!-- kanban:begin -->`，而 README / 设计文档 /
 * 命令层注释从一开始写的就是 `<!-- agent-kanban:begin -->` —— 两边各写各的，
 * 而且**没有任何测试能发现**，因为测试只跟着代码的常量走。
 * 现在统一为 `agent-kanban:`，这个 describe 就是防它再漂回去的。
 */
describe("受管区块标记", () => {
  test("代码用的是带 agent- 前缀的标记", () => {
    expect(PROTOCOL_BEGIN).toBe("<!-- agent-kanban:begin -->");
    expect(PROTOCOL_END).toBe("<!-- agent-kanban:end -->");
  });

  test("文档里提到的标记与代码一致（不得残留老标记）", () => {
    const docs = [
      "README.md",
      "README-zh.md",
      "docs/plan/001-总体设计.md",
      "docs/plan/003-实施计划.md",
      "src/commands/protocol.ts",
    ];
    // 文档提到标记时必须用新标记；老标记（0.1.x 的产物）出现即为漂移
    const offenders = docs.filter((rel) => {
      const text = readFileSync(join(ROOT, rel), "utf8");
      return text.includes("<!-- kanban:begin -->") || text.includes("<!-- kanban:end -->");
    });
    expect(offenders).toEqual([]);
  });

  test("本仓库自己的 AGENTS.md 用的是新标记", () => {
    // AGENTS.md 不入 git，干净 checkout 上不存在，所以这里只在存在时断言
    const agents = join(ROOT, "AGENTS.md");
    if (!existsSync(agents)) return;
    const text = readFileSync(agents, "utf8");
    expect(text).toContain(PROTOCOL_BEGIN);
    expect(text).toContain(PROTOCOL_END);
    expect(text).not.toContain("<!-- kanban:begin -->");
  });
});

describe("applyProtocol", () => {
  test("文件不存在时创建", () => {
    const r = applyProtocol(file);
    expect(r.action).toBe("created");
    expect(existsSync(file)).toBe(true);
    expect(inspectProtocol(file).status).toBe("up_to_date");
  });

  test("幂等：连续执行 N 次与执行 1 次结果相同", () => {
    applyProtocol(file);
    const first = readFileSync(file, "utf8");

    for (let i = 0; i < 3; i++) {
      expect(applyProtocol(file).action).toBe("unchanged");
    }
    expect(readFileSync(file, "utf8")).toBe(first);
  });

  test("保留区块外的全部内容，逐字不动", () => {
    const original = "# 团队规范\n\n- 禁止 any\n- 提交信息用 Conventional Commits\n";
    writeFileSync(file, original, "utf8");

    applyProtocol(file);

    expect(outsideBlock(readFileSync(file, "utf8")).trimEnd()).toBe(original.trimEnd());
  });

  test("已有区块时是替换，不是追加（不会堆叠多个区块）", () => {
    applyProtocol(file);
    applyProtocol(file);
    const text = readFileSync(file, "utf8");
    expect(text.split(PROTOCOL_BEGIN).length - 1).toBe(1);
    expect(text.split(PROTOCOL_END).length - 1).toBe(1);
  });

  test("替换后 END 标记仍在（曾因漏拼导致区块损坏）", () => {
    applyProtocol(file);
    applyProtocol(file);
    expect(readFileSync(file, "utf8")).toContain(PROTOCOL_END);
    expect(inspectProtocol(file).status).toBe("up_to_date");
  });

  test("原文件没有末尾换行时也能正确追加", () => {
    writeFileSync(file, "没有换行结尾", "utf8");
    const r = applyProtocol(file);
    expect(r.action).toBe("appended");
    expect(inspectProtocol(file).status).toBe("up_to_date");
    expect(outsideBlock(readFileSync(file, "utf8")).trimEnd()).toBe("没有换行结尾");
  });

  test("原文件为空时也能写入", () => {
    writeFileSync(file, "", "utf8");
    expect(applyProtocol(file).action).toBe("appended");
    expect(inspectProtocol(file).status).toBe("up_to_date");
  });
});

describe("inspectProtocol", () => {
  test("文件不存在 → missing", () => {
    const i = inspectProtocol(file);
    expect(i.status).toBe("missing");
    expect(i.installedVersion).toBeNull();
  });

  test("文件存在但无区块 → no_block", () => {
    writeFileSync(file, "# 别的规范\n", "utf8");
    expect(inspectProtocol(file).status).toBe("no_block");
  });

  test("版本落后 → outdated", () => {
    applyProtocol(file);
    writeFileSync(file, downgradeVersion(readFileSync(file, "utf8")), "utf8");

    const i = inspectProtocol(file);
    expect(i.status).toBe("outdated");
    expect(i.installedVersion).toBe("0.0.1");
    expect(i.currentVersion).toBe(readPackageVersion());
  });

  test("有 begin 无 end（手工破坏）→ no_block，不猜测", () => {
    applyProtocol(file);
    const text = readFileSync(file, "utf8").replace(PROTOCOL_END, "");
    writeFileSync(file, text, "utf8");
    // 宁可报"没有区块"也不要猜边界，否则会吃掉用户的内容
    expect(inspectProtocol(file).status).toBe("no_block");
  });

  test("修复后回到 up_to_date", () => {
    applyProtocol(file);
    writeFileSync(file, downgradeVersion(readFileSync(file, "utf8")), "utf8");
    expect(inspectProtocol(file).status).toBe("outdated");

    expect(applyProtocol(file).action).toBe("replaced");
    expect(inspectProtocol(file).status).toBe("up_to_date");
  });
});

describe("resolveProtocolFile", () => {
  test("默认落在项目根的 AGENTS.md", () => {
    expect(resolveProtocolFile("/proj")).toBe(join("/proj", "AGENTS.md"));
  });

  test("--file 可指向别处（不同 agent 生态的约定文件名）", () => {
    expect(resolveProtocolFile("/proj", ".cursor/rules/kanban.mdc")).toBe(
      join("/proj", ".cursor/rules/kanban.mdc"),
    );
  });
});
