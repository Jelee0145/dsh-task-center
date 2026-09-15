/**
 * Task/run model, input validation, fixed-offset calendar arithmetic, and the
 * pure transitions every mutation is built from.
 *
 * The module is deliberately free of Node, DSH, and Cordis imports: it is the
 * API-independent core of `dsh-task-center` and the only place that decides
 * what a valid task, run, or schedule is.
 *
 * Every instant in this module is an epoch-millisecond number, and every
 * timestamp field is therefore JSON-lossless without a re-parse step. The one
 * exception is {@link AtScheduleSpec.at}, which keeps the caller's canonical
 * RFC 3339 UTC string so a decoded schedule is byte-identical to the accepted
 * input.
 *
 * @module dsh-task-center/domain
 */

/** Lifecycle state the task owner sets explicitly. */
export type TaskState = 'open' | 'paused' | 'done'

/** Where an execution creates or resumes its DSH agent Session. */
export type RunIn = 'new-session' | 'origin-session' | 'session'

/** What caused one execution to start. */
export type RunTrigger = 'manual' | 'schedule'

/** Lifecycle of one execution record. */
export type RunStatus = 'running' | 'completed' | 'accepted' | 'failed'

/**
 * Status the task center shows for a task. It is derived from the task state
 * and its execution records, never stored.
 */
export type AggregateStatus =
  | 'done'
  | 'running'
  | 'awaiting_acceptance'
  | 'failed'
  | 'paused'
  | 'scheduled'
  | 'pending'

declare const taskIdBrand: unique symbol
declare const runIdBrand: unique symbol

/** Opaque identifier of one task. */
export type TaskId = string & { readonly [taskIdBrand]: 'TaskId' }

/** Opaque identifier of one execution record within a task. */
export type RunId = string & { readonly [runIdBrand]: 'RunId' }

/**
 * Brand a raw string as a task identifier without changing its runtime value.
 * @param value - Raw identifier.
 * @returns The same string carrying the {@link TaskId} brand.
 */
export function TaskId(value: string): TaskId {
  return value as TaskId
}

/**
 * Brand a raw string as a run identifier without changing its runtime value.
 * @param value - Raw identifier.
 * @returns The same string carrying the {@link RunId} brand.
 */
export function RunId(value: string): RunId {
  return value as RunId
}

/** A one-shot delay measured from the moment the schedule was created. */
export interface AfterScheduleSpec {
  readonly kind: 'after'
  /** Delay in whole minutes; at least {@link MIN_INTERVAL_MINUTES}. */
  readonly delayMinutes: number
  /**
   * Creation instant the delay is measured from. Captured at creation so
   * {@link import('./schedule.js').nextOccurrence} stays a pure function of the
   * spec and a restart does not restart the countdown.
   */
  readonly anchorMs: number
}

/** A one-shot absolute instant. */
export interface AtScheduleSpec {
  readonly kind: 'at'
  /** Canonical four-digit-year RFC 3339 UTC instant accepted at creation. */
  readonly at: string
}

/** A daily wall-clock recurrence at a fixed captured UTC offset. */
export interface DailyScheduleSpec {
  readonly kind: 'daily'
  /** Hour in the captured local offset, 0-23. */
  readonly hour: number
  /** Minute in the captured local offset, 0-59. */
  readonly minute: number
  /** Offset east of UTC in minutes, captured once at creation. */
  readonly tzOffsetMinutes: number
}

/** A weekly wall-clock recurrence at a fixed captured UTC offset. */
export interface WeeklyScheduleSpec {
  readonly kind: 'weekly'
  /** Weekday in the captured local offset, 0 = Sunday through 6 = Saturday. */
  readonly weekday: number
  /** Hour in the captured local offset, 0-23. */
  readonly hour: number
  /** Minute in the captured local offset, 0-59. */
  readonly minute: number
  /** Offset east of UTC in minutes, captured once at creation. */
  readonly tzOffsetMinutes: number
}

