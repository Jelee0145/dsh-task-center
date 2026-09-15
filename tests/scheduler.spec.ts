import { describe, expect, it } from 'vitest'
import type { Task } from '../src/domain.js'
import type { TimerApi, TimerHandle } from '../src/scheduler.js'
import { DEFAULT_SEGMENT_MS, Scheduler } from '../src/scheduler.js'
import { TaskStore } from '../src/store.js'
import { MINUTE, T0 } from './fixtures.js'

/** One armed timer in the virtual clock. */
interface PendingTimer {
  readonly at: number
  readonly handler: () => void
}

/** Deterministic timer implementation that never touches a real clock. */
class FakeTimers implements TimerApi {
  private current = T0
  private sequence = 0
  private readonly pending = new Map<number, PendingTimer>()

  setTimeout(handler: () => void, delayMs: number): TimerHandle {
    const id = ++this.sequence
    this.pending.set(id, { at: this.current + delayMs, handler })
    return id
  }

  clearTimeout(handle: TimerHandle): void {
    this.pending.delete(handle as number)
  }

  /** Current virtual wall-clock instant. */
  now(): number {
    return this.current
  }

  /** Number of armed timers. */
  armed(): number {
    return this.pending.size
  }

  /** Delay of the earliest armed timer, or undefined when none is armed. */
  nextDelay(): number | undefined {
    let earliest: number | undefined
    for (const entry of this.pending.values()) {
      const delay = entry.at - this.current
      if (earliest === undefined || delay < earliest) earliest = delay
    }
    return earliest
  }

  /** Move the clock without running anything, as a suspend/resume jump does. */
  setCurrent(instant: number): void {
    this.current = instant
  }

  /** Advance the virtual clock, running every timer that becomes due. */
  advance(ms: number): void {
    const target = this.current + ms
    for (;;) {
      let nextId: number | undefined
      let next: PendingTimer | undefined
      for (const [id, entry] of this.pending) {
        if (entry.at <= target && (next === undefined || entry.at < next.at)) {
          nextId = id
          next = entry
        }
      }
      if (nextId === undefined || next === undefined) break
      this.pending.delete(nextId)
      this.current = next.at
      next.handler()
    }
    this.current = target
  }
}

/** Wire a store, virtual timers, and a recording execution callback. */
function makeHarness(options: { segmentMs?: number; onError?: (error: unknown) => void } = {}) {
  const timers = new FakeTimers()
  let counter = 0
  const store = new TaskStore({ now: () => timers.now(), newId: prefix => `${prefix}-${++counter}` })
  const fired: Task[] = []
  const scheduler = new Scheduler({
    store,
    timers,
    now: () => timers.now(),
    run: (task) => { fired.push(task) },
    onError: options.onError ?? (() => {}),
    ...(options.segmentMs === undefined ? {} : { segmentMs: options.segmentMs }),
  })
  return { timers, store, scheduler, fired }
}

describe('arming', () => {
  it('arms nothing while no schedule is pending', () => {
    const { scheduler, timers } = makeHarness()
    scheduler.start()
    expect(timers.armed()).toBe(0)
  })

  it('arms one timer for the earliest pending instant', () => {
    const { scheduler, timers, store } = makeHarness()
    store.createTask({ title: 'late', schedule: { kind: 'after', delayMinutes: 30 } })
    store.createTask({ title: 'soon', schedule: { kind: 'after', delayMinutes: 5 } })
    scheduler.start()
    expect(timers.armed()).toBe(1)
    expect(timers.nextDelay()).toBe(5 * MINUTE)
  })

  it('segments a long delay into bounded wakeups that re-read the clock', () => {
    const { scheduler, timers, store, fired } = makeHarness()
    store.createTask({ title: 'much later', schedule: { kind: 'after', delayMinutes: 10 } })
    scheduler.start()
    expect(timers.nextDelay()).toBe(DEFAULT_SEGMENT_MS)

    // Five one-minute segments cover five minutes without firing anything.
    timers.advance(5 * MINUTE)
    expect(fired).toEqual([])
    expect(timers.armed()).toBe(1)
    expect(timers.nextDelay()).toBe(DEFAULT_SEGMENT_MS)
    expect(timers.now()).toBe(T0 + 5 * MINUTE)
  })

  it('honours a custom segment length', () => {
    const { scheduler, timers, store } = makeHarness({ segmentMs: 1000 })
    store.createTask({ title: 'later', schedule: { kind: 'after', delayMinutes: 1 } })
    scheduler.start()
    expect(timers.nextDelay()).toBe(1000)
  })
})

