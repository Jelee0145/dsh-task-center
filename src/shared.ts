/**
 * Shared, browser-safe vocabulary of `dsh-task-center`.
 *
 * Types and pure folds only. The host half imports `node:fs`, so a browser
 * bundle must reach the common vocabulary through this entry rather than the
 * package root. The browser plugin entry is `./client`.
 *
 * @module dsh-task-center/shared
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

import type { CreateTaskInput, TaskSummary, UpdateTaskInput } from './store.js'

/**
 * The operations a browser half invokes on the host half.
 *
 * Every argument and result is lossless JSON. The transport is the
 * deployment's: the browser plugin reaches this through whatever channel it is
 * given, and the host half's store and tools stay the single authority behind
 * it.
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
