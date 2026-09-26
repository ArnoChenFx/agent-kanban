/**
 * 任务详情抽屉。
 *
 * 为什么用 Sheet（侧边抽屉）而不是 Dialog：详情里有时间线、交接、计划三块长文本，
 * 弹窗会遮住看板——而看板的用处正是"一边看全局一边看单卡"。
 *
 * 这里是看板与"崩溃恢复"两条链路的交汇点：
 * 时间线回答"发生过什么"，交接回答"上一个 agent 想让你知道什么"。
 *
 * 概览（描述 / 检查项 / 依赖）刻意放在页签**上方**而不是再开一个页签：
 * 用户点开卡片九成是为了看"这活儿要做什么、还剩什么"，把它们藏在页签后面
 * 等于没显示——这正是"创建完就看不到描述与检查项"的老毛病。
 *
 * 语言：本文件与同目录其他组件一样只用 `t`；`Timeline` / `Handoffs` / `SessionsPanel`
 * 各自 `useI18n()`，不靠 props 传。
 */

import { useEffect, useState } from "react"
import {
  CheckIcon,
  CircleDotIcon,
  FileTextIcon,
  Link2Icon,
  ListChecksIcon,
  SquareIcon,
  TriangleAlertIcon,
  UserRoundIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  fetchTaskDetail,
  type ChecklistItem,
  type HandoffItem,
  type PlanItem,
  type SessionItem,
  type TaskDetail,
  type TaskItem,
} from "@/lib/api"
import type { KanbanEvent } from "@/lib/types"
import { useI18n } from "@/lib/i18n"
import { cn } from "@/lib/utils"
import { PRIORITY_LABEL, STATUS_META, describeEvent, relativeTime, statusLabel } from "@/lib/status"

