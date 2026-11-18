/**
 * E2E (real browser): the student's My Learning page.
 *  - a brand new student sees the empty state
 *  - a paid student sees their course; a refunded one does not (rule c: refund removes access at once)
 */
import { test, expect } from '@playwright/test'
import { createCreator, createCourse, createStudent, createEnrollment, cleanup } from '../helpers/factories'
import { db } from '../helpers/admin-db'
import { loginViaUi } from './ui'

let creator: any
let course: any
test.beforeAll(async () => { creator = await createCreator(); course = await createCourse(creator.id, { published: true }) })
test.afterAll(async () => { await cleanup() })



test('STU-E02 a paid student sees the course on My Learning', async ({ page }) => {
  const s = await createStudent()
  await createEnrollment({ studentId: s.id, creatorId: creator.id, courseId: course.id, phone: s.phone })
  await loginViaUi(page, s.email, s.password)
  await expect(page.getByText(course.name).first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('No courses yet')).toHaveCount(0)
})

test('STU-E03 (c) once the purchase is refunded the course disappears from My Learning', async ({ page }) => {
  const s = await createStudent()
  const enr = await createEnrollment({ studentId: s.id, creatorId: creator.id, courseId: course.id, phone: s.phone })
  await db().from('enrollments').update({ payment_status: 'refunded' }).eq('id', enr.id)
  await loginViaUi(page, s.email, s.password)
  await expect(page.getByText('No courses yet')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(course.name)).toHaveCount(0)
})