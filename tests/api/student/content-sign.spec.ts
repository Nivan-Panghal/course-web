/**
 * API: getting a signed video/PDF link  (POST /api/content/sign)  + the module release lock (drip).
 *
 * Rules:
 *  - Only a PAID enrollment (or a free lesson / free course) gets a signed link.
 *    Pending, refunded, other-course and no-login all get 403.
 *  - A lesson in a module that has not opened yet is refused with reason 'module_locked'
 *    and the exact unlock time. Free lessons are never held back.
 *  - A missing release rule never locks a paying student out.
 */
import { test, expect } from '@playwright/test'
import { accessToken } from '../../helpers/clients'
import { createLesson, cleanup } from '../../helpers/factories'
import { seedScenario, newPaidStudent, dripCourse, patch, daysAgoISO, daysAheadISO, cleanupStudentData } from '../../helpers/student-seed'

const URL = '/api/content/sign'
let sc: Awaited<ReturnType<typeof seedScenario>>

test.beforeAll(async () => { sc = await seedScenario() })
test.afterAll(async () => { await cleanupStudentData(); await cleanup() })

async function sign(request: any, lessonId: string, who?: { email: string; password: string }, type = 'video') {
  const headers = who ? { authorization: `Bearer ${await accessToken(who.email, who.password)}` } : {}
  return request.post(URL, { data: { lessonId, type }, headers })
}

test.describe('who gets a link', () => {
  test('SIGN-001 missing fields is a 400', async ({ request }) => {
    expect((await request.post(URL, { data: { type: 'video' } })).status()).toBe(400)
    expect((await request.post(URL, { data: { lessonId: sc.lesson.id } })).status()).toBe(400)
  })
  test('SIGN-002 a paid student gets a video link that points at the proxy, not at storage', async ({ request }) => {
    const res = await sign(request, sc.lesson.id, sc.student)
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.url).toContain('/api/video/stream')
    expect(body.url).not.toMatch(/r2\.cloudflarestorage|supabase\.co\/storage/)
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now())
  })
  test('SIGN-003 type "pdf" gives a PDF-viewer link', async ({ request }) => {
    const body = await (await sign(request, sc.lesson.id, sc.student, 'pdf')).json()
    expect(body.url).toContain('/api/pdf/view')
  })
  test('SIGN-004 a visitor with no login is refused (403 no_access)', async ({ request }) => {
    const res = await sign(request, sc.lesson.id)
    expect(res.status()).toBe(403)
    expect((await res.json()).reason).toBe('no_access')
  })
  test('SIGN-005 a logged-in student who never enrolled is refused', async ({ request }) => {
    expect((await sign(request, sc.lesson.id, sc.stranger)).status()).toBe(403)
  })
  test('SIGN-006 a PENDING enrollment is refused', async ({ request }) => {
    const p = await newPaidStudent(sc.course.id, sc.creator.id, { status: 'pending' })
    expect((await sign(request, sc.lesson.id, p.student)).status()).toBe(403)
  })
  test('SIGN-007 a REFUNDED enrollment is refused straight away (rule c)', async ({ request }) => {
    const p = await newPaidStudent(sc.course.id, sc.creator.id)
    expect((await sign(request, sc.lesson.id, p.student)).status()).toBe(200)
    await patch('enrollments', p.enrollment.id, { payment_status: 'refunded' })
    expect((await sign(request, sc.lesson.id, p.student)).status()).toBe(403)
  })
  test('SIGN-008 a payment that arrives AFTER the course was paused still grants access (rule b)', async ({ request }) => {
    await patch('courses', sc.course.id, { is_published: false, auto_unpublished_reason: 'revenue_share_overdue' })
    const p = await newPaidStudent(sc.course.id, sc.creator.id)
    const res = await sign(request, sc.lesson.id, p.student)
    await patch('courses', sc.course.id, { is_published: true, auto_unpublished_reason: null })
    expect(res.status()).toBe(200)
  })
  test('SIGN-009 a student paid for a different course is refused', async ({ request }) => {
    const other = await dripCourse(sc.creator.id, 'all_at_once')
    const p = await newPaidStudent(other.course.id, sc.creator.id)
    expect((await sign(request, sc.lesson.id, p.student)).status()).toBe(403)
  })
  test('SIGN-010 a FREE lesson needs no login', async ({ request }) => {
    expect((await sign(request, sc.freeLesson.id)).status()).toBe(200)
  })
  test('SIGN-011 an unpublished or unknown lesson is a 404', async ({ request }) => {
    const draft = await createLesson(sc.course.id, sc.creator.id, { order: 9, published: false })
    expect((await sign(request, draft.id, sc.student)).status()).toBe(404)
    expect((await sign(request, '00000000-0000-4000-8000-000000000000', sc.student)).status()).toBe(404)
  })
})

