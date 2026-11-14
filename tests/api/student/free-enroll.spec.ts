/**
 * API: free enrolment  (POST /api/free-enroll).
 *
 * Rules:
 *  - Only a published FREE course (or a 100% coupon) can be joined without paying.
 *  - Joining twice gives the same enrolment, one payment record, no duplicates.
 *  - Nobody can use this open endpoint to take over or edit ANOTHER person's student account.
 * Test students use the "kurso.test+buyer-" email prefix so factories.cleanup() removes them.
 */
import { test, expect } from '@playwright/test'
import crypto from 'crypto'
import { db } from '../../helpers/admin-db'
import { createCreator, createCourse, createStudent, cleanup } from '../../helpers/factories'
import { patch, trackCourse, cleanupStudentData } from '../../helpers/student-seed'

const URL = '/api/free-enroll'
const email = () => `kurso.test+buyer-${crypto.randomBytes(4).toString('hex')}@example.com`

let creator: any
let free: any
test.beforeAll(async () => {
  creator = await createCreator()
  free = await createCourse(creator.id)
  trackCourse(free.id)
    await patch('courses', free.id, { is_free_course: true, price: 0 })
})
test.afterAll(async () => { await cleanupStudentData(); await cleanup() })

const join = (request: any, data: object) => request.post(URL, { data })
const enrollmentsFor = async (courseId: string, studentId: string) =>
  (await db().from('enrollments').select('*').eq('course_uuid', courseId).eq('student_id', studentId)).data ?? []

/** An attacker who has just signed up: a real login (auth user) but no student row yet. */
async function freshLoginWithoutStudentRow() {
  const a = await createStudent()
  await db().from('students').delete().eq('id', a.id)
  return a
}

test.describe('who may join', () => {
  test('FREE-001 missing course id, or no contact detail, is a 400', async ({ request }) => {
    expect((await join(request, { studentEmail: email() })).status()).toBe(400)
    expect((await join(request, { courseId: free.id })).status()).toBe(400)
  })
  test('FREE-002 an unknown course is a 404', async ({ request }) => {
    expect((await join(request, { courseId: '00000000-0000-4000-8000-000000000000', studentEmail: email() })).status()).toBe(404)
  })
  test('FREE-003 an unpublished course is refused', async ({ request }) => {
    const draft = await createCourse(creator.id, { published: false })
    trackCourse(draft.id)
        await patch('courses', draft.id, { is_free_course: true, price: 0 })
    expect((await join(request, { courseId: draft.id, studentEmail: email() })).status()).toBe(403)
  })
  test('FREE-004 a PAID course cannot be joined for free', async ({ request }) => {
    const paid = await createCourse(creator.id, { price: 999 })
    trackCourse(paid.id)
    const res = await join(request, { courseId: paid.id, studentEmail: email() })
    expect(res.status()).toBe(400)
    const e = (await db().from('enrollments').select('id').eq('course_uuid', paid.id)).data ?? []
    expect(e).toHaveLength(0)
  })
})

test.describe('joining a free course', () => {
  test('FREE-010 creates a student, a paid ₹0 enrolment and a FREE payment record', async ({ request }) => {
    const e = email()
    const res = await join(request, { courseId: free.id, studentEmail: e, studentName: 'Free Learner', studentPhone: '9123456780' })
    expect(res.status()).toBe(200)
    const { enrollmentId } = await res.json()
    const enr = (await db().from('enrollments').select('*').eq('id', enrollmentId).single()).data!
    expect(enr).toMatchObject({ payment_status: 'paid', amount_paid: 0, payment_id: 'FREE', course_uuid: free.id, creator_id: creator.id })
    const pay = (await db().from('payments').select('*').eq('enrollment_id', enrollmentId)).data ?? []
    expect(pay).toHaveLength(1)
    expect(pay[0]).toMatchObject({ provider: 'FREE', status: 'paid', net_amount: 0, creator_earning: 0, platform_fee: 0 })
  })
  test('FREE-011 joining twice gives the SAME enrolment: no duplicate enrolment or payment row', async ({ request }) => {
    const e = email()
    const a = await (await join(request, { courseId: free.id, studentEmail: e, studentName: 'Twice' })).json()
    const b = await (await join(request, { courseId: free.id, studentEmail: e, studentName: 'Twice' })).json()
    expect(b.alreadyEnrolled).toBe(true)
    expect(b.enrollmentId).toBe(a.enrollmentId)
    expect((await db().from('payments').select('id').eq('enrollment_id', a.enrollmentId)).data).toHaveLength(1)
  })
  test('FREE-012 the same email typed in a different letter case is the SAME student', async ({ request }) => {
    const e = email()
    await join(request, { courseId: free.id, studentEmail: e, studentName: 'Case' })
    await join(request, { courseId: free.id, studentEmail: e.toUpperCase(), studentName: 'Case' })
    const students = (await db().from('students').select('id').ilike('email', e)).data ?? []
    expect(students, 'one person must not become two students').toHaveLength(1)
  })
  test('FREE-013 a refunded enrolment can be re-joined and works again', async ({ request }) => {
    const e = email()
    const a = await (await join(request, { courseId: free.id, studentEmail: e })).json()
    await patch('enrollments', a.enrollmentId, { payment_status: 'refunded' })
    const b = await (await join(request, { courseId: free.id, studentEmail: e })).json()
    expect(b.success).toBe(true)
    expect((await db().from('enrollments').select('payment_status').eq('id', a.enrollmentId).single()).data!.payment_status).toBe('paid')
  })
})

test.describe('account safety (the endpoint needs no login)', () => {
  test('FREE-020 knowing a student\'s email does NOT let someone attach their own login to that student', async ({ request }) => {
    const victim = await createStudent()
    const attacker = await freshLoginWithoutStudentRow()
    await join(request, { courseId: free.id, studentEmail: victim.email, studentId: attacker.auth_id })
    const after = (await db().from('students').select('auth_id').eq('id', victim.id).single()).data!
    expect(after.auth_id, 'victim must keep their own login').toBe(victim.auth_id)
  })
  test('FREE-021 nor can an anonymous caller rewrite that student\'s name or phone', async ({ request }) => {
    const victim = await createStudent()
    await join(request, { courseId: free.id, studentEmail: victim.email, studentName: 'Hacked Name', studentPhone: '9000000009' })
    const after = (await db().from('students').select('name, phone').eq('id', victim.id).single()).data!
    expect(after.name).toBe(victim.name)
    expect(after.phone).toBe(victim.phone)
  })
  test('FREE-022 the victim\'s paid enrolments stay out of the attacker\'s reach', async ({ request }) => {
    const victim = await createStudent()
    const attacker = await freshLoginWithoutStudentRow()
    await join(request, { courseId: free.id, studentEmail: victim.email, studentId: attacker.auth_id })
    const mine = await enrollmentsFor(free.id, victim.id)
    const { data: row } = await db().from('students').select('auth_id').eq('id', victim.id).single()
    expect(mine.length === 0 || row!.auth_id !== attacker.auth_id).toBe(true)
  })
})