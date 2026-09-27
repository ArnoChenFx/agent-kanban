/**
 * 会话领域逻辑：身份、租约、僵尸回收。
 *
 * 这是崩溃恢复的执行层（ADR-4 L1/L2）。核心思想：
 *
 * **归属不是永久的，而是带过期时间的租约。**
 *
 * agent 崩溃是常态而非异常，所以恢复协议不能依赖"崩溃的 agent 回来解锁"。
 * 判据是心跳：任何 CLI/MCP 调用都会刷新 last_seen_at（agent 本来就在调命令，
 * 零额外心智负担）；超过 grace 未见心跳就判为失联，其持有的卡自动回到待办。
 *
 * 最关键的一点（与常见实现不同）：**回收时保留 progress 与 checklist**。
 * 新 agent 看到的是"这张卡做到 60%，未完成的是 X、Y"，而不是从零开始。
 */

import type { Database } from "bun:sqlite";
import { KanbanError } from "./errors.ts";
import { newSessionId } from "./ids.ts";
import { toSession, toTask, type SessionRow, type TaskRow } from "./rows.ts";
import { withTx, type TxContext } from "./tx.ts";
import { synthesizeCrashHandoff } from "./handoff.ts";
import type { Session, SessionStatus, SessionView, Task, TaskStatus } from "./types.ts";

/** 默认失联宽限：10 分钟（远大于 agent 单次操作间隔，避免误判） */
export const DEFAULT_GRACE_MS = 10 * 60 * 1000;

/**
 * 刷新 last_seen_at 的节流间隔。
 *
 * ## 为什么需要节流
 *
 * 「任何 CLI/MCP 调用都算一次心跳」是本项目的核心前提（ADR-4 L1），
 * 所以刷新点在**每条命令**上。但刷新是写操作，agent 跑脚本时一分钟能调几十次，
 * 不节流就等于把写锁抢成了常态。60s 粒度对判据完全够用：
 * 失联宽限默认 10 分钟，是它的 10 倍。
 *
 * ## 曾经的 bug（为什么这行注释这么长）
 *
 * `touchSession` 曾经**零调用点**——函数与注释都在，但没人调它，
 * `last_seen_at` 只在 `session start` 与显式 `session heartbeat` 时更新。
 * 后果是：一个连续工作 30 分钟、每 3 分钟调一次 `task progress` 的 agent，
 * 在第 12 分钟被判 crashed、自己的卡被回收回 todo、还被合成了一条
 * **造假的** crash 交接说"持有者失联 12 分钟"。而 `reapZombies` 是在
 * **每条命令开头**跑的——agent 用来证明自己活着的命令正是杀死它的命令。
 * 触发门槛只是「干活超过宽限期」，也就是最正常的用法。
 *
 * 回归测试在 `test/session-heartbeat.test.ts`。
 */
export const TOUCH_THROTTLE_MS = 60_000;

/** 会话接口 */
export interface CreateSessionInput {
  agentName: string;
  harness?: string | null;
  cwd?: string;
  pid?: number | null;
  /** 显式指定 session id（测试用） */
  id?: string;
}

/** 注册新会话 */
export function createSession(ctx: TxContext, input: CreateSessionInput): Session {
  const id = input.id ?? newSessionId();
  const now = ctx.now();
  ctx.db
    .query(
      `INSERT INTO sessions (id, agent_name, harness, cwd, pid, status, started_at, last_seen_at, lease_expires_at, meta)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, '{}')`,
    )
    .run(
      id,
      input.agentName,
      input.harness ?? null,
      input.cwd ?? process.cwd(),
      input.pid ?? process.pid ?? null,
      now,
      now,
      null,
    );
  ctx.emit({
    type: "session_started",
    data: { agent_name: input.agentName, harness: input.harness ?? null, pid: input.pid ?? process.pid },
    sessionId: id,
    // 会话启动是全局事件（不属于某个 project）
    projectKey: "system",
  });
  return requireSession(ctx.db, id);
}

/** 按 ID 取会话 */
export function getSession(db: Database, sessionId: string): Session | null {
  const row = db
    .query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?")
    .get(sessionId);
  return row ? toSession(row) : null;
}

