/**
 * Recurrence evaluation: the single authority for "when does this schedule
 * fire next" and for turning caller input into a normalized {@link Schedule}.
 *
 * Recurrences are evaluated against a UTC offset captured once at creation and
 * stored in the spec. No daylight-saving transition is modelled anywhere in
 * this package: a `daily` 09:00 schedule in a zone that changes offset keeps
 * firing at the same UTC instant, so its local wall-clock time drifts by one
 * hour across the transition. Modelling zone rules would require an IANA
 * database and a per-occurrence zone lookup, which this package does not carry.
 *
 * @module dsh-task-center/schedule
 */

import type { Schedule, ScheduleSpec } from './domain.js'
import {
  MAX_HORIZON_MINUTES,
  MINUTE_MS,
  TaskValidationError,
  assertWithinHorizon,
  isSafeInteger,
  nextDailyOccurrence,
  nextEveryOccurrence,
  nextWeeklyOccurrence,
  normalizeAtInstant,
  normalizeHour,
  normalizeInstant,
  normalizeIntervalMinutes,
  normalizeMinute,
  normalizeTzOffsetMinutes,
  normalizeWeekday,
} from './domain.js'

/**
 * The next instant a recurrence fires, strictly after `fromMs`.
 *
 * `daily`, `weekly`, and `every` always have a next occurrence. `after` and
 * `at` are one-shot rules and return null once their single instant is spent.
 * @param spec - Normalized recurrence rule.
 * @param fromMs - Exclusive lower bound in epoch milliseconds.
 * @returns The next fire instant, or null for a spent one-shot.
 */
export function nextOccurrence(spec: ScheduleSpec, fromMs: number): number | null {
  switch (spec.kind) {
    case 'after': {
      const target = spec.anchorMs + spec.delayMinutes * MINUTE_MS
      return target > fromMs ? target : null
    }
    case 'at': {
      const target = Date.parse(spec.at)
      return target > fromMs ? target : null
    }
    case 'daily':
      return nextDailyOccurrence(spec.hour, spec.minute, spec.tzOffsetMinutes, fromMs)
    case 'weekly':
      return nextWeeklyOccurrence(spec.weekday, spec.hour, spec.minute, spec.tzOffsetMinutes, fromMs)
    case 'every':
      return nextEveryOccurrence(spec.intervalMinutes, spec.anchorMs, fromMs)
    default: {
      const unreachable: never = spec
      throw new TaskValidationError('invalid_schedule_kind', `unknown schedule kind ${String(unreachable)}`)
    }
  }
}

/**
 * Whether a schedule is enabled and due at `nowMs`.
 * @param schedule - Schedule to test.
 * @param nowMs - Wall-clock instant in epoch milliseconds.
 * @returns True when the schedule must fire now.
 */
export function isDue(schedule: Schedule, nowMs: number): boolean {
  return schedule.enabled && schedule.nextFireAt !== null && schedule.nextFireAt <= nowMs
}

/**
 * Advance a schedule past `nowMs`, disabling it when its one-shot instant is spent.
 * @param schedule - Schedule to advance.
 * @param nowMs - Wall-clock instant in epoch milliseconds.
 * @returns The advanced schedule.
 */
export function advanceSchedule(schedule: Schedule, nowMs: number): Schedule {
  const nextFireAt = nextOccurrence(schedule.spec, nowMs)
  return { enabled: nextFireAt !== null, nextFireAt, spec: schedule.spec }
}

/** Caller-supplied schedule rule before normalization. */
export type ScheduleInput =
  | { readonly kind: 'after'; readonly delayMinutes: number }
  | { readonly kind: 'at'; readonly at: string }
  | { readonly kind: 'daily'; readonly hour: number; readonly minute: number; readonly tzOffsetMinutes?: number }
  | {
      readonly kind: 'weekly'
      readonly weekday: number
      readonly hour: number
      readonly minute: number
      readonly tzOffsetMinutes?: number
    }
  | { readonly kind: 'every'; readonly intervalMinutes: number; readonly anchorMs?: number }

/**
 * Capture the process's UTC offset for one instant.
 *
 * This is the only place the package reads the host time zone. Callers that
 * know their target offset pass `tzOffsetMinutes` explicitly instead.
 * @param nowMs - Instant to sample in epoch milliseconds.
 * @returns Offset east of UTC in minutes.
 */
export function captureTzOffsetMinutes(nowMs: number): number {
  return -new Date(nowMs).getTimezoneOffset()
}

/**
 * Validate one caller-supplied rule and compute its first fire instant.
 * @param input - Caller-supplied rule.
 * @param nowMs - Creation instant in epoch milliseconds.
 * @returns The normalized schedule with `nextFireAt` set.
 * @throws TaskValidationError when the rule violates a documented bound.
 */
export function buildSchedule(input: ScheduleInput, nowMs: number): Schedule {
  const spec = buildSpec(input, nowMs)
  const nextFireAt = nextOccurrence(spec, nowMs)
  if (nextFireAt !== null) assertWithinHorizon(nextFireAt, nowMs)
  return { enabled: true, nextFireAt, spec }
}

