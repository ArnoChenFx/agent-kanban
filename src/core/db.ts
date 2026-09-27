/**
 * 数据库连接层：打开、PRAGMA、schema 迁移、配置读写。
 *
 * 关键实现约束（ADR-2，探针已实测验证）：
 *
 * 1. WAL + busy_timeout=5000
 *    实测 8 进程 × 25 次 BEGIN IMMEDIATE 短事务，0 次 SQLITE_BUSY。
 *    但如果不显式设 busy_timeout，瞬时并发会直接抛 "database is locked"。
 *
 * 2. 打开已存在的库必须写 { readwrite: true, create: false }
 *    只写 { create: false } 会抛 SQLITE_MISUSE（errno 21）——这是 bun:sqlite 的坑，
 *    详见 docs/note/2026-02-19-bun-sqlite-并发探针.md
 *
 * 3. foreign_keys=ON
 *    目前 schema.sql 没有声明 FOREIGN KEY，这条 pragma 暂时没有可管的东西；
 *    打开它是为了将来加约束时不用再动连接代码，而不是现状有保护。
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { slugifyProjectKey } from "./ids.ts";
import { KanbanError } from "./errors.ts";
import type { KanbanConfig } from "./types.ts";

/**
 * schema.sql 作为 **embedded file** 引入。
 *
 * 这行 import 是 `bun build --compile` 能产出可运行二进制的关键：
 * 普通 `readFileSync(join(import.meta.dir, "schema.sql"))` 在编译产物里
 * 会报 ENOENT（编译器不会把非模块图的文件打进去），而 declared embedded file
 * 会被嵌进可执行文件，运行时 `Bun.file()` 读到内存副本。
 *
 * 开发模式（bun run）下它就是普通的文件路径，行为一致。
 */
import SCHEMA_FILE from "./schema.sql" with { type: "file" };

/** 当前 schema 版本；新增表/列/索引时 +1 并在 MIGRATIONS 里补一条 */
export const SCHEMA_VERSION = 7;

/** 默认配置：租约 15 分钟、失联宽限 10 分钟 */
export const DEFAULT_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_GRACE_MS = 10 * 60 * 1000;

/**
 * 数据库句柄 + 路径的组合。
 * 所有 core 模块都通过这个对象访问数据库，方便测试注入临时库。
 */
export interface Db {
  raw: Database;
  dbPath: string;
  dir: string;
}

/**
 * 打开（或创建）数据库连接。
 *
 * @param dbPath 主库绝对路径
 * @param opts.readonly 只读打开（doctor / export 场景，避免意外写入）
 * @param opts.createIfMissing 文件不存在时是否自动创建
 */
export function openDb(
  dbPath: string,
  opts: { readonly?: boolean; createIfMissing?: boolean } = {},
): Db {
  const { readonly = false, createIfMissing = true } = opts;
  const fileExists = existsSync(dbPath);
  // 用 node:path 的 dirname 而不是字符串切片：Windows 上分隔符是 "\"，切片会截错
  const dir = dirname(dbPath);

  let raw: Database;
  if (fileExists) {
    if (readonly) {
      raw = new Database(dbPath, { readonly: true });
    } else {
      // 注意：{ create: false } 单独给会 SQLITE_MISUSE，必须配 readwrite
      raw = new Database(dbPath, { readwrite: true, create: false });
    }
  } else {
    if (!createIfMissing) {
      throw KanbanError.notInit(`database file not found: ${dbPath}`, {
        reason: "db_file_not_found",
        hint: "Run `agent-kanban init` first",
      });
    }
    mkdirSync(dir, { recursive: true });
    raw = new Database(dbPath, { create: true });
  }

  // ---- PRAGMA：并发与一致性基线（ADR-2）----
  if (!readonly) {
    raw.exec("PRAGMA journal_mode = WAL");
    // 瞬时并发时等待而不是立刻报 locked；超过 5s 才抛 BUSY，由上层映射为退出码 4
    raw.exec("PRAGMA busy_timeout = 5000");
    // 写锁竞争时立刻升级为"取不到就等"，配合 BEGIN IMMEDIATE 使用
    raw.exec("PRAGMA synchronous = NORMAL");
  }
  raw.exec("PRAGMA foreign_keys = ON");

  return { raw, dbPath, dir };
}

