import { describe, expect, it } from 'vitest'
import type { Task } from '../src/domain.js'
import {
  MAX_HORIZON_MINUTES,
  MAX_NOTE_LENGTH,
  MAX_TITLE_LENGTH,
  TaskValidationError,
  aggregateStatus,
  assertWithinHorizon,
  latestRun,
  nextDailyOccurrence,
  nextEveryOccurrence,
  nextWeeklyOccurrence,
  normalizeAtInstant,
  normalizeHour,
  normalizeIntervalMinutes,
  normalizeMinute,
  normalizeNote,
  normalizeRunIn,
  normalizeTaskState,
  normalizeTitle,
  normalizeTzOffsetMinutes,
  normalizeWeekday,
  weekdayOf,
  withRunUpdated,
  withTaskPatch,
} from '../src/domain.js'
import { MINUTE, T0, runFixture, taskFixture } from './fixtures.js'
import { RunId } from '../src/domain.js'

/** Capture the code of a thrown TaskValidationError. */
function codeOf(action: () => unknown): string {
  try {
    action()
  } catch (error: unknown) {
    if (error instanceof TaskValidationError) return error.code
    throw error
  }
  throw new Error('expected a TaskValidationError')
}

describe('input validation', () => {
  it('accepts a trimmed title at both bounds', () => {
    expect(normalizeTitle('  hello  ')).toBe('hello')
    expect(normalizeTitle('a'.repeat(MAX_TITLE_LENGTH))).toHaveLength(MAX_TITLE_LENGTH)
    expect(normalizeTitle('x')).toBe('x')
  })

  it('rejects an empty, over-long, or non-string title', () => {
    expect(codeOf(() => normalizeTitle('   '))).toBe('invalid_title')
    expect(codeOf(() => normalizeTitle('a'.repeat(MAX_TITLE_LENGTH + 1)))).toBe('invalid_title')
    expect(codeOf(() => normalizeTitle(42))).toBe('invalid_title')
  })

  it('accepts a note at its bound and rejects one character more', () => {
    expect(normalizeNote(undefined)).toBe('')
    expect(normalizeNote(null)).toBe('')
    expect(normalizeNote(' n ')).toBe('n')
    expect(normalizeNote('n'.repeat(MAX_NOTE_LENGTH))).toHaveLength(MAX_NOTE_LENGTH)
    expect(codeOf(() => normalizeNote('n'.repeat(MAX_NOTE_LENGTH + 1)))).toBe('invalid_note')
  })

  it('accepts exactly the documented enumerations', () => {
    expect(normalizeTaskState('open')).toBe('open')
    expect(normalizeTaskState('paused')).toBe('paused')
    expect(normalizeTaskState('done')).toBe('done')
    expect(codeOf(() => normalizeTaskState('running'))).toBe('invalid_state')

    expect(normalizeRunIn('new-session')).toBe('new-session')
    expect(normalizeRunIn('origin-session')).toBe('origin-session')
    expect(normalizeRunIn('session')).toBe('session')
    expect(codeOf(() => normalizeRunIn('other'))).toBe('invalid_run_in')
  })

  it('enforces every wall-clock bound at its edge', () => {
    expect(normalizeHour(0)).toBe(0)
    expect(normalizeHour(23)).toBe(23)
    expect(codeOf(() => normalizeHour(24))).toBe('invalid_hour')
    expect(codeOf(() => normalizeHour(-1))).toBe('invalid_hour')

    expect(normalizeMinute(0)).toBe(0)
    expect(normalizeMinute(59)).toBe(59)
    expect(codeOf(() => normalizeMinute(60))).toBe('invalid_minute')

    expect(normalizeWeekday(0)).toBe(0)
    expect(normalizeWeekday(6)).toBe(6)
    expect(codeOf(() => normalizeWeekday(7))).toBe('invalid_weekday')

    expect(normalizeTzOffsetMinutes(-840)).toBe(-840)
    expect(normalizeTzOffsetMinutes(840)).toBe(840)
    expect(codeOf(() => normalizeTzOffsetMinutes(841))).toBe('invalid_offset')
  })

  it('requires an interval of at least one minute', () => {
    expect(normalizeIntervalMinutes(1)).toBe(1)
    expect(normalizeIntervalMinutes(MAX_HORIZON_MINUTES)).toBe(MAX_HORIZON_MINUTES)
    expect(codeOf(() => normalizeIntervalMinutes(0))).toBe('invalid_interval')
    expect(codeOf(() => normalizeIntervalMinutes(1.5))).toBe('invalid_interval')
    expect(codeOf(() => normalizeIntervalMinutes(MAX_HORIZON_MINUTES + 1))).toBe('invalid_interval')
  })

  it('accepts only a canonical, real UTC instant', () => {
    expect(normalizeAtInstant('2030-01-02T03:04:05.000Z')).toBe('2030-01-02T03:04:05.000Z')
    expect(codeOf(() => normalizeAtInstant('2030-01-02T03:04:05Z'))).toBe('invalid_at')
    expect(codeOf(() => normalizeAtInstant('2030-02-30T00:00:00.000Z'))).toBe('invalid_at')
    expect(codeOf(() => normalizeAtInstant(0))).toBe('invalid_at')
  })

  it('rejects a fire instant beyond the 366-day horizon', () => {
    const horizon = MAX_HORIZON_MINUTES * MINUTE
    expect(assertWithinHorizon(T0 + horizon, T0)).toBe(T0 + horizon)
    expect(codeOf(() => assertWithinHorizon(T0 + horizon + 1, T0))).toBe('beyond_horizon')
  })
})

