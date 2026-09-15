import { describe, expect, it } from 'vitest'
import { RunNotFoundError, TaskNotFoundError, TaskValidationError } from '../src/domain.js'
import { TaskStore, summarize } from '../src/store.js'
import { MINUTE, T0 } from './fixtures.js'

/** Build a store with a deterministic clock and identifier sequence. */
function makeStore(now = T0): { store: TaskStore; setNow: (value: number) => void; writes: () => number } {
  let clock = now
  let counter = 0
  const store = new TaskStore({
    now: () => clock,
    newId: prefix => `${prefix}-${++counter}`,
  })
  return {
    store,
    setNow: (value) => { clock = value },
    writes: () => counter,
  }
}

describe('task lifecycle', () => {
  it('creates an open task with the documented defaults', () => {
    const { store } = makeStore()
    const task = store.createTask({ title: '  ship it  ', note: ' details ' })
    expect(task).toMatchObject({
      id: 'task-1',
      title: 'ship it',
      note: 'details',
      state: 'open',
      runIn: 'new-session',
      runs: [],
      schedule: null,
      createdAt: T0,
      updatedAt: T0,
      originSessionId: null,
      originCwd: null,
      targetSessionId: null,
      workspaceId: null,
      cwd: null,
    })
    expect(store.snapshot().tasks).toHaveLength(1)
    expect(store.getTask(task.id)).toBe(task)
  })

  it('attaches a validated schedule at creation', () => {
    const { store } = makeStore()
    const task = store.createTask({ title: 'later', schedule: { kind: 'after', delayMinutes: 5 } })
    expect(task.schedule).toEqual({
      enabled: true,
      nextFireAt: T0 + 5 * MINUTE,
      spec: { kind: 'after', delayMinutes: 5, anchorMs: T0 },
    })
    expect(store.nextFireAt()).toBe(T0 + 5 * MINUTE)
  })

  it('rejects an invalid schedule without mutating the store', () => {
    const { store } = makeStore()
    expect(() => store.createTask({ title: 'bad', schedule: { kind: 'every', intervalMinutes: 0 } }))
      .toThrow(TaskValidationError)
    expect(store.snapshot().tasks).toHaveLength(0)
  })

  it('updates named fields, clears nullable ones, and stamps updatedAt', () => {
    const { store, setNow } = makeStore()
    const task = store.createTask({ title: 'first', cwd: 'C:\\work' })
    setNow(T0 + 100)
    const updated = store.updateTask(task.id, { title: 'second', cwd: null, note: 'note' })
    expect(updated).toMatchObject({ title: 'second', cwd: null, note: 'note', updatedAt: T0 + 100 })
    expect(store.getTask(task.id)).toBe(updated)
  })

  it('replaces and removes a schedule through update', () => {
    const { store } = makeStore()
    const task = store.createTask({ title: 'first', schedule: { kind: 'after', delayMinutes: 5 } })
    const replaced = store.updateTask(task.id, { schedule: { kind: 'every', intervalMinutes: 2 } })
    expect(replaced.schedule?.spec).toEqual({ kind: 'every', intervalMinutes: 2, anchorMs: T0 })
    const removed = store.updateTask(task.id, { schedule: null })
    expect(removed.schedule).toBeNull()
    expect(store.nextFireAt()).toBeNull()
  })

  it('deletes a task and reports the deleted value', () => {
    const { store } = makeStore()
    const task = store.createTask({ title: 'gone' })
    expect(store.deleteTask(task.id).id).toBe(task.id)
    expect(store.snapshot().tasks).toHaveLength(0)
    expect(() => store.deleteTask(task.id)).toThrow(TaskNotFoundError)
  })

  it('refuses to operate on an unknown task', () => {
    const { store } = makeStore()
    expect(() => store.updateTask('missing', { title: 'x' })).toThrow(TaskNotFoundError)
    expect(() => store.startRun('missing', { trigger: 'manual', prompt: 'x' })).toThrow(TaskNotFoundError)
    expect(() => store.complete('missing')).toThrow(TaskNotFoundError)
  })
})

