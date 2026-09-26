/** 领域类型（与后端 snake_case 输出保持一致，不做驼峰转换，减少心智负担） */

export type KanbanEventType =
  | "session_started"
  | "session_heartbeat"
  | "session_closed"
  | "session_crashed"
  | "task_created"
  | "task_updated"
  | "task_ready"
  | "task_claimed"
  | "task_released"
  | "task_reclaimed"
  | "task_progress"
  | "task_note"
  | "task_blocked"
  | "task_unblocked"
  | "task_review"
  | "task_done"
  | "task_cancelled"
  | "task_reopened"
  | "task_removed"
  | "dep_added"
  | "dep_removed"
  | "plan_created"
  | "plan_superseded"
  | "handoff_created"
  | "handoff_consumed"
  | "board_exported"
  | "board_imported"
  | "protocol_installed"

export interface KanbanEvent {
  seq: number
  ts: number
  session_id: string | null
  type: KanbanEventType
  task_id: string | null
  plan_id: string | null
  project_key: string | null
  data: Record<string, unknown>
}