/** A fixed-rate recurrence aligned to its creation anchor. */
export interface EveryScheduleSpec {
  readonly kind: 'every'
  /** Interval in whole minutes; at least {@link MIN_INTERVAL_MINUTES}. */
  readonly intervalMinutes: number
  /** Duration-arithmetic anchor; every occurrence is `anchorMs + n * interval`. */
  readonly anchorMs: number
}

/** One of the five recurrence rules a task schedule can carry. */
export type ScheduleSpec =
  | AfterScheduleSpec
  | AtScheduleSpec
  | DailyScheduleSpec
  | WeeklyScheduleSpec
  | EveryScheduleSpec

/** Discriminator of {@link ScheduleSpec}. */
export type ScheduleKind = ScheduleSpec['kind']

/** A task's normalized schedule. */
export interface Schedule {
  /** Whether the scheduler may fire this schedule. */
  readonly enabled: boolean
  /**
   * Next instant the scheduler must fire, in epoch milliseconds, or null when
   * the schedule is disabled or its one-shot occurrence is spent.
   */
  readonly nextFireAt: number | null
  /** The normalized recurrence rule. */
  readonly spec: ScheduleSpec
}

/** One execution of a task. */
export interface Run {
  readonly id: RunId
  /** What started this execution. */
  readonly trigger: RunTrigger
  readonly status: RunStatus
  /** Instant the execution was admitted, in epoch milliseconds. */
  readonly startedAt: number
  /** Instant the runner returned a terminal status, or null while running. */
  readonly finishedAt: number | null
  /** DSH Session the execution ran in, once one exists. */
  readonly sessionId: string | null
  /** Prompt text handed to the Session. */
  readonly prompt: string
  /** Whether {@link Run.prompt} carried task context beyond the raw title. */
  readonly enriched: boolean
  /** Failure text, set exactly when the status is `failed`. */
  readonly error: string | null
}

/** One scheduled or manual to-do. */
export interface Task {
  readonly id: TaskId
  readonly title: string
  /** Free-form detail; never empty-string-normalized beyond `trim`. */
  readonly note: string
  readonly state: TaskState
  readonly runIn: RunIn
  /** Session the task was created from, when a session asked for it. */
  readonly originSessionId: string | null
  /** Working directory of the creating session, when one existed. */
  readonly originCwd: string | null
  /** Session `runIn: 'session'` targets. */
  readonly targetSessionId: string | null
  /** Workspace an execution attaches its Session to. */
  readonly workspaceId: string | null
  /** Working directory an execution uses. */
  readonly cwd: string | null
  readonly schedule: Schedule | null
  readonly runs: readonly Run[]
  readonly createdAt: number
  readonly updatedAt: number
}

/** The complete persisted task-center value. */
export interface TaskCenterState {
  readonly tasks: readonly Task[]
}

/** The empty task-center value; the result of loading nothing. */
export const EMPTY_STATE: TaskCenterState = Object.freeze({ tasks: Object.freeze([]) })

/** Maximum accepted {@link Task.title} length. */
export const MAX_TITLE_LENGTH = 500

/** Maximum accepted {@link Task.note} length. */
export const MAX_NOTE_LENGTH = 4000

/** Smallest accepted recurrence interval, in minutes. */
export const MIN_INTERVAL_MINUTES = 1

/** Largest accepted distance between now and the next fire, in days. */
export const MAX_HORIZON_DAYS = 366

/** Largest accepted distance between now and the next fire, in minutes. */
export const MAX_HORIZON_MINUTES = MAX_HORIZON_DAYS * 24 * 60

/** Milliseconds in one minute. */
export const MINUTE_MS = 60_000

/** Milliseconds in one hour. */
export const HOUR_MS = 3_600_000

/** Milliseconds in one day. */
export const DAY_MS = 86_400_000

/** Milliseconds in one week. */
export const WEEK_MS = 604_800_000