test.describe('module release lock (drip)', () => {
  test('SIGN-020 per-student drip: locked until N days after enrolling, with the exact unlock time', async ({ request }) => {
    const d = await dripCourse(sc.creator.id, 'per_student_drip', { unlockAfterDays: 7 })
    const p = await newPaidStudent(d.course.id, sc.creator.id) // enrolled just now
    const res = await sign(request, d.lesson.id, p.student)
    expect(res.status()).toBe(403)
    const body = await res.json()
    expect(body.reason).toBe('module_locked')
    expect(body.moduleName).toBe(d.module.name)
    const hoursAway = (new Date(body.unlockAt).getTime() - Date.now()) / 3_600_000
    expect(hoursAway).toBeGreaterThan(6 * 24) // about 7 days away, never less than 6
    expect(hoursAway).toBeLessThan(8 * 24)
  })
  test('SIGN-021 per-student drip: opens once the student is past the wait', async ({ request }) => {
    const d = await dripCourse(sc.creator.id, 'per_student_drip', { unlockAfterDays: 7 })
    const p = await newPaidStudent(d.course.id, sc.creator.id, { enrolledAt: daysAgoISO(10) })
    expect((await sign(request, d.lesson.id, p.student)).status()).toBe(200)
  })
  test('SIGN-022 per-student drip: two students of one course get different unlock moments', async ({ request }) => {
    const d = await dripCourse(sc.creator.id, 'per_student_drip', { unlockAfterDays: 7 })
    const early = await newPaidStudent(d.course.id, sc.creator.id, { enrolledAt: daysAgoISO(9) })
    const late = await newPaidStudent(d.course.id, sc.creator.id, { enrolledAt: daysAgoISO(2) })
    expect((await sign(request, d.lesson.id, early.student)).status()).toBe(200)
    expect((await sign(request, d.lesson.id, late.student)).status()).toBe(403)
  })
  test('SIGN-023 fixed calendar: locked before the date, open after it, same for everyone', async ({ request }) => {
    const future = await dripCourse(sc.creator.id, 'fixed_calendar', { unlockDate: daysAheadISO(30) })
    const past = await dripCourse(sc.creator.id, 'fixed_calendar', { unlockDate: daysAgoISO(30) })
    const a = await newPaidStudent(future.course.id, sc.creator.id, { enrolledAt: daysAgoISO(100) })
    const b = await newPaidStudent(past.course.id, sc.creator.id)
    const locked = await sign(request, future.lesson.id, a.student)
    expect(locked.status()).toBe(403)
    expect((await locked.json()).reason).toBe('module_locked')
    expect((await sign(request, past.lesson.id, b.student)).status()).toBe(200)
  })
  test('SIGN-024 all-at-once ignores any module dates', async ({ request }) => {
    const d = await dripCourse(sc.creator.id, 'all_at_once', { unlockDate: daysAheadISO(30), unlockAfterDays: 30 })
    const p = await newPaidStudent(d.course.id, sc.creator.id)
    expect((await sign(request, d.lesson.id, p.student)).status()).toBe(200)
  })
  test('SIGN-025 a module with NO release rule never locks a paying student out', async ({ request }) => {
    const d = await dripCourse(sc.creator.id, 'per_student_drip', { unlockAfterDays: null })
    const p = await newPaidStudent(d.course.id, sc.creator.id)
    expect((await sign(request, d.lesson.id, p.student)).status()).toBe(200)
  })
  test('SIGN-026 a FREE lesson inside a locked module stays open', async ({ request }) => {
    const d = await dripCourse(sc.creator.id, 'per_student_drip', { unlockAfterDays: 30 }, { isFree: true })
    const p = await newPaidStudent(d.course.id, sc.creator.id)
    expect((await sign(request, d.lesson.id, p.student)).status()).toBe(200)
  })
})