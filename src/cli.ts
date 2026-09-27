#!/usr/bin/env bun
/**
 * kanban CLI 入口。
 *
 * 职责边界（ADR-6 / ADR-10）：
 * - 本文件只做：子命令路由、全局选项提取、错误 → 退出码映射
 * - 命令层只做：参数解析 → 构造 Op → 调 Backend → 格式化输出
 * - 所有业务逻辑在 src/core（本地与远程共用，行为一致性是结构保证）
 *
 * 退出码语义见 docs/plan/002-接口契约.md §1.2，agent 依赖它做分支判断，不要随意改动。
 */

import { ExitCode, type ExitCodeValue } from "./core/errors.ts";
import { cmdInit } from "./commands/init.ts";
import { cmdInstallProtocol } from "./commands/protocol.ts";
import { cmdBackup } from "./commands/backup.ts";
import { runMcpServer } from "./mcp/server.ts";
import { cmdSession } from "./commands/session.ts";
import { cmdTask } from "./commands/task.ts";
import { cmdBoard } from "./commands/board.ts";
import { cmdProject } from "./commands/project.ts";
import { cmdConfig } from "./commands/config.ts";
import { cmdAdmin } from "./commands/admin.ts";
import { cmdHandoff } from "./commands/handoff.ts";
import { cmdContext } from "./commands/recovery.ts";
import { cmdPlan } from "./commands/plan.ts";
import { cmdRebuild } from "./commands/rebuild.ts";
import { cmdUpdate } from "./commands/update.ts";
import { runServe } from "./server/http.ts";
import { reportError } from "./commands/output.ts";
import { assertKnownOptions, getBool, getInt, getString, parseArgs } from "./commands/args.ts";
import { openCtx, closeCtx } from "./commands/context.ts";
import { style } from "./core/format.ts";
import { readPackageVersion } from "./core/version.ts";

/** 主帮助 */
const HELP = `agent-kanban —— a task board shared by multiple agent sessions / projects

Usage: agent-kanban <command> [subcommand] [args] [options]

Commands:
  init        Initialize the local board (.kanban/, creates the single project)
  install-protocol  Write the agent collaboration protocol into the project AGENTS.md
  session     Session lifecycle: start / list / heartbeat / end
  task        Task operations: add / list / show / claim / progress / done ...
  board       Terminal swimlane view
  context     Read the situation (first step of a session): board + handoffs + suggested actions
  resume      Take over a task, injecting its handoff and timeline
  handoff     Write a handoff (before wrapping up): summary / next / blockers / open
  doctor      Consistency self-check and repair
  export/import/snapshot/compact  Backup and maintenance (event journal export / replay / trim)
  plan        Versioned plans: save (each call stores a new version) / show / list / history / at / attach
  rebuild     Rebuild projections from the event stream (self-verifying; verify-only by default)
  config      Project config: show / init / set / use (.kanban/config.toml)
  project     Project queries (direct local access)
  admin       Admin: project create/delete, token issue/revoke/authorize
  update      Self-update the binary from GitHub Releases (--check to compare only)
  serve       Start the HTTP + SSE server (for sharing across machines)
  mcp         Start the MCP server (stdio; agents read and write the board via tool calls)

Two modes
  Local: agent-kanban task list
        Data lives in <project>/.kanban/kanban.db and maps to the single project
        automatically; no configuration needed
  Remote: agent-kanban --server https://kanban.corp --project app --key k_xxx task list
        Data lives on the server; one server hosts many projects

Config (recommended: configure once, always in effect)
  agent-kanban config init --server https://kanban.corp --project app --key k_xxx
  agent-kanban task list                 # no arguments needed afterwards
  agent-kanban config show               # show the effective config and its source

Admin (on the server host or any machine)
  agent-kanban serve                     # start (an admin token is generated on first run)
  agent-kanban admin project add app     # create a project
  agent-kanban admin token create --project app --name "CI runner"
  Open http://127.0.0.1:7788/admin in a browser  # admin UI

Global options (take precedence over the config file):
  --server <url>     Remote server address
  --project <key>    Project key (required for remote; derived locally)
  --key <k_xxx>      Access token
  --db <path>        Local database path
  --session <id>     Session id (or KANBAN_SESSION)
  --json             Structured output
  --no-color         Disable color
  --version, -V      Print the version

Typical workflow (from an agent's perspective):
  agent-kanban session start --agent pi-main --harness pi   # 1. register the session
  agent-kanban context                                      # 2. read the situation (handoffs / in progress / claimable)
  agent-kanban task claim T-0007                            # 3. claim
  agent-kanban task progress T-0007 --pct 60 --note "..."   # 4. progress (renews the lease automatically)
  agent-kanban handoff --task T-0007 --summary "..." --next "..."  # 5. handoff
  agent-kanban plan save --task T-0007 --title "..." --body-file <path>  # 5'. save a new version when the approach changes
  agent-kanban session end                                  # 6. wrap up

Crash recovery:
  agent-kanban context                # a new session starts here: read the situation first
  agent-kanban resume T-0007          # take over that card, handoff and timeline included

More: agent-kanban task --help · agent-kanban config --help · agent-kanban admin --help`;

