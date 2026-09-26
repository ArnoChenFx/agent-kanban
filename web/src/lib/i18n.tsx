/**
 * 极简 i18n：自带词典，不引第三方依赖。
 *
 * 为什么不装 react-i18next：看板的可翻译面就这几十条文案，体积敏感，
 * 而 i18next 那套要带 namespace 解析、fallback 链、SSR 适配——
 * 全都用不上。自己写一个 200 行的模块，换来零依赖、可审计、离线可用。
 *
 * 三条约定：
 * 1. **键是契约**。`zh` 是唯一的键来源，`en` 被声明成 `Record<keyof typeof zh, string>`，
 *    少一条或多一条都会在 `tsc` 阶段报错，而不是上线后某语言露出一个 key。
 * 2. **插值用 `{name}`**，不做 ICU 复数。单复数在需要的地方（"还剩 1 项 / 1 left"）
 *    拆成两个键、在代码里选，避免为了一个数字引入整套复数语法。
 * 3. **词典只管界面文案**。任务标题、交接正文、agent 名等用户数据原样透传，
 *    不做翻译——那是内容，不是 chrome。
 *
 * 首次访问按 `navigator.language` 自动判定（只认语言前缀，en-US/en-GB 都算 en），
 * 之后以用户在顶栏的选择为准，写进 localStorage。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"

export type Locale = "zh" | "en"

/** 顶栏切换控件的取值顺序：中文在前（本项目母语），English 在后 */
export const LOCALES: readonly Locale[] = ["zh", "en"]

/**
 * 语言的自称（endonym）。
 * 切换按钮上写"中文 / English"而不是"中文 / 英文"——按对方自己的语言称呼它，
 * 母语者不需要翻译就知道那是自己的语言。
 */
export const LOCALE_NAME: Record<Locale, string> = {
  zh: "中文",
  en: "English",
}

/** 写进 `<html lang>` 的 BCP 47 值：中文用简体地区码，英文不锁地区 */
const HTML_LANG: Record<Locale, string> = { zh: "zh-CN", en: "en" }

const STORAGE_KEY = "kanban.locale"

/** 插值参数。允许传 number，调用点不用为了模板字符串先 String() 一遍。 */
export type TranslateParams = Record<string, string | number | undefined>

export type Translate = (key: string, params?: TranslateParams) => string

// ---------------------------------------------------------------------------
// 词典
// ---------------------------------------------------------------------------

