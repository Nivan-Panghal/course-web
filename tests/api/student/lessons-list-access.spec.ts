/**
 * API: who can read lesson content?  (GET /api/course/lessons  and  GET /api/resource/lesson)
 *
 * Rules:
 *  - A visitor, or a student who has NOT paid (pending / refunded / other course), gets the lesson
 *    list as a "preview": titles and order only. No video, PDF, live link, notes, summary,
 *    assignment file or quiz questions.
 *  - A paid student and the course owner get everything.
 *  - Unpublished lessons are never listed.
 */
import { test, expect } from '@playwright/test'
import { accessToken } from '../../helpers/clients'
import { createCreator, createCourse, createLesson, cleanup } from '../../helpers/factories'
import { seedScenario, newPaidStudent, patch, trackCourse, cleanupStudentData } from '../../helpers/student-seed'
import { db } from '../../helpers/admin-db'

const URL = '/api/course/lessons'
const SECRETS = {
  content_url: 'https://secret.example/video.mp4',
  video_storage_path: 'videos/secret.mp4',
  pdf_storage_path: 'pdfs/secret.pdf',
  live_join_url: 'https://secret.example/join',
  live_recording_url: 'https://secret.example/recording',
  summary_url: 'https://secret.example/summary.pdf',
  notes_url: 'https://secret.example/notes.pdf',
  assignment_file_url: 'https://secret.example/assignment.pdf',
  quiz_questions: [{ question: 'Secret Q?', options: ['a', 'b'], correct: 0 }],
}

let sc: Awaited<ReturnType<typeof seedScenario>>
let hidden: any // an unpublished lesson

test.beforeAll(async () => {
  sc = await seedScenario()
  await patch('lessons', sc.lesson.id, SECRETS)
  hidden = await createLesson(sc.course.id, sc.creator.id, { order: 3, published: false, title: 'Draft lesson' })
})
test.afterAll(async () => { await cleanupStudentData(); await cleanup() })

const get = (request: any, courseId: string, token?: string) =>
  request.get(`${URL}?courseId=${courseId}`, { headers: token ? { authorization: `Bearer ${token}` } : {} })

test.describe('input checks', () => {
  test('STU-001 no courseId or a malformed one is a 400', async ({ request }) => {
    expect((await request.get(URL)).status()).toBe(400)
    expect((await request.get(`${URL}?courseId=not-a-uuid`)).status()).toBe(400)
  })
  test('STU-002 unknown course is a 404', async ({ request }) => {
    expect((await get(request, '00000000-0000-4000-8000-000000000000')).status()).toBe(404)
  })
  test('STU-003 the summary mode (?courseIds=) exposes only counts, never content', async ({ request }) => {
    const res = await request.get(`${URL}?courseIds=${sc.course.id},not-a-uuid`)
    const { lessons } = await res.json()
    expect(lessons.length).toBe(2) // published lessons only (paid + free), not the draft
    for (const l of lessons) expect(Object.keys(l).sort()).toEqual(['course_id', 'is_last_lesson', 'order_num'])
  })
})

test.describe('visitors and non-paying students see a preview', () => {
  function expectPreview(body: any) {
    expect(body.access).toBe('preview')
    const l = body.lessons.find((x: any) => x.id === sc.lesson.id)
    expect(l, 'the paid lesson is listed (title only)').toBeTruthy()
    for (const col of ['content_url', 'video_storage_path', 'pdf_storage_path', 'live_join_url', 'live_recording_url']) {
      expect(l[col] || null, `${col} must be hidden`).toBeNull()
    }
  }

  test('STU-004 a visitor with no login gets the preview', async ({ request }) => {
    expectPreview(await (await get(request, sc.course.id)).json())
  })
  test('STU-005 a garbage login token is treated as a visitor', async ({ request }) => {
    expectPreview(await (await get(request, sc.course.id, 'garbage.token.value')).json())
  })
  test('STU-006 a logged-in student who never enrolled gets the preview', async ({ request }) => {
    expectPreview(await (await get(request, sc.course.id, await accessToken(sc.stranger.email, sc.stranger.password))).json())
  })
  test('STU-007 a student with a PENDING enrollment gets the preview', async ({ request }) => {
    const p = await newPaidStudent(sc.course.id, sc.creator.id, { status: 'pending' })
    expectPreview(await (await get(request, sc.course.id, await accessToken(p.student.email, p.student.password))).json())
  })
  test('STU-008 a REFUNDED student loses access straight away (rule c)', async ({ request }) => {
    const p = await newPaidStudent(sc.course.id, sc.creator.id)
    const token = await accessToken(p.student.email, p.student.password)
    expect((await (await get(request, sc.course.id, token)).json()).access).toBe('full')
    await patch('enrollments', p.enrollment.id, { payment_status: 'refunded' })
    expectPreview(await (await get(request, sc.course.id, token)).json())
  })
  test('STU-009 a student paid for a DIFFERENT course gets the preview here', async ({ request }) => {
    const other = await createCourse(sc.creator.id)
    trackCourse(other.id)
    const p = await newPaidStudent(other.id, sc.creator.id)
    expectPreview(await (await get(request, sc.course.id, await accessToken(p.student.email, p.student.password))).json())
  })
})

