# agent-kanban

[English](README.md) · [中文](README_zh.md) · [开发者文档](Develop.md) · [Develop](Develop_zh.md)

让多个 AI agent 会话共享同一份任务真相，并且在其中一个崩溃后接手它的工作。

---

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
│ handoff  │ ─────────► │ session  │  kanban resume T-0007
│ 说明     │            │    B     │  → 拿到交接 + 时间线
└──────────┘            └──────────┘
```

**1. 任务归属靠租约。**
`kanban task claim T-0007` 给当前会话一份有期限的租约（默认 15 分钟）。进度和检查项完整保留。租约到期就回收，不管 agent 是崩溃、被杀还是走人，server 都会**自动**把任务收回去。下次 `context` 调用会告诉新会话"这张卡没人管，可以认领"，不需要跑任何清理脚本。

**2. 事件流是事实来源，看板是投影。**
每一次状态变化都是一个事件：`task_created`、`task_progress`、`handoff_created`、`plan_superseded`。`tasks` 和 `plans` 表是推导出来的。所以 `kanban rebuild` 能从事件流重算出整个看板，再和库里存的逐字段对比：

```console
$ kanban rebuild
重放 412 个事件...
4 个字段与已存投影不一致。

$ kanban rebuild --write
重放 412 个事件... 4 处漂移已在单个事务中修复。
```

事件流和投影一旦不一致，你会被告知，不会等到六周后才发现。

**3. 交接由人写。**
一个会话收工时会写交接：做完了什么、下一步是什么、卡在什么地方、还有什么悬而未决。`kanban resume` 优先展示**这个**。崩溃时系统自动生成的交接只作兜底，它会明确写"原持有者失联"，你不会把一个死掉会话的猜测误当成活人会话的指示。

**4. 计划存版本。**
`kanban plan save` 每次都产生新版本，旧版本标记为 `superseded`。`kanban plan history` 能看版本链，`kanban plan at --ts` 能看任意时刻生效的计划。任务做完、有人问"当初为什么这么做"时，答案还在。

## 快速开始

### 方式 A —— 单文件二进制（无需运行时）

从 [Releases](https://github.com/your-org/agent-kanban/releases) 下载对应平台的文件。二进制内嵌了 Bun 运行时、数据库 schema 和整个 Web 界面。

```bash
chmod +x kanban-linux-x64        # macOS 用 kanban-darwin-arm64 · Windows 用 kanban-windows-x64.exe
./kanban-linux-x64 init
./kanban-linux-x64 session start --agent my-agent
./kanban-linux-x64 task add "重写鉴权层"
./kanban-linux-x64 serve         # → http://127.0.0.1:7788/
```

### 方式 B —— 从源码运行

需要 [Bun](https://bun.sh) ≥ 1.4.2。

```bash
bun install
bun run build:binary            # 构建前端 → 内嵌资源 → 编译
./dist/kanban init
./dist/kanban serve
```

### 方式 C —— Docker

```bash
cp .env.example .env
# 填 KANBAN_ADMIN_TOKEN —— 生成一个：openssl rand -hex 16
docker compose up -d
```

镜像里**不含**编译好的二进制，它直接用 `oven/bun` 跑 TypeScript 源码，镜像内没有构建步骤，Bun 运行时也只有一份。

默认会用 Compose 本地构建镜像。想改成拉取已发布的镜像，在 `.env` 里设 `KANBAN_IMAGE`；`KANBAN_BIND` 和 `KANBAN_PORT` 控制服务能被访问到多远、绑在哪个宿主端口上。

## 日常用法

```bash
# 1. 开会话（登记你是谁）
kanban session start --agent pi-main --harness pi

# 2. 读现场 —— 这应该是你开工的第一个动作
kanban context
#    → 属于你的交接、你正在做的、你可以认领的

# 3. 认领任务（拿到租约）
kanban task claim T-0007

# 4. 干活，并顺手让看板保持真实
kanban task progress T-0007 --pct 60 --note "存储层重写完"
kanban task check T-0007 --item "加迁移测试"

# 5. 卡住了？说清楚，租约会自动释放
kanban task block T-0007 --reason "等运维给 API key"

# 6. 要离开？留一份真正的交接
kanban handoff --task T-0007 \
  --summary "鉴权重写完成，剩 token 刷新" \
  --next "从 refreshToken() 接手，见计划 v2" \
  --blockers "需要 staging API key" \
  --open "每次使用都轮换 refresh token？"

