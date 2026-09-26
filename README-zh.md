# agent-kanban

[English](README.md) · [中文](README-zh.md) · [开发者文档](Develop.md) · [Develop](Develop-zh.md)

让多个 AI agent 会话共享同一份任务真相，并且在其中一个崩溃后接手它的工作。

---
![Screenshot](docs/images/screenshot.png)
![Task](docs/images/task.png)

## 要解决的问题

你在同一个仓库上跑多个编码 agent。可能是一个主会话加若干子 agent，也可能是 agent 在任务做到一半时死掉：网络抖动，OOM 被杀，笔记本合上了，或者 supervisor 发了 `SIGKILL`。

到头来通常剩下一堆终端滚动记录里的工作，后来谁也读不懂：

- Agent A 改了一半的鉴权层，上下文全在 A 的提示词窗口里。
- Agent B 看到一条标题为"修鉴权"的任务，要么从零开始，要么更糟，直接和 A 撞车。
- 三个开着的分支里哪个是过期的，没人说得清。
- 任务清单、推理过程和进度状态分在三个地方：TODO 文件、agent 的输出、还有你的脑子。

每一次重启都是考古。

## agent-kanban 做了什么

它给每个 agent 一份**任务租约**和一条**只追加的事件流**，再加一套**交接协议**。新会话接手时能拿到上一个会话的真实上下文，不必只看到一个任务标题。

```
┌──────────┐   claim    ┌───────────┐   write     ┌──────────┐
│ session  │ ─────────► │   task    │ ──────────► │ progress │
│    A     │            │ T-0007    │            │ 60%, ... │
└────┬─────┘            └─────┬─────┘            └────┬─────┘
     │                        │                       │
     │  租约过期，或 agent 崩溃                      │
     ▼                        ▼                       ▼
┌────────────────────────────────────────────────────────────┐
│  事件流（只追加，唯一事实来源）                                │
└────────────────────────────────────────────────────────────┘
     │                        │
     │  handoff               │  rebuild
     ▼                        ▼
┌──────────┐            ┌──────────┐
│ handoff  │ ─────────► │ session  │  agent-kanban resume T-0007
│ 说明     │            │    B     │  → 拿到交接 + 时间线
└──────────┘            └──────────┘
```

**1. 任务归属靠租约。**
`agent-kanban task claim T-0007` 给当前会话一份有期限的租约（默认 15 分钟）。进度和检查项完整保留。租约到期就回收，不管 agent 是崩溃、被杀还是走人，server 都会**自动**把任务收回去。下次 `context` 调用会告诉新会话"这张卡没人管，可以认领"，不需要跑任何清理脚本。

**2. 事件流是事实来源，看板是投影。**
每一次状态变化都是一个事件：`task_created`、`task_progress`、`handoff_created`、`plan_superseded`。`tasks` 和 `plans` 表是推导出来的。所以 `agent-kanban rebuild` 能从事件流重算出整个看板，再和库里存的逐字段对比：

```console
$ agent-kanban rebuild
agent-kanban  replayed 412 events (23ms)
  Recomputed: tasks 18 · deps 6 · plans 4 · handoffs 5

✗ found 4 drifts (the stored projections ≠ the result recomputed from the events)
  tasks.T-0012 field status
    stored:     todo
    recomputed: doing
  ... and 3 more
  Fix: agent-kanban rebuild --write --force
  (--write overwrites tasks/plans/handoffs/task_deps with the event stream)

$ agent-kanban rebuild --write --force
agent-kanban  replayed 412 events (19ms)
  Recomputed: tasks 18 · deps 6 · plans 4 · handoffs 5

✓ the projections match the event stream exactly
  the projections have been overwritten with the recomputed result
```

事件流和投影一旦不一致，你会被告知，不会等到六周后才发现。

**3. 交接由人写。**
一个会话收工时会写交接：做完了什么、下一步是什么、卡在什么地方、还有什么悬而未决。`agent-kanban resume` 优先展示**这个**。崩溃时系统自动生成的交接只作兜底，它会明确写"原持有者失联"，你不会把一个死掉会话的猜测误当成活人会话的指示。

