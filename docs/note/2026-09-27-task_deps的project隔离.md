# task_deps 的 project 隔离：补完漏掉的读路径（2026-09-27）

看板任务：T-0002「补 task_deps 的 project 隔离」（p0）

## 背景：这张卡剩的不是表结构，是读路径

v1→v2 迁移（ADR-9）给 `tasks` / `events` / `plans` / `handoffs` 都加了 `project_key`，
**唯独漏了 `task_deps`**。后果有三个，都很安静：

1. 主键 `(task_id, depends_on_id)` 不含 project，而 T 编号是 per-project 的
   → 两个 project 的「T-0001 依赖 T-0002」撞同一条记录
2. `INSERT OR IGNORE` 把后者的依赖**静默丢弃**（当成重复）
3. 读依赖的查询不带 project 过滤 → 跨 project 判定

`src/core/db.ts` 的 `MIGRATIONS[3]`（v3→v4）已经把 1、2 解决了：换主键、按任务反查回填
`project_key`。但第 3 条——**读路径**——当时只改了 `getDependencies` / `getDependents` /
`getUnfinishedDeps` 这些点查，漏掉了两处子查询。这张卡剩下的就是这两处。

## 现象（多 project server 模式才会看到）

两个 project，各自都有 `T-0001` / `T-0002`，只在 p2 里连了 `T-0001 → T-0002`：

| 入口 | 修之前 | 症状 |
| --- | --- | --- |
| `listTasks(scope, {ready:true})` | p1 的 `T-0001` 不在结果里 | 「可认领」列表凭空少卡，agent 以为自己没活可干 |
| `getWaitingDepsMap(scope)` | p1 的 `T-0001` → `["T-0002"]` | 看板卡上冒出别的 project 的上游 |

`ready` 列表是 `buildContext` 的「可认领」数据源，`getWaitingDepsMap` 是看板快照
（`board.get`）的数据源——两个都是最显眼的地方。

原来的 `NOT EXISTS` 长这样：

```sql
SELECT 1 FROM task_deps d
JOIN tasks dt ON dt.id = d.depends_on_id AND dt.project_key = tasks.project_key
WHERE d.task_id = tasks.id AND dt.status NOT IN ('done','cancelled')
```

`JOIN` 那半看着像过滤了 project，其实只把「上游任务」限制在当前 project，
**没限制那条依赖边属于哪个 project**。p2 的边（`task_id='T-0001'`）照样能匹配上
p1 的 `T-0001` 行，只要 p1 恰好也有同号的 `depends_on_id` 且未完成。

## 修法

```sql
SELECT 1 FROM task_deps d
JOIN tasks dt ON dt.project_key = d.project_key AND dt.id = d.depends_on_id
WHERE d.project_key = tasks.project_key
  AND d.task_id = tasks.id
  AND dt.status NOT IN ('done','cancelled')
```

`JOIN` 条件改成 `dt.project_key = d.project_key`（而不是外层的 `tasks.project_key`），
子查询就自洽了：它只回答「这条边指向的那个任务，在**这条边自己的 project** 里完成了吗」。
`WHERE` 里的 `d.project_key = tasks.project_key` 正好命中
`idx_deps_project(project_key, task_id)` 这个复合索引，不会因为加过滤而丢索引。

`getWaitingDepsMap` 同理。

顺带扫全仓发现一处同类漏网：`scripts/verify-rebuild.ts` 里那句
`DELETE FROM task_deps WHERE task_id = 'T-0003'`（故意弄脏投影用的）也没带 project。
那脚本跑在**真实的 `.kanban/kanban.db`** 上，不加过滤会连带删掉别的 project 的同号边。

## 为什么必须专门写测试：单 project 的库永远测不出来

这是这类 bug 最难受的地方：**本地模式（一个 `.kanban/` 对应一个 project）下 100% 正常**，
而 `bun test` 里绝大多数 fixture 都只建一个 project。于是「补了表结构、漏了读路径」
这种半成品可以一路绿灯发布，直到有人用 server 模式托管多个 project 才炸。

所以 `test/deps-project-isolation.test.ts` 里每条用例都先建两个 project
（`createTestDb({projectKey:"p1"})` + 手工 `createProject("p2")`），
让两个 project 各自从 `T-0001` 开始撞号。

## 三层回归

### 1. 行为层：跨 project 隔离（6 条）

- p2 的边**不得**让 p1 的同名卡从 `ready` 列表消失 ← 本次修的那处
- p2 的边**不得**出现在 p1 的看板 `waiting` map 里 ← 本次修的那处
- `getDependencies` / `getDependents` / `getUnfinishedDeps` 各自按 project 过滤
- 同一条边能在两个 project 各存一份（老主键下第二次插入会被 `OR IGNORE` 吞掉）
- 环检测不跨 project：p1 有 `T-0001 → T-0002` 时，p2 的反向边 `T-0002 → T-0001`
  不该被误报成环；同一个 project 里真的成环仍然要报错
- 删任务只清本 project 的依赖边

### 2. 静态层：字面量级扫描（1 条）

行为测试只能钉住**已经写出来的那几条路径**，而这类 bug 的特征是
「新加一个查询时忘了带 project_key」——它不会让任何现有测试变红。
所以扫 `src/` 与 `scripts/` 的全部字符串/模板字面量：

