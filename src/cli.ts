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
import { runServe } from "./server/http.ts";
import { reportError } from "./commands/output.ts";
import { assertKnownOptions, getBool, getInt, getString, parseArgs } from "./commands/args.ts";
import { openCtx, closeCtx } from "./commands/context.ts";
import { style } from "./core/format.ts";
import { readPackageVersion } from "./core/version.ts";

/** 主帮助 */
const HELP = `agent-kanban —— 多会话 / 多项目 agent 共享的任务看板

用法：agent-kanban <命令> [子命令] [参数] [选项]

命令：
  init        初始化本地看板（.kanban/，自动创建唯一 project）
  install-protocol  把 agent 协作协议写入项目 AGENTS.md
  session     会话生命周期：start / list / heartbeat / end
  task        任务操作：add / list / show / claim / progress / done ...
  board       终端泳道视图
  context     恢复现场（开工第一步）：看板 + 交接 + 建议动作
  resume      接管任务并注入交接与时间线
  handoff     写交接（收工前）：summary / next / blockers / open
  doctor      一致性自检与修复
  export/import/snapshot/compact  备份与维护（事件 journal 导出/重放/裁剪）
  plan        计划版本化：save（每次存新版本）/ show / list / history / at / attach
  rebuild     从事件流重建投影（自证一致；默认只校验）
  config      项目配置：show / init / set / use（.kanban/config.toml）
  project     项目查询（本机直连）
  admin       管理员：project 创建/删除、token 签发/吊销/授权
  serve       启动 HTTP + SSE server（供多机共享）
  mcp         启动 MCP server（stdio，agent 通过 tool call 读写看板）

两种模式
  本地：agent-kanban task list
        数据在 <项目>/.kanban/kanban.db，自动对应唯一 project，无需任何配置
  远程：kanban --server https://kanban.corp --project app --key k_xxx task list
        数据在 server；一个 server 管多个 project

配置（推荐：配置一次，固定生效）
  agent-kanban config init --server https://kanban.corp --project app --key k_xxx
  agent-kanban task list                 # 之后无需再传参数
  agent-kanban config show               # 查看生效配置与来源

管理员（server 端或任意机器）
  agent-kanban serve                     # 启动（首次自动生成管理员 token）
  agent-kanban admin project add app     # 建项目
  agent-kanban admin token create --project app --name "CI 专用"
  浏览器打开 http://127.0.0.1:7788/admin  # 管理界面

全局选项（优先级高于配置文件）：
  --server <url>     远程 server 地址
  --project <key>    project 标识（远程必填；本地自动派生）
  --key <k_xxx>      访问 token
  --db <path>        本地数据库路径
  --session <id>     会话标识（也可用 KANBAN_SESSION）
  --json             结构化输出
  --no-color         关闭颜色
  --version, -V      打印版本号

典型工作流（agent 视角）：
  agent-kanban session start --agent pi-main --harness pi   # 1. 注册会话
  agent-kanban context                                      # 2. 读现场（交接/在做/可认领）
  agent-kanban task claim T-0007                            # 3. 认领
  agent-kanban task progress T-0007 --pct 60 --note "..."   # 4. 推进（自动续租）
  agent-kanban handoff --task T-0007 --summary "..." --next "..."  # 5. 交接
  agent-kanban plan save --task T-0007 --title "..." --body-file <路径>  # 5'. 方案变了就存新版
  agent-kanban session end                                  # 6. 收工

崩溃恢复：
  agent-kanban context                # 新会话开工：先看现场
  agent-kanban resume T-0007          # 接管那张卡，交接与时间线一并注入

更多：agent-kanban task --help · agent-kanban config --help · agent-kanban admin --help
文档：docs/plan/001-总体设计.md · docs/plan/002-接口契约.md`;

/** `agent-kanban mcp` 的用法（它是给 harness 看的，不是给人天天敲的，所以与主帮助分开） */
const MCP_USAGE = `用法：agent-kanban mcp [--server <url>] [--project <key>] [--key <k_xxx>]

以 stdio 方式启动 MCP server，把看板暴露成 agent 可调用的工具。
harness 会把它当子进程拉起，不需要手动运行。

注册示例：
  pi mcp add kanban -- cmd agent-kanban mcp
  claude mcp add kanban -- cmd agent-kanban mcp

工具分组：
  会话   kanban_session_start / kanban_bootstrap / kanban_session_end
  任务   kanban_task_list / get / create / claim / progress / note /
         block / unblock / complete / review
  恢复   kanban_resume / kanban_handoff
  计划   kanban_plan_save / show / diff
  看板   kanban_board / kanban_doctor

每个会话第一步 kanban_session_start，第二步 kanban_bootstrap。

注意：stdout 是 JSON-RPC 通道，诊断信息一律走 stderr。`;

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
      process.stderr.write(`未知命令：${command}\n\n`);
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
      `用法：agent-kanban serve [--host 127.0.0.1] [--port 7788] [--reap-interval 30]

在 server 所在机器上运行。一个 server 管多个 project（ADR-9），
每个 project 用自己的 API key 隔离（ADR-11）。

配套命令：
  agent-kanban project add <key>    创建 project 并生成 API key（key 只显示一次）
  agent-kanban project list         列出所有 project

客户端接入：
  agent-kanban remote set <url> --project <key> --key k_xxx
  agent-kanban task list           # 之后无需重复传参

注意：默认只绑定 127.0.0.1。跨机访问请置于 TLS 反向代理之后。\n`,
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
    process.stderr.write("错误：无法定位数据库文件，请先运行 `agent-kanban init` 或用 --db 指定\n");
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
