# MCP 工具对照

> 索引：注册 · 调用链 · 工具清单 · CLI↔MCP 对照 · 包络 · 差异

## 目录

- [什么时候用 MCP 而不是 CLI](#什么时候用-mcp-而不是-cli)
- [注册](#注册)
- [每个会话的调用链](#每个会话的调用链)
- [20 个工具](#20-个工具)
- [CLI ↔ MCP 参数对照](#cli--mcp-参数对照)
- [返回包络](#返回包络)
- [MCP 与 CLI 的行为差异](#mcp-与-cli-的行为差异)

---

## 什么时候用 MCP 而不是 CLI

两条路走的是**同一份 core**，数据完全一致，退出码也一致。选择只看环境：

| 用 MCP 工具 | 用 CLI |
|---|---|
| harness 已注册 kanban MCP server（省一次进程启动） | 脚本、CI、子 agent 的 shell 命令 |
| 需要结构化返回、不想解析文本表格 | 需要人读输出 |
| 同一个会话里连续操作（长驻进程，连接复用） | 一次性查询 |

**MCP 不会自动读 `.kanban/session`**，所以每次调用都要显式带 `session_id`。
（CLI 在**本地模式**下可以从 `.kanban/session` 自动取；**远程模式**下 CLI 也得显式传，见 [remote.md](remote.md)。）

**MCP 走的是和 CLI 完全相同的配置解析**，所以远程配置对 MCP 一样生效（`.kanban/config.toml` 被读取）。

## 注册

```bash
pi mcp add kanban -- cmd kanban mcp
claude mcp add kanban -- cmd kanban mcp
```

或写进项目根目录的标准 MCP 文件（本仓库已有 `.mcp.json`）：

```json
{
  "mcpServers": {
    "kanban": {
      "command": "dist/kanban.exe",
      "args": ["mcp"]
    }
  }
}
```

- `command` 的路径**相对于 harness 的工作目录**，所以要从项目根目录启动 harness。
- 看板本身是靠**从工作目录向上查找 `.kanban/`** 定位的。
- `kanban mcp` 的 stdout 是 JSON-RPC 通道，**诊断信息一律走 stderr**。

## 每个会话的调用链

```
kanban_session_start(agent_name="pi-fix")       → s-4k9d2m
kanban_bootstrap(session_id="s-4k9d2m")         → 交接、我的卡、无人持有的卡、失联会话
kanban_resume(session_id="s-4k9d2m", task_id="T-0007")
kanban_plan_show(task_id="T-0007")
kanban_task_progress(session_id=..., task_id="T-0007", pct=80)
kanban_handoff(session_id=..., task_id="T-0007", summary="...", next_step="...")
kanban_session_end(session_id="s-4k9d2m")
```

**`kanban_session_start` 之后必须紧跟 `kanban_bootstrap`**，它对应 CLI 的 `kanban context`。跳过它就是在盲干。

## 20 个工具

### 会话

| 工具 | 必填 | 可选 | 说明 |
|---|---|---|---|
| `kanban_session_start` | `agent_name` | `harness` | 注册会话，返回 `session_id`；顺带触发僵尸回收 |
| `kanban_bootstrap` | `session_id` | `consume_handoffs`(默认 true) | 对应 CLI `kanban context`。**每个会话第一个调用** |
| `kanban_session_end` | `session_id` | `summary` | 关闭会话，返回它释放的卡 |

### 任务

| 工具 | 必填 | 可选 |
|---|---|---|
| `kanban_task_list` | `session_id` | `status[]`、`mine`、`ready`、`label`、`limit`(默认 30) |
| `kanban_task_get` | `task_id` | `include_timeline`(默认 true)、`timeline_tail`(默认 20)、`include_plan` |
| `kanban_task_create` | `title` | `description`、`priority`(0 最高 4 最低)、`labels[]`、`checklist[]`、`blocked_by[]` |
| `kanban_task_claim` | `session_id`、`task_id` | `ttl_ms`(默认 900000)、`force` |
| `kanban_task_progress` | `session_id`、`task_id`、**`pct`** | `note`、`check_done`、`check_uncheck` |
| `kanban_task_note` | `session_id`、`task_id`、`text` | — |
| `kanban_task_block` | `session_id`、`task_id`、**`reason`** | — |
| `kanban_task_unblock` | `session_id`、`task_id` | — |
| `kanban_task_complete` | `session_id`、`task_id` | `note`、`force` |
| `kanban_task_review` | `session_id`、`task_id` | `note` |

### 恢复

| 工具 | 必填 | 可选 | 说明 |
|---|---|---|---|
| `kanban_resume` | `session_id`、`task_id` | `force` | 注入前任的交接与事件时间线。前任留过交接时**不需要** `force` |
| `kanban_handoff` | `session_id`、`task_id`、**`summary`** | `next_step`、`blockers[]`、`open_questions[]` | 同时释放租约 |

### 计划

| 工具 | 必填 | 可选 |
|---|---|---|
| `kanban_plan_save` | `title`、**`markdown`** | `task_id`（省略则为项目级计划） |
| `kanban_plan_show` | —（`task_id` 或 `plan_id` 二选一） | `max_chars`(默认 20000) |
| `kanban_plan_diff` | `from_plan_id`、`to_plan_id` | — |

### 看板

| 工具 | 必填 | 可选 |
|---|---|---|
| `kanban_board` | — | `include_ready`(默认 true)、`include_done` |
| `kanban_doctor` | — | `deep`、`fix` |

## CLI ↔ MCP 参数对照

| CLI | MCP | 注意 |
|---|---|---|
| `session start --agent X --harness Y` | `kanban_session_start` | MCP 每次调用都要传 `session_id` |
| `context` | `kanban_bootstrap` | `consume_handoffs` ↔ `--no-consume` |
| `context --task T-0007` | `kanban_task_get` + `include_plan` | |
| `resume T-0007` | `kanban_resume` | |
| `task list --ready` | `kanban_task_list(ready=true)` | MCP 默认 `limit=30`，CLI 默认 200 |
| `task show T-0007 --timeline` | `kanban_task_get(include_timeline=true)` | |
| `task add "T" -d "D" --check "a,b"` | `kanban_task_create` | MCP 用数组 `checklist: ["a","b"]` |
| `task claim T-0007 --ttl 2h` | `kanban_task_claim(ttl_ms=7200000)` | **CLI 收时长字符串，MCP 收毫秒数** |
| `task progress T --pct 60 --note N` | `kanban_task_progress(pct=60, note=N)` | |
| `task progress T --check "a"` | `kanban_task_progress(check_done="a")` | CLI 可一次传多项，MCP 一次一项 |
| `task note T "text"` | `kanban_task_note(text="text")` | |
| `task block T --reason R` | `kanban_task_block(reason=R)` | |
| `task unblock T` | `kanban_task_unblock` | |
| `task done T --note N` | `kanban_task_complete(note=N)` | 都需要 `force` 才能从 `todo`/`doing` 直达 `done` |
| `task review T` | `kanban_task_review` | |
| `handoff --task T --summary S --next N` | `kanban_handoff(summary=S, next_step=N)` | `--blockers "a,b"` ↔ `blockers: ["a","b"]` |
| `plan save --title T --body-file F` | `kanban_plan_save(title=T, markdown=<正文>)` | MCP 直接传正文，没有 `--body-file` |
| `plan show PL-T-0007-02`（位置参数是**计划号**） | `kanban_plan_show(plan_id=...)` 或 `kanban_plan_show(task_id="T-0007")` | **CLI 的 `show`/`history` 不支持 `--task`**，只能传计划号；MCP 两者都收 |
| `plan history PL-T-0007-02` | — | MCP 无对应工具，用 `kanban_plan_list` 看版本 |
| `plan diff` | `kanban_plan_diff` | **CLI 没有 `plan diff` 子命令**，diff 只能走 MCP |
| `board` | `kanban_board` | |
| `doctor --deep --fix` | `kanban_doctor(deep=true, fix=true)` | |
| `session end` | `kanban_session_end` | |

**MCP 工具集里没有的 CLI 命令**：`task cancel` / `reopen` / `release` / `edit` / `dep` / `rm` / `list --all`、`plan history` / `at` / `attach`、通用状态转移（`review → doing`）、`config` / `admin` / `project` / `serve` / `export` / `import` / `snapshot` / `compact` / `rebuild`。遇到这些请走 CLI。

反过来，**CLI 没有 `plan diff`**（`plan.diff` 只在 core 与 MCP 层），diff 只能走 MCP。

## 返回包络

成功：

```json
{ "ok": true, "data": { "...": "..." }, "next_actions": ["继续：..."] }
```

失败（`ok: false`，`error.code` / `error.name` 与 CLI 退出码一一对应）：

```json
{
  "ok": false,
  "error": {
    "code": 3,
    "name": "CONFLICT",
    "message": "任务 T-0004 正在被 s-agentc 处理（进度 0%，租约剩 15 分钟）",
    "hint": "改做 kanban_task_list(ready=true) 里的任务；确实需要接管请人工确认后用 force"
  }
}
```

- **按 `error.code` / `error.name` 分支**，不要解析 `message`。
- `next_actions` 是工具写给 agent 的建议下一步，照着走比自己猜可靠。

## MCP 与 CLI 的行为差异

| 差异点 | CLI | MCP |
|---|---|---|
| 会话身份 | 读 `.kanban/session`，无需显式传 | 长驻进程，**每次调用传 `session_id`** |
| 错误通道 | stderr，进程退出码 | 返回值里的 `error` 对象 |
| 列表默认条数 | `limit=200` | `limit=30` |
| 租约时长格式 | `2h` / `30m` 字符串 | `ttl_ms` 毫秒数 |
| checklist 操作 | `--check "a,b"` 一次多项 | `check_done` 一次一项 |
| 连接 | 每次调用一个进程 | 进程常驻，连接复用 |