/** 简体中文（键的唯一来源） */
const zh = {
  "app.title": "agent-kanban 看板",

  // ---- 通用 ----
  "common.cancel": "取消",
  "common.save": "保存",
  "common.create": "创建",
  "common.view": "查看",
  "common.empty": "空",
  "common.confirm": "确认",

  // ---- 语言切换 ----
  "locale.switch": "切换到 {name}",

  // ---- 顶栏 ----
  "board.selectProject": "选择 project",
  "board.newTask": "新建任务",
  "board.newTask.aria": "新建任务",
  "board.refresh": "刷新",
  "board.theme.aria": "切换亮暗",
  "board.theme.toLight": "切到浅色",
  "board.theme.toDark": "切到深色",
  "board.online": "实时",
  "board.offline": "离线",
  "board.logout": "退出",

  // ---- 空看板 ----
  "board.empty.title": "看板还是空的",
  // 命令本身单独一个键：它是 <code>，要保留等宽字形，不能跟解释文案溟在一起
  "board.empty.desc": "新建第一张卡，或在项目目录里执行",
  "board.empty.cmd": "agent-kanban task add \"...\"",

  // ---- 失联告警条 ----
  "board.zombie.title": "{n} 个会话失联",
  "board.zombie.line": "{agent}（{session}，{minutes} 分钟无心跳）持有 {tasks}",
  "board.zombie.noTask": "无任务",
  "board.zombie.cli": "CLI 接管：",
  "board.zombie.cliNote": "（进度会自动保留）",
  /** 顿号：中文列举用顿号，英文用逗号+空格——两种语言的列表标点本来就不一样 */
  "list.sep": "、",

  // ---- 命令行示例里的占位符（渲染在 <code> 里，随语言走） ----
  "cli.taskIdArg": "任务号",

  // ---- 右侧栏 ----
  "sidebar.handoffs": "交给你的交接",
  "sidebar.handoff.crash": "崩溃合成",
  "sidebar.handoff.manual": "主动",
  "sidebar.handoff.empty": "没有待接手的交接",
  "sidebar.sessions": "会话",
  "sidebar.next": "建议接下来",
  "sidebar.cliEquiv": "命令行等价",

  // ---- 任务状态 ----
  "status.backlog": "想法池",
  "status.todo": "待办",
  "status.doing": "进行中",
  "status.blocked": "阻塞",
  "status.review": "待评审",
  "status.done": "已完成",
  "status.cancelled": "已取消",

  // ---- 状态机守卫（拖不过去时告诉用户为什么） ----
  "guard.sameStatus": "状态未变",
  "guard.toDoing": "「进行中」必须先认领，请用卡片菜单的「认领任务」",
  "guard.needReason": "需要填写原因",
  "guard.toDone": "只有「待评审」能直接完成；从进行中完成请用卡片菜单的「完成」",
  "guard.terminal": "终态任务需要先「重新打开」才能改状态",
  "guard.hint.blocked": "转阻塞需要填原因，请用卡片菜单里的「标记阻塞」",
  "guard.hint.review": "需要先认领（claim）再提交评审",
  "guard.hint.cancelled": "取消需要填原因，请用卡片菜单里的「取消任务」",

  // ---- 相对时间 / 租约 ----
  "time.justNow": "刚刚",
  "time.minutesAgo": "{n}m 前",
  "time.hoursAgo": "{n}h 前",
  "time.daysAgo": "{n}d 前",
  "time.leaseExpired": "租约已过期",
  "time.leaseUnderMin": "租约剩 <1m",
  "time.leaseMinutes": "租约剩 {n}m",
  "time.leaseHours": "租约剩 {n}h",

  // ---- 卡片 ----
  "card.drag.aria": "拖动以调整状态",
  "card.dropHint": "松手后会提示原因",
  "card.menu.aria": "卡片操作",
  "card.checklistLeftOne": "还剩 1 项",
  "card.checklistLeft": "还剩 {n} 项",
  "card.waitingDeps": "等 {deps} 完成",
  "card.action.claim": "认领任务",
  "card.action.progress": "更新进度",
  "card.action.review": "提交评审",
  "card.action.done": "标记完成",
  "card.action.handoff": "写交接",
  "card.action.block": "标记阻塞",
  "card.action.unblock": "解除阻塞",
  "card.action.release": "释放（保留进度）",
  "card.action.reopen": "重新打开",
  "card.action.cancel": "取消任务",

  // ---- 详情抽屉 ----
  "detail.blockReason": "阻塞原因",
  "detail.created": "创建于 {time}",
  "detail.updated": "更新于 {time}",
  "detail.tab.timeline": "时间线",
  "detail.tab.handoff": "交接",
  "detail.tab.plan": "计划",
  "detail.cliEquivalent": "CLI 等价操作：",
  "detail.timeline.empty": "还没有事件",
  "detail.description": "描述",
  "detail.checklist.title": "检查项",
  "detail.checklist.count": "{done}/{total} 完成",
  "detail.links": "关联任务",
  "detail.parent": "父任务",
  "detail.dep.unfinished": "依赖（未完成）",
  "detail.dep.done": "依赖（已完成）",

  // ---- 交接卡片 ----
  "handoff.kind.crash": "崩溃自动合成",
  "handoff.kind.manual": "主动交接",
  "handoff.consumed": "{by} 已接手",
  "handoff.nextStep": "下一步：",
  "handoff.empty": "还没有交接记录",
  "handoff.emptyHint": "用卡片菜单的「写交接」给下一个 agent 留话",

  // ---- 会话面板 ----
  "sessions.empty": "还没有活跃会话",
  "sessions.stale": "失联",
  "sessions.active": "活跃",
  "sessions.holding": "持有 {tasks}",

  // ---- 冲突对话框 ----
  "conflict.title": "这张卡有人正在做",
  "conflict.holder": "持有者",
  "conflict.progress": "进度 {pct}%",
  "conflict.body":
    "强行抢过来会让两个 agent 同时改同一张卡。除非确认对方已经失联，否则换个任务做更稳妥。",
  "conflict.back": "算了，换一张",
  "conflict.force": "确认强行接管",

  // ---- 通知（toast） ----
  "toast.error.auth": "token 无效或已过期",
  "toast.error.authDesc": "重新登录一下",
  "toast.error.conflict": "被别的 agent 抢先了",
  "toast.error.busy": "数据库忙，请稍后重试",
  "toast.error.unknown": "未知错误",
  "toast.moveFailed": "这一步走不通",
  "toast.success.claim": "已认领 {id}",
  "toast.success.review": "已提交评审：{id}",
  "toast.success.done": "已完成：{id}",
  "toast.success.unblock": "已解除阻塞：{id}",
  "toast.success.release": "已释放（进度保留）：{id}",
  "toast.success.create": "任务已创建",
  "toast.success.progress": "进度已更新：{id}",
  "toast.success.handoff": "交接已记录，下一个会话会看到",
  "toast.success.force": "已强行接管 {id}（已记录 reclaimed 事件）",
  "toast.success.updated": "已更新",

  // ---- 新建任务对话框 ----
  "newTask.title": "新建任务",
  "newTask.desc": "标题说清\"要什么\"，检查项留给接手的人说\"怎么算做完\"。",
  "newTask.label.title": "标题",
  "newTask.placeholder.title": "实现崩溃自动合成",
  "newTask.label.body": "描述",
  "newTask.placeholder.body": "背景、约束、验收标准",
  "newTask.description.desc": "任务详情里会原样展示。写清“做完长什么样”，下一个 agent 就不用猜。",
  "newTask.label.priority": "优先级",
  "newTask.priority.highest": "（最高）",
  "newTask.priority.lowest": "（最低）",
  "newTask.label.labels": "标签",
  "newTask.label.checklist": "检查项",
  "newTask.placeholder.checklist": "补齐事件 payload,实现 rebuild",
  "newTask.checklist.desc": "逗号分隔。这些会成为崩溃恢复时的\"剩余工作\"。",
  "newTask.label.deps": "依赖的任务号",

  // ---- 原因对话框 ----
  "reason.block.title": "标记阻塞",
  "reason.block.desc":
    "阻塞需要人介入，说明白卡在哪，下一个 agent 才知道该不该换路。",
  "reason.cancel.title": "取消任务",
  "reason.cancel.desc": "取消是终态。写清原因，将来有人问起时能看到当时的判断。",
  "reason.reopen.title": "重新打开",
  "reason.reopen.desc": "重新打开会把任务拉回待办（进度保留）。",
  "reason.label": "原因",
  "reason.placeholder": "发生了什么？下一个 agent 需要知道什么？",
  "reason.desc": "必填。会写进事件时间线，接手的人靠它理解现场。",

  // ---- 进度对话框 ----
  "progress.title": "更新进度",
  "progress.pct": "进度：{pct}%",
  "progress.checklist": "勾选已完成的检查项",
  "progress.item": "第 {n} 项",
  "progress.checklistDesc": "按顺序勾选（后端按文字匹配，这里用序号代替）。",
  "progress.note": "备注",
  "progress.notePlaceholder": "这次推进做了什么？",

  // ---- 交接对话框 ----
  "handoffDialog.title": "写交接",
  "handoffDialog.legend": "交接四要素",
  "handoffDialog.summary": "做了什么（必填）",
  "handoffDialog.summaryPlaceholder": "完成 WAL 事务层，store.ts 20 个测试全绿",
  "handoffDialog.next": "建议下一步",
  "handoffDialog.nextPlaceholder": "实现 handoff 崩溃自动合成",
  "handoffDialog.blockers": "已知卡点",
  "handoffDialog.blockersPlaceholder": "依赖没装，WAL 文件归属待定",
  "handoffDialog.blockersDesc": "多个用逗号分隔。",
  "handoffDialog.open": "留给人的问题",
  "handoffDialog.openPlaceholder": "租约时长要不要按任务类型区分？",
  "handoffDialog.submit": "记录交接",

  // ---- API 客户端自己的错误（lib/api.ts，经 tActive 翻译） ----
  "api.error.unknown": "未知错误",
  "api.error.network": "连不上看板服务（网络错误）",
  "api.error.networkHint": "确认 agent-kanban serve 是否在运行",
  "api.error.badShape": "服务端返回的任务详情形状异常",

  // ---- 登录卡片 ----
  "login.title": "连接看板",
  "login.desc.before": "粘贴访问 token。它由管理员用",
  "login.desc.cmd": "agent-kanban admin token create",
  "login.desc.mid": "签发，或直接看 server 的 .kanban/config.toml 里的 admin_token。",
  "login.label.token": "访问 token",
  "login.label.project": "project（可选）",
  "login.placeholder.project": "留空则自动选第一个有权限的",
  "login.desc.project": "一个 token 可以授权多个 project。",
  "login.submit": "进入看板",
  "login.footer.before": "管理页面在",
  "login.footer.after": "（创建 project、签发 token）。本页只做看板。",

  // ---- 事件一句话（与后端 describeEventBrief 同口径） ----
  "event.task_created": "创建任务",
  "event.task_claimed": "认领任务",
  "event.task_progress": "进度 {pct}%",
  "event.task_progress.note": "进度 {pct}%（{note}）",
  "event.task_progress.generic": "更新进度",
  "event.task_note": "备注",
  "event.task_blocked": "标记阻塞：{reason}",
  "event.task_unblocked": "解除阻塞",
  "event.task_released": "被释放",
  "event.task_reclaimed": "被强制回收",
  "event.task_reclaimed.auto": "持有者失联，被自动回收",
  "event.task_review": "提交评审",
  "event.task_done": "完成",
  "event.task_cancelled": "取消",
  "event.task_reopened": "重新打开",
  "event.task_removed": "已删除",
  "event.task_updated": "更新元信息",
  "event.dep_added": "新增依赖 {id}",
  "event.dep_removed": "移除依赖 {id}",
  "event.plan_created": "保存计划",
  "event.plan_superseded": "计划被新版本顶替",
  "event.handoff_created.crash": "系统合成交接（崩溃恢复）",
  "event.handoff_created.manual": "写了交接",
  "event.handoff_consumed": "交接被 {by} 接手",
  "event.session_started": "会话启动",
  "event.session_closed": "会话结束",
  "event.session_crashed": "会话失联",
} satisfies Record<string, string>

