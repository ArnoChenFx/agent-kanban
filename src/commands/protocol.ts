/**
 * `agent-kanban install-protocol` —— 把协作协议写进项目的 AGENTS.md。
 *
 * 解决的问题：agent 知道"有个 kanban"和知道"开工先跑 agent-kanban context"
 * 是两回事。没有这份协议，agent 会绕过看板直接改代码，看板随即失真。
 */

import { dirname, join } from "node:path";
import { KanbanError, ExitCode, type ExitCodeValue } from "../core/errors.ts";
import { style } from "../core/format.ts";
import { findKanbanDirLoose } from "../core/paths.ts";
import {
  applyProtocol,
  describeProtocol,
  inspectProtocol,
  resolveProtocolFile,
} from "../core/protocol.ts";
import { assertKnownOptions, getBool, getString, parseArgs } from "./args.ts";
import { createOutput } from "./output.ts";

const USAGE = `用法：agent-kanban install-protocol [选项]

幂等地把 agent 协作协议写入项目的 AGENTS.md。受管区块
（<!-- kanban:begin --> ... <!-- kanban:end -->）之外的内容逐字保留，
所以可以放心地在同一个文件里写别的规范。

选项：
  --file <路径>    目标文件（相对项目根，默认 AGENTS.md）
  --check          只检查不写入；缺协议或版本落后时以非零码退出
  --json           结构化输出

退出码：
  0  协议存在且是当前版本（或刚写入成功）
  2  --check 发现协议缺失或版本落后

示例：
  agent-kanban install-protocol                 # 写入/更新
  agent-kanban install-protocol --check         # CI 里守住它是否最新
  agent-kanban install-protocol --file .cursor/rules/kanban.mdc`;

export function cmdInstallProtocol(argv: string[]): ExitCodeValue {
  const args = parseArgs(argv, {
    booleans: ["json", "check", "help"],
    strings: ["file"],
    short: { h: "help" },
  });
  assertKnownOptions(args, ["json", "check", "help", "file"]);

  if (getBool(args, "help")) {
    process.stdout.write(USAGE + "\n");
    return ExitCode.OK;
  }

  const json = getBool(args, "json");
  const check = getBool(args, "check");
  const out = createOutput(json);

  // 项目根优先取 .kanban 的父目录（agent 的 cwd 常在子目录）；
  // 还没 init 就退回 cwd，让用户能先装协议再初始化。
  const projectRoot = dirname(findKanbanDirLoose(process.cwd()) ?? join(process.cwd(), ".kanban"));
  const file = resolveProtocolFile(projectRoot, getString(args, "file"));

  if (check) {
    const insp = inspectProtocol(file);
    out.data({
      file: insp.file,
      status: insp.status,
      installed_version: insp.installedVersion,
      current_version: insp.currentVersion,
    });

    if (insp.status === "up_to_date") {
      out.line(`${style.green("✓")} 协作协议已是最新（${insp.currentVersion}）  ${style.gray(insp.file)}`);
      return ExitCode.OK;
    }

    out.line(`${style.yellow("!")} 协作协议${describeProtocol(insp)}  ${style.gray(insp.file)}`);
    out.line(`  ${style.gray("修：agent-kanban install-protocol")}`);
    return ExitCode.STATE;
  }

  const result = applyProtocol(file);
  out.data({
    file: result.file,
    action: result.action,
    status: result.status,
    current_version: result.currentVersion,
  });

  const verb =
    result.action === "created" ? "已创建" : result.action === "appended" ? "已写入" : result.action === "replaced" ? "已更新" : "无需改动";
  const mark = result.action === "unchanged" ? style.gray("·") : style.green("✓");

  out.line(`${mark} ${verb}协作协议  ${style.gray(`${result.file}  (v${result.currentVersion})`)}`);
  if (result.action === "replaced") {
    out.line(`  ${style.gray("旧版本区块已替换，区块外的内容未改动")}`);
  }
  out.blank();
  out.line(style.gray("现在读取该文件的 agent 会自动获得看板使用规范。"));
  return ExitCode.OK;
}

/** 供 doctor 复用：把 --check 的语义包成可抛出的错误（CI 场景用） */
export function assertProtocolFresh(projectRoot: string, fileOpt?: string | undefined): void {
  const insp = inspectProtocol(resolveProtocolFile(projectRoot, fileOpt));
  if (insp.status === "up_to_date") return;
  throw KanbanError.state(`协作协议${describeProtocol(insp)}`, {
    hint: "运行 `agent-kanban install-protocol` 更新",
    file: insp.file,
    status: insp.status,
  });
}
