/**
 * Durable, atomic, versioned JSON persistence for the task center.
 *
 * File format: one JSON object in `<root>/state.json` with the exact fields
 * `{ version: 1, savedAt, tasks }`. Writes go to a temporary file in the same
 * directory and are then renamed over the target, so a reader never observes a
 * partially written file and an interrupted write leaves the previous state in
 * place.
 *
 * Root directory resolution order (first applicable wins):
 *
 * 1. `rootDir`, an explicit programmatic override. Tests and embedders use it.
 * 2. `DSH_TASK_CENTER_HOME`, when set to a non-empty value.
 * 3. `<os.homedir()>/.dsh/tasks`, when a home directory is available.
 * 4. `fallbackDir`, a caller-supplied last resort.
 * 5. Otherwise the constructor throws: there is no safe implicit location.
 *
 * Reads tolerate a missing file, an empty file, and malformed content. A
 * version this build does not implement fails loud instead of being rewritten
 * in the older format.
 *
 * This module is Node-only and is never part of the browser half.
 *
 * @module dsh-task-center/persistence
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Run, Task, TaskCenterState } from './domain.js'
import {
  EMPTY_STATE,
  RunId,
  TaskId,
  isSafeInteger,
  normalizeInstant,
  normalizeNote,
  normalizeRunIn,
  normalizeTaskState,
  normalizeTitle,
} from './domain.js'
import { decodeSchedule } from './schedule.js'

/** Durable task-center format version this build writes and reads. */
export const STATE_VERSION = 1

/** Default file name inside the root directory. */
export const STATE_FILE_NAME = 'state.json'

/** Environment variable that overrides the default root directory. */
export const ROOT_ENV_VAR = 'DSH_TASK_CENTER_HOME'

/** Default debounce window between coalesced writes, in milliseconds. */
export const DEFAULT_DEBOUNCE_MS = 500

/** The exact JSON value written to `state.json`. */
export interface PersistedTaskCenterState {
  readonly version: typeof STATE_VERSION
  /** Wall-clock instant the file was written, in epoch milliseconds. */
  readonly savedAt: number
  readonly tasks: readonly Task[]
}

/** How a load attempt resolved. */
export type LoadOutcome = 'loaded' | 'missing' | 'empty' | 'recovered'

/** Result of one durable read. */
export interface LoadResult {
  /** The value to adopt; {@link EMPTY_STATE} for every tolerated failure. */
  readonly state: TaskCenterState
  /** Which branch produced {@link LoadResult.state}. */
  readonly outcome: LoadOutcome
  /** Path of the quarantined file for a `recovered` outcome. */
  readonly backupPath: string | null
  /** Diagnostic detail for a `recovered` outcome. */
  readonly detail: string | null
}

/** Error raised when the file carries a format version this build cannot read. */
export class TaskPersistenceVersionError extends Error {
  /** Version found in the file. */
  readonly version: number

  /**
   * Construct a version failure.
   * @param version - Version found in the file.
   */
  constructor(version: number) {
    super(`task center state version ${version} is not supported by this build (expected ${STATE_VERSION})`)
    this.name = 'TaskPersistenceVersionError'
    this.version = version
  }
}

/** Collaborators a {@link TaskPersistence} needs. */
export interface TaskPersistenceOptions {
  /** Explicit root directory; highest precedence. */
  readonly rootDir?: string
  /** Last-resort root directory used when no home directory is available. */
  readonly fallbackDir?: string
  /** Environment to read {@link ROOT_ENV_VAR} from. Defaults to `process.env`. */
  readonly env?: Record<string, string | undefined>
  /** Clock used for `savedAt`, backups, and temporary names. Defaults to `Date.now`. */
  readonly now?: () => number
  /** Coalescing window in milliseconds. Defaults to {@link DEFAULT_DEBOUNCE_MS}. */
  readonly debounceMs?: number
  /** File name inside the root directory. Defaults to {@link STATE_FILE_NAME}. */
  readonly fileName?: string
  /** Sink for a background write failure, which no caller can await. */
  readonly onError?: (error: unknown) => void
}

/**
 * Resolve the durable root directory for the documented precedence order.
 * @param options - Root, fallback, and environment overrides.
 * @returns The absolute root directory path.
 * @throws Error when no location can be resolved.
 */
