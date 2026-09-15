/**
 * Browser-safe surface of `dsh-task-center`.
 *
 * Types only. The host half imports `node:fs`, so a browser bundle must reach
 * the shared vocabulary through this entry instead of the package root.
 *
 * @module dsh-task-center/client
 */

export type {
  AfterScheduleSpec,
  AggregateStatus,
  AtScheduleSpec,
  DailyScheduleSpec,
  EveryScheduleSpec,
  Run,
  RunId,
  RunIn,
  RunStatus,
  RunTrigger,
  Schedule,
  ScheduleKind,
  ScheduleSpec,
  Task,
  TaskCenterState,
  TaskId,
  TaskState,
  WeeklyScheduleSpec,
} from './domain.js'

import type { CreateTaskInput, TaskSummary, UpdateTaskInput } from './store.js'

export type {
  CreateTaskInput,
  FinishRunInput,
  RunOutcome,
  StartRunInput,
  TaskQuery,
  TaskSummary,
  UpdateTaskInput,
} from './store.js'

export type { ScheduleInput } from './schedule.js'

export { describeSchedule } from './schedule.js'

export {
  MAX_NOTE_LENGTH,
  MAX_TITLE_LENGTH,
  MIN_INTERVAL_MINUTES,
  MAX_HORIZON_DAYS,
  aggregateStatus,
} from './domain.js'

/**
 * The operations a browser half invokes on the host half.
 *
 * Every argument and result is lossless JSON. A client plugin calls this
 * through whatever transport its deployment provides; the host half's store and
 * tools are the single authority behind it.
 */
export interface TaskCenterApi {
  /** Every task, newest first, with aggregate status and next fire time. */
  snapshot(): Promise<{ now: string; tasks: TaskSummary[] }>
  /** Create a task. */
  create(input: CreateTaskInput): Promise<{ ok: true; task: TaskSummary }>
  /** Patch a task, or settle one of its executions. */
  update(id: string, patch: UpdateTaskInput): Promise<{ ok: true; task: TaskSummary }>
  /** Delete a task and its execution history. */
  remove(id: string): Promise<{ ok: true; deleted: boolean }>
  /** Run a task now without touching its plan. */
  runNow(id: string): Promise<{ ok: true; taskId: string; runId: string }>
  /** Pause the plan. */
  pause(id: string): Promise<{ ok: true; task: TaskSummary }>
  /** Resume the plan. */
  resume(id: string): Promise<{ ok: true; task: TaskSummary }>
  /** Accept one execution. User-only: no model tool reaches this. */
  acceptRun(id: string, runId: string): Promise<{ ok: true; task: TaskSummary }>
  /** Complete the task. User-only: no model tool reaches this. */
  complete(id: string): Promise<{ ok: true; task: TaskSummary }>
  /** Reopen a completed task. */
  reopen(id: string): Promise<{ ok: true; task: TaskSummary }>
}
