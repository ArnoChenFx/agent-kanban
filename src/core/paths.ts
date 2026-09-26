/**
 * 路径发现：定位项目级数据目录 `.kanban/`。
 *
 * 发现规则（契约 §1.1，优先级从高到低）：
 *   1. 环境变量 KANBAN_DB —— 直接指定 db 文件路径（测试与特例场景用）
 *   2. 命令行 --db     —— 同上
 *   3. 从 cwd 向上逐级查找 `.kanban/kanban.db`，最多 5 层（支持 monorepo：
 *      在 packages/foo 下执行命令也能找到仓库根的看板）
 *
 * 为什么要向上查找：agent 的 cwd 常常是子目录，而看板属于整个项目。
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { KanbanError } from "./errors.ts";

/** 数据目录名 */
export const KANBAN_DIR = ".kanban";
/** 主库文件名 */
export const DB_FILENAME = "kanban.db";
/** 会话便捷文件名（记录本机最近一次的 session_id） */
export const SESSION_FILENAME = "session";
/** 向上查找的最大层数 */
export const MAX_LOOKUP_DEPTH = 5;

export interface KanbanPaths {
  /** .kanban 目录绝对路径 */
  dir: string;
  /** 主库绝对路径 */
  db: string;
  /** 事件 journal 目录（入 git，跨机器恢复用） */
  journalDir: string;
  /** 计划归档目录（入 git，人可读） */
  plansDir: string;
  /** 看板快照目录（入 git，DB 丢失可参考） */
  snapshotsDir: string;
  /** 项目根目录（.kanban 的父目录） */
  projectRoot: string;
}

/**
 * 从给定起点向上查找 .kanban 目录。
 * 返回 null 表示在 MAX_LOOKUP_DEPTH 层内没找到（调用方决定是否报错）。
 */
export function findKanbanDir(startDir: string = process.cwd()): string | null {
  let current = resolve(startDir);
  for (let depth = 0; depth <= MAX_LOOKUP_DEPTH; depth++) {
    const candidate = join(current, KANBAN_DIR);
    if (existsSync(join(candidate, DB_FILENAME))) return candidate;
    const parent = dirname(current);
    // 已到文件系统根仍未命中
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * 宽松版目录发现：**只要 `.kanban` 目录存在**就算命中，不要求里面有数据库。
 *
 * 什么时候需要它：远程模式的项目，本地**没有** kanban.db（数据在 server 上），
 * 但仍然需要 `.kanban/config.toml` 存放 server 地址与 token。
 * 如果用严格版查找，远程项目会被当成“没初始化过”，导致 config set/show 报错。
 */
export function findKanbanDirLoose(startDir: string = process.cwd()): string | null {
  let current = resolve(startDir);
  for (let depth = 0; depth <= MAX_LOOKUP_DEPTH; depth++) {
    const candidate = join(current, KANBAN_DIR);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * 解析出完整路径集合。
 *
 * @param opts.db 显式指定的 db 路径（来自 --db 或 KANBAN_DB）
 * @param opts.cwd 查找起点，默认 process.cwd()
 * @param opts.mustExist 为 true 时找不到就抛 NOT_INIT(5)；`kanban init` 传 false
 */
export function resolvePaths(
  opts: { db?: string | undefined; cwd?: string; mustExist?: boolean } = {},
): KanbanPaths {
  const { db: explicitDb, cwd = process.cwd(), mustExist = true } = opts;

  // ---- 情形 1：显式指定 db 路径 ----
  if (explicitDb && explicitDb.length > 0) {
    const dbPath = isAbsolute(explicitDb) ? explicitDb : resolve(cwd, explicitDb);
    const dir = dirname(dbPath);
    return buildPaths(dir, dbPath);
  }

  // ---- 情形 2：向上查找 ----
  const found = findKanbanDir(cwd);
  if (!found) {
    if (!mustExist) {
      // init 场景：按 cwd 推定将要创建的位置
      return buildPaths(join(resolve(cwd), KANBAN_DIR), join(resolve(cwd), KANBAN_DIR, DB_FILENAME));
    }
    throw KanbanError.notInit(
      `未找到看板数据目录（在 ${cwd} 向上 ${MAX_LOOKUP_DEPTH} 层内没有 ${KANBAN_DIR}/${DB_FILENAME}）`,
      {
        hint: "在项目根目录运行 `kanban init` 初始化看板；已有 journal 可用 `kanban import` 恢复",
        cwd: resolve(cwd),
      },
    );
  }
  return buildPaths(found, join(found, DB_FILENAME));
}

/** 组装完整路径集合，并确保子目录已创建 */
function buildPaths(dir: string, dbPath: string): KanbanPaths {
  return {
    dir,
    db: dbPath,
    journalDir: join(dir, "journal"),
    plansDir: join(dir, "plans"),
    snapshotsDir: join(dir, "snapshots"),
    projectRoot: dirname(dir),
  };
}
