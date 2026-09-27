-- =============================================================================
-- agent-kanban 数据库 schema（v5：plans 主键含 project_key）
--
-- 设计依据见 docs/plan/001-总体设计.md：
--   §4 数据模型 / ADR-1 事件溯源 / ADR-2 并发 / ADR-4 租约
--   ADR-9 project 层级：project_key 贯穿业务表，但 sessions 故意不带
--   ADR-13 token 权限：project 级 token（显式 project 白名单） + 管理员 token
--
-- 约定：
--   * 所有时间戳均为 epoch 毫秒（INTEGER）
--   * JSON 字段以 TEXT 存储，读取时解析，缺失时用默认值
--   * events 表只追加不修改，是唯一事实来源；tasks/sessions/plans 都是它的投影
--   * **任务号 T-0007 与计划号 PL-0001 都是 per-project 唯一的**（不是全局唯一），
--     因为 agent 口语里的 "T-0007" 必须只指向本 project 的卡；
--     且 tasks / plans 的 UNIQUE 约束都含 project_key。
--     （plans 直到 v5 才补上：v1→v2 迁移漏了它，导致第二个 project 存计划必撞主键）
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 访问 token（v3 新增，ADR-13）
--
-- 取代 v2 的 projects.api_key_hash：per-project key 无法表达
-- "一个 token 授权多个 project" 与 "管理员 token" 这两种需求。
--
-- 角色：
--   admin    —— 管理员：可访问所有 project，可管理 project 与 token
--   project  —— 项目级：只能访问 projects 白名单里列出的 project
--
-- 安全：库里只存 key_hash（SHA-256），明文只在创建/轮换时显示一次。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tokens (
  id           TEXT PRIMARY KEY,          -- k_ + 32 hex
  name         TEXT,                      -- 人类可读名（admin 界面/审计用）
  role         TEXT NOT NULL,             -- admin | project
  projects     TEXT,                      -- JSON 数组：role=project 时的白名单
  key_hash     TEXT NOT NULL,             -- sha256:<hex>
  created_at   INTEGER NOT NULL,
  created_by   TEXT,                      -- 哪个 admin 签发
  last_used_at INTEGER,                   -- 最后使用（审计：闲置 token 可见）
  revoked_at   INTEGER,                   -- 吊销时间；非空则不可用
  expires_at   INTEGER,                   -- 过期时间；非空则过期后不可用
  note         TEXT                       -- 备注（如"CI 专用"、"外包团队"）
);
CREATE INDEX IF NOT EXISTS idx_tokens_role    ON tokens(role);
CREATE INDEX IF NOT EXISTS idx_tokens_active  ON tokens(revoked_at, expires_at);

-- -----------------------------------------------------------------------------
-- 项目（ADR-9）
--
-- 注意：v3 起 **api_key_hash 不再用于鉴权**（改用 tokens 表），
-- 该列保留仅为兼容旧数据与迁移过程，鉴权逻辑一律读 tokens。
--
-- 一个本地 .kanban/ 只对应一个 project（key 由目录名派生）；
-- 一个远程 server 可以管多个 project，靠 token 的 project 白名单隔离。
-- -----------------------------------------------------------------------------


CREATE TABLE IF NOT EXISTS projects (
  key            TEXT PRIMARY KEY,          -- 'agent-kanban'：人类可读 slug，CLI/URL 友好
  name           TEXT NOT NULL,             -- 显示名
  root_path      TEXT,                      -- 本地模式的项目目录；远程模式可空
  api_key_hash   TEXT,                      -- per-project key 的 SHA-256；本地模式为空（不鉴权）
  created_at     INTEGER NOT NULL,
  default_ttl_ms INTEGER,                   -- 该 project 可覆盖全局默认
  grace_ms       INTEGER
);

