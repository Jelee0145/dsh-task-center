import { describe, expect, it } from 'vitest'
import type { ScheduleSpec } from '../src/domain.js'
import { MAX_HORIZON_DAYS, TaskValidationError } from '../src/domain.js'
import {
  advanceSchedule,
  buildSchedule,
  captureTzOffsetMinutes,
  decodeSchedule,
  describeSchedule,
  isDue,
  nextOccurrence,
} from '../src/schedule.js'
import { MINUTE, T0 } from './fixtures.js'

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

/** Round-trip a value through JSON, as durability does. */
function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

describe('nextOccurrence for the five rule kinds', () => {
  it('measures `after` from its creation anchor and spends exactly once', () => {
    const spec: ScheduleSpec = { kind: 'after', delayMinutes: 30, anchorMs: T0 }
    expect(nextOccurrence(spec, T0)).toBe(T0 + 30 * MINUTE)
    expect(nextOccurrence(spec, T0 + 30 * MINUTE - 1)).toBe(T0 + 30 * MINUTE)
    expect(nextOccurrence(spec, T0 + 30 * MINUTE)).toBeNull()
    expect(nextOccurrence(spec, T0 + 31 * MINUTE)).toBeNull()
  })

  it('returns the `at` instant until it is spent', () => {
    const spec: ScheduleSpec = { kind: 'at', at: '2030-01-01T00:05:00.000Z' }
    expect(nextOccurrence(spec, T0)).toBe(T0 + 5 * MINUTE)
    expect(nextOccurrence(spec, T0 + 5 * MINUTE)).toBeNull()
    expect(nextOccurrence(spec, T0 + 10 * MINUTE)).toBeNull()
  })

  it('rolls `daily` to the next day exactly on the boundary', () => {
    const spec: ScheduleSpec = { kind: 'daily', hour: 9, minute: 0, tzOffsetMinutes: 0 }
    expect(nextOccurrence(spec, T0)).toBe(Date.parse('2030-01-01T09:00:00.000Z'))
    expect(nextOccurrence(spec, Date.parse('2030-01-01T09:00:00.000Z')))
      .toBe(Date.parse('2030-01-02T09:00:00.000Z'))
  })

  it('rolls `weekly` a full week when the target day has already passed', () => {
    const spec: ScheduleSpec = { kind: 'weekly', weekday: 2, hour: 0, minute: 0, tzOffsetMinutes: 0 }
    expect(nextOccurrence(spec, T0)).toBe(Date.parse('2030-01-08T00:00:00.000Z'))
    expect(nextOccurrence(spec, T0 - 1)).toBe(Date.parse('2030-01-01T00:00:00.000Z'))
  })

  it('catches `every` up to the first future occurrence only', () => {
    const spec: ScheduleSpec = { kind: 'every', intervalMinutes: 15, anchorMs: T0 }
    expect(nextOccurrence(spec, T0)).toBe(T0 + 15 * MINUTE)
    // Ten missed intervals collapse to one, never a backlog.
    expect(nextOccurrence(spec, T0 + 149 * MINUTE)).toBe(T0 + 150 * MINUTE)
    expect(nextOccurrence(spec, T0 - 60 * MINUTE)).toBe(T0)
  })
})

describe('schedule construction', () => {
  it('anchors `after` at the creation instant', () => {
    const schedule = buildSchedule({ kind: 'after', delayMinutes: 5 }, T0)
    expect(schedule).toEqual({
      enabled: true,
      nextFireAt: T0 + 5 * MINUTE,
      spec: { kind: 'after', delayMinutes: 5, anchorMs: T0 },
    })
  })

  it('anchors `every` at the creation instant unless one is given', () => {
    expect(buildSchedule({ kind: 'every', intervalMinutes: 2 }, T0).spec)
      .toEqual({ kind: 'every', intervalMinutes: 2, anchorMs: T0 })
    expect(buildSchedule({ kind: 'every', intervalMinutes: 2, anchorMs: T0 - MINUTE }, T0).spec)
      .toEqual({ kind: 'every', intervalMinutes: 2, anchorMs: T0 - MINUTE })
  })

  it('rejects an `at` that is not strictly in the future', () => {
    expect(codeOf(() => buildSchedule({ kind: 'at', at: '2030-01-01T00:00:00.000Z' }, T0)))
      .toBe('at_not_future')
    expect(codeOf(() => buildSchedule({ kind: 'at', at: '2029-12-31T23:59:59.999Z' }, T0)))
      .toBe('at_not_future')
    expect(buildSchedule({ kind: 'at', at: '2030-01-01T00:00:00.001Z' }, T0).nextFireAt)
      .toBe(T0 + 1)
  })

  it('rejects a rule whose next fire is beyond the 366-day horizon', () => {
    const justInside = new Date(T0 + MAX_HORIZON_DAYS * 24 * 60 * MINUTE - 1).toISOString()
    const justOutside = new Date(T0 + MAX_HORIZON_DAYS * 24 * 60 * MINUTE + 1).toISOString()
    expect(buildSchedule({ kind: 'at', at: justInside }, T0).nextFireAt)
      .toBe(Date.parse(justInside))
    expect(codeOf(() => buildSchedule({ kind: 'at', at: justOutside }, T0))).toBe('beyond_horizon')
    expect(codeOf(() => buildSchedule({ kind: 'after', delayMinutes: MAX_HORIZON_DAYS * 24 * 60 }, T0)))
      .toBe('beyond_horizon')
  })

  it('rejects out-of-range wall-clock fields', () => {
    expect(codeOf(() => buildSchedule({ kind: 'daily', hour: 24, minute: 0 }, T0))).toBe('invalid_hour')
    expect(codeOf(() => buildSchedule({ kind: 'daily', hour: 0, minute: 60 }, T0))).toBe('invalid_minute')
    expect(codeOf(() => buildSchedule({ kind: 'weekly', weekday: 7, hour: 0, minute: 0 }, T0)))
      .toBe('invalid_weekday')
    expect(codeOf(() => buildSchedule({ kind: 'every', intervalMinutes: 0 }, T0))).toBe('invalid_interval')
    expect(codeOf(() => buildSchedule({ kind: 'after', delayMinutes: 0 }, T0))).toBe('invalid_interval')
  })

  it('captures an explicit offset instead of reading the host zone', () => {
    const schedule = buildSchedule({ kind: 'daily', hour: 9, minute: 0, tzOffsetMinutes: 330 }, T0)
    // 09:00 at UTC+05:30 is 03:30 UTC.
    expect(schedule.nextFireAt).toBe(Date.parse('2030-01-01T03:30:00.000Z'))
  })

  it('captures the host offset only when none is supplied', () => {
    const captured = captureTzOffsetMinutes(T0)
    const schedule = buildSchedule({ kind: 'daily', hour: 9, minute: 0 }, T0)
    expect(schedule.spec).toMatchObject({ tzOffsetMinutes: captured })
    expect(typeof captured).toBe('number')
  })
})

