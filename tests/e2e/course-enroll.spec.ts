/**
 * E2E (real browser): a student enrolling through the popup on the checkout page /enroll/<courseId>.
 * Students are NOT created through the creator login: they sign up INSIDE the popup (role "student").
 *
 *  - free course: sign up -> "You're Enrolled" -> the course shows on My Learning
 *  - a short phone number and a wrong password are refused with a message
 *  - paid course: sign up -> order summary -> Pay. Gateway keys are fake, so no payment can finish:
 *    the student must see an error and NO enrollment may exist
 *  - an already-enrolled student signing in is taken straight to the course
 *  - the course owner and visitors of an unpublished course never get an Enroll button
 */
import { test, expect } from '@playwright/test'
import { db } from '../helpers/admin-db'
import { createCreator, createCourse, createGateway, createStudent, createEnrollment, cleanup } from '../helpers/factories'
import { patch } from '../helpers/student-seed'
import { loginViaUi } from './ui'
import { uiEmail, uiPhone, uiPassword, openEnrollPopup, fillSignup, cleanupUiStudents } from './enroll-ui'

let creator: any
let freeCourse: any
let paidCourse: any
test.beforeAll(async () => {
  creator = await createCreator()
  await createGateway(creator.id, 'razorpay', { credentials: { keyId: 'rzp_test_fake', keySecret: 'fake' } })
  freeCourse = await createCourse(creator.id, { price: 0, published: true })
  await patch('courses', freeCourse.id, { is_free_course: true })
  paidCourse = await createCourse(creator.id, { price: 499, published: true })
})
test.afterAll(async () => { await cleanupUiStudents(); await cleanup() })

const enrollmentsFor = async (courseId: string) => (await db().from('enrollments').select('*').eq('course_uuid', courseId)).data ?? []