/** Stable machine-readable reason a task input was rejected. */
export type TaskValidationCode =
  | 'invalid_title'
  | 'invalid_note'
  | 'invalid_state'
  | 'invalid_run_in'
  | 'invalid_schedule_kind'
  | 'invalid_interval'
  | 'invalid_hour'
  | 'invalid_minute'
  | 'invalid_weekday'
  | 'invalid_offset'
  | 'invalid_at'
  | 'at_not_future'
  | 'beyond_horizon'
  | 'invalid_anchor'

/** Error raised when a task or schedule input violates a documented bound. */
export class TaskValidationError extends Error {
  /** Stable machine-readable rejection reason. */
  readonly code: TaskValidationCode

  /**
   * Construct a validation failure.
   * @param code - Stable rejection reason.
   * @param message - Human-readable diagnostic.
   */
  constructor(code: TaskValidationCode, message: string) {
    super(message)
    this.name = 'TaskValidationError'
    this.code = code
  }
}

/** Error raised when an operation names a task that does not exist. */
export class TaskNotFoundError extends Error {
  /** Identifier that was not found. */
  readonly taskId: string

  /**
   * Construct a not-found failure.
   * @param taskId - Identifier that was not found.
   */
  constructor(taskId: string) {
    super(`task ${JSON.stringify(taskId)} does not exist`)
    this.name = 'TaskNotFoundError'
    this.taskId = taskId
  }
}

/** Error raised when an operation names a run that does not exist on its task. */
export class RunNotFoundError extends Error {
  /** Task that was searched. */
  readonly taskId: string
  /** Run identifier that was not found. */
  readonly runId: string

  /**
   * Construct a not-found failure.
   * @param taskId - Task that was searched.
   * @param runId - Run identifier that was not found.
   */
  constructor(taskId: string, runId: string) {
    super(`run ${JSON.stringify(runId)} does not exist on task ${JSON.stringify(taskId)}`)
    this.name = 'RunNotFoundError'
    this.taskId = taskId
    this.runId = runId
  }
}

/** Canonical four-digit-year RFC 3339 UTC instant. */
const UTC_INSTANT = /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/

/**
 * Whether a value is a safe integer, which every instant and count here must be.
 * @param value - Candidate value.
 * @returns True when the value is a safe integer.
 */
export function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

/**
 * Validate one title and return its normalized form.
 * @param value - Candidate title.
 * @returns The trimmed title.
 */
export function normalizeTitle(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TaskValidationError('invalid_title', 'title must be a string')
  }
  const title = value.trim()
  if (title.length === 0 || title.length > MAX_TITLE_LENGTH) {
    throw new TaskValidationError(
      'invalid_title',
      `title must be 1 to ${MAX_TITLE_LENGTH} characters after trimming`,
    )
  }
  return title
}

/**
 * Validate one note and return its normalized form.
 * @param value - Candidate note, or undefined for an absent note.
 * @returns The trimmed note, or the empty string.
 */
export function normalizeNote(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') {
    throw new TaskValidationError('invalid_note', 'note must be a string')
  }
  const note = value.trim()
  if (note.length > MAX_NOTE_LENGTH) {
    throw new TaskValidationError('invalid_note', `note must be at most ${MAX_NOTE_LENGTH} characters`)
  }
  return note
}

/**
 * Validate one run placement.
 * @param value - Candidate {@link RunIn}.
 * @returns The validated value.
 */
export function normalizeRunIn(value: unknown): RunIn {
  if (value === 'new-session' || value === 'origin-session' || value === 'session') return value
  throw new TaskValidationError(
    'invalid_run_in',
    'runIn must be "new-session", "origin-session", or "session"',
  )
}

/**
 * Validate one explicit task state.
 * @param value - Candidate {@link TaskState}.
 * @returns The validated value.
 */
export function normalizeTaskState(value: unknown): TaskState {
  if (value === 'open' || value === 'paused' || value === 'done') return value
  throw new TaskValidationError('invalid_state', 'state must be "open", "paused", or "done"')
}

