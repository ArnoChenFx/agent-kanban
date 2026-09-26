/**
 * doctor —— 一致性自检与自动修复。
 *
 * 定位：不是"定期体检报告"，而是**回答一个问题**：
 * "看板现在的状态，有没有和实际发生的事对不上的地方？"
 *
 * 检查项分两类：
 * - **可自动修复**：状态层面的不一致（租约过期没回收、依赖满足却还阻塞着）
 * - **仅报告**：需要人判断的（progress 与 checklist 对不上、有卡长期没进展）
 *
 * 关键设计：轻量检查（reapZombies）已经在每次 CLI 调用时隐式执行，
 * 所以 doctor 的默认（不传 --deep）只做快速核对；--deep 才做全量比对。
 */

import type { Database } from "bun:sqlite";
import { getConfig } from "./db.ts";
import { isStale, listSessions } from "./sessions.ts";
import { countEvents } from "./events.ts";
import {
  countByStatus,
  getUnfinishedDeps,
  listTasks,
  type Scope,
} from "./tasks.ts";
import { countPendingHandoffs } from "./handoff.ts";
import {
  inspectProtocol,
  resolveProtocolFile,
  PROTOCOL_ISSUE_MISSING,
  PROTOCOL_ISSUE_OUTDATED,
} from "./protocol.ts";

/** 单个问题 */
export interface DoctorIssue {
  /** 问题代码（稳定，便于脚本处理） */
  code: string;
  /** 人可读描述 */
  message: string;
  /** 涉及的实体（任务号/session） */
  subjects: string[];
  /** 是否已被 --fix 修复 */
  fixed: boolean;
  /** 修复建议（未修复时该做什么） */
  hint: string;
  severity: "error" | "warning" | "info";
}

/** 自检报告 */
export interface DoctorReport {
  project_key: string;
  checked_at: number;
  deep: boolean;
  ok: boolean;
  issues: DoctorIssue[];
  /** 概览数据（即使没发现问题也返回，方便 `--json` 消费） */
  stats: {
    tasks: Record<string, number>;
    events: number;
    sessions: number;
    active_sessions: number;
    stale_sessions: number;
    pending_handoffs: number;
  };
}

export interface DoctorOptions {
  projectKey: string;
  deep?: boolean;
  /** 自动修复可修复项 */
  fix?: boolean;
  now?: number;
  graceMs?: number;
  /**
   * 项目根目录；存在时才会检查 AGENTS.md 协议区块。
   * 远程模式下 client 本地没有 .kanban，不该对别人的仓库报“协议缺失”。
   */
  projectRoot?: string;
}

