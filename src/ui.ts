/**
 * Browser half of `dsh-task-center`: the task dock, the session panel, the task
 * center page, and the detail/edit drawer.
 *
 * Ported from the working dynamic plugin. It talks to the host through
 * {@link TaskCenterUiApi} and registers itself through a structural
 * {@link UiSlotRegistry}, so the module needs no import from the harness
 * packages and stays typecheckable outside a DSH install.
 *
 * @module dsh-task-center/ui
 */

import { Fragment, createElement, useEffect, useState, type ReactNode } from 'react'
import type { AggregateStatus, RunStatus, ScheduleKind, TaskState } from './domain.js'

/** One execution as the browser renders it. */
export interface UiRun {
  readonly id: string
  readonly trigger: 'manual' | 'schedule'
  readonly status: RunStatus
  readonly startedAt: string
  readonly finishedAt: string | null
  readonly sessionId: string | null
  readonly prompt: string
  readonly enriched: boolean
  readonly error: string | null
}

/** One task as the browser renders it. Deliberately flat JSON. */
export interface UiTask {
  readonly id: string
  readonly title: string
  readonly note: string | null
  readonly state: TaskState
  readonly status: AggregateStatus
  readonly runIn: 'new-session' | 'origin-session' | 'session'
  readonly originSessionId: string | null
  readonly targetSessionId: string | null
  readonly workspaceId: string | null
  readonly nextFireAt: string | null
  readonly scheduleKind: ScheduleKind | null
  readonly scheduleEnabled: boolean
  readonly createdAt: string
  readonly updatedAt: string
  readonly runs: readonly UiRun[]
}

/** A workspace a task can be filed under. */
export interface UiWorkspace { readonly id: string; readonly title: string; readonly path: string }

/** A session a task can be pointed at. */
export interface UiSession { readonly id: string; readonly title: string | null; readonly live: boolean }

/** Everything the browser half reads and writes. */
export interface TaskCenterUiApi {
  snapshot(): Promise<{ now: string; tasks: readonly UiTask[] }>
  choices(): Promise<{ workspaces: readonly UiWorkspace[]; sessions: readonly UiSession[] }>
  create(payload: Record<string, unknown>): Promise<unknown>
  update(id: string, patch: Record<string, unknown>): Promise<unknown>
  remove(id: string): Promise<unknown>
  runNow(id: string): Promise<unknown>
  pause(id: string): Promise<unknown>
  resume(id: string): Promise<unknown>
  acceptRun(id: string, runId: string): Promise<unknown>
  complete(id: string): Promise<unknown>
  reopen(id: string): Promise<unknown>
}

/** The slice of the client slot system this module registers into. */
export interface UiSlotRegistry {
  inject(key: string, callback: () => () => void): () => void
  register(options: Record<string, unknown>, component: (props: never) => ReactNode): () => void
}

/** Everything the browser half needs from its deployment. */
export interface TaskCenterUiOptions {
  readonly slots: UiSlotRegistry
  readonly api: TaskCenterUiApi
  /** Poll interval in milliseconds. Defaults to 3000. */
  readonly pollMs?: number
  /** Registers an interval that is disposed with the caller's fiber. */
  readonly interval?: (callback: () => void, delayMs: number) => () => void
  /** Injects one stylesheet. */
  readonly insertStyles?: (css: string) => void
  /**
   * Selects the task center main panel. The client half resolves it from the
   * layout service at click time, so this plugin never waits for a service the
   * deployment may not mount.
   */
  readonly openTasks?: () => void
}

const STATUS_LABEL: Record<AggregateStatus, string> = {
  pending: '待处理',
  scheduled: '等待定时执行',
  paused: '已暂停',
  running: 'AI 执行中',
  awaiting_acceptance: '待用户验收',
  failed: '执行失败',
  done: '用户确认完成',
}

const RUN_LABEL: Record<RunStatus, string> = {
  running: '执行中',
  completed: '待验收',
  accepted: '已验收',
  failed: '执行失败',
}

const ERROR_LABEL: Record<string, string> = {
  cancelled_by_user: '已被用户取消',
  session_disposed: '目标会话已关闭',
}

const SCHEDULE_LABEL: Record<ScheduleKind, string> = {
  after: '几分钟后',
  at: '指定时间',
  daily: '每天',
  weekly: '每周',
  every: '每隔一段时间',
}

