import type { Run, Task } from '../src/domain.js'
import { RunId, TaskId } from '../src/domain.js'

/** Fixed wall-clock base every fixture is measured from: 2030-01-01T00:00:00.000Z. */
export const T0 = Date.parse('2030-01-01T00:00:00.000Z')

/** Milliseconds in one minute, restated so a spec never imports the constant it tests. */
export const MINUTE = 60_000

/**
 * Build one execution record with explicit defaults.
 * @param overrides - Fields to replace.
 * @returns A complete run value.
 */
export function runFixture(overrides: Partial<Run> = {}): Run {
  return {
    id: RunId('run-1'),
    trigger: 'manual',
    status: 'running',
    startedAt: T0,
    finishedAt: null,
    sessionId: null,
    prompt: 'do the thing',
    enriched: false,
    error: null,
    ...overrides,
  }
}

/**
 * Build one task with explicit defaults.
 * @param overrides - Fields to replace.
 * @returns A complete task value.
 */
export function taskFixture(overrides: Partial<Task> = {}): Task {
  return {
    id: TaskId('task-1'),
    title: 'ship it',
    note: '',
    state: 'open',
    runIn: 'new-session',
    originSessionId: null,
    originCwd: null,
    targetSessionId: null,
    workspaceId: null,
    cwd: null,
    schedule: null,
    runs: [],
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  }
}
