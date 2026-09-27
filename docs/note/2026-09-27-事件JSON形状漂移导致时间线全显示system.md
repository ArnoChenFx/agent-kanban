# 2026-09-27 任务时间线全显示 system：事件 JSON 形状漂移

## 现象

用户截图报：任意任务详情抽屉的「时间线」页签里，每一条事件后面的署名都是
`system`——`刚刚 · system`、`13h 前 · system` 全部如此。

## 定位（一半靠猜，一半靠查库）

第一反应是"写入时丢了 session"：库里 `session_id` 真为 `'system'` 或 `NULL` 的
事件有好几条（`board_exported`、`task_reclaimed`、`handoff_created`），
而且前端正是 `e.session_id ?? "system"`，看起来完美吻合。

**先查库把它推翻**。`T-0002` 的 6 条事件：

| seq | type | session_id |
| --- | --- | --- |
| 146 | `task_claimed` | `s-t51c0o` |
| 83 / 82 | `task_unblocked` / `task_blocked` | `s-u87d6n` |
| 12 / 11 / 4 | `task_unblocked` / `task_blocked` / `task_created` | `s-5hywvz` |

数据库里**没有一条是 system**，六个值分属三个真实会话。数据是对的。

## 断点：`KanbanEvent` 是驼峰，对外契约是 snake_case

起 server 打 `POST /api/op` 的 `events.tail`：

```
seq=146 type=task_claimed session_id='' sessionId='s-t51c0o'
keys=seq,ts,sessionId,type,taskId,planId,projectKey,data
```

返回的是**驼峰**。而前端 `web/src/lib/types.ts` 的 `KanbanEvent` 声明为 snake_case，
`web/src/components/task-detail.tsx` 读 `e.session_id` → 恒 `undefined` →
`?? "system"` → 全员 system。

`src/core/rows.ts` 的文件头写着"JSON 输出又必须回到 snake_case（agent 脚本和
前端 jq 在用，契约 §6）。三处转换集中在这里，改一处不会漏另两处"——
**三处里的第三处（事件）压根没写**。只有 `taskToJson`（@225）与
`sessionToJson`（@251），没有 `eventToJson`。于是四个出口全都把领域对象
直接 `JSON.stringify`：

| 出口 | 位置 | 当时的写法 |
| --- | --- | --- |
| `task.get` 的 `timeline` | `ops.ts:370` | `.map((e) => e)` |
| `events.list` | `ops.ts:658` | `rows.map((r) => toEvent(r))` |
| `events.tail` | `ops.ts:663` | `events.map((e) => e)` |
| `/api/events` | `http.ts:343` | `rows.map((r) => toEvent(r))` |
| SSE `/api/stream` | `http.ts:680` | `JSON.stringify(event)` |

`context.get` 的 `zombie_sessions` 逃过一劫——那是手写 snake_case 字面量，
不是走 `toEvent`。这也解释了为什么**只有时间线这一处露馅**。

## 修复

1. `rows.ts` 新增 `eventToJson`（snake_case，与 `taskToJson` / `sessionToJson`
   同风格）。`data` 是普通 JSON，原样透传，不做键名转换。
2. 上述五个出口全部改走它。SSE 里游标改用 `row.seq`（与领域对象同一个值），
   避免从 `Record<string, unknown>` 里取 `seq` 时的类型噪音。
3. MCP 自动受益：`kanban_task_get` 走的就是 `task.get` + `timeline=true`。

## 守卫（两层，且都做了反向验证）

### 1. `test/web-contract.test.ts` 新增 describe「事件字段形状」

- **行为**：`events.tail` / `events.list` / `task.get` 的 `timeline` /
  `/api/events` 四条路都断言：无驼峰键、八个 snake_case 字段齐全、
  `session_id` 是 `s-aaaaaa` 而不是 undefined
- **静态对账**：把前端 `types.ts` 声明的 `KanbanEvent` 字段逐个拿去
  `rows.ts` 的 `eventToJson` 函数体里查——前端声明了但后端不产出的字段列出来
  （前端不在根 tsc 范围，没有编译期校验，只能这么对账）
- **防回退**：扫 `ops.ts` / `http.ts`，禁掉 `.map((e) => e)` 这个惯用法。
  只报行号不 dump 全文——`expect(x).not.toMatch(源码)` 失败时会把 1000+ 行
  一起打出来，那行 `map((e) => e)` 会被埋掉。

### 2. `scripts/verify-web.ts` §4.2（真 HTTP）

对真 server 断言同样 5 条，外加 SSE 那条（`data:` 行解析后必须带
`session_id` 且无驼峰键）——SSE 与 `/api/op` 是两个独立出口。

### 反向验证（这一步不能省）

改完后把 `events.tail` 临时改回 `events.map((e) => e)`，确认两个测试都变红：

```
(fail) events.tail 每条都带真实的 session_id
  + "events.tail seq=17: session_id=undefined（期望 s-aaaaaa）"
  + "events.tail seq=18: session_id=undefined（期望 s-aaaaaa）"
  + "events.tail seq=19: session_id=undefined（期望 s-aaaaaa）"
  + "events.tail seq=20: session_id=undefined（期望 s-aaaaaa）"
(fail) 对外出口没有绕过 eventToJson 直接吐领域对象（防回退）
```

行为测试与静态测试**互相独立**且都抓到了同一处回退——说明两层守卫不是摆设。

## 踩坑

- **别把"症状吻合"当证据**。库里真有 `session_id='system'` 的事件，
  `?? "system"` 的兜底也对得上，第一眼看过去完全说得通。先查库、
  再打真实接口，两步就把方向掰正了。
- **我第一版守卫写反了语义**：`expect(msg).toContain("never")` 想表达
  "消息里没有 never 时才通过"，结果条件一成立就红。改成
  `collect problems → expect(problems).toEqual([])`，顺便还能一次列出所有问题，
  而不是第一个错就中断。
- **`session_id: null` 是合法值，不是 bug**：那次操作没关联会话
  （verify 脚本里有一条 `task.progress` 就没带 `X-Kanban-Session` 头），
  前端把它显示成 `system` 是对的。第一版断言要求"每条都像 `s-xxx`"，
  把 `null` 误判成故障，改成"至少有一条是真会话 id，且数据里不含 `system`"。
- **写文件前先看行尾**：`scripts/verify-web.ts` 在工作区是 CRLF，其余源文件是 LF，
  `edit` 的 LF 匹配不上。先 `git ls-files --eol` 确认，再按 index 的 LF 转回去
  （`i/lf w/lf`），diff 才干净。

## 顺带发现（不属于本次改动，未修）

`bun run verify:web` 基线（改动前）就有 3 项红：
`泳道有数据 doing=0`、`待办泳道 todo=3`、`SSE 推送到新事件 47 行`。
`git stash` 对比确认与本次无关。根因是工作区在途的 identity 分片改动
（`src/core/paths.ts` / `src/commands/session.ts` / `src/core/tasks.ts`
未提交，commit `2542b69 qoder env`）：

远端模式下 `session start` 报成功（打印了 identity 行），
但紧接着的 `task claim` 报

```
Error[USAGE]: missing session id, cannot tell who is operating
Your identity key is `pi-...`, but no session is registered for it yet.
```

`start` 成功却没留下可读的 session，是那条线要查的事。
连带后果：认领没生效（`doing=0`）、verify 脚本的 `task note` 也没发出去
（SSE 收不到新事件）。**没有顺手改**——那是在途的另一批工作。
