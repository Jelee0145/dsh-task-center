/**
 * The timer owner for the task center.
 *
 * The scheduler keeps exactly one armed timer for the earliest pending fire
 * instant. Every wake re-reads the wall clock, drains every schedule that is
 * due, and re-arms; the delay is segmented to at most {@link DEFAULT_SEGMENT_MS}
 * so a suspend/resume or a backwards clock jump cannot leave the timer waiting
 * for an instant that already passed. Firing never awaits the execution, so a
 * long run cannot delay the next one.
 *
 * The timer interface is injected, so tests drive the whole scheduler with a
 * virtual clock and no real time passes.
 *
 * @module dsh-task-center/scheduler
 */

import { MINUTE_MS } from './domain.js'
import type { Task } from './domain.js'
import type { TaskStore } from './store.js'

/**
 * One opaque timer token.
 *
 * Production code never inspects it; the injected {@link TimerApi} that minted
 * it is the only owner that reads it back.
 */
export type TimerHandle = unknown

/** The `setTimeout`/`clearTimeout` pair the scheduler drives. */
export interface TimerApi {
  /**
   * Arm one timer.
   * @param handler - Callback invoked when the delay elapses.
   * @param delayMs - Non-negative delay in milliseconds.
   * @returns An opaque token passed back to {@link TimerApi.clearTimeout}.
   */
  setTimeout(handler: () => void, delayMs: number): TimerHandle
  /**
   * Cancel one armed timer.
   * @param handle - Token returned by {@link TimerApi.setTimeout}.
   */
  clearTimeout(handle: TimerHandle): void
}

/** Timer implementation backed by the host's real timers. */
export const systemTimers: TimerApi = {
  setTimeout(handler, delayMs) {
    return setTimeout(handler, delayMs)
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

/**
 * Largest delay one timer segment may cover, in milliseconds.
 *
 * A pending fire within this distance is armed exactly; a later one is
 * re-armed once per segment so every wake re-reads the wall clock.
 */
export const DEFAULT_SEGMENT_MS = 5 * MINUTE_MS

/** Collaborators a {@link Scheduler} needs. */
export interface SchedulerOptions {
  /** Store the scheduler reads due tasks from and claims them on. */
  readonly store: TaskStore
  /**
   * Start one execution. The returned promise is never awaited by the
   * scheduler; a rejection reaches {@link SchedulerOptions.onError}.
   */
  readonly run: (task: Task) => void | Promise<void>
  /** Timer implementation. Defaults to {@link systemTimers}. */
  readonly timers?: TimerApi
  /** Wall-clock source in epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number
  /** Longest delay one timer segment may cover. Defaults to {@link DEFAULT_SEGMENT_MS}. */
  readonly segmentMs?: number
  /** Sink for a rejected execution or a thrown store call. */
  readonly onError?: (error: unknown) => void
}

/** Single-timer owner that fires every due task schedule. */
export class Scheduler {
  private readonly store: TaskStore
  private readonly run: (task: Task) => void | Promise<void>
  private readonly timers: TimerApi
  private readonly now: () => number
  private readonly segmentMs: number
  private readonly onError: (error: unknown) => void
  private handle: TimerHandle | undefined
  private running = false

  /**
   * Construct an inactive scheduler; {@link Scheduler.start} arms the first timer.
   * @param options - Store, execution callback, and injectable time sources.
   */
  constructor(options: SchedulerOptions) {
    this.store = options.store
    this.run = options.run
    this.timers = options.timers ?? systemTimers
    this.now = options.now ?? (() => Date.now())
    this.segmentMs = options.segmentMs ?? DEFAULT_SEGMENT_MS
    this.onError = options.onError ?? (() => {})
  }

  /** Arm the timer and immediately drain anything already due. */
  start(): void {
    this.running = true
    this.wake()
  }

  /** Stop arming timers. An execution already dispatched is not cancelled. */
  stop(): void {
    this.running = false
    this.clearTimer()
  }

  /**
   * Re-read the clock, fire every due schedule, and re-arm.
   *
   * Callers invoke this after any store mutation so a new or edited schedule
   * is armed without waiting for the previous timer to elapse.
   */
  wake(): void {
    if (!this.running) return
    this.clearTimer()
    try {
      const nowMs = this.now()
      for (const task of this.store.dueTasks(nowMs)) {
        const claimed = this.store.markFired(task.id, nowMs)
        if (claimed === undefined) continue
        this.dispatch(claimed)
      }
      this.arm()
    } catch (error: unknown) {
      this.onError(error)
      this.arm()
    }
  }

  /** Invoke one execution without awaiting it. */
  private dispatch(task: Task): void {
    try {
      const result = this.run(task)
      if (result instanceof Promise) void result.catch((error: unknown) => { this.onError(error) })
    } catch (error: unknown) {
      this.onError(error)
    }
  }

  /** Arm one bounded timer segment for the earliest pending instant. */
  private arm(): void {
    if (!this.running) return
    const target = this.store.nextFireAt()
    if (target === null) return
    const delayMs = Math.max(0, Math.min(target - this.now(), this.segmentMs))
    this.handle = this.timers.setTimeout(() => {
      this.handle = undefined
      this.wake()
    }, delayMs)
  }

  /** Cancel the armed timer, if any. */
  private clearTimer(): void {
    if (this.handle === undefined) return
    this.timers.clearTimeout(this.handle)
    this.handle = undefined
  }
}