/** 执行自检 */
export function runDoctor(db: Database, opts: DoctorOptions): DoctorReport {
  const now = opts.now ?? Date.now();
  const deep = opts.deep ?? false;
  const fix = opts.fix ?? false;
  const graceMs = opts.graceMs ?? getConfig(db).graceMs;
  const scope: Scope = { db, projectKey: opts.projectKey };
  const issues: DoctorIssue[] = [];

  const allTasks = listTasks(scope, { includeTerminal: true, limit: 5000 });
  const activeTasks = allTasks.filter((t) => t.status === "doing");
  const blockedTasks = allTasks.filter((t) => t.status === "blocked");
  const sessions = listSessions(db);
  const activeSessions = sessions.filter((s) => s.status === "active" || s.status === "idle");
  const staleSessions = activeSessions.filter((s) => isStale(s, now, graceMs));

  // ---- 1. doing 但持有者已失联（租约过期未回收）----
  const orphanTasks = activeTasks.filter((t) => {
    if (!t.assigneeSessionId) return true; // doing 却无人持有：一定是异常
    const holder = sessions.find((s) => s.id === t.assigneeSessionId);
    if (!holder) return true; // 持有者会话行不存在
    return isStale(holder, now, graceMs);
  });
  if (orphanTasks.length > 0) {
    const fixedCount = fix ? releaseOrphans(db, orphanTasks, now) : 0;
    issues.push({
      code: "stale_lease",
      message:
        fixedCount > 0
          ? `${orphanTasks.length} task(s) had holders who lost contact, reclaimed automatically (progress kept)`
          : `${orphanTasks.length} task(s) are in progress but their holder lost contact`,
      subjects: orphanTasks.map((t) => t.id),
      fixed: fixedCount > 0,
      hint: fix ? "" : "Run `agent-kanban doctor --fix` to reclaim them (progress is kept), or `agent-kanban resume <task-id>` to take over",
      severity: fixedCount > 0 ? "info" : "warning",
    });
  }

  // ---- 2. blocked 但依赖已全部完成（应该自动解除）----
  const unblockedCandidates = blockedTasks.filter(
    (t) => getUnfinishedDeps(scope, t.id).length === 0,
  );
  if (unblockedCandidates.length > 0) {
    const fixedCount = fix
      ? db
          .query(
            `UPDATE tasks SET status = 'todo', block_reason = NULL, updated_at = ?
              WHERE project_key = ? AND status = 'blocked'
                AND id IN (${unblockedCandidates.map(() => "?").join(",")})`,
          )
          .run(now, opts.projectKey, ...unblockedCandidates.map((t) => t.id)).changes
      : 0;
    issues.push({
      code: "stale_block",
      message:
        fixedCount > 0
          ? `${fixedCount} task(s) had all dependencies completed, unblocked automatically`
          : `${unblockedCandidates.length} task(s) are blocked even though all dependencies are completed`,
      subjects: unblockedCandidates.map((t) => t.id),
      fixed: fixedCount > 0,
      hint: fix ? "" : "Run `agent-kanban doctor --fix` to unblock them automatically, or `agent-kanban task unblock <task-id>`",
      severity: fixedCount > 0 ? "info" : "warning",
    });
  }

  // ---- 3. 长期无进展的进行中任务（需要人关注，不可自动修）----
  const STALE_PROGRESS_MS = 4 * 60 * 60 * 1000; // 4 小时
  const stalled = activeTasks.filter(
    (t) => !orphanTasks.includes(t) && now - t.updatedAt > STALE_PROGRESS_MS,
  );
  if (stalled.length > 0) {
    issues.push({
      code: "no_progress",
      message: `${stalled.length} task(s) have not updated their progress for over 4 hours`,
      subjects: stalled.map((t) => t.id),
      fixed: false,
      hint: "Check whether they are stuck; explain with `agent-kanban task note <task-id> \"currently stuck on ...\"`, or mark them blocked with `agent-kanban task block --reason`",
      severity: "warning",
    });
  }

  // ---- 4. progress 与 checklist 不一致（仅报告）----
  const inconsistent = allTasks.filter((t) => {
    if (t.checklist.length === 0) return false;
    const doneRatio = t.checklist.filter((c) => c.done).length / t.checklist.length;
    const expected = Math.round(doneRatio * 100);
    // 容忍 10% 误差（agent 可能手动设了 pct）
    return Math.abs(expected - t.progress) > 10 && t.progress !== 100;
  });
  if (inconsistent.length > 0) {
    issues.push({
      code: "progress_mismatch",
      message: `${inconsistent.length} task(s) have a progress value far from their checklist completion ratio`,
      subjects: inconsistent.slice(0, 10).map((t) => t.id),
      fixed: false,
      hint: "Fix it with `agent-kanban task progress <task-id> --pct <correct value>`, or verify with `agent-kanban task show <task-id> --timeline`",
      severity: "info",
    });
  }

  // ---- 5. 孤儿检查：checklist 未完成但已 done ----
  const doneWithRemaining = allTasks.filter(
    (t) => t.status === "done" && t.checklist.some((c) => !c.done),
  );
  if (doneWithRemaining.length > 0) {
    issues.push({
      code: "done_with_remaining",
      message: `${doneWithRemaining.length} task(s) are marked done but still have unchecked checklist items`,
      subjects: doneWithRemaining.map((t) => t.id),
      fixed: false,
      hint: "If they really are done, tick the rest with `agent-kanban task progress --check \"<item>\"`; if they were marked done by mistake, `agent-kanban task reopen --reason`",
      severity: "info",
    });
  }

  // ---- 6. 深度检查：投影与事件一致性 ----
  if (deep) {
    const projIssue = checkProjectionConsistency(db, scope);
    if (projIssue) issues.push(projIssue);
  }

  // ---- 7. 协作协议是否落后于当前 CLI ----
  // agent 靠 AGENTS.md 里的受管区块知道怎么用看板。升级了 kanban 却不更新，
  // agent 会照着旧协议执行已经不存在的命令。只能提示，不能自动修。
  const protocolIssue = checkProtocol(opts.projectRoot);
  if (protocolIssue) issues.push(protocolIssue);

  const stats = {
    tasks: countByStatus(scope),
    events: countEvents(db, opts.projectKey),
    sessions: sessions.length,
    active_sessions: activeSessions.length,
    stale_sessions: staleSessions.length,
    pending_handoffs: countPendingHandoffs(scope),
  };

  return {
    project_key: opts.projectKey,
    checked_at: now,
    deep,
    ok: issues.every((i) => i.severity !== "error" || i.fixed),
    issues,
    stats,
  };
}

/**
 * 检查 AGENTS.md 里的协作协议区块是否落后于当前 CLI。
 *
 * 不自动修：协议内容是给人读的 Markdown，`--fix` 静默改掉它会让人
 * 不知道自己看过的东西变了。缺失时给出安装命令让人自己决定。
 */
