/**
 * Observable in-memory task store.
 *
 * The store owns exactly one value, {@link TaskCenterState}, and every mutation
 * replaces it with a new value derived only from the previous value, the
 * arguments, the injected clock, and the injected identifier factory. No
 * mutation reads a timer, a file, or any other ambient state, so the same call
 * sequence always produces the same state and the whole store can be persisted
 * by serializing {@link TaskStore.snapshot}.
 *
 * @module dsh-task-center/store
 */

import type {
  AggregateStatus,
  Run,
  RunIn,
  RunTrigger,
  Task,
  TaskCenterState,
  TaskPatch,
  TaskState,
} from './domain.js'
import {
  EMPTY_STATE,
  RunId as makeRunId,
  TaskId as makeTaskId,
  TaskNotFoundError,
  aggregateStatus,
  latestRun,
  normalizeNote,
  normalizeRunIn,
  normalizeTaskState,
  normalizeTitle,
  withRunAppended,
  withRunUpdated,
  withTaskPatch,
} from './domain.js'
import type { ScheduleInput } from './schedule.js'
import { advanceSchedule, buildSchedule, isDue } from './schedule.js'

/** Input accepted by {@link TaskStore.createTask}. */
export interface CreateTaskInput {
  readonly title: string
  readonly note?: string
  readonly runIn?: RunIn
  readonly originSessionId?: string | null
  readonly originCwd?: string | null
  readonly targetSessionId?: string | null
  readonly workspaceId?: string | null
  readonly cwd?: string | null
  /** Schedule to attach; omitted or null creates an unscheduled task. */
  readonly schedule?: ScheduleInput | null
}

/** Input accepted by {@link TaskStore.updateTask}. */
export interface UpdateTaskInput {
  readonly title?: string
  readonly note?: string
  readonly state?: TaskState
  readonly runIn?: RunIn
  readonly targetSessionId?: string | null
  readonly workspaceId?: string | null
  readonly cwd?: string | null
  /** Replacement schedule, or null to remove the schedule; omitted leaves it. */
  readonly schedule?: ScheduleInput | null
}

/** Input accepted by {@link TaskStore.startRun}. */
export interface StartRunInput {
  readonly trigger: RunTrigger
  /** Prompt text the runner will hand to the Session. */
  readonly prompt: string
  /** Whether the prompt carries task context beyond the raw title. */
  readonly enriched?: boolean
  /** Session the execution was placed in, when already known. */
  readonly sessionId?: string | null
}

/** Terminal outcome {@link TaskStore.finishRun} accepts. */
export type RunOutcome = 'completed' | 'failed'

/** Input accepted by {@link TaskStore.finishRun}. */
export interface FinishRunInput {
  readonly status: RunOutcome
  /** Failure text; required in practice when the status is `failed`. */
  readonly error?: string | null
  /** Session the execution ended up in, when it changed. */
  readonly sessionId?: string | null
}

/** Filter accepted by {@link TaskStore.listTasks}. */
export interface TaskQuery {
  readonly state?: TaskState
  readonly status?: AggregateStatus
  readonly runIn?: RunIn
  /** Keep only tasks whose schedule is enabled with a pending fire instant. */
  readonly scheduledOnly?: boolean
  /** Maximum number of tasks to return, applied after filtering. */
  readonly limit?: number
}

/** One task with its derived status, for tools and UI listings. */
export interface TaskSummary {
  readonly id: string
  readonly title: string
  readonly state: TaskState
  readonly status: AggregateStatus
  readonly runIn: RunIn
  readonly nextFireAt: number | null
  readonly updatedAt: number
  readonly runCount: number
  readonly latestRunStatus: Run['status'] | null
}

/** Collaborators a {@link TaskStore} needs; both are injectable for tests. */
export interface TaskStoreOptions {
  /** Wall-clock source in epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number
  /** Identifier factory. Defaults to a random UUID-based value. */
  readonly newId?: (prefix: string) => string
  /** Value the store starts from. Defaults to {@link EMPTY_STATE}. */
  readonly initialState?: TaskCenterState
}

/** Notification callback invoked with the committed value. */
export type TaskStoreListener = (state: TaskCenterState) => void

