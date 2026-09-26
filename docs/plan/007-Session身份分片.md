# 007 · Session 身份按 harness key 分片

> 状态：已实施（2026-09-27）。对应看板任务 `T-0005`。
> 实施过程与踩的坑见 [2026-09-27-Session身份分片实施笔记](../note/2026-09-27-Session身份分片实施笔记.md)。

## 一、要解决的问题

改造前，所有 agent 共用 `.kanban/session` **一个文件**存自己的 session id：

```
session start --agent pi-main   →  写 .kanban/session = s-aaaaaa
session start --agent pi-web   →  写 .kanban/session = s-bbbbbb   ← 覆盖了上一个
```

同目录跑两个 agent 时，第二个 `session start` 直接覆盖第一个。此后：

| 现象 | 根因 |
| --- | --- |
| 两个 agent 的 `context` 都显示"没有我的卡" | 两条命令都解析到同一个（最后一个）session id |
| A claim B 的卡**不报错** | `assigneeSessionId === actor.sessionId` 成立 → 当成"自己持有"续租 |
| 冲突信息指向一个不存在的"另一个人" | 只有一个 session，holder 栏显示的是自己 |
| 事件流分不清谁做的 | `events.session_id` 全是同一个值 |

**全程不报错。** 只有等到两张卡互相踩才看得出来——这是最贵的一类 bug。

## 二、为什么不用进程号

| 候选 | 实测结果 | 结论 |
| --- | --- | --- |
| `process.pid` | 同一 shell 内连跑 4 次：`31500 / 71872 / 68744 / 62996` | ❌ CLI 每次调用都是新进程，pid 每次都变。schema 里存了 `pid`，但注释自己写明"诊断用（存活探测仅作提示，不作判据）" |
| `process.ppid` | 同一 shell 内 4 次全等 `70712`；另一轮 A/B 全等 `31564`；**跨 shell 变成 `57976 / 70712 / 31564`** | ⚠️ 只在"同一个交互式 shell"内稳定 |
| tty 设备名 | Windows 上 bun 拿不到 `/dev/pts/*` | ❌ 仅 Unix 可用 |
| harness 会话变量 | `PI_SESSION_ID=01a0debe-…`，与 `PI_SESSION_FILE` 同名 | ✅ harness 生成的 UUID，子进程继承 |

### 为什么 ppid 连兜底都不做

`ppid` 是**发起命令的那个 shell**。人坐在终端里手敲时它几小时不变，很好用。但 agent 不手敲：
本项目自己的 harness 每条命令起一个新 `pwsh`，实测三次调用拿到三个不同 ppid。

按 ppid 自动登记的结果是**每条命令都认出一个新身份**：造出一堆野会话，租约永远互相看不见，
每次 `context` 都是空的新人。**比现在共用一个文件更糟**，所以不做。

（pid 复用的窗口也不必提了：既然主路径不成立，那点残留风险不值得再论证。）

## 三、方案

用 harness 自己注入的**每会话唯一**环境变量当 identity key，一个 key 一个文件。

### 3.1 key 的来源与优先级

三级，**先具体后通用**：

```
1. KANBAN_SESSION_KEY           显式。给未列入表的 harness 的逃生口
2. 已核实的表（按声明顺序）
     pi          PI_SESSION_ID           id
     oh-my-pi    PI_SESSION_FILE         路径 → 只取文件名
     claude-code CLAUDE_CODE_SESSION_ID  id
     grok        GROK_SESSION_ID         id
     codex       CODEX_SESSION_ID        id（root session，**不是** thread）
3. 自动发现：唯一/最靠前的 <TOOL>_SESSION_ID
4. 都没有 → 解析失败，退回旧单文件
```