> 凡 `FROM/JOIN task_deps` 的语句，整条语句里找不到 `project_key` → 判失败

判据故意收得很窄，为的是零误报：

- `PRAGMA table_info(task_deps)`、`DROP TABLE`、`CREATE INDEX … (depends_on_id)` 这类 DDL
  本来就不需要过滤，不落在这个判据里
- 迁移脚本在同一条语句里自带 `project_key`（回填用的 `COALESCE` 子查询），
  天然通过，不需要白名单
- 注释与界面文案不是 SQL 字面量，不会被扫到
  （`src/commands/rebuild.ts` 里那句提到 task_deps 的提示文案就安然无恙）

代价是**只能扫反引号与双引号**——拼出来的 SQL 字面量扫不到，所以别拼 SQL。
这条守卫上线时全仓只有一处违规，就是上面提到的 `verify-rebuild.ts`。

**⚠ 它只认 token 在不在，不认语义对不对。** 实测把谓词换成常量
`d.project_key = 'SENTINEL'`（过滤过头，所有依赖都当不存在），静态守卫与本文件的
跨 project 用例**照样全绿**。兜住这一类的是 `test/state-machine.test.ts` 的
「ready 过滤：依赖未满足的不算可认领」——它断言同 project 内的正反两面。
两层各管一段，别指望其中一层单独兜底。

### 3. 迁移层：手工造 v3 库再升级（3 条）

v3→v4 的 backfill 属于**只在老库上跑一次**的路径：新库 `from === 0` 直接建全量表，
永远不执行 `MIGRATIONS[3]`。也就是说这段代码在任何常规测试里都是死代码，
而它写错的后果是老用户升级后依赖边丢失或挂错 project，且**没有任何报错指得回来**。

所以手工把库造回 v3 形状再升：

- 先 `migrate()` 建 v4 库 → `DROP TABLE task_deps` → 建 v3 形状的表
  （无 `project_key`，主键 `(task_id, depends_on_id)`）→ 塞数据和任务
  → 把 `meta.schema_version` 改回 `3` → 再 `migrate()`
- 断言：回填按任务实际所属 project 归位（p1 与 p2 都有 `T-0001` 时取
  `created_at` 更早的那个）；悬空边（任务已删）退化为最早创建的 project；
  迁移后 `getDependencies` / `getUnfinishedDeps` 真的读得到（不只对了表、没对上接口）；
  重复 `migrate()` 幂等

## 踩到的两个坑

**① `createProject` 的 `created_at` 默认是 `Date.now()`，同一毫秒内建的两个 project
   时间戳相同。** backfill 挑 fallback 时是 `ORDER BY created_at ASC, key ASC`，
   时间相同时退化成按 key 字母序——`p-new` 会排在 `p-old` 前面，断言一下就变成
   "碰巧对"。测试里显式给两个 project 传不同的 `now`，把意图写死。

**② `readdirSync(dir, { withFileTypes: true, flat: true })` 在本仓库的 TS 版本下
   类型不认 `flat`。** 改用 `statSync(p).isDirectory()` 递归（和
   `scripts/verify-deps.ts` 的 `walk()` 一样），两边行为也对得上。

顺带一条：`tsconfig.json` 的 `include` 只有 `src/**` 与 `test/**`，**`scripts/` 不在
`tsc --noEmit` 范围里**。改 `scripts/*.ts` 要单独验：
`bunx tsc --noEmit --ignoreConfig --skipLibCheck --strict --target esnext --module esnext --moduleResolution bundler --allowImportingTsExtensions --types bun scripts/verify-rebuild.ts`
（`--ignoreConfig` 必需，否则 TS5112 直接拒跑。该文件第 41 行有一条**既有**的
TS2869 报错，与本次改动无关。）

## 门禁现状

- `bun test` 250 pass / `tsc --noEmit` 干净
- `verify:deps` / `verify:workflows` / `verify:docs` / `verify:deploy` 里前三项绿；
  `verify:deploy` 红的原因是**既有的本地状态**：`src/server/assets.generated.ts`
  里是真实构建产物而不是 HEAD 里的空表占位（之前跑过 `web:build`）。恢复命令见
  `docs/note/2026-09-26-Web详情概览-描述与检查项.md` 末节。
- `verify:all` **不能在这个仓库目录里跑**：`scripts/verify-rebuild.ts` 与
  `verify-recovery.ts` 会 `agent-kanban init --force`，那会
  **删掉真实的 `.kanban/kanban.db`**（含正在用的看板）。要跑请先复制一份仓库。

## 改了什么

| 文件 | 动作 |
| --- | --- |
| `src/core/tasks.ts` | `listTasks` 的 `readySql` 补 `d.project_key` 与自洽的 JOIN 条件 |
| `src/core/tasks.ts` | `getWaitingDepsMap` 的相关子查询同样补齐 |
| `test/deps-project-isolation.test.ts` | **新增**：6 条行为 + 1 条静态守卫 + 3 条迁移 |
| `scripts/verify-rebuild.ts` | 弄脏投影的 `DELETE` 补 `project_key` |
| `AGENTS.md` | 新增「改 task_deps 的 SQL：project_key 不能少」一节 |
