# 建议区漏出中文：`next_actions` 结构化（2026-09-26）

问题：英文界面下右侧栏「建议接下来 / Suggested next」那两行是中文
（截图里是「有 1 张卡阻塞中（可能需要人介入）：T-0013」和「认领新任务：agent-kanban task claim …」）。

## 改了什么

| 文件 | 动作 |
| --- | --- |
| `src/core/context.ts` | 新增 `NextActionCode` / `NextActionArgs` / `NextActionItem`；`buildNextActions` 改为**只产出结构化条目**，`renderNextAction(item)` 负责渲染中文串；`RecoveryContext` 多一个 `next_action_items` |
| `web/src/lib/api.ts` | `RecoveryContext.next_action_items?`（可选，老服务端不发）+ `NextActionCode` 联合类型 |
| `web/src/lib/next-actions.ts` | **新增**：`keyFor(item)`（代号 → 词典键，`never` 穷尽检查）+ `localizedNextActions(ctx, t)`（含三条降级路径） |
| `web/src/lib/i18n.tsx` | 新增 10 键 × 2 语言（`sidebar.next.*`） |
| `web/src/components/board.tsx` | 侧栏改用 `localizedNextActions(context, t)`；**顺手修**：`reload` 里 `fetchContext` 的结果被丢掉了（`setContext((c) => c)`），侧栏永远停在首次进页面时的快照 |
| `test/recovery.test.ts` | 断言 `next_actions === next_action_items.map(renderNextAction)` |
| `test/web-i18n.test.ts` | **新增**：代号两侧对齐、zh/en 都有词条、英文词条无中文、渲染行为、三条降级路径 |
| `test/web-contract.test.ts` | 组件层不得再出现 `.next_actions`（`lib/api.ts` 读 `env.next_actions` 解析包络不算） |
| `scripts/verify-web-ui.ts` | 浏览器里断言两种语言下建议区各说各的话 |

## 为什么不走另外两条路

### 1. 前端词典里给每条中文串配英文译法 ❌

会多出**第二份真相**：后端改了措辞（比如"接管"→"接手"），词典不会跟着改，
英文界面会安静地显示过时旧句——没有任何报错，而且中文界面是新的、英文是旧的，
比"两边都是中文"更难排查。

### 2. 前端从 `ready` / `blocked` / `zombie_sessions` 自己重推建议 ❌

数据是齐的（`context.get` 把这些都发了），但**排序规则**是业务逻辑：
"先接别人留下的烂摊子 → 再做自己手上的活 → 最后领新活"（`buildNextActions` 的注释里
写明了这个排序依据）。复制一份到前端，两处必然漂移，而且没有任何测试能发现。
与 ADR-6（逻辑全在 core，客户端是薄封装）也不合。

### 3. 后端多发一份结构化数据 ✅

`buildNextActions` 只产出 `{ code, args }`，中文串由 `renderNextAction` 从**同一份**数据渲染。
于是：

- agent 侧一个字都没变——CLI / MCP / `--json` 拿到的仍是那串中文；
- 界面侧按 `code` 选词典条目，参数里的标点由界面拼（中文顿号、英文逗号）；
- 两份形态不可能漂移（有测试钉住）。

## 几个具体决定

**`code` 是契约，穷尽性靠 `never`。** 前端 `keyFor` 的 `default` 分支同时干两件事：
给 `tsc` 一个"后端加代号我漏了分支"的编译错误，给运行时一个"前端旧 + 服务端新"
的降级（返回 `null` → 退回后端中文串，而不是崩掉）。

**数组参数的标点归界面。** `args.tasks` 用 `t("list.sep")` 拼（顿号/逗号+空格），
`args.commands` 用 `" / "` 拼——斜杠两边都是代码，不属于任何一种语言。
后端不写死标点，是这个设计能同时服务两种语言的前提。

**单复数拆两条键。** `sidebar.next.blocked.one` / `.many`（`crash_handoffs` 同），
沿用 i18n 词典里既有的约定（不做 ICU 复数语法）。`n === 1` 选 `.one`，
这也是测试里唯一按数量分支的地方。

**交接摘要不翻译。** `read_handoff` 的 `summary` 原样透传——那是上一个 agent 写的
内容。英文界面里出现中文是**对的**。所以 `verify:web:ui` 的断言只查 chrome 模板
（"认领新任务"/"张卡阻塞"…），不是"整段无中文"。

**`next_action_items` 是可选字段。** 前端连老服务端也能跑（退回中文串），
所以 npm 上的旧 `web/dist` 配新后端、或反过来，都不会出现空白面板。

## 踩到的坑

**在根测试里静态 import web 源码会把 `web/` 拖进根 `tsc`。**
`test/web-i18n.test.ts` 需要真的跑 `web/src/lib/next-actions.ts` 的逻辑，
但根 `tsconfig.json` 的 `include` 有 `test/**/*.ts`，于是 `api.ts` / `i18n.tsx`
跟着进了根程序，报一串 `Cannot use JSX unless the '--jsx' flag is provided` 和
`Cannot find name 'window'`。

解法不是加 `exclude`（`exclude` 只管 `include` 的通配，import 照样把文件拉进来），
而是**变量形式的 specifier**：

```ts
const specifier = "../web/src/lib/next-actions.ts";
const mod = (await import(specifier)) as { localizedNextActions: ... };
```

类型检查器不解析它（模块是 `any`，自己声明需要的形状），bun 运行时照常解析。
于是类型归 `bun run web:typecheck`、行为归 `bun test`，两边各管一段，
和项目里"web 前端不在根 tsc 编译范围"这个既有事实是一致的。

**`bun run web:build` 会覆盖 `src/server/assets.generated.ts`。**
004 计划里记过：跑完要 `git checkout HEAD -- src/server/assets.generated.ts`，
否则 `verify:deploy` 会红。

## 验证

- `bun test`：新增 11 条，全绿。
- `bunx tsc --noEmit` / `bun run web:typecheck`：均 0 错误。
- `bun run verify:web:ui`：中文侧断言「认领新任务/张卡阻塞…」存在，
  英文侧断言这些模板**一个都不出现**，且出现 `Claim new work` 之类英文文案。
