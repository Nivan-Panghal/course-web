/**
 * API: every scheduled job listed in vercel.json exists and refuses a call without the secret.
 * A 404 here means vercel.json points at a route that is not there (the job silently never runs).
 */
import fs from 'fs'
import path from 'path'
import { test, expect } from '@playwright/test'
import { db } from '../../helpers/admin-db'
import { runCron } from '../../helpers/cron'
import { createCreator, createCourse, cleanup } from '../../helpers/factories'

const crons: { path: string }[] = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'vercel.json'), 'utf8')).crons

for (const c of crons) {
  test(`CRN-001 ${c.path} exists and refuses a request without the secret`, async ({ request }) => {
    const res = await request.get(c.path)
    expect(res.status(), '404 means vercel.json points at a route that does not exist').toBe(401)
  })
}

test.describe('CRN-002 recording notice', () => {
  const ROUTE = '/api/cron/live-session-recording-notify'
  let creator: any, course: any

  test.beforeAll(async () => {
    creator = await createCreator()
    course = await createCourse(creator.id)
  })
  test.afterAll(async () => {
    await db().from('live_sessions').delete().eq('creator_id', creator.id)
    await cleanup()
  })

  const session = async (startedMinutesAgo: number, duration: number) =>
    (await db().from('live_sessions').insert({
      course_id: course.id, creator_id: creator.id, title: 'Test live class',
      scheduled_at: new Date(Date.now() - startedMinutesAgo * 60_000).toISOString(),
      duration_minutes: duration, join_url: 'https://zoom.example.com/j/test',
    }).select().single()).data
  const notified = async (id: string) => (await db().from('live_sessions').select('recording_notified_at').eq('id', id).single()).data?.recording_notified_at

  test('an ended session is claimed once; a running one is left alone; a second run changes nothing', async ({ request }) => {
    const ended = await session(180, 60)
    const running = await session(10, 120)
    const first = await runCron(request, ROUTE)
    expect(first.status()).toBe(200)
    const stamp = await notified(ended.id)
    expect(stamp).toBeTruthy()
    expect(await notified(running.id)).toBeNull()
    expect((await runCron(request, ROUTE)).status()).toBe(200)
    expect(await notified(ended.id)).toBe(stamp)
  })
})