describe('execution records', () => {
  it('admits a run with the initial running record', () => {
    const { store, setNow } = makeStore()
    const task = store.createTask({ title: 'run me' })
    setNow(T0 + 10)
    const { task: after, run } = store.startRun(task.id, {
      trigger: 'manual',
      prompt: 'do it',
      enriched: true,
      sessionId: 's-1',
    })
    expect(run).toEqual({
      id: 'run-2',
      trigger: 'manual',
      status: 'running',
      startedAt: T0 + 10,
      finishedAt: null,
      sessionId: 's-1',
      prompt: 'do it',
      enriched: true,
      error: null,
    })
    expect(after.runs).toEqual([run])
    expect(summarize(after).status).toBe('running')
  })

  it('records a completed outcome and then an acceptance', () => {
    const { store, setNow } = makeStore()
    const task = store.createTask({ title: 'run me' })
    const { run } = store.startRun(task.id, { trigger: 'schedule', prompt: 'do it' })
    setNow(T0 + 20)
    const finished = store.finishRun(task.id, run.id, { status: 'completed', sessionId: 's-9' })
    expect(finished.runs[0]).toMatchObject({
      status: 'completed',
      finishedAt: T0 + 20,
      sessionId: 's-9',
      error: null,
    })
    expect(summarize(finished).status).toBe('awaiting_acceptance')

    setNow(T0 + 30)
    const accepted = store.acceptRun(task.id, run.id)
    expect(accepted.runs[0]).toMatchObject({ status: 'accepted', finishedAt: T0 + 20 })
    expect(summarize(accepted).status).toBe('pending')
  })

  it('records a failure with its error text', () => {
    const { store } = makeStore()
    const task = store.createTask({ title: 'fail' })
    const { run } = store.startRun(task.id, { trigger: 'manual', prompt: 'x' })
    const failed = store.finishRun(task.id, run.id, { status: 'failed', error: 'boom' })
    expect(failed.runs[0]).toMatchObject({ status: 'failed', error: 'boom' })
    expect(summarize(failed).status).toBe('failed')
  })

  it('keeps the full history instead of a single task status', () => {
    const { store, setNow } = makeStore()
    const task = store.createTask({ title: 'many' })
    for (let index = 0; index < 3; index++) {
      setNow(T0 + index * 100)
      const { run } = store.startRun(task.id, { trigger: 'manual', prompt: `attempt ${index}` })
      store.finishRun(task.id, run.id, { status: index === 1 ? 'failed' : 'completed', error: 'nope' })
    }
    const runs = store.requireTask(task.id).runs
    expect(runs.map(run => run.status)).toEqual(['completed', 'failed', 'completed'])
    expect(summarize(store.requireTask(task.id))).toMatchObject({ runCount: 3, latestRunStatus: 'completed' })
  })

  it('refuses to finish the same run twice or accept an unfinished one', () => {
    const { store } = makeStore()
    const task = store.createTask({ title: 'once' })
    const { run } = store.startRun(task.id, { trigger: 'manual', prompt: 'x' })
    expect(() => store.acceptRun(task.id, run.id)).toThrow(/cannot be accepted/)
    store.finishRun(task.id, run.id, { status: 'completed' })
    expect(() => store.finishRun(task.id, run.id, { status: 'failed' })).toThrow(/cannot finish again/)
  })

  it('refuses an unknown run', () => {
    const { store } = makeStore()
    const task = store.createTask({ title: 'x' })
    expect(() => store.finishRun(task.id, 'run-999', { status: 'completed' })).toThrow(RunNotFoundError)
    expect(() => store.acceptRun(task.id, 'run-999')).toThrow(RunNotFoundError)
  })
})

