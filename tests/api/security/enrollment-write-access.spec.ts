/**
 * SECURITY: can a SIGNED-IN person write to enrollments straight through the public database API?
 * The "authenticated" role has INSERT and DELETE on the table, so only the row policies protect it.
 * Everything here acts as a real logged-in student or creator, never as admin.
 * "Blocked" means a permission error or no change; the result is checked by re-reading as admin.
 * If one of these FAILS it is a real finding: someone could give themselves a paid course for free,
 * or remove somebody else's access.
 */
import { test, expect } from '@playwright/test'
import { db } from '../../helpers/admin-db'
import { signedInClient } from '../../helpers/clients'
import { createCreator, createCourse, createStudent, createEnrollment, cleanup } from '../../helpers/factories'

let A: any, B: any, S1: any, S2: any, course: any, enrollment: any
test.beforeAll(async () => {
  A = await createCreator()
  B = await createCreator()
  S1 = await createStudent()
  S2 = await createStudent()
  course = await createCourse(A.id, { price: 499 })
  enrollment = await createEnrollment({ studentId: S1.id, creatorId: A.id, courseId: course.id, phone: S1.phone })
})
test.afterAll(async () => { await cleanup() })

const enrollmentsOf = async (studentId: string) =>
  (await db().from('enrollments').select('id, payment_status').eq('course_uuid', course.id).eq('student_id', studentId)).data ?? []
const stillThere = async () => (await db().from('enrollments').select('id').eq('id', enrollment.id).maybeSingle()).data

test.describe('a signed-in student', () => {
  test('ENW-001 cannot give THEMSELVES a paid enrollment', async () => {
    const s2 = await signedInClient(S2.email, S2.password)
    await s2.from('enrollments').insert({ student_id: S2.id, creator_id: A.id, course_uuid: course.id, phone: S2.phone, payment_status: 'paid', amount_paid: 0 })
    expect(await enrollmentsOf(S2.id)).toHaveLength(0)
  })
  test('ENW-002 cannot give someone ELSE an enrollment', async () => {
    const s2 = await signedInClient(S2.email, S2.password)
    await s2.from('enrollments').insert({ student_id: S1.id, creator_id: A.id, course_uuid: course.id, phone: S1.phone, payment_status: 'paid', amount_paid: 0 })
    expect(await enrollmentsOf(S1.id)).toHaveLength(1) // only the original one
  })
  test('ENW-003 cannot delete their own enrollment (that would erase a purchase record)', async () => {
    const s1 = await signedInClient(S1.email, S1.password)
    await s1.from('enrollments').delete().eq('id', enrollment.id)
    expect(await stillThere()).not.toBeNull()
  })
  test('ENW-004 cannot delete another student\'s enrollment', async () => {
    const s2 = await signedInClient(S2.email, S2.password)
    await s2.from('enrollments').delete().eq('id', enrollment.id)
    expect(await stillThere()).not.toBeNull()
  })
})

test.describe('another creator', () => {
  test('ENW-010 cannot create an enrollment on MY course', async () => {
    const b = await signedInClient(B.email, B.password)
    await b.from('enrollments').insert({ student_id: S2.id, creator_id: A.id, course_uuid: course.id, phone: S2.phone, payment_status: 'paid', amount_paid: 0 })
    expect(await enrollmentsOf(S2.id)).toHaveLength(0)
  })
  test('ENW-011 cannot delete an enrollment on MY course', async () => {
    const b = await signedInClient(B.email, B.password)
    await b.from('enrollments').delete().eq('id', enrollment.id)
    expect(await stillThere()).not.toBeNull()
  })
})

test.describe('a creator pointing an enrollment at SOMEONE ELSE\'S course', () => {
  test('ENW-012 another creator cannot give a phone free access to MY course, even with their own creator id on it', async () => {
    const b = await signedInClient(B.email, B.password)
    await b.from('enrollments').insert({ student_id: S2.id, creator_id: B.id, course_uuid: course.id, phone: S2.phone, payment_status: 'paid', amount_paid: 0 })
    expect(await enrollmentsOf(S2.id)).toHaveLength(0)
  })
})