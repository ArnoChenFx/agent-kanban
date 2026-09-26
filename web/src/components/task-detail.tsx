/**
 * 任务详情抽屉。
 *
 * 为什么用 Sheet（侧边抽屉）而不是 Dialog：详情里有时间线、交接、计划三块长文本，
 * 弹窗会遮住看板——而看板的用处正是"一边看全局一边看单卡"。
 *
 * 这里是看板与"崩溃恢复"两条链路的交汇点：
 * 时间线回答"发生过什么"，交接回答"上一个 agent 想让你知道什么"。
 */

import { useEffect, useState } from "react"
import {
  CircleDotIcon,
  FileTextIcon,
  ListChecksIcon,
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
import { fetchTaskDetail, type HandoffItem, type PlanItem, type TaskItem } from "@/lib/api"
import type { KanbanEvent } from "@/lib/types"
import { PRIORITY_LABEL, STATUS_META, describeEvent, relativeTime } from "@/lib/status"

export function TaskDetailSheet({
  task,
  token,
  project,
  onClose,
}: {
  task: TaskItem | null
  token: string
  project: string
  onClose: () => void
}) {
  const [detail, setDetail] = useState<{
    task: Record<string, unknown>
    timeline: KanbanEvent[]
    handoffs: HandoffItem[]
    plan: PlanItem | null
  } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
                  {meta.label}
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
                {task.progress}% · 创建于 {relativeTime(task.created_at)}
                {task.updated_at && ` · 更新于 ${relativeTime(task.updated_at)}`}
              </SheetDescription>
            </SheetHeader>

            {task.block_reason && (
              <div className="text-destructive bg-destructive/8 flex items-start gap-2 rounded-md p-3 text-sm">
                <TriangleAlertIcon className="mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium">阻塞原因</p>
                  <p>{task.block_reason}</p>
                </div>
              </div>
            )}

            {task.progress > 0 && <Progress value={task.progress} className="h-1.5" />}

            {loading && (
              <div className="flex flex-col gap-2">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-24 w-full" />
              </div>
            )}

            {error && <p className="text-destructive text-sm">{error}</p>}

            {detail && (
              <Tabs defaultValue="timeline">
                <TabsList>
                  <TabsTrigger value="timeline">时间线</TabsTrigger>
                  <TabsTrigger value="handoff">
                    交接
                    {detail.handoffs.length > 0 && (
                      <Badge variant="secondary" className="ml-1">
                        {detail.handoffs.length}
                      </Badge>
                    )}
                  </TabsTrigger>
                  {detail.plan && <TabsTrigger value="plan">计划</TabsTrigger>}
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

            <SheetFooter className="mt-4">
              <p className="text-muted-foreground text-xs">
                CLI 等价操作：<code>kanban task show {task.id}</code>
              </p>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

function Timeline({ events }: { events: KanbanEvent[] }) {
  if (events.length === 0) {
    return <p className="text-muted-foreground py-8 text-center text-sm">还没有事件</p>
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
              <p className="text-sm">{describeEvent(e.type, e.data)}</p>
              <p className="text-muted-foreground text-[11px]">
                {relativeTime(e.ts)} · {e.session_id ?? "system"}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </ScrollArea>
  )
}

function Handoffs({ items }: { items: HandoffItem[] }) {
  if (items.length === 0) {
    return (
      <div className="text-muted-foreground flex flex-col items-center gap-2 py-8 text-center text-sm">
        <UserRoundIcon className="size-6" />
        <p>还没有交接记录</p>
        <p className="text-xs">用卡片菜单的「写交接」给下一个 agent 留话</p>
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
              {h.kind === "crash" ? "崩溃自动合成" : "主动交接"}
            </Badge>
            <span className="text-muted-foreground text-[11px]">
              {h.from_session} · {relativeTime(h.created_at)}
            </span>
            {h.consumed_by && (
              <Badge variant="outline" className="ml-auto text-[10px]">
                {h.consumed_by} 已接手
              </Badge>
            )}
          </div>
          <p className="text-sm">{h.summary}</p>
          {h.next_step && (
            <p className="text-muted-foreground text-sm">
              <span className="text-foreground font-medium">下一步：</span>
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
  sessions: Array<{ id: string; agent_name: string; status: string; stale: boolean; fresh: string | null; tasks: string[] }>
  tasksById: Map<string, TaskItem>
}) {
  if (sessions.length === 0) {
    return (
      <div className="text-muted-foreground flex flex-col items-center gap-2 py-6 text-center text-sm">
        <ListChecksIcon className="size-5" />
        <p>还没有活跃会话</p>
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
                失联
              </Badge>
            ) : (
              <Badge variant="secondary" className="ml-auto text-[10px]">
                {s.fresh ?? "活跃"}
              </Badge>
            )}
          </div>
          {s.tasks.length > 0 && (
            <p className="text-muted-foreground text-[11px]">
              持有 {s.tasks.map((t) => tasksById.get(t)?.title ?? t).join("、")}
            </p>
          )}
        </li>
      ))}
    </ul>
  )
}