describe('advanceSchedule and isDue', () => {
  it('disables a spent one-shot and keeps the spec', () => {
    const schedule = buildSchedule({ kind: 'after', delayMinutes: 1 }, T0)
    const advanced = advanceSchedule(schedule, T0 + MINUTE)
    expect(advanced).toEqual({ enabled: false, nextFireAt: null, spec: schedule.spec })
  })

  it('re-arms a recurring rule from the fire instant', () => {
    const schedule = buildSchedule({ kind: 'every', intervalMinutes: 1 }, T0)
    const advanced = advanceSchedule(schedule, T0 + MINUTE)
    expect(advanced.enabled).toBe(true)
    expect(advanced.nextFireAt).toBe(T0 + 2 * MINUTE)
  })

  it('treats a task as due exactly at its fire instant', () => {
    const schedule = buildSchedule({ kind: 'after', delayMinutes: 1 }, T0)
    expect(isDue(schedule, T0 + MINUTE - 1)).toBe(false)
    expect(isDue(schedule, T0 + MINUTE)).toBe(true)
    expect(isDue(schedule, T0 + MINUTE + 1)).toBe(true)
    expect(isDue({ ...schedule, enabled: false }, T0 + MINUTE)).toBe(false)
  })
})

describe('durable round trip', () => {
  it('survives JSON unchanged for every rule kind', () => {
    const specs: ScheduleSpec[] = [
      { kind: 'after', delayMinutes: 7, anchorMs: T0 },
      { kind: 'at', at: '2030-06-01T12:00:00.000Z' },
      { kind: 'daily', hour: 6, minute: 30, tzOffsetMinutes: -300 },
      { kind: 'weekly', weekday: 5, hour: 17, minute: 45, tzOffsetMinutes: 60 },
      { kind: 'every', intervalMinutes: 90, anchorMs: T0 },
    ]
    for (const spec of specs) {
      const schedule = { enabled: true, nextFireAt: nextOccurrence(spec, T0), spec }
      expect(decodeSchedule(roundTrip(schedule))).toEqual(schedule)
    }
  })

  it('keeps a spent schedule spent across a restart', () => {
    const spent = { enabled: false, nextFireAt: null, spec: { kind: 'at', at: '2029-01-01T00:00:00.000Z' } as ScheduleSpec }
    expect(decodeSchedule(roundTrip(spent))).toEqual(spent)
  })

  it('rejects a schedule that cannot be one of the five rules', () => {
    expect(() => decodeSchedule({ enabled: true, nextFireAt: null, spec: { kind: 'hourly' } }))
      .toThrow(TaskValidationError)
    expect(() => decodeSchedule({ enabled: 'yes', nextFireAt: null, spec: { kind: 'every', intervalMinutes: 1, anchorMs: T0 } }))
      .toThrow(TaskValidationError)
    expect(() => decodeSchedule(null)).toThrow(TaskValidationError)
    expect(() => decodeSchedule({
      enabled: true,
      nextFireAt: 1.5,
      spec: { kind: 'every', intervalMinutes: 1, anchorMs: T0 },
    })).toThrow(TaskValidationError)
  })
})

describe('describeSchedule', () => {
  it('renders one stable line per rule kind', () => {
    expect(describeSchedule({ kind: 'after', delayMinutes: 10, anchorMs: T0 })).toBe('after 10 minute(s)')
    expect(describeSchedule({ kind: 'at', at: '2030-01-01T00:00:00.000Z' }))
      .toBe('once at 2030-01-01T00:00:00.000Z')
    expect(describeSchedule({ kind: 'daily', hour: 9, minute: 5, tzOffsetMinutes: 0 }))
      .toBe('daily at 09:05 (UTC+00:00)')
    expect(describeSchedule({ kind: 'weekly', weekday: 1, hour: 9, minute: 5, tzOffsetMinutes: -330 }))
      .toBe('weekly on Monday at 09:05 (UTC-05:30)')
    expect(describeSchedule({ kind: 'every', intervalMinutes: 60, anchorMs: T0 })).toBe('every 60 minute(s)')
  })
})