-- -----------------------------------------------------------------------------
-- 全局元信息（key-value）
--
-- 注意：project_name 已下沉到 projects.name；这里只留全局默认值与版本号
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- -----------------------------------------------------------------------------
-- 会话：一次 agent 运行
--
-- **故意不带 project_key**（ADR-9）：会话是 agent 进程身份，可以跨项目工作。
-- 因此租约回收（reapZombies）是全局的：进程死了，它在所有 project 下的卡都要回收。
--
-- last_seen_at 是防"agent 忘记心跳"的核心：任何 CLI/MCP 调用都会刷新它，
-- 系统据此判断持有者是否失联（ADR-4 L2）。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id               TEXT PRIMARY KEY,              -- s-7f3a2b（base36，6 位）
  agent_name       TEXT NOT NULL,                 -- 人可读名，如 pi-main
  harness          TEXT,                          -- pi | claude-code | cursor | human
  cwd              TEXT NOT NULL,                 -- 启动时的工作目录
  pid              INTEGER,                       -- 诊断用（存活探测仅作提示，不作判据）
  status           TEXT NOT NULL,                 -- active | idle | closed | crashed
  started_at       INTEGER NOT NULL,
  last_seen_at     INTEGER NOT NULL,              -- 最后心跳
  lease_expires_at INTEGER,                       -- 会话级租约
  meta             TEXT                          -- JSON：{ model, host, ... }
);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status, last_seen_at);

-- -----------------------------------------------------------------------------
-- 任务
--
-- assignee_session_id + lease_expires_at 构成"租约"（ADR-4）：
--   归属不是永久的，而是带期限的。持有者失联后租约过期，卡自动回到可认领状态，
--   但 progress 与 checklist 原样保留 —— 这是"恢复后不用从头再来"的关键。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
  seq                 INTEGER PRIMARY KEY AUTOINCREMENT,  -- 全局唯一序号（SSE 游标/稳定排序）
  id                  TEXT NOT NULL,             -- T-0007（per-project 唯一，UNIQUE(project_key,id)）
  project_key         TEXT NOT NULL,            -- 所属 project（ADR-9）
  title               TEXT NOT NULL,
  body                TEXT,                     -- markdown 详细描述
  status              TEXT NOT NULL,            -- backlog|todo|doing|blocked|review|done|cancelled
  priority            INTEGER NOT NULL DEFAULT 2,-- 0 最高 … 4 最低
  assignee_session_id TEXT,                     -- 当前租约持有者
  lease_expires_at    INTEGER,                  -- 租约到期时间；NULL = 未持有
  progress            INTEGER NOT NULL DEFAULT 0,-- 0..100
  checklist           TEXT,                     -- JSON：[{text,done,done_at,by}]
  labels              TEXT,                     -- JSON：["backend","urgent"]
  parent_id           TEXT,                     -- 父任务 T-0003
  plan_id             TEXT,                     -- 当前生效的计划版本
  block_reason        TEXT,                     -- 阻塞原因（block 时写入）
  created_by          TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  started_at          INTEGER,
  finished_at         INTEGER,
  estimate_ms         INTEGER,
  spent_ms            INTEGER
);
-- 看板主查询路径：按 project + 状态过滤 + 优先级排序
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_key, id);
CREATE INDEX IF NOT EXISTS idx_tasks_status   ON tasks(project_key, status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_session_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent   ON tasks(project_key, parent_id);

-- -----------------------------------------------------------------------------
-- per-project 的任务号分配计数器
--
-- 为什么不直接用 MAX(id)：删除任务后 MAX 会回退，导致已删除的 ID 被重新分配，
-- 而历史事件/交接里仍引用着那个 ID → 审计链条断裂。
-- 计数器表保证 **ID 永不复用**（与 SQLite AUTOINCREMENT 同思路）。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_counters (
  project_key   TEXT PRIMARY KEY,
  next_task_num INTEGER NOT NULL
);

-- -----------------------------------------------------------------------------
-- 任务依赖：A 依赖 B，B 完成则 A 可做
-- 不加自引用/级联之外的复杂约束，环检测在应用层做（core/tasks.ts）
--
-- project_key 不可省（v3 → v4 补上的）：T- 编号是 per-project 的，
-- 没有它，两个 project 的 “T-0001 依赖 T-0002” 会撞同一条记录，
-- 且 INSERT OR IGNORE 会静默丢弃后者的依赖（多 project 下静默出错）。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS task_deps (
  project_key   TEXT NOT NULL,
  task_id       TEXT NOT NULL,
  depends_on_id TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (project_key, task_id, depends_on_id)
);
CREATE INDEX IF NOT EXISTS idx_deps_dependson ON task_deps(depends_on_id);
CREATE INDEX IF NOT EXISTS idx_deps_project   ON task_deps(project_key, task_id);

-- -----------------------------------------------------------------------------
-- 事件：不可变，只追加
--
-- seq 是全局单调自增，既是审计顺序也是 SSE 断线续传游标。
-- 投影表与事件在同一事务内写入，因此不存在"状态变了但没日志"的中间态。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  session_id TEXT,                                -- 系统事件为 'system' 或 NULL
  type       TEXT NOT NULL,
  task_id    TEXT,
  plan_id    TEXT,
  project_key TEXT,                               -- 所属 project（ADR-9）
  data       TEXT                                 -- JSON payload，缺失时为 '{}'
);
CREATE INDEX IF NOT EXISTS idx_events_task    ON events(task_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_ts      ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_sess    ON events(session_id, seq);
-- SSE 按 project 增量拉取用（远程模式下一个 server 服务多个 project）
CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_key, seq);

