/**
 * API: rule (c) "a refund removes access immediately" for the SIGNED-LINK doors (Telegram / WhatsApp).
 *  - /api/lesson/view          the lesson page opened from a Telegram link
 *  - /api/whatsapp/my-courses  the course list opened from a WhatsApp link
 * Each test has a CONTROL: the same link for a PAID student must work. If the control fails the test
 * says so, so a refusal can never be mistaken for "the refund rule works".
 * Links are forged exactly like src/lib/signer.ts (HMAC-SHA256 hex of the payload, secret LESSON_LINK_SECRET).
 */
import { test, expect } from '@playwright/test'
import crypto from 'crypto'
import { need } from '../../helpers/env'
import { cleanup } from '../../helpers/factories'
import { seedScenario, newPaidStudent, cleanupStudentData } from '../../helpers/student-seed'

const hmac = (payload: string) => crypto.createHmac('sha256', need('LESSON_LINK_SECRET')).update(payload).digest('hex')

function lessonPageLink(courseId: string, lessonId: string, identity: string) {
  const exp = Date.now() + 10 * 60_000
  const sig = hmac(`lesson.${courseId}.${lessonId}.1.${identity}.${exp}`)
  return `/api/lesson/view?${new URLSearchParams({ courseId, lessonId, lesson: '1', identity, exp: String(exp), sig })}`
}
function myCoursesLink(identity: string) {
  const exp = Date.now() + 10 * 60_000
  const sig = hmac(`mycourses.${identity}.${exp}`)
  return `/api/whatsapp/my-courses?${new URLSearchParams({ identity, exp: String(exp), sig })}`
}

let s: Awaited<ReturnType<typeof seedScenario>>
test.beforeAll(async () => { s = await seedScenario() })
test.afterAll(async () => { await cleanupStudentData(); await cleanup() })

test.describe('Telegram lesson page', () => {
  test('RFL-001 CONTROL: a paying student with a valid link opens the lesson page', async ({ request }) => {
    const chat = `tg_${Date.now()}`
    await newPaidStudent(s.course.id, s.creator.id, { telegramChatId: chat })
    const res = await request.get(lessonPageLink(s.course.id, s.lesson.id, chat))
    expect(res.status(), 'control failed: a paid student must get the page (check LESSON_LINK_SECRET)').toBe(200)
  })
  test('RFL-002 a REFUNDED student with a still-valid link is refused (403) and sees no lesson content', async ({ request }) => {
    const chat = `tg_${Date.now()}_r`
    await newPaidStudent(s.course.id, s.creator.id, { telegramChatId: chat, status: 'refunded' })
    const res = await request.get(lessonPageLink(s.course.id, s.lesson.id, chat))
    expect(res.status()).toBe(403)
    expect(await res.text()).not.toContain(s.lesson.title)
  })
})

test.describe('WhatsApp my-courses list', () => {
  test('RFL-010 CONTROL: a paying student sees the course in the list', async ({ request }) => {
    const { student } = await newPaidStudent(s.course.id, s.creator.id)
    const body = await (await request.get(myCoursesLink(student.phone))).json()
    expect(body.valid, 'control failed: link not accepted').toBe(true)
    expect(body.courses.map((c: any) => c.courseId), 'control failed: paid course missing').toContain(s.course.id)
  })
  test('RFL-011 a REFUNDED student does not see the refunded course in the list', async ({ request }) => {
    const { student } = await newPaidStudent(s.course.id, s.creator.id, { status: 'refunded' })
    const body = await (await request.get(myCoursesLink(student.phone))).json()
    expect(body.valid).toBe(true)
    expect(body.courses.map((c: any) => c.courseId)).not.toContain(s.course.id)
  })
})