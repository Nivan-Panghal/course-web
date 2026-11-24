/**
 * API security: POST /api/telegram|whatsapp/create-token.
 * The bots mark an enrollment PAID when the start token carries a payment id, and the token decides
 * WHICH student gets linked. So neither may come from what the browser says:
 *  - "paid" comes from a real paid enrollment on that course (CTT-001/002/005/006/007/008)
 *  - the creator on the token is always the course owner (CTT-003); an unknown course is a 404 (CTT-004)
 *  - a logged-in student can only get their OWN link; someone with a web account cannot be asked for
 *    without signing in; people with NO web account (imported students) can still ask (CTA-001..006)
 */
import crypto from 'crypto'
import { test, expect } from '@playwright/test'
import { db } from '../../helpers/admin-db'
import { accessToken } from '../../helpers/clients'
import { createCreator, createCourse, createStudent, createEnrollment, cleanup } from '../../helpers/factories'

const hex = () => crypto.randomBytes(4).toString('hex')
const bearer = async (u: { email: string; password: string }) => ({ authorization: `Bearer ${await accessToken(u.email, u.password)}` })
const randPhone = () => '9' + String(Date.now()).slice(-8) + String(Math.floor(Math.random() * 10))

let owner: any, rival: any, course: any, otherCourse: any
let paidStudent: any, paidPaymentId: string, freeStudent: any
let phoneOnly: any, phoneOnlyPhone: string, migratedEmail: string
const looseStudents: string[] = []

async function looseStudent(values: Record<string, unknown>) {
  const { data, error } = await db().from('students').insert({ name: 'Imported Student', ...values }).select().single()
  if (error) throw new Error(`student: ${error.message}`)
  looseStudents.push(data.id)
  return data
}

test.beforeAll(async () => {
  owner = await createCreator()
  rival = await createCreator()
  course = await createCourse(owner.id)
  otherCourse = await createCourse(owner.id)

  // registered students (have a web login)
  paidStudent = await createStudent()
  paidPaymentId = `pay_ctt_${hex()}`
  const e1 = await createEnrollment({ studentId: paidStudent.id, creatorId: owner.id, courseId: course.id, phone: paidStudent.phone })
  await db().from('enrollments').update({ payment_id: paidPaymentId }).eq('id', e1.id)

  freeStudent = await createStudent()
  const e3 = await createEnrollment({ studentId: freeStudent.id, creatorId: owner.id, courseId: otherCourse.id, phone: freeStudent.phone })
  await db().from('enrollments').update({ payment_id: 'FREE' }).eq('id', e3.id)

  // imported students (NO web login): one with a phone, one with only an email
  phoneOnlyPhone = randPhone()
  phoneOnly = await looseStudent({ phone: phoneOnlyPhone })
  const e2 = await createEnrollment({ studentId: phoneOnly.id, creatorId: owner.id, courseId: course.id, phone: phoneOnlyPhone })
  await db().from('enrollments').update({ payment_id: `MIGRATED:${course.id}:${phoneOnlyPhone}` }).eq('id', e2.id)

  migratedEmail = `kurso.test+ctt-mig-${hex()}@example.com`
  const mig = await looseStudent({ email: migratedEmail })
  const e4 = await createEnrollment({ studentId: mig.id, creatorId: owner.id, courseId: course.id, phone: migratedEmail })
  await db().from('enrollments').update({ payment_id: `MIGRATED:${course.id}:${migratedEmail}` }).eq('id', e4.id)
})
test.afterAll(async () => {
  for (const t of ['telegram_tokens', 'whatsapp_tokens']) {
    await db().from(t).delete().eq('creator_id', owner.id)
    await db().from(t).delete().eq('creator_id', rival.id)
  }
  if (looseStudents.length) {
    await db().from('enrollments').delete().in('student_id', looseStudents)
    await db().from('students').delete().in('id', looseStudents)
  }
  await cleanup()
})