describe('aggregateStatus precedence', () => {
  it('reports done before anything else, even a running execution', () => {
    const task = taskFixture({ state: 'done', runs: [runFixture({ status: 'running' })] })
    expect(aggregateStatus(task)).toBe('done')
  })

  it('reports running while any execution is running', () => {
    const task = taskFixture({
      runs: [runFixture({ id: RunId('run-1'), status: 'completed' }), runFixture({ status: 'running' })],
    })
    expect(aggregateStatus(task)).toBe('running')
  })

  it('reports awaiting_acceptance when the newest execution completed', () => {
    expect(aggregateStatus(taskFixture({ runs: [runFixture({ status: 'completed' })] })))
      .toBe('awaiting_acceptance')
  })

  it('reports failed when the newest execution failed', () => {
    expect(aggregateStatus(taskFixture({ runs: [runFixture({ status: 'failed', error: 'boom' })] })))
      .toBe('failed')
  })

  it('ignores an older failure once a newer execution completed', () => {
    const task = taskFixture({
      runs: [runFixture({ status: 'failed' }), runFixture({ id: RunId('run-2'), status: 'completed' })],
    })
    expect(aggregateStatus(task)).toBe('awaiting_acceptance')
  })

  it('treats an accepted newest execution as terminal for display', () => {
    const accepted = taskFixture({ runs: [runFixture({ status: 'accepted' })] })
    expect(aggregateStatus(accepted)).toBe('pending')
    expect(aggregateStatus({ ...accepted, state: 'paused' })).toBe('paused')
  })

  it('distinguishes paused, scheduled, and pending', () => {
    expect(aggregateStatus(taskFixture({ state: 'paused' }))).toBe('paused')
    expect(aggregateStatus(taskFixture({
      schedule: { enabled: true, nextFireAt: T0 + MINUTE, spec: { kind: 'at', at: '2030-01-01T00:01:00.000Z' } },
    }))).toBe('scheduled')
    expect(aggregateStatus(taskFixture({
      schedule: { enabled: false, nextFireAt: null, spec: { kind: 'at', at: '2030-01-01T00:01:00.000Z' } },
    }))).toBe('pending')
    expect(aggregateStatus(taskFixture())).toBe('pending')
  })
})

describe('pure task transitions', () => {
  it('patches only the named fields and stamps updatedAt', () => {
    const task = taskFixture()
    const patched = withTaskPatch(task, { title: 'renamed', state: 'paused' }, T0 + 5)
    expect(patched.title).toBe('renamed')
    expect(patched.state).toBe('paused')
    expect(patched.note).toBe('')
    expect(patched.runIn).toBe('new-session')
    expect(patched.updatedAt).toBe(T0 + 5)
    expect(patched.createdAt).toBe(T0)
    expect(task.title).toBe('ship it')
  })

  it('clears a nullable field only when null is passed explicitly', () => {
    const task = taskFixture({ cwd: 'C:\\work' })
    expect(withTaskPatch(task, {}, T0).cwd).toBe('C:\\work')
    expect(withTaskPatch(task, { cwd: null }, T0).cwd).toBeNull()
  })

  it('replaces exactly one run and leaves the others identical by reference', () => {
    const first = runFixture({ id: RunId('run-1') })
    const second = runFixture({ id: RunId('run-2') })
    const task = taskFixture({ runs: [first, second] })
    const updated = withRunUpdated(task, second.id, run => ({ ...run, status: 'completed' }), T0 + 1)
    expect(updated.runs[0]).toBe(first)
    expect(updated.runs[1]?.status).toBe('completed')
    expect(updated.updatedAt).toBe(T0 + 1)
  })

  it('reports the newest run', () => {
    expect(latestRun(taskFixture())).toBeUndefined()
    const run = runFixture()
    expect(latestRun(taskFixture({ runs: [run] }))).toBe(run)
  })
})