/**
 * 应用 schema（幂等）。全部语句都是 CREATE TABLE IF NOT EXISTS，可重复执行。
 *
 * ⚠ 为什么用 `with { type: "file" }` 而不是 fs 读路径：
 * 普通的 `readFileSync(join(import.meta.dir, "schema.sql"))` 在 `bun build --compile`
 * 编译成单文件二进制后**会失败**（ENOENT: 'B:\~BUN\root\schema.sql'）——
 * 因为 schema.sql 不是模块图的一部分，编译器不会把它打进去。
 * 声明为 embedded file 后，编译产物自带它，`Bun.file()` 直接读到内存副本。
 * 非编译模式下同样工作（指向真实文件）。
 */
export function applySchema(db: Db): void {
  let sql: string;
  try {
    sql = readFileSync(SCHEMA_FILE, "utf8");
  } catch (err) {
    throw KanbanError.notInit(`failed to read the schema: ${(err as Error).message}`, {
      reason: "schema_read_failed",
      hint: "If this is a compiled binary, the build is incomplete (the embedded schema.sql is missing)",
    });
  }
  try {
    db.raw.exec(sql);
  } catch (err) {
    throw KanbanError.notInit(`failed to apply the schema: ${(err as Error).message}`, {
      reason: "schema_apply_failed",
      hint: "The database may be corrupted; back it up and rebuild it from the event stream with `agent-kanban import <journal>`",
    });
  }
}

/**
 * 读取 schema 版本（库尚未初始化时返回 0）。
 */
export function getSchemaVersion(db: Db): number {
  try {
    const row = db.raw.query<{ v: string }, []>("SELECT v FROM meta WHERE k = 'schema_version'").get();
    return row ? Number(row.v) : 0;
  } catch {
    // meta 表还不存在 = 未初始化
    return 0;
  }
}

/**
 * 迁移到当前 schema 版本。
 *
 * 迁移原则：
 * 1. **幂等**：每一步都能安全地重复执行（`ADD COLUMN` 前先查 pragma、`CREATE TABLE` 用 IF NOT EXISTS）
 * 2. **不丢数据**：只能加列/加表，不能删列/删表
 * 3. **可回滚思路**：出错时提示用户备份，不要就地降级
 */
export function migrate(db: Db): { from: number; to: number } {
  const from = getSchemaVersion(db);
  if (from === 0) {
    // 全新库：建全量表 + 写入版本
    applySchema(db);
    setMeta(db.raw, "schema_version", String(SCHEMA_VERSION));
    return { from: 0, to: SCHEMA_VERSION };
  }
  if (from > SCHEMA_VERSION) {
    // 库来自更新的 CLI 版本：拒绝降级写入，避免破坏数据
    throw KanbanError.notInit(
      `the database schema version is ${from}, which is higher than the ${SCHEMA_VERSION} supported by this CLI, please upgrade kanban`,
      { reason: "schema_version_too_new", db_version: from, cli_version: SCHEMA_VERSION },
    );
  }

  // 逐步执行迁移（v1 → v2 → …）
  // 整个升级链包在一个事务里：SQLite 的 DDL（ALTER/CREATE/DROP）同样支持回滚，
  // 不包事务的话，v1→v2 这种换表迁移若在 DROP 之后、RENAME 之前崩溃，
  // 库会卡死在"tasks 表不存在"的中间态（版本号还没写，重跑也无法自愈）
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    for (let v = from; v < SCHEMA_VERSION; v++) {
      const step = MIGRATIONS[v];
      if (!step) {
        throw KanbanError.notInit(`missing migration script from schema v${v} to v${v + 1}`, {
          reason: "migration_script_missing",
          from: v,
          to: v + 1,
        });
      }
      step.up(db);
      setMeta(db.raw, "schema_version", String(v + 1));
    }
    db.raw.exec("COMMIT");
  } catch (err) {
    try {
      db.raw.exec("ROLLBACK");
    } catch {
      // 连接已不可用时保留原始异常
    }
    throw err;
  }
  return { from, to: SCHEMA_VERSION };
}

/**
 * 迁移步骤表：key 是「源版本」，value.up 把 v → v+1。
 * 全新库不经过这里（applySchema 直接建到最新）。
 */
