import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TaskCenterState } from '../src/domain.js'
import {
  DEFAULT_DEBOUNCE_MS,
  ROOT_ENV_VAR,
  STATE_FILE_NAME,
  STATE_VERSION,
  TaskPersistence,
  TaskPersistenceVersionError,
  encodePersistedState,
  resolveTaskCenterRoot,
} from '../src/persistence.js'
import { TaskStore } from '../src/store.js'
import { MINUTE, T0 } from './fixtures.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-task-center-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Whether a path exists. */
async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}

/** Build a store whose value can be persisted directly. */
function seedStore(): TaskStore {
  let counter = 0
  const store = new TaskStore({ now: () => T0, newId: prefix => `${prefix}-${++counter}` })
  store.createTask({ title: 'plain', note: 'no schedule' })
  store.createTask({ title: 'after', schedule: { kind: 'after', delayMinutes: 5 } })
  store.createTask({ title: 'at', schedule: { kind: 'at', at: '2030-06-01T12:00:00.000Z' } })
  store.createTask({ title: 'daily', schedule: { kind: 'daily', hour: 9, minute: 30, tzOffsetMinutes: 120 } })
  store.createTask({ title: 'weekly', schedule: { kind: 'weekly', weekday: 5, hour: 17, minute: 0, tzOffsetMinutes: -300 } })
  store.createTask({ title: 'every', schedule: { kind: 'every', intervalMinutes: 15 } })
  const ran = store.createTask({ title: 'ran', runIn: 'session', targetSessionId: 's-42' })
  const { run } = store.startRun(ran.id, { trigger: 'schedule', prompt: 'do it', enriched: true, sessionId: 's-42' })
  store.finishRun(ran.id, run.id, { status: 'failed', error: 'boom' })
  return store
}

describe('root directory resolution', () => {
  it('prefers an explicit root over the environment', () => {
    expect(resolveTaskCenterRoot({ rootDir: 'C:\\explicit', env: { [ROOT_ENV_VAR]: 'C:\\from-env' } }))
      .toBe('C:\\explicit')
  })

  it('reads the environment variable when no explicit root is given', () => {
    expect(resolveTaskCenterRoot({ env: { [ROOT_ENV_VAR]: 'C:\\from-env' } })).toBe('C:\\from-env')
  })

  it('ignores an empty environment value and falls through to the home directory', () => {
    expect(resolveTaskCenterRoot({ env: { [ROOT_ENV_VAR]: '' } }))
      .toBe(join(homedir(), '.dsh', 'tasks'))
  })

  it('falls through to the home directory when the variable is unset', () => {
    expect(resolveTaskCenterRoot({ env: {} })).toBe(join(homedir(), '.dsh', 'tasks'))
  })

  it('reports the resolved root and file path on the instance', () => {
    const persistence = new TaskPersistence({ rootDir: root })
    expect(persistence.rootDir).toBe(root)
    expect(persistence.filePath).toBe(join(root, STATE_FILE_NAME))
  })
})

describe('durable round trip', () => {
  it('writes version 1 and reads back an identical value', async () => {
    const store = seedStore()
    const writer = new TaskPersistence({ rootDir: root, now: () => T0 })
    writer.schedule(store.snapshot())
    await writer.flush()

    const raw = JSON.parse(await readFile(join(root, STATE_FILE_NAME), 'utf8')) as {
      version: number
      savedAt: number
      tasks: unknown[]
    }
    expect(raw.version).toBe(STATE_VERSION)
    expect(raw.savedAt).toBe(T0)
    expect(raw.tasks).toHaveLength(7)

    const reader = new TaskPersistence({ rootDir: root })
    const result = await reader.load()
    expect(result.outcome).toBe('loaded')
    expect(result.backupPath).toBeNull()
    expect(result.state.tasks).toEqual(store.snapshot().tasks)
  })

  it('reports a missing file as missing and empty', async () => {
    const result = await new TaskPersistence({ rootDir: root }).load()
    expect(result).toMatchObject({ outcome: 'missing', backupPath: null, detail: null })
    expect(result.state.tasks).toEqual([])
  })

  it('reports an empty file as empty without quarantining it', async () => {
    await writeFile(join(root, STATE_FILE_NAME), '   \n', 'utf8')
    const result = await new TaskPersistence({ rootDir: root }).load()
    expect(result).toMatchObject({ outcome: 'empty', backupPath: null })
    expect(result.state.tasks).toEqual([])
    expect(await exists(join(root, STATE_FILE_NAME))).toBe(true)
  })
})

