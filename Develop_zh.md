# 开发 agent-kanban

[English](Develop.md) · [中文](Develop_zh.md) · [用户指南](README_zh.md) · [User guide](README.md)

架构、构建、发布，以及验证工具链。

---

## 技术栈

| 部分 | 选型 | 原因 |
|---|---|---|
| 运行时 | Bun ≥ 1.4.2 | 直接编译 TypeScript；`bun build --compile` 产出独立二进制 |
| 语言 | TypeScript（strict） | — |
| 存储 | SQLite / WAL 模式 | 单文件、无守护进程，`docker stop` 之后数据还在 |
| HTTP | Bun.serve | 不引框架；接口面小到能一口气读完 |
| 前端 | React 19 + Vite + Tailwind v4 + shadcn/ui | — |
| 测试 | `bun test` | — |

## 目录结构

```
src/
  cli.ts              命令路由、全局选项提取、错误 → 退出码映射
  commands/           参数解析 → 构造 Op → 调 Backend → 格式化输出
    context.ts        openCtx / closeCtx / resolveSessionId  （不是恢复命令）
    recovery.ts       `context` / `resume` / `doctor` 三个命令
  core/               全部业务逻辑——本地与远程后端共用
    schema.sql        整个数据库定义
    db.ts             连接、迁移、BEGIN IMMEDIATE 辅助
    tasks.ts          状态机、租约、依赖就绪判定
    handoff.ts        交接的创建与消费
    plans.ts          计划版本化
    rebuild.ts        事件重放与漂移检测
    ops.ts            Op 协议（唯一的写入面）
    backend.ts        本地 Backend
    backend-remote.ts HTTP Backend
  server/
    http.ts           路由、鉴权、SSE、静态资源
    admin-page.ts     自包含的 /admin HTML
    assets.generated.ts   内嵌前端清单（**已提交**，见下文）
  types/assets.d.ts  内嵌文件的模块声明
web/                  独立的 Vite 应用；`bun --cwd web`
scripts/              验证与构建辅助脚本
test/                 bun test 测试套件
docs/plan/            设计文档
docs/note/            实施记录与踩坑笔记
```

### 分层规则

`cli.ts` 负责路由，`commands/` 负责解析与格式化，`core/` 干活。`core/` 以下的一切都不知道自己是在读写本地文件还是在发 HTTP。

这就是本地模式与远程模式行为一致的原因。它是结构性保证，不靠谁来自觉遵守。

**注意：** `src/commands/context.ts` 是连接/会话上下文辅助模块；`src/commands/recovery.ts` 才是实现 `kanban context` 的命令文件。两者无关，命名容易误导。

### 前端文案约定（i18n）

看板 `web/` 与管理页 `/admin` 都支持中英双语，**共用同一套约定**与同一个
`localStorage` 键 `kanban.locale`（同 origin 不该有两套语言状态）。

`web/src/lib/i18n.tsx` 是看板侧的**唯一**文案入口，三条硬规则：

1. **组件里不准写中文字面量。** 界面文案一律 `const { t } = useI18n()` 后 `t("board.newTask")`；需要传给 `web/src/lib/status.ts` 这类纯函数时，把 `t` 本身传下去（`canMove(from, to, t)`、`relativeTime(ts, t)`）。
2. **`zh` 是键的唯一来源**，`en` 被声明为 `Record<MessageKey, string>`。少翻一条就是 `tsc` 报错，而不是上线后英文界面里某个按钮突然变成一串 key。**别把它改成 `satisfies`——那不是穷尽检查。**
3. **代码注释用中文，界面文案用词典。** `web/src/**/*.tsx` 里剩下的中文字符只应该出现在注释中——`rg '[\x{4e00}-\x{9fff}]' web/src` 出现新的一行，就是漏翻。

`web/src/lib/status.ts` 不引 React，只接收一个绑定好 locale 的 `t`，所以它依然可以脱离界面单测。`web/src/lib/api.ts` 同样是纯请求层，用 `tActive()`（`i18n.tsx` 里的模块级翻译函数）翻译自己的错误文案。

管理页 `src/server/admin-page.ts` 是模板字符串，没有类型层的穷尽检查：静态文案用 `data-i18n` / `data-i18n-ph` 标记后统一刷，动态文案走内联 `t()`。

界面语言由后端下发的**数据**（任务标题、交接正文、`next_actions`）不翻译——那是内容，不是 chrome。唯一例外是会话心跳：后端 `sessionToJson` 同时给了 `last_seen_at`（毫秒时间戳），前端用它自己格式化，不直接用后端那个中文串 `fresh`。