for (const p of [
  { name: 'telegram', table: 'telegram_tokens', courseCol: 'course_id' },
  { name: 'whatsapp', table: 'whatsapp_tokens', courseCol: 'course_slug' },
]) {
  const URL = `/api/${p.name}/create-token`
  const email = () => `kurso.test+ctt-${hex()}@example.com`
  const stored = async (token: string) => (await db().from(p.table).select('*').eq('token', token).single()).data
  const make = (request: any, data: object, headers: object = {}) =>
    request.post(URL, { headers, data: { courseId: course.id, ...data } })

  test.describe(`${p.name} create-token`, () => {
    test(`CTT-001 (${p.name}) a made-up payment id is not stored`, async ({ request }) => {
      const res = await make(request, { studentEmail: email(), paymentId: 'totally-fake' })
      expect(res.status()).toBe(200)
      expect((await stored((await res.json()).token)).payment_id).toBeNull()
    })
    test(`CTT-002 (${p.name}) a real paid student, signed in, keeps the paid flag with the enrollment's own payment id`, async ({ request }) => {
      const res = await make(request, { paymentId: 'whatever-the-browser-says' }, await bearer(paidStudent))
      expect(res.status()).toBe(200)
      expect((await stored((await res.json()).token)).payment_id).toBe(paidPaymentId)
    })
    test(`CTT-003 (${p.name}) the creator on the token is the course owner, not what the browser sent`, async ({ request }) => {
      const res = await make(request, { studentEmail: email(), creatorId: rival.id })
      expect(res.status()).toBe(200)
      expect((await stored((await res.json()).token)).creator_id).toBe(owner.id)
    })
    test(`CTT-004 (${p.name}) an unknown course is a 404`, async ({ request }) => {
      const res = await make(request, { studentEmail: email(), courseId: '00000000-0000-4000-8000-000000000000' })
      expect(res.status()).toBe(404)
    })
    test(`CTT-005 (${p.name}) an imported student with a phone (no web login) keeps the paid flag`, async ({ request }) => {
      const res = await make(request, { studentPhone: phoneOnlyPhone })
      expect(res.status()).toBe(200)
      expect((await stored((await res.json()).token)).payment_id).toBe(`MIGRATED:${course.id}:${phoneOnlyPhone}`)
    })
    test(`CTT-006 (${p.name}) being paid on ANOTHER course does not make this token paid`, async ({ request }) => {
      const res = await make(request, { paymentId: 'FREE' }, await bearer(freeStudent))
      expect(res.status()).toBe(200)
      expect((await stored((await res.json()).token)).payment_id).toBeNull()
    })
    test(`CTT-007 (${p.name}) an imported student with only an email keeps the paid flag`, async ({ request }) => {
      const res = await make(request, { studentEmail: migratedEmail })
      expect(res.status()).toBe(200)
      expect((await stored((await res.json()).token)).payment_id).toBe(`MIGRATED:${course.id}:${migratedEmail}`)
    })
    test(`CTT-008 (${p.name}) a free enrolment keeps the paid flag, so live-class reminders keep working`, async ({ request }) => {
      const res = await make(request, { courseId: otherCourse.id, paymentId: 'FREE' }, await bearer(freeStudent))
      expect(res.status()).toBe(200)
      expect((await stored((await res.json()).token)).payment_id).toBe('FREE')
    })

    test(`CTA-001 (${p.name}) someone with a web account cannot be asked for without signing in (401), and nothing is created`, async ({ request }) => {
      const count = async () => ((await db().from(p.table).select('token').eq('student_email', paidStudent.email)).data ?? []).length
      const before = await count()
      const res = await make(request, { studentEmail: paidStudent.email })
      expect(res.status()).toBe(401)
      expect(await count()).toBe(before)
    })
    test(`CTA-002 (${p.name}) a broken or expired login is a 401`, async ({ request }) => {
      const res = await make(request, { studentEmail: email() }, { authorization: 'Bearer not-a-real-token' })
      expect(res.status()).toBe(401)
    })
    test(`CTA-003 (${p.name}) a logged-in student cannot get ANOTHER student's link, even by asking with their email`, async ({ request }) => {
      const victim = await (await make(request, {}, await bearer(paidStudent))).json()
      const res = await make(request, { studentEmail: paidStudent.email }, await bearer(freeStudent))
      expect(res.status()).toBe(200)
      const mine = await res.json()
      expect(mine.token).not.toBe(victim.token)
      expect(await stored(mine.token)).toMatchObject({ student_email: freeStudent.email, student_auth_id: freeStudent.auth_id })
    })
    test(`CTA-004 (${p.name}) a phone number that belongs to a web account is also refused without signing in`, async ({ request }) => {
      const res = await make(request, { studentPhone: paidStudent.phone })
      expect(res.status()).toBe(401)
    })
    test(`CTA-005 (${p.name}) the course owner, logged in, can make a test student's link`, async ({ request }) => {
      const e = email()
      const res = await make(request, { studentEmail: e, studentPhone: randPhone() }, await bearer(owner))
      expect(res.status()).toBe(200)
      expect(await stored((await res.json()).token)).toMatchObject({ student_email: e, creator_id: owner.id })
    })
    test(`CTA-006 (${p.name}) another creator is treated as an ordinary user: they only get their own link, never paid`, async ({ request }) => {
      const res = await make(request, { studentEmail: paidStudent.email }, await bearer(rival))
      expect(res.status()).toBe(200)
      const row = await stored((await res.json()).token)
      expect(row).toMatchObject({ student_email: rival.email.toLowerCase(), student_auth_id: rival.id })
      expect(row.payment_id).toBeNull()
    })
  })
}