test.describe('paying students and the owner see everything', () => {
  test('STU-010 a paid student gets full access and the real links', async ({ request }) => {
    const body = await (await get(request, sc.course.id, await accessToken(sc.student.email, sc.student.password))).json()
    expect(body.access).toBe('full')
    const l = body.lessons.find((x: any) => x.id === sc.lesson.id)
    expect(l.content_url).toBe(SECRETS.content_url)
    expect(l.video_storage_path).toBe(SECRETS.video_storage_path)
  })
  test('STU-011 the course owner gets full access', async ({ request }) => {
    const body = await (await get(request, sc.course.id, await accessToken(sc.creator.email, sc.creator.password))).json()
    expect(body.access).toBe('full')
  })
  test('STU-012 a different creator does NOT get full access to this course', async ({ request }) => {
    const rival = await createCreator()
    const body = await (await get(request, sc.course.id, await accessToken(rival.email, rival.password))).json()
    expect(body.access).toBe('preview')
  })
  test('STU-013 unpublished lessons are never listed, even for the paid student', async ({ request }) => {
    const body = await (await get(request, sc.course.id, await accessToken(sc.student.email, sc.student.password))).json()
    expect(body.lessons.map((l: any) => l.id)).not.toContain(hidden.id)
  })
})

test.describe('the preview must not leak the other lesson materials', () => {
  test('STU-014 a visitor gets no notes, summary, assignment file or quiz questions of a PAID lesson', async ({ request }) => {
    const body = await (await get(request, sc.course.id)).json()
    const l = body.lessons.find((x: any) => x.id === sc.lesson.id)
    expect(l.notes_url || null, 'notes_url').toBeNull()
    expect(l.summary_url || null, 'summary_url').toBeNull()
    expect(l.assignment_file_url || null, 'assignment_file_url').toBeNull()
    expect(l.quiz_questions?.length ?? 0, 'quiz_questions').toBe(0)
  })
  test('STU-015 /api/resource/lesson does not hand a paid lesson\'s notes and quiz to a visitor', async ({ request }) => {
    const res = await request.get(`/api/resource/lesson?lessonId=${sc.lesson.id}`)
    const body = res.status() === 200 ? await res.json() : {}
    expect(body.lesson?.notes_url || null, 'notes_url').toBeNull()
    expect(body.lesson?.quiz_questions?.length ?? 0, 'quiz_questions').toBe(0)
  })
  test('STU-016 /api/resource/lesson still works for a FREE lesson', async ({ request }) => {
    await db().from('lessons').update({ notes_url: 'https://example.com/free-notes.pdf' }).eq('id', sc.freeLesson.id)
    const res = await request.get(`/api/resource/lesson?lessonId=${sc.freeLesson.id}`)
    expect(res.status()).toBe(200)
    expect((await res.json()).lesson.notes_url).toBe('https://example.com/free-notes.pdf')
  })
  test('STU-017 /api/resource/lesson hides unpublished lessons', async ({ request }) => {
    expect((await request.get(`/api/resource/lesson?lessonId=${hidden.id}`)).status()).toBe(404)
  })
})