describe('malformed content is quarantined, never fatal', () => {
  it('backs up invalid JSON and returns the empty state', async () => {
    const target = join(root, STATE_FILE_NAME)
    await writeFile(target, '{ not json', 'utf8')
    const result = await new TaskPersistence({ rootDir: root, now: () => T0 }).load()
    expect(result.outcome).toBe('recovered')
    expect(result.state.tasks).toEqual([])
    expect(result.backupPath).toContain('.corrupt-')
    expect(await readFile(result.backupPath as string, 'utf8')).toBe('{ not json')
    expect(await exists(target)).toBe(false)
  })

  it('backs up JSON of the right version but the wrong structure', async () => {
    await writeFile(join(root, STATE_FILE_NAME), JSON.stringify({ version: 1, savedAt: T0, tasks: 'nope' }), 'utf8')
    const result = await new TaskPersistence({ rootDir: root, now: () => T0 }).load()
    expect(result.outcome).toBe('recovered')
    expect(result.detail).toContain('version 1 format')
  })

  it('backs up a task that fails validation', async () => {
    await writeFile(
      join(root, STATE_FILE_NAME),
      JSON.stringify({ version: 1, savedAt: T0, tasks: [{ id: 'task-1', title: '' }] }),
      'utf8',
    )
    const result = await new TaskPersistence({ rootDir: root, now: () => T0 }).load()
    expect(result.outcome).toBe('recovered')
    expect(result.state.tasks).toEqual([])
  })

  it('fails loud on an unknown future version and leaves the file alone', async () => {
    const target = join(root, STATE_FILE_NAME)
    const payload = JSON.stringify({ version: 2, savedAt: T0, tasks: [] })
    await writeFile(target, payload, 'utf8')
    await expect(new TaskPersistence({ rootDir: root }).load()).rejects.toBeInstanceOf(TaskPersistenceVersionError)
    expect(await readFile(target, 'utf8')).toBe(payload)
  })

  it('fails loud on a missing version field only through quarantine, not a crash', async () => {
    await writeFile(join(root, STATE_FILE_NAME), JSON.stringify({ savedAt: T0, tasks: [] }), 'utf8')
    const result = await new TaskPersistence({ rootDir: root, now: () => T0 }).load()
    expect(result.outcome).toBe('recovered')
  })
})

describe('atomic and coalesced writes', () => {
  it('leaves no temporary file behind after a write', async () => {
    const persistence = new TaskPersistence({ rootDir: root, now: () => T0 })
    persistence.schedule(seedStore().snapshot())
    await persistence.flush()
    const entries = await readdir(root)
    expect(entries).toEqual([STATE_FILE_NAME])
  })

  it('coalesces several queued values into one write of the newest value', async () => {
    let nowCalls = 0
    const persistence = new TaskPersistence({
      rootDir: root,
      now: () => { nowCalls += 1; return T0 },
      debounceMs: 60_000,
    })
    const store = new TaskStore({ now: () => T0 })
    const first = store.createTask({ title: 'first' })
    persistence.schedule(store.snapshot())
    store.createTask({ title: 'second' })
    persistence.schedule(store.snapshot())
    store.updateTask(first.id, { title: 'renamed' })
    persistence.schedule(store.snapshot())

    // The debounce window has not elapsed: nothing has been written yet.
    expect(await exists(join(root, STATE_FILE_NAME))).toBe(false)
    expect(nowCalls).toBe(0)

    await persistence.flush()
    expect(nowCalls).toBe(1)
    const loaded = await new TaskPersistence({ rootDir: root }).load()
    expect(loaded.state.tasks.map(task => task.title)).toEqual(['renamed', 'second'])
  })

  it('writes nothing when no value was ever queued', async () => {
    const persistence = new TaskPersistence({ rootDir: root, now: () => T0 })
    await persistence.flush()
    expect(await readdir(root)).toEqual([])
  })

  it('flushes a queued value on dispose', async () => {
    const persistence = new TaskPersistence({ rootDir: root, now: () => T0, debounceMs: 60_000 })
    persistence.schedule({ tasks: [] })
    await persistence.dispose()
    expect(await exists(join(root, STATE_FILE_NAME))).toBe(true)
  })

  it('serializes overlapping flushes without losing the newest value', async () => {
    const persistence = new TaskPersistence({ rootDir: root, now: () => T0 })
    const store = new TaskStore({ now: () => T0 })
    persistence.schedule(store.snapshot())
    const store2 = new TaskStore({ now: () => T0 })
    store2.createTask({ title: 'second generation' })
    persistence.schedule(store2.snapshot())
    await Promise.all([persistence.flush(), persistence.flush()])
    const loaded = await new TaskPersistence({ rootDir: root }).load()
    expect(loaded.state.tasks.map(task => task.title)).toEqual(['second generation'])
  })

  it('reports a background write failure through onError', async () => {
    const errors: unknown[] = []
    // A file where the root directory should be makes mkdir fail.
    const fileRoot = join(root, 'blocked')
    await writeFile(fileRoot, 'not a directory', 'utf8')
    const persistence = new TaskPersistence({
      rootDir: fileRoot,
      now: () => T0,
      debounceMs: 1,
      onError: (error) => { errors.push(error) },
    })
    persistence.schedule({ tasks: [] })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(errors).toHaveLength(1)
  })
})

describe('encoding', () => {
  it('writes exactly the documented fields', () => {
    const state: TaskCenterState = { tasks: [] }
    expect(Object.keys(encodePersistedState(state, T0)).sort()).toEqual(['savedAt', 'tasks', 'version'])
    expect(encodePersistedState(state, T0)).toEqual({ version: 1, savedAt: T0, tasks: [] })
  })

  it('exposes a documented default debounce window', () => {
    expect(DEFAULT_DEBOUNCE_MS).toBeGreaterThan(0)
  })

  it('round-trips a schedule through the persisted form unchanged', async () => {
    const store = seedStore()
    const writer = new TaskPersistence({ rootDir: root, now: () => T0 })
    writer.schedule(store.snapshot())
    await writer.flush()
    const { state } = await new TaskPersistence({ rootDir: root }).load()
    const every = state.tasks.find(task => task.title === 'every')
    expect(every?.schedule).toEqual({
      enabled: true,
      nextFireAt: T0 + 15 * MINUTE,
      spec: { kind: 'every', intervalMinutes: 15, anchorMs: T0 },
    })
  })
})