# 7. 收工
kanban task done T-0007 --note "测试全绿"
kanban session end
```

### 崩溃之后回来

```bash
kanban context           # 哪些是我的、哪些没人管、谁崩了
kanban resume T-0007     # 接管：交接 + 完整时间线一并注入
```

你拿到的是上一个会话的笔记、这次任务所有变更的有序列表、当前的计划版本——而不是一张标题写着"修鉴权"的空白卡。

## Web 看板

`kanban serve` 会在 7788 端口开一个真正的界面：

- **7 条泳道** —— 想法池 / 待办 / 进行中 / 已阻塞 / 待评审 / 已完成 / 已取消
- **拖拽**改状态，带状态机前置校验；非法移动会被拒绝并说明原因
- **任务详情抽屉** —— 时间线、交接记录、计划版本历史
- **实时刷新**（SSE），断线重连后按游标续传
- **多 project 切换**、亮暗模式
- **分享链接** —— `?key=…&project=…`，参数读取后立即从 URL 移除
- **管理页**在 `/admin` —— 管 project、签发/吊销 token

Web 和 CLI 走同一条数据通路。浏览器里能做的，agent 在 shell 里也能做。

## 跨机器共享一个看板

一个 `kanban serve` 进程可以管多个 project。每个 project 完全隔离：各自的任务、token、ID 空间（每个 project 的 `T-0001` 都从 1 开始）。

```bash
# 在 server 机器上
kanban serve                                  # 管理员 token 只打印一次
kanban admin project add my-app
kanban admin token create --project my-app --name "CI runner"
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
kanban config show     # 确认生效配置及其来源
kanban task list       # 之后不用再带参数
```

或者一条命令配好：

```bash
kanban config init --server https://kanban.example.com --project my-app --key k_a1b2c3
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
| `kanban init` | 创建本地看板（`.kanban/`） |
| `kanban session start \| end \| list \| heartbeat` | 会话生命周期 |
| `kanban task add \| list \| show \| claim \| progress \| block \| done \| …` | 任务操作 |
| `kanban board` | 终端泳道视图 |
| `kanban context` | 读现场：看板 + 交接 + 建议动作 |
| `kanban resume <task>` | 接管任务，注入交接与时间线 |
| `kanban handoff` | 写交接（summary / next / blockers / open） |
| `kanban plan save \| show \| list \| history \| at \| attach` | 计划版本化 |
| `kanban rebuild [--write]` | 重放事件流并校验投影 |
| `kanban doctor [--deep]` | 一致性自检与修复 |
| `kanban config show \| init \| set \| use \| path` | 配置管理 |
| `kanban project list` | 查询 project（本地库） |
| `kanban admin project … \| token …` | project 与 token 管理 |
| `kanban serve` | 启动 HTTP + SSE server |

完整参数见 `kanban <命令> --help`。

### 退出码

这是对外发布的契约，agent 会基于它做分支，含义不会变。

| 码 | 名称 | 含义 | 该做什么 |
|---|---|---|---|
| `0` | OK | 成功 | — |
| `1` | USAGE | 参数错误 | 读 `details.usage` 修正命令 |
| `2` | STATE | 任务不存在、非法状态转移、缺少必填的 `--reason` | 不要原样重试 |
| `3` | CONFLICT | 任务被他人持有且租约仍有效 | 换做别的，或等租约到期。**不要**用 `--force` |
| `4` | BUSY | 数据库被锁 | 退避后重试，最多 3 次 |
| `5` | NOT_INIT | 找不到 `.kanban/`，或 schema 需要迁移 | 跑 `kanban init` |
| `6` | INTERNAL | 内部错误（视为 bug） | 上报，不要重试 |
| `7` | AUTH | 缺 key、key 不对、或 project 不存在 | 修凭据 |

agent 应该基于退出码（或 `--json` 输出里的 `error.name` 字符串）分支，不要去解析错误文案。

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

## 文档

- [Develop_zh.md](Develop_zh.md) —— 架构、构建、发布、验证
- `docs/plan/001-总体设计.md` —— 设计与数据模型
- `docs/plan/002-接口契约.md` —— HTTP API 与 Op 协议
- `docs/note/` —— 实施记录与踩坑笔记

## 许可证

MIT