/** Drawer state: at most one of the three surfaces is open. */
export type Drawer =
  | { readonly mode: 'create'; readonly sessionId?: string | undefined }
  | { readonly mode: 'list'; readonly scope: 'session' | 'all'; readonly sessionId?: string | undefined }
  | {
    readonly mode: 'detail'
    readonly taskId: string
    readonly back: { readonly scope: 'session' | 'all'; readonly sessionId?: string | undefined } | null
  }

/** Pad a number to two digits. */
function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/** Format one ISO instant as a short local stamp, or `-`. */
export function formatStamp(iso: string | null): string {
  if (iso === null || iso === '') return '-'
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return '-'
  const date = new Date(ms)
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Format one ISO instant relative to now. */
export function formatRelative(iso: string | null, nowMs: number): string {
  if (iso === null || iso === '') return ''
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const diff = ms - nowMs
  const minutes = Math.round(Math.abs(diff) / 60_000)
  const unit = minutes < 60
    ? `${minutes} 分钟`
    : minutes < 1440 ? `${Math.round(minutes / 60)} 小时` : `${Math.round(minutes / 1440)} 天`
  return diff >= 0 ? `还有 ${unit}` : `已过期 ${unit}`
}

/** Human text for a stored failure code. */
export function errorText(code: string | null): string | null {
  if (code === null) return null
  return ERROR_LABEL[code] ?? code.replace(/^turn_/, '结束于 ')
}

/** Status weight used for ordering open work first. */
const STATUS_WEIGHT: Record<AggregateStatus, number> = {
  running: 0,
  awaiting_acceptance: 1,
  failed: 2,
  scheduled: 3,
  pending: 4,
  paused: 5,
  done: 6,
}

/** Order tasks the way every surface shows them. */
export function sortTasks(tasks: readonly UiTask[]): UiTask[] {
  return [...tasks].sort((left, right) => {
    const delta = STATUS_WEIGHT[left.status] - STATUS_WEIGHT[right.status]
    if (delta !== 0) return delta
    return Date.parse(right.createdAt) - Date.parse(left.createdAt)
  })
}

const CSS = [
  '.dt-dock{display:flex;flex-direction:column;gap:6px;flex:none;overflow:hidden;margin:0 auto;box-sizing:border-box;width:calc(100% - 2*var(--dsh-composer-side-clearance,16px) - 4*var(--dsh-composer-dock-inset,8px));max-width:calc(var(--dsh-composer-card-max-width,100%) - 4*var(--dsh-composer-dock-inset,8px));border-radius:12px;}',
  '.dt-head{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary);padding:0 4px;flex:none;}',
  '.dt-head strong{font-weight:600;color:var(--dsw-alias-label-primary);}',
  '.dt-spacer{flex:1;}',
  '.dt-muted{font-size:11px;color:var(--dsw-alias-label-secondary);}',
  '.dt-card{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-1);}',
  '.dt-list{overflow-y:auto;overscroll-behavior:contain;}',
  '.dt-page-list{flex:1 1 auto;min-height:0;overflow-y:auto;}',
  '.dt-drawer-list{flex:1 1 auto;min-height:0;overflow-y:auto;border:none;border-radius:0;}',
  '.dt-drawer-toolbar{flex:none;display:flex;align-items:center;gap:6px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);}',
  '.dt-row{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);}',
  '.dt-row:last-child{border-bottom:none;}',
  '.dt-row-main{display:flex;align-items:center;gap:8px;min-width:0;}',
  '.dt-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;text-align:left;color:var(--dsw-alias-label-primary);background:none;border:none;padding:0;cursor:pointer;font-family:inherit;}',
  '.dt-title:hover{color:var(--dsw-alias-brand-primary);text-decoration:underline;}',
  '.dt-next{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;}',
  '.dt-chip{flex:none;font-size:11px;line-height:16px;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap;}',
  '.dt-chip-running{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}',
  '.dt-chip-awaiting_acceptance{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);}',
  '.dt-chip-failed{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);}',
  '.dt-chip-done{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);}',
  '.dt-chip-scheduled{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}',
  '.dt-actions{display:flex;flex-wrap:wrap;gap:6px;}',
  '.dt-btn{font-size:12px;line-height:18px;padding:2px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit;}',
  '.dt-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}',
  '.dt-btn:disabled{opacity:.45;cursor:default;}',
  '.dt-btn-primary{color:var(--dsw-alias-label-primary);}',
  '.dt-btn-danger:hover{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);}',
  '.dt-empty{font-size:12px;color:var(--dsw-alias-label-secondary);padding:8px 10px;}',
  '.dt-runs{display:flex;flex-wrap:wrap;gap:6px;}',
  '.dt-run{font-size:11px;color:var(--dsw-alias-label-secondary);border:1px dashed var(--dsw-alias-border-l1);border-radius:999px;padding:0 6px;}',
  '.dt-err{font-size:11px;color:var(--dsw-alias-state-error-primary);}',
  '.dt-flow{display:flex;flex-direction:column;gap:8px;}',
  '.dt-field{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--dsw-alias-label-secondary);}',
  '.dt-input,.dt-select,.dt-area{font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:4px 6px;width:100%;box-sizing:border-box;}',
  '.dt-area{min-height:70px;resize:vertical;}',
  '.dt-inline{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;}',
  '.dt-inline .dt-field{flex:1;min-width:110px;}',
  '.dt-steps{display:flex;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary);}',
  '.dt-step-on{color:var(--dsw-alias-brand-primary);}',
  '.dt-foot{display:flex;gap:8px;align-items:center;}',
  '.dt-note{font-size:11px;color:var(--dsw-alias-state-error-primary);}',
  '.dt-modal{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;pointer-events:auto;}',
  '.dt-page{display:flex;flex:1 1 auto;flex-direction:column;gap:10px;padding:16px;box-sizing:border-box;height:100%;min-height:0;overflow:hidden;}',
  '.dt-page-head{display:flex;align-items:center;gap:10px;flex:none;}',
  '.dt-page-head h2{font-size:15px;margin:0;color:var(--dsw-alias-label-primary);}',
  '.dt-filters{display:flex;gap:6px;flex-wrap:wrap;flex:none;}',
  '.dt-icon-btn{display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:3px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;}',
  '.dt-icon-btn:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}',
  '.dt-badge{font-size:10px;line-height:14px;min-width:14px;text-align:center;border-radius:999px;padding:0 4px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);}',
  '.dt-backdrop{position:fixed;inset:0;pointer-events:auto;background:rgba(0,0,0,.32);}',
  '.dt-drawer{position:relative;pointer-events:auto;display:flex;flex-direction:column;width:min(560px,100%);max-height:min(80vh,760px);overflow:hidden;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:0 18px 48px rgba(0,0,0,.28);}',
  '.dt-drawer-head{flex:none;display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);}',
  '.dt-drawer-head h2{font-size:14px;margin:0;color:var(--dsw-alias-label-primary);}',
  '.dt-drawer-body{flex:1 1 auto;min-height:0;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:14px;}',
  '.dt-drawer-foot{flex:none;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l1);display:flex;gap:8px;flex-wrap:wrap;align-items:center;}',
  '.dt-sect{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px;background:var(--dsw-alias-bg-layer-2);}',
  '.dt-sect-title{font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);}',
  '.dt-kv{display:flex;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary);}',
  '.dt-kv b{font-weight:500;color:var(--dsw-alias-label-primary);min-width:0;overflow-wrap:anywhere;}',
  '.dt-runrow{display:flex;flex-direction:column;gap:3px;padding:6px 0;border-bottom:1px dashed var(--dsw-alias-border-l1);font-size:12px;}',
  '.dt-prompt{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere;}',
].join('')

/** Shared store every surface subscribes to. One poller for the whole page. */
interface TaskStore {
  snapshot(): { tasks: readonly UiTask[]; error: string | null }
  subscribe(listener: () => void): () => void
  refresh(): Promise<void>
  drawer(): Drawer | null
  setDrawer(next: Drawer | null): void
  choices(): { workspaces: readonly UiWorkspace[]; sessions: readonly UiSession[] } | null
  loadChoices(): Promise<void>
}

/** Build the shared store over one API. */
function createStore(api: TaskCenterUiApi): TaskStore {
  let state: { tasks: readonly UiTask[]; error: string | null; drawer: Drawer | null } =
    { tasks: [], error: null, drawer: null }
  let choices: { workspaces: readonly UiWorkspace[]; sessions: readonly UiSession[] } | null = null
  const listeners = new Set<() => void>()
  const emit = (): void => { for (const listener of listeners) listener() }
  return {
    snapshot: () => ({ tasks: state.tasks, error: state.error }),
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async refresh() {
      try {
        const data = await api.snapshot()
        state = { ...state, tasks: data.tasks, error: null }
      } catch (error: unknown) {
        state = { ...state, error: error instanceof Error ? error.message : String(error) }
      }
      emit()
    },
    drawer: () => state.drawer,
    setDrawer(next) {
      state = { ...state, drawer: next }
      emit()
    },
    choices: () => choices,
    async loadChoices() {
      if (choices !== null) return
      try {
        choices = await api.choices()
      } catch {
        choices = { workspaces: [], sessions: [] }
      }
      emit()
    },
  }
}

/** Subscribe a component to the store. */
function useStore(store: TaskStore): { tasks: readonly UiTask[]; error: string | null } {
  const [value, setValue] = useState(() => store.snapshot())
  useEffect(() => store.subscribe(() => setValue(store.snapshot())), [store])
  return value
}

/** Subscribe a component to the drawer state. */
function useDrawer(store: TaskStore): Drawer | null {
  const [value, setValue] = useState<Drawer | null>(() => store.drawer())
  useEffect(() => store.subscribe(() => setValue(store.drawer())), [store])
  return value
}

/** One status chip. */
function StatusChip(props: { status: AggregateStatus }): ReactNode {
  return createElement('span', { className: `dt-chip dt-chip-${props.status}` }, STATUS_LABEL[props.status])
}

/** Props every row needs. */
interface RowProps {
  readonly task: UiTask
  readonly nowMs: number
  readonly store: TaskStore
  readonly api: TaskCenterUiApi
  readonly openTask: (id: string) => void
}

/** One task row. */
function TaskRow(props: RowProps): ReactNode {
  const task = props.task
  const awaiting = task.runs.filter(run => run.status === 'completed')
  const failed = task.runs.find(run => run.status === 'failed')
  const act = (work: Promise<unknown>): void => { void work.then(() => props.store.refresh()) }
  return createElement('div', { className: 'dt-row' },
    createElement('div', { className: 'dt-row-main' },
      createElement(StatusChip, { status: task.status }),
      createElement('button', {
        className: 'dt-title',
        title: '点击查看完整信息并编辑',
        onClick: () => props.openTask(task.id),
      }, task.title),
      task.nextFireAt === null
        ? null
        : createElement('span', { className: 'dt-next' },
          `下次 ${formatStamp(task.nextFireAt)} · ${formatRelative(task.nextFireAt, props.nowMs)}`),
    ),
    task.runs.length === 0 ? null : createElement('div', { className: 'dt-runs' },
      task.runs.slice(0, 3).map(run => createElement('span', { key: run.id, className: `dt-run dt-run-${run.status}` },
        `${RUN_LABEL[run.status]} · ${formatStamp(run.startedAt)}`))),
    failed === undefined ? null : createElement('div', { className: 'dt-err' },
      `上次失败：${errorText(failed.error) ?? '未知原因'}`),
    createElement('div', { className: 'dt-actions' },
      createElement('button', {
        className: 'dt-btn',
        disabled: task.status === 'running',
        onClick: () => act(props.api.runNow(task.id)),
      }, '立即执行'),
      awaiting.length === 0 ? null : createElement('button', {
        className: 'dt-btn',
        onClick: () => act(props.api.acceptRun(task.id, awaiting[0]!.id)),
      }, '验收'),
      task.status === 'done'
        ? createElement('button', { className: 'dt-btn', onClick: () => act(props.api.reopen(task.id)) }, '重新打开')
        : createElement('button', { className: 'dt-btn dt-btn-primary', onClick: () => act(props.api.complete(task.id)) }, '完成'),
      task.scheduleKind === null ? null : createElement('button', {
        className: 'dt-btn',
        onClick: () => act(task.state === 'paused' ? props.api.resume(task.id) : props.api.pause(task.id)),
      }, task.state === 'paused' ? '恢复' : '暂停'),
    ),
  )
}

/** A capped, self-scrolling list of rows. */
function TaskList(props: {
  className: string
  style?: Record<string, string>
  tasks: readonly UiTask[]
  empty: string
  store: TaskStore
  api: TaskCenterUiApi
  openTask: (id: string) => void
}): ReactNode {
  const nowMs = Date.now()
  return createElement('div', { className: `${props.className} dt-list`, style: props.style },
    props.tasks.length === 0
      ? createElement('div', { className: 'dt-empty' }, props.empty)
      : props.tasks.map(task => createElement(TaskRow, {
        key: task.id,
        task,
        nowMs,
        store: props.store,
        api: props.api,
        openTask: props.openTask,
      })))
}

/** Props the four registered surfaces share. */
interface SurfaceProps {
  readonly store: TaskStore
  readonly api: TaskCenterUiApi
  readonly sessionId?: string | undefined
}

/** One selector hook the runtime binds from the standard session share. */
interface SlotSelectorHook { (select: (snapshot: never) => unknown): unknown }

/** Selector hooks a session-scoped surface reads its standard snapshots through. */
interface SurfaceStandardProps {
  readonly useSession?: SlotSelectorHook | undefined
  readonly useConversation?: SlotSelectorHook | undefined
  readonly useSessions?: SlotSelectorHook | undefined
}

/** Session lifecycle facts the dock reads off `useSession`. */
interface DockSessionFacts {
  readonly blank?: boolean | undefined
  readonly awaitingFirstTurn?: boolean | undefined
  readonly running?: boolean | undefined
  readonly promptAttempted?: boolean | undefined
  readonly openState?: string | undefined
}

/** Conversation facts the dock reads off `useConversation`. */
interface DockConversationFacts { readonly activeTargets?: { readonly size: number } | undefined }

/** Session roster summary the dock reads the current Session's blank flag from. */
interface DockSessionsFacts {
  readonly byId?: Record<string, { readonly blank?: boolean | undefined } | undefined> | undefined
}

/** Props of the home-page dock. */
type HomeDockProps = SurfaceProps & SurfaceStandardProps

/**
 * Read one value from a selector hook the slot supplies.
 *
 * A deployment that does not supply the hook, or a selector that throws, yields
 * `undefined` instead of breaking the render tree.
 * @param hook - the runtime selector hook, when the slot supplied one.
 * @param select - projection over the hook's snapshot.
 * @returns the projected value, or `undefined` when it cannot be read.
 */
function readSlotSelector<T>(hook: SlotSelectorHook | undefined, select: (snapshot: never) => T): T | undefined {
  if (typeof hook !== 'function') return undefined
  try {
    return hook(select) as T
  } catch {
    // A selector running against an unexpected snapshot must not blank the dock.
    return undefined
  }
}

/**
 * The home-page dock. It renders its rows only on the hero (home / new-session)
 * page and nothing at all inside an established conversation: the host's dock
 * seat imposes no geometry, so an entry that renders there misaligns against
 * the composer card.
 */
function HomeDock(props: HomeDockProps): ReactNode | null {
  const state = useStore(props.store)
  const [open, setOpen] = useState(false)
  const session = readSlotSelector(props.useSession, snapshot => snapshot as DockSessionFacts)
  const conversation = readSlotSelector(props.useConversation, snapshot => snapshot as DockConversationFacts)
  const sessions = readSlotSelector(props.useSessions, snapshot => snapshot as DockSessionsFacts)
  const summaryBlank = props.sessionId === undefined ? undefined : sessions?.byId?.[props.sessionId]?.blank
  const active = conversation !== undefined && session !== undefined
    && ((conversation.activeTargets?.size ?? 0) > 0
      || (!session.blank && !session.awaitingFirstTurn)
      || session.running === true)
  const shellPhase = session === undefined || conversation === undefined
    ? 'blank'
    : active ? 'active' : (session.promptAttempted === true ? 'engaging' : 'blank')
  const hero = shellPhase === 'blank' && (session?.openState === 'open' || summaryBlank === true)
  if (!hero) return null
  const tasks = sortTasks(state.tasks)
  const openTask = (id: string): void => { props.store.setDrawer({ mode: 'detail', taskId: id, back: null }) }
  return createElement('div', { className: 'dt-dock' },
    createElement('div', { className: 'dt-head' },
      createElement('strong', null, '待办'),
      createElement('span', null,
        `共 ${tasks.length} 条 · ${tasks.filter(task => task.status !== 'done').length} 项未完成`),
      createElement('span', { className: 'dt-spacer' }),
      createElement('button', {
        className: 'dt-btn',
        onClick: () => { props.store.setDrawer({ mode: 'create', sessionId: props.sessionId }) },
      }, '＋ 新建'),
      createElement('button', {
        className: 'dt-btn',
        onClick: () => { props.store.setDrawer({ mode: 'list', scope: 'all', sessionId: props.sessionId }) },
      }, '在侧栏展开'),
      tasks.length <= 4 ? null : createElement('button', {
        className: 'dt-btn',
        onClick: () => setOpen(!open),
      }, open ? '收起' : '展开（可滚动）'),
    ),
    createElement(TaskList, {
      className: 'dt-card',
      style: { maxHeight: open ? '46vh' : '184px' },
      tasks,
      empty: '暂无待办，点「＋ 新建」创建。',
      store: props.store,
      api: props.api,
      openTask,
    }))
}

/** Props of the session header button; `openTasks` arrives through the register inject factory. */
type SessionTasksButtonProps = SurfaceProps & { readonly openTasks?: (() => void) | undefined }

/**
 * The session header button: one inline control that selects the task center
 * main panel. The host's utilities row is a bare `flex: none` strip, so an
 * oversized child would grow the header; the layout service is reached through
 * the injected `openTasks` callback rather than from this component.
 */
function SessionTasksButton(props: SessionTasksButtonProps): ReactNode {
  const state = useStore(props.store)
  const sessionId = props.sessionId
  const open = state.tasks.filter(task => task.status !== 'done'
    && (sessionId === undefined || task.originSessionId === sessionId || task.targetSessionId === sessionId))
  const openTasks = props.openTasks
  return createElement('button', {
    type: 'button',
    className: 'dt-icon-btn',
    title: '任务中心',
    'aria-label': '任务中心',
    onClick: () => { if (typeof openTasks === 'function') openTasks() },
  },
  createElement('span', null, '任务'),
  open.length === 0 ? null : createElement('span', { className: 'dt-badge' }, String(open.length)))
}

/** The task center page. */
function TaskCenter(props: SurfaceProps): ReactNode {
  const state = useStore(props.store)
  const [filter, setFilter] = useState<'all' | AggregateStatus>('all')
  const tasks = sortTasks(filter === 'all' ? state.tasks : state.tasks.filter(task => task.status === filter))
  const filters: Array<'all' | AggregateStatus> = ['all', 'pending', 'scheduled', 'paused', 'running', 'awaiting_acceptance', 'failed', 'done']
  return createElement('div', { className: 'dt-page' },
    createElement('div', { className: 'dt-page-head' },
      createElement('h2', null, '任务中心'),
      createElement('span', null, `共 ${state.tasks.length} 条`),
      createElement('span', { className: 'dt-spacer' }),
      createElement('button', {
        className: 'dt-btn dt-btn-primary',
        onClick: () => { props.store.setDrawer({ mode: 'create' }) },
      }, '＋ 新建任务')),
    createElement('div', { className: 'dt-filters' }, filters.map(key => createElement('button', {
      key,
      className: `dt-btn${filter === key ? ' dt-btn-primary' : ''}`,
      onClick: () => setFilter(key),
    }, key === 'all' ? '全部' : STATUS_LABEL[key]))),
    state.error === null ? null : createElement('div', { className: 'dt-note' }, state.error),
    createElement(TaskList, {
      className: 'dt-card dt-page-list',
      tasks,
      empty: '没有符合条件的任务。',
      store: props.store,
      api: props.api,
      openTask: (id: string) => { props.store.setDrawer({ mode: 'detail', taskId: id, back: null }) },
    }))
}

/**
 * The sidebar panel icon.
 *
 * The sidebar draws the row itself from this registration's metadata and
 * mounts the component only inside a 16/18px `aria-hidden` span, so it stays a
 * bare inline SVG glyph sized and tinted from its owner props: text, cards, or
 * block layout here would break the rail.
 */
function PanelIcon(props: { readonly size?: number | undefined; readonly active?: boolean | undefined }): ReactNode {
  const size = typeof props.size === 'number' && props.size > 0 ? props.size : 16
  return createElement('svg', {
    viewBox: '0 0 16 16',
    width: size,
    height: size,
    'aria-hidden': true,
    style: {
      display: 'block',
      color: props.active === true ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
    },
  },
  createElement('path', {
    fill: 'currentColor',
    d: 'M2.5 2.5h11a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Zm.5 2v1h2v-1H3Zm3.5 0v1H13v-1H6.5Zm-3.5 3v1h2v-1H3Zm3.5 0v1H13v-1H6.5Zm-3.5 3v1h2v-1H3Zm3.5 0v1H13v-1H6.5Z',
  }))
}

/** Section wrapper for the drawer. */
function Section(props: { title: string; children?: ReactNode }): ReactNode {
  return createElement('div', { className: 'dt-sect' },
    createElement('div', { className: 'dt-sect-title' }, props.title),
    props.children)
}

/** Detail + edit for one task. Remounted per task id. */
function TaskDetail(props: { task: UiTask; store: TaskStore; api: TaskCenterUiApi }): ReactNode {
  const task = props.task
  const [title, setTitle] = useState(task.title)
  const [note, setNote] = useState(task.note ?? '')
  const [error, setError] = useState<string | null>(null)
  const save = (): void => {
    setError(null)
    void props.api.update(task.id, { title, note: note === '' ? null : note })
      .then(() => props.store.refresh())
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
  }
  const rows: Array<[string, string | null]> = [
    ['总状态', STATUS_LABEL[task.status]],
    ['任务状态', task.state],
    ['下次执行', task.nextFireAt],
    ['创建时间', formatStamp(task.createdAt)],
    ['更新时间', formatStamp(task.updatedAt)],
    ['任务 ID', task.id],
    ['创建会话', task.originSessionId],
    ['绑定会话', task.targetSessionId],
  ]
  return createElement('div', { className: 'dt-drawer-body' },
    createElement(Section, { title: '内容' },
      createElement('div', { className: 'dt-field' }, '标题',
        createElement('input', { className: 'dt-input', value: title, onChange: (e: { target: { value: string } }) => setTitle(e.target.value) })),
      createElement('div', { className: 'dt-field' }, '补充说明',
        createElement('textarea', { className: 'dt-area', value: note, onChange: (e: { target: { value: string } }) => setNote(e.target.value) })),
      createElement('div', { className: 'dt-foot' },
        createElement('button', { className: 'dt-btn dt-btn-primary', disabled: title.trim() === '', onClick: save }, '保存内容'))),
    createElement(Section, { title: task.scheduleKind === null ? '执行计划（无）' : `执行计划（${SCHEDULE_LABEL[task.scheduleKind]}）` },
      createElement('div', { className: 'dt-kv' },
        createElement('span', null, '启用'),
        createElement('b', null, task.scheduleEnabled ? '是' : '否'))),
    createElement(Section, { title: '状态' },
      ...rows.map(([label, value]) => createElement('div', { key: label, className: 'dt-kv' },
        createElement('span', null, label),
        createElement('b', null, value === null || value === '' ? '-' : value)))),
    createElement(Section, { title: `执行历史（${task.runs.length}）` },
      task.runs.length === 0
        ? createElement('div', { className: 'dt-empty' }, '尚未执行过。')
        : task.runs.map(run => createElement('div', { key: run.id, className: 'dt-runrow' },
          createElement('div', null,
            `${RUN_LABEL[run.status]} · ${run.trigger === 'manual' ? '手动' : '定时'} · ${formatStamp(run.startedAt)}`),
          createElement('div', { className: 'dt-prompt' },
            `发给 Agent 的内容：${run.prompt}${run.enriched ? '（已自动补全）' : ''}`),
          run.sessionId === null ? null : createElement('div', { className: 'dt-prompt' }, `会话：${run.sessionId}`),
          run.error === null ? null : createElement('div', { className: 'dt-err' }, `失败：${errorText(run.error) ?? run.error}`)))),
    error === null ? null : createElement('div', { className: 'dt-note' }, error))
}

/** The right-hand drawer: list, detail, or the create flow. */
function TaskDrawer(props: SurfaceProps): ReactNode | null {
  const drawer = useDrawer(props.store)
  const state = useStore(props.store)
  useEffect(() => { if (drawer !== null) void props.store.loadChoices() }, [drawer, props.store])
  if (drawer === null) return null
  const close = (): void => { props.store.setDrawer(null) }
  const task = drawer.mode === 'detail' ? state.tasks.find(item => item.id === drawer.taskId) : undefined
  const title = drawer.mode === 'create'
    ? '新建任务'
    : drawer.mode === 'list' ? (drawer.sessionId === undefined ? '全部任务' : '任务')
      : (task === undefined ? '任务已删除' : '任务详情')

  let body: ReactNode
  let foot: ReactNode = null
  if (drawer.mode === 'create') {
    body = createElement('div', { className: 'dt-drawer-body' },
      createElement('div', { className: 'dt-empty' }, '创建流程在此渲染；接入 CreateFlow 与 choices 后即可用。'))
  } else if (drawer.mode === 'list') {
    const tasks = drawer.scope === 'all'
      ? sortTasks(state.tasks)
      : sortTasks(state.tasks.filter(item => item.originSessionId === drawer.sessionId || item.targetSessionId === drawer.sessionId))
    body = createElement(Fragment, null,
      createElement('div', { className: 'dt-drawer-toolbar' },
        createElement('button', {
          className: 'dt-btn',
          onClick: () => { props.store.setDrawer({ mode: 'create', sessionId: drawer.sessionId }) },
        }, '＋ 新建'),
        createElement('span', { className: 'dt-spacer' }),
        createElement('span', { className: 'dt-muted' }, `${tasks.length} 条`)),
      createElement(TaskList, {
        className: 'dt-drawer-list',
        tasks,
        empty: '暂无任务。',
        store: props.store,
        api: props.api,
        openTask: (id: string) => {
          props.store.setDrawer({ mode: 'detail', taskId: id, back: { scope: drawer.scope, sessionId: drawer.sessionId } })
        },
      }))
  } else if (task === undefined) {
    body = createElement('div', { className: 'dt-drawer-body' },
      createElement('div', { className: 'dt-empty' }, '这个任务已经不存在了。'))
  } else {
    body = createElement(TaskDetail, { key: task.id, task, store: props.store, api: props.api })
    foot = createElement('div', { className: 'dt-drawer-foot' },
      createElement('button', {
        className: 'dt-btn',
        disabled: task.status === 'running',
        onClick: () => { void props.api.runNow(task.id).then(() => props.store.refresh()) },
      }, '立即执行'),
      createElement('span', { className: 'dt-spacer' }),
      createElement('button', {
        className: 'dt-btn dt-btn-danger',
        onClick: () => { void props.api.remove(task.id).then(() => { close(); return props.store.refresh() }) },
      }, '删除任务'))
  }

  return createElement('div', { className: 'dt-modal' },
    createElement('div', { className: 'dt-backdrop', onClick: close }),
    createElement('div', { className: 'dt-drawer', role: 'dialog', 'aria-label': title },
      createElement('div', { className: 'dt-drawer-head' },
        drawer.mode === 'detail' && drawer.back !== null
          ? createElement('button', {
            className: 'dt-btn',
            onClick: () => { props.store.setDrawer({ mode: 'list', scope: drawer.back!.scope, sessionId: drawer.back!.sessionId }) },
          }, '‹ 返回列表')
          : null,
        createElement('h2', null, title),
        createElement('span', { className: 'dt-spacer' }),
        createElement('button', { className: 'dt-btn', onClick: close, title: '关闭' }, '✕ 关闭')),
      body,
      foot))
}

/**
 * Register every browser surface.
 *
 * One store and one poller serve all five surfaces, so the page makes one host
 * call per interval regardless of how many are mounted.
 * @param options - the slot registry, the host API, and optional plumbing.
 * @returns a disposer that releases the poller and every registration.
 */
export function registerTaskCenterUi(options: TaskCenterUiOptions): () => void {
  const store = createStore(options.api)
  const disposers: Array<() => void> = []
  const openTasks = options.openTasks
  options.insertStyles?.(CSS)

  for (const seat of [
    { key: 'conversation.input.dock', options: { name: 'conversation.input.dock', id: 'tasks', order: 1 }, view: HomeDock },
    {
      key: 'conversation.session.header.utilities',
      options: {
        name: 'conversation.session.header.utilities', id: 'tasks', order: 20,
        inject: () => ({ openTasks: () => { openTasks?.() } }),
      },
      view: SessionTasksButton,
    },
    { key: 'sidebar.panellist', options: { name: 'sidebar.panellist', id: 'tasks', order: 20, label: '任务' }, view: PanelIcon },
    { key: 'main', options: { name: 'main', key: 'tasks' }, view: TaskCenter },
    { key: 'shell.overlay', options: { name: 'shell.overlay', id: 'tasks-drawer', order: 100 }, view: TaskDrawer },
  ]) {
    disposers.push(options.slots.inject(seat.key, () => options.slots.register(
      seat.options,
      ((props: Record<string, unknown>) => createElement(
        seat.view as never,
        { ...props, store, api: options.api } as never,
      )) as (props: never) => ReactNode,
    )))
  }

  const interval = options.interval
  if (interval !== undefined) {
    disposers.push(interval(() => { void store.refresh() }, options.pollMs ?? 3000))
  }
  void store.refresh()

  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}
