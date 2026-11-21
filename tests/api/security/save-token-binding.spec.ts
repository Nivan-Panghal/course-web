/**
 * API security: POST /api/telegram|whatsapp/save-enrollment-token.
 *  - A token our own create-token route issued, for the same course, is saved (STK-001).
 *  - An invented token, an unknown enrollment, or a token for ANOTHER course is refused and nothing changes (STK-002..004).
 */
import { test, expect } from '@playwright/test'
import { db } from '../../helpers/admin-db'
import { createCreator, createCourse, createStudent, createEnrollment, cleanup } from '../../helpers/factories'

let creator: any, courseA: any, courseB: any, enr: any
test.beforeAll(async () => {
  creator = await createCreator()
  courseA = await createCourse(creator.id)
  courseB = await createCourse(creator.id)
  const s = await createStudent()
  enr = await createEnrollment({ studentId: s.id, creatorId: creator.id, courseId: courseA.id, phone: s.phone })
})
test.afterAll(async () => {
  await db().from('telegram_tokens').delete().eq('creator_id', creator.id)
  await db().from('whatsapp_tokens').delete().eq('creator_id', creator.id)
  await cleanup()
})

for (const p of [
  { name: 'telegram', table: 'telegram_tokens', col: 'telegram_start_token', courseCol: 'course_id' },
  { name: 'whatsapp', table: 'whatsapp_tokens', col: 'whatsapp_start_token', courseCol: 'course_slug' },
]) {
  const URL = `/api/${p.name}/save-enrollment-token`
  const issue = async (courseId: string) => {
    const token = `stk-${p.name}-${Math.random().toString(16).slice(2)}${Date.now()}`
    const { error } = await db().from(p.table).insert({
      token, creator_id: creator.id, [p.courseCol]: courseId, used: false,
      student_email: 'kurso.test+stk@example.com',
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    })
    if (error) throw new Error(error.message)
    return token
  }
  const saved = async () => (await db().from('enrollments').select(p.col).eq('id', enr.id).single()).data?.[p.col] ?? null

  test.describe(`${p.name} save-enrollment-token`, () => {
    test(`STK-001 (${p.name}) a token issued for this course is saved`, async ({ request }) => {
      const token = await issue(courseA.id)
      const res = await request.post(URL, { data: { enrollmentId: enr.id, token } })
      expect(res.status()).toBe(200)
      expect(await saved()).toBe(token)
    })
    test(`STK-002 (${p.name}) an invented token is refused and nothing changes`, async ({ request }) => {
      const before = await saved()
      const res = await request.post(URL, { data: { enrollmentId: enr.id, token: 'made-up-by-attacker' } })
      expect(res.status()).toBe(400)
      expect(await saved()).toBe(before)
    })
    test(`STK-003 (${p.name}) an unknown enrollment is a 404`, async ({ request }) => {
      const token = await issue(courseA.id)
      const res = await request.post(URL, { data: { enrollmentId: '00000000-0000-0000-0000-000000000000', token } })
      expect(res.status()).toBe(404)
    })
    test(`STK-004 (${p.name}) a token issued for ANOTHER course is refused`, async ({ request }) => {
      const before = await saved()
      const token = await issue(courseB.id)
      const res = await request.post(URL, { data: { enrollmentId: enr.id, token } })
      expect(res.status()).toBe(400)
      expect(await saved()).toBe(before)
    })
  })
}