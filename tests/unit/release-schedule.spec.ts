/** UNIT: IST date/time helpers behind drip delivery (src/lib/releaseSchedule.ts). */
import { test, expect } from '@playwright/test'
import {
  addCalendarDays, computePerStudentUnlockAt, istPartsFromIso, istPartsToIso,
  normalizeDeliveryMode, normalizeUnlockTime,
} from '../../src/lib/releaseSchedule'

test('normalizeDeliveryMode keeps valid modes and defaults the rest to all_at_once', () => {
  expect(normalizeDeliveryMode('fixed_calendar')).toBe('fixed_calendar')
  expect(normalizeDeliveryMode('per_student_drip')).toBe('per_student_drip')
  for (const bad of [undefined, null, '', 'weekly', 42]) expect(normalizeDeliveryMode(bad)).toBe('all_at_once')
})

test('normalizeUnlockTime trims seconds and falls back to 09:00', () => {
  expect(normalizeUnlockTime('18:30:00')).toBe('18:30')
  expect(normalizeUnlockTime('07:15')).toBe('07:15')
  for (const bad of [undefined, null, 'garbage', '9:00', 900]) expect(normalizeUnlockTime(bad)).toBe('09:00')
})

test('istPartsFromIso converts UTC to IST (can roll to the next day)', () => {
  expect(istPartsFromIso('2026-03-10T20:00:00Z')).toEqual({ date: '2026-03-11', time: '01:30' })
  expect(istPartsFromIso('2026-03-10T05:00:00Z')).toEqual({ date: '2026-03-10', time: '10:30' })
  expect(istPartsFromIso(null)).toBeNull()
  expect(istPartsFromIso('nope')).toBeNull()
})

test('istPartsToIso converts IST wall-clock to UTC and rejects bad input', () => {
  expect(istPartsToIso('2026-03-13', '09:00')).toBe('2026-03-13T03:30:00.000Z')
  expect(istPartsToIso('2026-3-13', '09:00')).toBeNull()
  expect(istPartsToIso('2026-03-13', '9:00')).toBeNull()
})

test('addCalendarDays handles month, year and leap-day boundaries', () => {
  expect(addCalendarDays('2026-02-27', 2)).toBe('2026-03-01')
  expect(addCalendarDays('2028-02-28', 1)).toBe('2028-02-29')
  expect(addCalendarDays('2026-12-31', 1)).toBe('2027-01-01')
})

test.describe('computePerStudentUnlockAt', () => {
  test('uses the IST calendar date, not enrollment time + N x 24h', () => {
    expect(computePerStudentUnlockAt('2026-03-10T20:00:00Z', 2, '09:00')?.toISOString()).toBe('2026-03-13T03:30:00.000Z')
  })
  test('two students enrolling on the same IST day unlock at the same moment', () => {
    const early = computePerStudentUnlockAt('2026-03-10T19:00:00Z', 2, '09:00') // 00:30 IST on the 11th
    const late = computePerStudentUnlockAt('2026-03-11T17:59:00Z', 2, '09:00') // 23:29 IST on the 11th
    expect(early?.toISOString()).toBe(late?.toISOString())
  })
  test('honours the course unlock time', () => {
    expect(computePerStudentUnlockAt('2026-03-10T20:00:00Z', 2, '18:30')?.toISOString()).toBe('2026-03-13T13:00:00.000Z')
  })
  test('returns null (= never lock) for day 0, negative, fractional or bad input', () => {
    expect(computePerStudentUnlockAt('2026-03-10T20:00:00Z', 0, '09:00')).toBeNull()
    expect(computePerStudentUnlockAt('2026-03-10T20:00:00Z', -3, '09:00')).toBeNull()
    expect(computePerStudentUnlockAt('2026-03-10T20:00:00Z', 1.5, '09:00')).toBeNull()
    expect(computePerStudentUnlockAt('garbage', 2, '09:00')).toBeNull()
  })
})