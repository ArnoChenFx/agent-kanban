# 远程模式：看板在别的机器上

> 一台 `agent-kanban serve` 可以管多个 project，多个 agent 会话、多个开发机都接同一份看板。
> 本文所有行为都在真实 server + 远程客户端上实测过。

## 目录

- [两种模式的差别](#两种模式的差别)
- [搭建](#搭建)
- [客户端配置](#客户端配置)
- [最大的坑：session start 不写本地文件](#最大的坑session-start-不写本地文件)
- [命令可用性对照](#命令可用性对照)
- [失联回收的时机不一样](#失联回收的时机不一样)
- [别在远程目录里跑 agent-kanban init](#别在远程目录里跑-kanban-init)
- [备份与维护要去 server 机器](#备份与维护要去-server-机器)
- [跨机协作](#跨机协作)
- [安全](#安全)
- [MCP 在远程模式](#mcp-在远程模式)

---

## 两种模式的差别

|  | 本地模式 | 远程模式 |
|---|---|---|
| 数据在哪 | `<项目>/.kanban/kanban.db` | **server 的库**；客户端只有 `.kanban/config.toml` |
| `.kanban/` 里有啥 | `kanban.db` + `config.toml` + `session` + `journal/` | **只有 `config.toml`**（`session` 也不会有，见下） |
| 怎么进这个模式 | `agent-kanban init`（默认 `mode = "local"`） | 配置里 `mode = "remote"` 且 `server.url` 非空 |
| 看板定位 | 向上找带 `kanban.db` 的 `.kanban/` | 向上找带 `config.toml` 的 `.kanban/`（宽松查找，**不要求有 db**） |
| 失联回收时机 | 每次命令隐式触发 | server 定时（`serve --reap-interval`，默认 30s） |
| 网络 | 无 | 每个命令一次 HTTP，失败即退出码 7 / 6 |

判定当前模式（**每次开工都该跑一次**）：

```bash
agent-kanban config show
#   模式    远程  (config)
#   server  https://kanban.example.com  (config)
#   project my-app  (config)
#   token   k_3da17f…72c6（34 字符）  (config)
```

优先级链（两种模式共用）：`命令行选项 > 环境变量 > config.toml > 派生默认`。
**空环境变量算"未设置"**，所以 `export KANBAN_SERVER=` 会静默盖掉配置——"突然多了一个空看板"先查环境变量。

## 搭建

### server 机器

```bash
agent-kanban init                      # server 自己也是个本地项目
agent-kanban serve                     # 默认 http://127.0.0.1:7788
```

`serve` 第一次启动会自动生成管理员 token 并打印一次（之后只在 `config.toml` 里）。
来自 `KANBAN_ADMIN_TOKEN` 的 token **不打印明文**（避免进容器日志）。

```bash
agent-kanban admin project add my-app
agent-kanban admin token create --project my-app --name "CI runner"
# → k_3da17fb1a6058a98e7cad5b7b70072c6      只显示这一次
```

也可以用 `kanban --key <admin_token> admin project list` 跨 project 查看。

### 一个 server 管多个 project

每个 project 完全隔离：自己的任务、自己的 token、自己的 ID 空间（`T-0001` 在每个 project 都从 1 开始）。
project token 只能访问被显式授权的 project；admin token 能访问全部。

## 客户端配置

一次配好，之后所有命令都不用带参数：

```bash
agent-kanban config init --server https://kanban.example.com --project my-app --key k_3da17fb1...
agent-kanban config show       # 确认生效配置与来源
```

等价的手写配置 `.kanban/config.toml`：

```toml
mode = "remote"

[server]
url   = "https://kanban.example.com"
token = "k_3da17fb1..."

[project]
key = "my-app"
```

或改单个字段：

```bash
agent-kanban config set server.url https://kanban.example.com
agent-kanban config set server.token k_3da17fb1...
agent-kanban config set project.key my-app
```

⚠️ `config.toml` **含 token，不要提交到公开仓库**。

## 最大的坑：session start 不写本地文件

```console
$ agent-kanban session start --agent remote-agent --harness pi
✓ 会话已注册
  session_id : s-16bbht
$ agent-kanban task claim T-0001
错误[USAGE]：缺少会话标识，无法确定是谁在操作
```

**远程模式下 `session start` 故意不写 `.kanban/session`**（源码注释：「远程模式不写本地状态」），所以每条命令都得自己带身份。三种解法：

```bash
# 1. 导出环境变量（本会话内最省事）
export KANBAN_SESSION=s-16bbht

# 2. 每条命令显式传
agent-kanban task claim T-0001 --session s-16bbht

# 3. 记在 agent 的上下文里，每条命令都带上
```

`--session` / `KANBAN_SESSION` **两种模式都有效**；只是本地模式还能白拿 `.kanban/session` 兜底，远程模式没有。
`session start --json` 可以直接拿到 id，方便脚本化：

```bash
SID=$(agent-kanban session start --agent my-agent --json | jq -r .id)
```

## 命令可用性对照

### 远程可用（Op 在 server 侧执行，与本地同一套 core）

`session start/list/heartbeat/end` · `task add/list/show/ready/claim/progress/note/block/unblock/review/done/cancel/reopen/release/edit/dep/rm` · `board` · `context` · `resume` · `handoff` · `plan save/show/list/history/at/attach` · `doctor` · `rebuild` · `config show/init/set/use/path` · `admin project/token`

`doctor` 和 `rebuild` 走的是 Backend 而不是直连数据库，**所以远程模式照样能跑**，一致性校验在 server 上完成。

### 远程不可用（需要本地库 → 退出码 5 `NOT_INIT`）

`export` · `import` · `snapshot` · `compact` · `project list` · `serve`（客户端跑 serve 没意义，serve 自己就是那一端）

⚠️ 错误信息 `未找到看板数据目录（… 没有 .kanban/kanban.db）` 在远程模式下是**误导**——它只说明"本地没库"，
不代表你的看板有问题。看 `agent-kanban config show` 确认模式就能区分。

## 失联回收的时机不一样

- **本地**：每次命令调用都隐式跑一次回收（`openCtx` 里），所以下一条命令就能看到回收结果。
- **远程**：回收在 **server 侧**按 `serve --reap-interval`（默认 30s）跑，跟你的命令无关。

所以远程模式下 agent 崩溃后：

```bash
agent-kanban context
```

**刚跑完还可能看到那张卡"有人在做"**——那是回收定时器还没到。最多等 30s + 失联宽限（默认 10 分钟）再试。
看到 `zombie_sessions` 非空、或卡在 `in_progress` 里但 `stale_holder: true`，就是该接管了。

需要立刻回收又不想到等，可以在 **server 机器**上跑 `agent-kanban doctor --fix`。

## 别在远程目录里跑 agent-kanban init

远程配置好的目录里跑 `agent-kanban init` **不会破坏配置**（它检测到 `mode = "remote"` 就不覆盖 `config.toml`，
还会提示「现有配置是 mode = remote，命令实际会走远程」），但它**会建出一个没人用的本地 `kanban.db`**。

这个"诱饵库"会让后面 `export` 之类的命令不再报 NOT_INIT，而是**静默导出这个空本地库**——比报错更糟。

远程目录里看到 `NOT_INIT` 时，**不要用 `agent-kanban init` 去"修"**，先 `agent-kanban config show` 确认模式。

## 备份与维护要去 server 机器

```bash
# 在 server 机器上（那里才有真库）
agent-kanban export --out /backup/journal
agent-kanban compact --keep-days 30
agent-kanban rebuild --write          # 修投影漂移
```

客户端的 `export` / `import` / `snapshot` / `compact` 一律不可用（见上面的对照表）。
恢复演练、数据库瘦身这类操作都在 server 那侧做。

## 跨机协作

- 事件流是唯一事实源，所以跨机迁移/备份靠 `export` + `import`，不靠拷 `.db`。
- project key 由目录名派生，**跨机不一致**；`import` 默认把事件改写到当前 project 并提示，要保留原 key 加 `--keep-project`。
- `agent-kanban import` / `rebuild --write` 只能在 server 机器做。
- 客户端的 `config.toml` + server 的 project + token 三者要对应上，缺一个就是退出码 7。

## 安全

- **`serve` 默认只绑 `127.0.0.1`，且不终结 TLS。** 跨机访问必须放在 TLS 反向代理（nginx / Ingress / 公司网关）之后，
  否则 **token 明文过网**。
- Docker 里 `KANBAN_BIND` 控制**宿主机侧**绑定地址；容器内永远听 `0.0.0.0`。
- `KANBAN_ADMIN_TOKEN` 必须是 `k_` + 32 位小写 hex，格式错在启动时失败（而不是用到一半才炸）。
- server token 只显示一次，丢了就重新签发一个再吊销旧的。

## MCP 在远程模式

MCP server 用的是**和 CLI 完全相同的配置解析**，所以 `.kanban/config.toml` 里的远程配置对 MCP 一样生效。

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

远程模式下 MCP 的两条额外要求（本地模式没这些问题）：

1. `command` 路径相对于 harness 工作目录，**从项目根目录启动 harness**。
2. `session_id` 仍然必须每次显式传——MCP 走 `kanban_session_start` 拿 id，与 `.kanban/session` 文件无关（两种模式都一样）。

网络抖动时的表现：命令失败会返回 `error.code`（7 = 认证/连接类）。**不要因为一次网络失败就以为租约丢了**——
先 `agent-kanban context` 确认卡的真实状态，再决定是重试还是换卡。
