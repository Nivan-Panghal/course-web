/**
 * E2E (real browser): signing in, wrong password, sign-out and who is sent where.
 *  - a student lands on My Learning, a creator on the dashboard
 *  - a visitor with no session is sent to the login page
 *  - a student cannot sit on the creator dashboard
 */
import { test, expect } from '@playwright/test'
import { createCreator, createCourse, createEnrollment, createStudent, cleanup } from '../helpers/factories'
import { loginViaUi, expectPath } from './ui'

let creator: any
let student: any
// Students only exist in Kurso once they have enrolled in a course, so ours is enrolled.
test.beforeAll(async () => {
  creator = await createCreator()
  student = await createStudent()
  const course = await createCourse(creator.id, { published: true })
  await createEnrollment({ studentId: student.id, creatorId: creator.id, courseId: course.id, phone: student.phone })
})
test.afterAll(async () => { await cleanup() })

test('AUTH-E01 a visitor with no session is sent to login from My Learning and the dashboard', async ({ page }) => {
  await page.goto('/my-courses')
  await expectPath(page, '/login')
  await page.goto('/dashboard')
  await expectPath(page, '/login')
})

test('AUTH-E02 a wrong password shows an error and keeps you on the login page', async ({ page }) => {
  await page.goto('/login')
  await page.getByPlaceholder('you@example.com').fill(student.email)
  await page.getByPlaceholder('Your password').fill('definitely-wrong-password')
  await page.getByRole('button', { name: 'Sign In', exact: true }).last().click()
  await expect(page.getByText(/invalid login credentials/i)).toBeVisible({ timeout: 20_000 })
  await expectPath(page, '/login')
})

test('AUTH-E03 an enrolled student signs in and lands on My Learning', async ({ page }) => {
  await loginViaUi(page, student.email, student.password)
  await expectPath(page, '/my-courses')
  await expect(page.getByRole('heading', { name: 'My Learning' })).toBeVisible()
})

test('AUTH-E04 a creator signs in and lands on the dashboard', async ({ page }) => {
  await loginViaUi(page, creator.email, creator.password)
  await expectPath(page, '/dashboard')
})

test('AUTH-E05 a signed-in enrolled student is turned away from the creator dashboard', async ({ page }) => {
  await loginViaUi(page, student.email, student.password)
  await page.goto('/dashboard')
  await expectPath(page, '/my-courses')
})

test('AUTH-E06 a signed-in creator who opens My Learning is sent to the dashboard', async ({ page }) => {
  await loginViaUi(page, creator.email, creator.password)
  await page.goto('/my-courses')
  await expectPath(page, '/dashboard')
})

test('AUTH-E07 a creator signing out is sent away from the dashboard and cannot go back in', async ({ page }) => {
  await loginViaUi(page, creator.email, creator.password)
  await expectPath(page, '/dashboard')
  await page.getByRole('button', { name: 'Sign out' }).first().click()
  await expectPath(page, '/login')
  await page.goto('/dashboard')
  await expectPath(page, '/login')
})

test('AUTH-E08 the Sign Up tab shows the name field and the forgot-password link works', async ({ page }) => {
  await page.goto('/login')
  await page.getByRole('button', { name: 'Sign Up', exact: true }).click()
  await expect(page.getByPlaceholder('Full name or username')).toBeVisible()
  await expect(page.getByPlaceholder('Min 8 characters')).toBeVisible()
  await page.getByRole('button', { name: 'Sign In', exact: true }).first().click()
  await page.getByText(/forgot/i).first().click()
  await expect(page.getByPlaceholder('you@example.com')).toBeVisible()
})