const MIGRATIONS: Record<number, { up: (db: Db) => void }> = {
  /**
   * v1 → v2：引入 project 层级（ADR-9）
   *
   * 步骤：
   * 1. 建 projects 表
   * 2. 给业务表加 project_key 列（SQLite 不支持 IF NOT EXISTS 式 ADD COLUMN，需先查 pragma）
   * 3. 回填：存量行统一归入「本地默认 project」
   * 4. 插入默认 project 记录（api_key_hash=NULL，即本地模式不鉴权）
   * 5. 重建含 project_key 的索引
   *
   * 关键：迁移后**本地项目零配置继续可用**——不传 --project 就用这个默认 project。
   */
  1: {
    up(db: Db) {
      const raw = db.raw;

      // ---- 0. 先算出默认 project key ----
      // 必须在重建 tasks 表**之前**算：重建时要把存量行的 project_key
      // 直接填成最终值（而不是占位符），否则后续回填语句
      // （WHERE project_key IS NULL OR = ''）匹配不上，会留下 "default" 字面量
      const legacyName = getMeta(raw, "project_name") ?? "default";
      const defaultKey = slugifyProjectKey(legacyName);
      const now = Date.now();

      // ---- 1. projects 表 ----
      raw.exec(`CREATE TABLE IF NOT EXISTS projects (
        key            TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        root_path      TEXT,
        api_key_hash   TEXT,
        created_at     INTEGER NOT NULL,
        default_ttl_ms INTEGER,
        grace_ms       INTEGER
      )`);

      // ---- 2. tasks 表：id 的全局 UNIQUE → (project_key, id) UNIQUE ----
      // v1 写的是 `id TEXT NOT NULL UNIQUE`，多 project 下必然冲突
      // （两个 project 都想用 T-0001）。SQLite 不支持 DROP CONSTRAINT，只能重建表。
      rebuildTasksTableForProject(raw, defaultKey);

      // ---- 2b. per-project 任务号计数器 ----
      // 必须在这里建：全新库走 schema.sql 会建，但 v1→v2 迁移只跑本函数
      raw.exec(`CREATE TABLE IF NOT EXISTS project_counters (
        project_key   TEXT PRIMARY KEY,
        next_task_num INTEGER NOT NULL
      )`);

      // ---- 3. 给其余表加 project_key 列 ----
      addColumnIfMissing(raw, "events", "project_key", "TEXT");
      addColumnIfMissing(raw, "plans", "project_key", "TEXT");
      addColumnIfMissing(raw, "handoffs", "project_key", "TEXT");

      // ---- 4. 回填：存量行归入默认 project ----
      for (const table of ["tasks", "events", "plans", "handoffs"]) {
        raw
          .query(
            `UPDATE ${table} SET project_key = ? WHERE project_key IS NULL OR project_key = ''`,
          )
          .run(defaultKey);
      }

      // ---- 5. 插入默认 project 记录（api_key_hash 留空 = 本地模式不鉴权）----
      raw
        .query(
          `INSERT OR IGNORE INTO projects (key, name, root_path, api_key_hash, created_at)
           VALUES (?, ?, ?, NULL, ?)`,
        )
        .run(defaultKey, legacyName, db.dir ? String(db.dir) : null, now);

      // ---- 6. 任务号计数器：回填已用最大号，避免迁移后 ID 重用 ----
      const maxNum = raw
        .query<{ n: number | null }, [string]>(
          `SELECT MAX(CAST(substr(id, 3) AS INTEGER)) AS n FROM tasks WHERE project_key = ?`,
        )
        .get(defaultKey);
      raw
        .query(
          `INSERT OR IGNORE INTO project_counters (project_key, next_task_num) VALUES (?, ?)`,
        )
        .run(defaultKey, (maxNum?.n ?? 0) + 1);

      // ---- 7. 重建含 project_key 的索引 ----
      raw.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_key, id)");
      raw.exec("CREATE INDEX IF NOT EXISTS idx_tasks_status   ON tasks(project_key, status, priority, created_at)");
      raw.exec("CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_session_id)");
      raw.exec("CREATE INDEX IF NOT EXISTS idx_tasks_parent   ON tasks(project_key, parent_id)");
      raw.exec("CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_key, seq)");
      raw.exec("CREATE INDEX IF NOT EXISTS idx_plans_scope    ON plans(project_key, scope, task_id, version)");
      raw.exec("CREATE INDEX IF NOT EXISTS idx_handoffs_task  ON handoffs(project_key, task_id, id)");
    },
  },

  /**
   * v3 → v4：补上 task_deps 的 project 隔离（ADR-9 的遗漏）
   *
   * 背景：v1→v2 迁移给 tasks/events/plans/handoffs 都加了 project_key，
   * **唯独漏了 task_deps**。后果是多 project 场景下的真实错误：
   *   1. 主键 (task_id, depends_on_id) 不含 project，而 T-编号是 per-project 的
   *      → project A 与 project B 的 "T-0001 依赖 T-0002" 撞同一条记录
   *   2. `INSERT OR IGNORE` 会**静默**丢弃 project B 的依赖（被当成重复）
   *   3. getDependencies / getUnfinishedDeps 不带 project 过滤 → 跨 project 判定
   *
   * 单 project 的库（本地模式、迁移前的老库）不会暴露这个 bug，
   * 但它会让"一个 server 管多个 project"在有依赖时静默出错——必须修。
   *
   * 回填：靠 tasks 表反查 project_key。若同一 T-编号在多个 project 都存在
   * （理论上不可能，因为 v2 之后 T 编号按 project 独立分配），归给最早创建的 project。
   */
  3: {
    up(db: Db) {
      const raw = db.raw;

      // 幂等：已经有 project_key 就跳过（防御手工改过 schema 的库）
      const cols = raw
        .query<{ name: string }, []>("PRAGMA table_info(task_deps)")
        .all()
        .map((c) => c.name);
      if (cols.includes("project_key")) {
        raw.exec("CREATE INDEX IF NOT EXISTS idx_deps_project ON task_deps(project_key, task_id)");
        return;
      }

      raw.exec(`CREATE TABLE task_deps_v4 (
        project_key   TEXT NOT NULL,
        task_id       TEXT NOT NULL,
        depends_on_id TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        PRIMARY KEY (project_key, task_id, depends_on_id)
      )`);

      // 回填 project_key：以 task_id 能在 tasks 里匹配到的 project 为准；
      // 匹配不到（任务已删）时退化为"最早创建的 project"
      const fallback = raw
        .query<{ key: string }, []>("SELECT key FROM projects ORDER BY created_at ASC, key ASC LIMIT 1")
        .get()?.key;
      if (!fallback) return; // 没有任何 project，迁移无法进行（不应发生）

      raw.query(
        `INSERT OR IGNORE INTO task_deps_v4 (project_key, task_id, depends_on_id, created_at)
         SELECT
           COALESCE(
             (SELECT t.project_key FROM tasks t WHERE t.id = d.task_id ORDER BY t.created_at ASC LIMIT 1),
             ?
           ),
           d.task_id, d.depends_on_id, d.created_at
         FROM task_deps d`,
      ).run(fallback);

      raw.exec("DROP TABLE task_deps");
      raw.exec("ALTER TABLE task_deps_v4 RENAME TO task_deps");
      raw.exec("CREATE INDEX IF NOT EXISTS idx_deps_dependson ON task_deps(depends_on_id)");
      raw.exec("CREATE INDEX IF NOT EXISTS idx_deps_project   ON task_deps(project_key, task_id)");
    },
  },

  /**
   * v2 → v3：引入 token 权限模型（ADR-13）
   *
   * 背景：v2 的 `projects.api_key_hash` 只能表达 "1 个 project ↔ 1 个 key"，
   * 无法满足：
   *   1. 一个 token 授权多个 project
   *   2. 管理员 token（可管理 project 与 token）
   *
   * 迁移策略：
   * 1. 建 tokens 表
   * 2. 每个有 api_key_hash 的 project → 生成一条 role=project 的 token，
   *      白名单 = [该 project]（**明文不可恢复**，因为 v2 只存了哈希）
   * 3. **把 admin token 写到 server 的 config.toml**（明文），这是唯一能拿到明文的地方
   * 4. 旧 api_key_hash 保留但不再用于鉴权
   *
   * 重要：因为 v2 只存了哈希，**旧的 project key 明文无法恢复**。
   * 迁移后旧 key 全部失效，需要管理员重新签发。这是安全性正确的选择
   * （宁可让人重新配一次，也不要为了兼容而明文存 key），但必须在日志里说清楚。
   */
  2: {
    up(db: Db) {
      const raw = db.raw;

      // ---- 1. tokens 表 ----
      raw.exec(`CREATE TABLE IF NOT EXISTS tokens (
        id           TEXT PRIMARY KEY,
        name         TEXT,
        role         TEXT NOT NULL,
        projects     TEXT,
        key_hash     TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        created_by   TEXT,
        last_used_at INTEGER,
        revoked_at   INTEGER,
        expires_at   INTEGER,
        note         TEXT
      )`);
      raw.exec("CREATE INDEX IF NOT EXISTS idx_tokens_role   ON tokens(role)");
      raw.exec("CREATE INDEX IF NOT EXISTS idx_tokens_active ON tokens(revoked_at, expires_at)");

      // ---- 2. 旧 project key 无法恢复明文，只登记"需要重新签发"的提示 ----
      // 不自动生成新 token：明文只能展示一次，自动生成等于没人知道它是什么
      const legacyProjects = raw
        .query<{ key: string }, []>(
          "SELECT key FROM projects WHERE api_key_hash IS NOT NULL AND api_key_hash != ''",
        )
        .all();

      if (legacyProjects.length > 0) {
        // 写一条事件到 system project，说明需要人工介入
        const keys = legacyProjects.map((p) => p.key).join(", ");
        raw
          .query(
            `INSERT INTO events (ts, session_id, type, task_id, plan_id, project_key, data)
             VALUES (?, 'system', 'system_notice', NULL, NULL, 'system', ?)`,
          )
          .run(
            Date.now(),
            JSON.stringify({
              action: "tokens_migration",
              note: "v2→v3 migration: old project keys only stored a hash, the plaintext is unrecoverable, an admin has to issue new ones",
              projects: legacyProjects.map((p) => p.key),
            }),
          );
        console.warn(
          `[kanban] found ${legacyProjects.length} project(s) still using an old-style project key: ${keys}\n` +
            `        The old keys no longer work (v2 only stored the hash, the plaintext is unrecoverable).\n` +
            `        Run this with an admin token:\n` +
            `          agent-kanban admin token create --project ${legacyProjects[0]!.key}`,
        );
      }

      // ---- 3. schema 版本由外层统一更新 ----
    },
  },

  /**
   * v4 → v5：plans 主键改成含 project_key（ADR-9 的遗漏，plans 版）
   *
   * 背景：**计划号是 per-project 分配的**（ids.ts 的 nextProjectPlanId /
   * nextTaskPlanId 都带 projectKey），但 plans.id 是 `TEXT PRIMARY KEY`（全局唯一）。
   * 于是第二个 project 存第一份计划时就撞主键：
   *   pa → PL-0001
   *   pb → unique constraint failed
   * 而 ADR-9 声称支持「一个 server 管多个 project」，所以这是功能级断裂。
   *
   * 顺带修掉一个被它掩盖的缺陷：项目级计划 `PL-000N` 里**不含 project**，
   * 即使不撞主键，也无法从 ID 看出它属于哪个看板。
   *
   * ## 为什么不改成全局计数，而是改主键
   *
   * 三个理由，按重要性：
   *   1. 与 tasks / events / handoffs 的形状一致（都是 per-project 标识 + per-project 主键），
   *      少一条「计划是例外」的特例规则。
   *   2. 改主键后 ID 可以保持 `PL-0001` 短且可读；改全局计数则 ID 要变长。
   *   3. v1→v2 已经为 `tasks` 走过一遍同型迁移（rebuildTasksTableForProject），
   *      有可直接照抄的套路。
   *
   * ## 迁移步骤
   *
   * 1. 幂等检查：主键已含 project_key 就直接建索引返回
   * 2. 建 plans_v5（三元组主键），逐行拷入；project_key 为空时回落到库里最早创建的 project
   * 3. 删旧表、改名、重建索引
   *
   * ## 存量库会不会有「同 project 同 id」的行
   *
   * 不会：旧主键就是 id 单列，重复 id 根本插不进去。所以拷入用普通 INSERT 而非 IGNORE——
   * 真出现重复说明库已被手工改坏，宁可让它报错也不要静默丢一份计划。
   * 也就是说迁移要处理的只是「往后按 project 分配」，没有 id 冲突要解。
   */
  4: {
    up(db: Db) {
      const raw = db.raw;

      // ---- 幂等：主键已经是含 project_key 的三元组就什么都不用做 ----
      const info = raw.query<{ name: string; pk: number }, []>("PRAGMA table_info(plans)").all();
      const pkCols = info.filter((c) => c.pk !== 0).map((c) => c.name);
      if (info.some((c) => c.name === "project_key") && pkCols.includes("project_key")) {
        raw.exec("CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(project_key, status)");
        return;
      }

      // ---- 回填用的 project：老库里 project_key 可能为空 ----
      // （v1→v2 的 ADD COLUMN 允许 NULL，后面那轮回填又只处理 NULL/空串）
      const fallback = raw
        .query<{ key: string }, []>("SELECT key FROM projects ORDER BY created_at ASC, key ASC LIMIT 1")
        .get()?.key;
      if (!fallback) {
        throw KanbanError.notInit(
          "cannot migrate the plans table: this database has no project",
          {
            reason: "plans_migration_no_project",
            hint: "This database has plans but no project; it was probably created by a broken version. Restore from a backup with `agent-kanban import` instead",
          },
        );
      }

      // ---- 换表：建新表 → 拷数据 → 删旧表 → 改名 ----
      // 关外键是为了换表期间 tasks.plan_id 的悬空引用不被拦下。
      // （schema 里其实没声明外键约束，所以这一步目前是纯粹的保险）
      raw.exec("PRAGMA foreign_keys = OFF");
      try {
        raw.exec(`CREATE TABLE plans_v5 (
          id                TEXT NOT NULL,
          project_key       TEXT NOT NULL,
          scope             TEXT NOT NULL,
          task_id           TEXT,
          version           INTEGER NOT NULL,
          title             TEXT NOT NULL,
          body              TEXT NOT NULL,
          status            TEXT NOT NULL,
          author_session_id TEXT,
          created_at        INTEGER NOT NULL,
          supersedes_id     TEXT,
          PRIMARY KEY (project_key, id, version)
        )`);

        raw.exec(`INSERT INTO plans_v5
          (id, project_key, scope, task_id, version, title, body, status,
           author_session_id, created_at, supersedes_id)
          SELECT id,
                 COALESCE(NULLIF(project_key, ''), '${defaultKeySql(fallback)}'),
                 scope, task_id, version, title, body, status,
                 author_session_id, created_at, supersedes_id
            FROM plans`);

        raw.exec("DROP TABLE plans");
        raw.exec("ALTER TABLE plans_v5 RENAME TO plans");
      } finally {
        raw.exec("PRAGMA foreign_keys = ON");
      }

      raw.exec("CREATE INDEX IF NOT EXISTS idx_plans_scope  ON plans(project_key, scope, task_id, version)");
      raw.exec("CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(project_key, status)");
    },
  },

  /**
   * v5 → v6：给 `tokens.key_hash` 加 UNIQUE 索引。
   *
   * ## 为什么这条索引是承重的
   *
   * 把 `tokens.id` 改成独立引用之后，**鉴权的唯一依据就是 `key_hash`**
   * （`authenticateInternal` 拿 `WHERE key_hash = ?` 查）。而这张表上原本
   * 只有 `role` 与 `(revoked_at, expires_at)` 两个索引，**没有 key_hash 的索引**，
   * 于是每个请求都退化成全表扫描。token 表通常很小（本机自用几个），
   * 所以这个退化不报错、也慢不到能被察觉，只是安静地把 O(1) 变成 O(n)；
   * 而远程 server 上 admin 会给 CI 一个、给外包一个，token 表是会长大的。
   *
   * UNIQUE 不只是性能，它是**不变量**：`hashToken` 是 sha256，同一个明文 key
   * 只能对应一个 token 行。写进数据库层意味着这个约束连并发也管得住——
   * 应用层「先查再插」在两个请求同时签发同一个值时会漏。
   *
   * ## 存量库可能有重复吗
   *
   * 自然情况下不可能：`generateToken` 给的是 256 位随机明文，两次签发出同一个
   * 明文的概率约 2^-256。**但被手工改过的库可能有**（同一个明文插了两行、
   * 或 import 过两份）。此时 `CREATE UNIQUE INDEX` 会直接报错，而迁移报错 =
   * `migrate` 抛错 = **这个库从此打不开**——那比慢严重得多。
   *
   * 所以先查再建。查到了就**报错并附上排查语句**，而不是静默跳过：
   * 静默跳过等于「索引没建 + 没人知道」，正是这次要消灭的那类安静退化。
   * 重复几乎只可能是人为造成的，让人来看一眼是合理的。
   */
  5: {
    up(db: Db) {
      const raw = db.raw;

      // ---- 幂等：索引已在就不动 ----
      const existing = raw
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_tokens_key_hash'",
        )
        .get();
      if (existing) return;

      // ---- 先查重复：UNIQUE 建不上时不能把库锁死 ----
      const dup = raw
        .query<{ key_hash: string; n: number }, []>(
          `SELECT key_hash, COUNT(*) AS n FROM tokens
           GROUP BY key_hash HAVING n > 1 ORDER BY n DESC LIMIT 1`,
        )
        .get();
      if (dup) {
        throw KanbanError.notInit(
          `cannot add the UNIQUE index on tokens.key_hash: ${dup.n} tokens share the same key hash (${dup.key_hash})`,
          {
            reason: "duplicate_token_key_hash",
            key_hash: dup.key_hash,
            hint:
              "Two rows with the same key hash mean the same secret is stored twice, which should be impossible. " +
              "List the affected rows with:\n" +
              "  SELECT id, name, created_at FROM tokens WHERE key_hash = '<hash above>'\n" +
              "Revoke the duplicates, issue a new token, then re-run this command.",
          },
        );
      }

      raw.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_tokens_key_hash ON tokens(key_hash)");
    },
  },

  /**
   * v6 → v7：删掉 tasks.spent_ms 死列。
   *
   * 这列从第一天起就没有任何写入路径（task_done 的耗时记在事件 payload 的
   * spent_ms 字段里，不是这列）——留着只会让读代码的人以为"耗时落在库里"。
   * 新库（schema.sql）已经不建它，这里只处理存量库。
   */
  6: {
    up(db: Db) {
      const raw = db.raw;
      // 幂等：列已不存在（新库或重跑）就不动
      const cols = raw
        .query<{ name: string }, []>("PRAGMA table_info(tasks)")
        .all()
        .map((c) => c.name);
      if (!cols.includes("spent_ms")) return;
      // 该列没有索引/约束引用，DROP COLUMN 安全
      raw.exec("ALTER TABLE tasks DROP COLUMN spent_ms");
    },
  },
};

