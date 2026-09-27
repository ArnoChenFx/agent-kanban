/**
 * 看板主页面。
 *
 * 三块结构：
 *   顶栏  —— project 切换、新建任务、亮/暗切换、连接状态
 *   泳道  —— 7 条泳道，卡片可拖拽改状态（受状态机守卫约束）
 *   侧栏  —— 交接（崩溃恢复的核心）、会话、建议动作
 *
 * 数据流：首次 load 拉 /api/board → SSE 收到事件 → 防抖后重新拉 board。
 * 不做增量更新：看板数据量小（几百张卡），全量重拉比维护 diff 更不容易出错。
 *
 * 语言：本文件所有界面文案都走 `t(key)`；从 lib/status.ts 拿的
 * 状态名/时间/事件描述也一样传 `t` 下去。**不要**在这里写中文字面量——
 * 漏翻的那一条会静静地在英文界面里露出中文。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core"
import {
  AlertTriangleIcon,
  CheckIcon,
  InboxIcon,
  MoonIcon,
  PlusIcon,
  RefreshCwIcon,
  SunIcon,
  WifiIcon,
  WifiOffIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

import { Lane, TaskCard, type CardAction } from "@/components/task-card"
import { TaskDetailSheet, SessionsPanel } from "@/components/task-detail"
import { localizedNextActions } from "@/lib/next-actions"
import { errorHint, errorText, holderText } from "@/lib/error-text"
import {
  ConflictDialog,
  HandoffDialog,
  NewTaskDialog,
  ProgressDialog,
  ReasonDialog,
} from "@/components/dialogs"
import { LoginCard } from "@/components/login"
import { LanguageToggle } from "@/components/language-toggle"
import {
  ApiError,
  clearLastProject,
  executeOp,
  fetchBoard,
  fetchContext,
  fetchProjects,
  getLastProject,
  getToken,
  setLastProject,
  setToken,
  subscribeEvents,
  type BoardSnapshot,
  type RecoveryContext,
  type TaskItem,
  type TaskStatus,
} from "@/lib/api"
import { useI18n } from "@/lib/i18n"
import { resolveProject } from "@/lib/project"
import { LANE_ORDER, STATUS_META, canMove, relativeTime, statusLabel } from "@/lib/status"

export function Board() {
  // 注意：URL 里的 ?key=… 由 main.tsx 在 render 前统一处理（启动引导）
  const { t } = useI18n()
  const [token, setTokenState] = useState<string | null>(getToken())
  const [project, setProject] = useState<string | null>(getLastProject())
  const [projects, setProjects] = useState<Array<{ key: string; name: string }>>([])
  const [board, setBoard] = useState<BoardSnapshot | null>(null)
  const [context, setContext] = useState<RecoveryContext | null>(null)
  const [loading, setLoading] = useState(false)
  const [online, setOnline] = useState(false)
  const [dark, setDark] = useState(() => localStorage.getItem("kanban.theme") === "dark")

  const [selected, setSelected] = useState<TaskItem | null>(null)
  const [dragging, setDragging] = useState<TaskItem | null>(null)
  const [dialog, setDialog] = useState<{ kind: CardAction; task: TaskItem } | null>(null)
  const [newTaskOpen, setNewTaskOpen] = useState(false)
  const [conflict, setConflict] = useState<{ task: TaskItem; holder: { session: string; progress?: number; lastSeen?: string } | null } | null>(null)

  // 亮/暗模式：写 <html class="dark">，主题令牌整体切换
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark)
    localStorage.setItem("kanban.theme", dark ? "dark" : "light")
  }, [dark])

  // ---- 改选 project 的唯一出口 ----
  // 记忆存在 localStorage，所以每次改选都得同时写 state 和 localStorage：
  // 少写一次，刷新页面就弹回上一个 project（曾经下拉框直接接 setProject，
  // 选完刷新就丢，而且不报任何错）。反过来，读的时候只认 localStorage（getLastProject），
  // 于是「内存里的值」和「下次打开的值」天然一致。
  const selectProject = useCallback((key: string) => {
    setProject(key)
    setLastProject(key)
  }, [])

  /** 回到「未选」状态：清掉记忆，让下面的列表 effect 按第一个 project 兜底 */
  const clearProject = useCallback(() => {
    setProject(null)
    clearLastProject()
  }, [])

  // ---- 拉取 project 列表，并定下这次看哪个 ----
  // 只依赖 token：以前把 project 也列进依赖，用户每切一次就重拉一遍列表（无意义），
  // 而且那个闭包读到的是**上一次**的 project，逻辑越写越绕。
  useEffect(() => {
    if (!token) return
    // 组件已卸载就别再 setState（StrictMode 下 effect 会跑两遍）
    let cancelled = false
    fetchProjects(token)
      .then((list) => {
        if (cancelled) return
        const items = list.map((p) => ({ key: p.key, name: p.name }))
        setProjects(items)
        const next = resolveProject(getLastProject(), items.map((p) => p.key))
        // 自动兜底选中的那个也记下来，下次打开不必再走一遍判断
        if (next) setLastProject(next)
        setProject(next)
      })
      .catch((e) => {
        if (cancelled) return
        if (e instanceof ApiError && e.isAuth) {
          setToken(null)
          setTokenState(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [token])

  // ---- 拉取看板 + 恢复上下文 ----
  const reload = useCallback(async () => {
    if (!token || !project) return
    try {
      const [b, c] = await Promise.all([
        fetchBoard(token, project),
        // 拉取失败不该让整块看板跟着失败，所以这里 .catch 后再判空
        fetchContext(token, project, null).catch(() => null),
      ])
      setBoard(b)
      // 交接与会话列表是活的状态：SSE 推了事件就重拉一次，否则侧栏会一直停在
      // 首次进页面时的快照（有人接手了交接、session 变红了都看不见）。
      if (c) setContext(c)
    } catch (e) {
      if (e instanceof ApiError && e.isAuth) {
        setTokenState(null)
        setToken(null)
      }
    }
  }, [token, project])

  useEffect(() => {
    // project 还没定下来时（第一次拿列表、或者这个 token 一个项目都没有）
    // 别发请求：空 project 只会换来一个 400，外加骨架屏白闪一下
    if (!token || !project) {
      setLoading(false)
      return
    }
    setLoading(true)
    setBoard(null)
    fetchContext(token, project, null)
      .then(setContext)
      .catch(() => undefined)
      .finally(() => setLoading(false))
  }, [token, project])

  useEffect(() => {
    reload()
  }, [reload])

  // ---- SSE：收到事件就防抖重拉 ----
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!token || !project) return
    const handle = subscribeEvents(
      token,
      project,
      board?.head_seq ?? 0,
      () => {
        if (reloadTimer.current) clearTimeout(reloadTimer.current)
        // agent 批量写时会连发很多事件，防抖避免请求风暴
        reloadTimer.current = setTimeout(reload, 400)
      },
      setOnline,
    )
    return () => {
      handle.close()
      if (reloadTimer.current) clearTimeout(reloadTimer.current)
    }
  }, [token, project, board?.head_seq, reload])

  // ---- 派生数据 ----
  const sessionById = useMemo(() => {
    const map = new Map<string, { agent_name: string; stale: boolean }>()
    for (const s of board?.sessions ?? []) map.set(s.id, { agent_name: s.agent_name, stale: s.stale })
    return map
  }, [board])

  // 详情抽屉的署名要用（时间线 / 检查项 / 交接显示成"agent 名 + session id"）
  const sessionNames = useMemo(() => {
    const map = new Map<string, string>()
    for (const s of board?.sessions ?? []) map.set(s.id, s.agent_name)
    return map
  }, [board])

  const tasksById = useMemo(() => {
    const map = new Map<string, TaskItem>()
    for (const list of Object.values(board?.lanes ?? {})) {
      for (const t of list ?? []) map.set(t.id, t)
    }
    return map
  }, [board])

  // 建议区：后端给「代号 + 参数」，这里按当前语言选词。
  // 依赖 t（locale 变了要重算）而不是把结果存进 state。
  const nextActions = useMemo(
    () => (context ? localizedNextActions(context, t) : []),
    [context, t],
  )

  const isStale = (task: TaskItem) =>
    task.assignee_session_id ? (sessionById.get(task.assignee_session_id)?.stale ?? false) : false

  // ---- 写操作统一出口：把后端错误翻译成人话 ----
  const run = useCallback(
    async (op: { kind: string; params?: Record<string, unknown> }, successMsg: string) => {
      if (!token || !project) return false
      try {
        const { nextActions } = await executeOp<unknown>(token, project, op)
        toast.success(successMsg, {
          // 把后端给的 next_actions 也显示出来：这是给 agent 看的，对人同样有用
          description: nextActions[0],
        })
        await reload()
        return true
      } catch (e) {
        if (e instanceof ApiError) {
          if (e.isAuth) toast.error(t("toast.error.auth"), { description: t("toast.error.authDesc") })
          else if (e.isConflict) toast.error(t("toast.error.conflict"), { description: holderText(e.details.holder, errorText(e, t)) })
          else if (e.isBusy) toast.error(t("toast.error.busy"), { description: errorText(e, t) })
          // 其余错误：正文走词典（details.reason → error.* 键），查不到才回退后端的英文 message
          else toast.error(errorText(e, t), {
            description: errorHint(e) || undefined,
          })
        } else {
          toast.error(t("toast.error.unknown"), { description: String(e) })
        }
        return false
      }
    },
    [token, project, reload, t],
  )

  // ---- 卡片操作分发 ----
  const onCardAction = useCallback(
    async (task: TaskItem, action: CardAction) => {
      switch (action) {
        case "claim":
          await run({ kind: "task.claim", params: { task_id: task.id } }, t("toast.success.claim", { id: task.id }))
          break
        case "progress":
        case "handoff":
        case "block":
        case "cancel":
        case "reopen":
          // 这四个需要额外信息（hmm/block/cancel/reopen 要 reason，progress 要数值）
          setDialog({ kind: action, task })
          break
        case "review":
          await run({ kind: "task.review", params: { task_id: task.id } }, t("toast.success.review", { id: task.id }))
          break
        case "done":
          await run({ kind: "task.done", params: { task_id: task.id, force: true } }, t("toast.success.done", { id: task.id }))
          break
        case "unblock":
          await run({ kind: "task.unblock", params: { task_id: task.id } }, t("toast.success.unblock", { id: task.id }))
          break
        case "release":
          await run({ kind: "task.release", params: { task_id: task.id } }, t("toast.success.release", { id: task.id }))
          break
      }
    },
    [run, t],
  )

  // ---- 拖拽 ----
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const onDragStart = (e: DragStartEvent) => {
    const id = String(e.active.id)
    setDragging(tasksById.get(id) ?? null)
  }

  const onDragEnd = async (e: DragEndEvent) => {
    setDragging(null)
    const id = String(e.active.id)
    const task = tasksById.get(id)
    if (!task || !e.over) return

    const to = e.over.data.current?.status as TaskStatus | undefined
    if (!to || to === task.status) return

    const check = canMove(task.status, to, t)
    if (!check.ok) {
      toast.warning(check.reason ?? t("toast.moveFailed"))
      return
    }
    // todo → cancelled / backlog → todo 这类直接调状态机即可
    const ok = await run(
      { kind: "task.transition", params: { task_id: task.id, to } },
      `${task.id} → ${statusLabel(to, t)}`,
    )
    if (!ok) {
      // 冲突：给出"强行接管"的选项
      if (task.status === "doing") {
        setConflict({
          task,
          holder: {
            session: task.assignee_session_id ?? "?",
            progress: task.progress,
          },
        })
      }
    }
  }

  // ---- 未登录 ----
  if (!token) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <LoginCard
          onLogin={(t, p) => {
            setToken(t)
            setTokenState(t)
            // 填了 project 就用它；留空 = 登录框上写的「自动选第一个有权限的」，
            // 所以顺手把旧记忆清掉，别让上一个 token 的 project 截胡
            if (p) selectProject(p)
            else clearProject()
          }}
        />
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col">
      {/* ---------- 顶栏 ---------- */}
      <header className="border-border flex items-center gap-3 border-b px-4 py-2.5">
        <h1 className="font-heading text-lg font-semibold">agent-kanban</h1>

        <Select value={project ?? undefined} onValueChange={selectProject}>
          <SelectTrigger size="sm" className="w-44">
            <SelectValue placeholder={t("board.selectProject")} />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {projects.map((p) => (
                <SelectItem key={p.key} value={p.key}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>

        <div className="ml-auto flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  setNewTaskOpen(true)
                }}
                aria-label={t("board.newTask.aria")}
              >
                <PlusIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("board.newTask")}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" onClick={reload} aria-label={t("board.refresh")}>
                <RefreshCwIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("board.refresh")}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setDark(!dark)}
                aria-label={t("board.theme.aria")}
              >
                {dark ? <SunIcon /> : <MoonIcon />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{dark ? t("board.theme.toLight") : t("board.theme.toDark")}</TooltipContent>
          </Tooltip>

          <LanguageToggle />

          {/* 实时连接状态：SSE 断了要看得见，否则用户会以为看板不动了 */}
          <Badge variant={online ? "secondary" : "outline"} className="gap-1">
            {online ? <WifiIcon /> : <WifiOffIcon />}
            {online ? t("board.online") : t("board.offline")}
          </Badge>

          <Separator orientation="vertical" className="mx-1 h-5" />

          <Button variant="ghost" size="sm" onClick={() => setToken(null)}>
            {t("board.logout")}
          </Button>
        </div>
      </header>

      {/* ---------- 失联告警条：最高优先级信息，不能藏在侧栏 ---------- */}
      {context && context.zombie_sessions.length > 0 && (
        <Alert variant="destructive" className="mx-4 mt-3">
          <AlertTriangleIcon />
          <AlertTitle>{t("board.zombie.title", { n: context.zombie_sessions.length })}</AlertTitle>
          <AlertDescription>
            {context.zombie_sessions.map((z) => (
              <p key={z.session_id}>
                {t("board.zombie.line", {
                  agent: z.agent_name,
                  session: z.session_id,
                  minutes: z.silent_minutes,
                  tasks: z.tasks.map((task) => `${task.id} ${task.title}`).join(t("list.sep")) || t("board.zombie.noTask"),
                })}
              </p>
            ))}
            <p className="text-xs">
              {t("board.zombie.cli")} <code>{`agent-kanban resume <${t("cli.taskIdArg")}>`}</code>
              {t("board.zombie.cliNote")}
            </p>
          </AlertDescription>
        </Alert>
      )}

      {/* ---------- 主体 ---------- */}
      <div className="flex min-h-0 flex-1">
        <ScrollArea className="min-w-0 flex-1">
          {loading ? (
            <div className="flex min-h-[60vh] flex-wrap content-start gap-4 p-4">
              {LANE_ORDER.slice(0, 4).map((s) => (
                <div key={s} className="min-w-72 flex-1">
                  <Skeleton className="mb-2 h-5 w-20" />
                  <Skeleton className="mb-2 h-24 w-full" />
                  <Skeleton className="h-24 w-full" />
                </div>
              ))}
            </div>
          ) : board && Object.values(board.lanes).some((l) => (l ?? []).length > 0) ? (
            <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
              {/* 泳道换行而不是横向滚动：7 条泳道在 1400px 宽度下会排成 2-3 行，
                  全局扫视比左右拖动重要得多；卡片窄一点也能读 */}
              <div className="flex flex-wrap content-start gap-4 p-4">
                {LANE_ORDER.map((status) => {
                  const tasks = board.lanes[status] ?? []
                  return (
                    <Lane key={status} status={status} tasks={tasks}>
                      {tasks.map((task) => (
                        <TaskCard
                          key={task.id}
                          task={task}
                          holderName={sessionById.get(task.assignee_session_id ?? "")?.agent_name}
                          holderStale={isStale(task)}
                          onOpen={setSelected}
                          onAction={onCardAction}
                        />
                      ))}
                    </Lane>
                  )
                })}
              </div>
              {/* 拖拽中的浮层：让用户看清自己拖的是哪张卡 */}
              <DragOverlay>
                {dragging && (
                  <div className="card-lift w-72">
                    <TaskCardPreview task={dragging} />
                  </div>
                )}
              </DragOverlay>
            </DndContext>
          ) : (
            <Empty className="min-h-[60vh]">
              <EmptyHeader>
                <InboxIcon />
                <EmptyTitle>{t("board.empty.title")}</EmptyTitle>
                <EmptyDescription>
                  {t("board.empty.desc")} <code>{t("board.empty.cmd")}</code>
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button onClick={() => setNewTaskOpen(true)}>
                  <PlusIcon data-icon="inline-start" />
                  {t("board.newTask")}
                </Button>
              </EmptyContent>
            </Empty>
          )}
        </ScrollArea>

        {/* ---------- 右侧栏：交接 / 会话 / 建议 ---------- */}
        <aside className="border-border bg-sidebar hidden w-80 shrink-0 flex-col gap-4 overflow-y-auto border-l p-4 lg:flex">
          <section>
            <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
              {t("sidebar.handoffs")}
              {context && context.pending_handoffs.length > 0 && (
                <Badge className="status-chip border-0" style={{ ["--chip-color" as string]: "var(--status-review)" }}>
                  {context.pending_handoffs.length}
                </Badge>
              )}
            </h2>
            {context && context.pending_handoffs.length > 0 ? (
              <ul className="flex flex-col gap-2">
                {context.pending_handoffs.map((h) => (
                  <li
                    key={h.id}
                    className="flex flex-col gap-1 rounded-md border p-2 text-sm"
                    style={{
                      ["--chip-color" as string]:
                        h.kind === "crash" ? "var(--status-stale)" : "var(--status-doing)",
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <Badge className="status-chip border-0">
                        {h.kind === "crash" ? t("sidebar.handoff.crash") : t("sidebar.handoff.manual")}
                      </Badge>
                      <span className="text-muted-foreground text-[11px]">{relativeTime(h.created_at, t)}</span>
                    </div>
                    <p className="font-mono text-xs">{h.task_id}</p>
                    <p className="line-clamp-3 text-xs">{h.summary}</p>
                    {h.next_step && <p className="text-muted-foreground text-[11px]">→ {h.next_step}</p>}
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-1 h-7 text-xs"
                      onClick={() => {
                        const t = tasksById.get(h.task_id)
                        if (t) setSelected(t)
                      }}
                    >
                      {t("common.view")}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground text-sm">{t("sidebar.handoff.empty")}</p>
            )}
          </section>

          <Separator />

          <section>
            <h2 className="mb-2 text-sm font-semibold">{t("sidebar.sessions")}</h2>
            <SessionsPanel sessions={board?.sessions ?? []} tasksById={tasksById} />
          </section>

          {context && nextActions.length > 0 && (
            <>
              <Separator />
              <section>
                <h2 className="mb-2 text-sm font-semibold">{t("sidebar.next")}</h2>
                <ul className="text-muted-foreground flex flex-col gap-1 text-xs">
                  {nextActions.slice(0, 6).map((a, i) => (
                    <li key={i} className="flex items-start gap-1.5">
                      <CheckIcon className="text-status-done mt-0.5 size-3 shrink-0" />
                      {a}
                    </li>
                  ))}
                </ul>
              </section>
            </>
          )}

          <Separator />

          <section>
            <h2 className="mb-2 text-sm font-semibold">{t("sidebar.cliEquiv")}</h2>
            <ul className="text-muted-foreground space-y-1 font-mono text-[11px]">
              <li>agent-kanban context</li>
              <li>{`agent-kanban resume <${t("cli.taskIdArg")}>`}</li>
              <li>agent-kanban board</li>
              <li>agent-kanban doctor --deep</li>
            </ul>
          </section>
        </aside>
      </div>

      {/* ---------- 对话框 ---------- */}
      {/* tasksById 传进详情抽屉：依赖/父任务要显示成"编号 + 标题"，
          只给编号的话用户还得自己回看板上去找那张卡。 */}
      <TaskDetailSheet
        task={selected}
        token={token}
        project={project ?? ""}
        tasksById={tasksById}
        sessionNames={sessionNames}
        onSelect={(id) => {
          const target = tasksById.get(id)
          if (target) setSelected(target)
        }}
        onClose={() => setSelected(null)}
      />

      <NewTaskDialog
        open={newTaskOpen}
        onOpenChange={setNewTaskOpen}
        onConfirm={async (input) => {
          await run(
            {
              kind: "task.create",
              params: {
                title: input.title,
                // 契约字段名是 `description`（CreateTaskParams），不是 `body`：
                // 写成 body 会被服务端静默忽略，用户在"新建任务"里填的描述就丢了。
                // 服务端收到 description 后自己存进 tasks.body 列。
                description: input.description,
                priority: input.priority,
                labels: input.labels,
                checklist: input.checklist,
                blocked_by: input.blocked_by,
              },
            },
            "toast.success.create",
          )
        }}
      />

      <ProgressDialog
        open={dialog?.kind === "progress"}
        onOpenChange={(v) => !v && setDialog(null)}
        task={dialog?.task ?? null}
        onConfirm={async (input) => {
          if (!dialog) return
          await run(
            { kind: "task.progress", params: { task_id: dialog.task.id, ...input } },
            t("toast.success.progress", { id: dialog.task.id }),
          )
        }}
      />

      <HandoffDialog
        open={dialog?.kind === "handoff"}
        onOpenChange={(v) => !v && setDialog(null)}
        task={dialog?.task ?? null}
        onConfirm={async (input) => {
          if (!dialog) return
          await run(
            { kind: "handoff.create", params: { task_id: dialog.task.id, ...input } },
            t("toast.success.handoff"),
          )
        }}
      />

      <ReasonDialog
        open={dialog?.kind === "block" || dialog?.kind === "cancel" || dialog?.kind === "reopen"}
        onOpenChange={(v) => !v && setDialog(null)}
        title={
          dialog?.kind === "block"
            ? t("reason.block.title")
            : dialog?.kind === "cancel"
              ? t("reason.cancel.title")
              : t("reason.reopen.title")
        }
        description={
          dialog?.kind === "block"
            ? t("reason.block.desc")
            : dialog?.kind === "cancel"
              ? t("reason.cancel.desc")
              : t("reason.reopen.desc")
        }
        confirmLabel={
          dialog?.kind === "block"
            ? t("reason.block.title")
            : dialog?.kind === "cancel"
              ? t("reason.cancel.title")
              : t("reason.reopen.title")
        }
        onConfirm={async (reason) => {
          if (!dialog) return
          const op =
            dialog.kind === "block"
              ? { kind: "task.block", params: { task_id: dialog.task.id, reason } }
              : dialog.kind === "cancel"
                ? { kind: "task.cancel", params: { task_id: dialog.task.id, reason } }
                : { kind: "task.reopen", params: { task_id: dialog.task.id, reason } }
          await run(op, t("toast.success.updated"))
        }}
      />

      <ConflictDialog
        open={conflict !== null}
        onOpenChange={(v) => !v && setConflict(null)}
        holder={conflict?.holder ?? null}
        onForce={async () => {
          if (!conflict) return
          await run(
            { kind: "task.claim", params: { task_id: conflict.task.id, force: true } },
            t("toast.success.force", { id: conflict.task.id }),
          )
        }}
      />
    </div>
  )
}

/** 拖拽浮层里的卡片缩略（不需要交互，只要能认出来） */
function TaskCardPreview({ task }: { task: TaskItem }) {
  const meta = STATUS_META[task.status]
  return (
    <div
      className="bg-card flex flex-col gap-1 rounded-lg border p-3 shadow-lg"
      style={{ ["--chip-color" as string]: `var(${meta.colorVar})` }}
    >
      <div className="flex items-center gap-2">
        <span className="lane-accent size-2 rounded-full" />
        <span className="font-mono text-[10px] text-muted-foreground">{task.id}</span>
      </div>
      <p className="line-clamp-2 text-sm font-medium">{task.title}</p>
    </div>
  )
}
