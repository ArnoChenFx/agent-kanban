/**
 * 状态 → 颜色令牌 / 动态文案。
 *
 * 颜色一律用 CSS 变量名（var(--status-xxx)）而不是硬编码色值，
 * 这样换主题时只改 index.css，这里的代码不动。
 * CSS 里用 `color-mix()` 由同一个变量派生出淡底/边框/文字，
 * 所以每个状态只需要**一个**颜色定义。
 *
 * 语言相关的部分全部走 `t`：本文件不读全局状态，也不引入 React，
 * 只是"拿一个已经绑定好 locale 的翻译函数"——于是它仍然可以单测。
 * 颜色是纯静态的，留在模块常量里，渲染路径上零查表。
 */

import type { MessageKey, Translate } from "./i18n"
import type { TaskStatus } from "./api"

export interface StatusMeta {
  /** CSS 变量名（不含 var() 包装） */
  colorVar: string
  /** 该状态在词典里的键；文案要随语言变，所以不能在这里存成静态字符串 */
  labelKey: MessageKey
  /** 拖到该泳道时是否合法的说明文案键（状态机守卫，详见 docs/plan/001 §5.2） */
  hintKey?: MessageKey
}

export const STATUS_META: Record<TaskStatus, StatusMeta> = {
  backlog: { colorVar: "--status-backlog", labelKey: "status.backlog" },
  todo: { colorVar: "--status-todo", labelKey: "status.todo" },
  doing: { colorVar: "--status-doing", labelKey: "status.doing" },
  blocked: {
    colorVar: "--status-blocked",
    labelKey: "status.blocked",
    hintKey: "guard.hint.blocked",
  },
  review: {
    colorVar: "--status-review",
    labelKey: "status.review",
    hintKey: "guard.hint.review",
  },
  done: { colorVar: "--status-done", labelKey: "status.done" },
  cancelled: {
    colorVar: "--status-cancelled",
    labelKey: "status.cancelled",
    hintKey: "guard.hint.cancelled",
  },
}

/** 状态的中文名/英文名 */
export function statusLabel(status: TaskStatus, t: Translate): string {
  return t(STATUS_META[status].labelKey)
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
export function canMove(
  from: TaskStatus,
  to: TaskStatus,
  t: Translate,
): { ok: boolean; reason?: string } {
  if (from === to) return { ok: false, reason: t("guard.sameStatus") }
  if (to === "doing") {
    return { ok: false, reason: t("guard.toDoing") }
  }
  if (to === "blocked" || to === "cancelled") {
    return { ok: false, reason: t(STATUS_META[to].hintKey ?? "guard.needReason") }
  }
  if (to === "done" && from !== "review") {
    return { ok: false, reason: t("guard.toDone") }
  }
  if (from === "done" || from === "cancelled") {
    return { ok: false, reason: t("guard.terminal") }
  }
  return { ok: true }
}

/** 相对时间：与 CLI 的显示口径保持一致 */
export function relativeTime(ts: number, t: Translate, now = Date.now()): string {
  const diff = Math.max(0, now - ts)
  const min = Math.floor(diff / 60_000)
  if (min < 1) return t("time.justNow")
  if (min < 60) return t("time.minutesAgo", { n: min })
  const hour = Math.floor(min / 60)
  if (hour < 24) return t("time.hoursAgo", { n: hour })
  return t("time.daysAgo", { n: Math.floor(hour / 24) })
}

/** 租约剩余时间（可能已过期 → 显示"已过期"） */
export function leaseText(expiresAt: number | null, t: Translate, now = Date.now()): string | null {
  if (expiresAt === null) return null
  const diff = expiresAt - now
  if (diff <= 0) return t("time.leaseExpired")
  const min = Math.floor(diff / 60_000)
  if (min < 1) return t("time.leaseUnderMin")
  if (min < 60) return t("time.leaseMinutes", { n: min })
  return t("time.leaseHours", { n: Math.floor(min / 60) })
}

/** 事件 → 一句话（与后端 describeEventBrief 同口径）。
 *  resolveSession：把事件数据里的 session id 翻成"名字 + id"（如 handoff_consumed 的接管方）；
 *  不传或查不到就原样用 id。 */
export function describeEvent(
  type: string,
  data: Record<string, unknown>,
  t: Translate,
  resolveSession?: (id: string) => string,
): string {
  switch (type) {
    case "task_created":
      return t("event.task_created")
    case "task_claimed":
      return t("event.task_claimed")
    case "task_progress":
      // pct 缺失 = 纯文字备注（"更新进度"），三种情况拆三个键而不是在模板里做条件
      if (data.pct === undefined) return t("event.task_progress.generic")
      return data.note
        ? t("event.task_progress.note", { pct: String(data.pct), note: String(data.note) })
        : t("event.task_progress", { pct: String(data.pct) })
    case "task_note":
      return String(data.text ?? t("event.task_note"))
    case "task_blocked":
      return t("event.task_blocked", { reason: String(data.reason ?? "") })
    case "task_unblocked":
      return t("event.task_unblocked")
    case "task_released":
      return t("event.task_released")
    case "task_reclaimed":
      return data.forced === true
        ? t("event.task_reclaimed")
        : t("event.task_reclaimed.auto")
    case "task_review":
      return t("event.task_review")
    case "task_done":
      return t("event.task_done")
    case "task_cancelled":
      return t("event.task_cancelled")
    case "task_reopened":
      return t("event.task_reopened")
    case "task_removed":
      return t("event.task_removed")
    case "task_updated":
      return t("event.task_updated")
    case "dep_added":
      return t("event.dep_added", { id: String(data.depends_on_id ?? "") })
    case "dep_removed":
      return t("event.dep_removed", { id: String(data.depends_on_id ?? "") })
    case "plan_created":
      return t("event.plan_created")
    case "plan_superseded":
      return t("event.plan_superseded")
    case "handoff_created":
      return data.kind === "crash" ? t("event.handoff_created.crash") : t("event.handoff_created.manual")
    case "handoff_consumed": {
      const by = String(data.by_session ?? "?")
      return t("event.handoff_consumed", { by: resolveSession ? resolveSession(by) : by })
    }
    case "session_started":
      return t("event.session_started")
    case "session_closed":
      return t("event.session_closed")
    case "session_crashed":
      return t("event.session_crashed")
    default:
      // 未知事件类型原样透出：前端版本比服务端旧时，这里要能看出"是什么"
      return type
  }
}
