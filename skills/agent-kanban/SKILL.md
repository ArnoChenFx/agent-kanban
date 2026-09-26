---
name: agent-kanban
description: 用 agent-kanban 看板协调多个 agent 会话的任务——开工读现场、认领租约、推进进度、写交接、崩溃后接管别人的卡。适用于任何存在 .kanban/ 目录、AGENTS.md 里带 kanban 协议块、或注册了 kanban MCP server 的仓库；CLI 与 MCP 工具（kanban_*）两套接口都覆盖。触发词：kanban、看板、认领、claim、交接、handoff、租约、lease、接管、resume、agent-kanban context、agent-kanban task progress、多会话协作、崩溃恢复、共享任务状态。不适用于：单 agent 的短任务、不需要跨会话共享的待办清单。
---

# agent-kanban 协作

看板是同一仓库所有 agent 会话共享的唯一事实源。**改代码却不更新看板，等于让看板描述一个不存在的项目。**

看板有**本地**和**远程**两种模式（`agent-kanban config show` 可查），行为差别很大，**开工前先确认自己在哪种模式**。

## 硬规则

1. **绝不直接读写 `.kanban/kanban.db`，绝不手工编辑 `.kanban/` 下任何文件。** 只用 `kanban` CLI 或 `kanban_*` MCP 工具。远程模式下本地**根本没有** db，只存 `config.toml`。
2. **按退出码 / `error.name` 分支，永远不要解析错误文案。** 文案会改，码是公开契约。
3. **退出码 3（CONFLICT）意味着换一张卡，不是加 `--force`。** `--force` 只在人工明确确认后用，且会留下 `task_reclaimed` 事件。
4. **交接是写给下一个人看的**：落到函数名、文件路径、失败的测试名。"剩下的不复杂"会让下一个会话多花一整轮。
5. **状态流转必须走 CLI/工具**，守卫是有意设计的（见"状态机"）。绕过守卫等于让看板说谎。

## 第一步：确认模式（两种模式行为不同）

```bash
agent-kanban config show      # 看「模式」那行：本地 还是 远程
```

|  | 本地模式 | 远程模式（`agent-kanban serve` 在别的机器上） |
|---|---|---|
| 数据在哪 | 本地 `.kanban/kanban.db` | **server 的库里**；本地只有 `.kanban/config.toml` |
| 怎么配 | `agent-kanban init`，零配置 | `agent-kanban config init --server <url> --project <key> --key k_xxx` |
| 会话身份 | `session start` 会写 `.kanban/session`，后续命令自动带上 | ⚠️ **`session start` 不写本地文件**——每条命令都要 `--session <id>` 或设 `KANBAN_SESSION` |
| 失联回收 | 每次命令隐式触发 | **server 定时回收**（`serve --reap-interval`，默认 30s） |
| `export`/`import`/`snapshot`/`compact`/`project list` | 可用 | ❌ 退出码 5（本地没库），要在 **server 机器上**跑 |

最容易被坑的一条：**远程模式下 `agent-kanban session start` 不会写 `.kanban/session`**，紧接着的 `task claim` 会报
`缺少会话标识`。补救：`export KANBAN_SESSION=s-xxxx`（或每条命令带 `--session`）。
详见 [references/remote.md](references/remote.md)。

## 开工：两条命令读现场

每个工作会话的第一件事。**在仓库任意子目录执行都有效**——看板靠向上查找 `.kanban/` 定位：

```bash
agent-kanban session start --agent <你的名字> --harness pi   # 拿到 s-xxxx，并把 id 写进 .kanban/session
agent-kanban context                                        # 读现场：交接 / 我在做的 / 失联会话 / 阻塞 / 可认领 / 建议动作
```

- `session start` 在**本地模式**下顺带触发僵尸回收：崩溃 agent 遗留的租约在这里被回收，卡片重新变成可认领（远程模式由 server 定时回收，见上表）。
- **本地模式**下 `session start` 会把 id 写进 `.kanban/session`，之后的 CLI 命令不用再带 `--session`。
  **远程模式不会写**——每条命令都要显式带 `--session <id>`，或先 `export KANBAN_SESSION=s-xxxx`。