每一项都是**挖二进制或读官方源码**核实的；完整核实步骤与本机结果见文末
[附：核实一个新 harness](#附核实一个新-harness的环境变量)。

**已核实、确实没有可用变量的：cursor-agent**（只有 `CURSOR_AGENT_SOCKET` 这类进程级变量）
→ 需手动 `KANBAN_SESSION_KEY`。

> ⚠️ 加新 harness 前照这个办法**核实**，别写"听起来像"的名字：写错了不会报错，
> 只是那个变量永远不存在，分流静默失效。

#### 表里的顺序有意义

`pi` 同时也设置 `PI_SESSION_FILE`（oh-my-pi 用的那个变量），所以 pi 必须排在 oh-my-pi 前面，
否则在 pi 里跑会顶着 oh-my-pi 的身份。

#### 身份粒度不能比 agent 本身更细

codex 后来又加了 `CODEX_THREAD_ID`（PR #10096，2026-02-03 合入 main），但本实现**故意不用它**，
用更粗的 `CODEX_SESSION_ID`（root session）。

理由：一个 codex agent 内部的并行 thread 是**同一个 agent**，应该共用一个看板身份。
按 thread 分片，一个 codex agent 起 3 个并行 thread 就会变成 3 个"不同 agent"，
互相抢同一批卡、互相报 CONFLICT。**身份要按"一次 agent 会话"切。**

#### 自动发现的代价

第 3 级让"其它 harness"真正变成开放的：以后任何导出 `<TOOL>_SESSION_ID` 的工具直接可用，
codex 将来改名也不用改代码。代价是可能**选错**（→ 两个 agent 共用一个 key，
也就是这次刚修掉的那个静默 bug），所以：

- 排除名单认真维护（终端/遥测/API 层的同名变量，实测名单见 `paths.ts`）
- 多个候选时**按变量名排序**取第一个，不能按 env 枚举顺序（那会让同一台机器两次调用
  可能给出不同身份，比选错更糟）
- `session start` 会把选中的 key 打印出来，**选错了一眼能看见**

### 3.2 文件名

`<.kanban>/sessions/<key>`，key 形如 `pi-01a0debe-ca55-752e-895f-c20eb141ac19`。

- 常见值（UUID、短 id）**原样保留**，文件名能被人一眼认出是哪个 agent
- 含非法字符或超长 → 清洗 + FNV-1a 哈希后缀。因为 `"a/b"` 与 `"a\\b"` 清洗后都是 `a_b`，
  不加哈希就会**静默共用身份**，正是这次要消灭的那类 bug
- 合法字符集刻意**不含点**：否则能拼出 `..` / `...` 这类怪文件名
- **路径型变量（`kind: "path"`）只取 basename，且一律补哈希**。以 oh-my-pi 为例，
  真实文件名是 `~/.omp/agent/sessions/<项目目录>/2026-08-09T08-33-15-322Z_<uuid>.jsonl`
  ——目录段对同目录并行的每个 agent 完全相同，只有 basename 有区分度

### 3.3 读：key 解析得出来时，绝不回退旧单文件

```
key 可解析  → 只读 .kanban/sessions/<key>，没有就是 null
key 不可解析 → 读 .kanban/session（改造前的行为，逐字不变）
```

理由：A、B 同目录，A 先 `session start`。B 从没注册过。若允许 B 读旧单文件，
B 就会以 A 的身份操作看板——**正是这次要消灭的静默串号**。

B 的 key 明明解析得出来（它是另一个真实的 agent），所以让它**大声报错**（退出码 1），
提示里直接给出 `session start` 这条修复动作，比让它安静地冒充 A 强得多。

### 3.4 写：只写一个地方，取决于 key

- **有 key** → 只写分片，**绝不碰旧单文件**。若此时还顺手写旧单文件，
  同目录里没 key 的进程就会读到它、以这个身份操作看板——**等于在新机制旁边留了个冒充后门**。
- **无 key** → 退回旧单文件，行为不变。

代价：keyful 与 keyless 混用时，keyless 侧会**明确报错**（而不是冒充）。这是有意的取舍：
宁可退出码 1，不要静默写错人。

### 3.5 只读命令不硬报错，但要**说清楚**

`agent-kanban context` 是协议里要求 agent 跑的第一条命令。没注册身份时如果硬报错，
等于拒绝服务；但如果静默继续，看板会**说谎**：自己的卡被列进 "Other sessions in progress"。

所以 `context` 在顶部打一行警告：

```
⚠ not registered as a session  (identity key: pi-01a0debe-…)
  Your own cards will show up under "Other sessions" until you register.
  Fix: agent-kanban session start --agent <name> --harness <harness>
```

JSON / Op 契约**不动**（web 的 `api.ts` 也消费 `context.get`，不跨界改契约）。
用 `--json` 的 agent 会在第一条身份相关命令上撞到退出码 1 与同样的提示，能自愈。

### 3.6 清理：30 天 TTL

key 来自 harness 的会话 UUID，**每开一个 agent 会话就多一个文件**。本项目自己 dogfood 时
一天能开十几个会话，不清理的话 `.kanban/sessions/` 会无声地长到几千个文件。

判据是文件 mtime（= `session start` 时刻），TTL 取 30 天：比任何合理的失联宽限
（默认 10 分钟）长三个数量级——30 天没敲过命令的 agent，它的 session 早被僵尸回收判成
crashed 了（卡也早回到 todo、进度保留），那份身份文件留着没用，删掉与看板自身语义一致。

只在 `session start` 时清理（写新身份的那一刻顺手收拾）。**读路径不做任何清理**：
读路径一旦有副作用，测试和并发推理都会变麻烦。

## 四、身份解析的完整优先级

```
--session s-xxx        显式，最高
KANBAN_SESSION=s-xxx   次之
.kanban/sessions/<key> 由 key 决定读哪个分片
.kanban/session        仅当 key 解析不出来
都没有                 退出码 1 + 可操作提示（不自动建"野会话"）
```

MCP 路径不需要这套：`server.ts` 是长驻进程，`session_start` 由 agent 主动调，
之后每个 tool call 显式带 `session_id`，本来就没有"共用一个文件"的问题。

## 五、顺带修掉的一个静默 bug（先于本次改动存在）

`openCtx` 的优先级链原本写成：

```ts
process.env.KANBAN_SESSION ?? readSessionFile(dir) ?? null
```

看上去等价，实际上不是：`KANBAN_SESSION=`（shell 里给变量赋空，最常见的"取消设置"写法）
**不是 nullish**，`??` 会让它直接胜出，于是 `sessionId` 变成空串——身份文件被忽略、
事件流记成空 `session_id`、所有 `claim` 都以空身份互相续租。

症状同样是静默的：两个 agent 抢同一张卡不报错、看板 holder 栏空白。

README 早就声明了"An empty environment variable counts as *unset*"，
**这次是把代码兑现到已声明的约定**，而不是引入新约定。修法是三处都判非空字符串
（`pickSessionId`），与 `resolveSessionKey` 对空值的处理一致。

## 六、测试

`test/session-identity.test.ts`（46 个用例），四层：

1. **key 解析**（纯函数，8 条）：前缀、空串、空白、清洗后不撞、超长不撞、点号不可用
2. **其它 harness**（9 条）：grok / claude-code / codex / deepseek-harness /
   oh-my-pi（路径取 basename、同名文件不撞）/ pi 优先于 oh-my-pi 的顺序 /
   codex thread-vs-session 的粒度选择
3. **自动发现**（7 条）：收编未列入表的工具、排除终端/遥测/API 层变量、
   多候选取序与 env 枚举顺序无关、表里永远压过发现、长度过滤、形状不误匹配
4. **文件读写 + 端到端**（22 条）：两条"绝不能"（换 key 读不到上一个人的身份、
   旧单文件在也不回退）、写侧"有 key 不写旧单文件"、同目录两个**不同 harness**（pi + grok）
   的真进程各认各的、A 抢 B 得退出码 3 且 `holder.agent_name === "agent-b"`、
   未注册的 key 退出码 1、无 key 进程不冒充任何人、空 `KANBAN_SESSION` 回归

## 七、已知边界

- **cursor-agent 走不到自动分流**，需手动 `KANBAN_SESSION_KEY`
- **嵌套 harness 会命中外层的变量**：在外层 pi 里起内层 grok，env 里两个变量都有，
  按表顺序 pi 先命中。env 层面无法区分谁设置的。用 `KANBAN_SESSION_KEY` 显式覆盖。
- **自动发现可能选错**（→ 两个 agent 共用一个 key）。排除名单 + 排序取一 + 打印 key
  三道缓解，但本质上这是启发式。选错时 `session start` 输出的 `identity` 行会露馅。
- **旧版 CLI 二进制**只认 `.kanban/session`，与新版共存时会因缺该文件报
  "missing session id"，跑一次旧版 `session start` 即可自愈
- **升级后的第一次命令会报一次错**（提示里给了修复动作），重注册安全：
  旧会话过宽限判 crashed，它手里的卡回 todo 且进度与 checklist 保留。
  变量名变化（如 codex 将来换变量）也属于这一类：key 变了就得重新注册一次。
- **`session end` 不删身份文件**。已关闭的 session id 仍可被读到——这是改造前就有的
  毛刺，本次不顺手改（会让"结束后误操作"从静默变成报错，属于另一个决定）

## 附：核实一个新 harness 的环境变量

**不要凭印象写变量名。** 写错了不会报错，只是那个变量永远不存在。

```powershell
# 1. 找到真正的可执行文件（scoop 的 shim 只是转发壳）
Get-Content D:\Library\scoop\shims\<name>.shim | Select-String 'path\s*='

# 2. 宽松正则列候选（**不要** Select-Object -First N 截断）
rg -a -o -N --no-filename '\b[A-Z][A-Z0-9_]{2,28}_SESSION_ID\b' <exe> | Sort-Object -Unique
rg -a -o -N --no-filename '\b<NAME>_[A-Z0-9_]{2,40}\b' <exe> | Sort-Object -Unique

# 3. 用 --fixed-strings 逐个确认（带 \b 的正则会漏，见下）
rg -a -c --fixed-strings 'CODEX_SESSION_ID' <exe>

# 4. dump 命中处上下文，看它是“注入给子进程的 env”还是只是错误串常量
```

**本机结果（2026-09-27，`bun 1.4.2` / Windows）：**

| 工具 | 变量 | 证据 |
| --- | --- | --- |
| pi | `PI_SESSION_ID`、`PI_SESSION_FILE` | 本机 env 实测 |
| oh-my-pi (`omp`) | `PI_SESSION_FILE`（**路径**） | dump 到构造子进程 env 的那段代码 |
| claude-code | `CLAUDE_CODE_SESSION_ID`、`CLAUDE_SESSION_ID` | 二进制字符串 |
| grok | `GROK_SESSION_ID` | 与 `GROK_HOOK_EVENT` / `GROK_HOOK_NAME` / `GROK_WORKSPACE_ROOT` 同一组 env |
| codex | `CODEX_SESSION_ID`（新版另有 `CODEX_THREAD_ID`） | 官方 `codex-rs/core/src/exec_env.rs` 的 `inject_session_env` |
| DeepSeek Harness | `DSH_SESSION_ID` | 本地 checkout 的 `packages/shell/shell-env/src/index.ts` |
| cursor-agent | ❌ 无 | 只有 `CURSOR_AGENT_SOCKET` 这类进程级变量 |

**有源码时直接读源码，别信搜索摘要。** DeepSeek Harness 的网页搜索摘要还在推荐
`DSH_SESSION_JSONL`，而仓库里的决策笔记（`.agents/notes/archived/simplification/2026-08-27-*.md`）
明确写着该变量**已移除**（理由：默认产物是 `.jsonl.zstd`，bash 根本读不了）。
环境变量这种事实，搜索摘要会过期，源码不会。

### 两条“变量存在 ≠ 一直有”的前提

- **DeepSeek Harness 只给 agent 发起的 shell 调用注入 `DSH_SESSION_ID`**
  （源码里是 `if (execution.agent !== undefined)`）。人手动敲的 shell 里没有它，会退回旧单文件。
  好消息是它的 shell 执行器**每次都丢弃继承的 `DSH_*`** 再合并当前快照，
  源码注释明说是为了让“嵌套 harness 与并发的父子 agent 无法泄露陈旧身份”——对我们正好。
- **codex 的 `CODEX_THREAD_ID` 只在新版有**（本机 0.157.1 只有 `CODEX_SESSION_ID`）。
  表里选 `CODEX_SESSION_ID` 也正好避开这个版本差异。

### 扫描方法本身的三个坑

1. **带 `\b` 的正则会漏。** Rust 编译出的 rodata 里字符串是**紧挨着排的**（无 NUL 分隔），
   前一个字符串的末尾字母会让下一个的 `\b` 判定失败。实测 `CODEX_SESSION_ID`
   用 `--fixed-strings` 数出 1 处，带 `\b` 的正则清单里**完全不出现**。
   → 先用宽松正则列候选，再用 `--fixed-strings` 确认，最后 dump 上下文。
2. **别截断清单。** 用 `Select-Object -First 30` 看 `CODEX_*` 时，清单看起来完整，
   于是得出了"codex 没有会话变量"的**错误结论**——被截掉的那一条正是 `CODEX_SESSION_ID`。
3. **翻二进制找不到就查官方源码。** codex 那个变量是先翻二进制没找到、
   后读 `codex-rs/core/src/exec_env.rs` 才确认的。两条路都要走。
