# agent-kanban 完整命令参考

> 本文以**本地模式**为准。**远程模式**（看板在别的机器上）下有 5 个命令不可用、`session start` 也不写本地文件，
> 先看 [remote.md](remote.md)。
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
- [运维 doctor / rebuild / rebuild](#运维-doctor--rebuild)
- [配置 config / project / admin / serve](#配置-config--project--admin--serve)
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
| 模式 | `kanban config use` | `KANBAN_MODE` | 有 server 则 `remote`，否则 `local` |
| 数据库 | `--db` | `KANBAN_DB` | `<project>/.kanban/kanban.db` |
| 会话 id | `--session` | `KANBAN_SESSION` | `<project>/.kanban/session` |

**空环境变量算"未设置"**，不是空值——否则 `export KANBAN_SERVER=` 会静默盖掉 `config.toml`，凭空建一个空本地库。

服务端变量：`KANBAN_HOST` / `KANBAN_PORT` / `KANBAN_WEB_DIR` / `KANBAN_ADMIN_TOKEN`。
Docker 里 `KANBAN_BIND` 控制**宿主机侧**绑定地址（容器内永远听 `0.0.0.0`）。

## 会话 session

```bash
kanban session start --agent <名字> [--harness pi|claude-code|cursor|human] [--id s-xxx]
kanban session list [--all] [--json]
kanban session heartbeat [--session <id>]
kanban session end [--summary "本次做了什么"] [--session <id>]
```

- `start` 把 `session_id` 写进 `.kanban/session`，之后 CLI 命令无需再传 `--session`；并顺带触发僵尸回收。
  ⚠️ **只有本地模式会写这个文件**。远程模式下 `start` 只在 server 侧建会话，本地不留痕迹，
  每条命令都要显式带 `--session` 或设 `KANBAN_SESSION`（`session start --json` 可直接取 id）。
- `end` **释放本会话持有的所有任务**（进度保留，状态回 `todo`），输出里列出释放了哪些卡。
- `heartbeat` 只刷新活跃时间，不写事件（否则事件量会被心跳淹没）。远程模式下回收由 server 定时做，不是靠心跳。

## 任务 task

### 读

```bash
kanban task list [--status todo,doing] [--ready] [--mine] [--all]
                 [--label <标签>] [--parent <T-xxxx>] [--sort priority|created|updated|id]
                 [--limit <n，默认200>] [--json]
kanban task ready                 # 等价于 task list --ready
kanban task show T-0007 [--timeline] [--body] [--tail <n>] [--json]
```

- `--ready` = 依赖已满足**且无人持有**（租约过期的持有者也算无人持有）。
- `--all` 才包含 `done` / `cancelled`。
- 短选项：`-j` json、`-a` all、`-m` mine、`-s` status、`-l` label。

### 写（都需要会话上下文）

```bash
kanban task add "标题" [-d "描述"] [-p 0-4] [--label a,b] [--parent T-0001]
                     [--check "步骤1,步骤2"] [--blocked-by T-0003] [--estimate 2h]
                     [--backlog]        # 直接进 backlog，默认进 todo
kanban task claim T-0007 [--ttl 2h] [--force]     # start 是别名
kanban task progress T-0007 [--pct 0-100] [--note "..."]
                             [--check "项1,项2"]      # 勾掉
                             [--uncheck "项1"]         # 取消勾选
                             [--add-check "新项"]      # 追加 checklist
kanban task note T-0007 "发现依赖冲突"
kanban task block T-0007 --reason "等 API key"      # 释放租约
kanban task unblock T-0007
kanban task review T-0007 [--note "..."]            # doing → review
kanban task done T-0007 [--note "测试全绿"] [--force]   # complete 是别名
kanban task cancel T-0007 --reason "需求变更"
kanban task reopen T-0007 --reason "回归失败"
kanban task release T-0007 [--reason "..."]         # 释放回 todo，进度保留
kanban task edit T-0007 [--title "..."] [-d "..."] [-p 0-4] [--label a,b] [--estimate 1d]
kanban task dep add T-0007 T-0003
kanban task dep remove T-0007 T-0003
kanban task dep list T-0007
kanban task rm T-0007 [--force]                     # 事件与交接记录保留
```

- `--estimate` 支持 `30m` / `2h` / `1d` / `1h30m`。
- `--ttl` 传的是**时长字符串**（`30m`、`2h`），不是分钟数。
- `--check` / `--uncheck` / `--add-check` / `--label` 是**逗号分隔列表**，按文本匹配。
- `done` 的返回体里有 `unblocked` 数组——告诉 agent 哪些下游卡现在能开工了。

## 看板与现场

```bash
kanban board [--ready] [--mine] [--all] [--json]
kanban context [--task T-0007] [--tail <n>] [--no-consume] [--json]
kanban resume T-0007 [--force] [--tail <n>] [--json]
```

- `board --json` 与 `/api/board` 同一形状（7 条泳道：backlog/todo/doing/blocked/review/done/cancelled）。
- `context` 输出：看板概览 · 失联会话告警 · 待接手交接 · 本会话在做的 · 阻塞 · 可认领 · 建议动作。默认**消费**交接，`--no-consume` 只读。
- `resume` 输出：原持有者与是否发生过崩溃回收 · 最近交接 · 剩余 checklist · 时间线 · 当前计划版本 · 接下来该做什么。

## 交接 handoff

```bash
kanban handoff --task T-0007 --summary "完成了什么" [--next "接着做什么"]
                 [--blockers "卡点1,卡点2"] [--open "待确认问题"]
kanban handoff list --task T-0007
kanban handoff pending
```

`--summary` 必填；`--next` 强烈建议（下一个 agent 最需要知道的就是"接下来干什么"）。
刚创建、已完成的卡不用写交接。写交接会**释放租约**。

## 计划 plan

```bash
kanban plan save --title "标题" [--task T-0007] [--body-file <路径> | --body "..."]
kanban plan show <计划号> [--json] [--raw]          # 位置参数是计划号，如 PL-T-0007-02
kanban plan list [--task T-0007] [--all] [--json]
kanban plan history <计划号> [--json]              # 位置参数是计划号
kanban plan at --task T-0007 --ts <毫秒epoch>      # 那时生效的计划
kanban plan attach <计划号> --task T-0007          # 把任务指向某个版本
```

- 计划号形如 **`PL-T-0007-02`**（`PL-<任务号>-<版本号>`）。`show` / `history` 的位置参数是**计划号**，不支持 `--task`。
- `--ts` 只收**数字**（毫秒 epoch），ISO 时间串会报 `选项 --ts 需要数字`。
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
kanban doctor [--deep] [--fix] [--json]
kanban rebuild [--write] [--force] [--from-seq 100] [--json]
```

- `doctor` 快速核对租约/阻塞/progress 一致性；`--deep` 额外校验"投影与事件流是否一致"；`--fix` 自动回收失联任务、解除过期阻塞。
- 轻量回收（失联任务）在**本地模式**由每次命令隐式执行，**远程模式**由 server 按 `--reap-interval`（默认 30s）执行；`doctor` 在两种模式下都可用（走 Backend，在 server 侧校验）。
- `rebuild` **默认只校验不改数据**，可以放心随时跑（CI 里也可以）。`--write` 才覆盖投影，`--force` 允许带漂移强制覆盖。
- `lease_expires_at` 与 `updated_at` **不参与**漂移比较（由心跳/续租前移，续租不写事件）。这是设计上的正常现象。
- `kanban doctor` 还会报告 AGENTS.md 里安装的协议块是否落后于 CLI 版本（**本地模式专属**，它读的是本地文件）。

## 配置 config / project / admin / serve

```bash
kanban config show | init | set | use | path
  kanban config init --server <url> --project <key> --key k_xxx
  kanban config set server.url <url>
  kanban config use remote|local
kanban project list
kanban admin project add|remove|list ...
kanban admin token create|revoke|grant ... --project <key> --name "CI runner"
kanban serve [--host 127.0.0.1] [--port 7788] [--reap-interval 30] [--quiet]
kanban mcp        # 以 stdio 启动 MCP server，harness 当子进程拉起
```

- `serve` **默认只绑 127.0.0.1，且不终结 TLS**。跨机访问必须放在 TLS 反向代理之后，否则 token 明文过网。
- **`serve` 忽略 `--server`**——它自己就是提供能力的那一端，只能直连本地库。
- `KANBAN_ADMIN_TOKEN` 必须是 `k_` + 32 位小写 hex，格式错在**启动时**就失败。
- token 只显示一次；来自环境变量时既不写进 `config.toml` 也不打进日志。
- `project list` 是**本机直连**（列本地库里的 project），远程模式下不可用。

## 备份 export / import / snapshot / compact

```bash
kanban export [--out <目录>]        # 导出事件 journal，一天一个文件
kanban import <目录> [--dry-run] [--keep-project]
kanban snapshot                    # 写人类可读的看板快照
kanban compact [--keep-days 30]    # 先写快照，再裁剪旧事件
```

> ⚠️ **这四个命令不处理 `--help`**——加上 `--help` 会真的执行该操作。
>
> ⚠️ **只在本地模式可用**（需要直连本地库）。远程模式跑它们会报退出码 5 `NOT_INIT`（本地没库），请到 server 机器上执行。

跨机迁移：

```bash
# 旧机器
kanban export --out .kanban/journal
# 新机器
kanban init && kanban import .kanban/journal && kanban rebuild --write
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
  "next_actions": ["继续：kanban task progress T-0002 --pct 30 --note \"...\""]
}
```

时间戳一律是**毫秒 epoch**。

**错误包络**（走 stderr，stdout 保持干净）：

```json
{
  "error": {
    "code": 3,
    "name": "CONFLICT",
    "message": "任务 T-0004 正在被 s-agentc 处理（进度 0%，租约剩 15 分钟）",
    "details": {
      "task_id": "T-0004",
      "holder": { "session_id": "s-agentc", "agent_name": "agent-c", "progress": 0,
                  "last_seen_at": 1790433279457, "lease_expires_at": 1790434185172,
                  "lease_left_min": 15 },
      "last_event": { "type": "task_claimed", "ts": 1790433285173, "data": { "...": "..." } },
      "hint": "该卡正被别人处理。改做 `kanban task list --ready` 里的任务；确实需要接管请人工确认后用 --force"
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