/** `agent-kanban mcp` 的用法（它是给 harness 看的，不是给人天天敲的，所以与主帮助分开） */
const MCP_USAGE = `Usage: agent-kanban mcp [--server <url>] [--project <key>] [--key <k_xxx>]

Starts the MCP server over stdio and exposes the board as tools agents can call.
The harness spawns it as a subprocess; you never run it by hand.

Registration example:
  pi mcp add kanban -- cmd agent-kanban mcp
  claude mcp add kanban -- cmd agent-kanban mcp

Tool groups:
  Session  kanban_session_start / kanban_bootstrap / kanban_session_end
  Task     kanban_task_list / get / create / claim / progress / note /
           block / unblock / complete / review
  Recovery kanban_resume / kanban_handoff
  Plan     kanban_plan_save / show / diff
  Board    kanban_board / kanban_doctor

First call of a session: kanban_session_start, second: kanban_bootstrap.

Note: stdout is the JSON-RPC channel; all diagnostics go to stderr.`;

/** 提升到模块级：main 的 catch 兜底需要用 */
const globals = {
  json: false,
  db: undefined as string | undefined,
  session: undefined as string | undefined,
  server: undefined as string | undefined,
  project: undefined as string | undefined,
  key: undefined as string | undefined,
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // 全局选项提取：无论写在子命令前还是后都要生效。
  // 注入时**追加到末尾**，因为子命令取 argv[0]，前置会让 "--json" 被当成子命令名。
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json" || arg === "-j") {
      globals.json = true;
    } else if (arg === "--no-color") {
      // 只影响本次进程的输出，不透传给子命令（否则会被当成未知选项）
      process.env.NO_COLOR = "1";
    } else if (arg === "--db" && i + 1 < argv.length) {
      globals.db = argv[++i];
    } else if (arg.startsWith("--db=")) {
      globals.db = arg.slice(5);
    } else if (arg === "--session" && i + 1 < argv.length) {
      globals.session = argv[++i];
    } else if (arg.startsWith("--session=")) {
      globals.session = arg.slice(10);
    } else if (arg === "--server" && i + 1 < argv.length) {
      globals.server = argv[++i];
    } else if (arg.startsWith("--server=")) {
      globals.server = arg.slice(9);
    } else if (arg === "--project" && i + 1 < argv.length) {
      globals.project = argv[++i];
    } else if (arg.startsWith("--project=")) {
      globals.project = arg.slice(10);
    } else if (arg === "--key" && i + 1 < argv.length) {
      globals.key = argv[++i];
    } else if (arg.startsWith("--key=")) {
      globals.key = arg.slice(6);
    } else {
      rest.push(arg);
    }
  }

  const command = rest[0];
  const subArgv = rest.slice(1);

  const withGlobals = (): string[] => {
    const injected: string[] = [];
    if (globals.db !== undefined) injected.push("--db", globals.db);
    if (globals.session !== undefined) injected.push("--session", globals.session);
    if (globals.server !== undefined) injected.push("--server", globals.server);
    if (globals.project !== undefined) injected.push("--project", globals.project);
    if (globals.key !== undefined) injected.push("--key", globals.key);
    if (globals.json) injected.push("--json");
    return [...subArgv, ...injected];
  };

  let code: ExitCodeValue;
  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP + "\n");
      code = ExitCode.OK;
      break;
    // 版本号：从 package.json 读，与发布 tag 同源（CI 校验二者一致）
    case "--version":
    case "-V":
    case "version":
      process.stdout.write(`${readPackageVersion()}\n`);
      code = ExitCode.OK;
      break;
    case "init":
      code = await cmdInit(withGlobals());
      break;
    case "install-protocol":
      code = cmdInstallProtocol(withGlobals());
      break;
    case "export":
    case "import":
    case "snapshot":
    case "compact":
      code = await cmdBackup([command!, ...withGlobals()]);
      break;
    case "session":
      code = await cmdSession(withGlobals());
      break;
    case "task":
      code = await cmdTask(withGlobals());
      break;
    case "board":
      code = await cmdBoard(withGlobals());
      break;
    case "project":
      code = await cmdProject(withGlobals());
      break;
    case "config":
      code = await cmdConfig(withGlobals());
      break;
    case "admin":
      code = await cmdAdmin(withGlobals());
      break;
    case "plan":
      code = await cmdPlan(withGlobals());
      break;
    case "rebuild":
      code = await cmdRebuild(withGlobals());
      break;
    case "update":
      code = await cmdUpdate(withGlobals());
      break;
    case "handoff":
      code = await cmdHandoff(withGlobals());
      break;
    case "context":
    case "resume":
    case "doctor":
      code = await cmdContext([command!, ...withGlobals()]);
      break;
    case "serve":
      // serve 是特例：server 跑在当前进程的事件循环上，
      // 所以**不能**走到末尾的 process.exit()——那会把刚启动的 server 杀掉。
      // 这里直接 return，让进程持续存活，直到收到 SIGINT。
      cmdServe(withGlobals());
      return;
    case "mcp": {
      // 同 serve：MCP server 跑在当前进程上，不能被末尾的 process.exit 带走
      const args = parseArgs(withGlobals(), {
        booleans: ["json", "help"],
        strings: ["db", "server", "project", "key"],
        short: { h: "help" },
      });
      assertKnownOptions(args, ["json", "help", "db", "server", "project", "key"]);
      if (getBool(args, "help")) {
        process.stdout.write(MCP_USAGE + "\n");
        process.exit(ExitCode.OK);
      }
      await runMcpServer({
        db: getString(args, "db"),
        server: getString(args, "server"),
        project: getString(args, "project"),
        key: getString(args, "key"),
      });
      return;
    }
    default:
      process.stderr.write(`unknown command: ${command}\n\n`);
      process.stderr.write(HELP + "\n");
      code = ExitCode.USAGE;
      break;
  }

  process.exit(code);
}