/**
 * Validate a wall-clock hour.
 * @param value - Candidate hour.
 * @returns The validated hour.
 */
export function normalizeHour(value: unknown): number {
  if (!isSafeInteger(value) || value < 0 || value > 23) {
    throw new TaskValidationError('invalid_hour', 'hour must be an integer from 0 to 23')
  }
  return value
}

/**
 * Validate a wall-clock minute.
 * @param value - Candidate minute.
 * @returns The validated minute.
 */
export function normalizeMinute(value: unknown): number {
  if (!isSafeInteger(value) || value < 0 || value > 59) {
    throw new TaskValidationError('invalid_minute', 'minute must be an integer from 0 to 59')
  }
  return value
}

/**
 * Validate a weekday with Sunday as 0.
 * @param value - Candidate weekday.
 * @returns The validated weekday.
 */
export function normalizeWeekday(value: unknown): number {
  if (!isSafeInteger(value) || value < 0 || value > 6) {
    throw new TaskValidationError('invalid_weekday', 'weekday must be an integer from 0 (Sunday) to 6 (Saturday)')
  }
  return value
}

/**
 * Validate a captured UTC offset.
 * @param value - Candidate offset in minutes east of UTC.
 * @returns The validated offset.
 */
export function normalizeTzOffsetMinutes(value: unknown): number {
  if (!isSafeInteger(value) || value < -14 * 60 || value > 14 * 60) {
    throw new TaskValidationError('invalid_offset', 'tzOffsetMinutes must be an integer from -840 to 840')
  }
  return value
}

/**
 * Validate a recurrence interval in whole minutes.
 * @param value - Candidate interval.
 * @returns The validated interval.
 */
export function normalizeIntervalMinutes(value: unknown): number {
  if (!isSafeInteger(value) || value < MIN_INTERVAL_MINUTES || value > MAX_HORIZON_MINUTES) {
    throw new TaskValidationError(
      'invalid_interval',
      `interval must be an integer from ${MIN_INTERVAL_MINUTES} to ${MAX_HORIZON_MINUTES} minutes`,
    )
  }
  return value
}

/**
 * Require a safe-integer instant.
 * @param value - Candidate instant in epoch milliseconds.
 * @param field - Field name used in the diagnostic.
 * @returns The validated instant.
 */
export function normalizeInstant(value: unknown, field: string): number {
  if (!isSafeInteger(value)) {
    throw new TaskValidationError('invalid_anchor', `${field} must be a safe integer epoch-millisecond instant`)
  }
  return value
}

/**
 * Validate and canonicalize an absolute instant string.
 *
 * The accepted form is the exact `Date.prototype.toISOString()` profile, so a
 * decoded schedule is byte-identical to an accepted one and no normalization
 * is left to the calendar implementation.
 * @param value - Candidate RFC 3339 UTC instant.
 * @returns The canonical instant string.
 */
export function normalizeAtInstant(value: unknown): string {
  if (typeof value !== 'string' || !UTC_INSTANT.test(value)) {
    throw new TaskValidationError(
      'invalid_at',
      'at must be a canonical RFC 3339 UTC instant such as 2030-01-02T03:04:05.000Z',
    )
  }
  const epoch = Date.parse(value)
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    throw new TaskValidationError('invalid_at', 'at must be a real calendar instant')
  }
  return value
}

/**
 * Require a target instant within the accepted horizon.
 * @param targetMs - Candidate fire instant in epoch milliseconds.
 * @param nowMs - Wall-clock creation instant in epoch milliseconds.
 * @returns The candidate instant.
 */
export function assertWithinHorizon(targetMs: number, nowMs: number): number {
  if (!isSafeInteger(targetMs)) {
    throw new TaskValidationError('invalid_at', 'the computed fire instant is not a representable instant')
  }
  if (targetMs > nowMs + MAX_HORIZON_MINUTES * MINUTE_MS) {
    throw new TaskValidationError(
      'beyond_horizon',
      `the next fire instant must be within ${MAX_HORIZON_DAYS} days`,
    )
  }
  return targetMs
}

