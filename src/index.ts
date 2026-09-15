/**
 * Host half of `dsh-task-center`: a durable to-do and scheduled-task engine for
 * DeepSeek Harness.
 *
 * The engine (store, schedule, persistence, scheduler) is dependency-free and
 * fully unit tested. This module wires it together and adapts it to a Cordis
 * host through a narrow structural seam, so the package needs no runtime
 * dependency on the harness packages. See README "Integration seam".
 *
 * @module dsh-task-center
 */

import { TaskPersistence, type TaskPersistenceOptions } from './persistence.js'
import { Scheduler } from './scheduler.js'
import { TaskStore, summarize, type TaskStoreOptions, type TaskSummary } from './store.js'
import { aggregateStatus, type Task, type TaskCenterState } from './domain.js'

export * from './domain.js'
export * from './schedule.js'
export * from './store.js'
export * from './scheduler.js'
export * from './persistence.js'

/** Stable plugin name and Cordis injection list. */
export const name = 'dsh-task-center'
export const inject = ['tools'] as const

/**
 * Start or continue one execution of a task.
 *
 * The host half never creates sessions itself: the deployment supplies this
 * collaborator, which is the only DSH-specific behavior the engine needs.
 */
export interface TaskCenterRunner {
  /**
   * Deliver `prompt` to the session this task executes in, creating or
   * resuming it as `task.runIn` requires.
   * @param task - the task being executed.
   * @param prompt - the exact text to deliver, already enrichment-applied.
   * @returns the durable session id the prompt was delivered to.
   */
  execute(task: Task, prompt: string): Promise<{ sessionId: string }>
}

/** Collaborators and deployment choices for one task center instance. */
export interface TaskCenterOptions {
  /** Durable-storage options; see {@link TaskPersistenceOptions}. */
  readonly persistence?: TaskPersistenceOptions
  /** Store options. */
  readonly store?: TaskStoreOptions
  /** Executes a task; omit to run the center as a store-only task list. */
  readonly runner?: TaskCenterRunner
  /** Longest delay one timer segment may cover. */
  readonly segmentMs?: number
  /** Sink for a background failure. */
  readonly onError?: (error: unknown) => void
}

/** A wired engine: the store, its durable writer, and the timer owner. */
export interface TaskCenter {
  readonly store: TaskStore
  readonly persistence: TaskPersistence
  readonly scheduler: Scheduler
  /** Load persisted state, then arm the scheduler. */
  start(): Promise<void>
  /** Flush and release everything. Safe to call more than once. */
  dispose(): Promise<void>
}

/**
 * Build one task center: store, durable persistence, and scheduler wired to a
 * single write-through path and a single execution path.
 *
 * Every store mutation queues the new state for persistence and wakes the
 * scheduler, so a caller never has to remember either.
 * @param options - collaborators and deployment choices.
 * @returns the wired engine; call {@link TaskCenter.start} to load and arm it.
 */
export function createTaskCenter(options: TaskCenterOptions = {}): TaskCenter {
  const persistence = new TaskPersistence(options.persistence ?? {})
  const store = new TaskStore(options.store ?? {})

  let disposed = false

  const run = async (task: Task): Promise<void> => {
    const runner = options.runner
    if (runner === undefined) {
      store.finishRun(task.id, latestRunId(task), { status: 'failed', error: 'no_runner' })
      return
    }
    const runId = latestRunId(task)
    try {
      const { sessionId } = await runner.execute(task, task.title)
      store.finishRun(task.id, runId, { status: 'completed', sessionId })
    } catch (error: unknown) {
      store.finishRun(task.id, runId, { status: 'failed', error: messageOf(error) })
      report(options.onError, error)
    }
  }

  const scheduler = new Scheduler({
    store,
    run,
    ...(options.segmentMs === undefined ? {} : { segmentMs: options.segmentMs }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  })

  const unsubscribe = store.subscribe((state: TaskCenterState) => {
    persistence.schedule(state)
    scheduler.wake()
  })

  return {
    store,
    persistence,
    scheduler,
    async start(): Promise<void> {
      const loaded = await persistence.load()
      store.replaceState(loaded.state)
      scheduler.start()
    },
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      unsubscribe()
      scheduler.stop()
      await persistence.dispose()
    },
  }
}