/**
 * v1 → v2：把 tasks 表的 `id UNIQUE` 改成 `(project_key, id) UNIQUE`。
 *
 * SQLite 不支持 ALTER TABLE DROP CONSTRAINT，只能重建：
 * 建新表 → 拷数据 → 删旧表 → 改名。
 *
 * @param projectKey 存量行的 project_key 填成这个值（**传最终值，不要传占位符**：
 *                   后续回填语句只处理 NULL/空串，填错就再也修不回来）
 */
function rebuildTasksTableForProject(raw: import("bun:sqlite").Database, projectKey: string): void {
  const cols = raw
    .query<{ name: string }, []>("PRAGMA table_info(tasks)")
    .all()
    .map((r) => r.name);

  // 全新库（无表）或已是目标结构：无需重建
  if (cols.length === 0) return;
  const hasProjectKey = cols.includes("project_key");
  const hasBlockReason = cols.includes("block_reason");
  if (hasProjectKey && !hasBlockReason) return;

  raw.exec("PRAGMA foreign_keys = OFF");
  try {
    raw.exec(`CREATE TABLE tasks_v2 (
      seq                 INTEGER PRIMARY KEY AUTOINCREMENT,
      id                  TEXT NOT NULL,
      project_key         TEXT NOT NULL,
      title               TEXT NOT NULL,
      body                TEXT,
      status              TEXT NOT NULL,
      priority            INTEGER NOT NULL DEFAULT 2,
      assignee_session_id TEXT,
      lease_expires_at    INTEGER,
      progress            INTEGER NOT NULL DEFAULT 0,
      checklist           TEXT,
      labels              TEXT,
      parent_id           TEXT,
      plan_id             TEXT,
      block_reason        TEXT,
      created_by          TEXT,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      started_at          INTEGER,
      finished_at         INTEGER,
      estimate_ms         INTEGER
    )`);

    // 拷贝存量行：project_key 直接填最终的默认 key
    // spent_ms 从未有任何写入路径（task_done 事件里记的是 payload，不是这列），
    // v7 迁移把它删掉；换表路径（老库升级）同样不再带上它
    raw.exec(`INSERT INTO tasks_v2
      (seq, id, project_key, title, body, status, priority, assignee_session_id,
       lease_expires_at, progress, checklist, labels, parent_id, plan_id${hasBlockReason ? ", block_reason" : ""},
       created_by, created_at, updated_at, started_at, finished_at, estimate_ms)
      SELECT seq, id, '${defaultKeySql(projectKey)}', title, body, status, priority, assignee_session_id,
             lease_expires_at, progress, checklist, labels, parent_id, plan_id${hasBlockReason ? ", block_reason" : ""},
             created_by, created_at, updated_at, started_at, finished_at, estimate_ms
        FROM tasks`);

    raw.exec("DROP TABLE tasks");
    raw.exec("ALTER TABLE tasks_v2 RENAME TO tasks");
  } finally {
    raw.exec("PRAGMA foreign_keys = ON");
  }
}