新增语言：看板往 `LOCALES` 加一项、给 `HTML_LANG` / `LOCALE_NAME` 补值、写一份同键的词典（类型会告诉你还差哪些键）；管理页补一份 `DICT.<lang>`。

> ⚠ 改 `src/server/admin-page.ts` 里的内联 JS 时，反斜杠与反引号要当作"多了一层转义"来审：模板字符串会先吃掉一层（`\w` → `w`，正则会静默失效；反引号会直接终止模板字符串）。插值用的是 `split`/`join` 而不是正则，就是为了避开这个坑。

## 数据模型

**事件是事实来源。** 每次变更都往 `events` 追加一条；`tasks`、`plans`、`handoffs`、`task_deps` 是投影。如果你给投影加了字段，就必须同时在对应事件里发出足够的 payload，否则 `rebuild` 会报漂移。

**每个业务表都带 project_key。** project 隔离由 schema 保证，不靠应用层。任务 ID 在 project 内唯一（每个 project 都从 `T-0001` 开始）。session 保持全局，因为一个 agent 可以跨 project 工作。

**归属是租约。** `tasks.owner_session_id` 加 `lease_expires_at`。回收过期租约时保留进度和检查项，只把归属换掉。

**交接分两种。** 主动交接（agent 收工前写的）和崩溃自动生成的。`resume` 优先用主动交接；崩溃版只是兜底，而且一定会写明"原持有者失联"。存在主动交接时，其他 session **即使在租约未过期时也能接管**，因为写交接就意味着让位。“让位”包括交接尚未被消费、**以及已被当前这个 session 消费过**两种情况——否则 MCP 的标准流程（`bootstrap` 先消费、再 `resume`）会卡在 CONFLICT，把 agent 逼去用 `force`。

**一律用 `BEGIN IMMEDIATE`。** 写事务一开始就拿写锁，避开中途升级，这能防住租约回收协程与正常流量之间的 `SQLITE_BUSY` 死锁。

## 环境准备

```bash
bun install
cd web && bun install && cd ..

bun run verify:all    # 13 道门禁全跑一遍，带汇总
bun run web:dev      # Vite 在 :5173
bun run serve        # 后端 + 已构建前端在 :7788
```

`serve` 需要 `web/dist` 存在才有界面；没有的话会返回一个占位页，提示你去构建。

## 构建

```bash
bun run web:build      # vite build，然后 gen:assets
bun build --compile src/cli.ts --outfile dist/kanban
```

或者一条命令：

```bash
bun run build:binary
```

### 顺序不可省略

`web:build` 必须在 `bun build --compile` 之前，`gen:assets` 必须在两者之间：

```
vite build  →  gen:assets  →  bun build --compile
```

`gen:assets` 扫描 `web/dist`，为每个资源写一条静态的 `import ... with { type: "file" }` 到 `src/server/assets.generated.ts`。之所以要这么做，是因为 Bun 的内嵌文件 import 必须是字面量路径，而 Vite 产出的文件名带内容哈希，构建前不可知。

**跳过 `gen:assets` 依然会编译成功。** 你会得到一个不含 Web 界面的二进制，`/` 静默返回占位页。`web:build` 已经帮你接上了这一步；如果你直接调 `vite build`，要自己补。

### `src/server/assets.generated.ts` 是入库的

是的，一个生成文件在版本控制里。它以**空表占位**形态提交，因为 `http.ts` 静态 import 它，而干净 checkout（CI、新机器）里既没有 `web/dist` 也没人跑过生成脚本。少了它，`tsc --noEmit` 会在前端构建**之前**就报 TS2307。

`web:build` 之后它会被改写成真实清单，并显示为 modified——这是预期的，不要提交构建后的版本。

同样的道理适用于 `schema.sql` 和 `package.json`，但它们内嵌的理由不同：编译出来的二进制必须在没有任何源码目录的情况下可用。

## 测试

```bash
bun test                    # 97 个测试
bunx tsc --noEmit           # 后端
cd web && bun run typecheck # 前端
```

### 验证脚本

单测覆盖逻辑。下面这些脚本会真起 server、真起子进程、对真 HTTP 做断言，抓的是只在跨进程、跨环境时才暴露的问题。