/** The run an execution callback is settling: the newest one the store holds. */
function latestRunId(task: Task): string {
  const run = task.runs[0]
  if (run === undefined) throw new Error(`task ${task.id} has no execution to settle`)
  return run.id
}

/** Contain a reporting sink so a throwing one cannot break the caller. */
function report(sink: ((error: unknown) => void) | undefined, error: unknown): void {
  if (sink === undefined) return
  try {
    sink(error)
  } catch {
    // A reporting sink that throws has nowhere left to report to.
  }
}

/** Narrow an unknown thrown value to a message. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** One model-facing tool definition, as the harness expects it. */
export interface TaskToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: { readonly schema: Record<string, unknown>; render: (args: never, value: never) => unknown }
  execute(args: unknown, exec?: unknown): Promise<unknown>
}

/**
 * The slice of the Cordis host this plugin uses.
 *
 * Declared structurally so the package compiles and publishes without a runtime
 * dependency on the harness packages; a real DSH context satisfies it.
 */
export interface TaskCenterHostContext {
  readonly tools: { register(definition: TaskToolDefinition): () => void }
  effect(callback: () => (() => void) | void): () => void
  get(name: string): unknown
}

/** Deployment configuration accepted by {@link apply}. */
export interface Config extends TaskCenterOptions {
  /** Builds a `TaskToolDefinition`; supply the harness `defineTool`. */
  readonly defineTool?: (definition: TaskToolDefinition) => TaskToolDefinition
}

/**
 * Register the task center on one Cordis host context.
 *
 * Registers the model tools and owns the engine for the calling fiber; the
 * harness runs one task center per host.
 * @param ctx - the host context to register on.
 * @param config - deployment choices, including the tool factory.
 * @returns nothing; every side effect is owned by the calling fiber.
 */
export function apply(ctx: TaskCenterHostContext, config: Config = {}): void {
  const center = createTaskCenter(config)
  ctx.effect(() => () => {
    void center.dispose()
  })
  void center.start()
  registerTaskTools(ctx, center, config)
}

/**
 * Register the five model tools. Kept separate from {@link apply} so a
 * store-only deployment can skip them.
 * @param ctx - the host context to register on.
 * @param center - the wired engine the tools operate on.
 * @param config - supplies the harness tool factory.
 */
export function registerTaskTools(ctx: TaskCenterHostContext, center: TaskCenter, config: Config = {}): void {
  const define = config.defineTool ?? ((definition: TaskToolDefinition) => definition)
  for (const definition of buildTaskTools(center)) {
    // One rejected registration must not take the host down with it: this seam
    // is structural, so a harness whose tool contract differs should lose a
    // tool and log it, not fail the whole plugin load.
    try {
      ctx.tools.register(define(definition))
    } catch (error) {
      console.error(`task-center: tool "${definition.name}" was rejected: ${messageOf(error)}`)
    }
  }
}

