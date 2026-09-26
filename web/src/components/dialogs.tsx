/**
 * 写操作对话框集合。
 *
 * 为什么要对话框而不是直接执行：状态机里 blocked / cancelled / reopen 都要求
 * `--reason`，`done` 在非 review 来源要 `--force`。让用户在 UI 上补齐这些信息，
 * 而不是发出一个注定失败、还要再报错的请求。
 */

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { TaskItem } from "@/lib/api"

/** 需要一个原因的操作 */
export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  placeholder,
  confirmLabel,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  title: string
  description: string
  placeholder?: string
  confirmLabel: string
  onConfirm: (reason: string) => Promise<void> | void
}) {
  const [reason, setReason] = useState("")
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (open) setReason("")
  }, [open])

  const submit = async () => {
    if (!reason.trim()) return
    setPending(true)
    try {
      await onConfirm(reason.trim())
      onOpenChange(false)
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field data-invalid={!reason.trim() && pending ? true : undefined}>
            <FieldLabel htmlFor="reason">原因</FieldLabel>
            <Textarea
              id="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={placeholder ?? "发生了什么？下一个 agent 需要知道什么？"}
              rows={3}
              aria-invalid={!reason.trim() && pending}
            />
            <FieldDescription>必填。会写进事件时间线，接手的人靠它理解现场。</FieldDescription>
          </Field>
        </FieldGroup>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">取消</Button>
          </DialogClose>
          <Button disabled={!reason.trim() || pending} onClick={submit}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 更新进度：pct + 勾选检查项 + 备注 */
export function ProgressDialog({
  open,
  onOpenChange,
  task,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  task: TaskItem | null
  onConfirm: (input: { pct?: number; check?: string[]; note?: string }) => Promise<void> | void
}) {
  const [pct, setPct] = useState(task?.progress ?? 0)
  const [note, setNote] = useState("")
  const [checks, setChecks] = useState<string[]>([])
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (open && task) {
      setPct(task.progress)
      setNote("")
      setChecks([])
    }
  }, [open, task])

  if (!task) return null

  const submit = async () => {
    setPending(true)
    try {
      await onConfirm({
        // 只在用户真的拖动了滑块时才提交 pct，否则让后端按 checklist 比例重算
        pct: pct !== task.progress ? pct : undefined,
        check: checks.length > 0 ? checks : undefined,
        note: note.trim() || undefined,
      })
      onOpenChange(false)
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>更新进度</DialogTitle>
          <DialogDescription>
            {task.id} · {task.title}
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="pct">进度：{pct}%</FieldLabel>
            <input
              id="pct"
              type="range"
              min={0}
              max={100}
              step={5}
              value={pct}
              onChange={(e) => setPct(Number(e.target.value))}
              className="accent-primary w-full"
            />
            <Progress value={pct} className="mt-1 h-1.5" />
          </Field>

          {task.checklist.total > task.checklist.done && (
            <Field>
              <FieldLabel>勾选已完成的检查项</FieldLabel>
              <div className="flex flex-col gap-1.5">
                {Array.from({ length: task.checklist.total - task.checklist.done }).map((_, i) => {
                  const idx = task.checklist.done + i
                  return (
                    <Label key={idx} className="flex items-center gap-2 text-sm font-normal">
                      <input
                        type="checkbox"
                        checked={checks.includes(String(idx))}
                        onChange={(e) =>
                          setChecks((prev) =>
                            e.target.checked ? [...prev, String(idx)] : prev.filter((c) => c !== String(idx)),
                          )
                        }
                      />
                      第 {idx + 1} 项
                    </Label>
                  )
                })}
              </div>
              <FieldDescription>按顺序勾选（后端按文字匹配，这里用序号代替）。</FieldDescription>
            </Field>
          )}

          <Field>
            <FieldLabel htmlFor="note">备注</FieldLabel>
            <Textarea
              id="note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="这次推进做了什么？"
              rows={2}
            />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">取消</Button>
          </DialogClose>
          <Button disabled={pending} onClick={submit}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 写交接：summary / next / blockers / open —— 这是 M2 崩溃恢复的核心输入 */
export function HandoffDialog({
  open,
  onOpenChange,
  task,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  task: TaskItem | null
  onConfirm: (input: {
    summary: string
    next_step?: string
    blockers?: string[]
    open_questions?: string[]
  }) => Promise<void> | void
}) {
  const [summary, setSummary] = useState("")
  const [next, setNext] = useState("")
  const [blockers, setBlockers] = useState("")
  const [questions, setQuestions] = useState("")
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (open) {
      setSummary("")
      setNext("")
      setBlockers("")
      setQuestions("")
    }
  }, [open])

  if (!task) return null

  const splitList = (s: string) =>
    s
      .split(/[,，;；\n]/)
      .map((x) => x.trim())
      .filter(Boolean)

  const submit = async () => {
    if (!summary.trim()) return
    setPending(true)
    try {
      await onConfirm({
        summary: summary.trim(),
        next_step: next.trim() || undefined,
        blockers: splitList(blockers),
        open_questions: splitList(questions),
      })
      onOpenChange(false)
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>写交接</DialogTitle>
          <DialogDescription>
            {task.id} · {task.title}
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <FieldSet>
            <FieldLegend>交接四要素</FieldLegend>
            <Field data-invalid={pending && !summary.trim() ? true : undefined}>
              <FieldLabel htmlFor="ho-summary">做了什么（必填）</FieldLabel>
              <Textarea
                id="ho-summary"
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                placeholder="完成 WAL 事务层，store.ts 20 个测试全绿"
                rows={2}
                aria-invalid={pending && !summary.trim()}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="ho-next">建议下一步</FieldLabel>
              <Input
                id="ho-next"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                placeholder="实现 handoff 崩溃自动合成"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="ho-blockers">已知卡点</FieldLabel>
              <Input
                id="ho-blockers"
                value={blockers}
                onChange={(e) => setBlockers(e.target.value)}
                placeholder="依赖没装，WAL 文件归属待定"
              />
              <FieldDescription>多个用逗号分隔。</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="ho-open">留给人的问题</FieldLabel>
              <Input
                id="ho-open"
                value={questions}
                onChange={(e) => setQuestions(e.target.value)}
                placeholder="租约时长要不要按任务类型区分？"
              />
            </Field>
          </FieldSet>
        </FieldGroup>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">取消</Button>
          </DialogClose>
          <Button disabled={!summary.trim() || pending} onClick={submit}>
            记录交接
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 新建任务 */
export function NewTaskDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onConfirm: (input: {
    title: string
    body?: string
    priority: number
    labels: string[]
    checklist: string[]
    blocked_by: string[]
  }) => Promise<void> | void
}) {
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const [priority, setPriority] = useState(2)
  const [labels, setLabels] = useState("")
  const [checklist, setChecklist] = useState("")
  const [blockedBy, setBlockedBy] = useState("")
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (open) {
      setTitle("")
      setBody("")
      setPriority(2)
      setLabels("")
      setChecklist("")
      setBlockedBy("")
    }
  }, [open])

  const splitList = (s: string) =>
    s
      .split(/[,，\n]/)
      .map((x) => x.trim())
      .filter(Boolean)

  const submit = async () => {
    if (!title.trim()) return
    setPending(true)
    try {
      await onConfirm({
        title: title.trim(),
        body: body.trim() || undefined,
        priority,
        labels: splitList(labels),
        checklist: splitList(checklist),
        blocked_by: splitList(blockedBy),
      })
      onOpenChange(false)
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>新建任务</DialogTitle>
          <DialogDescription>标题说清"要什么"，检查项留给接手的人说"怎么算做完"。</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field data-invalid={pending && !title.trim() ? true : undefined}>
            <FieldLabel htmlFor="nt-title">标题</FieldLabel>
            <Input
              id="nt-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="实现崩溃自动合成"
              aria-invalid={pending && !title.trim()}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="nt-body">描述</FieldLabel>
            <Textarea
              id="nt-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={2}
              placeholder="背景、约束、验收标准"
            />
          </Field>
          <Field>
            <FieldLabel>优先级</FieldLabel>
            <Select value={String(priority)} onValueChange={(v) => setPriority(Number(v))}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {[0, 1, 2, 3, 4].map((p) => (
                    <SelectItem key={p} value={String(p)}>
                      P{p} {p === 0 ? "（最高）" : p === 4 ? "（最低）" : ""}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="nt-labels">标签</FieldLabel>
            <Input
              id="nt-labels"
              value={labels}
              onChange={(e) => setLabels(e.target.value)}
              placeholder="core, backend"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="nt-check">检查项</FieldLabel>
            <Input
              id="nt-check"
              value={checklist}
              onChange={(e) => setChecklist(e.target.value)}
              placeholder="补齐事件 payload,实现 rebuild"
            />
            <FieldDescription>逗号分隔。这些会成为崩溃恢复时的"剩余工作"。</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="nt-deps">依赖的任务号</FieldLabel>
            <Input
              id="nt-deps"
              value={blockedBy}
              onChange={(e) => setBlockedBy(e.target.value)}
              placeholder="T-0001, T-0002"
            />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">取消</Button>
          </DialogClose>
          <Button disabled={!title.trim() || pending} onClick={submit}>
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 冲突提示：拖拽被抢占时的解释性对话框 */
export function ConflictDialog({
  open,
  onOpenChange,
  holder,
  onForce,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  holder: { session: string; progress?: number; lastSeen?: string } | null
  onForce?: () => Promise<void> | void
}) {
  if (!holder) return null
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            这张卡有人正在做
          </DialogTitle>
          <DialogDescription>
            持有者 <span className="font-mono">{holder.session}</span>
            {holder.progress !== undefined && ` · 进度 ${holder.progress}%`}
            {holder.lastSeen && ` · ${holder.lastSeen}`}
          </DialogDescription>
        </DialogHeader>
        <div className="text-muted-foreground text-sm">
          <p>强行抢过来会让两个 agent 同时改同一张卡。除非确认对方已经失联，否则换个任务做更稳妥。</p>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">算了，换一张</Button>
          </DialogClose>
          {onForce && (
            <Button variant="destructive" onClick={onForce}>
              确认强行接管
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 状态徽标（替代 Badge variant 的有限枚举） */
export function StatusChip({ label, colorVar }: { label: string; colorVar: string }) {
  return (
    <Badge
      className="status-chip border-0"
      style={{ ["--chip-color" as string]: `var(${colorVar})` }}
    >
      {label}
    </Badge>
  )
}