/** Validate one caller-supplied rule into its normalized spec. */
function buildSpec(input: ScheduleInput, nowMs: number): ScheduleSpec {
  switch (input.kind) {
    case 'after': {
      const delayMinutes = normalizeIntervalMinutes(input.delayMinutes)
      if (delayMinutes >= MAX_HORIZON_MINUTES) {
        throw new TaskValidationError('beyond_horizon', `delayMinutes must be less than ${MAX_HORIZON_MINUTES}`)
      }
      return { kind: 'after', delayMinutes, anchorMs: nowMs }
    }
    case 'at': {
      const at = normalizeAtInstant(input.at)
      const target = Date.parse(at)
      if (target <= nowMs) {
        throw new TaskValidationError('at_not_future', 'at must be strictly in the future')
      }
      assertWithinHorizon(target, nowMs)
      return { kind: 'at', at }
    }
    case 'daily':
      return {
        kind: 'daily',
        hour: normalizeHour(input.hour),
        minute: normalizeMinute(input.minute),
        tzOffsetMinutes: normalizeTzOffsetMinutes(input.tzOffsetMinutes ?? captureTzOffsetMinutes(nowMs)),
      }
    case 'weekly':
      return {
        kind: 'weekly',
        weekday: normalizeWeekday(input.weekday),
        hour: normalizeHour(input.hour),
        minute: normalizeMinute(input.minute),
        tzOffsetMinutes: normalizeTzOffsetMinutes(input.tzOffsetMinutes ?? captureTzOffsetMinutes(nowMs)),
      }
    case 'every':
      return {
        kind: 'every',
        intervalMinutes: normalizeIntervalMinutes(input.intervalMinutes),
        anchorMs: normalizeInstant(input.anchorMs ?? nowMs, 'anchorMs'),
      }
    default: {
      const unreachable: never = input
      throw new TaskValidationError('invalid_schedule_kind', `unknown schedule kind ${String(unreachable)}`)
    }
  }
}

/**
 * Validate one decoded schedule value from durable JSON.
 *
 * A stored `nextFireAt` is authoritative: a restart never reschedules a
 * pending one-shot, and a recurrence keeps the instant it was already armed
 * for. Only `nextFireAt: null` is preserved as "spent or disabled".
 * @param schedule - Candidate decoded schedule.
 * @returns The validated schedule.
 * @throws TaskValidationError when the value cannot be a schedule.
 */
export function decodeSchedule(schedule: unknown): Schedule {
  if (schedule === null || typeof schedule !== 'object' || Array.isArray(schedule)) {
    throw new TaskValidationError('invalid_schedule_kind', 'schedule must be an object')
  }
  const record = schedule as Record<string, unknown>
  const spec = decodeScheduleSpec(record['spec'])
  const enabled = record['enabled']
  if (typeof enabled !== 'boolean') {
    throw new TaskValidationError('invalid_schedule_kind', 'schedule.enabled must be a boolean')
  }
  const rawNext = record['nextFireAt']
  if (rawNext !== null && !isSafeInteger(rawNext)) {
    throw new TaskValidationError('invalid_schedule_kind', 'schedule.nextFireAt must be null or a safe integer')
  }
  return { enabled, nextFireAt: rawNext === null ? null : rawNext, spec }
}

/**
 * Validate one decoded schedule spec.
 * @param value - Untrusted decoded value.
 * @returns The validated spec.
 * @throws TaskValidationError when the value is not one of the five rules.
 */
export function decodeScheduleSpec(value: unknown): ScheduleSpec {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TaskValidationError('invalid_schedule_kind', 'schedule.spec must be an object')
  }
  const record = value as Record<string, unknown>
  switch (record['kind']) {
    case 'after':
      return {
        kind: 'after',
        delayMinutes: normalizeIntervalMinutes(record['delayMinutes']),
        anchorMs: normalizeInstant(record['anchorMs'], 'anchorMs'),
      }
    case 'at':
      return { kind: 'at', at: normalizeAtInstant(record['at']) }
    case 'daily':
      return {
        kind: 'daily',
        hour: normalizeHour(record['hour']),
        minute: normalizeMinute(record['minute']),
        tzOffsetMinutes: normalizeTzOffsetMinutes(record['tzOffsetMinutes']),
      }
    case 'weekly':
      return {
        kind: 'weekly',
        weekday: normalizeWeekday(record['weekday']),
        hour: normalizeHour(record['hour']),
        minute: normalizeMinute(record['minute']),
        tzOffsetMinutes: normalizeTzOffsetMinutes(record['tzOffsetMinutes']),
      }
    case 'every':
      return {
        kind: 'every',
        intervalMinutes: normalizeIntervalMinutes(record['intervalMinutes']),
        anchorMs: normalizeInstant(record['anchorMs'], 'anchorMs'),
      }
    default:
      throw new TaskValidationError(
        'invalid_schedule_kind',
        'schedule.spec.kind must be "after", "at", "daily", "weekly", or "every"',
      )
  }
}

/** Weekday labels indexed by the Sunday-is-zero weekday number. */
const WEEKDAYS: readonly string[] = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Zero-pad one wall-clock field. */
function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** Render a captured UTC offset as `+HH:MM` or `-HH:MM`. */
function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? '-' : '+'
  const absolute = Math.abs(offsetMinutes)
  return `${sign}${pad2(Math.floor(absolute / 60))}:${pad2(absolute % 60)}`
}

/**
 * Render a rule as one short human- and model-readable line.
 * @param spec - Normalized recurrence rule.
 * @returns A stable description of the rule.
 */
export function describeSchedule(spec: ScheduleSpec): string {
  switch (spec.kind) {
    case 'after':
      return `after ${spec.delayMinutes} minute(s)`
    case 'at':
      return `once at ${spec.at}`
    case 'daily':
      return `daily at ${pad2(spec.hour)}:${pad2(spec.minute)} (UTC${formatOffset(spec.tzOffsetMinutes)})`
    case 'weekly':
      return `weekly on ${WEEKDAYS[spec.weekday] ?? '?'} at ${pad2(spec.hour)}:${pad2(spec.minute)} (UTC${formatOffset(spec.tzOffsetMinutes)})`
    case 'every':
      return `every ${spec.intervalMinutes} minute(s)`
    default: {
      const unreachable: never = spec
      throw new TaskValidationError('invalid_schedule_kind', `unknown schedule kind ${String(unreachable)}`)
    }
  }
}