/** 键的全集——`en` 必须在编译期补齐这每一个键 */
export type MessageKey = keyof typeof zh

/** English。类型写成 `Record<MessageKey, string>`：漏译是编译错误，不是线上事故。 */
const en: Record<MessageKey, string> = {
  "app.title": "agent-kanban Board",

  "common.cancel": "Cancel",
  "common.save": "Save",
  "common.create": "Create",
  "common.view": "View",
  "common.empty": "Empty",
  "common.confirm": "Confirm",

  "locale.switch": "Switch to {name}",

  "board.selectProject": "Select project",
  "board.newTask": "New task",
  "board.newTask.aria": "New task",
  "board.refresh": "Refresh",
  "board.theme.aria": "Toggle theme",
  "board.theme.toLight": "Switch to light",
  "board.theme.toDark": "Switch to dark",
  "board.online": "Live",
  "board.offline": "Offline",
  "board.logout": "Sign out",

  "board.empty.title": "This board is empty",
  "board.empty.desc": "Create the first card, or run this in the project directory:",
  "board.empty.cmd": "agent-kanban task add \"...\"",

  "board.zombie.title": "{n} unresponsive session(s)",
  "board.zombie.line": "{agent} ({session}, silent for {minutes} min) holds {tasks}",
  "board.zombie.noTask": "no tasks",
  "board.zombie.cli": "Take over from the CLI:",
  "board.zombie.cliNote": "(progress is preserved)",
  "list.sep": ", ",

  "cli.taskIdArg": "task-id",

  "sidebar.handoffs": "Handoffs for you",
  "sidebar.handoff.crash": "Auto-synthesized",
  "sidebar.handoff.manual": "Manual",
  "sidebar.handoff.empty": "No handoffs waiting",
  "sidebar.sessions": "Sessions",
  "sidebar.next": "Suggested next",
  "sidebar.cliEquiv": "CLI equivalents",

  "status.backlog": "Ideas",
  "status.todo": "To Do",
  "status.doing": "In Progress",
  "status.blocked": "Blocked",
  "status.review": "In Review",
  "status.done": "Done",
  "status.cancelled": "Cancelled",

  "guard.sameStatus": "The status did not change",
  "guard.toDoing": "Entering \"In Progress\" requires a claim — use \"Claim task\" in the card menu",
  "guard.needReason": "A reason is required",
  "guard.toDone":
    "Only \"In Review\" can be completed directly — to finish from \"In Progress\", use \"Mark done\" in the card menu",
  "guard.terminal": "A finished task must be reopened before its status can change",
  "guard.hint.blocked": "Blocking requires a reason — use \"Mark blocked\" in the card menu",
  "guard.hint.review": "Claim the task before submitting it for review",
  "guard.hint.cancelled": "Cancelling requires a reason — use \"Cancel task\" in the card menu",

  "time.justNow": "just now",
  "time.minutesAgo": "{n}m ago",
  "time.hoursAgo": "{n}h ago",
  "time.daysAgo": "{n}d ago",
  "time.leaseExpired": "Lease expired",
  "time.leaseUnderMin": "Lease <1m left",
  "time.leaseMinutes": "Lease {n}m left",
  "time.leaseHours": "Lease {n}h left",

  "card.drag.aria": "Drag to change status",
  "card.dropHint": "Drop to see why",
  "card.menu.aria": "Card actions",
  "card.checklistLeftOne": "1 left",
  "card.checklistLeft": "{n} left",
  "card.waitingDeps": "Waiting on {deps}",
  "card.action.claim": "Claim task",
  "card.action.progress": "Update progress",
  "card.action.review": "Submit for review",
  "card.action.done": "Mark done",
  "card.action.handoff": "Write handoff",
  "card.action.block": "Mark blocked",
  "card.action.unblock": "Unblock",
  "card.action.release": "Release (keep progress)",
  "card.action.reopen": "Reopen",
  "card.action.cancel": "Cancel task",

  "detail.blockReason": "Blocked because",
  "detail.created": "created {time}",
  "detail.updated": "updated {time}",
  "detail.tab.timeline": "Timeline",
  "detail.tab.handoff": "Handoffs",
  "detail.tab.plan": "Plan",
  "detail.cliEquivalent": "CLI equivalent:",
  "detail.timeline.empty": "No events yet",
  "detail.description": "Description",
  "detail.checklist.title": "Checklist",
  "detail.checklist.count": "{done}/{total} done",
  "detail.links": "Related tasks",
  "detail.parent": "Parent",
  "detail.dep.unfinished": "Blocked by (open)",
  "detail.dep.done": "Blocked by (done)",

  "handoff.kind.crash": "Auto-synthesized",
  "handoff.kind.manual": "Manual handoff",
  "handoff.consumed": "picked up by {by}",
  "handoff.nextStep": "Next step:",
  "handoff.empty": "No handoffs yet",
  "handoff.emptyHint": "Use \"Write handoff\" in the card menu to leave a note for the next agent",

  "sessions.empty": "No active sessions",
  "sessions.stale": "Unresponsive",
  "sessions.active": "Active",
  "sessions.holding": "Holding {tasks}",

  "conflict.title": "Someone is already on this card",
  "conflict.holder": "Held by",
  "conflict.progress": "{pct}% done",
  "conflict.body":
    "Forcing a takeover lets two agents edit the same card at once. Unless you are sure the other one is gone, working on a different task is safer.",
  "conflict.back": "Never mind",
  "conflict.force": "Force takeover",

  "toast.error.auth": "Token is invalid or expired",
  "toast.error.authDesc": "Sign in again",
  "toast.error.conflict": "Another agent got there first",
  "toast.error.busy": "Database busy, try again in a moment",
  "toast.error.unknown": "Unknown error",
  "toast.moveFailed": "That move is not allowed",
  "toast.success.claim": "Claimed {id}",
  "toast.success.review": "Submitted for review: {id}",
  "toast.success.done": "Done: {id}",
  "toast.success.unblock": "Unblocked: {id}",
  "toast.success.release": "Released (progress kept): {id}",
  "toast.success.create": "Task created",
  "toast.success.progress": "Progress updated: {id}",
  "toast.success.handoff": "Handoff recorded — the next session will see it",
  "toast.success.force": "Force-took {id} (a reclaimed event was recorded)",
  "toast.success.updated": "Updated",

  "newTask.title": "New task",
  "newTask.desc": "Make the title say what is needed; leave the checklist to say how \"done\" looks.",
  "newTask.label.title": "Title",
  "newTask.placeholder.title": "Implement crash-recovery synthesis",
  "newTask.label.body": "Description",
  "newTask.placeholder.body": "Background, constraints, acceptance criteria",
  "newTask.description.desc":
    "Shown as-is in the task detail. Say what \"done\" looks like so the next agent does not have to guess.",
  "newTask.label.priority": "Priority",
  "newTask.priority.highest": " (highest)",
  "newTask.priority.lowest": " (lowest)",
  "newTask.label.labels": "Labels",
  "newTask.label.checklist": "Checklist",
  "newTask.placeholder.checklist": "complete event payload, implement rebuild",
  "newTask.checklist.desc": "Comma-separated. These become the \"remaining work\" of crash recovery.",
  "newTask.label.deps": "Blocked by (task ids)",

  "reason.block.title": "Mark blocked",
  "reason.block.desc":
    "Blocking means a human has to step in. Say where it is stuck so the next agent knows whether to change course.",
  "reason.cancel.title": "Cancel task",
  "reason.cancel.desc": "Cancelling is terminal. Write down why — it is what someone will read if they ask later.",
  "reason.reopen.title": "Reopen",
  "reason.reopen.desc": "Reopening moves the task back to To Do (progress is preserved).",
  "reason.label": "Reason",
  "reason.placeholder": "What happened? What does the next agent need to know?",
  "reason.desc": "Required. It is written into the event timeline so whoever picks this up can read the situation.",

  "progress.title": "Update progress",
  "progress.pct": "Progress: {pct}%",
  "progress.checklist": "Tick off completed checklist items",
  "progress.item": "Item {n}",
  "progress.checklistDesc": "Tick in order (the backend matches by text, so items are numbered here).",
  "progress.note": "Note",
  "progress.notePlaceholder": "What did you get done this round?",

  "handoffDialog.title": "Write handoff",
  "handoffDialog.legend": "The four parts of a handoff",
  "handoffDialog.summary": "What you did (required)",
  "handoffDialog.summaryPlaceholder": "Finished the WAL transaction layer; all 20 store.ts tests pass",
  "handoffDialog.next": "Suggested next step",
  "handoffDialog.nextPlaceholder": "Implement handoff crash auto-synthesis",
  "handoffDialog.blockers": "Known blockers",
  "handoffDialog.blockersPlaceholder": "Dependency missing; WAL file ownership undecided",
  "handoffDialog.blockersDesc": "Separate multiple entries with commas.",
  "handoffDialog.open": "Questions for a human",
  "handoffDialog.openPlaceholder": "Should lease duration vary by task type?",
  "handoffDialog.submit": "Record handoff",

  // ---- API 客户端自己的错误 ----
  "api.error.unknown": "Unknown error",
  "api.error.network": "Cannot reach the board service (network error)",
  "api.error.networkHint": "Check that agent-kanban serve is running",
  "api.error.badShape": "The server returned an unexpected task-detail shape",

  "login.title": "Connect to the board",
  "login.desc.before": "Paste your access token. It is issued by an admin with",
  "login.desc.cmd": "agent-kanban admin token create",
  "login.desc.mid": ", or find admin_token in the server's .kanban/config.toml.",
  "login.label.token": "Access token",
  "login.label.project": "Project (optional)",
  "login.placeholder.project": "Leave blank to pick the first one you have access to",
  "login.desc.project": "A single token can be granted access to several projects.",
  "login.submit": "Enter the board",
  "login.footer.before": "The admin page lives at",
  "login.footer.after": " (create projects, issue tokens). This page is the board only.",

  "event.task_created": "Task created",
  "event.task_claimed": "Task claimed",
  "event.task_progress": "Progress {pct}%",
  "event.task_progress.note": "Progress {pct}% ({note})",
  "event.task_progress.generic": "Progress updated",
  "event.task_note": "Note",
  "event.task_blocked": "Marked blocked: {reason}",
  "event.task_unblocked": "Unblocked",
  "event.task_released": "Released",
  "event.task_reclaimed": "Force-reclaimed",
  "event.task_reclaimed.auto": "Owner went silent, auto-reclaimed",
  "event.task_review": "Submitted for review",
  "event.task_done": "Done",
  "event.task_cancelled": "Cancelled",
  "event.task_reopened": "Reopened",
  "event.task_removed": "Deleted",
  "event.task_updated": "Metadata updated",
  "event.dep_added": "Added dependency {id}",
  "event.dep_removed": "Removed dependency {id}",
  "event.plan_created": "Plan saved",
  "event.plan_superseded": "Plan superseded by a newer version",
  "event.handoff_created.crash": "Handoff auto-synthesized (crash recovery)",
  "event.handoff_created.manual": "Wrote a handoff",
  "event.handoff_consumed": "Handoff picked up by {by}",
  "event.session_started": "Session started",
  "event.session_closed": "Session ended",
  "event.session_crashed": "Session went silent",
}