describe('firing', () => {
  it('fires at the due instant and spends a one-shot schedule', () => {
    const { scheduler, timers, store, fired } = makeHarness()
    const task = store.createTask({ title: 'once', schedule: { kind: 'after', delayMinutes: 1 } })
    scheduler.start()

    timers.advance(MINUTE - 1)
    expect(fired).toEqual([])

    timers.advance(1)
    expect(fired.map(entry => entry.id)).toEqual([task.id])
    expect(store.requireTask(task.id).schedule).toMatchObject({ enabled: false, nextFireAt: null })
    expect(timers.armed()).toBe(0)
  })

  it('re-arms after every fire and fires a recurrence repeatedly', () => {
    const { scheduler, timers, store, fired } = makeHarness()
    const task = store.createTask({ title: 'often', schedule: { kind: 'every', intervalMinutes: 1 } })
    scheduler.start()

    timers.advance(MINUTE)
    expect(fired).toHaveLength(1)
    expect(timers.armed()).toBe(1)
    expect(store.requireTask(task.id).schedule?.nextFireAt).toBe(T0 + 2 * MINUTE)

    timers.advance(2 * MINUTE)
    expect(fired).toHaveLength(3)
    expect(store.requireTask(task.id).schedule?.nextFireAt).toBe(T0 + 4 * MINUTE)
  })

  it('catches up to the latest occurrence instead of replaying a backlog', () => {
    const { scheduler, timers, store, fired } = makeHarness()
    const task = store.createTask({ title: 'often', schedule: { kind: 'every', intervalMinutes: 1 } })
    scheduler.start()

    // A suspend/resume jump moves the clock past five occurrences without the
    // timer having run; the wake fires once and the claim advances the schedule
    // past every occurrence that was missed meanwhile.
    timers.setCurrent(T0 + 5 * MINUTE)
    scheduler.wake()
    expect(fired).toHaveLength(1)
    expect(store.requireTask(task.id).schedule?.nextFireAt).toBe(T0 + 6 * MINUTE)
  })

  it('never blocks on a running execution', () => {
    const timers = new FakeTimers()
    let counter = 0
    const store = new TaskStore({ now: () => timers.now(), newId: prefix => `${prefix}-${++counter}` })
    const task = store.createTask({ title: 'slow', schedule: { kind: 'every', intervalMinutes: 1 } })
    const unresolved = new Promise<void>(() => {})
    const scheduler = new Scheduler({
      store,
      timers,
      now: () => timers.now(),
      run: () => unresolved,
    })
    scheduler.start()

    timers.advance(MINUTE)
    expect(timers.armed()).toBe(1)
    timers.advance(2 * MINUTE)
    expect(store.requireTask(task.id).schedule?.nextFireAt).toBe(T0 + 4 * MINUTE)
  })

  it('reports a rejected execution through onError without stopping the loop', async () => {
    const errors: unknown[] = []
    const timers = new FakeTimers()
    let counter = 0
    const store = new TaskStore({ now: () => timers.now(), newId: prefix => `${prefix}-${++counter}` })
    const task = store.createTask({ title: 'fails', schedule: { kind: 'every', intervalMinutes: 1 } })
    const scheduler = new Scheduler({
      store,
      timers,
      now: () => timers.now(),
      run: () => Promise.reject(new Error('execution exploded')),
      onError: (error) => { errors.push(error) },
    })
    scheduler.start()
    timers.advance(MINUTE)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(errors).toHaveLength(1)
    expect(store.requireTask(task.id).schedule?.nextFireAt).toBe(T0 + 2 * MINUTE)
  })

  it('contains a synchronous throw from the execution callback', () => {
    const errors: unknown[] = []
    const timers = new FakeTimers()
    let counter = 0
    const store = new TaskStore({ now: () => timers.now(), newId: prefix => `${prefix}-${++counter}` })
    store.createTask({ title: 'throws', schedule: { kind: 'every', intervalMinutes: 1 } })
    const scheduler = new Scheduler({
      store,
      timers,
      now: () => timers.now(),
      run: () => { throw new Error('synchronous failure') },
      onError: (error) => { errors.push(error) },
    })
    scheduler.start()
    timers.advance(MINUTE)
    expect(errors).toHaveLength(1)
  })
})

describe('wake and stop', () => {
  it('re-arms when a new earlier schedule is added', () => {
    const { scheduler, timers, store } = makeHarness()
    store.createTask({ title: 'late', schedule: { kind: 'after', delayMinutes: 30 } })
    scheduler.start()
    expect(timers.nextDelay()).toBe(DEFAULT_SEGMENT_MS)

    store.createTask({ title: 'soon', schedule: { kind: 'after', delayMinutes: 2 } })
    scheduler.wake()
    expect(timers.armed()).toBe(1)
    expect(timers.nextDelay()).toBe(2 * MINUTE)
  })

  it('fires a schedule that became due during a clock jump', () => {
    const { scheduler, timers, store, fired } = makeHarness()
    const task = store.createTask({ title: 'overdue', schedule: { kind: 'after', delayMinutes: 1 } })
    scheduler.start()

    // A suspend/resume jump moves the clock past the due instant without the
    // timer having run; the next wake re-reads the clock and fires.
    timers.setCurrent(T0 + 10 * MINUTE)
    scheduler.wake()
    expect(fired.map(entry => entry.id)).toEqual([task.id])
    expect(store.requireTask(task.id).schedule).toMatchObject({ enabled: false, nextFireAt: null })
  })

  it('stops arming after stop and ignores later wakes', () => {
    const { scheduler, timers, store, fired } = makeHarness()
    store.createTask({ title: 'often', schedule: { kind: 'every', intervalMinutes: 1 } })
    scheduler.start()
    expect(timers.armed()).toBe(1)

    scheduler.stop()
    expect(timers.armed()).toBe(0)
    timers.advance(10 * MINUTE)
    scheduler.wake()
    expect(fired).toEqual([])
    expect(timers.armed()).toBe(0)
  })

  it('does not fire when nothing is due at the armed instant', () => {
    const { scheduler, timers, store, fired } = makeHarness()
    store.createTask({ title: 'later', schedule: { kind: 'after', delayMinutes: 2 } })
    scheduler.start()
    timers.advance(MINUTE)
    expect(fired).toEqual([])
    expect(timers.armed()).toBe(1)
  })
})