export function resolveTaskCenterRoot(options: TaskPersistenceOptions = {}): string {
  const explicit = options.rootDir
  if (explicit !== undefined && explicit.length > 0) return explicit
  const env = options.env ?? process.env
  const configured = env[ROOT_ENV_VAR]
  if (configured !== undefined && configured.length > 0) return configured
  const home = homedir()
  if (home.length > 0) return join(home, '.dsh', 'tasks')
  const fallback = options.fallbackDir
  if (fallback !== undefined && fallback.length > 0) return fallback
  throw new Error(
    `cannot resolve a task center root: set ${ROOT_ENV_VAR}, provide a home directory, or pass fallbackDir`,
  )
}

/** Whether a decoded value is a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Require a decoded string field. */
function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`)
  }
  return value
}

/** Require a decoded nullable string field. */
function requireNullableString(value: unknown, field: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string or null`)
  return value
}

/** Require a decoded boolean field. */
function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${field} must be a boolean`)
  return value
}

/** Require a decoded array field. */
function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`)
  return value
}

/**
 * Decode one execution record from durable JSON.
 * @param value - Untrusted decoded value.
 * @returns The validated run.
 */
export function decodeRun(value: unknown): Run {
  if (!isRecord(value)) throw new TypeError('run must be an object')
  const status = value['status']
  if (status !== 'running' && status !== 'completed' && status !== 'accepted' && status !== 'failed') {
    throw new TypeError('run.status must be running, completed, accepted, or failed')
  }
  const trigger = value['trigger']
  if (trigger !== 'manual' && trigger !== 'schedule') {
    throw new TypeError('run.trigger must be manual or schedule')
  }
  const finishedAt = value['finishedAt']
  if (finishedAt !== null && !isSafeInteger(finishedAt)) {
    throw new TypeError('run.finishedAt must be null or a safe integer')
  }
  return {
    id: RunId(requireString(value['id'], 'run.id')),
    trigger,
    status,
    startedAt: normalizeInstant(value['startedAt'], 'run.startedAt'),
    finishedAt: finishedAt === null ? null : finishedAt,
    sessionId: requireNullableString(value['sessionId'], 'run.sessionId'),
    prompt: typeof value['prompt'] === 'string' ? value['prompt'] : '',
    enriched: requireBoolean(value['enriched'], 'run.enriched'),
    error: requireNullableString(value['error'], 'run.error'),
  }
}

/**
 * Decode one task from durable JSON.
 * @param value - Untrusted decoded value.
 * @returns The validated task.
 */
export function decodeTask(value: unknown): Task {
  if (!isRecord(value)) throw new TypeError('task must be an object')
  const schedule = value['schedule']
  return {
    id: TaskId(requireString(value['id'], 'task.id')),
    title: normalizeTitle(value['title']),
    note: normalizeNote(value['note']),
    state: normalizeTaskState(value['state']),
    runIn: normalizeRunIn(value['runIn']),
    originSessionId: requireNullableString(value['originSessionId'], 'task.originSessionId'),
    originCwd: requireNullableString(value['originCwd'], 'task.originCwd'),
    targetSessionId: requireNullableString(value['targetSessionId'], 'task.targetSessionId'),
    workspaceId: requireNullableString(value['workspaceId'], 'task.workspaceId'),
    cwd: requireNullableString(value['cwd'], 'task.cwd'),
    schedule: schedule === null || schedule === undefined ? null : decodeSchedule(schedule),
    runs: requireArray(value['runs'], 'task.runs').map(decodeRun),
    createdAt: normalizeInstant(value['createdAt'], 'task.createdAt'),
    updatedAt: normalizeInstant(value['updatedAt'], 'task.updatedAt'),
  }
}

/**
 * Decode one complete persisted value.
 *
 * A `version` field that is a number other than {@link STATE_VERSION} fails
 * loud; anything else that cannot be decoded is the caller's cue to quarantine
 * the file and start empty.
 * @param value - Untrusted decoded value.
 * @returns The validated state.
 * @throws TaskPersistenceVersionError when the format version is not supported.
 */
export function decodePersistedState(value: unknown): TaskCenterState {
  if (!isRecord(value)) throw new TypeError('state.json must contain a JSON object')
  const version = value['version']
  if (typeof version === 'number') {
    if (version !== STATE_VERSION) throw new TaskPersistenceVersionError(version)
  } else {
    throw new TypeError('state.json is missing a numeric version field')
  }
  const tasks = requireArray(value['tasks'], 'tasks').map(decodeTask)
  return { tasks }
}

/**
 * Encode one value in the durable format.
 * @param state - Value to encode.
 * @param nowMs - Instant to record as `savedAt`.
 * @returns The exact JSON value written to disk.
 */
export function encodePersistedState(state: TaskCenterState, nowMs: number): PersistedTaskCenterState {
  return { version: STATE_VERSION, savedAt: nowMs, tasks: [...state.tasks] }
}