/** Render one tool value as a single text block, matching harness content blocks. */
function renderJson(value: unknown): unknown {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/** The task list shape a tool returns. The core owns both rules. */
function summarizeAll(center: TaskCenter): TaskSummary[] {
  return center.store.listTasks().map(summarize)
}

/**
 * The five model tools.
 *
 * `task_update` can settle one execution as completed/failed but can never set
 * `done` or `accepted`: only the user confirms completion. The enforcement is
 * in the operation, not in the schema text.
 * @param center - the engine the tools operate on.
 * @returns the definitions to register.
 */
export function buildTaskTools(center: TaskCenter): TaskToolDefinition[] {
  const store = center.store
  return [
    {
      name: 'task_list',
      description: 'List tasks (to-dos and scheduled jobs) owned by this harness, including their aggregate status and next fire time.',
      parameters: { status: { type: 'string' }, include_runs: { type: 'boolean' } },
      output: { schema: { type: 'object' }, render: (_args: never, value: never) => renderJson(value) },
      async execute(args: unknown): Promise<unknown> {
        const input = (args ?? {}) as { status?: unknown }
        const tasks = summarizeAll(center)
        const filtered = typeof input.status === 'string' ? tasks.filter(task => task.status === input.status) : tasks
        return { count: filtered.length, tasks: filtered }
      },
    },
    {
      name: 'task_create',
      description: 'Create a to-do, optionally with an execution plan that turns it into a scheduled job.',
      parameters: { title: { type: 'string', required: true }, note: { type: 'string' } },
      output: { schema: { type: 'object' }, render: (_args: never, value: never) => renderJson(value) },
      async execute(args: unknown): Promise<unknown> {
        const input = (args ?? {}) as { title?: unknown; note?: unknown }
        const task = store.createTask({
          title: typeof input.title === 'string' ? input.title : '',
          ...(typeof input.note === 'string' ? { note: input.note } : {}),
        })
        return { ok: true, task: { id: task.id, title: task.title, status: aggregateStatus(task) } }
      },
    },
    {
      name: 'task_update',
      description: 'Change a task, or settle one of its executions as completed or failed. Only the user can accept an execution or complete a task.',
      parameters: {
        id: { type: 'string', required: true },
        title: { type: 'string' },
        note: { type: 'string' },
        run_id: { type: 'string' },
        run_status: { type: 'string', enum: ['completed', 'failed'] },
      },
      output: { schema: { type: 'object' }, render: (_args: never, value: never) => renderJson(value) },
      async execute(args: unknown): Promise<unknown> {
        const input = (args ?? {}) as { id?: unknown; run_id?: unknown; run_status?: unknown; title?: unknown; note?: unknown }
        const id = String(input.id)
        // Enforcement lives here: the two user-only outcomes are unreachable
        // through this tool even if a caller bypasses the declared enum.
        if (input.run_status !== undefined && input.run_status !== 'completed' && input.run_status !== 'failed') {
          throw new Error('run_status must be completed or failed; only the user accepts an execution')
        }
        if (input.run_id !== undefined) {
          store.finishRun(id, String(input.run_id), { status: input.run_status as 'completed' | 'failed' })
        }
        if (input.title !== undefined || input.note !== undefined) {
          store.updateTask(id, {
            ...(typeof input.title === 'string' ? { title: input.title } : {}),
            ...(typeof input.note === 'string' ? { note: input.note } : {}),
          })
        }
        return { ok: true, task: { id, status: aggregateStatus(store.requireTask(id)) } }
      },
    },
    {
      name: 'task_run',
      description: 'Run a task now without changing its plan or next scheduled time. The user is asked to accept the result afterwards.',
      parameters: { id: { type: 'string', required: true } },
      output: { schema: { type: 'object' }, render: (_args: never, value: never) => renderJson(value) },
      async execute(args: unknown): Promise<unknown> {
        const input = (args ?? {}) as { id?: unknown }
        const id = String(input.id)
        const task = store.requireTask(id)
        const { run } = store.startRun(id, { trigger: 'manual', prompt: task.title })
        center.scheduler.wake()
        return { ok: true, taskId: id, runId: run.id }
      },
    },
    {
      name: 'task_delete',
      description: 'Delete a task permanently. Its execution history goes with it; sessions it created are untouched.',
      parameters: { id: { type: 'string', required: true } },
      output: { schema: { type: 'object' }, render: (_args: never, value: never) => renderJson(value) },
      async execute(args: unknown): Promise<unknown> {
        const input = (args ?? {}) as { id?: unknown }
        store.deleteTask(String(input.id))
        return { ok: true, deleted: true }
      },
    },
  ]
}