/**
 * 转义 project key 供 SQL 字面量使用。
 * project key 已被 validateProjectKey 限制为 [a-z0-9-]，
 * 这里再做一层单引号转义，防止未来放宽校验后出现 SQL 注入。
 */
function defaultKeySql(key: string): string {
  return key.replace(/'/g, "''");
}

/**
 * SQLite 的 `ALTER TABLE ADD COLUMN` 不支持 IF NOT EXISTS，
 * 重复执行会报 "duplicate column name"。所以先查 pragma_table_info 确认。
 */
function addColumnIfMissing(
  db: import("bun:sqlite").Database,
  table: string,
  column: string,
  type: string,
): void {
  const cols = db
    // PRAGMA 不接受参数，所以 Params 类型是空元组
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .map((r) => r.name);
  if (!cols.includes(column)) {
    // 注意：SQLite 不允许 ADD COLUMN NOT NULL 无默认值，所以列可空，由回填步骤补齐
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

/** 写入 meta 键值 */
export function setMeta(db: Database, key: string, value: string): void {
  db.query("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(
    key,
    value,
  );
}

/** 读取 meta 键值，不存在返回 undefined */
export function getMeta(db: Database, key: string): string | undefined {
  const row = db.query<{ v: string }, [string]>("SELECT v FROM meta WHERE k = ?").get(key);
  return row?.v;
}

/** 读取看板配置（缺省字段用默认值填充） */
export function getConfig(db: Database): KanbanConfig {
  return {
    schemaVersion: Number(getMeta(db, "schema_version") ?? "0"),
    projectName: getMeta(db, "project_name") ?? "Unnamed project",
    createdAt: Number(getMeta(db, "created_at") ?? "0"),
    defaultTtlMs: Number(getMeta(db, "default_ttl_ms") ?? String(DEFAULT_TTL_MS)),
    graceMs: Number(getMeta(db, "grace_ms") ?? String(DEFAULT_GRACE_MS)),
  };
}

/**
 * 写入初始配置。
 *
 * 注意：本函数**不**开事务，由调用方（init 命令）统一包在一个 BEGIN IMMEDIATE 里，
 * 以便"建库 + 写配置 + 记事件"是一次原子提交（避免出现有库没配置的半成品）。
 * 已存在的键不覆盖，用户调过的 ttl/grace 不会被 init 重置。
 */
/** 写入初始配置 */
export function setInitialConfig(
  db: Database,
  opts: { projectName?: string; ttlMs?: number; graceMs?: number; now?: number },
): void {
  const now = opts.now ?? Date.now();
  if (opts.projectName && !getMeta(db, "project_name")) {
    setMeta(db, "project_name", opts.projectName);
  }
  if (!getMeta(db, "created_at")) setMeta(db, "created_at", String(now));
  if (!getMeta(db, "default_ttl_ms")) {
    setMeta(db, "default_ttl_ms", String(opts.ttlMs ?? DEFAULT_TTL_MS));
  }
  if (!getMeta(db, "grace_ms")) {
    setMeta(db, "grace_ms", String(opts.graceMs ?? DEFAULT_GRACE_MS));
  }
  setMeta(db, "schema_version", String(SCHEMA_VERSION));
}

/** 关闭连接（Bun 的 Database 有 close） */
export function closeDb(db: Db): void {
  try {
    db.raw.close();
  } catch {
    // 已关闭时静默忽略，避免在错误处理路径里二次抛错
  }
}