/**
 * `agent-kanban serve` —— 启动 server。
 *
 * 与其他命令不同：它需要能直连数据库（不通过 Backend），因为
 * server 本身就是提供 Backend 能力的那一端。
 */
function cmdServe(argv: string[]): ExitCodeValue {
  const args = parseArgs(argv, {
    booleans: ["json", "help", "quiet", "open"],
    strings: ["host", "port", "db", "reap-interval"],
    short: { j: "json", h: "help" },
  });
  assertKnownOptions(args, ["json", "help", "quiet", "open", "host", "port", "db", "reap-interval"]);

  if (getBool(args, "help")) {
    process.stdout.write(
      `Usage: agent-kanban serve [--host 127.0.0.1] [--port 7788] [--reap-interval 30]

Run this on the machine that hosts the server. One server hosts many projects (ADR-9),
and each project is isolated by its own API key (ADR-11).

Companion commands:
  agent-kanban project add <key>    Create a project and generate its API key (shown once)
  agent-kanban project list         List all projects

Client setup:
  agent-kanban remote set <url> --project <key> --key k_xxx
  agent-kanban task list           # no repeated arguments afterwards

Note: binds to 127.0.0.1 only by default. Put it behind a TLS reverse proxy for remote access.\n`,
    );
    return ExitCode.OK;
  }

  // server 走直连模式（不走远程 Backend）：即使传了 --server 也忽略
  const ctx = openCtx({
    json: false,
    dbPath: getString(args, "db"),
    // 强制本地：server 必须能直连 DB
  });
  const dbPath = ctx.handle?.dbPath;
  closeCtx(ctx);
  if (!dbPath) {
    process.stderr.write("error: cannot locate the database file, run `agent-kanban init` first or pass --db\n");
    return ExitCode.NOT_INIT;
  }

  return runServe({
    dbPath,
    host: getString(args, "host") ?? "127.0.0.1",
    port: getInt(args, "port") ?? 7788,
    reapIntervalSec: getInt(args, "reap-interval") ?? 30,
    quiet: getBool(args, "quiet"),
  });
}

void style;
main().catch((err) => {
  // 顶层兜底：任何未被命令层捕获的异常都转成退出码。
  // 走 reportError 而不是直接写 JSON，保证人类模式看到的是可读提示而非 JSON。
  const code = reportError(err, globals.json);
  process.exit(code);
});