function checkProtocol(projectRoot: string | undefined): DoctorIssue | null {
  if (!projectRoot) return null;
  const insp = inspectProtocol(resolveProtocolFile(projectRoot));
  if (insp.status === "up_to_date") return null;

  return {
    code: insp.status === "outdated" ? PROTOCOL_ISSUE_OUTDATED : PROTOCOL_ISSUE_MISSING,
    message:
      insp.status === "outdated"
        ? `the collaboration protocol in AGENTS.md is outdated (protocol ${insp.installedVersion}, current ${insp.currentVersion})`
        : `AGENTS.md has no collaboration protocol block, so agents do not know to run agent-kanban context before starting`,
    subjects: [insp.file],
    fixed: false,
    hint: "Run `agent-kanban install-protocol` to update it (only the managed block is touched, the rest of the file is left alone)",
    severity: "warning",
  };
}

/** 回收失联持有者的任务（progress/checklist 保留） */
function releaseOrphans(
  db: Database,
  tasks: Array<{ id: string; projectKey?: string }>,
  now: number,
): number {
  let fixed = 0;
  for (const task of tasks) {
    const result = db
      .query(
        `UPDATE tasks
            SET status = 'todo', assignee_session_id = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE id = ? AND status = 'doing'`,
      )
      .run(now, task.id);
    if (result.changes > 0) {
      fixed++;
      db.query(
        `INSERT INTO events (ts, session_id, type, task_id, plan_id, project_key, data)
         VALUES (?, 'system', 'task_reclaimed', ?, NULL, ?, ?)`,
      ).run(
        now,
        task.id,
        task.projectKey ?? "system",
        JSON.stringify({ holder_crashed: true, fixed_by: "doctor" }),
      );
    }
  }
  return fixed;
}

/**
 * 深度检查：投影与事件流是否一致（ADR-1 的正确性验证）。
 *
 * 做法：重放事件得到的状态 vs 实际 tasks 表的 status/progress/assignee。
 * 两者不一致说明有绕过 core 的直接写库操作（或有 bug）。
 */
function checkProjectionConsistency(db: Database, scope: Scope): DoctorIssue | null {
  const mismatches: string[] = [];

  for (const task of listTasks(scope, { includeTerminal: true, limit: 5000 })) {
    // 取该任务最后一个状态变更事件
    const last = db
      .query<{ type: string; data: string | null }, [string]>(
        `SELECT type, data FROM events
          WHERE task_id = ? AND type IN
            ('task_created','task_claimed','task_blocked','task_unblocked',
             'task_review','task_done','task_cancelled','task_reopened','task_released','task_reclaimed')
          ORDER BY seq DESC LIMIT 1`,
      )
      .get(task.id);
    if (!last) continue;

    // 终态任务不做状态比对（最后事件可能是 progress，与 status 无关）
    if (task.status === "done" || task.status === "cancelled") continue;

    const expected = expectedStatusAfter(last.type, task.status);
    if (expected !== null && expected !== task.status) {
      mismatches.push(`${task.id}(event→${expected}, actual ${task.status})`);
    }
  }

  if (mismatches.length === 0) return null;

  return {
    code: "projection_drift",
    message: `${mismatches.length} task(s) have a status that disagrees with what the event stream implies (maybe someone wrote to the database directly, bypassing core)`,
    subjects: mismatches.slice(0, 10),
    fixed: false,
    hint: "Run `agent-kanban rebuild` to rebuild the projection from the event stream (it overwrites the tasks table, so back up first)",
    severity: "error",
  };
}

/** 根据最后的状态事件推导应该是什么状态 */
function expectedStatusAfter(
  eventType: string,
  currentStatus: string,
): string | null {
  switch (eventType) {
    case "task_created":
      return "todo"; // 若是 backlog 创建则不匹配（会报出，属正常）
    case "task_claimed":
      return "doing";
    case "task_blocked":
      return "blocked";
    case "task_unblocked":
    case "task_released":
    case "task_reclaimed":
      return "todo";
    case "task_review":
      return "review";
    case "task_reopened":
      return "todo";
    default:
      // progress/note 等不改变状态的事件
      return currentStatus === "doing" ? "doing" : null;
  }
}

/** 人类可读的报告（CLI 用） */
export function formatDoctorReport(report: DoctorReport): string[] {
  const lines: string[] = [];
  const s = report.stats;
  lines.push(
    `project ${report.project_key}  ` +
      `tasks ${Object.values(s.tasks).reduce((a, b) => a + b, 0)} · ` +
      `events ${s.events} · sessions ${s.active_sessions}/${s.sessions} active` +
      (s.stale_sessions > 0 ? ` (${s.stale_sessions} lost contact)` : "") +
      (s.pending_handoffs > 0 ? ` · pending handoffs ${s.pending_handoffs}` : ""),
  );

  if (report.issues.length === 0) {
    lines.push("✓ no issues found");
    return lines;
  }

  for (const issue of report.issues) {
    const mark = issue.fixed ? "✓" : issue.severity === "error" ? "✗" : "⚠";
    lines.push(`${mark} [${issue.code}] ${issue.message}`);
    if (issue.subjects.length > 0) {
      lines.push(`    ${issue.subjects.slice(0, 8).join(" ")}${issue.subjects.length > 8 ? " …" : ""}`);
    }
    if (issue.hint) lines.push(`    ${issue.hint}`);
  }
  return lines;
}
