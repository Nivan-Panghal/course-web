/**
 * API: marking a lesson complete / saving a quiz score  (POST /api/lesson/complete).
 *
 * Rules:
 *  - Progress only moves forward: completing is idempotent and current_lesson never goes backwards.
 *  - A lesson in a module that has not opened yet cannot be completed (no skipping the schedule).
 *  - Only a PAID enrollment can record progress. A refunded or unpaid one must not
 *    (otherwise a refunded student could still finish the course and collect the certificate).
 */
import { test, expect } from '@playwright/test'
import { db } from '../../helpers/admin-db'
import { createLesson, cleanup } from '../../helpers/factories'
import { seedScenario, newPaidStudent, dripCourse, cleanupStudentData } from '../../helpers/student-seed'

const URL = '/api/lesson/complete'
let sc: Awaited<ReturnType<typeof seedScenario>>
let l3: any

test.beforeAll(async () => {
  sc = await seedScenario() // lesson order 1 (paid) and 2 (free)
  l3 = await createLesson(sc.course.id, sc.creator.id, { order: 3 })
})
test.afterAll(async () => { await cleanupStudentData(); await cleanup() })

const complete = (request: any, enrollmentId: string, courseId: string, lessonNum: number, extra: object = {}) =>
  request.post(URL, { data: { enrollmentId, courseId, lessonNum, source: 'web', ...extra } })

const progress = async (enrollmentId: string) =>
  (await db().from('enrollments').select('completed_lessons, current_lesson, quiz_results').eq('id', enrollmentId).single()).data!

test.describe('input checks', () => {
  test('DONE-001 missing lessonNum or courseId is a 400', async ({ request }) => {
    expect((await request.post(URL, { data: { enrollmentId: sc.enrollment.id, courseId: sc.course.id } })).status()).toBe(400)
    expect((await request.post(URL, { data: { enrollmentId: sc.enrollment.id, lessonNum: 1 } })).status()).toBe(400)
  })
  test('DONE-002 neither identity nor enrollmentId is a 400', async ({ request }) => {
    expect((await request.post(URL, { data: { courseId: sc.course.id, lessonNum: 1 } })).status()).toBe(400)
  })
  test('DONE-003 an unknown enrollment is a 404', async ({ request }) => {
    expect((await complete(request, '00000000-0000-4000-8000-000000000000', sc.course.id, 1)).status()).toBe(404)
  })
  test('DONE-004 an enrollment from ANOTHER course cannot be used for this course', async ({ request }) => {
    const other = await dripCourse(sc.creator.id, 'all_at_once')
    const p = await newPaidStudent(other.course.id, sc.creator.id)
    expect((await complete(request, p.enrollment.id, sc.course.id, 1)).status()).toBe(404)
  })
})

test.describe('progress', () => {
  test('DONE-010 completing a lesson saves it and moves the student to the next one', async ({ request }) => {
    const p = await newPaidStudent(sc.course.id, sc.creator.id)
    const res = await complete(request, p.enrollment.id, sc.course.id, 1)
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, completed: [1], currentLesson: 2 })
    expect(await progress(p.enrollment.id)).toMatchObject({ completed_lessons: [1], current_lesson: 2 })
  })
  test('DONE-011 completing the same lesson twice changes nothing (idempotent)', async ({ request }) => {
    const p = await newPaidStudent(sc.course.id, sc.creator.id)
    await complete(request, p.enrollment.id, sc.course.id, 1)
    const body = await (await complete(request, p.enrollment.id, sc.course.id, 1)).json()
    expect(body.completed).toEqual([1])
  })
  test('DONE-012 progress never goes backwards when an earlier lesson is completed late', async ({ request }) => {
    const p = await newPaidStudent(sc.course.id, sc.creator.id)
    await complete(request, p.enrollment.id, sc.course.id, 3)
    const body = await (await complete(request, p.enrollment.id, sc.course.id, 1)).json()
    expect(body.currentLesson).toBe(4)
    expect([...body.completed].sort()).toEqual([1, 3])
  })
  test('DONE-013 a quiz score is stored, and a retake REPLACES it instead of adding a second entry', async ({ request }) => {
    const p = await newPaidStudent(sc.course.id, sc.creator.id)
    await complete(request, p.enrollment.id, sc.course.id, 1, { lessonId: sc.lesson.id, quizScore: 2, quizTotal: 5 })
    await complete(request, p.enrollment.id, sc.course.id, 1, { lessonId: sc.lesson.id, quizScore: 5, quizTotal: 5 })
    const q = (await progress(p.enrollment.id)).quiz_results
    expect(q).toHaveLength(1)
    expect(q[0]).toMatchObject({ lessonId: sc.lesson.id, score: 5, total: 5 })
  })
})

test.describe('schedule and payment rules', () => {
  test('DONE-020 a lesson in a module that has not opened cannot be completed, and nothing is saved', async ({ request }) => {
    const d = await dripCourse(sc.creator.id, 'per_student_drip', { unlockAfterDays: 14 })
    const p = await newPaidStudent(d.course.id, sc.creator.id)
    const res = await complete(request, p.enrollment.id, d.course.id, 1)
    expect(res.status()).toBe(403)
    expect((await res.json()).reason).toBe('module_locked')
    expect((await progress(p.enrollment.id)).completed_lessons).toEqual([])
  })
  test('DONE-021 a REFUNDED enrollment cannot record progress (rule c)', async ({ request }) => {
    const p = await newPaidStudent(sc.course.id, sc.creator.id, { status: 'refunded' })
    const res = await complete(request, p.enrollment.id, sc.course.id, 1)
    expect(res.status(), 'refunded student must be refused').toBeGreaterThanOrEqual(400)
    expect((await progress(p.enrollment.id)).completed_lessons).toEqual([])
  })
  test('DONE-022 a PENDING (never paid) enrollment cannot record progress', async ({ request }) => {
    const p = await newPaidStudent(sc.course.id, sc.creator.id, { status: 'pending' })
    const res = await complete(request, p.enrollment.id, sc.course.id, 1)
    expect(res.status(), 'unpaid student must be refused').toBeGreaterThanOrEqual(400)
    expect((await progress(p.enrollment.id)).completed_lessons).toEqual([])
  })
})