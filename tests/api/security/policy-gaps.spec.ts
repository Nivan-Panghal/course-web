/**
 * SECURITY: gaps that the row policies might leave open. Each test acts as a real signed-in user through the
 * public database API and then re-reads the result as admin. CONTROL tests prove the setup works, so a
 * "blocked" result can never be a broken test.
 * If a test FAILS it is a real finding (do not "fix the test"):
 *  - LES: a creator puts lessons into, or moves a lesson to, ANOTHER creator's course
 *  - COU: a creator attaches a coupon to ANOTHER creator's course and it works there
 *  - PHN: a student claims someone else's phone number and reads that person's enrollment
 *  - CRE: a creator changes their own plan
 */
import { test, expect } from '@playwright/test'
import { db } from '../../helpers/admin-db'
import { anonClient, signedInClient, visibleRows } from '../../helpers/clients'
import { createCreator, createCourse, createLesson, createStudent, createEnrollment, cleanup } from '../../helpers/factories'

let A: any, B: any, S1: any, S2: any, courseA: any, courseB: any, lessonA: any, enrollment: any
test.beforeAll(async () => {
  A = await createCreator()
  B = await createCreator()
  S1 = await createStudent()
  S2 = await createStudent()
  courseA = await createCourse(A.id)
  courseB = await createCourse(B.id)
  lessonA = await createLesson(courseA.id, A.id, { order: 1 })
  enrollment = await createEnrollment({ studentId: S1.id, creatorId: B.id, courseId: courseB.id, phone: S1.phone })
})
test.afterAll(async () => {
  await db().from('coupons').delete().in('creator_id', [A.id, B.id])
  await cleanup()
})

const lessonRow = (title: string) => db().from('lessons').select('id, course_id').eq('title', title)
const newLesson = (courseId: string, creatorId: string, title: string) => ({
  course_id: courseId, creator_id: creatorId, title, order_num: 90, content_type: 'video', is_published: true,
})

test.describe('lessons', () => {
  test('LES-000 CONTROL: a creator can add a lesson to their OWN course', async () => {
    const a = await signedInClient(A.email, A.password)
    const title = `own-lesson-${Date.now()}`
    const res = await a.from('lessons').insert(newLesson(courseA.id, A.id, title))
    expect(res.error, 'control failed: own insert must work').toBeNull()
    expect((await lessonRow(title)).data).toHaveLength(1)
  })
  test('LES-001 a creator cannot put a lesson into ANOTHER creator\'s course', async () => {
    const a = await signedInClient(A.email, A.password)
    const title = `sneaky-lesson-${Date.now()}`
    await a.from('lessons').insert(newLesson(courseB.id, A.id, title))
    expect((await lessonRow(title)).data?.filter((r: any) => r.course_id === courseB.id)).toHaveLength(0)
  })
  test('LES-002 a creator cannot MOVE their lesson into ANOTHER creator\'s course', async () => {
    const a = await signedInClient(A.email, A.password)
    await a.from('lessons').update({ course_id: courseB.id }).eq('id', lessonA.id)
    const row = (await db().from('lessons').select('course_id').eq('id', lessonA.id).single()).data!
    expect(row.course_id).toBe(courseA.id)
  })
})

test.describe('coupons', () => {
  const coupon = (code: string, creatorId: string, courseId: string | null) => ({
    creator_id: creatorId, course_id: courseId, code, discount_type: 'percentage', discount_value: 100, is_active: true,
  })
  test('COU-000 CONTROL: a creator can make a coupon for their OWN course and it validates', async () => {
    const a = await signedInClient(A.email, A.password)
    const code = `OWN${Date.now()}`
    expect((await a.from('coupons').insert(coupon(code, A.id, courseA.id))).error, 'control failed').toBeNull()
    const res = await anonClient().rpc('validate_coupon_for_course', { input_course_id: courseA.id, input_coupon_code: code })
    expect(res.data?.[0]?.valid, 'control failed: own coupon should validate on own course').toBe(true)
  })
  test('COU-001 a coupon a creator attaches to ANOTHER creator\'s course does NOT work there', async () => {
    const a = await signedInClient(A.email, A.password)
    const code = `SNEAK${Date.now()}`
    await a.from('coupons').insert(coupon(code, A.id, courseB.id))
    const res = await anonClient().rpc('validate_coupon_for_course', { input_course_id: courseB.id, input_coupon_code: code })
    expect(res.data?.[0]?.valid ?? false).toBe(false)
  })
})

test.describe('phone takeover', () => {
  test('PHN-000 CONTROL: the real student can read their own enrollment', async () => {
    const s1 = await signedInClient(S1.email, S1.password)
    expect(visibleRows(await s1.from('enrollments').select('id').eq('id', enrollment.id))).toHaveLength(1)
  })
  test('PHN-001 a student who writes SOMEONE ELSE\'S phone on their own profile cannot read that person\'s enrollment', async () => {
    const s2 = await signedInClient(S2.email, S2.password)
    await s2.from('students').update({ phone: S1.phone }).eq('auth_id', S2.auth_id)
    expect(visibleRows(await s2.from('enrollments').select('id').eq('id', enrollment.id))).toHaveLength(0)
  })
  test('PHN-002 a student who puts SOMEONE ELSE\'S phone in their own login profile cannot read that person\'s enrollment', async () => {
    const s2 = await signedInClient(S2.email, S2.password)
    await s2.auth.updateUser({ data: { phone: S1.phone } })
    await s2.auth.refreshSession()
    expect(visibleRows(await s2.from('enrollments').select('id').eq('id', enrollment.id))).toHaveLength(0)
  })
})

test.describe('creator profile', () => {
  test('CRE-001 a creator cannot change their own plan through the database API', async () => {
    const a = await signedInClient(A.email, A.password)
    await a.from('creators').update({ plan: 'enterprise' }).eq('id', A.id)
    const row = (await db().from('creators').select('plan').eq('id', A.id).single()).data!
    expect(row.plan).toBe(A.plan)
  })
})