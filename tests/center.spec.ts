/**
 * Behavior of the wired task center: what one execution does to a task.
 *
 * These cover the two ways an execution starts — a schedule coming due and a
 * user asking for one now — because a runner that is never dispatched and a
 * runner that is never supplied look identical from the outside: the execution
 * stays `running` for the first and reports `no_runner` for the second.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTaskCenter, type Task, type TaskCenter, type TaskCenterRunner } from '../src/index.js'

/** Durable roots this spec created, removed after each test. */
const roots: string[] = []

/** Create one task center over a fresh durable root and start it. */
async function centerWith(runner?: TaskCenterRunner): Promise<TaskCenter> {
  const root = await mkdtemp(join(tmpdir(), 'task-center-'))
  roots.push(root)
  const center = createTaskCenter({
    persistence: { rootDir: root },
    ...(runner === undefined ? {} : { runner }),
  })
  await center.start()
  return center
}

/** Wait until the task's newest execution has settled. */
async function settle(center: TaskCenter, taskId: string): Promise<Task['runs'][number]> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const run = center.store.requireTask(taskId).runs[0]
    if (run !== undefined && run.status !== 'running') return run
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('the execution never settled')
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('startNow', () => {
  it('dispatches the execution even though the task carries no schedule', async () => {
    const delivered: string[] = []
    const center = await centerWith({
      async execute(_task, prompt) {
        delivered.push(prompt)
        return { sessionId: 'session-1' }
      },
    })
    const task = center.store.createTask({ title: '交房租' })

    center.startNow(task.id)
    const run = await settle(center, task.id)

    expect(delivered).toHaveLength(1)
    expect(run.status).toBe('completed')
    expect(run.sessionId).toBe('session-1')
  })

  it('frames a short title and delivers exactly what it recorded', async () => {
    const delivered: string[] = []
    const center = await centerWith({
      async execute(_task, prompt) {
        delivered.push(prompt)
        return { sessionId: 'session-1' }
      },
    })
    const task = center.store.createTask({ title: '交房租', note: '每月 1 号' })

    center.startNow(task.id)
    const run = await settle(center, task.id)

    expect(run.enriched).toBe(true)
    expect(run.prompt).toContain('交房租')
    expect(run.prompt).toContain('每月 1 号')
    expect(delivered[0]).toBe(run.prompt)
  })

  it('delivers a long title as written', async () => {
    const delivered: string[] = []
    const center = await centerWith({
      async execute(_task, prompt) {
        delivered.push(prompt)
        return { sessionId: 'session-1' }
      },
    })
    const title = '把这一段足够长的说明原样交给执行会话不要加任何框架文字'
    const task = center.store.createTask({ title })

    center.startNow(task.id)
    const run = await settle(center, task.id)

    expect(run.enriched).toBe(false)
    expect(delivered[0]).toBe(title)
  })

  it('records the runner failure rather than leaving the execution running', async () => {
    const center = await centerWith({
      async execute() {
        throw new Error('boom')
      },
    })
    const task = center.store.createTask({ title: '交房租' })

    center.startNow(task.id)
    const run = await settle(center, task.id)

    expect(run.status).toBe('failed')
    expect(run.error).toBe('boom')
  })

  it('records no_runner when the deployment supplied no runner', async () => {
    const center = await centerWith()
    const task = center.store.createTask({ title: '交房租' })

    center.startNow(task.id)
    const run = await settle(center, task.id)

    expect(run.status).toBe('failed')
    expect(run.error).toBe('no_runner')
  })
})
