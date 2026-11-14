/**
 * Helpers for the student-access tests (Phase 4).
 *  - signVideo(): forges a signed video link exactly like src/lib/signer.ts does
 *  - seedScenario(): one creator + course + a paid lesson + a free lesson + a paying student
 *  - newPaidStudent(): a fresh paying student (for tests that change the enrollment, e.g. refund)
 *  - dripCourse(): a course with a module release schedule (drip lock)
 *  - cleanupStudentData(): removes what these helpers created that factories.cleanup() doesn't know about.
 *    Call it BEFORE cleanup() in afterAll.
 */
import crypto from 'crypto'
import { db } from './admin-db'
import { need } from './env'
import { createCreator, createCourse, createLesson, createStudent, createEnrollment } from './factories'

const DAY = 86_400_000
const trackedCourseIds: string[] = []
const rand = () => crypto.randomBytes(4).toString('hex')

/** A signed /api/video/stream URL (path + query only). Same rule as the app: HMAC-SHA256 hex of "video.<lesson>.<identity>.<exp>". */
export function signVideo(lessonId: string, identity: string, opts: { ttlMs?: number; secret?: string } = {}) {
  const exp = Date.now() + (opts.ttlMs ?? 10 * 60_000)
  const sig = crypto.createHmac('sha256', opts.secret ?? need('LESSON_LINK_SECRET')).update(`video.${lessonId}.${identity}.${exp}`).digest('hex')
  return `/api/video/stream?${new URLSearchParams({ lessonId, identity, exp: String(exp), sig, t: 'v' })}`
}

export function trackCourse(courseId: string) {
  trackedCourseIds.push(courseId)
}

export async function patch(table: 'courses' | 'lessons' | 'enrollments', id: string, values: Record<string, unknown>) {
  const { error } = await db().from(table).update(values).eq('id', id)
  if (error) throw new Error(`patch ${table} failed: ${error.message}`)
}

/** A paying student of the given course. Pass opts to change the enrollment (e.g. status 'refunded'). */
export async function newPaidStudent(courseId: string, creatorId: string, opts: { status?: string; enrolledAt?: string; telegramChatId?: string } = {}) {
  const student = await createStudent()
  const enrollment = await createEnrollment({ studentId: student.id, creatorId, courseId, phone: student.phone })
  const values: Record<string, unknown> = {}
  if (opts.status) values.payment_status = opts.status
  if (opts.enrolledAt) values.enrolled_at = opts.enrolledAt
  if (opts.telegramChatId) values.telegram_chat_id = opts.telegramChatId
  if (Object.keys(values).length) await patch('enrollments', enrollment.id, values)
  return { student, enrollment: { ...enrollment, ...values } }
}

/** Creator + published course + lesson 1 (paid) + lesson 2 (free preview) + a paying student + a stranger with no enrollment. */
export async function seedScenario() {
  const creator = await createCreator()
  const course = await createCourse(creator.id)
  trackCourse(course.id)
  const lesson = await createLesson(course.id, creator.id, { order: 1 })
  const freeLesson = await createLesson(course.id, creator.id, { order: 2, isFree: true })
  const { student, enrollment } = await newPaidStudent(course.id, creator.id)
  const stranger = await createStudent()
  return { creator, course, lesson, freeLesson, student, enrollment, stranger }
}

/**
 * A course with one module and one lesson inside it.
 *  mode 'per_student_drip' -> module opens `unlockAfterDays` after the student enrolled
 *  mode 'fixed_calendar'   -> module opens on `unlockDate` for everyone
 */
export async function dripCourse(
  creatorId: string,
  mode: 'all_at_once' | 'fixed_calendar' | 'per_student_drip',
  rule: { unlockAfterDays?: number | null; unlockDate?: string | null } = {},
  lessonOpts: { isFree?: boolean } = {}
) {
  const course = await createCourse(creatorId)
  trackCourse(course.id)
  await patch('courses', course.id, { delivery_mode: mode })
  const { data: mod, error } = await db()
    .from('course_modules')
    .insert({ course_id: course.id, name: `Module ${rand()}`, order_num: 1, unlock_after_days: rule.unlockAfterDays ?? null, unlock_date: rule.unlockDate ?? null })
    .select()
    .single()
  if (error || !mod) throw new Error(`module insert failed: ${error?.message}`)
  const lesson = await createLesson(course.id, creatorId, { order: 1, isFree: lessonOpts.isFree })
  await patch('lessons', lesson.id, { module_id: mod.id })
  return { course, lesson, module: mod }
}

export const daysAgoISO = (n: number) => new Date(Date.now() - n * DAY).toISOString()
export const daysAheadISO = (n: number) => new Date(Date.now() + n * DAY).toISOString()

/** Removes modules and access-log rows left behind. Run before factories.cleanup(). */
export async function cleanupStudentData() {
  const ids = trackedCourseIds.splice(0)
  if (!ids.length) return
  const d = db()
  for (const t of ['lesson_access_logs', 'course_modules']) {
    const { error } = await d.from(t).delete().in('course_id', ids)
    if (error) console.warn(`[cleanupStudentData] ${t}: ${error.message}`)
  }
}