/** Local day index of a shifted epoch, using floor division. */
function localDayIndex(shiftedMs: number): number {
  return Math.floor(shiftedMs / DAY_MS)
}

/**
 * Weekday of a shifted epoch, with Sunday as 0 and no `Date` allocation.
 * @param shiftedMs - Epoch shifted by the captured UTC offset.
 * @returns Weekday index, 0 = Sunday through 6 = Saturday.
 */
export function weekdayOf(shiftedMs: number): number {
  // 1970-01-01 (day index 0) was a Thursday, which is index 4 with Sunday as 0.
  return (((localDayIndex(shiftedMs) + 4) % 7) + 7) % 7
}

/**
 * Next daily wall-clock occurrence strictly after `fromMs`.
 *
 * The captured offset is applied for every occurrence; no daylight-saving
 * transition is modelled, so a zone that shifts its offset keeps firing at the
 * same UTC instant rather than the same local wall clock.
 * @param hour - Local hour, 0-23.
 * @param minute - Local minute, 0-59.
 * @param tzOffsetMinutes - Captured offset east of UTC in minutes.
 * @param fromMs - Exclusive lower bound in epoch milliseconds.
 * @returns The next occurrence in epoch milliseconds.
 */
export function nextDailyOccurrence(hour: number, minute: number, tzOffsetMinutes: number, fromMs: number): number {
  const offsetMs = tzOffsetMinutes * MINUTE_MS
  const shifted = fromMs + offsetMs
  let candidate = localDayIndex(shifted) * DAY_MS + hour * HOUR_MS + minute * MINUTE_MS
  if (candidate <= shifted) candidate += DAY_MS
  return candidate - offsetMs
}

/**
 * Next weekly wall-clock occurrence strictly after `fromMs`.
 * @param weekday - Local weekday, 0 = Sunday through 6 = Saturday.
 * @param hour - Local hour, 0-23.
 * @param minute - Local minute, 0-59.
 * @param tzOffsetMinutes - Captured offset east of UTC in minutes.
 * @param fromMs - Exclusive lower bound in epoch milliseconds.
 * @returns The next occurrence in epoch milliseconds.
 */
export function nextWeeklyOccurrence(
  weekday: number,
  hour: number,
  minute: number,
  tzOffsetMinutes: number,
  fromMs: number,
): number {
  const offsetMs = tzOffsetMinutes * MINUTE_MS
  const shifted = fromMs + offsetMs
  const dayStart = localDayIndex(shifted) * DAY_MS
  const delta = (((weekday - weekdayOf(shifted)) % 7) + 7) % 7
  let candidate = dayStart + delta * DAY_MS + hour * HOUR_MS + minute * MINUTE_MS
  if (candidate <= shifted) candidate += WEEK_MS
  return candidate - offsetMs
}

/**
 * First anchor-aligned occurrence strictly after `fromMs`.
 *
 * This is a latest-only catch-up: an interval that was missed several times
 * yields the next future occurrence, never the backlog.
 * @param intervalMinutes - Fixed interval in whole minutes.
 * @param anchorMs - Anchor the occurrences are aligned to.
 * @param fromMs - Exclusive lower bound in epoch milliseconds.
 * @returns The next occurrence in epoch milliseconds.
 */
export function nextEveryOccurrence(intervalMinutes: number, anchorMs: number, fromMs: number): number {
  const interval = intervalMinutes * MINUTE_MS
  if (fromMs < anchorMs) return anchorMs
  const steps = Math.floor((fromMs - anchorMs) / interval) + 1
  return anchorMs + steps * interval
}