const DICTS: Record<Locale, Record<MessageKey, string>> = { zh, en }

/**
 * 替换 `{name}` 占位符。
 *
 * 缺失的参数**保留占位符原样**（而不是塞成 "undefined"）：漏传参数在开发时是一眼
 * 可辨的 `{pct}`，上线后变成 "undefined" 只会被当成正常文案读过去。
 */
function interpolate(template: string, params?: TranslateParams): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name]
    return value === undefined ? whole : String(value)
  })
}

/**
 * 查表 + 插值。找不到键时依次退回英文、中文，最后才退回键本身。
 * 开发环境下同时打一条 warn，让漏译在浏览器控制台里立刻可见。
 */
function lookup(locale: Locale, key: string, params?: TranslateParams): string {
  const template = DICTS[locale][key as MessageKey] ?? DICTS.en[key as MessageKey] ?? zh[key as MessageKey]
  if (template === undefined) {
    if (import.meta.env?.DEV) console.warn(`[i18n] 词典里没有这个键：${key}`)
    return key
  }
  if (import.meta.env?.DEV && DICTS[locale][key as MessageKey] === undefined) {
    console.warn(`[i18n] ${locale} 缺少 ${key}，已退回 ${DICTS.en[key as MessageKey] ? "en" : "zh"}`)
  }
  return interpolate(template, params)
}

