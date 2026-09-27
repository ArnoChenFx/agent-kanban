# agent-kanban 完整命令参考

> 本文以**本地模式**为准。**远程模式**（看板在别的机器上）下有 5 个命令不可用，
> 先看 [remote.md](remote.md)。会话身份、状态机、JSON 字段在两种模式下**完全一致**。
>
> 索引：全局选项 · 配置 · 会话 · 任务 · 看板与现场 · 交接 · 计划 · 运维 · 备份 · JSON 字段 · 状态机

## 目录

- [全局选项](#全局选项)
- [配置与来源优先级](#配置与来源优先级)
- [会话 session](#会话-session)
- [任务 task](#任务-task)
- [看板与现场](#看板与现场)
- [交接 handoff](#交接-handoff)
- [计划 plan](#计划-plan)
- [运维 doctor / rebuild](#运维-doctor--rebuild)
- [配置 / install-protocol / admin / serve](#配置-install-protocol--admin--serve)
- [备份 export / import / snapshot / compact](#备份-export--import--snapshot--compact)
- [JSON 输出字段](#json-输出字段)
- [状态机与守卫](#状态机与守卫)

---

## 全局选项

写在**子命令前或后**都生效（CLI 会先剥离全局选项再路由）。

| 选项 | 短 | 说明 |
|---|---|---|
| `--server <url>` | | 远程 server 地址（远程模式必填） |
| `--project <key>` | | project 标识；本地模式由目录名派生 |
| `--key <k_xxx>` | | 访问 token，格式 `k_` + 32 位小写 hex |
| `--db <path>` | | 本地数据库路径，默认 `<project>/.kanban/kanban.db` |
| `--session <id>` | | 会话标识；也可用 `KANBAN_SESSION` |
| `--json` | `-j` | 结构化输出，成功走 stdout，失败走 stderr |
| `--no-color` | | 关闭 ANSI 颜色（CI 里可用 `NO_COLOR=1`） |
| `--version` | `-V` | 打印版本号 |

**这些只有部分命令实现了 `--help`**，见 SKILL.md 的"坑"一节。

## 配置与来源优先级

```
命令行选项  >  环境变量  >  .kanban/config.toml  >  派生默认值
```

| 设置 | CLI | 环境变量 | 默认 |
|---|---|---|---|
| server url | `--server` | `KANBAN_SERVER` | 由项目目录派生 |
| project key | `--project` | `KANBAN_PROJECT` | 由项目目录派生 |
| token | `--key` | `KANBAN_KEY` | — |
| 模式 | `agent-kanban config use` | `KANBAN_MODE` | 有 server 则 `remote`，否则 `local` |
| 数据库 | `--db` | `KANBAN_DB` | `<project>/.kanban/kanban.db` |
| 会话 id | `--session` | `KANBAN_SESSION` | `<project>/.kanban/sessions/<identity-key>`，推不出 key 时退回 `.kanban/session` |

**空环境变量算"未设置"**，不是空值——否则 `export KANBAN_SERVER=` 会静默盖掉 `config.toml`，凭空建一个空本地库。

服务端变量：`KANBAN_HOST` / `KANBAN_PORT` / `KANBAN_WEB_DIR` / `KANBAN_ADMIN_TOKEN`。
Docker 里 `KANBAN_BIND` 控制**宿主机侧**绑定地址（容器内永远听 `0.0.0.0`）。

## 会话 session

```bash
agent-kanban session start --agent <名字> [--harness pi|claude-code|cursor|human] [--id s-xxx] [--no-write]
agent-kanban session list [--all] [--json]
agent-kanban session heartbeat [--session <id>]
agent-kanban session end [--summary "本次做了什么"] [--session <id>]
```

- `start` 把 `session_id` 写进本机身份文件，之后 CLI 命令无需再传 `--session`；并顺带触发僵尸回收（仅本地模式）。
  **本地与远程都会写这个文件**——身份文件记的是"这台机器上我是谁"，不是看板状态。
- 身份文件位置由 **identity key** 决定，解析顺序：
  1. `$KANBAN_SESSION_KEY`（任意稳定唯一值）
  2. 已核实的 harness 变量：`PI_SESSION_ID`(pi)、`PI_SESSION_FILE`(oh-my-pi)、`CLAUDE_CODE_SESSION_ID`、`GROK_SESSION_ID`、`CODEX_SESSION_ID`、`DSH_SESSION_ID`……
  3. 自动发现：任何 `<TOOL>_SESSION_ID`（按变量名排序取第一个；`TERM_*` / `ITERM_*` / `OTEL_*` / `ANTHROPIC_*` 已排除）

  → `.kanban/sessions/<key>`；**三者都推不出**才退回旧的单文件 `.kanban/session`。
  `--harness` 只是贴标签，不参与选 key。
- 输出里有 `identity   : <key>` 一行；显示 `(none — sharing .kanban/session…)` 就是没分片，
  同目录的所有无 key 进程共用一个身份。`--no-write` 可以让 `start` 不落盘。
- **读取时绝不回退**：解析得出 key 就只读那个分片。所以升级后第一次跑会看到
  `missing session id, cannot tell who is operating`——跑一次 `session start` 即可，重注册安全
  （旧会话过宽限期判失联，卡回 `todo`，进度与 checklist 保留）。
- `end` **释放本会话持有的所有任务**（进度保留，状态回 `todo`），输出里列出释放了哪些卡。
- `heartbeat` 只刷新活跃时间，不写事件（否则事件量会被心跳淹没）。远程模式下回收由 server 定时做，不是靠心跳。
- MCP 不读这个文件，每次调用都要显式传 `session_id`（见 [mcp-tools.md](mcp-tools.md)）。

## 任务 task

### 读

```bash
agent-kanban task list [--status todo,doing] [--ready] [--mine] [--all]
                 [--label <标签>] [--parent <T-xxxx>] [--sort priority|created|updated|id]
                 [--limit <n，默认200>] [--json]
agent-kanban task ready                 # 等价于 task list --ready
agent-kanban task show T-0007 [--timeline] [--tail <n>] [--json]
```

- `--ready` = 依赖已满足**且无人持有**（租约过期的持有者也算无人持有）。
- `--all` 才包含 `done` / `cancelled`。
- `task show` 默认输出描述、checklist 逐项、依赖（id + 标题 + 完成状态），末尾附**可用的下一步命令**（`Available actions:`）。
  （`--body` 是遗留的兼容参数：早先描述要靠它才显示，现在默认就显示，传了也不报错。）
- 短选项：`-j` json、`-a` all、`-m` mine、`-s` status、`-l` label。

### 写（都需要会话上下文）

```bash
agent-kanban task add "标题" [-d "描述"] [-p 0-4] [--label a,b] [--parent T-0001]
                     [--check "步骤1,步骤2"] [--blocked-by T-0003] [--estimate 2h]
                     [--backlog]        # 直接进 backlog，默认进 todo
agent-kanban task claim T-0007 [--ttl 2h] [--force]     # start 是别名
agent-kanban task progress T-0007 [--pct 0-100] [--note "..."]
                             [--check "项1,项2"]      # 勾掉
                             [--uncheck "项1"]         # 取消勾选
                             [--add-check "新项"]      # 追加 checklist
agent-kanban task note T-0007 "发现依赖冲突"
agent-kanban task block T-0007 --reason "等 API key"      # 释放租约
agent-kanban task unblock T-0007
agent-kanban task review T-0007 [--note "..."]            # doing → review
agent-kanban task done T-0007 [--note "测试全绿"] [--force]   # complete 是别名
agent-kanban task cancel T-0007 --reason "需求变更"
agent-kanban task reopen T-0007 --reason "回归失败"
agent-kanban task release T-0007 [--reason "..."]         # 释放回 todo，进度保留
agent-kanban task edit T-0007 [--title "..."] [-d "..."] [-p 0-4] [--label a,b] [--estimate 1d]
agent-kanban task dep add T-0007 T-0003
agent-kanban task dep remove T-0007 T-0003
agent-kanban task dep list T-0007
agent-kanban task rm T-0007 [--force]                     # 事件与交接记录保留
```

- `--estimate` 支持 `30m` / `2h` / `1d` / `1h30m`。
- `--ttl` 传的是**时长字符串**（`30m`、`2h`、`short`），**不是分钟数**——`--ttl 7200` 会报 `cannot parse lease duration`。
  （`init --ttl` / `init --grace` 才收分钟数。）
- `--check` / `--uncheck` / `--add-check` / `--label` 是**逗号分隔列表**，按文本匹配。
- `done` 的返回体里有 `unblocked` 数组——告诉 agent 哪些下游卡现在能开工了。

## 看板与现场

```bash
agent-kanban board [--ready] [--mine] [--all] [--json]
agent-kanban context [--task T-0007] [--tail <n>] [--no-consume] [--json]
agent-kanban resume T-0007 [--force] [--tail <n>] [--json]
```

- `board --json` 与 `/api/board` 同一形状（7 条泳道：backlog/todo/doing/blocked/review/done/cancelled）。
- `context` 输出：看板概览 · 失联会话告警 · 待接手交接 · 本会话在做的 · 阻塞 · 可认领 · 建议动作。默认**消费**交接，`--no-consume` 只读。
- `resume` 输出：原持有者与是否发生过崩溃回收 · 最近交接 · 剩余 checklist · 时间线 · 当前计划版本 · 接下来该做什么。

## 交接 handoff

```bash
agent-kanban handoff --task T-0007 --summary "完成了什么" [--next "接着做什么"]
                 [--blockers "卡点1,卡点2"] [--open "待确认问题"]
agent-kanban handoff list --task T-0007
agent-kanban handoff pending
```

`--summary` 必填；`--next` 强烈建议（下一个 agent 最需要知道的就是"接下来干什么"）。
刚创建、已完成的卡不用写交接。写交接会**释放租约**。

## 计划 plan

```bash
agent-kanban plan save --title "标题" [--task T-0007] [--body-file <路径> | --body "..."]
agent-kanban plan show <计划号> [--json] [--raw]          # 位置参数是计划号，如 PL-T-0007-02
agent-kanban plan list [--task T-0007] [--all] [--json]
agent-kanban plan history <计划号> [--json]              # 位置参数是计划号
agent-kanban plan at --task T-0007 --ts <毫秒epoch>      # 那时生效的计划
agent-kanban plan attach <计划号> --task T-0007          # 把任务指向某个版本
```

- 计划号形如 **`PL-T-0007-02`**（`PL-<任务号>-<版本号>`）。`show` / `history` 的位置参数是**计划号**，不支持 `--task`。
- `--ts` 只收**数字**（毫秒 epoch），ISO 时间串会被当成缺参数，报 `missing --ts <epoch milliseconds>`。
- 每次 `save` 都产生新版本，旧版本转 `superseded`（不会丢）。带 `--task` 保存后自动挂到该任务上，等价于 `attach`。
- **CLI 没有 `plan diff` 子命令**（`plan.diff` 只存在于 core 与 MCP 层）。要比版本：用 MCP 的 `kanban_plan_diff`，或分别 `plan show` 两个计划号。
- `plan show --json` 的对象：

```json
{
  "id": "PL-T-0001-02", "scope": "task", "task_id": "T-0001", "version": 2,
  "title": "v2 方案", "status": "active", "author_session_id": "s-evp4k3",
  "created_at": 1790433425935, "supersedes_id": "PL-T-0001-01", "body": "第一步改了"
}
```

## 运维 doctor / rebuild

```bash
agent-kanban doctor [--deep] [--fix] [--json]
agent-kanban rebuild [--write] [--force] [--from-seq 100] [--json]
```

- `doctor` 快速核对租约/阻塞/progress 一致性；`--deep` 额外校验"投影与事件流是否一致"；`--fix` 自动回收失联任务、解除过期阻塞。
- 轻量回收（失联任务）在**本地模式**由每次命令隐式执行，**远程模式**由 server 按 `--reap-interval`（默认 30s）执行；`doctor` 在两种模式下都可用（走 Backend，在 server 侧校验）。
- `rebuild` **默认只校验不改数据**，可以放心随时跑（CI 里也可以）。`--write` 才覆盖投影，`--force` 允许带漂移强制覆盖。
- `lease_expires_at` 与 `updated_at` **不参与**漂移比较（由心跳/续租前移，续租不写事件）。这是设计上的正常现象。
- `agent-kanban doctor` 还会报告 AGENTS.md 里安装的协议块是否落后于 CLI 版本（**本地模式专属**，它读的是本地文件）。

## 配置 / install-protocol / admin / serve

```bash
agent-kanban config show | init | set | use | path
  agent-kanban config init --server <url> --project <key> --key k_xxx
  agent-kanban config set server.url <url>
  agent-kanban config use remote|local
agent-kanban install-protocol [--file <path>] [--check]   # 写入 / 校验 AGENTS.md 里的协作协议块
agent-kanban project list
agent-kanban admin project add|remove|list ...
agent-kanban admin token create|revoke|grant ... --project <key> --name "CI runner"
agent-kanban serve [--host 127.0.0.1] [--port 7788] [--reap-interval 30] [--quiet]
agent-kanban update [--check]        # 从 GitHub Releases 自更新二进制
agent-kanban mcp        # 以 stdio 启动 MCP server，harness 当子进程拉起
```

- `install-protocol` 幂等：只改 `<!-- agent-kanban:begin --> ... <!-- agent-kanban:end -->` 托管块，
  区块外的内容逐字不动，可以和别的约定写在同一个文件里。`--check` 只校验，缺失/落后时**退出码 2**（CI 用）。
  `doctor` 也会报这块是否落后于 CLI 版本（本地模式专属）。

- `serve` **默认只绑 127.0.0.1，且不终结 TLS**。跨机访问必须放在 TLS 反向代理之后，否则 token 明文过网。
- **`serve` 忽略 `--server`**——它自己就是提供能力的那一端，只能直连本地库。
- `KANBAN_ADMIN_TOKEN` 必须是 `k_` + 32 位小写 hex，格式错在**启动时**就失败。
- token 只显示一次；来自环境变量时既不写进 `config.toml` 也不打进日志。
- `project list` 是**本机直连**（列本地库里的 project），远程模式下不可用。

## 备份 export / import / snapshot / compact

```bash
agent-kanban export [--out <目录>]        # 导出事件 journal，一天一个文件
agent-kanban import <目录> [--dry-run] [--keep-project]
agent-kanban snapshot                    # 写人类可读的看板快照
agent-kanban compact [--keep-days 30]    # 先写快照，再裁剪旧事件
```

> ⚠️ **这四个命令不处理 `--help`**——加上 `--help` 会真的执行该操作。
>
> ⚠️ **只在本地模式可用**（需要直连本地库）。远程模式跑它们会报退出码 5 `NOT_INIT`（本地没库），请到 server 机器上执行。

跨机迁移：

```bash
# 旧机器
agent-kanban export --out .kanban/journal
# 新机器
agent-kanban init && agent-kanban import .kanban/journal && agent-kanban rebuild --write
```

`import` 会把事件重写到当前 project 并提示（因为 project key 由目录名派生，跨机不一致）；要保留原 key 加 `--keep-project`。

`compact` 保留最近 N 天 + 所有进行中任务的相关事件 + 保底 1000 条，被裁掉的历史只存在于裁剪前的快照里。

## JSON 输出字段

**`task show --json` / `task list --json` 的任务对象**：

```json
{
  "id": "T-0002", "project": "app", "title": "...", "status": "doing",
  "priority": 2, "progress": 10,
  "assignee_session_id": "s-4jdje0", "lease_expires_at": 1790434174040,
  "parent_id": null, "plan_id": null, "labels": [],
  "checklist": [{ "text": "步骤A", "done": true, "done_at": 1790433274040, "by": "s-4jdje0" }],
  "block_reason": null,
  "created_at": 1790433273910, "updated_at": 1790434174040,
  "started_at": 1790433273978, "finished_at": null, "body": null,
  "dependencies": [], "unfinished_dependencies": [],
  "next_actions": ["Continue: agent-kanban task progress T-0002 --pct 30 --note \"...\""]
}
```

时间戳一律是**毫秒 epoch**。

**错误包络**（走 stderr，stdout 保持干净）：

```json
{
  "error": {
    "code": 3,
    "name": "CONFLICT",
    "message": "task T-0004 is being worked on by s-agentc (progress 0%, 15 minute(s) left on the lease)",
    "details": {
      "task_id": "T-0004",
      "holder": { "session_id": "s-agentc", "agent_name": "agent-c", "progress": 0,
                  "last_seen_at": 1790433279457, "lease_expires_at": 1790434185172,
                  "lease_left_min": 15 },
      "last_event": { "type": "task_claimed", "ts": 1790433285173, "data": { "...": "..." } },
      "hint": "Someone else is working on this task. Pick a task from `agent-kanban task list --ready` instead; if you really need to take over, have a human confirm and use --force"
    }
  }
}
```

`details` 常见键：`usage`（USAGE）、`holder`（CONFLICT）、`legal_transitions`（STATE 非法流转）、`hint`。

## 状态机与守卫

| from | 可以去 | 守卫 |
|---|---|---|
| `backlog` | `todo`、`cancelled` | 取消要 `--reason` |
| `todo` | `blocked`、`done`、`cancelled`；`doing` 走 `claim` | 阻塞/取消要 `--reason`；`done` 要 `--force` |
| `doing` | `blocked`、`review`、`done`、`cancelled`；`todo` 走 `release` | 阻塞/取消要 `--reason`；`done` 要 `--force` |
| `blocked` | `todo`（`unblock`）、`cancelled` | 取消要 `--reason` |
| `review` | `done`、`doing`（打回重做）、`cancelled` | 取消要 `--reason` |
| `done` / `cancelled` | `todo`（`reopen`） | 要 `--reason` |

- 依赖满足时，被阻塞的依赖方会**自动**从 `blocked` 回到 `todo`（写 `task_unblocked` 事件）。
- `task done` 会解除依赖它的卡，返回体里带 `unblocked` 数组。
- 非法转移 → 退出码 2，错误 `details.legal_transitions` 列出合法后继。
- ⚠️ 这张表是**状态机本身**，不是 CLI 子命令表。`review → doing`（打回重做）**没有对应的 CLI/MCP 命令**
  （`task.transition` Op 只在 Web 看板拖拽里用到），变通见 [troubleshooting.md](troubleshooting.md#已知的转移缺口review-打回重做)。