| 脚本 | 它证明了什么 |
|---|---|
| `verify-web.ts` | 静态资源、SPA 回退、路径穿越、API、鉴权、SSE、缓存头、**任务详情 Op 契约** |
| `verify-web-ui.ts` | 无头 Chrome **真点开一张卡**：详情抽屉能开、三个页签有数据、无运行时异常 |
| `verify-binary.ts` | 编译出的二进制确实是自包含的 |
| `verify-deploy.ts` | Dockerfile、compose、`.env` 的结构正确 |
| `verify-deps.ts` | 没有未声明的（幽灵）依赖 |
| `verify-workflows.ts` | workflow 文件可解析且保留必要结构 |
| `verify-docs.ts` | 文档与代码一致：退出码、环境变量、选项、命令名、脚本名 |
| `verify-auth.ts` | token 权限范围与 project 隔离 |
| `verify-remote.ts` | 本地与远程后端行为一致 |
| `verify-recovery.ts` | 租约过期、交接、`context`、`resume`、`doctor` |
| `verify-rebuild.ts` | 故意破坏投影，再用单个事务修回来 |
| `verify-mcp.ts` | MCP server 走真 stdio JSON-RPC，跑契约 §3.4 的恢复流程 |
| `verify-backup.ts` | export → import 在另一台机器上无损恢复 |
| `verify-all.ts` | 把上面所有门禁跑一遍，用汇总回答“还有哪里红” |

```bash
bun run verify:web
bun run verify:web:ui   # 需要本机有 Chrome/Edge，没有则跳过
bun run verify:deps
bun run verify:workflows
bun run verify:docs
bun run verify:deploy
bun run verify:mcp
bun run verify:backup
bun run verify:all    # 全跑一遍，带汇总
```

文档腐烂是**无声的**。改了个命令名或重新分配了退出码，运行时不会报任何错，只会让文档悄悄变错，而没人会读第二遍。`verify-docs.ts` 把四份文档里的断言拿去和源码逐一对比：每个退出码、环境变量、全局选项、顶层命令、npm script，以及引用到的文件路径。

## 文档约定

- `README.md` / `README_zh.md` 面向**使用者**：功能、解决什么问题、怎么部署和配置。默认展示英文（`README.md`），中文版在 `README_zh.md`。
- `Develop.md` / `Develop_zh.md` 面向**开发者**：架构、构建、发布、验证工具链。
- 四份文档顶部互相链，用户可以随时切换语言。

## 测试与 SQLite

涉及租约过期的测试依赖真实时间，因此是串行执行的（`bunfig.toml` 关掉了 coverage，测试套件也刻意避开了墙钟竞争）。不要用"并行化"来加速慢测试。

## 发布

由 tag 驱动。推 `vX.Y.Z` 后，workflow 会：

1. 断言 tag 与 `package.json.version` 一致。版本号只有一个来源
2. 跑类型检查、测试和端到端脚本
3. 为 5 个平台编译自包含二进制，并在**目标平台上**逐个冒烟（arm64 走 QEMU，因为 arm64 二进制无法在 x64 runner 上运行）
4. 构建并推送 `linux/amd64` + `linux/arm64` 镜像到 GHCR 与 Docker Hub
5. 创建 GitHub Release，附上二进制与 SHA-256 校验和

**打第一个 tag 之前：** 确认 `package.json.version`，跑完上面所有验证脚本，确认 `web/dist` 能构建。版本一致性是硬门禁，不一致会让整个流程失败。

## 部署形态

一个部署一个 `kanban serve` 进程，内部管多个 project，各自用 project key 和受限 token 隔离。

```bash
cp .env.example .env      # 填 KANBAN_ADMIN_TOKEN（openssl rand -hex 16）
docker compose up -d
docker compose exec kanban kanban admin project add my-app
```

- **compose 里没有反向代理，也没有 TLS。** 多数部署背后已经有 HTTPS。为此再加一个要续期证书的容器，等于引入一个新的故障模式（证书过期 → 全面不可用），而多数用户不需要。`KANBAN_BIND` 默认 `127.0.0.1`，暴露要显式决定。
- **没有 TLS 的话，token 是明文传输的。** 这是整套设计里唯一的真实风险，所以它同时写在 README、`.env.example` 和 compose 注释里。不要在超出 localhost 的范围暴露时不配 TLS 终止。
- **没有 bootstrap 服务。** 建 project 和签 token 是两条命令，不值得为此做一个自带状态、健康检查和幂等语义的一次性容器。
- **Docker 镜像不编译二进制。** `bun build --compile` 会把一份 Bun 运行时链进产物；而基于 `oven/bun` 的镜像本来就有一份。直接跑源码意味着只有一份运行时、更小的镜像，也没有会悄悄过期的构建步骤。

## 设计文档

- `docs/plan/001-总体设计.md` —— 架构、数据模型、ADR
- `docs/plan/002-接口契约.md` —— HTTP API、Op 协议、退出码、Web 主题令牌
- `docs/plan/003-实施计划.md` —— 里程碑与状态
- `docs/note/` —— 分功能的实施记录；在动同一块代码之前，值得先读里面的踩坑笔记
