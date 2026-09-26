/**
 * 写操作对话框集合。
 *
 * 为什么要对话框而不是直接执行：状态机里 blocked / cancelled / reopen 都要求
 * `--reason`，`done` 在非 review 来源要 `--force`。让用户在 UI 上补齐这些信息，
 * 而不是发出一个注定失败、还要再报错的请求。
 *
 * 语言：每个对话框自己 `useI18n()`，不靠 props 传文案——文案列在一处好过散在两边。
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
import { useI18n } from "@/lib/i18n"
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
  const { t } = useI18n()

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
            <FieldLabel htmlFor="reason">{t("reason.label")}</FieldLabel>
            <Textarea
              id="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={placeholder ?? t("reason.placeholder")}
              rows={3}
              aria-invalid={!reason.trim() && pending}
            />
            <FieldDescription>{t("reason.desc")}</FieldDescription>
          </Field>
        </FieldGroup>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">{t("common.cancel")}</Button>
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
  const { t } = useI18n()

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
          <DialogTitle>{t("progress.title")}</DialogTitle>
          <DialogDescription>
            {task.id} · {task.title}
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="pct">{t("progress.pct", { pct })}</FieldLabel>
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
              <FieldLabel>{t("progress.checklist")}</FieldLabel>
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
                      {t("progress.item", { n: idx + 1 })}
                    </Label>
                  )
                })}
              </div>
              <FieldDescription>{t("progress.checklistDesc")}</FieldDescription>
            </Field>
          )}

          <Field>
            <FieldLabel htmlFor="note">{t("progress.note")}</FieldLabel>
            <Textarea
              id="note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t("progress.notePlaceholder")}
              rows={2}
            />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">{t("common.cancel")}</Button>
          </DialogClose>
          <Button disabled={pending} onClick={submit}>
            {t("common.save")}
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
  const { t } = useI18n()

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
          <DialogTitle>{t("handoffDialog.title")}</DialogTitle>
          <DialogDescription>
            {task.id} · {task.title}
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <FieldSet>
            <FieldLegend>{t("handoffDialog.legend")}</FieldLegend>
            <Field data-invalid={pending && !summary.trim() ? true : undefined}>
              <FieldLabel htmlFor="ho-summary">{t("handoffDialog.summary")}</FieldLabel>
              <Textarea
                id="ho-summary"
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                placeholder={t("handoffDialog.summaryPlaceholder")}
                rows={2}
                aria-invalid={pending && !summary.trim()}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="ho-next">{t("handoffDialog.next")}</FieldLabel>
              <Input
                id="ho-next"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                placeholder={t("handoffDialog.nextPlaceholder")}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="ho-blockers">{t("handoffDialog.blockers")}</FieldLabel>
              <Input
                id="ho-blockers"
                value={blockers}
                onChange={(e) => setBlockers(e.target.value)}
                placeholder={t("handoffDialog.blockersPlaceholder")}
              />
              <FieldDescription>{t("handoffDialog.blockersDesc")}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="ho-open">{t("handoffDialog.open")}</FieldLabel>
              <Input
                id="ho-open"
                value={questions}
                onChange={(e) => setQuestions(e.target.value)}
                placeholder={t("handoffDialog.openPlaceholder")}
              />
            </Field>
          </FieldSet>
        </FieldGroup>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">{t("common.cancel")}</Button>
          </DialogClose>
          <Button disabled={!summary.trim() || pending} onClick={submit}>
            {t("handoffDialog.submit")}
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
  const { t } = useI18n()

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
          <DialogTitle>{t("newTask.title")}</DialogTitle>
          <DialogDescription>{t("newTask.desc")}</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field data-invalid={pending && !title.trim() ? true : undefined}>
            <FieldLabel htmlFor="nt-title">{t("newTask.label.title")}</FieldLabel>
            <Input
              id="nt-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("newTask.placeholder.title")}
              aria-invalid={pending && !title.trim()}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="nt-body">{t("newTask.label.body")}</FieldLabel>
            <Textarea
              id="nt-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={2}
              placeholder={t("newTask.placeholder.body")}
            />
          </Field>
          <Field>
            <FieldLabel>{t("newTask.label.priority")}</FieldLabel>
            <Select value={String(priority)} onValueChange={(v) => setPriority(Number(v))}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {[0, 1, 2, 3, 4].map((p) => (
                    <SelectItem key={p} value={String(p)}>
                      {/* 括号内的补充说明跟着语言走：中文用全角括号，英文用半角 + 空格 */}
                      {`P${p}${p === 0 ? t("newTask.priority.highest") : p === 4 ? t("newTask.priority.lowest") : ""}`}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="nt-labels">{t("newTask.label.labels")}</FieldLabel>
            <Input
              id="nt-labels"
              value={labels}
              onChange={(e) => setLabels(e.target.value)}
              placeholder="core, backend"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="nt-check">{t("newTask.label.checklist")}</FieldLabel>
            <Input
              id="nt-check"
              value={checklist}
              onChange={(e) => setChecklist(e.target.value)}
              placeholder={t("newTask.placeholder.checklist")}
            />
            <FieldDescription>{t("newTask.checklist.desc")}</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="nt-deps">{t("newTask.label.deps")}</FieldLabel>
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
            <Button variant="outline">{t("common.cancel")}</Button>
          </DialogClose>
          <Button disabled={!title.trim() || pending} onClick={submit}>
            {t("common.create")}
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
  const { t } = useI18n()
  if (!holder) return null
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {t("conflict.title")}
          </DialogTitle>
          <DialogDescription>
            {t("conflict.holder")} <span className="font-mono">{holder.session}</span>
            {holder.progress !== undefined && ` · ${t("conflict.progress", { pct: holder.progress })}`}
            {holder.lastSeen && ` · ${holder.lastSeen}`}
          </DialogDescription>
        </DialogHeader>
        <div className="text-muted-foreground text-sm">
          <p>{t("conflict.body")}</p>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">{t("conflict.back")}</Button>
          </DialogClose>
          {onForce && (
            <Button variant="destructive" onClick={onForce}>
              {t("conflict.force")}
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