describe('state flags arm and disarm the schedule', () => {
  it('disarms on pause and complete, re-arms on resume and reopen', () => {
    const { store } = makeStore()
    const task = store.createTask({ title: 'recurring', schedule: { kind: 'every', intervalMinutes: 5 } })
    expect(store.requireTask(task.id).schedule?.enabled).toBe(true)

    expect(store.pause(task.id)).toMatchObject({ state: 'paused' })
    expect(store.requireTask(task.id).schedule?.enabled).toBe(false)
    expect(store.nextFireAt()).toBeNull()

    expect(store.resume(task.id)).toMatchObject({ state: 'open' })
    expect(store.requireTask(task.id).schedule?.enabled).toBe(true)
    expect(store.nextFireAt()).toBe(T0 + 5 * MINUTE)

    expect(store.complete(task.id)).toMatchObject({ state: 'done' })
    expect(store.requireTask(task.id).schedule?.enabled).toBe(false)

    expect(store.reopen(task.id)).toMatchObject({ state: 'open' })
    expect(store.requireTask(task.id).schedule?.enabled).toBe(true)
  })

  it('leaves an unscheduled task without a schedule through every flag', () => {
    const { store } = makeStore()
    const task = store.createTask({ title: 'plain' })
    expect(store.pause(task.id).schedule).toBeNull()
    expect(store.resume(task.id).schedule).toBeNull()
    expect(store.complete(task.id).schedule).toBeNull()
    expect(store.reopen(task.id).schedule).toBeNull()
  })
})

describe('due tasks and claiming', () => {
  it('orders due tasks by fire instant and ignores disabled ones', () => {
    const { store } = makeStore()
    store.createTask({ title: 'later', schedule: { kind: 'after', delayMinutes: 10 } })
    store.createTask({ title: 'sooner', schedule: { kind: 'after', delayMinutes: 1 } })
    const paused = store.createTask({ title: 'paused', schedule: { kind: 'after', delayMinutes: 1 } })
    store.pause(paused.id)

    expect(store.dueTasks(T0)).toEqual([])
    const due = store.dueTasks(T0 + 10 * MINUTE)
    expect(due.map(task => task.title)).toEqual(['sooner', 'later'])
  })

  it('advances a recurring schedule on claim and spends a one-shot', () => {
    const { store } = makeStore()
    const oneShot = store.createTask({ title: 'once', schedule: { kind: 'after', delayMinutes: 1 } })
    const recurring = store.createTask({ title: 'often', schedule: { kind: 'every', intervalMinutes: 1 } })

    expect(store.markFired(oneShot.id, T0)).toBeUndefined()
    const claimedOnce = store.markFired(oneShot.id, T0 + MINUTE)
    expect(claimedOnce?.schedule).toEqual({ enabled: false, nextFireAt: null, spec: oneShot.schedule?.spec })
    expect(store.markFired(oneShot.id, T0 + MINUTE)).toBeUndefined()

    const claimedOften = store.markFired(recurring.id, T0 + MINUTE)
    expect(claimedOften?.schedule?.nextFireAt).toBe(T0 + 2 * MINUTE)
  })

  it('reports the earliest armed instant across tasks', () => {
    const { store } = makeStore()
    expect(store.nextFireAt()).toBeNull()
    store.createTask({ title: 'b', schedule: { kind: 'after', delayMinutes: 20 } })
    store.createTask({ title: 'a', schedule: { kind: 'after', delayMinutes: 3 } })
    expect(store.nextFireAt()).toBe(T0 + 3 * MINUTE)
  })
})

