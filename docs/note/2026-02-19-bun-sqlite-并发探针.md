# 2026-02-19 技术探针：bun:sqlite 并发能力

## 目的

在敲定 [001-总体设计](../plan/001-总体设计.md) 的存储层方案前，用一次性探针脚本验证三个决定性假设，
避免"文档里写可行、真写代码才发现不行"。

## 环境

- Bun 1.4.2（Windows x64）
- `bun:sqlite` 内置模块
- 8 个并发子进程，共享同一个 db 文件

## 探针 1：默认日志模式

```ts
const db = new Database(dbPath, { create: true });
db.query("PRAGMA journal_mode=WAL").get();  // → { journal_mode: "wal" }
```

**结论**：`bun:sqlite` 默认就是 WAL，无需显式设置（但代码里仍显式设置一次，避免依赖默认值）。

## 探针 2：多进程并发短事务是否 SQLITE_BUSY

8 进程 × 25 次 `BEGIN IMMEDIATE` 短事务（每次一条 INSERT/条件 UPDATE）：

```
{ ok: 8, busy: 0, other: 0 }
```

**结论**：0 次 BUSY。agent 场景写频率是分钟级，SQLite 单写者完全够用，不需要上 Postgres。

## 探针 3：条件 UPDATE 的抢占唯一性

表内预置一行 `owner=NULL`，8 进程各 25 次执行：

```sql
UPDATE t SET owner = ? WHERE owner IS NULL
```

结果：恰好 1 个 worker 提交成功（`committed=1`），其余 200 次 `changes=0` 全部正确失败。

**结论**：这是"抢占任务"实现方式的正确基础——不靠"先 SELECT 再 UPDATE"的读改写竞态，
而是靠条件 UPDATE + `changes` 判定。ADR-2 成立。

## 踩到的两个坑

### 坑 1：`{ create: false }` 触发 SQLITE_MISUSE

```ts
new Database(path, { create: false });                    // ❌ SQLITE_MISUSE (errno 21)
new Database(path, { readwrite: true, create: false });   // ✅
```

**原因**：`create: false` 单独给时，连接被当作"不新建也不可写"的矛盾状态。
**修复**：打开已存在的库必须显式 `readwrite: true`，与 `create: false` 同时给。
**影响面**：`core/db.ts` 里所有"只打开已存在库"的路径（`doctor`、`rebuild`、`import`）都要注意。

### 坑 2：探针脚本自身的逻辑错误（空表 UPDATE）

第一版探针里没往表里插初始数据，就让 8 进程去抢 `WHERE owner IS NULL`，
所有 worker 都返回 `changes=0`，看起来像"抢占机制有问题"。

实际上 `UPDATE` 不会凭空插入行，空表匹配 0 行是**正确行为**。

**教训**：验证并发/条件更新类机制时，先用一个最小 sanity check 确认"在无竞争时该语句确实会命中 1 行"，
再上并发。否则会把脚本 bug 当成设计缺陷。

### 附：`Bun.argv` 语义确认

`bun run script.ts a b` 时：

```
Bun.argv = [bun.exe, "E:/path/script.ts", "a", "b"]
→ Bun.argv.slice(2) === ["a", "b"]   ✅
```

子进程用 `Bun.spawn(["bun", "script.ts", arg1, arg2])` 时同理，参数解析正常。
但用相对脚本路径 + Windows 工作目录时要小心，建议一律传绝对路径。

## 落地到设计

以上结论已写进 [001-总体设计 §13](../plan/001-总体设计.md) 与 ADR-2，
实施时 `src/core/db.ts` 的 PRAGMA 与连接选项必须遵守：

```ts
// 已存在库
new Database(path, { readwrite: true, create: false });
// 新建库
new Database(path, { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 5000");
```
