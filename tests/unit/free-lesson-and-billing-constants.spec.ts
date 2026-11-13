/**
 * UNIT: free-lesson rule + billing constants + month helpers.
 * The constants test is deliberate: changing a rate or grace period should be a
 * conscious act that makes a test fail, not an accident.
 */
import { test, expect } from '@playwright/test'
import { isLessonFree } from '../../src/lib/freeLesson'
import {
  REVENUE_SHARE_BASE_RATE_PERCENT, REVENUE_SHARE_OVERFLOW_RATE_PERCENT, REVENUE_SHARE_STUDENT_THRESHOLD,
  REVENUE_SHARE_INVOICE_GRACE_DAYS, EBOOK_REVENUE_SHARE_RATE_PERCENT, EBOOK_MONTHLY_REVENUE_FLOOR,
  monthStart, monthEnd, previousMonthRange,
} from '../../src/lib/revenueShare'

test.describe('isLessonFree: a lesson is free if EITHER the course or the lesson is free', () => {
  const cases: [boolean, boolean, boolean][] = [
    [false, false, false], // paid course, paid lesson
    [true, false, true],   // free lesson inside a paid course
    [false, true, true],   // free course
    [true, true, true],
  ]
  for (const [lessonFree, courseFree, expected] of cases) {
    test(`lesson.is_free=${lessonFree}, course.is_free_course=${courseFree} -> ${expected}`, () => {
      expect(isLessonFree({ is_free: lessonFree }, { is_free_course: courseFree })).toBe(expected)
    })
  }
})

test('billing constants match the published pricing', () => {
  expect(REVENUE_SHARE_BASE_RATE_PERCENT).toBe(5)
  expect(REVENUE_SHARE_OVERFLOW_RATE_PERCENT).toBe(6.5)
  expect(REVENUE_SHARE_STUDENT_THRESHOLD).toBe(300)
  expect(REVENUE_SHARE_INVOICE_GRACE_DAYS).toBe(14)
  expect(EBOOK_REVENUE_SHARE_RATE_PERCENT).toBe(4)
  expect(EBOOK_MONTHLY_REVENUE_FLOOR).toBe(500)
})

test.describe('billing month helpers (UTC)', () => {
  test('monthStart / monthEnd', () => {
    expect(monthStart(new Date('2026-03-15T10:00:00Z'))).toBe('2026-03-01')
    expect(monthEnd(new Date('2026-03-15T10:00:00Z'))).toBe('2026-03-31')
  })
  test('monthEnd handles February in a leap and a normal year', () => {
    expect(monthEnd(new Date('2028-02-10T00:00:00Z'))).toBe('2028-02-29')
    expect(monthEnd(new Date('2026-02-10T00:00:00Z'))).toBe('2026-02-28')
  })
  test('previousMonthRange crosses the year boundary', () => {
    expect(previousMonthRange(new Date('2026-01-05T00:00:00Z'))).toEqual({ start: '2025-12-01', end: '2025-12-31' })
  })
})