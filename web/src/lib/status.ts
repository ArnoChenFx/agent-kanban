/**
 * 状态 → 颜色令牌 / 文案的映射。
 *
 * 颜色一律用 CSS 变量名（var(--status-xxx)）而不是硬编码色值，
 * 这样换主题时只改 index.css，这里的代码不动。
 * CSS 里用 `color-mix()` 由同一个变量派生出淡底/边框/文字，
 * 所以每个状态只需要**一个**颜色定义。
 */

import type { TaskStatus } from "./api"

export interface StatusMeta {
  /** CSS 变量名（不含 var() 包装） */
  colorVar: string
  label: string
  /** 拖到该泳道时是否合法（状态机守卫，详见 docs/plan/001 §5.2） */
  /** 说明文案：拖不过去时告诉用户为什么 */
  blockedHint?: string
}

export const STATUS_META: Record<TaskStatus, StatusMeta> = {
  backlog: { colorVar: "--status-backlog", label: "想法池" },
  todo: { colorVar: "--status-todo", label: "待办" },
  doing: { colorVar: "--status-doing", label: "进行中" },
  blocked: {
    colorVar: "--status-blocked",
    label: "阻塞",
    blockedHint: "转阻塞需要填原因，请用卡片菜单里的「标记阻塞」",
  },
  review: {
    colorVar: "--status-review",
    label: "待评审",
    blockedHint: "需要先认领（claim）再提交评审",
  },
  done: { colorVar: "--status-done", label: "已完成" },
  cancelled: {
    colorVar: "--status-cancelled",
    label: "已取消",
    blockedHint: "取消需要填原因，请用卡片菜单里的「取消任务」",
  },
}

/** 泳道展示顺序：与人的阅读顺序一致（想法池 → 待办 → 进行中 → 阻塞 → 评审 → 完成） */
export const LANE_ORDER: TaskStatus[] = [
  "backlog",
  "todo",
  "doing",
  "blocked",
  "review",
  "done",
  "cancelled",
]

/** 卡片上要显色但不算"状态"的情况 */
export const STALE_VAR = "--status-stale"

/** 优先级：0 最高。用文字而不是只靠颜色区分（无障碍） */
export const PRIORITY_LABEL: Record<number, string> = {
  0: "P0",
  1: "P1",
  2: "P2",
  3: "P3",
  4: "P4",
}

/**
 * 拖拽合法性（前端预检）。
 *
 * 真正的守卫在后端状态机里，这里只是**提前**告诉用户"这一步走不通"，
 * 避免拖完才报错。规则对齐 docs/plan/001-总体设计.md §5.2：
 *   - doing 只能由 claim 进入，拖动不算 claim
 *   - blocked / cancelled 需要 reason
 *   - review → doing 是"评审打回"，与 claim 不同路径
 */
export function canMove(from: TaskStatus, to: TaskStatus): { ok: boolean; reason?: string } {
  if (from === to) return { ok: false, reason: "状态未变" }
  if (to === "doing") {
    return { ok: false, reason: "「进行中」必须先认领，请用卡片菜单的「认领任务」" }
  }
  if (to === "blocked" || to === "cancelled") {
    return { ok: false, reason: STATUS_META[to].blockedHint ?? "需要填写原因" }
  }
  if (to === "done" && from !== "review") {
    return { ok: false, reason: "只有「待评审」能直接完成；从进行中完成请用卡片菜单的「完成」" }
  }
  if (from === "done" || from === "cancelled") {
    return { ok: false, reason: "终态任务需要先「重新打开」才能改状态" }
  }
  return { ok: true }
}

/** 相对时间：与 CLI 的显示口径保持一致 */
export function relativeTime(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts)
  const min = Math.floor(diff / 60_000)
  if (min < 1) return "刚刚"
  if (min < 60) return `${min}m 前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour}h 前`
  return `${Math.floor(hour / 24)}d 前`
}

/** 租约剩余时间（可能已过期 → 显示"已过期"） */
export function leaseText(expiresAt: number | null, now = Date.now()): string | null {
  if (expiresAt === null) return null
  const diff = expiresAt - now
  if (diff <= 0) return "租约已过期"
  const min = Math.floor(diff / 60_000)
  if (min < 1) return "租约剩 <1m"
  if (min < 60) return `租约剩 ${min}m`
  return `租约剩 ${Math.floor(min / 60)}h`
}

/** 事件 → 一句话（与后端 describeEventBrief 同口径） */
export function describeEvent(type: string, data: Record<string, unknown>): string {
  switch (type) {
    case "task_created":
      return "创建任务"
    case "task_claimed":
      return "认领任务"
    case "task_progress":
      return data.pct !== undefined
        ? `进度 ${String(data.pct)}%${data.note ? `（${String(data.note)}）` : ""}`
        : "更新进度"
    case "task_note":
      return String(data.text ?? "备注")
    case "task_blocked":
      return `标记阻塞：${String(data.reason ?? "")}`
    case "task_unblocked":
      return "解除阻塞"
    case "task_released":
      return "被释放"
    case "task_reclaimed":
      return data.forced === true ? "被强制回收" : "持有者失联，被自动回收"
    case "task_review":
      return "提交评审"
    case "task_done":
      return "完成"
    case "task_cancelled":
      return "取消"
    case "task_reopened":
      return "重新打开"
    case "task_removed":
      return "已删除"
    case "task_updated":
      return "更新元信息"
    case "dep_added":
      return `新增依赖 ${String(data.depends_on_id ?? "")}`
    case "dep_removed":
      return `移除依赖 ${String(data.depends_on_id ?? "")}`
    case "plan_created":
      return "保存计划"
    case "plan_superseded":
      return "计划被新版本顶替"
    case "handoff_created":
      return data.kind === "crash" ? "系统合成交接（崩溃恢复）" : "写了交接"
    case "handoff_consumed":
      return `交接被 ${String(data.by_session ?? "?")} 接手`
    case "session_started":
      return "会话启动"
    case "session_closed":
      return "会话结束"
    case "session_crashed":
      return "会话失联"
    default:
      return type
  }
}
