/**
 * Task execution against the harness agent registry.
 *
 * The task center owns no session machinery. Executing a task means handing a
 * user message to an agent: a `new-session` task creates one, an
 * `origin-session` or `session` task targets an existing one — live when it is
 * running, resumed when it is cold.
 *
 * Everything here reaches the harness through `ctx.get(name)` and plain
 * objects, so the package keeps no runtime dependency on harness packages.
 * Each call mirrors a shipped call site: `ctx.agents.create` with a mounted
 * preset and `agent.followup`, as the webhook plugin does, and the delivered
 * value is what `createUserMessage` produces — `{ id, role, content, source }`
 * with a fresh UUID identity.
 *
 * @module dsh-task-center/runner
 */

import { randomUUID } from 'node:crypto'
import type { Task } from './domain.js'
import type { TaskCenterHostContext, TaskCenterRunner } from './index.js'

/** Titles at or below this length are captures that need framing before delivery. */
export const ENRICH_MAX_TITLE_CHARS = 24

/** An agent that can receive a message. */
interface AgentLike {
  followup(message: unknown): void
}

/** What `agents.create` and `agents.resume` resolve to. */
interface AgentHandleLike {
  readonly agent: AgentLike
}

/** The slice of `ctx.agents` this plugin drives. */
interface AgentRegistryLike {
  get(id: string): AgentLike | undefined
  create(options: Record<string, unknown>): Promise<AgentHandleLike>
  resume(options: Record<string, unknown>): Promise<AgentHandleLike>
}

/** The slice of `ctx.agentPresets` this plugin drives. */
interface AgentPresetsLike {
  resolve(id?: string): Promise<{ readonly id: string }>
  standingKeyFor(id?: string): Promise<unknown>
  mount(agentCtx: unknown, id?: string): Promise<unknown>
}

/** The slice of `ctx.agentDefaultModel` this plugin drives. */
interface AgentDefaultModelLike {
  currentSelection(): { readonly provider: string; readonly model: string }
}

/**
 * Render the prompt a task delivers.
 *
 * A long title is already a usable instruction, so it is delivered as written.
 * A short one is a capture — the user jotted "交房租" — so it carries framing
 * that tells the agent to work out what the task involves before acting.
 * @param task - the task being executed.
 * @returns the exact text to deliver.
 */
export function enrichPrompt(task: Task): string {
  const title = task.title.trim()
  const note = task.note.trim()
  if (title.length > ENRICH_MAX_TITLE_CHARS) {
    return note.length === 0 ? title : `${title}\n\n${note}`
  }
  const lines = [
    `执行这条待办：${title}`,
    '这条待办的描述很短，请先判断它具体需要做什么，再动手完成。',
  ]
  if (note.length > 0) lines.push('', `补充说明：${note}`)
  return lines.join('\n')
}

/**
 * Build the user message a task delivers.
 *
 * This is the value `createUserMessage` returns: a fresh identity, the user
 * role, one text block, and a producer source. A plugin source must also
 * declare how its text was formed, which is `notice` for a task execution.
 * @param text - the prompt to deliver.
 * @returns a value the agent registry accepts as a user message.
 */
export function createTaskMessage(text: string): unknown {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: 'task-center',
      form: 'notice',
      summary: '定时任务执行',
    },
  }
}

/** Read the deployment's current model route, when that service is mounted. */
function currentModelSelection(
  ctx: TaskCenterHostContext,
): { provider: string; model: string } | undefined {
  const service = ctx.get('agentDefaultModel') as AgentDefaultModelLike | undefined
  if (service === undefined) return undefined
  return service.currentSelection()
}

/** The session a task targets, or `null` when it needs a new one. */
function targetSessionId(task: Task): string | null {
  if (task.runIn === 'origin-session') return task.originSessionId
  if (task.runIn === 'session') return task.targetSessionId
  return null
}

/**
 * Deliver one prompt to an existing session, resuming it when it is cold.
 *
 * A cold session is resumed rather than skipped: the user asked for the task to
 * run in that session, and resuming is the only path that reaches it.
 * @param agents - the agent registry.
 * @param sessionId - the session to deliver to.
 * @param message - the message to deliver.
 * @param ctx - host context, used for the model route.
 * @returns the session the prompt was delivered to.
 */
async function deliverToSession(
  agents: AgentRegistryLike,
  sessionId: string,
  message: unknown,
  ctx: TaskCenterHostContext,
): Promise<string> {
  const live = agents.get(sessionId)
  if (live !== undefined) {
    live.followup(message)
    return sessionId
  }
  const selection = currentModelSelection(ctx)
  const handle = await agents.resume({
    resumeSessionId: sessionId,
    ...(selection === undefined ? {} : { agentOptions: selection }),
  })
  handle.agent.followup(message)
  return sessionId
}

/**
 * Create a session and deliver one prompt to it.
 *
 * Without a mounted preset the new agent carries no tools and no persona, so it
 * could not act on the prompt; the preset is mounted inside `setup`, before the
 * first turn is delivered.
 * @param agents - the agent registry.
 * @param task - the task being executed.
 * @param message - the message to deliver.
 * @param ctx - host context, used for presets, cwd, and the model route.
 * @returns the created session id.
 */
async function deliverToNewSession(
  agents: AgentRegistryLike,
  task: Task,
  message: unknown,
  ctx: TaskCenterHostContext,
): Promise<string> {
  const presets = ctx.get('agentPresets') as AgentPresetsLike | undefined
  const preset = presets === undefined ? undefined : await presets.resolve(undefined)
  if (presets !== undefined && preset !== undefined) await presets.standingKeyFor(preset.id)
  const selection = currentModelSelection(ctx)
  const sessionId = `task-${randomUUID()}`
  const handle = await agents.create({
    sessionId,
    meta: {
      ...(task.cwd === null ? {} : { cwd: task.cwd }),
      ...(preset === undefined ? {} : { agentPreset: preset.id }),
    },
    ...(selection === undefined ? {} : { agentOptions: selection }),
    ...(presets === undefined || preset === undefined
      ? {}
      : {
          setup: async (agentCtx: unknown): Promise<void> => {
            await presets.mount(agentCtx, preset.id)
          },
        }),
  })
  handle.agent.followup(message)
  return sessionId
}

/**
 * Build the runner that executes tasks against this host's agent registry.
 * @param ctx - the host context whose services the runner drives.
 * @returns a runner that fails loud when the registry is unavailable.
 */
export function createAgentRunner(ctx: TaskCenterHostContext): TaskCenterRunner {
  return {
    async execute(task: Task, prompt: string): Promise<{ sessionId: string }> {
      const agents = ctx.get('agents') as AgentRegistryLike | undefined
      if (agents === undefined) {
        throw new Error('the agents service is not mounted, so no task can execute')
      }
      const message = createTaskMessage(prompt)
      const target = targetSessionId(task)
      if (target === null) {
        return { sessionId: await deliverToNewSession(agents, task, message, ctx) }
      }
      return { sessionId: await deliverToSession(agents, target, message, ctx) }
    },
  }
}