**4. 计划存版本。**
`agent-kanban plan save` 每次都产生新版本，旧版本标记为 `superseded`。`agent-kanban plan history` 能看版本链，`agent-kanban plan at --ts` 能看任意时刻生效的计划。任务做完、有人问"当初为什么这么做"时，答案还在。

## 快速开始

### 方式 A —— 单文件二进制（无需运行时）

从 [Releases](https://github.com/ArnoChenFx/agent-kanban/releases) 下载对应平台的文件。二进制内嵌了 Bun 运行时、数据库 schema 和整个 Web 界面。

```bash
chmod +x agent-kanban-linux-x64        # macOS 用 agent-kanban-darwin-arm64 · Windows 用 agent-kanban-windows-x64.exe
./agent-kanban-linux-x64 init
./agent-kanban-linux-x64 install-protocol   # 教会你的 agent 使用看板
./agent-kanban-linux-x64 session start --agent my-agent
./agent-kanban-linux-x64 task add "重写鉴权层"
./agent-kanban-linux-x64 serve         # → http://127.0.0.1:7788/
```

### 方式 B —— 从源码运行

需要 [Bun](https://bun.sh) ≥ 1.4.2。

```bash
bun install
bun run build:binary            # 构建前端 → 内嵌资源 → 编译
./dist/agent-kanban init
./dist/agent-kanban serve
```

### 方式 C —— Docker

```bash
cp .env.example .env
# 填 KANBAN_ADMIN_TOKEN —— 生成一个：openssl rand -hex 16
docker compose up -d
```

镜像里**不含**编译好的二进制，它直接用 `oven/bun` 跑 TypeScript 源码，镜像内没有构建步骤，Bun 运行时也只有一份。

从 **GitHub Container Registry（GHCR）** 拉取已发布的镜像——发布流程只推 GHCR，不推 Docker Hub。镜像地址直接写在 `docker-compose.yml` 里，想换 tag 或命名空间就改那一行。`KANBAN_BIND` 和 `KANBAN_PORT` 控制服务能被访问到多远、绑在哪个宿主端口上。

## 日常用法

```bash
# 1. 开会话（登记你是谁）
agent-kanban session start --agent pi-main --harness pi

# 2. 读现场 —— 这应该是你开工的第一个动作
agent-kanban context
#    → 属于你的交接、你正在做的、你可以认领的

# 3. 认领任务（拿到租约）
agent-kanban task claim T-0007

# 4. 干活，并顺手让看板保持真实
agent-kanban task progress T-0007 --pct 60 --note "存储层重写完"
agent-kanban task check T-0007 --item "加迁移测试"

# 5. 卡住了？说清楚，租约会自动释放
agent-kanban task block T-0007 --reason "等运维给 API key"

# 6. 要离开？留一份真正的交接
agent-kanban handoff --task T-0007 \
  --summary "鉴权重写完成，剩 token 刷新" \
  --next "从 refreshToken() 接手，见计划 v2" \
  --blockers "需要 staging API key" \
  --open "每次使用都轮换 refresh token？"

# 7. 收工
agent-kanban task done T-0007 --note "测试全绿"
agent-kanban session end
```

### 崩溃之后回来

```bash
agent-kanban context           # 哪些是我的、哪些没人管、谁崩了
agent-kanban resume T-0007     # 接管：交接 + 完整时间线一并注入
```

你拿到的是上一个会话的笔记、这次任务所有变更的有序列表、当前的计划版本——而不是一张标题写着"修鉴权"的空白卡。

## Web 看板

`agent-kanban serve` 会在 7788 端口开一个真正的界面。看板、管理页和 CLI 调的是同一套 API
——一条数据通路，不存在第二份事实源。

```bash
agent-kanban serve                                  # → http://127.0.0.1:7788/
agent-kanban serve --port 9000 --host 0.0.0.0       # --host 0.0.0.0 前先看下面的 TLS 提醒
agent-kanban serve --reap-interval 30               # server 回收失联会话的间隔
```

### 怎么进去：所有 `/api/*` 都要 token

浏览器没有环境权限，所以第一屏会问你要 token。拿到 token 只有三条路：

| token 从哪来 | 怎么拿 |
|---|---|
| **管理员 token，自动生成** | 机器上第一次 `agent-kanban serve` 会打印一次，并写进 `.kanban/config.toml` 的 `[server] admin_token`。若它来自 `KANBAN_ADMIN_TOKEN` 环境变量则**不打印**，去配置文件里看 |
| **项目级 token，签发得到** | `agent-kanban admin token create --project my-app --name "CI 专用"` —— 明文只显示这一次 |
| **分享链接** | `http://host:7788/?key=k_…&project=my-app` —— 参数读取后立即从 URL 移除 |

把 token 粘进登录卡片。**project 栏是选填的**：留空则自动选第一个有权限的 project。
一个 token 可以同时授权多个 project，顶栏那个切换器就是为这个准备的。

| token 类型 | 能访问 |
|---|---|
| 项目级 token | 只有被显式授权的那些 project |
| 管理员 token | 全部 project，外加 project 与 token 管理 |

### 看板能做什么

- **7 条泳道** —— 想法池 / 待办 / 进行中 / 已阻塞 / 待评审 / 已完成 / 已取消
- **拖拽**改状态，带状态机前置校验；非法移动会被拒绝并说明原因
- **任务详情抽屉** —— 概览（描述、检查项逐项 + 谁勾的、依赖/父任务）、时间线、交接记录、计划版本历史
- **实时刷新**（SSE），断线重连后按游标续传
- **多 project 切换**、亮暗模式
- **中英文双语** —— 看板与管理页（`/admin`）都能一键切换，共用同一个语言选择；首次打开按浏览器语言自动判定
- **分享链接** —— `?key=…&project=…`，参数读取后立即从 URL 移除

Web 和 CLI 走同一条数据通路。浏览器里能做的，agent 在 shell 里也能做。

### `/admin` 管理页

建 project、签发 token、改某个 token 能访问哪些 project、吊销 token。吊销在下一个请求就生效
——没有会话要等过期。

`/admin` 需要**管理员** token。项目级 token 会拿到 `403` 并说明原因，这是刻意区分的：
*forbidden* 意思是「token 有效但角色不对，换一个」，*invalid* 意思是「去拿个新 token」——
两种问题、两种修法。

前端没构建过时，`serve` 会退回内置占位页，把 API 面板列出来而不是假装那是个看板：
`GET /api/health`（免鉴权）、`POST /api/op`（需 `X-Kanban-Key` 或 `Authorization: Bearer`）、
`GET /api/stream`、`/admin`。

### 暴露出去之前

`serve` 不终结 TLS，默认只绑 `127.0.0.1`。要绑 `0.0.0.0` 先放在 TLS 反向代理后面
——**没有 TLS，token 就是明文传输的。** 参见[安全](#安全)一节。

Docker 里看板和 API 共用一个端口：`KANBAN_PORT` 控制宿主端口，`KANBAN_BIND` 控制宿主机侧
绑定地址（容器内永远听 `0.0.0.0`）。

浏览器把 token 存在 `localStorage`，这样刷新不用重新登录。代价是 XSS 能读到它，
所以本项目**严格禁止 `innerHTML`**。

## 跨机器共享一个看板

一个 `agent-kanban serve` 进程可以管多个 project。每个 project 完全隔离：各自的任务、token、ID 空间（每个 project 的 `T-0001` 都从 1 开始）。

```bash
# 在 server 机器上
agent-kanban serve                                  # 管理员 token 只打印一次
agent-kanban admin project add my-app
agent-kanban admin token create --project my-app --name "CI runner"
# → k_a1b2c3...

# 在客户端机器上：写 <项目>/.kanban/config.toml
```

```toml
mode = "remote"

[server]
url   = "https://kanban.example.com"
token = "k_a1b2c3..."

[project]
key = "my-app"
```

```bash
agent-kanban config show     # 确认生效配置及其来源
agent-kanban task list       # 之后不用再带参数
```

或者一条命令配好：

```bash
agent-kanban config init --server https://kanban.example.com --project my-app --key k_a1b2c3
```

## 配置

所有配置都在 `<项目>/.kanban/config.toml`。

| 配置项 | 命令行参数 | 环境变量 | 默认值 |
|---|---|---|---|
| Server 地址 | `--server` | `KANBAN_SERVER` | 由项目目录派生 |
| Project key | `--project` | `KANBAN_PROJECT` | 由项目目录派生 |
| 访问 token | `--key` | `KANBAN_KEY` | — |
| 模式 | — | `KANBAN_MODE` | 有 server 则 `remote`，否则 `local` |
| 数据库路径 | `--db` | `KANBAN_DB` | `<项目>/.kanban/kanban.db` |
| 会话 ID | `--session` | `KANBAN_SESSION` | `<项目>/.kanban/session` |

有两个选项对所有命令生效，写在子命令前后都可以：`--json` 输出结构化结果，`--no-color` 关闭 ANSI 颜色。在 CI 里更推荐设 `NO_COLOR=1`。

Server 端：`KANBAN_HOST`、`KANBAN_PORT`、`KANBAN_WEB_DIR`、`KANBAN_ADMIN_TOKEN`。在 Docker 里 `KANBAN_BIND` 控制的是**宿主侧**的绑定地址（`127.0.0.1` 或 `0.0.0.0`）。容器内部始终监听 `0.0.0.0`，真正决定服务能被谁访问的是这个变量。

**优先级：** 命令行参数 > 环境变量 > `config.toml` > 派生默认值。

> 空字符串环境变量算作"未设置"。否则 `export KANBAN_SERVER=` 会静默屏蔽一份完全正确的 `config.toml`，然后悄悄新建一个空本地库。

## 安全

**`serve` 不终止 TLS，默认只绑 `127.0.0.1`。**

这是有意为之。这类工具的多数部署场景背后已经有 HTTPS：可能是公司网关、nginx 或 K8s Ingress，也可能只是 VPN 内可达的网络。为此再加一个会续期证书的容器，等于引入一个新的故障模式（证书过期 → 全面不可用），而多数用户并不需要。

如果你要对外暴露，请放在 TLS 终止之后。**没有 TLS，token 就是明文传输的。**

`KANBAN_ADMIN_TOKEN` 必须是 `k_` 加 32 位小写十六进制。格式不对会在**启动时**就失败，不会拖到第一次用。一个只在后面才坏的凭据配置是最糟的一种。

来自环境变量时，它既不会写进 `config.toml`，也不会打印到日志。

| Token 类型 | 权限 |
|---|---|
| 项目级 token | 只能访问被显式授权的 project |
| 管理员 token | 全部 project，外加 project 与 token 管理 |

## 命令速查

| 命令 | 用途 |
|---|---|
| `agent-kanban init` | 创建本地看板（`.kanban/`） |
| `agent-kanban install-protocol` | 把 agent 协作协议写入项目的 `AGENTS.md` |
| `agent-kanban mcp` | 启动 MCP server（stdio），让 agent 以 tool call 读写看板 |
| `agent-kanban session start \| end \| list \| heartbeat` | 会话生命周期 |
| `agent-kanban task add \| list \| show \| claim \| progress \| block \| done \| …` | 任务操作 |
| `agent-kanban board` | 终端泳道视图 |
| `agent-kanban context` | 读现场：看板 + 交接 + 建议动作 |
| `agent-kanban resume <task>` | 接管任务，注入交接与时间线 |
| `agent-kanban handoff` | 写交接（summary / next / blockers / open） |
| `agent-kanban plan save \| show \| list \| history \| at \| attach` | 计划版本化 |
| `agent-kanban rebuild [--write]` | 重放事件流并校验投影 |
| `agent-kanban export [--out <目录>]` | 导出事件 journal（按天分文件） |
| `agent-kanban import <目录> [--dry-run]` | 从 journal 重建库（跨机器迁移用） |
| `agent-kanban snapshot` | 写看板快照（人可读 JSON） |
| `agent-kanban compact [--keep-days 30]` | 裁剪旧事件（先自动快照） |
| `agent-kanban doctor [--deep]` | 一致性自检与修复 |
| `agent-kanban config show \| init \| set \| use \| path` | 配置管理 |
| `agent-kanban project list` | 查询 project（本地库） |
| `agent-kanban admin project … \| token …` | project 与 token 管理 |
| `agent-kanban serve` | 启动 HTTP + SSE server |

完整参数见 `agent-kanban <命令> --help`。

### 退出码

这是对外发布的契约，agent 会基于它做分支，含义不会变。

| 码 | 名称 | 含义 | 该做什么 |
|---|---|---|---|
| `0` | OK | 成功 | — |
| `1` | USAGE | 参数错误 | 读 `details.usage` 修正命令 |
| `2` | STATE | 任务不存在、非法状态转移、缺少必填的 `--reason` | 不要原样重试 |
| `3` | CONFLICT | 任务被他人持有且租约仍有效 | 换做别的，或等租约到期。**不要**用 `--force` |
| `4` | BUSY | 数据库被锁 | 退避后重试，最多 3 次 |
| `5` | NOT_INIT | 找不到 `.kanban/`，或 schema 需要迁移 | 跑 `agent-kanban init` |
| `6` | INTERNAL | 内部错误（视为 bug） | 上报，不要重试 |
| `7` | AUTH | 缺 key、key 不对、或 project 不存在 | 修凭据 |

agent 应该基于退出码（或 `--json` 输出里的 `error.name` 字符串）分支，不要去解析错误文案。

## 让 agent 自己会用这个看板

### 方式一：协议文件（对任何 agent 有效）

```bash
agent-kanban install-protocol      # 往 <项目>/AGENTS.md 写一个受管区块
agent-kanban install-protocol --check   # CI 门禁：缺失或落后则退出码 2
```

区块夹在 `<!-- agent-kanban:begin -->` 与 `<!-- agent-kanban:end -->` 之间，命令只碰这一段，
所以你可以在同一个文件里写自己的规范。`agent-kanban doctor` 会报出区块是否落后于 CLI 版本。

只要 agent 会读 `AGENTS.md`（或 `CLAUDE.md`、或你 harness 认的那个文件名），
它就知道开工前要先跑 `agent-kanban session start` 和 `agent-kanban context`，而不是直接改代码。
也可以用 `--file` 写到别处，比如 `--file .cursor/rules/kanban.mdc`。

### 方式二：MCP 工具

```bash
pi mcp add agent-kanban -- cmd agent-kanban mcp
claude mcp add agent-kanban -- cmd agent-kanban mcp
```

本仓库已经自带：根目录的 `.mcp.json` 注册的就是本地构建产物，任何读取标准 MCP 配置的
harness 都能零配置接上。注意要从项目根启动 harness——`command` 路径相对于它的工作目录解析，
看板本身也是从那里逐级向上查找的。

```json
{
  "mcpServers": {
    "kanban": {
      "command": "kanban",
      "args": ["mcp"]
    }
  }
}
```

20 个工具，全部是 CLI 同一套 core 的薄封装：

| 分组 | 工具 |
|---|---|
| 会话 | `kanban_session_start` / `kanban_bootstrap` / `kanban_session_end` |
| 任务 | `kanban_task_list` / `get` / `create` / `claim` / `progress` / `note` / `block` / `unblock` / `complete` / `review` |
| 恢复 | `kanban_resume` / `kanban_handoff` |
| 计划 | `kanban_plan_save` / `show` / `diff` |
| 看板 | `kanban_board` / `kanban_doctor` |

agent 被期望跑的训练流程：

```
kanban_session_start(agent_name="pi-fix")   → s-4k9d2m
kanban_bootstrap(session_id="s-4k9d2m")     → 交接、你的卡、无人管的卡
kanban_resume(session_id="s-4k9d2m", task_id="T-0007")
kanban_plan_show(task_id="T-0007")
kanban_task_progress(..., pct=80)
kanban_handoff(..., summary="...", next_step="...")
kanban_session_end(session_id="s-4k9d2m")
```

每个工具返回 `{ ok, data, next_actions }`；失败时返回 `{ ok: false, error }`，
其中的 `code` 与 `name` 与 CLI 的退出码一一对应，agent 可以用同一套逻辑分支。

### 方式三：agent skill

skill 是第三种方式，也是唯一一种教 agent **工作流**而不是接口的方式。协议文件说的是"开工先跑
`agent-kanban context`"；skill 说的是拿到退出码 3 时该换卡而不是加 `--force`、`task progress` 顺带续租、
`doing → done` 会被守卫拦下所以要绕 `review`。agent 容易踩的那些点被拆成了几个 reference：
完整命令参考、MCP 工具对照、本地与远程的差异，以及一张按退出码索引的排障表。

```bash
npx skills add ArnoChenFx/agent-kanban --skill agent-kanban            # 安装
```

skill 实体放在本仓库的 `skills/` 下，所以任何项目都能装，不只是本仓库。装到已经建好看板的项目里，
再和上面两种方式之一搭配使用——三者互补：skill 负责讲清楚，协议文件负责强制，MCP 工具负责动手。

## 什么时候该用它

适合：

- 多个 agent 会话在同一个仓库上工作
- 任务长到需要跨越上下文窗口
- 工作会被打断（CI、笔记本合上、agent 重启）
- 团队想**看见** agent 在干什么，而不用 tail 日志

不适合：

- 单个 agent 的短任务，开销不划算
- 不能共享给 server 的工作，用本地模式，不需要 server
- 需要真正的多用户权限模型。token 是按 project 授权的，不是按用户

## 常见问题

**数据库不入 git，这样安全吗？**

安全，而且丢了能恢复。`.kanban/kanban.db` 是个 SQLite 文件：它本来就是构建产物、
里面全是 token 哈希、合并也麻烦。不入 git 是刻意的。

**入 git 的是 `.kanban/journal/`** —— 只追加的事件流，每次变更一行 JSON，按天分文件。
既然事件是事实来源、看板只是投影，那么在新机器上重放这个日志就能完整重建：
任务、检查项、计划、交接、依赖，一个不少。`agent-kanban rebuild --write` 干的正是这件事，
和它用来自证一致的是同一套机制。

```bash
# 旧机器上
agent-kanban export --out .kanban/journal

# 新机器上
agent-kanban init
agent-kanban import .kanban/journal
agent-kanban rebuild --write --force
```

project key 是由目录名派生的，所以新旧机器不同。`import` 会把事件改写到当前 project
并告知你；想保留原 key 就加 `--keep-project`。

**能不能直接拷 `.db` 文件到另一台机器？**

通常可以，前提是路径不变。但它是个活数据库，要在 server 停掉时拷，而且不会与目标机
上已有的数据合并。更推荐 `export` / `import`：可合并、可 diff、且 server 在跑时也能用。

**事件流有缺口怎么办？**

`agent-kanban doctor` 会报出不一致，`agent-kanban rebuild` 能指出到底哪些字段对不上。
不加 `--write --force` 它不会写入任何东西，所以历史里的缺口不可能静默地抹掉你的看板。

**两个 agent 抢同一张卡会怎样？**

一个赢。输的那个拿到退出码 `3`，并附上当前持有者的名字、进度和最后动作，应该改做别的。
`--force` 留给你确认过要人工介入的情况，它会留下一条 `task_reclaimed` 事件。

**agent 干活途中死了，怎么接手？**

`agent-kanban context` 会列出持有者已失联的卡，然后 `agent-kanban resume T-0007` 接管。
进度和检查项都会保留，上一位持有者的交接会一并注入。
如果对方留了交接，即使租约还没到期也能接管——写交接就意味着让位。

**怎么把整个看板迁到共享 server？**

在目标机器上跑 `agent-kanban serve`，建一个 project，签一个 token，
再用 `.kanban/config.toml` 把客户端指过去。每个 project 隔离，每个 token 只能访问被授权的 project。

**跑了几个月，数据库变大了。**

`agent-kanban compact --keep-days 30`。它会先写快照再删旧事件，
保留最近 N 天的全部、进行中任务的相关事件，以及无论多旧都保底的 1000 条。
被裁掉的那段历史只存在于那份快照里。

**能直接暴露到网络上吗？**

`serve` 默认绑 `127.0.0.1`，且不终止 TLS。暴露前请放在 TLS 终止之后：
没有 TLS 的话 token 就是明文传输的。参见[安全](#安全)一节。

## 文档

- [Develop-zh.md](Develop-zh.md) —— 架构、构建、发布、验证
- 文档配图用的演示看板：`bun run seed:demo` 会往 `.kanban/kanban.db` 灌一份模拟看板，详见 Develop-zh.md 的“演示看板（截图用）”一节

## 许可证

MIT