/** 读用户上次的选择；localStorage 不可用（隐私模式）时安静地当作没存过 */
function readStoredLocale(): Locale | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw === "zh" || raw === "en" ? raw : null
  } catch {
    return null
  }
}

/** 首次访问的默认语言：跟浏览器走，只比语言前缀（en-US / en-GB 都算 en） */
function detectLocale(): Locale {
  const stored = readStoredLocale()
  if (stored) return stored
  const lang = typeof navigator === "undefined" ? "" : navigator.language
  return lang.toLowerCase().startsWith("en") ? "en" : "zh"
}

/**
 * 把 locale 写进文档级属性。
 *
 * 单独抽出来是为了能在 render **之前**调用（见 main.tsx 的启动引导）：
 * `<html lang>` 决定浏览器的朗读语音与断词位置，等首帧之后再改就已经晚了一步。
 * `document.title` 同理——否则英文用户的标签页会先闪一下中文标题。
 */
export function applyLocaleToDocument(locale: Locale): void {
  if (typeof document === "undefined") return
  document.documentElement.lang = HTML_LANG[locale]
  document.title = interpolate(DICTS[locale]["app.title"])
}

/** 启动引导用：按当前应当生效的语言，先把文档属性摆正 */
export function primeDocumentLocale(): void {
  applyLocaleToDocument(detectLocale())
}