describe('aggregation query', () => {
  it('filters by stored state, derived status, placement, and schedule', () => {
    const { store } = makeStore()
    const open = store.createTask({ title: 'open' })
    const scheduled = store.createTask({ title: 'scheduled', schedule: { kind: 'every', intervalMinutes: 1 } })
    const paused = store.createTask({ title: 'paused', runIn: 'session', targetSessionId: 's-1' })
    store.pause(paused.id)

    expect(store.listTasks({ state: 'open' }).map(task => task.title)).toEqual(['open', 'scheduled'])
    expect(store.listTasks({ state: 'paused' }).map(task => task.id)).toEqual([paused.id])
    expect(store.listTasks({ status: 'scheduled' }).map(task => task.id)).toEqual([scheduled.id])
    expect(store.listTasks({ status: 'pending' }).map(task => task.id)).toEqual([open.id])
    expect(store.listTasks({ runIn: 'session' }).map(task => task.id)).toEqual([paused.id])
    expect(store.listTasks({ scheduledOnly: true }).map(task => task.id)).toEqual([scheduled.id])
    expect(store.listTasks({ limit: 1 }).map(task => task.id)).toEqual([open.id])
  })

  it('counts tasks by derived status', () => {
    const { store } = makeStore()
    store.createTask({ title: 'a' })
    store.createTask({ title: 'b', schedule: { kind: 'every', intervalMinutes: 1 } })
    const run = store.createTask({ title: 'c' })
    const { run: record } = store.startRun(run.id, { trigger: 'manual', prompt: 'x' })
    store.finishRun(run.id, record.id, { status: 'completed' })

    expect(store.countByStatus()).toEqual({
      done: 0,
      running: 0,
      awaiting_acceptance: 1,
      failed: 0,
      paused: 0,
      scheduled: 1,
      pending: 1,
    })
  })

  it('summarizes one task for listings', () => {
    const { store } = makeStore()
    const task = store.createTask({ title: 'summary', schedule: { kind: 'after', delayMinutes: 3 } })
    expect(summarize(task)).toEqual({
      id: task.id,
      title: 'summary',
      state: 'open',
      status: 'scheduled',
      runIn: 'new-session',
      nextFireAt: T0 + 3 * MINUTE,
      updatedAt: T0,
      runCount: 0,
      latestRunStatus: null,
    })
  })
})

describe('observability and purity', () => {
  it('notifies subscribers after every committed mutation and stops after unsubscribe', () => {
    const { store } = makeStore()
    const seen: number[] = []
    const unsubscribe = store.subscribe(state => seen.push(state.tasks.length))
    const task = store.createTask({ title: 'a' })
    store.createTask({ title: 'b' })
    unsubscribe()
    store.deleteTask(task.id)
    expect(seen).toEqual([1, 2])
  })

  it('replaces the value instead of mutating it', () => {
    const { store, setNow } = makeStore()
    const before = store.snapshot()
    const task = store.createTask({ title: 'immutable' })
    const after = store.snapshot()
    expect(after).not.toBe(before)
    expect(before.tasks).toHaveLength(0)
    expect(after.tasks).toHaveLength(1)

    setNow(T0 + 1)
    const updatedReference = store.snapshot()
    const updated = store.updateTask(task.id, { title: 'renamed' })
    expect(store.snapshot()).not.toBe(updatedReference)
    expect(updatedReference.tasks[0]?.title).toBe('immutable')
    expect(updated.title).toBe('renamed')
  })

  it('produces the same value for the same call sequence and clock', () => {
    const run = (): string => {
      const { store, setNow } = makeStore()
      const task = store.createTask({ title: 'same', schedule: { kind: 'every', intervalMinutes: 5 } })
      setNow(T0 + MINUTE)
      const { run: record } = store.startRun(task.id, { trigger: 'schedule', prompt: 'p' })
      store.finishRun(task.id, record.id, { status: 'failed', error: 'e' })
      return JSON.stringify(store.snapshot())
    }
    expect(run()).toBe(run())
  })

  it('adopts a loaded value through replaceState', () => {
    const { store } = makeStore()
    const loaded = { tasks: [store.createTask({ title: 'from disk' })] }
    const target = makeStore().store
    target.replaceState(loaded)
    expect(target.snapshot()).toBe(loaded)
    expect(target.listTasks()).toHaveLength(1)
  })
})