/** Default identifier factory built on the platform's random UUID source. */
function defaultNewId(prefix: string): string {
  return `${prefix}-${globalThis.crypto.randomUUID()}`
}

/**
 * Summarize one task for listings.
 * @param task - Task to summarize.
 * @returns A detached summary value.
 */
export function summarize(task: Task): TaskSummary {
  return {
    id: task.id,
    title: task.title,
    state: task.state,
    status: aggregateStatus(task),
    runIn: task.runIn,
    nextFireAt: task.schedule?.nextFireAt ?? null,
    updatedAt: task.updatedAt,
    runCount: task.runs.length,
    latestRunStatus: latestRun(task)?.status ?? null,
  }
}

/** Mutable store over an immutable {@link TaskCenterState} value. */
export class TaskStore {
  private state: TaskCenterState
  private readonly listeners = new Set<TaskStoreListener>()
  private readonly clock: () => number
  private readonly newId: (prefix: string) => string

  /**
   * Construct a store.
   * @param options - Injectable clock, identifier factory, and starting value.
   */
  constructor(options: TaskStoreOptions = {}) {
    this.clock = options.now ?? (() => Date.now())
    this.newId = options.newId ?? defaultNewId
    this.state = options.initialState ?? EMPTY_STATE
  }

  /**
   * Register a listener notified after every committed mutation.
   * @param listener - Callback receiving the committed value.
   * @returns A disposer that removes the listener.
   */
  subscribe(listener: TaskStoreListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * The current value.
   * @returns The committed {@link TaskCenterState}.
   */
  snapshot(): TaskCenterState {
    return this.state
  }

  /**
   * Replace the whole value, as a load from durable storage does.
   * @param state - Value to adopt.
   */
  replaceState(state: TaskCenterState): void {
    this.commit(state)
  }

  /**
   * Read one task.
   * @param id - Task identifier.
   * @returns The task, or undefined.
   */
  getTask(id: string): Task | undefined {
    return this.state.tasks.find(task => task.id === id)
  }

  /**
   * Read one task or fail.
   * @param id - Task identifier.
   * @returns The task.
   * @throws TaskNotFoundError when no such task exists.
   */
  requireTask(id: string): Task {
    const task = this.getTask(id)
    if (task === undefined) throw new TaskNotFoundError(id)
    return task
  }

  /**
   * Filter tasks by the derived and stored fields of {@link TaskQuery}.
   * @param query - Optional filter.
   * @returns Matching tasks in creation order.
   */
  listTasks(query: TaskQuery = {}): Task[] {
    const matched = this.state.tasks.filter((task) => {
      if (query.state !== undefined && task.state !== query.state) return false
      if (query.runIn !== undefined && task.runIn !== query.runIn) return false
      if (query.status !== undefined && aggregateStatus(task) !== query.status) return false
      if (query.scheduledOnly === true) {
        if (task.schedule === null || !task.schedule.enabled || task.schedule.nextFireAt === null) return false
      }
      return true
    })
    return query.limit === undefined ? matched : matched.slice(0, query.limit)
  }

  /**
   * Count tasks by derived status.
   * @returns One count per {@link AggregateStatus} member.
   */
  countByStatus(): Record<AggregateStatus, number> {
    const counts: Record<AggregateStatus, number> = {
      done: 0,
      running: 0,
      awaiting_acceptance: 0,
      failed: 0,
      paused: 0,
      scheduled: 0,
      pending: 0,
    }
    for (const task of this.state.tasks) counts[aggregateStatus(task)]++
    return counts
  }

  /**
   * Create a task.
   * @param input - Task fields.
   * @returns The created task.
   */
  createTask(input: CreateTaskInput): Task {
    const nowMs = this.clock()
    const schedule = input.schedule === undefined || input.schedule === null
      ? null
      : buildSchedule(input.schedule, nowMs)
    const task: Task = {
      id: makeTaskId(this.newId('task')),
      title: normalizeTitle(input.title),
      note: normalizeNote(input.note),
      state: 'open',
      runIn: normalizeRunIn(input.runIn ?? 'new-session'),
      originSessionId: input.originSessionId ?? null,
      originCwd: input.originCwd ?? null,
      targetSessionId: input.targetSessionId ?? null,
      workspaceId: input.workspaceId ?? null,
      cwd: input.cwd ?? null,
      schedule,
      runs: [],
      createdAt: nowMs,
      updatedAt: nowMs,
    }
    this.commit({ tasks: [...this.state.tasks, task] })
    return task
  }

  /**
   * Replace the mutable fields of a task.
   * @param id - Task identifier.
   * @param patch - Fields to replace.
   * @returns The updated task.
   * @throws TaskNotFoundError when no such task exists.
   */
  updateTask(id: string, patch: UpdateTaskInput): Task {
    const nowMs = this.clock()
    const task = this.requireTask(id)
    const fields: TaskPatch = {
      ...(patch.title === undefined ? {} : { title: normalizeTitle(patch.title) }),
      ...(patch.note === undefined ? {} : { note: normalizeNote(patch.note) }),
      ...(patch.state === undefined ? {} : { state: normalizeTaskState(patch.state) }),
      ...(patch.runIn === undefined ? {} : { runIn: normalizeRunIn(patch.runIn) }),
      ...(patch.targetSessionId === undefined ? {} : { targetSessionId: patch.targetSessionId }),
      ...(patch.workspaceId === undefined ? {} : { workspaceId: patch.workspaceId }),
      ...(patch.cwd === undefined ? {} : { cwd: patch.cwd }),
      schedule: patch.schedule === undefined
        ? task.schedule
        : patch.schedule === null
          ? null
          : buildSchedule(patch.schedule, nowMs),
    }
    return this.replaceTask(withTaskPatch(task, fields, nowMs))
  }

  /**
   * Delete a task and every execution record it owns.
   * @param id - Task identifier.
   * @returns The deleted task.
   * @throws TaskNotFoundError when no such task exists.
   */
  deleteTask(id: string): Task {
    const task = this.requireTask(id)
    this.commit({ tasks: this.state.tasks.filter(candidate => candidate.id !== task.id) })
    return task
  }

  /**
   * Admit one execution of a task.
   * @param taskId - Task identifier.
   * @param input - Trigger, prompt, and optional Session.
   * @returns The updated task and the admitted run.
   * @throws TaskNotFoundError when no such task exists.
   */
  startRun(taskId: string, input: StartRunInput): { task: Task; run: Run } {
    const nowMs = this.clock()
    const task = this.requireTask(taskId)
    const run: Run = {
      id: makeRunId(this.newId('run')),
      trigger: input.trigger,
      status: 'running',
      startedAt: nowMs,
      finishedAt: null,
      sessionId: input.sessionId ?? null,
      prompt: input.prompt,
      enriched: input.enriched ?? false,
      error: null,
    }
    return { task: this.replaceTask(withRunAppended(task, run, nowMs)), run }
  }

  /**
   * Record a terminal outcome for one execution.
   *
   * The accepted statuses are `completed` and `failed`. Acceptance is a user
   * decision and only {@link TaskStore.acceptRun} can set it.
   * @param taskId - Task identifier.
   * @param runId - Run identifier.
   * @param input - Terminal status and optional detail.
   * @returns The updated task.
   * @throws TaskNotFoundError when no such task exists.
   * @throws RunNotFoundError when the task has no such run.
   * @throws Error when the run is not currently running.
   */
  finishRun(taskId: string, runId: string, input: FinishRunInput): Task {
    const nowMs = this.clock()
    const task = this.requireTask(taskId)
    return this.replaceTask(withRunUpdated(task, makeRunId(runId), (run) => {
      if (run.status !== 'running') {
        throw new Error(`run ${JSON.stringify(runId)} is ${run.status} and cannot finish again`)
      }
      return {
        ...run,
        status: input.status,
        finishedAt: nowMs,
        sessionId: input.sessionId ?? run.sessionId,
        error: input.status === 'failed' ? (input.error ?? 'execution failed') : null,
      }
    }, nowMs))
  }

  /**
   * Accept one finished execution. Only a user-facing acceptance path may call this.
   * @param taskId - Task identifier.
   * @param runId - Run identifier.
   * @returns The updated task.
   * @throws TaskNotFoundError when no such task exists.
   * @throws RunNotFoundError when the task has no such run.
   * @throws Error when the run has not completed.
   */
  acceptRun(taskId: string, runId: string): Task {
    const nowMs = this.clock()
    const task = this.requireTask(taskId)
    return this.replaceTask(withRunUpdated(task, makeRunId(runId), (run) => {
      if (run.status !== 'completed') {
        throw new Error(`run ${JSON.stringify(runId)} is ${run.status} and cannot be accepted`)
      }
      return { ...run, status: 'accepted', finishedAt: run.finishedAt ?? nowMs }
    }, nowMs))
  }

  /**
   * Mark a task done and disarm its schedule.
   * @param id - Task identifier.
   * @returns The updated task.
   */
  complete(id: string): Task {
    return this.setStateFlag(id, 'done')
  }

  /**
   * Return a task to the open state and re-arm its schedule.
   * @param id - Task identifier.
   * @returns The updated task.
   */
  reopen(id: string): Task {
    return this.setStateFlag(id, 'open')
  }

  /**
   * Pause a task and disarm its schedule.
   * @param id - Task identifier.
   * @returns The updated task.
   */
  pause(id: string): Task {
    return this.setStateFlag(id, 'paused')
  }

  /**
   * Resume a paused task and re-arm its schedule.
   * @param id - Task identifier.
   * @returns The updated task.
   */
  resume(id: string): Task {
    return this.setStateFlag(id, 'open')
  }

  /**
   * Tasks whose enabled schedule is due at `nowMs`, earliest first.
   * @param nowMs - Wall-clock instant in epoch milliseconds.
   * @returns Due tasks ordered by fire instant.
   */
  dueTasks(nowMs: number): Task[] {
    return this.state.tasks
      .filter(task => task.schedule !== null && isDue(task.schedule, nowMs))
      .sort((left, right) => (left.schedule?.nextFireAt ?? 0) - (right.schedule?.nextFireAt ?? 0))
  }

  /**
   * The earliest pending fire instant across enabled schedules.
   * @returns The instant in epoch milliseconds, or null when nothing is armed.
   */
  nextFireAt(): number | null {
    let earliest: number | null = null
    for (const task of this.state.tasks) {
      const candidate = task.schedule?.enabled === true ? task.schedule.nextFireAt : null
      if (candidate !== null && (earliest === null || candidate < earliest)) earliest = candidate
    }
    return earliest
  }

  /**
   * Claim one due schedule before its execution starts, so a re-entrant wake
   * cannot fire the same occurrence twice.
   * @param id - Task identifier.
   * @param nowMs - Wall-clock instant in epoch milliseconds.
   * @returns The claimed task, or undefined when it is not due.
   * @throws TaskNotFoundError when no such task exists.
   */
  markFired(id: string, nowMs: number): Task | undefined {
    const task = this.requireTask(id)
    if (task.schedule === null || !isDue(task.schedule, nowMs)) return undefined
    return this.replaceTask({
      ...task,
      schedule: advanceSchedule(task.schedule, nowMs),
      updatedAt: nowMs,
    })
  }

  /** Apply one task-state flag, arming or disarming the schedule to match. */
  private setStateFlag(id: string, state: TaskState): Task {
    const nowMs = this.clock()
    const task = this.requireTask(id)
    const schedule = this.rearm(task.schedule, state === 'open', nowMs)
    return this.replaceTask(withTaskPatch(task, { state, schedule }, nowMs))
  }

  /** Arm or disarm a schedule for a state transition. */
  private rearm(schedule: Task['schedule'], armed: boolean, nowMs: number): Task['schedule'] {
    if (schedule === null) return null
    if (!armed) return { ...schedule, enabled: false }
    const advanced = advanceSchedule(schedule, nowMs)
    return { ...advanced, enabled: advanced.nextFireAt !== null }
  }

  /** Commit a replaced task and return it. */
  private replaceTask(task: Task): Task {
    this.commit({ tasks: this.state.tasks.map(candidate => (candidate.id === task.id ? task : candidate)) })
    return task
  }

  /** Adopt a value and notify every listener. */
  private commit(state: TaskCenterState): void {
    this.state = state
    for (const listener of [...this.listeners]) listener(state)
  }
}
