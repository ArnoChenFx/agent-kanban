/**
 * 备份与维护：export / import / snapshot / compact。
 *
 * ## 为什么要这些命令
 *
 * `.kanban/kanban.db` 是 gitignore 的（它是构建产物、含 token 哈希、体积不小），
 * 跨机器迁移只能靠“把事件流导出成 JSONL，再在新机器重放”。
 *
 * 这条路可行是因为 events 是唯一事实来源：导出事件 = 导出全部历史，
 * 新机器上重放 = 完整恢复，不需要备份二进制 SQLite 文件。
 *
 * ## 四者的分工
 *
 * | 命令 | 用途 | 什么时候需要 |
 * |---|---|---|
 * | `export`   | 事件流导出成 JSONL（按天分文件） | 迁移、审计、外部处理 |
 * | `import`   | 从 JSONL 重建库 | 换机器、DB 损坏后的恢复 |
 * | `snapshot` | 看板当前状态存成 JSON（人可读） | 想快速看“当时长什么样” |
 * | `compact`  | 裁剪旧事件以控制体积 | 事件表涨到影响日常操作 |
 *
 * compact 会**先自动 snapshot 再删**，因为裁剪是不可逆的。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ExitCode, KanbanError, type ExitCodeValue } from "../core/errors.ts";
import { style } from "../core/format.ts";
import { getConfig } from "../core/db.ts";
import { insertEvent, withTx } from "../core/tx.ts";
import { buildBoard } from "../core/board.ts";
import { listTasks } from "../core/tasks.ts";
import type { Scope } from "../core/tasks.ts";
import type { Database } from "bun:sqlite";

/** 导出/导入的一行：一个事件 */
interface JournalLine {
  ts: number;
  seq: number;
  type: string;
  session_id: string | null;
  task_id: string | null;
  plan_id: string | null;
  project_key: string;
  data: Record<string, unknown>;
}

interface EventRow {
  ts: number;
  seq: number;
  type: string;
  session_id: string | null;
  task_id: string | null;
  plan_id: string | null;
  project_key: string;
  data: string;
}

/** 读事件行（导出与 import 共用同一条查询，保证顺序一致） */
function readEvents(db: Database, opts: { projectKey?: string; sinceTs?: number } = {}): EventRow[] {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (opts.projectKey) {
    where.push("project_key = ?");
    params.push(opts.projectKey);
  }
  if (opts.sinceTs !== undefined) {
    where.push("ts >= ?");
    params.push(opts.sinceTs);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  return db
    .query<EventRow, Array<string | number>>(
      `SELECT ts, seq, type, session_id, task_id, plan_id, project_key, data
       FROM events ${clause} ORDER BY seq ASC`,
    )
    .all(...params);
}

/** UTC 日期 → YYYYMMDD。用 UTC 是为了跨时区导出时文件名稳定。 */
function dayStamp(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10).replace(/-/g, "");
}

// =============================================================================
// export
// =============================================================================

export interface ExportResult {
  files: string[];
  events: number;
  projects: string[];
}

export function exportEvents(
  db: Database,
  opts: { outDir: string; sinceTs?: number; projectKey?: string; now: number } = { outDir: "", now: 0 },
): ExportResult {
  const rows = readEvents(db, { sinceTs: opts.sinceTs, projectKey: opts.projectKey });
  if (rows.length === 0) {
    return { files: [], events: 0, projects: [] };
  }

  // 按天分文件：一次导出几万条时，单文件既难 diff 也难增量追加
  const byDay = new Map<string, JournalLine[]>();
  for (const row of rows) {
    const day = dayStamp(row.ts);
    const list = byDay.get(day) ?? [];
    list.push({
      ts: row.ts,
      seq: row.seq,
      type: row.type,
      session_id: row.session_id,
      task_id: row.task_id,
      plan_id: row.plan_id,
      project_key: row.project_key,
      data: safeParse(row.data),
    });
    byDay.set(day, list);
  }

  mkdirSync(opts.outDir, { recursive: true });
  const files: string[] = [];
  for (const day of [...byDay.keys()].sort()) {
    const file = join(opts.outDir, `events-${day}.jsonl`);
    const lines = (byDay.get(day) ?? []).map((e) => JSON.stringify(e)).join("\n");
    writeFileSync(file, `${lines}\n`, "utf8");
    files.push(file);
  }

  return {
    files,
    events: rows.length,
    projects: [...new Set(rows.map((r) => r.project_key))],
  };
}

// =============================================================================
// import
// =============================================================================

