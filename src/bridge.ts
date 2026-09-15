/**
 * Host side of the browser bridge.
 *
 * One `dispatch(method, args)` entry point serves every operation the browser
 * half performs. Exposing a single dispatcher rather than an object keeps the
 * HTTP route and the client call sites the same shape, and keeps every
 * argument on the lossless-JSON boundary.
 *
 * The view types live in `./ui.js`; only types are imported, so this module
 * carries no React dependency at runtime.
 *
 * @module dsh-task-center/bridge
 */

import { aggregateStatus, type Run, type Task } from './domain.js'
import type { TaskStore } from './store.js'
import type { UiRun, UiSession, UiTask, UiWorkspace } from './ui.js'

/** What the bridge needs from the running center. */
export interface BridgeHost {
  readonly store: TaskStore
  /** Re-arm the scheduler after a mutation that changed a plan. */
  wake(): void
  /** Start one execution now, without changing the task's plan. */
  startNow(taskId: string): { task: Task; run: Run }
  /** Workspace and session options for the browser pickers. */
  choices(): Promise<{ workspaces: UiWorkspace[]; sessions: UiSession[] }>
}

/** Read one value that may be a number or an ISO string, as an ISO string. */
function asIso(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
  if (typeof value === 'string' && value !== '') return value
  return null
}

/** Read one optional string field without trusting its declared type. */
function asText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** Map one durable execution onto the browser view. */
export function toUiRun(run: Run): UiRun {
  return {
    id: String(run.id),
    trigger: run.trigger,
    status: run.status,
    startedAt: asIso(run.startedAt) ?? new Date(0).toISOString(),
    finishedAt: asIso(run.finishedAt),
    sessionId: asText(run.sessionId),
    prompt: typeof run.prompt === 'string' ? run.prompt : '',
    enriched: run.enriched === true,
    error: asText(run.error),
  }
}

/** Map one durable task onto the browser view. */
export function toUiTask(task: Task): UiTask {
  const schedule = task.schedule
  return {
    id: String(task.id),
    title: task.title,
    note: asText(task.note),
    state: task.state,
    status: aggregateStatus(task),
    runIn: task.runIn,
    originSessionId: asText(task.originSessionId),
    targetSessionId: asText(task.targetSessionId),
    workspaceId: asText(task.workspaceId),
    nextFireAt: schedule !== null && schedule.enabled ? asIso(schedule.nextFireAt) : null,
    scheduleKind: schedule === null ? null : schedule.spec.kind,
    scheduleEnabled: schedule !== null && schedule.enabled,
    createdAt: asIso(task.createdAt) ?? new Date(0).toISOString(),
    updatedAt: asIso(task.updatedAt) ?? new Date(0).toISOString(),
    runs: task.runs.map(toUiRun),
  }
}

/** Read one required string argument, or throw a stable error. */
function requireString(args: readonly unknown[], index: number, field: string): string {
  const value = args[index]
  if (typeof value !== 'string' || value === '') throw new Error(`${field} must be a non-empty string`)
  return value
}

/** Read one optional record argument. */
function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

/**
 * Run one browser-requested operation.
 *
 * Every method name here is reachable from the page. The two user-only
 * outcomes (`accepted`, `done`) are only reachable through `acceptRun` and
 * `complete`, which no model tool can call.
 * @param host - the running center.
 * @param method - the operation name.
 * @param args - its positional arguments, already JSON-decoded.
 * @returns the lossless-JSON result.
 * @throws {Error} for an unknown method or rejected input.
 */
export async function dispatch(
  host: BridgeHost,
  method: string,
  args: readonly unknown[],
): Promise<unknown> {
  const store = host.store
  const mutate = <T>(value: T): T => {
    host.wake()
    return value
  }
  switch (method) {
    case 'snapshot':
      return {
        now: new Date().toISOString(),
        tasks: store.listTasks().map(toUiTask),
      }
    case 'choices':
      return await host.choices()
    case 'create':
      return { ok: true, task: toUiTask(mutate(store.createTask(asRecord(args[0]) as never))) }
    case 'update':
      return { ok: true, task: toUiTask(mutate(store.updateTask(requireString(args, 0, 'id'), asRecord(args[1]) as never))) }
    case 'remove':
      return { ok: true, deleted: mutate(store.deleteTask(requireString(args, 0, 'id'))) !== undefined }
    case 'runNow': {
      const started = host.startNow(requireString(args, 0, 'id'))
      return { ok: true, taskId: String(started.task.id), runId: String(started.run.id) }
    }
    case 'pause':
      return { ok: true, task: toUiTask(mutate(store.pause(requireString(args, 0, 'id')))) }
    case 'resume':
      return { ok: true, task: toUiTask(mutate(store.resume(requireString(args, 0, 'id')))) }
    case 'acceptRun':
      return {
        ok: true,
        task: toUiTask(mutate(store.acceptRun(requireString(args, 0, 'id'), requireString(args, 1, 'runId')))),
      }
    case 'complete':
      return { ok: true, task: toUiTask(mutate(store.complete(requireString(args, 0, 'id')))) }
    case 'reopen':
      return { ok: true, task: toUiTask(mutate(store.reopen(requireString(args, 0, 'id')))) }
    default:
      throw new Error(`unknown task-center method "${method}"`)
  }
}

/** Absolute pathname the browser half calls. */
export const BRIDGE_PATH = '/task-center/op'