-- -----------------------------------------------------------------------------
-- 计划（版本化，ADR-1 中"历史计划可追溯"的载体）
--
-- 同一 scope 内 version 自增；新版本落库时旧版本转 superseded 并被 supersedes_id 串成链。
--
-- ⚠ 主键含 project_key（v5 补的）：计划号按 project 分配（见 ids.ts），
--   而旧版主键只有 id，于是两个 project 的第一份计划都叫 PL-0001 → 撞主键，
--   `plan save` 在多 project server 上整个不可用。
--   version 也要在主键里：任务级计划的 id 里已含版本号（PL-T-0007-01/02…），
--   但项目级计划的 id 只是 PL-0001，version 承载了区分。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plans (
  id                TEXT NOT NULL,      -- PL-0007（项目级） / PL-T-0003-02（任务级）
  project_key       TEXT NOT NULL,      -- 所属 project（ADR-9）；per-project 唯一
  scope             TEXT NOT NULL,      -- project | task
  task_id           TEXT,               -- scope=task 时有效
  version           INTEGER NOT NULL,   -- 同 scope 内自增，从 1 开始
  title             TEXT NOT NULL,
  body              TEXT NOT NULL,      -- markdown 全文
  status            TEXT NOT NULL,      -- active | superseded | draft
  author_session_id TEXT,
  created_at        INTEGER NOT NULL,
  supersedes_id     TEXT,
  PRIMARY KEY (project_key, id, version)
);
CREATE INDEX IF NOT EXISTS idx_plans_scope   ON plans(project_key, scope, task_id, version);
CREATE INDEX IF NOT EXISTS idx_plans_status  ON plans(project_key, status);

-- -----------------------------------------------------------------------------
-- 交接：agent 之间传递上下文的结构化记录（ADR-7）
--
-- kind=voluntary 主动交接 / crash 崩溃后由系统自动合成 / reclaim 被接管时留痕
-- consumed_by 标记"谁接手了"，让新会话能区分"这是给我的"与"已经有人处理过"
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS handoffs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_key    TEXT NOT NULL,        -- 所属 project（ADR-9）
  task_id        TEXT NOT NULL,
  session_id     TEXT NOT NULL,        -- 交接发出方
  kind           TEXT NOT NULL,        -- voluntary | crash | reclaim
  summary        TEXT NOT NULL,        -- 做了什么
  next_step      TEXT,                 -- 建议下一步
  blockers       TEXT,                 -- JSON 数组
  open_questions TEXT,                 -- JSON 数组
  created_at     INTEGER NOT NULL,
  consumed_by    TEXT,                 -- 接手方 session id
  consumed_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_handoffs_task    ON handoffs(project_key, task_id, id);
CREATE INDEX IF NOT EXISTS idx_handoffs_pending ON handoffs(project_key, consumed_by, id);