export interface ImportPlan {
  file: string;
  lines: number;
  /** 与库中已有 seq 重复的条数 */
  duplicates: number;
  /** 会引入的 project */
  projects: string[];
  error?: string;
}

export interface ImportOptions {
  dryRun?: boolean;
  now: number;
  /**
   * 把 journal 里的事件改写到哪个 project。
   *
   * 为什么必须有：project key 是从目录名派生的，所以新机器上的 key 与旧机器
   * 不会相同。而 rebuild / board / doctor 全都按 project_key 过滤——不重映射的话，
   * 事件确实进了库，但被当成“另一个 project 的历史”而永远读不到。
   * 跨机器恢复失败且毫无报错，就是踩在这里。
   */
  targetProjectKey?: string;
  /** 保留 journal 里的原始 project_key（多 project 迁移时用） */
  keepProject?: boolean;
}

export interface ImportResult {
  applied: number;
  plans: ImportPlan[];
  /** 实际发生重映射时：原 key → 新 key */
  remapped: Array<{ from: string; to: string }>;
}

/**
 * 从 JSONL 重建。
 *
 * 幂等：按 seq 去重。重复导入同一份 journal 不会产生重复事件，
 * 所以“新机器上再导一次”这种操作是安全的。
 */
export function importEvents(db: Database, files: string[], opts: ImportOptions): ImportResult {
  const plans: ImportPlan[] = [];
  const remapped = new Map<string, string>();
  let applied = 0;
  const keep = opts.keepProject ?? false;
  const target = opts.targetProjectKey;

  for (const file of files) {
    const plan: ImportPlan = { file, lines: 0, duplicates: 0, projects: [] };
    if (!existsSync(file)) {
      plan.error = "the file does not exist";
      plans.push(plan);
      continue;
    }

    let events: JournalLine[] = [];
    try {
      events = readJournalFile(file);
    } catch (e) {
      plan.error = `failed to parse: ${(e as Error).message}`;
      plans.push(plan);
      continue;
    }

    plan.lines = events.length;
    plan.projects = [...new Set(events.map((e) => e.project_key))];

    // 已有 seq 集合：一次查出来，避免逐条 SELECT
    const existing = new Set(
      db
        .query<{ seq: number }, []>("SELECT seq FROM events")
        .all()
        .map((r) => r.seq),
    );

    const fresh = events.filter((e) => {
      if (existing.has(e.seq)) {
        plan.duplicates++;
        return false;
      }
      existing.add(e.seq);
      return true;
    });

    // 先算出重映射表，让输出里能提前告知
    for (const e of events) {
      if (keep || !target || e.project_key === target) continue;
      remapped.set(e.project_key, target);
    }

    if (!opts.dryRun && fresh.length > 0) {
      withTx(
        db,
        (tx) => {
          for (const e of fresh) {
            const projectKey = keep ? e.project_key : (target ?? e.project_key);
            insertEvent(
              db,
              {
                type: e.type as never,
                taskId: e.task_id,
                planId: e.plan_id,
                sessionId: e.session_id,
                projectKey,
                data: e.data,
              },
              e.ts,
              e.session_id,
              projectKey,
            );
          }
        },
        { now: () => opts.now, maxRetries: 0 },
      );
      applied += fresh.length;
    }

    plans.push(plan);
  }

  return {
    applied,
    plans,
    remapped: [...remapped.entries()].map(([from, to]) => ({ from, to })),
  };
}

/** 读一个 journal 文件（每行一个 JSON；空行忽略） */
function readJournalFile(file: string): JournalLine[] {
  const raw = readFileSync(file, "utf8");
  const out: JournalLine[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as JournalLine);
    } catch (e) {
      throw new Error(`line ${i + 1} is not valid JSON: ${(e as Error).message}`);
    }
  }
  return out;
}

function safeParse(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    // 事件 data 永远是 JSON 对象（契约 §6），解析失败只可能是库被外部改坏
    return {};
  }
}

// =============================================================================
// snapshot
// =============================================================================

export interface Snapshot {
  version: 1;
  taken_at: number;
  project_key: string;
  tasks: unknown[];
  counts: Record<string, number>;
  head_seq: number;
}

/**
 * 写看板快照（人可读的 JSON）。
 *
 * 与 export 的区别：snapshot 是**当前状态**，import 不了；
 * export 是**事件流**，能重放。快照的价值是“想快速知道当时长什么样”，
 * 以及给 compact 留一份可回溯的记录。
 */
