/**
 * 任务卡片。
 *
 * 信息取舍：一张卡上只放"扫一眼就该知道"的东西——标题、优先级、进度、
 * 剩余检查项、持有者。细节（时间线、交接、计划）一律进详情抽屉。
 * 看板的价值是全局态势，不是完整档案。
 */

import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import {
  BanIcon,
  CircleCheckIcon,
  GripVerticalIcon,
  HandIcon,
  ListChecksIcon,
  MoreHorizontalIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { TaskItem } from "@/lib/api"
import { PRIORITY_LABEL, STATUS_META, leaseText, relativeTime } from "@/lib/status"

export interface TaskCardProps {
  task: TaskItem
  /** 持有者会话名（从 sessions 里查出来的，便于显示"谁在做"） */
  holderName?: string
  /** 持有者是否失联（stale） */
  holderStale?: boolean
  onOpen: (task: TaskItem) => void
  onAction: (task: TaskItem, action: CardAction) => void
  disabled?: boolean
}

export type CardAction =
  | "claim"
  | "progress"
  | "review"
  | "done"
  | "block"
  | "unblock"
  | "cancel"
  | "reopen"
  | "release"
  | "handoff"

export function TaskCard({
  task,
  holderName,
  holderStale,
  onOpen,
  onAction,
  disabled,
}: TaskCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { status: task.status },
    disabled,
  })

  const meta = STATUS_META[task.status]
  const lease = leaseText(task.lease_expires_at)
  const waiting = task.unfinished_dependencies ?? []
  const checklistLeft = task.checklist.total - task.checklist.done

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        // 状态色以 CSS 变量注入，暗色模式自动跟随主题
        ["--chip-color" as string]: `var(${meta.colorVar})`,
      }}
      className={cn(
        "group relative flex flex-col gap-2 overflow-hidden rounded-lg border bg-card p-3 text-card-foreground",
        "shadow-xs transition-shadow hover:shadow-md",
        "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
        isDragging && "card-lift z-10 opacity-90",
      )}
      {...attributes}
    >
      {/* 泳道色条：卡片顶部一道细线，不占横向空间也能一眼区分状态。
          用顶部而不是左侧：左侧色条容易被卡片圆角和 border 吃掉，看不见。 */}
      <div className="lane-accent absolute inset-x-0 top-0 h-1" aria-hidden />

      {/* 顶部行。pr-6 是给右上角 hover 出现的操作菜单（absolute right-1 size-6）预留的位置：
          不留位的话长标题会钻到按钮底下。任务号已移到卡片底部，不在这里抢位。 */}
      <div className="flex items-start justify-between gap-2 pr-6 pt-0.5">
        {/* 拖拽把手：整卡可点开，把手只负责拖，避免误触。
            用抓手图标而不是 ⋯：右上角的 ⋯ 才是操作菜单，两个同名图标会让人点错。 */}
        <button
          type="button"
          {...listeners}
          className="text-muted-foreground/50 -ml-1 cursor-grab touch-none active:cursor-grabbing hover:text-muted-foreground"
          aria-label="拖动以调整状态"
        >
          <GripVerticalIcon data-icon="inline-start" />
        </button>
        <button
          type="button"
          onClick={() => onOpen(task)}
          className="text-left text-sm leading-snug font-medium line-clamp-2 flex-1 cursor-pointer hover:underline"
        >
          {task.title}
        </button>
      </div>

      {/* 优先级 + 标签 */}
      <div className="flex flex-wrap items-center gap-1">
        {task.priority <= 1 && (
          <span
            className={cn(
              "rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold",
              task.priority === 0
                ? "bg-destructive/12 text-destructive"
                : "bg-status-todo/15 text-status-todo",
            )}
          >
            {PRIORITY_LABEL[task.priority]}
          </span>
        )}
        {task.labels.slice(0, 2).map((label) => (
          <span key={label} className="text-muted-foreground bg-secondary rounded px-1.5 py-0.5 text-[10px]">
            {label}
          </span>
        ))}
      </div>

      {/* 阻塞原因：状态之外的补充信息，用酒红色呼应 blocked 令牌 */}
      {task.block_reason && (
        <p className="text-destructive bg-destructive/8 flex items-start gap-1 rounded px-2 py-1 text-[11px]">
          <TriangleAlertIcon className="mt-px shrink-0" />
          <span className="line-clamp-2">{task.block_reason}</span>
        </p>
      )}

      {/* 进度 + 检查项。进度条用**状态色**：拖到“待评审”的卡不该还是绿的 */}
      {task.progress > 0 && (
        <div className="flex flex-col gap-1">
          <Progress
            value={task.progress}
            className="h-1.5 text-primary"
            style={{ color: `var(${meta.colorVar})` }}
          />
          <div className="text-muted-foreground flex items-center justify-between text-[11px]">
            <span>{task.progress}%</span>
            {checklistLeft > 0 && (
              <span className="flex items-center gap-1">
                <ListChecksIcon />
                还剩 {checklistLeft} 项
              </span>
            )}
          </div>
        </div>
      )}

      {/* 等依赖：告诉用户"为什么还不能做" */}
      {waiting.length > 0 && task.status === "todo" && (
        <p className="text-muted-foreground bg-muted rounded px-2 py-1 text-[11px]">
          等 {waiting.join("、")} 完成
        </p>
      )}

      {/* 持有者 + 租约 */}
      {task.assignee_session_id && (
        <div
          className={cn(
            "flex items-center gap-1.5 text-[11px]",
            holderStale ? "text-status-stale" : "text-muted-foreground",
          )}
        >
          {holderStale ? <TriangleAlertIcon /> : <HandIcon />}
          <span className="truncate">{holderName ?? task.assignee_session_id}</span>
          {lease && <span className="ml-auto shrink-0">{lease}</span>}
        </div>
      )}

      {/* 底部元信息行：任务号 + 更新时间。
          任务号原来放在右上角，与 hover 浮现的操作按钮（absolute top-1.5 right-1）
          叠在同一个位置——卡片一被悬停，id 就被按钮盖住。挪到这里两边都不挤。 */}
      <div className="text-muted-foreground/70 flex items-center gap-2 text-[10px]">
        <span data-slot="task-id" className="font-mono">
          {task.id}
        </span>
        {task.updated_at && <span className="ml-auto shrink-0">{relativeTime(task.updated_at)}</span>}
      </div>

      {/* 操作菜单：写操作都收在这里（需要 reason 的走对话框） */}
      <TaskMenu task={task} onAction={onAction} />
    </div>
  )
}