/** 按 ID 取会话，不存在抛 STATE */
export function requireSession(db: Database, sessionId: string): Session {
  const session = getSession(db, sessionId);
  if (!session) {
    // 会话行不存在通常意味着 DB 被重建过：给出可操作的提示而不是干巴巴的“not found”
    throw KanbanError.state(`session ${sessionId} not found`, {
      reason: "session_not_found",
      session_id: sessionId,
      hint: "The session may have been lost when the database was rebuilt; re-register it with `agent-kanban session start` and take the task over with `agent-kanban resume <task-id>`",
    });
  }
  return session;
}

/**
 * 刷新心跳（不写事件）。
 *
 * 带节流：距上次刷新不足 `TOUCH_THROTTLE_MS` 就不写。
 * 幂等且安全——少写一次只意味着 `last_seen_at` 最多落后 60s，
 * 远小于任何合理的失联宽限。
 *
 * @returns 是否真的写了一次
 */
export function touchSession(db: Database, sessionId: string, now: number): boolean {
  const row = db
    .query<{ last_seen_at: number | null }, [string]>("SELECT last_seen_at FROM sessions WHERE id = ?")
    .get(sessionId);
  // 会话行不存在（库被重建过 / 手填的 session id）：不静默造一行，
  // 让调用方的 requireSession 路径去报那句可操作的错
  if (!row) return false;
  if (row.last_seen_at !== null && now - row.last_seen_at < TOUCH_THROTTLE_MS) return false;
  db.query("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(now, sessionId);
  return true;
}

/** 关闭会话：其持有的 doing 任务自动释放为 todo（保留进度，跨 project） */
export function closeSession(
  ctx: TxContext,
  sessionId: string,
  summary?: string,
): { released: string[] } {
  const db = ctx.db;
  const session = requireSession(db, sessionId);
  if (session.status === "closed") return { released: [] };

  // 释放持有中的任务：主动关闭不该让卡留在 doing 上（否则要等租约过期才可认领）
  // 带出 project_key：释放事件要写到任务所属的 project 下
  const heldRows = db
    .query<{ id: string; project_key: string }, [string]>(
      "SELECT id, project_key FROM tasks WHERE assignee_session_id = ? AND status = 'doing'",
    )
    .all(sessionId);

  const now = ctx.now();
  for (const row of heldRows) {
    // ⚠ WHERE 必须带 project_key：id 是 per-project 的（ADR-9），不带就会
    //   连带释放别的 project 里同号的卡（而那可能正被另一个会话拿着）。
    db.query(
      `UPDATE tasks SET status = 'todo', assignee_session_id = NULL, lease_expires_at = NULL,
                         block_reason = NULL, updated_at = ?
        WHERE project_key = ? AND id = ?`,
    ).run(now, row.project_key, row.id);
    ctx.emit({
      type: "task_released",
      taskId: row.id,
      projectKey: row.project_key,
      data: { reason: "session closed" },
    });
  }

  db.query("UPDATE sessions SET status = 'closed', lease_expires_at = NULL WHERE id = ?").run(sessionId);
  ctx.emit({ type: "session_closed", data: { summary: summary ?? null }, sessionId, projectKey: "system" });
  return { released: heldRows.map((r) => r.id) };
}

/** 列出所有会话（按最近活跃排序） */
export function listSessions(db: Database, opts: { includeClosed?: boolean } = {}): Session[] {
  const sql = opts.includeClosed
    ? "SELECT * FROM sessions ORDER BY last_seen_at DESC"
    : "SELECT * FROM sessions WHERE status IN ('active','idle','crashed') ORDER BY last_seen_at DESC";
  return db.query<SessionRow, []>(sql).all().map(toSession);
}

/** 会话当前持有的任务（跨 project，因为 agent 可以同时在多个 project 干活） */
export function getSessionTasks(db: Database, sessionId: string): Task[] {
  return db
    .query<TaskRow, [string]>(
      "SELECT * FROM tasks WHERE assignee_session_id = ? ORDER BY seq",
    )
    .all(sessionId)
    .map(toTask);
}

// =============================================================================
// 僵尸回收（ADR-4 L2）
// =============================================================================

export interface ReapResult {
  /** 被判失联的会话 ID */
  crashedSessions: string[];
  /** 被回收的任务（已回到 todo，进度保留） */
  reclaimedTasks: Array<{ taskId: string; projectKey: string; prevSessionId: string; prevProgress: number }>;
}

/**
 * 僵尸回收：把心跳超时的会话标记为 crashed，并释放其任务。
 *
 * 设计决策：
 * 1. **只在写事务内执行**，多个 agent 同时触发回收时不会重复回收同一张卡
 * 2. **跨 project**（ADR-9）：会话本身不属于任何 project（agent 可以跨项目工作），
 *    所以进程死了，它在**所有** project 下的卡都要回收。
 * 3. **blocked / review 状态的任务不回收**：阻塞是需要人处理的事实，与持有者是否存活无关；
 *    review 是人的闸口，更不该因为 agent 消失而退回
 * 4. **回收保留 progress 与 checklist**：这是"恢复后不用从头再来"的直接体现
 * 5. **时钟回拨兜底**：若 now < last_seen_at（系统时间被调），视为未超时
 *
 * @param graceMs 失联宽限；缺省用 DEFAULT_GRACE_MS
 * @param now 逻辑时钟，测试可注入
 */
export function reapZombies(
  db: Database,
  opts: { graceMs?: number; now?: number } = {},
): ReapResult {
  const now = opts.now ?? Date.now();
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const result: ReapResult = { crashedSessions: [], reclaimedTasks: [] };

  // ---- 快路径：先只读探测，确认真的有僵尸才开写事务 ----
  //
  // 为什么值得：reapZombies 在**每条命令开头**都跑，包括 `task list`、`board`
  // 这类纯读命令。而 withTx 是 BEGIN IMMEDIATE —— 哪怕一个僵尸都没有，
  // 每个 agent 的每次读命令也要抢一次全库写锁，多 agent 并发时全部串行化
  // （busy_timeout 会把压力转成退出码 4 而不是报错，所以表现是「变慢」不是「坏掉」，
  //  但规模上去后读性能被写锁拖住）。
  //
  // 下面事务内会**用同一判据重新查一次**，所以这里只是优化，不引入竞态：
  // 探测与开事务之间新出现的僵尸仍会被事务内那一次捞到。
  const hasZombie = db
    .query<{ n: number }, [number]>(
      `SELECT 1 AS n FROM sessions
        WHERE status IN ('active','idle') AND last_seen_at < ?
        LIMIT 1`,
    )
    .get(now - graceMs);
  if (!hasZombie) return result;

  withTx(
    db,
    (ctx) => {
      // 找出所有超时未心跳的活跃会话
      // 时钟回拨保护：last_seen_at > now 的会话（时间被往回调过）视为健康，
      // 条件写成 last_seen_at < now - grace 天然满足这一点（未来的时间戳不会小于过去）
      const zombies = ctx.db
        .query<{ id: string; last_seen_at: number }, [number]>(
          `SELECT id, last_seen_at FROM sessions
            WHERE status IN ('active','idle')
              AND last_seen_at < ?`,
        )
        .all(now - graceMs);

      for (const zombie of zombies) {
        const sessionId = zombie.id;
        ctx.db.query("UPDATE sessions SET status = 'crashed' WHERE id = ?").run(sessionId);
        // session_crashed 是全局事件（不属于某个 project），故 projectKey 用 "system"
        ctx.emit({
          type: "session_crashed",
          sessionId,
          projectKey: "system",
          data: {
            grace_ms: graceMs,
            last_seen_at: zombie.last_seen_at,
            silent_ms: now - zombie.last_seen_at,
          },
        });
        result.crashedSessions.push(sessionId);

        // 回收该会话在**所有 project** 下持有的 doing 任务
        const held = ctx.db
          .query<{ id: string; progress: number; project_key: string }, [string]>(
            "SELECT id, progress, project_key FROM tasks WHERE assignee_session_id = ? AND status = 'doing'",
          )
          .all(sessionId);

        for (const task of held) {
          // ⚠ WHERE 必须带 project_key：id 是 per-project 的（ADR-9）。
          //   这条曾经只按 id 匹配，后果是**回收崩溃会话时会连带释放另一个
          //   健康会话正在做的同号卡**——实测 sA 崩溃把 sB 手里 40% 的卡抢走。
          //   而整套租约机制存在的理由就是防这个（重复劳动）。
          ctx.db
            .query(
              `UPDATE tasks
                  SET status = 'todo',
                      assignee_session_id = NULL,
                      lease_expires_at = NULL,
                      updated_at = ?
                WHERE project_key = ? AND id = ? AND status = 'doing'`,
            )
            .run(now, task.project_key, task.id);
          // 注意：progress 与 checklist 都不动 —— 恢复现场的关键
          ctx.emit({
            type: "task_reclaimed",
            taskId: task.id,
            // 事件必须带上任务自己的 project，否则远程客户端按 project 过滤时会漏掉
            projectKey: task.project_key,
            data: {
              holder_crashed: true,
              crashed_session: sessionId,
              prev_progress: task.progress,
              silent_ms: now - zombie.last_seen_at,
            },
          });
          result.reclaimedTasks.push({
            taskId: task.id,
            projectKey: task.project_key,
            prevSessionId: sessionId,
            prevProgress: task.progress,
          });

          // ---- 自动合成崩溃交接（ADR-7 L3）----
          // 关键：崩溃的 agent 已经死了，**不可能让它写交接**。
          // 系统必须从已有事件反推"做到哪了、接下来干什么"，否则新 agent 只能从零猜。
          // 必须在同一个写事务内：避免出现"任务已回收但没有交接"的空窗。
          synthesizeCrashHandoff(db, {
            projectKey: task.project_key,
            taskId: task.id,
            sessionId,
            lastSeenAt: zombie.last_seen_at,
            silentMs: now - zombie.last_seen_at,
            now,
          });
        }
      }
    },
    { now: () => now, projectKey: "system" },
  );

  return result;
}

/** 会话是否已判失联（用于 board / context 的告警展示） */
export function isStale(session: Session, now: number, graceMs: number): boolean {
  // 时钟回拨：last_seen_at 在未来视为新鲜
  if (session.lastSeenAt > now) return false;
  return now - session.lastSeenAt >= graceMs;
}

/** 构造带新鲜度的会话视图（board / context 用） */
export function toSessionView(
  db: Database,
  session: Session,
  opts: { now: number; graceMs: number; projectKey?: string },
): SessionView {
  // projectKey 传入时只列该 project 下的任务（board 视图需要）
  const taskRows = opts.projectKey
    ? db
        .query<{ id: string }, [string, string]>(
          "SELECT id FROM tasks WHERE assignee_session_id = ? AND project_key = ? ORDER BY seq",
        )
        .all(session.id, opts.projectKey)
    : db
        .query<{ id: string }, [string]>(
          "SELECT id FROM tasks WHERE assignee_session_id = ? ORDER BY seq",
        )
        .all(session.id);
  const freshMs = Math.max(0, opts.now - session.lastSeenAt);
  return {
    ...session,
    fresh: freshMs < 60_000 ? "just now" : `${Math.floor(freshMs / 60_000)}m ago`,
    stale: isStale(session, opts.now, opts.graceMs),
    tasks: taskRows.map((t) => t.id),
  };
}

/** 找出所有已失联但仍标记为 active 的会话（doctor 用） */
export function findStaleSessions(
  db: Database,
  opts: { graceMs: number; now?: number },
): Session[] {
  const now = opts.now ?? Date.now();
  return listSessions(db).filter(
    (s) => (s.status === "active" || s.status === "idle") && isStale(s, now, opts.graceMs),
  );
}

/** 会话状态名（给 board 展示用） */
export function sessionStatusLabel(status: SessionStatus): string {
  switch (status) {
    case "active":
      return "Active";
    case "idle":
      return "Idle";
    case "closed":
      return "Closed";
    case "crashed":
      return "Lost contact";
    default:
      return status;
  }
}
