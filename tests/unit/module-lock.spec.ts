/**
 * UNIT: module release-schedule lock (src/lib/moduleLock.ts).
 * Pure logic, no database. Rule: missing or broken data NEVER locks a paying student.
 * IST reference: enrolling 2026-03-10T20:00Z is already 2026-03-11 01:30 in IST,
 * so "+2 days at 09:00 IST" = 2026-03-13T03:30:00.000Z.
 */
import { test, expect } from '@playwright/test'
import { evaluateModuleLock, evaluateLockForEnrollments, computeModuleUnlockAt } from '../../src/lib/moduleLock'

const ENROLLED = '2026-03-10T20:00:00.000Z'
const DRIP_UNLOCK = '2026-03-13T03:30:00.000Z'
const FIXED_UNLOCK = '2026-06-01T00:00:00.000Z'
const mod = { name: 'Module 2', unlock_date: FIXED_UNLOCK, unlock_after_days: 2 }
const at = (iso: string) => new Date(iso)

test.describe('all_at_once and missing data never lock', () => {
  test('all_at_once ignores any schedule on the module', () => {
    const r = evaluateModuleLock({ deliveryMode: 'all_at_once', unlockTime: '09:00', module: mod, enrolledAt: ENROLLED, now: at('2026-01-01T00:00:00Z') })
    expect(r.locked).toBe(false)
  })
  test('lesson with no module is unlocked', () => {
    expect(evaluateModuleLock({ deliveryMode: 'fixed_calendar', unlockTime: '09:00', module: null, enrolledAt: ENROLLED }).locked).toBe(false)
  })
  test('unknown delivery mode falls back to unlocked', () => {
    expect(evaluateModuleLock({ deliveryMode: 'weird', unlockTime: '09:00', module: mod, enrolledAt: ENROLLED, now: at('2026-01-01T00:00:00Z') }).locked).toBe(false)
  })
})

test.describe('fixed_calendar', () => {
  const base = { deliveryMode: 'fixed_calendar', unlockTime: '09:00', module: mod, enrolledAt: ENROLLED }
  test('locked before the date, with the unlock time and module name', () => {
    const r = evaluateModuleLock({ ...base, now: at('2026-05-31T23:59:59.999Z') })
    expect(r).toEqual({ locked: true, unlockAt: FIXED_UNLOCK, moduleName: 'Module 2' })
  })
  test('unlocks at the exact moment (boundary is inclusive)', () => {
    expect(evaluateModuleLock({ ...base, now: at(FIXED_UNLOCK) }).locked).toBe(false)
  })
  test('stays unlocked afterwards', () => {
    expect(evaluateModuleLock({ ...base, now: at('2027-01-01T00:00:00Z') }).locked).toBe(false)
  })
  test('missing unlock_date -> unlocked', () => {
    expect(evaluateModuleLock({ ...base, module: { name: 'x', unlock_date: null }, now: at('2026-01-01T00:00:00Z') }).locked).toBe(false)
  })
  test('garbage unlock_date -> unlocked, never locked', () => {
    expect(evaluateModuleLock({ ...base, module: { unlock_date: 'not-a-date' }, now: at('2026-01-01T00:00:00Z') }).locked).toBe(false)
  })
  test('module without a name reports moduleName null', () => {
    const r = evaluateModuleLock({ ...base, module: { unlock_date: FIXED_UNLOCK }, now: at('2026-01-01T00:00:00Z') })
    expect(r).toMatchObject({ locked: true, moduleName: null })
  })
})

test.describe('per_student_drip (IST calendar math)', () => {
  const base = { deliveryMode: 'per_student_drip', unlockTime: '09:00', module: mod, enrolledAt: ENROLLED }
  test('locked 1ms before the student\'s own unlock moment', () => {
    const r = evaluateModuleLock({ ...base, now: at('2026-03-13T03:29:59.999Z') })
    expect(r).toEqual({ locked: true, unlockAt: DRIP_UNLOCK, moduleName: 'Module 2' })
  })
  test('unlocked at the exact unlock moment', () => {
    expect(evaluateModuleLock({ ...base, now: at(DRIP_UNLOCK) }).locked).toBe(false)
  })
  test('unlock_after_days = 0 means available immediately', () => {
    expect(evaluateModuleLock({ ...base, module: { unlock_after_days: 0 }, now: at(ENROLLED) }).locked).toBe(false)
  })
  test('missing enrolledAt -> unlocked', () => {
    expect(evaluateModuleLock({ ...base, enrolledAt: null, now: at('2026-01-01T00:00:00Z') }).locked).toBe(false)
  })
  test('null / negative / fractional unlock_after_days -> unlocked', () => {
    for (const days of [null, undefined, -1, 1.5]) {
      expect(evaluateModuleLock({ ...base, module: { unlock_after_days: days as any }, now: at('2026-03-10T21:00:00Z') }).locked).toBe(false)
    }
  })
  test('Postgres time format 09:00:00 is accepted, 18:30 shifts the moment', () => {
    const r = evaluateModuleLock({ ...base, unlockTime: '18:30:00', now: at('2026-03-13T12:59:59Z') })
    expect(r).toMatchObject({ locked: true, unlockAt: '2026-03-13T13:00:00.000Z' })
  })
})

test.describe('students with more than one enrollment', () => {
  const base = { deliveryMode: 'per_student_drip', unlockTime: '09:00', module: mod }
  const OLD = ENROLLED // unlocks 2026-03-13T03:30Z
  const NEW = '2026-03-20T05:00:00.000Z' // unlocks 2026-03-22T03:30Z
  test('locked only if EVERY enrollment is locked; reports the soonest unlock', () => {
    const r = evaluateLockForEnrollments({ ...base, enrolledAts: [NEW, OLD], now: at('2026-03-12T00:00:00Z') })
    expect(r).toMatchObject({ locked: true, unlockAt: DRIP_UNLOCK })
  })
  test('unlocked as soon as any one enrollment is unlocked', () => {
    expect(evaluateLockForEnrollments({ ...base, enrolledAts: [NEW, OLD], now: at('2026-03-14T00:00:00Z') }).locked).toBe(false)
  })
  test('empty list behaves like missing data -> unlocked', () => {
    expect(evaluateLockForEnrollments({ ...base, enrolledAts: [], now: at('2026-01-01T00:00:00Z') }).locked).toBe(false)
  })
})

test.describe('computeModuleUnlockAt agrees with evaluateModuleLock', () => {
  for (const mode of ['fixed_calendar', 'per_student_drip']) {
    test(`${mode}: locked exactly while now < unlock moment`, () => {
      const input = { deliveryMode: mode, unlockTime: '09:00', module: mod, enrolledAt: ENROLLED }
      const unlockAt = computeModuleUnlockAt(input)!.getTime()
      for (const delta of [-86_400_000, -1, 0, 1, 86_400_000]) {
        const now = new Date(unlockAt + delta)
        expect(evaluateModuleLock({ ...input, now }).locked).toBe(now.getTime() < unlockAt)
      }
    })
  }
  test('all_at_once has no unlock moment', () => {
    expect(computeModuleUnlockAt({ deliveryMode: 'all_at_once', unlockTime: '09:00', module: mod, enrolledAt: ENROLLED })).toBeNull()
  })
})