/** 卡片操作菜单 */
function TaskMenu({ task, onAction }: { task: TaskItem; onAction: (t: TaskItem, a: CardAction) => void }) {
  const run = (action: CardAction) => () => onAction(task, action)
  const canClaim = task.status === "todo" || task.status === "backlog"
  const canProgress = task.status === "doing"
  const canBlock = task.status === "todo" || task.status === "doing"
  const canReview = task.status === "doing"
  const canDone = task.status === "doing" || task.status === "review"
  const isTerminal = task.status === "done" || task.status === "cancelled"

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="absolute top-1.5 right-1 size-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          aria-label="卡片操作"
        >
          <MoreHorizontalIcon />
        </Button>
      </DropdownMenuTrigger>
      {/* min-w-40：最长的文案是“释放（保留进度）”，160px 能一行放下，不用折行 */}
      <DropdownMenuContent align="end" className="min-w-40">
        <DropdownMenuGroup>
          <DropdownMenuItem disabled={!canClaim} onSelect={run("claim")}>
            <HandIcon data-icon="inline-start" />
            认领任务
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!canProgress} onSelect={run("progress")}>
            <ListChecksIcon data-icon="inline-start" />
            更新进度
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!canReview} onSelect={run("review")}>
            <CircleCheckIcon data-icon="inline-start" />
            提交评审
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!canDone} onSelect={run("done")}>
            <CircleCheckIcon data-icon="inline-start" />
            标记完成
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={run("handoff")}>
            <TriangleAlertIcon data-icon="inline-start" />
            写交接
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuGroup>
          <DropdownMenuItem disabled={!canBlock} onSelect={run("block")}>
            <BanIcon data-icon="inline-start" />
            标记阻塞
          </DropdownMenuItem>
          <DropdownMenuItem disabled={task.status !== "blocked"} onSelect={run("unblock")}>
            解除阻塞
          </DropdownMenuItem>
          <DropdownMenuItem disabled={task.status !== "doing"} onSelect={run("release")}>
            释放（保留进度）
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!isTerminal} onSelect={run("reopen")}>
            重新打开
          </DropdownMenuItem>
          <DropdownMenuItem disabled={isTerminal} onSelect={run("cancel")}>
            <BanIcon data-icon="inline-start" />
            取消任务
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** 泳道容器：可放置目标，拖入时高亮 */
export function Lane({
  status,
  tasks,
  children,
  dropHint,
}: {
  status: keyof typeof STATUS_META
  tasks: TaskItem[]
  children: React.ReactNode
  dropHint?: string | null
}) {
  const meta = STATUS_META[status]
  return (
    <section
      // flex-1 + min-w-72：既能在宽屏时均分空间，又能在窄屏换行后保持可读宽度
      className="flex min-w-72 flex-1 basis-72 flex-col gap-2"
      style={{ ["--chip-color" as string]: `var(${meta.colorVar})` }}
    >
      <header className="flex items-center gap-2 px-1">
        <span className="lane-accent size-2.5 shrink-0 rounded-full" aria-hidden />
        <h2 className="text-sm font-semibold">{meta.label}</h2>
        <Badge variant="secondary" className="ml-auto font-mono text-[10px]">
          {tasks.length}
        </Badge>
      </header>
      {dropHint && (
        <p className="text-muted-foreground bg-muted/60 rounded-md border border-dashed px-2 py-1.5 text-[11px]">
          {dropHint}
        </p>
      )}
      <div className="bg-muted/25 flex min-h-24 flex-1 flex-col gap-2 rounded-lg p-1.5">
        {children}
        {tasks.length === 0 && (
          <p className="text-muted-foreground/70 px-2 py-3 text-center text-[11px]">空</p>
        )}
      </div>
    </section>
  )
}

/** 泳道内的占位提示（tooltip 说明为什么不能拖） */
export function DropHint({ reason }: { reason: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="text-muted-foreground/60 border-border text-center text-[11px] border border-dashed rounded-md py-1.5">
          松手后会提示原因
        </div>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  )
}