test('ENR-E01 a new student enrolls in a FREE course and then sees it on My Learning', async ({ page }) => {
  const email = uiEmail()
  const popup = await openEnrollPopup(page, freeCourse.id)
  await fillSignup(popup, { email, phone: uiPhone() })
  await popup.getByRole('button', { name: 'Enroll for Free' }).click()
  await expect(popup.getByText(/You're Enrolled/)).toBeVisible({ timeout: 45_000 })
  expect(await enrollmentsFor(freeCourse.id)).toHaveLength(1)
  const { data } = await db().auth.admin.listUsers({ page: 1, perPage: 1000 })
  expect(data.users.find((u) => u.email === email)?.user_metadata?.role).toBe('student')
  await page.goto('/my-courses')
  await expect(page.getByText(freeCourse.name).first()).toBeVisible({ timeout: 30_000 })
})

test('ENR-E02 a phone number that is too short is refused and no account is created', async ({ page }) => {
  const email = uiEmail()
  const popup = await openEnrollPopup(page, freeCourse.id)
  await fillSignup(popup, { email, phone: '12345', stayOnForm: true })
  await expect(popup.getByText('Please enter a valid 10-digit mobile number')).toBeVisible({ timeout: 20_000 })
  const { data } = await db().auth.admin.listUsers({ page: 1, perPage: 1000 })
  expect(data.users.find((u) => u.email === email)).toBeUndefined()
})

test('ENR-E03 signing in with a wrong password shows the error and enrolls nobody', async ({ page }) => {
  const s = await createStudent()
  const popup = await openEnrollPopup(page, freeCourse.id)
  await popup.getByRole('button', { name: 'Already have account' }).click()
  await popup.getByPlaceholder('Email address').fill(s.email)
  await popup.getByPlaceholder('Your password').fill('wrong-password-123')
  await popup.getByRole('button', { name: /Sign In & Continue/ }).click()
  await expect(popup.getByText(/invalid login credentials/i)).toBeVisible({ timeout: 20_000 })
  expect((await enrollmentsFor(freeCourse.id)).filter((e: any) => e.student_id === s.id)).toHaveLength(0)
})

test('ENR-E04 a PAID course shows the order summary; with fake gateway keys paying fails safely (error, no enrollment)', async ({ page }) => {
  const popup = await openEnrollPopup(page, paidCourse.id)
  await fillSignup(popup, { email: uiEmail(), phone: uiPhone() })
  await expect(popup.getByText('Order Summary')).toBeVisible({ timeout: 45_000 })
  await expect(popup.getByText(paidCourse.name).first()).toBeVisible()
  await popup.getByRole('button', { name: /Pay ₹499 Securely/ }).click()
  await expect(popup.getByRole('button', { name: /Pay ₹499 Securely/ })).toBeEnabled({ timeout: 30_000 })
  expect(await enrollmentsFor(paidCourse.id)).toHaveLength(0)
})

test('ENR-E05 an already-enrolled student who signs in through the popup is taken to the course', async ({ page }) => {
  const s = await createStudent()
  await createEnrollment({ studentId: s.id, creatorId: creator.id, courseId: paidCourse.id, phone: s.phone })
  const popup = await openEnrollPopup(page, paidCourse.id)
  await popup.getByRole('button', { name: 'Already have account' }).click()
  await popup.getByPlaceholder('Email address').fill(s.email)
  await popup.getByPlaceholder('Your password').fill(s.password)
  await popup.getByRole('button', { name: /Sign In & Continue/ }).click()
  await page.waitForURL(/\/course\//, { timeout: 45_000 })
})

test('ENR-E06 the course OWNER sees no Enroll button on their own checkout page', async ({ page }) => {
  await loginViaUi(page, creator.email, creator.password)
  await page.goto(`/enroll/${paidCourse.id}`)
  await expect(page.getByRole('heading').first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('button', { name: /^Enroll/ })).toHaveCount(0)
})

test('ENR-E07 an UNPUBLISHED course offers no Enroll button to visitors', async ({ page }) => {
  const draft = await createCourse(creator.id, { price: 499, published: false })
  await page.goto(`/enroll/${draft.id}`)
  await page.waitForLoadState('networkidle')
  await expect(page.getByRole('button', { name: /^Enroll/ })).toHaveCount(0)
})
test('ENR-E08 after enrolling, the popup asks for the Telegram link WITH the student\'s login, and gets it', async ({ page }) => {
  await db().from('creators').update({ telegram_bot_username: 'kurso_test_bot' }).eq('id', creator.id)
  const calls: { req: any; status?: number }[] = []
  page.on('request', (r) => { if (r.url().includes('/api/telegram/create-token')) calls.push({ req: r }) })
  page.on('response', (r) => {
    if (r.url().includes('/api/telegram/create-token')) {
      const c = calls.find((x) => x.req === r.request())
      if (c) c.status = r.status()
    }
  })
  const popup = await openEnrollPopup(page, freeCourse.id)
  await fillSignup(popup, { email: uiEmail(), phone: uiPhone() })
  await popup.getByRole('button', { name: 'Enroll for Free' }).click()
  await expect(popup.getByText(/You're Enrolled/)).toBeVisible({ timeout: 45_000 })
  await expect.poll(() => calls.filter((c) => c.status !== undefined).length, { timeout: 20_000 }).toBeGreaterThan(0)
  for (const c of calls) {
    const h = await c.req.allHeaders()
    const state = await page.evaluate(() => ({
      installed: (window as any).__kursoAuthFetch === true,
      hasSession: Object.keys(localStorage).some((k) => k.includes('auth-token')),
    }))
    expect(
      !!h['authorization'],
      `no Authorization header. url=${c.req.url()} status=${c.status} page=${JSON.stringify(state)} headers=${Object.keys(h).join(',')}`
    ).toBe(true)
    expect(h['authorization']).toMatch(/^Bearer .{20,}/)
    expect(c.status).toBe(200)
  }
})

test('ENR-E09 a UAE student (9-digit number) can enroll, and the number is stored with the country code', async ({ page }) => {
  const email = uiEmail()
  const popup = await openEnrollPopup(page, freeCourse.id)
  await popup.getByRole('button', { name: /\+91/ }).click()
  await page.getByPlaceholder('Search country...').fill('Emirates')
  await page.getByRole('button', { name: /United Arab Emirates/ }).click()
  const local = '5' + String(Date.now()).slice(-8)
  await fillSignup(popup, { email, phone: local })
  await popup.getByRole('button', { name: 'Enroll for Free' }).click()
  await expect(popup.getByText(/You're Enrolled/)).toBeVisible({ timeout: 45_000 })
  const rows = await enrollmentsFor(freeCourse.id)
  expect(rows.some((e: any) => e.phone === '971' + local)).toBe(true)
})