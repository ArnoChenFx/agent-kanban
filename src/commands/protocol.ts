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
import { assertKnownOptions, getBool, getString, parseArgs, rejectExtraPositionals } from "./args.ts";
import { createOutput } from "./output.ts";

const USAGE = `Usage: agent-kanban install-protocol [options]

Idempotently writes the agent collaboration protocol into the project AGENTS.md. Content
outside the managed block
(<!-- agent-kanban:begin --> ... <!-- agent-kanban:end -->) is preserved verbatim, so you can
safely keep other conventions in the same file.

Options:
  --file <path>    Target file (relative to the project root, default AGENTS.md)
  --check          Check only, do not write; exits non-zero when the protocol is missing or outdated
  --json           Structured output

Exit codes:
  0  The protocol is present and current (or was just written successfully)
  2  --check found the protocol missing or outdated

Examples:
  agent-kanban install-protocol                 # write/update
  agent-kanban install-protocol --check         # keep CI honest about it being current
  agent-kanban install-protocol --file .cursor/rules/kanban.mdc`;

export function cmdInstallProtocol(argv: string[]): ExitCodeValue {
  const args = parseArgs(argv, {
    booleans: ["json", "check", "help"],
    strings: ["file"],
    short: { h: "help" },
  });
  assertKnownOptions(args, ["json", "check", "help", "file"]);
  rejectExtraPositionals(args, 0, "Usage: agent-kanban install-protocol [--check] [--file <path>]");

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
      out.line(`${style.green("✓")} the collaboration protocol is up to date (${insp.currentVersion})  ${style.gray(insp.file)}`);
      return ExitCode.OK;
    }

    out.line(`${style.yellow("!")} collaboration protocol: ${describeProtocol(insp)}  ${style.gray(insp.file)}`);
    out.line(`  ${style.gray("Fix: agent-kanban install-protocol")}`);
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
    result.action === "created" ? "created" : result.action === "appended" ? "written" : result.action === "replaced" ? "updated" : "unchanged";
  const mark = result.action === "unchanged" ? style.gray("·") : style.green("✓");

  out.line(`${mark} collaboration protocol ${verb}  ${style.gray(`${result.file}  (v${result.currentVersion})`)}`);
  if (result.action === "replaced") {
    out.line(`  ${style.gray("the old block was replaced, content outside the block is unchanged")}`);
  }
  out.blank();
  out.line(style.gray("agents reading that file will now pick up the board usage rules automatically."));
  return ExitCode.OK;
}

/** 供 doctor 复用：把 --check 的语义包成可抛出的错误（CI 场景用） */
export function assertProtocolFresh(projectRoot: string, fileOpt?: string | undefined): void {
  const insp = inspectProtocol(resolveProtocolFile(projectRoot, fileOpt));
  if (insp.status === "up_to_date") return;
  throw KanbanError.state(`collaboration protocol: ${describeProtocol(insp)}`, {
    hint: "run `agent-kanban install-protocol` to update",
    file: insp.file,
    status: insp.status,
  });
}