- `agent-kanban context` 会**消费**交接（标记已读）。只预览不消费用 `--no-consume`。
- MCP 是长驻进程、不读那个文件，**每次工具调用都要显式传 `session_id`**。
- `context --json` 字段：`project` / `counts` / `zombie_sessions` / `pending_handoffs` / `my_tasks` / `in_progress` / `blocked` / `ready` / `next_actions`。**先读 `next_actions`，它直接告诉你下一步干什么。**

## 认领与推进：租约会过期

```bash
agent-kanban task claim T-0007                      # 默认租约 15 分钟
agent-kanban task claim T-0007 --ttl 2h             # 明确知道要干很久，直接把租约拉长
agent-kanban task progress T-0007 --pct 60 --note "存储层重写完，20 个测试全绿"
agent-kanban task progress T-0007 --check "加迁移测试"   # 按文本勾掉 checklist 项
```

- **`task progress` 同时续租。** 每完成一个有意义的步骤就跑一次——"保持看板诚实"和"保住租约"是同一件事，别攒到最后。
- 同时持有多张卡时**每张都要单独 progress**，否则没更新的那张在别人眼里还是原样。
- `pct` 会影响状态机守卫：想从 `doing` 直接 `done` **必须加 `--force`**，正常路径是 `review`。

## 收工：两条出路

做完了 —— 走评审再完成，工具会告诉你哪些下游卡解锁了：

```bash
agent-kanban task review T-0001
agent-kanban task done T-0001 --note "测试全绿"
```

做不完 / 要让给别人 / 上下文快满了 —— 写交接，**并顺手释放租约**：

```bash
agent-kanban handoff --task T-0007 \
  --summary "WAL 事务层完成，store.ts 20 个测试全绿" \
  --next "实现崩溃自动合成交接，见计划 PL-T-0007-02 的 M2" \
  --blockers "等 staging 的 API key" \
  --open "WAL 文件要不要纳入 git 跟踪？倾向不纳入"
```

`--summary` 必填，`--next` 强烈建议。**写了交接等于主动让出这张卡**：下一个会话即使在租约有效期内也能直接接管，不必等超时。

```bash
agent-kanban session end --summary "本轮做完 T-0007 存储层"
```

`session end` **会释放本会话持有的所有任务**（进度保留、状态回 `todo`），并列出释放了哪些卡。所以它是"干净收工"，不是"挂着卡消失"。

## 崩溃恢复

```bash
agent-kanban context           # 先看：哪些卡持有者失联、哪些交接待接手
agent-kanban resume T-0007     # 接管：注入原持有者、最近交接、剩余 checklist、时间线、当前计划版本
```

- 原持有者**留过交接**时，`resume` 不需要 `--force`（写交接即让出）。
- `resume --force` 会抢仍在有效租约内的卡。**除非人工确认，不要用。**
- 崩溃自动合成的交接会明说"上一任不可达"，别把它当活人的指令。

## 状态机（流转不是自由的）

```
backlog ──> todo ──claim──> doing ──review──> review ──> done
              │               │                 │
              │               └──> blocked <────┘
              │                     │
              │               unblock│ / 依赖满足时自动
              │                     v
              │                   todo
              │
              └──cancel──> cancelled <──cancel──┘  (doing / review / blocked / backlog 同样可 cancel)

终态 done / cancelled ──reopen（必须 --reason）──> todo
```

**实际路径（实测）**：`todo`/`doing` → `done` 需要 `--force`，**正常路径是 `doing` → `review` → `done`**（`review` → `done` 不需要 force）。
`review` 想打回重做时，`agent-kanban task reopen` 会失败（退出码 2，`review` 的合法后继只有 `done` / `doing` / `cancelled`），
且 CLI/MCP 都没暴露通用的 `review → doing` 转移。变通：`done --note "打回"` → `reopen --reason "回归失败"` → `claim`。

守卫（不满足会返回退出码 1 或 2）：

| 转移 | 守卫 |
|------|------|
| → `blocked` | 必须给 `--reason` |
| → `cancelled` | 必须给 `--reason` |
| `done`/`cancelled` → `todo` | 必须给 `--reason` |
| `todo`/`doing` → `done` | 需要 `--force`（正常路径走 `review`） |
| 任何非法转移 | 退出码 2，错误里带 `legal_transitions` |