export function writeSnapshot(db: Database, scope: Scope, now: number): Snapshot {
  const tasks = listTasks(scope, { includeTerminal: true, limit: 100_000 });
  const counts: Record<string, number> = {};
  for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;

  const head = db
    .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM events WHERE project_key = ?")
    .get(scope.projectKey);

  const snap: Snapshot = {
    version: 1,
    taken_at: now,
    project_key: scope.projectKey,
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      body: t.body,
      status: t.status,
      priority: t.priority,
      progress: t.progress,
      labels: t.labels,
      checklist: t.checklist,
      assignee_session_id: t.assigneeSessionId,
      plan_id: t.planId,
      created_at: t.createdAt,
      updated_at: t.updatedAt,
      finished_at: t.finishedAt,
    })),
    counts,
    head_seq: head?.n ?? 0,
  };

  return snap;
}

// =============================================================================
// compact
// =============================================================================

export interface CompactResult {
  before: number;
  after: number;
  removed: number;
  cutoff_ts: number;
  snapshotFile: string;
}

/**
 * 裁剪旧事件。
 *
 * 安全约束：
 *  1. **先写快照**。裁剪不可逆，快照是唯一的回退依据。
 *  2. **不碰最近的**。默认留 30 天，且至少保留 1000 条（哪怕都很旧），
 *     否则“很久没用的库”会被裁到只剩骨架。
 *  3. **不裁进行中的任务**。它们的租约判定依赖事件。
 *  4. 需要重建投影时用 snapshot 恢复，不用事件。
 */
export function compactEvents(
  db: Database,
  opts: { keepDays: number; snapshotOut: string; now: number; projectKey: string; scope: Scope },
): CompactResult {
  const before = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()?.n ?? 0;
  const cutoff = opts.now - opts.keepDays * 86_400_000;

  // 保底：至少留下最近 1000 条（无论多旧）
  const floorSeq = db
    .query<{ seq: number | null }, []>(
      "SELECT seq FROM events ORDER BY seq DESC LIMIT 1 OFFSET 999",
    )
    .get()?.seq;

  // 进行中任务的事件一律保留：租约回收与 rebuild 都要读它们
  const liveTaskIds = listTasks(opts.scope, { includeTerminal: false, limit: 1000 })
    .map((t) => t.id);

  const clauses = ["ts < ?"];
  const params: Array<string | number> = [cutoff];
  if (floorSeq !== null && floorSeq !== undefined) {
    clauses.push("seq < ?");
    params.push(floorSeq);
  }
  if (liveTaskIds.length > 0) {
    clauses.push(`task_id NOT IN (${liveTaskIds.map(() => "?").join(",")})`);
    params.push(...liveTaskIds);
  }

  // 1) 先快照
  mkdirSync(dirname(opts.snapshotOut), { recursive: true });
  const snap = writeSnapshot(db, opts.scope, opts.now);
  writeFileSync(opts.snapshotOut, JSON.stringify(snap, null, 2), "utf8");

  // 2) 再裁剪
  const removed =
    db.query(`DELETE FROM events WHERE ${clauses.join(" AND ")}`).run(...params).changes;

  const after = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()?.n ?? 0;

  return { before, after, removed, cutoff_ts: cutoff, snapshotFile: opts.snapshotOut };
}

/** 列出一个目录下的所有 journal 文件（按文件名排序 = 按时间排序） */
export function listJournalFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^events-\d{8}\.jsonl$/.test(f))
    .sort()
    .map((f) => join(dir, f));
}

/** 统计目录里 journal 的总行数（给 import --dry-run 报告用） */
export function countJournalLines(dir: string): number {
  let n = 0;
  for (const f of listJournalFiles(dir)) {
    try {
      n += readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).length;
    } catch {
      // 读不了就当 0，dry-run 不该因为一个坏文件中断
    }
  }
  return n;
}

/** 供命令层用：确认目录里确实有东西 */
export function requireJournalDir(dir: string): void {
  const files = listJournalFiles(dir);
  if (files.length === 0) {
    throw KanbanError.state(`no journal files (events-YYYYMMDD.jsonl) in ${dir}`, {
      reason: "journal_not_found",
      hint: "Run `agent-kanban export` first, then import",
      dir,
    });
  }
}

/** 目录里的文件是否都能读（import 前置检查） */
export function verifyReadable(files: string[]): string[] {
  return files.filter((f) => {
    try {
      statSync(f);
      readFileSync(f, "utf8");
      return false;
    } catch {
      return true;
    }
  });
}

export { getConfig, buildBoard, ExitCode, style, mkdirSync, existsSync };