/** Debounced, atomic JSON store for one root directory. */
export class TaskPersistence {
  /** Resolved absolute root directory. */
  readonly rootDir: string
  /** Resolved absolute path of the state file. */
  readonly filePath: string

  private readonly now: () => number
  private readonly debounceMs: number
  private readonly onError: (error: unknown) => void
  private readonly fileName: string
  private pending: TaskCenterState | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private tail: Promise<void> = Promise.resolve()
  private writes = 0

  /**
   * Construct a persistence owner; no directory is created until the first write.
   * @param options - Root resolution, clock, and coalescing options.
   */
  constructor(options: TaskPersistenceOptions = {}) {
    this.rootDir = resolveTaskCenterRoot(options)
    this.fileName = options.fileName ?? STATE_FILE_NAME
    this.filePath = join(this.rootDir, this.fileName)
    this.now = options.now ?? (() => Date.now())
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this.onError = options.onError ?? (() => {})
  }

  /**
   * Read the durable value, tolerating every recoverable defect.
   * @returns The value to adopt plus how the load resolved.
   * @throws TaskPersistenceVersionError when the file version is not supported.
   */
  async load(): Promise<LoadResult> {
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { state: EMPTY_STATE, outcome: 'missing', backupPath: null, detail: null }
      }
      return this.recover(`the state file could not be read: ${describe(error)}`)
    }
    if (raw.trim().length === 0) {
      return { state: EMPTY_STATE, outcome: 'empty', backupPath: null, detail: null }
    }
    let decoded: unknown
    try {
      decoded = JSON.parse(raw)
    } catch (error: unknown) {
      return this.recover(`the state file is not valid JSON: ${describe(error)}`)
    }
    try {
      return { state: decodePersistedState(decoded), outcome: 'loaded', backupPath: null, detail: null }
    } catch (error: unknown) {
      if (error instanceof TaskPersistenceVersionError) throw error
      return this.recover(`the state file does not match the version ${STATE_VERSION} format: ${describe(error)}`)
    }
  }

  /**
   * Queue a value for the next coalesced write.
   * @param state - Value to persist.
   */
  schedule(state: TaskCenterState): void {
    this.pending = state
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.drain()
    }, this.debounceMs)
    this.timer.unref?.()
  }

  /**
   * Write every queued value and wait for all outstanding writes.
   * @throws The first write failure, which `schedule` can only report through `onError`.
   */
  async flush(): Promise<void> {
    this.clearTimer()
    const pending = this.pending
    this.pending = null
    if (pending !== null) await this.enqueue(pending)
    await this.tail
  }

  /**
   * Flush on shutdown. Identical to {@link TaskPersistence.flush} but named for
   * the lifecycle call site.
   */
  async dispose(): Promise<void> {
    await this.flush()
  }

  /** Write the queued value, reporting a failure through `onError`. */
  private async drain(): Promise<void> {
    const state = this.pending
    this.pending = null
    if (state === null) return
    try {
      await this.enqueue(state)
    } catch (error: unknown) {
      this.onError(error)
    }
  }

  /** Append one write to the serialized write chain. */
  private enqueue(state: TaskCenterState): Promise<void> {
    const next = this.tail.then(
      () => this.write(state),
      () => this.write(state),
    )
    this.tail = next.then(() => undefined, () => undefined)
    return next
  }

  /** Perform one atomic write. */
  private async write(state: TaskCenterState): Promise<void> {
    await mkdir(this.rootDir, { recursive: true })
    const payload = encodePersistedState(state, this.now())
    this.writes += 1
    const temporary = join(this.rootDir, `${this.fileName}.${process.pid}.${this.writes}.tmp`)
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    try {
      await rename(temporary, this.filePath)
    } catch (error: unknown) {
      await rm(temporary, { force: true })
      throw error
    }
  }

  /** Quarantine an undecodable file and report an empty state. */
  private async recover(detail: string): Promise<LoadResult> {
    this.writes += 1
    const backupPath = `${this.filePath}.corrupt-${this.now()}-${this.writes}`
    try {
      await rename(this.filePath, backupPath)
    } catch (error: unknown) {
      return { state: EMPTY_STATE, outcome: 'recovered', backupPath: null, detail: `${detail}; backup failed: ${describe(error)}` }
    }
    return { state: EMPTY_STATE, outcome: 'recovered', backupPath, detail }
  }

  /** Cancel the armed debounce timer. */
  private clearTimer(): void {
    if (this.timer === null) return
    clearTimeout(this.timer)
    this.timer = null
  }
}

/** Render an unknown thrown value for a diagnostic. */
function describe(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