describe('fixed-offset calendar arithmetic', () => {
  it('derives weekdays without a Date', () => {
    // 1970-01-01 was a Thursday.
    expect(weekdayOf(0)).toBe(4)
    expect(weekdayOf(Date.parse('2030-01-01T00:00:00.000Z'))).toBe(2)
    expect(weekdayOf(Date.parse('1969-12-31T00:00:00.000Z'))).toBe(3)
  })

  it('returns the next daily instant strictly after the bound', () => {
    const offset = 0
    const midnight = T0
    expect(nextDailyOccurrence(9, 30, offset, midnight)).toBe(Date.parse('2030-01-01T09:30:00.000Z'))
    expect(nextDailyOccurrence(9, 30, offset, Date.parse('2030-01-01T09:29:59.999Z')))
      .toBe(Date.parse('2030-01-01T09:30:00.000Z'))
    // Exactly on the boundary must move to the next day.
    expect(nextDailyOccurrence(9, 30, offset, Date.parse('2030-01-01T09:30:00.000Z')))
      .toBe(Date.parse('2030-01-02T09:30:00.000Z'))
    // Just past it likewise.
    expect(nextDailyOccurrence(9, 30, offset, Date.parse('2030-01-01T09:30:00.001Z')))
      .toBe(Date.parse('2030-01-02T09:30:00.000Z'))
  })

  it('applies the captured offset and never re-reads the zone', () => {
    // 09:00 at a captured UTC+02:00 is always 07:00 UTC; a real zone that moves
    // its offset across the year would still fire at 07:00 UTC here.
    const plus2 = 120
    expect(nextDailyOccurrence(9, 0, plus2, Date.parse('2030-03-30T00:00:00.000Z')))
      .toBe(Date.parse('2030-03-30T07:00:00.000Z'))
    expect(nextDailyOccurrence(9, 0, plus2, Date.parse('2030-03-31T00:00:00.000Z')))
      .toBe(Date.parse('2030-03-31T07:00:00.000Z'))
  })

  it('finds the next weekly instant within the same or the following week', () => {
    const offset = 0
    // 2030-01-01 is a Tuesday (weekday 2).
    expect(nextWeeklyOccurrence(2, 8, 0, offset, T0)).toBe(Date.parse('2030-01-01T08:00:00.000Z'))
    expect(nextWeeklyOccurrence(2, 0, 0, offset, T0)).toBe(Date.parse('2030-01-08T00:00:00.000Z'))
    expect(nextWeeklyOccurrence(3, 8, 0, offset, T0)).toBe(Date.parse('2030-01-02T08:00:00.000Z'))
    expect(nextWeeklyOccurrence(1, 8, 0, offset, T0)).toBe(Date.parse('2030-01-07T08:00:00.000Z'))
  })

  it('aligns every occurrence to the anchor and skips a whole backlog', () => {
    expect(nextEveryOccurrence(5, T0, T0 - MINUTE)).toBe(T0)
    expect(nextEveryOccurrence(5, T0, T0)).toBe(T0 + 5 * MINUTE)
    expect(nextEveryOccurrence(5, T0, T0 + 5 * MINUTE - 1)).toBe(T0 + 5 * MINUTE)
    // Ten missed intervals collapse to the single next future one.
    expect(nextEveryOccurrence(5, T0, T0 + 49 * MINUTE)).toBe(T0 + 50 * MINUTE)
    expect(nextEveryOccurrence(5, T0, T0 + 50 * MINUTE)).toBe(T0 + 55 * MINUTE)
  })
})

describe('task fixture sanity', () => {
  it('produces a task the aggregate classifies as pending', () => {
    const task: Task = taskFixture()
    expect(aggregateStatus(task)).toBe('pending')
  })
})
