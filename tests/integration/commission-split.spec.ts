/**
 * INTEGRATION: Kurso's commission on a sale (computeRevenueShareSplit) against the test DB.
 * Rules: 5% base; 6.5% once paid students are STRICTLY MORE than the threshold (300);
 * only paid, non-test enrollments count. We shrink the threshold to 2 via an agreement
 * so we don't need 300 students.
 */
import { test, expect } from '@playwright/test'
import { db } from '../helpers/admin-db'
import { createCreator, createCourse, cleanup } from '../helpers/factories'
import { computeRevenueShareSplit } from '../../src/lib/revenueShare'

test.afterAll(async () => { await cleanup() })

let phoneSeq = 0
async function addEnrollments(creatorId: string, courseId: string, n: number, extra: Record<string, any> = {}) {
  for (let i = 0; i < n; i++) {
    const phone = `8${String(Date.now()).slice(-8)}${phoneSeq++ % 10}`
    const { error } = await db().from('enrollments').insert({
      creator_id: creatorId, course_uuid: courseId, phone, payment_status: 'paid', amount_paid: 499, ...extra,
    })
    if (error) throw new Error(`enrollment seed failed: ${error.message}`)
    await new Promise((r) => setTimeout(r, 2)) // keep phones unique
  }
}

async function setAgreement(creatorId: string, terms: Record<string, any>) {
  await db().from('revenue_share_agreements').delete().eq('creator_id', creatorId)
  const { error } = await db().from('revenue_share_agreements').insert({ creator_id: creatorId, status: 'active', ...terms })
  if (error) throw new Error(`agreement seed failed: ${error.message}`)
}

test('new creator with no agreement and no students pays the standard 5%', async () => {
  const c = await createCreator()
  await db().from('revenue_share_agreements').delete().eq('creator_id', c.id)
  expect(await computeRevenueShareSplit(c.id, 1000)).toEqual({ platformFee: 50, creatorEarning: 950, ratePercent: 5 })
})

test('fee is rounded to whole rupees and the two parts always add up', async () => {
  const c = await createCreator()
  const a = await computeRevenueShareSplit(c.id, 999) // 49.95 -> 50
  expect(a.platformFee).toBe(50)
  expect(a.platformFee + a.creatorEarning).toBe(999)
  const b = await computeRevenueShareSplit(c.id, 10) // 0.5 -> 1
  expect(b.platformFee).toBe(1)
  expect(b.platformFee + b.creatorEarning).toBe(10)
})

test('rate switches to 6.5% only when paid students EXCEED the threshold', async () => {
  const c = await createCreator()
  const course = await createCourse(c.id)
  await setAgreement(c.id, { overflow_threshold_students: 2 })

  await addEnrollments(c.id, course.id, 2)
  expect((await computeRevenueShareSplit(c.id, 1000)).ratePercent).toBe(5) // exactly at threshold

  await addEnrollments(c.id, course.id, 1)
  expect(await computeRevenueShareSplit(c.id, 1000)).toEqual({ platformFee: 65, creatorEarning: 935, ratePercent: 6.5 })
})

test('pending and test enrollments do not count toward the threshold', async () => {
  const c = await createCreator()
  const course = await createCourse(c.id)
  await setAgreement(c.id, { overflow_threshold_students: 2 })
  await addEnrollments(c.id, course.id, 3, { payment_status: 'pending' })
  await addEnrollments(c.id, course.id, 3, { is_test: true })
  expect((await computeRevenueShareSplit(c.id, 1000)).ratePercent).toBe(5)
})

test('a custom agreement rate overrides the standard rate', async () => {
  const c = await createCreator()
  await setAgreement(c.id, { base_rate_percent: 3 })
  expect(await computeRevenueShareSplit(c.id, 1000)).toEqual({ platformFee: 30, creatorEarning: 970, ratePercent: 3 })
})

test('one creator\'s student count does not affect another creator\'s rate', async () => {
  const busy = await createCreator()
  const quiet = await createCreator()
  const course = await createCourse(busy.id)
  await setAgreement(busy.id, { overflow_threshold_students: 1 })
  await addEnrollments(busy.id, course.id, 3)
  expect((await computeRevenueShareSplit(busy.id, 1000)).ratePercent).toBe(6.5)
  expect((await computeRevenueShareSplit(quiet.id, 1000)).ratePercent).toBe(5)
})