export function TaskDetailSheet({
  task,
  token,
  project,
  tasksById,
  onSelect,
  onClose,
}: {
  task: TaskItem | null
  token: string
  project: string
  /** 当前看板上的任务索引：把依赖 / 父任务显示成"编号 + 标题"而不是光一个编号 */
  tasksById?: Map<string, TaskItem>
  /** 传入后依赖/父任务可点，直接跳到那张卡的详情 */
  onSelect?: (taskId: string) => void
  onClose: () => void
}) {
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { t } = useI18n()

  useEffect(() => {
    if (!task) {
      setDetail(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchTaskDetail(token, project, task.id)
      .then((d) => {
        if (!cancelled) setDetail(d)
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [task, token, project])

  const meta = task ? STATUS_META[task.status] : null

  return (
    <Sheet open={task !== null} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        {task && meta && (
          <>
            <SheetHeader>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="font-mono">
                  {task.id}
                </Badge>
                <Badge className="status-chip border-0" style={{ ["--chip-color" as string]: `var(${meta.colorVar})` }}>
                  {statusLabel(task.status, t)}
                </Badge>
                {task.priority <= 1 && <Badge variant="secondary">{PRIORITY_LABEL[task.priority]}</Badge>}
                {task.labels.map((l) => (
                  <Badge key={l} variant="outline">
                    {l}
                  </Badge>
                ))}
              </div>
              <SheetTitle className="text-xl leading-snug">{task.title}</SheetTitle>
              <SheetDescription>
                {`${task.progress}% · ${t("detail.created", { time: relativeTime(task.created_at, t) })}`}
                {task.updated_at && ` · ${t("detail.updated", { time: relativeTime(task.updated_at, t) })}`}
              </SheetDescription>
              {/* 进度条放进 header 而不是它的同级：
                  SheetContent 自身没有内边距（p-4 都在 SheetHeader/Footer 上），
                  放在同级时进度条会左右顶到抽屉边框、与描述和页签都没有空隙。
                  颜色跟着状态走，与卡片上的进度条保持一致（“进度 100% 的待评审卡”不该是绿的）。 */}
              {task.progress > 0 && (
                <Progress
                  value={task.progress}
                  className="text-primary mt-1.5 h-1"
                  style={{ color: `var(${meta.colorVar})` }}
                />
              )}
            </SheetHeader>

            {/* SheetContent 没有内边距，下面的内容统一收在这层里，避免顶到抽屉边框 */}
            <div className="flex flex-col gap-4 px-4">
              {task.block_reason && (
                <div className="text-destructive bg-destructive/8 flex items-start gap-2 rounded-md p-3 text-sm">
                  <TriangleAlertIcon className="mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium">{t("detail.blockReason")}</p>
                    <p>{task.block_reason}</p>
                  </div>
                </div>
              )}

              {loading && (
                <div className="flex flex-col gap-2">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-24 w-full" />
                </div>
              )}

              {error && <p className="text-destructive text-sm">{error}</p>}

              {/* 概览：描述 / 检查项 / 依赖。放在页签上方——这些是打开卡片就想看的东西 */}
              {detail && <Overview detail={detail} tasksById={tasksById} onSelect={onSelect} />}

              {detail && (
                <Tabs defaultValue="timeline">
                  <TabsList>
                    <TabsTrigger value="timeline">{t("detail.tab.timeline")}</TabsTrigger>
                    <TabsTrigger value="handoff">
                      {t("detail.tab.handoff")}
                      {detail.handoffs.length > 0 && (
                        <Badge variant="secondary" className="ml-1">
                          {detail.handoffs.length}
                        </Badge>
                      )}
                    </TabsTrigger>
                    {detail.plan && <TabsTrigger value="plan">{t("detail.tab.plan")}</TabsTrigger>}
                  </TabsList>

                  <TabsContent value="timeline">
                    <Timeline events={detail.timeline} />
                  </TabsContent>

                  <TabsContent value="handoff">
                    <Handoffs items={detail.handoffs} />
                  </TabsContent>

                  {detail.plan && (
                    <TabsContent value="plan">
                      <PlanView plan={detail.plan} />
                    </TabsContent>
                  )}
                </Tabs>
              )}
            </div>

            <SheetFooter className="mt-4">
              <p className="text-muted-foreground text-xs">
                {t("detail.cliEquivalent")} <code>agent-kanban task show {task.id}</code>
              </p>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

/**
 * 概览：描述 + 检查项 + 依赖 / 父任务。
 *
 * 这一块是 "task.get" 已经在返回、但之前**没人渲染**的数据：
 * 服务端 task.get 会带上 `body`、`checklist`（逐项，含 done_at/by）、`dependencies`，
 * 详情抽屉却只画了时间线/交接/计划，结果就是"填了描述、勾了检查项，回头什么都看不到"。
 *
 * 空值全部直接不渲染——描述、检查项、依赖都是可选的，没填就不该占一块灰。
 */
function Overview({
  detail,
  tasksById,
  onSelect,
}: {
  detail: TaskDetail
  tasksById?: Map<string, TaskItem>
  onSelect?: (taskId: string) => void
}) {
  const { t } = useI18n()
  const parentId = typeof detail.task.parent_id === "string" ? detail.task.parent_id : null
  // 关联任务：父任务在前、依赖在后（detail.related 已由 api 层归一化，含标题与完成状态）
  const related: Array<{ id: string; title: string; label: string; pending: boolean }> = [
    ...(parentId
      ? [{ id: parentId, title: tasksById?.get(parentId)?.title ?? "", label: t("detail.parent"), pending: false }]
      : []),
    ...detail.related.map((r) => ({
      id: r.id,
      // 服务端给了标题就用服务端的；没有（老服务端）再退回看板快照里查
      title: r.title || (tasksById?.get(r.id)?.title ?? ""),
      label: r.done ? t("detail.dep.done") : t("detail.dep.unfinished"),
      pending: !r.done,
    })),
  ]
  if (related.length === 0 && !detail.description && detail.checklist.length === 0) return null

  return (
    <div className="flex flex-col gap-4">
      {detail.description && (
        <section className="flex flex-col gap-1.5">
          <SectionTitle icon={FileTextIcon}>{t("detail.description")}</SectionTitle>
          {/* whitespace-pre-wrap：描述是自由文本（可能带换行与列表），
              不保留换行的话整段会挤成一行墙。不用 markdown 渲染器——
              描述是用户数据，当纯文本展示最安全。 */}
          <p className="text-sm whitespace-pre-wrap">{detail.description}</p>
        </section>
      )}

      {detail.checklist.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <SectionTitle icon={ListChecksIcon}>
            {t("detail.checklist.title")}
            <Badge variant="secondary" className="ml-1 font-mono text-[10px]">
              {t("detail.checklist.count", {
                done: detail.checklist.filter((c) => c.done).length,
                total: detail.checklist.length,
              })}
            </Badge>
          </SectionTitle>
          <ul className="flex flex-col gap-1">
            {detail.checklist.map((item, i) => (
              <ChecklistRow key={`${i}-${item.text}`} item={item} />
            ))}
          </ul>
        </section>
      )}

      {related.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <SectionTitle icon={Link2Icon}>{t("detail.links")}</SectionTitle>
          <ul className="flex flex-col gap-1 text-sm">
            {related.map((r) => (
              <li key={`${r.label}-${r.id}`}>
                <RelatedTask
                  id={r.id}
                  title={r.title}
                  onSelect={onSelect}
                  label={r.label}
                  pending={r.pending}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

/** 概览里的小节标题（图标 + 文字 + 可选尾巴） */
function SectionTitle({ icon: Icon, children }: { icon: React.ElementType; children: React.ReactNode }) {
  return (
    <h3 className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
      <Icon className="size-3.5 shrink-0" />
      {children}
    </h3>
  )
}

/** 检查项一行：勾了的划线 + 勾的人/时间（“谁勾的”是协作里最常被问的一个问题） */
function ChecklistRow({ item }: { item: ChecklistItem }) {
  const { t } = useI18n()
  return (
    <li className="flex items-start gap-2 text-sm">
      {item.done ? (
        <CheckIcon className="text-status-done mt-0.5 size-4 shrink-0" />
      ) : (
        <SquareIcon className="text-muted-foreground/50 mt-0.5 size-4 shrink-0" />
      )}
      <span className={cn("flex-1", item.done && "text-muted-foreground line-through")}>{item.text}</span>
      {item.done && (item.by || item.done_at) && (
        <span className="text-muted-foreground shrink-0 text-[11px]">
          {[item.by, item.done_at ? relativeTime(item.done_at, t) : null].filter(Boolean).join(" · ")}
        </span>
      )}
    </li>
  )
}

/**
 * 关联任务（依赖 / 父任务）一行。
 *
 * 状态标签（未完成/已完成）**可见**而不只是 title 提示：
 * “这条依赖还欠着”正是看关联任务的人最先要确认的事。
 * 能查到就在编号后补标题，能跳转就做成按钮；没有 onSelect 或本地没这张卡时退化成纯文本，
 * 不用 disabled 按钮占位。
 */
function RelatedTask({
  id,
  title,
  label,
  pending,
  onSelect,
}: {
  id: string
  title?: string
  label: string
  /** 依赖是否尚未完成（决定标签与配色） */
  pending: boolean
  onSelect?: (taskId: string) => void
}) {
  const content = (
    <>
      <span className="font-mono text-xs">{id}</span>
      {title && <span className="truncate">{title}</span>}
      <span className={cn("ml-auto shrink-0 text-[11px]", pending ? "text-status-todo" : "text-muted-foreground")}>
        {label}
      </span>
    </>
  )
  const cls = cn(
    "flex w-full items-center gap-2 rounded px-1.5 py-0.5 text-left text-sm",
    pending ? "text-status-todo" : "text-muted-foreground",
    onSelect && "hover:bg-muted/60 cursor-pointer",
  )
  // 没有 onSelect（或本地没这张卡）就退化成纯文本，不用 disabled 按钮占位
  if (!onSelect || !title) {
    return <span className={cls}>{content}</span>
  }
  return (
    <button type="button" className={cls} onClick={() => onSelect(id)}>
      {content}
    </button>
  )
}

function Timeline({ events }: { events: KanbanEvent[] }) {
  const { t } = useI18n()
  if (events.length === 0) {
    return <p className="text-muted-foreground py-8 text-center text-sm">{t("detail.timeline.empty")}</p>
  }
  return (
    <ScrollArea className="h-[26rem] pr-3">
      <ol className="flex flex-col gap-0">
        {[...events].reverse().map((e, i) => (
          <li key={e.seq} className="flex gap-3">
            {/* 时间线竖线：最后一个不画 */}
            <div className="flex flex-col items-center">
              <CircleDotIcon className="text-status-doing size-3.5 shrink-0" />
              {i < events.length - 1 && <div className="bg-border w-px flex-1" />}
            </div>
            <div className="flex flex-col gap-0.5 pb-4">
              <p className="text-sm">{describeEvent(e.type, e.data, t)}</p>
              <p className="text-muted-foreground text-[11px]">
                {relativeTime(e.ts, t)} · {e.session_id ?? "system"}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </ScrollArea>
  )
}

function Handoffs({ items }: { items: HandoffItem[] }) {
  const { t } = useI18n()
  if (items.length === 0) {
    return (
      <div className="text-muted-foreground flex flex-col items-center gap-2 py-8 text-center text-sm">
        <UserRoundIcon className="size-6" />
        <p>{t("handoff.empty")}</p>
        <p className="text-xs">{t("handoff.emptyHint")}</p>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-3">
      {[...items].reverse().map((h) => (
        <article
          key={h.id}
          className="bg-card flex flex-col gap-2 rounded-lg border p-3"
          style={{
            ["--chip-color" as string]:
              h.kind === "crash" ? "var(--status-stale)" : "var(--status-doing)",
          }}
        >
          <div className="flex items-center gap-2">
            <Badge className="status-chip border-0">
              {h.kind === "crash" ? t("handoff.kind.crash") : t("handoff.kind.manual")}
            </Badge>
            <span className="text-muted-foreground text-[11px]">
              {h.from_session} · {relativeTime(h.created_at, t)}
            </span>
            {h.consumed_by && (
              <Badge variant="outline" className="ml-auto text-[10px]">
                {t("handoff.consumed", { by: h.consumed_by })}
              </Badge>
            )}
          </div>
          <p className="text-sm">{h.summary}</p>
          {h.next_step && (
            <p className="text-muted-foreground text-sm">
              <span className="text-foreground font-medium">{t("handoff.nextStep")}</span>
              {h.next_step}
            </p>
          )}
          {h.blockers.length > 0 && (
            <ul className="text-destructive space-y-0.5 text-xs">
              {h.blockers.map((b, i) => (
                <li key={i}>· {b}</li>
              ))}
            </ul>
          )}
          {h.open_questions.length > 0 && (
            <ul className="text-status-todo space-y-0.5 text-xs">
              {h.open_questions.map((q, i) => (
                <li key={i}>? {q}</li>
              ))}
            </ul>
          )}
        </article>
      ))}
    </div>
  )
}

function PlanView({ plan }: { plan: PlanItem }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <FileTextIcon className="text-muted-foreground size-4" />
        <p className="text-sm font-medium">{plan.title}</p>
        <Badge variant="outline" className="ml-auto">
          v{plan.version} · {plan.status}
        </Badge>
      </div>
      <Separator />
      <pre className="text-muted-foreground bg-muted/40 max-h-[24rem] overflow-auto rounded-md p-3 font-mono text-xs whitespace-pre-wrap">
        {plan.body}
      </pre>
    </div>
  )
}

/** 会话面板：谁在做什么、谁失联了 */
export function SessionsPanel({
  sessions,
  tasksById,
}: {
  sessions: SessionItem[]
  tasksById: Map<string, TaskItem>
}) {
  const { t } = useI18n()
  if (sessions.length === 0) {
    return (
      <div className="text-muted-foreground flex flex-col items-center gap-2 py-6 text-center text-sm">
        <ListChecksIcon className="size-5" />
        <p>{t("sessions.empty")}</p>
      </div>
    )
  }
  return (
    <ul className="flex flex-col gap-2">
      {sessions.map((s) => (
        <li key={s.id} className="flex flex-col gap-1 rounded-md border p-2">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium">{s.agent_name}</span>
            <span className="text-muted-foreground font-mono text-[11px]">{s.id}</span>
            {s.stale ? (
              <Badge className="status-chip border-0" style={{ ["--chip-color" as string]: "var(--status-stale)" }}>
                {t("sessions.stale")}
              </Badge>
            ) : (
              <Badge variant="secondary" className="ml-auto text-[10px]">
                {/* 心跳时间优先用 last_seen_at 在前端自己格式化：后端的 fresh 是
                    中文串（"刚刚"），直接显示会在英文界面里露出来。
                    老服务端没带 last_seen_at 时才退回后端那个串。 */}
                {typeof s.last_seen_at === "number"
                  ? relativeTime(s.last_seen_at, t)
                  : (s.fresh ?? t("sessions.active"))}
              </Badge>
            )}
          </div>
          {s.tasks.length > 0 && (
            <p className="text-muted-foreground text-[11px]">
              {t("sessions.holding", {
                tasks: s.tasks.map((id) => tasksById.get(id)?.title ?? id).join(t("list.sep")),
              })}
            </p>
          )}
        </li>
      ))}
    </ul>
  )
}
