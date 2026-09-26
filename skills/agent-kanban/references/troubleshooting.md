# 排障手册

> 看板在**别的机器**上（`agent-kanban serve`）、本地没有 db 时，症状完全不同——先看 [remote.md](remote.md)。
>
> 索引：症状速查 · 租约 · 冲突 · 流转被拦 · 认证 · 远程 · 数据一致性 · CLI 行为异常 · MCP 异常

## 症状速查

| 症状 | 大概率原因 | 去哪看 |
|---|---|---|
| 退出码 5 | 没有 `.kanban/`，或 schema 待迁移；**也可能是在远程模式跑了本地专用命令** | [认证与配置](#认证与配置) / [远程模式](#远程模式看板在别的机器上) |
| 退出码 7 | 缺 key / key 错 / 项目不存在 | [认证与配置](#认证与配置) |
| 退出码 3 | 卡在别人手里，租约还活着 | [冲突](#冲突) |
| 退出码 4 | 数据库被锁 | [数据库被锁](#数据库被锁) |
| 退出码 2 + `legal_transitions` | 非法流转或被守卫拦下 | [流转被守卫拦下](#流转被守卫拦下) |
| `缺少会话标识` | 没跑 `session start`，或**远程模式不会写 `.kanban/session`** | [远程模式](#远程模式看板在别的机器上) |
| 改完代码，看板还显示 0% | 忘了 `task progress` | [租约与"看板说谎"](#租约与看板说谎) |
| 照着 `next_actions` 跑却撞退出码 2 | 流转类建议要对照当前状态校验 | [已知的转移缺口](#已知的转移缺口review-打回重做) |
| 卡片莫名回到 `todo`，进度还在 | 上一个会话 `session end` 释放了它 | [租约与"看板说谎"](#租约与看板说谎) |
| 崩溃后 `context` 还说那张卡有人做 | 远程模式回收由 server 定时做（≤30s + 宽限） | [远程模式](#远程模式看板在别的机器上) |
| `agent-kanban doctor` 报投影漂移 | 事件流与投影不一致 | [数据一致性](#数据一致性) |
| `--help` 真的执行了操作 | export/import/snapshot/compact 不处理 `--help` | [CLI 行为异常](#cli-行为异常) |
| 换了个目录就找不到看板 | 看板靠向上查找 `.kanban/` | [CLI 行为异常](#cli-行为异常) |

## 租约与"看板说谎"

**默认租约 15 分钟，失联宽限 10 分钟。** 租约到期后卡片自动回到可认领状态，进度与 checklist 全部保留——不会丢，但会变成"别人可以直接抢"。

让看板不塌的两个动作：

1. **`task progress` 会顺手续租。** 每完成一个有意义的步骤就跑一次，不要攒到最后。这是"保持看板诚实"和"保住租约"的同一个动作。
2. **明确知道要干很久时，一开始就把租约拉长**：`agent-kanban task claim T-0007 --ttl 4h`（或 MCP `ttl_ms=14400000`）。事后加 `--ttl` 不行，`ttl` 只在 `claim` 时有效。

其他让租约提前失效的路径（都是设计如此，不是 bug）：

- `agent-kanban session end` —— **释放本会话持有的所有任务**，状态回 `todo`，输出里列出释放了哪些卡。这是"干净收工"。
- `agent-kanban task block` —— 标记阻塞会释放租约，让别人能接。
- `agent-kanban task release` —— 主动放回待办，进度保留。
- `agent-kanban handoff` —— 写交接等于让出，即使租约还有效别人也能直接接管。
- 进程被 `SIGKILL` / OOM / 断网 —— 租约自然过期，下一次 `session start` 或 `context` 触发回收时卡片重回可认领。

**同时持有多张卡时，每张都要单独 progress。** 只更新一张，另一张在别人眼里还是原样。

## 冲突（退出码 3）

```
错误[CONFLICT]：任务 T-0004 正在被 s-agentc 处理（进度 0%，租约剩 15 分钟）
提示：该卡正被别人处理。改做 `agent-kanban task list --ready` 里的任务；确实需要接管请人工确认后用 --force
当前持有者：s-agentc（agent-c） 进度 0%
```

`--json` 模式下 `details.holder` 里有 `session_id` / `agent_name` / `progress` / `lease_left_min` / `last_event`。

**正确反应：换一张卡。** 看 `details.holder.progress`：

- 进度为 0 或很低 → 对方可能只是挂在那里，换 `agent-kanban task list --ready` 里的别的卡。
- 进度很高 → 对方真在干，别碰。

**`--force` 只在人工明确确认后用。** 它会留下 `task_reclaimed` 事件，是审计痕迹，不是"重试按钮"。

合法接管的两种情况（都不需要 `--force`）：

- 对方**留了交接** → `agent-kanban resume T-0007` 直接接管（写交接即让出）。
- 对方**租约已过期 / 会话失联** → `agent-kanban context` 会把它列进"可认领"，`claim` 正常成功。

## 流转被守卫拦下

| 报错 | 原因 | 怎么办 |
|---|---|---|
| `该操作需要 --reason 参数`（退出码 1） | `block` / `cancel` / `reopen` 缺 `--reason` | 补上原因，这是硬要求 |
| `任务 T-0001 进度为 40%，未完成；确认请加 --force` | 某条转移需要 100% | 先 `task progress T-0001 --pct 100`，或确实要跳过就 `--force` |
| `从 doing 直接变为 done 需要 --force` | `todo`/`doing` → `done` 是 `forceOnly` | **正常路径是 `review` → `done`**：`task review T-0007` 然后 `task done T-0007`（`review` → `done` 不需要 force） |
| `任务 T-0001 不能从 X 变为 Y；合法后继状态：…`（退出码 2） | 非法转移 | 按错误里的 `legal_transitions` 走 |

### 已知的转移缺口：`review` 打回重做

`task review` 之后的 `next_actions` 会提示 `agent-kanban task reopen T-0007 --reason "..."`，**但这条建议会失败**：

```
错误[STATE]：任务 T-0001 不能从 review 变为 todo；合法后继状态：done, doing, cancelled
```

原因：`reopen` 固定转移到 `todo`，而 `review` 的合法后继只有 `done` / `doing` / `cancelled`。CLI 和 MCP 都没暴露通用的 `review → doing` 转移（那条边只有 Web 看板拖拽走得到）。

变通（三步，进度保留）：

```bash
agent-kanban task done T-0007 --note "打回重做"     # review → done
agent-kanban task reopen T-0007 --reason "回归失败"  # done → todo
agent-kanban task claim T-0007                       # todo → doing
```

## 数据库被锁（退出码 4）

退避重试，**最多 3 次**。常见于多个 agent 同时写、或 `serve` 正在跑批量操作。不要改成无限重试，也不要直接删 `kanban.db`。

## 认证与配置

```bash
agent-kanban config show      # 看当前生效配置及其来源（token 脱敏）
agent-kanban config path      # 配置文件在哪
```

| 退出码 | 原因 | 处理 |
|---|---|---|
| 5 NOT_INIT | 没有 `.kanban/`，或 schema 需要迁移；**也可能是远程模式跑本地专用命令** | 本地 → `agent-kanban init`；远程 → 见 [远程模式](#远程模式看板在别的机器上)，**别用 init 去"修"** |
| 7 AUTH | 缺 key / key 错 / project 不存在 | 检查 `config.toml` 的 `[server] url/token` 与 `[project] key`；token 格式必须是 `k_` + 32 位小写 hex |

排查顺序：

1. `agent-kanban config show` —— 看解析出来的 server / project / mode 到底是从哪来的。
2. 确认**远程模式三个字段齐全**：`mode = "remote"`、`[server] url`、`[server] token`、`[project] key`。
3. **空环境变量算"未设置"**，不是空值。`export KANBAN_SERVER=` 会静默盖掉 `config.toml`，凭空建一个空本地库——看到"突然多了一个空看板"先查环境变量。
4. 改了仍不生效：CLI 最高优先级，用 `agent-kanban <cmd> --server <url> --project <key> --key k_xxx` 显式传一次验证。

## 远程模式的两个易混点

1. **project token 只能访问被显式授权的 project**，admin token 才能跨 project；ID 空间也按 project 独立
   （`T-0001` 在每个 project 都从 1 开始）。“连上了但看不到别人的卡”十有八九是 `--project` 指错了。
2. **网络失败看起来像认证失败**（都是退出码 7）。`agent-kanban config show` 确认配置没变之后重试，
   **不要因为一次网络抖动就以为自己的租约丢了、或去抢别人的卡**。

搭建、备份、跨机迁移、安全等完整内容见 [remote.md](remote.md)。

## 远程模式（看板在别的机器上）

先判定：`agent-kanban config show` → 「模式」那行。完整版见 [remote.md](remote.md)，这里只列排障要点。

| 症状 | 原因 | 处理 |
|---|---|---|
| `缺少会话标识，无法确定是谁在操作` | **远程模式下 `session start` 不写 `.kanban/session`**，紧接着的写命令就找不到身份 | `export KANBAN_SESSION=<session_id>`，或每条命令带 `--session`；id 用 `agent-kanban session start --agent X --json` 取 |
| `export` / `import` / `snapshot` / `compact` / `project list` 报退出码 5 | 这些命令直连本地库，远程模式本地没库 | 去 **server 机器**上跑。错误里的「没有 `.kanban/kanban.db`」是误导，看板没坏 |
| 崩溃后 `context` 还显示那张卡有人做 | 回收在 server 侧按 `--reap-interval`（默认 30s）跑，与你的命令无关 | 等 30s + 失联宽限（默认 10 分钟）；急的话去 server 跑 `doctor --fix`。别反复 `claim --force` |
| 远程目录里跑过 `init` 之后 `export` 不报错了 | `init` 建了个没人用的本地 `kanban.db` 当"诱饵"，`export` 静默导这个空库 | 删掉那个本地 `kanban.db`（配置在 `config.toml`，不会丢），备份去 server 做 |
| 时好时坏、退出码 7 | 网络抖动被当成认证失败 | `agent-kanban config show` 确认配置没变；重试一次；**别因为一次失败就以为租约丢了** |
| 看板连上了但看不到别人建的卡 | `--project` 指到了别的 project（ID 空间按 project 独立，`T-0001` 每个 project 都从 1 开始） | `agent-kanban config show` 核对 project key |

**判定原则：先 `agent-kanban config show` 定模式，再排错。** 本地模式报的 `NOT_INIT` 和远程模式报的 `NOT_INIT` 含义完全不同。

## 数据一致性

事件流是唯一事实源，`tasks` / `plans` 表是投影。所以"看板和现实对不上"是可以被证明的：

```bash
agent-kanban doctor              # 快速核对：租约 / 阻塞 / progress 一致性
agent-kanban doctor --deep       # 额外校验"投影与事件流是否一致"
agent-kanban doctor --fix        # 自动修复：回收失联任务、解除过期阻塞
agent-kanban rebuild             # 只校验，不改任何数据（CI 里可以放心跑）
agent-kanban rebuild --write     # 用事件流重算覆盖投影
agent-kanban rebuild --from-seq 100   # 只重放 seq >= 100，排查局部问题
```

- **`lease_expires_at` 与 `updated_at` 不参与漂移比较**——它们由心跳/续租前移，而续租不写事件。看到这两项"不一致"是正常的。
- `rebuild` 默认只读，所以历史有缺口**不可能**悄悄抹掉看板；真要覆盖得显式 `--write --force`。
- 升级到计划版本化之前的历史交接事件不带完整内容，会被列进"无法重建"而不是误报漂移。

备份与迁移：

```bash
agent-kanban export --out .kanban/journal     # 一天一个文件的事件 journal
# 新机器
agent-kanban init && agent-kanban import .kanban/journal && agent-kanban rebuild --write
```

`import` 会把事件重写到当前 project 并提示（project key 由目录名派生，跨机不一致）；要保留原 key 加 `--keep-project`。
别直接拷 `kanban.db`——那是活库，路径变了也对不上。`export`/`import` 可合并、可 diff、server 开着也能跑。

数据库跑了很久太大：`agent-kanban compact --keep-days 30`。它先写快照再裁剪，保留最近 N 天 + 所有进行中任务的相关事件 + 保底 1000 条；被裁掉的历史只存在于裁剪前的快照里。

## CLI 行为异常

| 现象 | 原因 | 应对 |
|---|---|---|
| `agent-kanban export --help` 真的导出了 | `export`/`import`/`snapshot`/`compact` **不处理 `--help`**，会直接执行 | 删掉误产出的文件；`compact` 删了事件就用 `.kanban/snapshots/pre-compact-*.json` 恢复 |
| `agent-kanban task claim --help` 报"缺少参数" | 子命令**先校验位置参数**再看 `--help`，`--help` 被当已知选项忽略 | 只有 `agent-kanban task --help` 打印用法；子命令选项查 [commands.md](commands.md) |
| 在子目录跑 `init` 没建新看板 | 看板靠**向上查找 `.kanban/`** 定位，找到就复用 | 要隔离得把目录放到仓库外面 |
| 远程目录里 `init` 之后 `export` 不报错了 | `init` 建了"诱饵"本地库 | 删掉本地 `kanban.db`；见 [远程模式](#远程模式看板在别的机器上) |
| 时间线里某条显示 `(undefined)` | 事件类型的中文描述未覆盖（展示层小瑕疵，不影响数据） | 忽略；以 `agent-kanban task show --json` 的结构化字段为准 |
| 改了 `.kanban/config.toml` 没生效 | CLI 参数优先级最高 | `agent-kanban config show` 看来源 |
| `session end` 后我的卡变成 `todo` 了 | 这是设计：释放租约、进度保留 | 正常；要保留持有就别 `session end` |

## MCP 异常

| 现象 | 原因 | 应对 |
|---|---|---|
| 工具报"缺少会话上下文" | MCP 不读 `.kanban/session`，必须显式传 | 先 `kanban_session_start` 拿到 `session_id`，之后每次调用都带上 |
| 看板定位到别的项目 | `command` 路径相对 harness 工作目录；看板靠 cwd 向上查找 | 从项目根目录启动 harness |
| 工具列表里没有 `plan history` / `task cancel` / `rebuild` | MCP 只暴露核心 20 个工具 | 这些走 CLI |
| stdout 出现非 JSON 文本 | `agent-kanban mcp` 的 stdout 是 JSON-RPC 通道 | 诊断信息走 stderr；把 stdout 当纯协议流读 |
| 某个工具报 `USAGE` "未知工具" | 名字拼错 | 错误 `hint` 里列了全部可用工具名 |