interface I18nContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
  /** 已绑定当前 locale 的翻译函数，传给 status.ts 这类纯函数用 */
  t: Translate
}

const I18nContext = createContext<I18nContextValue | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectLocale)

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // 存不进去也只影响"下次打开记不住"，不阻断切换
    }
  }, [])

  // 切换语言时同步文档级信息（lang / title），由 primeDocumentLocale 打底、这里跟到最新
  const t = useMemo<Translate>(() => (key, params) => lookup(locale, key, params), [locale])

  useEffect(() => {
    applyLocaleToDocument(locale)
    activeLocale = locale
  }, [locale])

  const value = useMemo<I18nContextValue>(() => ({ locale, setLocale, t }), [locale, setLocale, t])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext)
  // 不做兜底默认值：漏包 Provider 应该在第一次渲染就炸，而不是渲染出一屏 key
  if (!ctx) throw new Error("useI18n() 必须在 <I18nProvider> 内部使用")
  return ctx
}

/**
 * 模块级“当前语言”翻译函数，供**非组件**模块使用。
 *
 * 为什么需要它：`lib/api.ts` 是纯请求层，不能引 React，但它的 `ApiError`
 * 会在界面上直接显示（toast / 详情面板错误行）。把 `t` 一路当参数传进去
 * 需要改所有 fetch 包装函数的签名，代价远大于收益。
 *
 * 安全性：这是个单页应用，没有 SSR、不存在多实例并发。
 * Provider 在每次 locale 变化时同步这个变量，而它初始化时用的就是
 * `detectLocale()`，所以**首次渲染之前**它已经是对的。
 */
let activeLocale: Locale = detectLocale()

/** 供 lib/api.ts 等非组件模块翻译自己的错误文案 */
export function tActive(key: string, params?: TranslateParams): string {
  return lookup(activeLocale, key, params)
}
