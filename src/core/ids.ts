/**
 * ID 分配。
 *
 * 设计理由（ADR-3）：任务用 `T-0007` 这种人可读 ID，而不是 UUID。
 * 因为 agent 会在自然语言、提交信息、handoff 文本里反复引用任务号，
 * `T-0007` 可以直接读；UUID 会诱导 agent 编造不存在的 ID（幻觉的高发点）。
 *
 * 并发安全：任务序号在 **写事务内** 取 `MAX(seq)+1`。
 * 因为所有 ID 分配都发生在 BEGIN IMMEDIATE 事务中（写锁已持有），
 * 两个 agent 并发建任务不会拿到同一个 ID，不需要额外重试逻辑。
 * 并发测试见 test/concurrency.test.ts。
 */

import type { Database } from "bun:sqlite";
import { KanbanError } from "./errors.ts";

/** 任务 ID 序号部分的位数（支持 1..99999，超出后自然变宽：T-10000） */
const TASK_SEQ_WIDTH = 4;

/**
 * 分配任务 ID：T-0001 起递增，**per-project 独立计数**。
 *
 * 为什么 per-project：agent 口语里的 "T-0007" 必须只指向本 project 的卡。
 * 如果 ID 全局递增，project A 的 T-0042 和 project B 的 T-0043 会被不同 agent 混用，
 * “我改完了 T-0042”这句话就失去了指代能力。
 *
 * 为什么要计数器表而不是 MAX(id)+1：删除任务后 MAX 会回退，
 * 导致已删除的 ID 被重新分配，而历史事件/交接里仍引用它 → 审计链条断裂。
 * 计数器保证 ID 永不复用（与 SQLite AUTOINCREMENT 同思路）。
 *
 * 并发安全：必须在写事务内调用（依赖写锁保证唯一）。并发测试见 test/concurrency.test.ts。
 */
export function nextTaskId(db: Database, projectKey: string): string {
  // 首次使用时计数器行不存在：INSERT OR IGNORE 写入初值 1
  db.query("INSERT OR IGNORE INTO project_counters (project_key, next_task_num) VALUES (?, 1)").run(
    projectKey,
  );
  // 取出并递增（在同一事务内，读-改-写被写锁保护）
  const row = db
    .query<{ next_task_num: number }, [string]>(
      "SELECT next_task_num FROM project_counters WHERE project_key = ?",
    )
    .get(projectKey);
  const num = row?.next_task_num ?? 1;
  db.query("UPDATE project_counters SET next_task_num = ? WHERE project_key = ?").run(
    num + 1,
    projectKey,
  );
  return `T-${String(num).padStart(TASK_SEQ_WIDTH, "0")}`;
}

/**
 * 分配会话 ID：s- + base36(6 位)。
 * 用随机数而非自增：会话是"临时身份"，不需要可读有序，自增反而会泄露
 * "这个项目历史上开过多少会话"。
 */
export function newSessionId(random: () => number = Math.random): string {
  let suffix = "";
  for (let i = 0; i < 6; i++) {
    suffix += Math.floor(random() * 36).toString(36);
  }
  return `s-${suffix}`;
}

/**
 * 分配项目级计划 ID：PL-0001 起递增（per-project 独立）。
 * 必须在写事务内调用。
 */
export function nextProjectPlanId(db: Database, projectKey: string): string {
  const row = db
    .query<{ n: number | null }, [string]>(
      `SELECT MAX(version) AS n FROM plans WHERE scope = 'project' AND project_key = ?`,
    )
    .get(projectKey);
  const next = (row?.n ?? 0) + 1;
  return `PL-${String(next).padStart(4, "0")}`;
}

/**
 * 任务级计划 ID：PL-T-0007-03（任务 ID + 版本号）。
 * 版本号由该任务已有的 plan 数量决定（同一任务内自增，从 1 开始）。
 * 必须在写事务内调用。
 */
export function nextTaskPlanId(db: Database, projectKey: string, taskId: string): string {
  const row = db
    .query<{ n: number | null }, [string, string]>(
      `SELECT MAX(version) AS n FROM plans WHERE scope = 'task' AND project_key = ? AND task_id = ?`,
    )
    .get(projectKey, taskId);
  const version = (row?.n ?? 0) + 1;
  return `PL-${taskId}-${String(version).padStart(2, "0")}`;
}

/** 判断字符串是否形如 T-0007（用于输入校验，给 agent 友好的报错） */
export function isTaskId(value: string): boolean {
  return /^T-\d+$/i.test(value);
}

/**
 * 归一化任务 ID：允许 agent 传 t-7 / t-0007，统一成 T-0007。
 *
 * 输入防御：core 层的其他函数会直接调 normalizeTaskId，而参数可能来自
 * agent 的 JSON / CLI 位置参数 / MCP tool args。若上游传了非字符串（例如
 * 某个工具把整个 task 对象当 id 传下来），这里应给出可理解的 USAGE 错误，
 * 而不是让 `.trim is not a function` 这种内部错误漏到用户面前。
 */
export function normalizeTaskId(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw KanbanError.usage(
      `任务号必须是形如 T-0007 的字符串，收到 ${JSON.stringify(value)}`,
      "用法：T-0007（大小写与前导零会自动归一化，t-7 与 t-0007 等价）",
    );
  }
  const trimmed = value.trim().toUpperCase();
  if (!trimmed.startsWith("T-")) return `T-${trimmed}`;
  // 数字部分去掉前导零再补齐到 4 位，让 t-7 与 t-0007 指向同一张卡
  const digits = trimmed.slice(2).replace(/^0+(?=\d)/, "");
  return `T-${digits.padStart(TASK_SEQ_WIDTH, "0")}`;
}
