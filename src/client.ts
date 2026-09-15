/**
 * Browser half of `dsh-task-center`.
 *
 * This module is the `./client` entry: the harness's browser roster scans the
 * package's `dsh.client` declaration and loads `lib/client.js`, whose bundle
 * hands this plugin's `apply` to the client Cordis runtime.
 *
 * The five surfaces live in `./ui.js`; this file only resolves the host bridge
 * and registers them.
 *
 * @module dsh-task-center/client
 */

import {
  registerTaskCenterUi,
  type TaskCenterUiApi,
  type UiSession,
  type UiSlotRegistry,
  type UiTask,
  type UiWorkspace,
} from './ui.js'

/** Stable plugin name; matches the row id in a composition. */
export const name = '@lyzi_nya/dsh-task-center'

/** Services this browser half waits for before activating. */
export const inject = ['slots'] as const

/**
 * The slice of the client Cordis context this plugin uses.
 *
 * Declared structurally so the bundle needs no import from the harness
 * packages; the client runtime satisfies it.
 */
export interface TaskCenterClientContext {
  readonly slots: UiSlotRegistry
  get(name: string): unknown
  effect?(callback: () => (() => void) | void): () => void
  interval?(callback: () => void, delayMs: number): () => void
}

/** Service key the host half is expected to publish for this browser half. */
export const HOST_BRIDGE_KEY = 'taskCenter'

/**
 * Wrap one unknown host value as the browser API.
 *
 * Every method is checked before use: a host bridge that is absent or is the
 * wrong shape yields an API that resolves to empty data rather than throwing
 * inside a React render.
 * @param host - the value read from the client service registry.
 * @returns an API safe to hand to the surfaces.
 */
export function adaptHostBridge(host: unknown): TaskCenterUiApi {
  const source = (host ?? {}) as Record<string, unknown>
  const call = (method: string, ...args: unknown[]): Promise<never> => {
    const fn = source[method]
    if (typeof fn !== 'function') {
      return Promise.reject(new Error(`task-center: host bridge has no "${method}"`))
    }
    return Promise.resolve((fn as (...a: unknown[]) => unknown).apply(host, args)) as Promise<never>
  }
  return {
    snapshot: async (): Promise<{ now: string; tasks: readonly UiTask[] }> => {
      if (typeof source['snapshot'] !== 'function') return { now: new Date().toISOString(), tasks: [] }
      return await call('snapshot') as unknown as { now: string; tasks: readonly UiTask[] }
    },
    choices: async (): Promise<{ workspaces: readonly UiWorkspace[]; sessions: readonly UiSession[] }> => {
      if (typeof source['choices'] !== 'function') return { workspaces: [], sessions: [] }
      return await call('choices') as unknown as { workspaces: readonly UiWorkspace[]; sessions: readonly UiSession[] }
    },
    create: payload => call('create', payload),
    update: (id, patch) => call('update', id, patch),
    remove: id => call('remove', id),
    runNow: id => call('runNow', id),
    pause: id => call('pause', id),
    resume: id => call('resume', id),
    acceptRun: (id, runId) => call('acceptRun', id, runId),
    complete: id => call('complete', id),
    reopen: id => call('reopen', id),
  } as TaskCenterUiApi
}

/**
 * Register the task-center surfaces on one client context.
 *
 * Activation is not blocked on the host bridge: a missing bridge is logged and
 * the surfaces still mount, showing an empty list, so a composition error is
 * visible in the UI instead of a blank page.
 * @param ctx - the client context to register on.
 * @returns nothing; every side effect belongs to the calling fiber.
 */
export function apply(ctx: TaskCenterClientContext): void {
  const host = ctx.get(HOST_BRIDGE_KEY)
  if (host === undefined || host === null) {
    console.error(`task-center: no "${HOST_BRIDGE_KEY}" service on the client plane; surfaces mount empty`)
  }
  const release = registerTaskCenterUi({
    slots: ctx.slots,
    api: adaptHostBridge(host),
    ...(ctx.interval === undefined ? {} : { interval: ctx.interval }),
  })
  if (ctx.effect !== undefined) ctx.effect(() => release)
}
