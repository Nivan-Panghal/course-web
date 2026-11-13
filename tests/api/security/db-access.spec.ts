/**
 * SECURITY REGRESSION: locks in the database fixes applied to live.
 * Every check here acts as a real user (anon / signed-in) through the public API, never
 * as admin. "Blocked" means a permission error OR zero rows. Writes are verified by
 * re-reading the row with the admin client, so a silent no-op can't hide a leak.
 * If one of these FAILS, treat it as a real security finding, not a flaky test.
 */
import { test, expect } from '@playwright/test'
import { db } from '../../helpers/admin-db'
import { anonClient, signedInClient, visibleRows } from '../../helpers/clients'
import {
  createCreator, createCourse, createLesson, createStudent, createEnrollment,
  createGateway, createPendingTransaction, cleanup,
} from '../../helpers/factories'

let A: any, B: any, S1: any, S2: any, course: any, lesson: any, enrollment: any

test.beforeAll(async () => {
  A = await createCreator()
  B = await createCreator()
  course = await createCourse(A.id)
  lesson = await createLesson(course.id, A.id, { order: 1 })
  await db().from('lessons').update({
    content_url: 'https://secret.example/video', video_storage_path: 'videos/secret.mp4', pdf_storage_path: 'pdf/secret.pdf',
  }).eq('id', lesson.id)
  S1 = await createStudent()
  S2 = await createStudent()
  enrollment = await createEnrollment({ studentId: S1.id, creatorId: A.id, courseId: course.id, phone: S1.phone })
  await createGateway(A.id, 'razorpay')
  await createPendingTransaction({ creatorId: A.id, courseId: course.id, provider: 'razorpay' })
})
test.afterAll(async () => { await cleanup() })

const reread = async (table: string, id: string) => (await db().from(table).select('*').eq('id', id).maybeSingle()).data

test.describe('anonymous visitor', () => {
  for (const table of ['enrollments', 'students', 'transactions', 'creator_payment_gateways']) {
    test(`cannot read ${table}`, async () => {
      expect(visibleRows(await anonClient().from(table).select('*'))).toHaveLength(0)
    })
  }

  for (const view of ['creator_revenue_summary', 'course_revenue_summary', 'creator_recent_payments', 'creator_monthly_revenue', 'payment_refund_status']) {
    test(`cannot read view ${view}`, async () => {
      expect(visibleRows(await anonClient().from(view).select('*'))).toHaveLength(0)
    })
  }

  test('cannot read lesson content (video / pdf / link) straight from the lessons table', async () => {
    const res = await anonClient().from('lessons').select('content_url, video_storage_path, pdf_storage_path').eq('id', lesson.id)
    expect(visibleRows(res).filter((r) => r.content_url || r.video_storage_path || r.pdf_storage_path)).toHaveLength(0)
  })

  test('cannot create an enrollment', async () => {
    const phone = '9000000001'
    await anonClient().from('enrollments').insert({ phone, creator_id: A.id, course_uuid: course.id, payment_status: 'paid' })
    const { data } = await db().from('enrollments').select('id').eq('phone', phone)
    expect(data).toHaveLength(0)
  })

  test('cannot modify or delete a course', async () => {
    await anonClient().from('courses').update({ name: 'HACKED' }).eq('id', course.id)
    await anonClient().from('courses').delete().eq('id', course.id)
    expect((await reread('courses', course.id))?.name).toBe(course.name)
  })

  test('cannot delete an enrollment', async () => {
    await anonClient().from('enrollments').delete().eq('id', enrollment.id)
    expect(await reread('enrollments', enrollment.id)).not.toBeNull()
  })
})

test.describe('student', () => {
  test('can read their own enrollment (positive control)', async () => {
    const s1 = await signedInClient(S1.email, S1.password)
    const res = await s1.from('enrollments').select('id').eq('id', enrollment.id)
    expect(res.error?.message, 'database error').toBeUndefined()
    expect(res.data).toHaveLength(1)
  })

  test('cannot read another student\'s enrollment', async () => {
    const s2 = await signedInClient(S2.email, S2.password)
    expect(visibleRows(await s2.from('enrollments').select('id').eq('id', enrollment.id))).toHaveLength(0)
  })

  test('cannot read lesson content directly, even when enrolled', async () => {
    const s1 = await signedInClient(S1.email, S1.password)
    const res = await s1.from('lessons').select('content_url, video_storage_path, pdf_storage_path').eq('id', lesson.id)
    expect(visibleRows(res).filter((r) => r.content_url || r.video_storage_path || r.pdf_storage_path)).toHaveLength(0)
  })

  test('cannot read payment gateway keys or transactions', async () => {
    const s1 = await signedInClient(S1.email, S1.password)
    expect(visibleRows(await s1.from('creator_payment_gateways').select('*'))).toHaveLength(0)
    expect(visibleRows(await s1.from('transactions').select('*'))).toHaveLength(0)
  })

  test('cannot change their own enrollment into someone else\'s or mark it complete', async () => {
    const s1 = await signedInClient(S1.email, S1.password)
    await s1.from('enrollments').update({ creator_id: B.id, amount_paid: 0, payment_status: 'pending' }).eq('id', enrollment.id)
    const row = await reread('enrollments', enrollment.id)
    expect(row?.creator_id).toBe(A.id)
    expect(row?.payment_status).toBe('paid')
  })
})

test.describe('creator B cannot touch creator A\'s data', () => {
  test('A can read their own enrollments (positive control)', async () => {
    const a = await signedInClient(A.email, A.password)
    const res = await a.from('enrollments').select('id').eq('id', enrollment.id)
    expect(res.error?.message, 'database error').toBeUndefined()
    expect(res.data).toHaveLength(1)
  })

  test('B cannot read A\'s enrollments, gateway keys or transactions', async () => {
    const b = await signedInClient(B.email, B.password)
    expect(visibleRows(await b.from('enrollments').select('id').eq('creator_id', A.id))).toHaveLength(0)
    expect(visibleRows(await b.from('creator_payment_gateways').select('*').eq('creator_id', A.id))).toHaveLength(0)
    expect(visibleRows(await b.from('transactions').select('*').eq('creator_id', A.id))).toHaveLength(0)
  })

  test('B cannot edit or delete A\'s course', async () => {
    const b = await signedInClient(B.email, B.password)
    await b.from('courses').update({ name: 'HACKED', price: 1 }).eq('id', course.id)
    await b.from('courses').delete().eq('id', course.id)
    const row = await reread('courses', course.id)
    expect(row?.name).toBe(course.name)
    expect(row?.price).toBe(course.price)
  })

  test('B cannot create a course in A\'s name', async () => {
    const b = await signedInClient(B.email, B.password)
    const slug = `forged-${Date.now()}`
    await b.from('courses').insert({ creator_id: A.id, name: 'Forged', slug, price: 1 })
    const { data } = await db().from('courses').select('id').eq('slug', slug)
    expect(data).toHaveLength(0)
  })

  test('B cannot edit A\'s lessons', async () => {
    const b = await signedInClient(B.email, B.password)
    await b.from('lessons').update({ title: 'HACKED' }).eq('id', lesson.id)
    expect((await reread('lessons', lesson.id))?.title).toBe(lesson.title)
  })
})