/**
 * Derive the status the task center shows for a task.
 *
 * Precedence is `done` > `running` > `awaiting_acceptance` > a failure of the
 * newest run > `paused` > `scheduled` > `pending`. An accepted newest run is
 * terminal for display purposes and falls through to the state-based statuses.
 * @param task - Task to classify.
 * @returns The derived status.
 */
export function aggregateStatus(task: Task): AggregateStatus {
  if (task.state === 'done') return 'done'
  if (task.runs.some(run => run.status === 'running')) return 'running'
  const newest = task.runs[task.runs.length - 1]
  if (newest !== undefined && newest.status === 'completed') return 'awaiting_acceptance'
  if (newest !== undefined && newest.status === 'failed') return 'failed'
  if (task.state === 'paused') return 'paused'
  if (task.schedule !== null && task.schedule.enabled && task.schedule.nextFireAt !== null) return 'scheduled'
  return 'pending'
}

/**
 * The newest execution record of a task.
 * @param task - Task to read.
 * @returns The newest run, or undefined when the task never ran.
 */
export function latestRun(task: Task): Run | undefined {
  return task.runs[task.runs.length - 1]
}

/**
 * Apply a partial update to a task, stamping `updatedAt`.
 *
 * A nullable field is cleared by passing `null` explicitly; `undefined` still
 * means "leave it alone", which is why every field is compared against
 * `undefined` rather than coalesced.
 * @param task - Task to copy.
 * @param patch - Fields to replace; `undefined` leaves a field untouched.
 * @param nowMs - Update instant in epoch milliseconds.
 * @returns The updated task.
 */
export function withTaskPatch(task: Task, patch: TaskPatch, nowMs: number): Task {
  return {
    id: task.id,
    title: patch.title ?? task.title,
    note: patch.note ?? task.note,
    state: patch.state ?? task.state,
    runIn: patch.runIn ?? task.runIn,
    originSessionId: patch.originSessionId === undefined ? task.originSessionId : patch.originSessionId,
    originCwd: patch.originCwd === undefined ? task.originCwd : patch.originCwd,
    targetSessionId: patch.targetSessionId === undefined ? task.targetSessionId : patch.targetSessionId,
    workspaceId: patch.workspaceId === undefined ? task.workspaceId : patch.workspaceId,
    cwd: patch.cwd === undefined ? task.cwd : patch.cwd,
    schedule: patch.schedule === undefined ? task.schedule : patch.schedule,
    runs: task.runs,
    createdAt: task.createdAt,
    updatedAt: nowMs,
  }
}

/** Task fields one update may replace. */
export interface TaskPatch {
  readonly title?: string
  readonly note?: string
  readonly state?: TaskState
  readonly runIn?: RunIn
  readonly originSessionId?: string | null
  readonly originCwd?: string | null
  readonly targetSessionId?: string | null
  readonly workspaceId?: string | null
  readonly cwd?: string | null
  readonly schedule?: Schedule | null
}

/**
 * Append one execution record to a task, stamping `updatedAt`.
 * @param task - Task to copy.
 * @param run - Run to append.
 * @param nowMs - Mutation instant in epoch milliseconds.
 * @returns The updated task.
 */
export function withRunAppended(task: Task, run: Run, nowMs: number): Task {
  return { ...task, runs: [...task.runs, run], updatedAt: nowMs }
}

/**
 * Replace one execution record on a task, stamping `updatedAt`.
 * @param task - Task to copy.
 * @param runId - Run to replace.
 * @param update - Pure mapping applied to the existing run.
 * @param nowMs - Mutation instant in epoch milliseconds.
 * @returns The updated task.
 * @throws RunNotFoundError when the task has no such run.
 */
export function withRunUpdated(
  task: Task,
  runId: RunId,
  update: (run: Run) => Run,
  nowMs: number,
): Task {
  const index = task.runs.findIndex(run => run.id === runId)
  if (index < 0) throw new RunNotFoundError(task.id, runId)
  const runs = task.runs.map((run, position) => (position === index ? update(run) : run))
  return { ...task, runs, updatedAt: nowMs }
}