## 方案有变就存计划，不要覆盖

计划是版本化的：每次 `save` 产生新版本，旧版本转 `superseded`，不会丢。

```bash
agent-kanban plan save --task T-0007 --title "拆成 4 个里程碑" --body-file .kanban/plans/T-0007.md
agent-kanban plan list --task T-0007            # 当前生效版本
agent-kanban plan show PL-T-0007-02             # 读某个版本全文（位置参数是**计划号**，不是任务号）
agent-kanban plan history PL-T-0007-02          # 版本链
```

计划号形如 `PL-T-0007-02`（`PL-<任务号>-<版本号>`）。`--body` 必填：标题只是一句话，正文才是价值。
**存新版前先 `plan show` 读当前版本**，让新版本是增量而不是重写。

CLI **没有** `plan diff` 子命令（`plan.diff` 只在 core 与 MCP 层暴露）。要比两个版本：用 MCP 的 `kanban_plan_diff`，
或分别 `plan show` 两个计划号自己比。

## 分支：退出码是契约

| 码 | 名字 | 含义 | 你该做什么 |
|----|------|------|-----------|
| 0 | OK | 成功 | 继续 |
| 1 | USAGE | 参数不对 / 缺 `--reason` | 读 `details.usage` 改命令，**不要原样重试** |
| 2 | STATE | 任务不存在 / 非法流转 / 被守卫拦下 | 读 `legal_transitions` 换方案，**不要原样重试** |
| 3 | CONFLICT | 他人持有且租约有效 | 读 `details.holder`（持有者、进度、剩余租约），换一张卡 |
| 4 | BUSY | 数据库被锁 | 退避重试，最多 3 次 |
| 5 | NOT_INIT | 没有 `.kanban/` 或 schema 待迁移 | `agent-kanban init` |
| 6 | INTERNAL | 工具自身的 bug | 报告，不要重试 |
| 7 | AUTH | 缺 key / key 错 / 项目不存在 | `agent-kanban config show` 查来源，修凭据 |

## 输出契约

- `--json`（或 `-j`）对所有命令有效，写在子命令前或后都行。
- **脚本、循环、CI 里一律加 `--json`**；人类输出带颜色和排版，不要去解析。
- 成功 → stdout 一个 JSON 对象。失败 → **stderr** 一个 `{"error":{"code","name","message","details"}}`，stdout 保持干净。
- 写命令的返回体带 `next_actions`（JSON 模式下是 `next_actions` 字段），是工具写给 agent 的建议下一步。**优先照着它走，比自己猜可靠；但流转类建议要对照当前状态校验**（例：`task review` 之后提示的 `task reopen` 会撞守卫，见上面"状态机"）。

## 更多细节按需读

| 想知道 | 读 |
|--------|-----|
| 看板在远程 server 上：配置、命令可用性、失联回收时机、跨机协作 | [references/remote.md](references/remote.md) |
| 每个子命令的完整选项、配置与环境变量、JSON 字段、备份维护命令 | [references/commands.md](references/commands.md) |
| 用 MCP 工具（`kanban_*`）怎么调、CLI↔MCP 参数对照、`.mcp.json` 注册 | [references/mcp-tools.md](references/mcp-tools.md) |
| 租约/冲突/漂移/认证/远程模式的排障手法 | [references/troubleshooting.md](references/troubleshooting.md) |

## 坑（实测踩过的，别重蹈）

- `agent-kanban export` / `import` / `snapshot` / `compact` **不处理 `--help`**——加上 `--help` 会**真的执行该操作**（导出、裁剪事件）。要看用法去读文档，不是敲 `--help`。
- `agent-kanban task <子命令> --help` **不打印帮助**，而是真去执行该命令、因缺位置参数报 USAGE。只有 `agent-kanban task --help` 打印用法。
- 在**仓库的子目录**里跑 `agent-kanban init` 不会建新看板——它向上找到已有的 `.kanban/` 就复用。要隔离测试得把目录放到仓库外面。
- 远程模式的目录里跑 `agent-kanban export` 会报 `NOT_INIT 未找到看板数据目录`——**这个提示是误导的**，你的看板在 server 上好好的。备份要去 server 机器跑。
- `--force` 不是"再试一次"的意思。
