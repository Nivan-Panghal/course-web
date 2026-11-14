/**
 * API: the secure video proxy  (GET /api/video/stream).
 *
 * The proxy checks, in order: link signature + expiry -> rate limit -> enrollment -> storage.
 * A lesson WITHOUT a stored video answers 404 "Video not found" only AFTER the enrollment check
 * passed, so "404" below means "access was granted" and "403" means "access was refused".
 * The last block really streams bytes from the TEST R2 bucket (skipped if R2 keys are missing).
 *
 * Needs UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN in .env.test (rate limit + enrollment cache).
 */
import { test, expect } from '@playwright/test'
import crypto from 'crypto'
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { createLesson, cleanup } from '../../helpers/factories'
import { seedScenario, newPaidStudent, patch, signVideo, cleanupStudentData } from '../../helpers/student-seed'

let sc: Awaited<ReturnType<typeof seedScenario>>
test.beforeAll(async () => { sc = await seedScenario() })
test.afterAll(async () => { await cleanupStudentData(); await cleanup() })

const GRANTED = 404 // proxy got past the enrollment check, and this test lesson has no video file

test.describe('link signature', () => {
  test('VID-001 missing parameters are refused', async ({ request }) => {
    expect((await request.get('/api/video/stream')).status()).toBe(401)
    expect((await request.get(`/api/video/stream?lessonId=${sc.lesson.id}`)).status()).toBe(401)
  })
  test('VID-002 a tampered signature is refused', async ({ request }) => {
    const url = signVideo(sc.lesson.id, sc.student.auth_id).replace(/sig=[0-9a-f]+/, 'sig=' + '0'.repeat(64))
    expect((await request.get(url)).status()).toBe(401)
  })
  test('VID-003 a link signed with the wrong secret is refused', async ({ request }) => {
    expect((await request.get(signVideo(sc.lesson.id, sc.student.auth_id, { secret: 'not-the-real-secret' }))).status()).toBe(401)
  })
  test('VID-004 an expired link is refused', async ({ request }) => {
    expect((await request.get(signVideo(sc.lesson.id, sc.student.auth_id, { ttlMs: -1000 }))).status()).toBe(401)
  })
  test('VID-005 a link for lesson A cannot be reused for lesson B, or for another student', async ({ request }) => {
    const other = await createLesson(sc.course.id, sc.creator.id, { order: 5 })
    const forA = signVideo(sc.lesson.id, sc.student.auth_id)
    expect((await request.get(forA.replace(sc.lesson.id, other.id))).status()).toBe(401)
    expect((await request.get(forA.replace(sc.student.auth_id, sc.stranger.auth_id))).status()).toBe(401)
  })
})

test.describe('who may watch', () => {
  test('VID-010 a paid student is let through', async ({ request }) => {
    expect((await request.get(signVideo(sc.lesson.id, sc.student.auth_id))).status()).toBe(GRANTED)
  })
  test('VID-011 a student with no enrollment is refused (403)', async ({ request }) => {
    const res = await request.get(signVideo(sc.lesson.id, sc.stranger.auth_id))
    expect(res.status()).toBe(403)
  })
  test('VID-012 a PENDING enrollment is refused', async ({ request }) => {
    const p = await newPaidStudent(sc.course.id, sc.creator.id, { status: 'pending' })
    expect((await request.get(signVideo(sc.lesson.id, p.student.auth_id))).status()).toBe(403)
  })
  test('VID-013 "web" identity without the web-session cookie is refused', async ({ request }) => {
    expect((await request.get(signVideo(sc.lesson.id, 'web'))).status()).toBe(403)
  })
  test('VID-014 a FREE lesson plays for anyone holding a valid link', async ({ request }) => {
    expect((await request.get(signVideo(sc.freeLesson.id, 'web'))).status()).toBe(GRANTED)
  })
  test('VID-015 Telegram/WhatsApp numeric identity: paid is let through, pending and unknown are refused', async ({ request }) => {
    const chat = String(7_000_000_000 + Math.floor(Math.random() * 1_000_000))
    const paid = await newPaidStudent(sc.course.id, sc.creator.id, { telegramChatId: chat })
    expect((await request.get(signVideo(sc.lesson.id, chat))).status()).toBe(GRANTED)
    const chat2 = String(7_100_000_000 + Math.floor(Math.random() * 1_000_000))
    await newPaidStudent(sc.course.id, sc.creator.id, { telegramChatId: chat2, status: 'pending' })
    expect((await request.get(signVideo(sc.lesson.id, chat2))).status()).toBe(403)
    expect((await request.get(signVideo(sc.lesson.id, '7999999999'))).status()).toBe(403)
    expect(paid.enrollment.id).toBeTruthy()
  })
  test('VID-016 a REFUNDED student can no longer stream, immediately (rule c)', async ({ request }) => {
    const p = await newPaidStudent(sc.course.id, sc.creator.id)
    expect((await request.get(signVideo(sc.lesson.id, p.student.auth_id))).status()).toBe(GRANTED) // access is now cached
    await patch('enrollments', p.enrollment.id, { payment_status: 'refunded' })
    expect((await request.get(signVideo(sc.lesson.id, p.student.auth_id))).status()).toBe(403)
  })
  test('VID-017 an unpublished lesson is not served even to a paid student', async ({ request }) => {
    const draft = await createLesson(sc.course.id, sc.creator.id, { order: 8, published: false })
    const res = await request.get(signVideo(draft.id, sc.student.auth_id))
    expect([403, 404]).toContain(res.status())
  })
})

test.describe('abuse limits', () => {
  test('VID-020 the 41st request within a minute for one link identity is rate limited (429)', async ({ request }) => {
    const identity = 'rl-' + crypto.randomBytes(4).toString('hex')
    let last = 0
    for (let i = 0; i < 41; i++) last = (await request.get(signVideo(sc.freeLesson.id, identity))).status()
    expect(last).toBe(429)
  })
})

test.describe('real bytes from the test R2 bucket', () => {
  const hasR2 = !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY)
  const KEY = `phase4/${crypto.randomBytes(4).toString('hex')}.mp4`
    const PAYLOAD = crypto.randomBytes(2048)
  const s3 = () =>
    new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! },
    })

  test.beforeAll(async () => {
    if (!hasR2) return
    expect(process.env.R2_BUCKET_NAME, 'must be the TEST bucket').toMatch(/test/)
    await s3().send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME!, Key: KEY, Body: PAYLOAD, ContentType: 'video/mp4' }))
    await patch('lessons', sc.lesson.id, { video_storage_path: KEY })
  })
  test.afterAll(async () => {
    if (!hasR2) return
    await s3().send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME!, Key: KEY })).catch(() => {})
  })

  test('VID-030 a paid student receives the exact file, with anti-download headers and no storage address', async ({ request }) => {
    test.skip(!hasR2, 'R2 keys are not set in .env.test')
    const res = await request.get(signVideo(sc.lesson.id, sc.student.auth_id))
    expect(res.status()).toBe(200)
    expect(Buffer.from(await res.body()).equals(PAYLOAD)).toBe(true)
    const h = res.headers()
    expect(h['cache-control']).toContain('no-store')
    expect(h['content-disposition']).toBe('inline')
    expect(JSON.stringify(h)).not.toMatch(/cloudflarestorage|X-Amz/i)
  })
  test('VID-031 seeking works: a Range request returns exactly that slice (206)', async ({ request }) => {
    test.skip(!hasR2, 'R2 keys are not set in .env.test')
    const res = await request.get(signVideo(sc.lesson.id, sc.student.auth_id), { headers: { range: 'bytes=0-99' } })
    expect(res.status()).toBe(206)
    expect(res.headers()['content-range']).toBe('bytes 0-99/2048')
    expect(Buffer.from(await res.body()).equals(PAYLOAD.subarray(0, 100))).toBe(true)
  })
  test('VID-032 a stranger gets no bytes even though the file exists', async ({ request }) => {
    test.skip(!hasR2, 'R2 keys are not set in .env.test')
    expect((await request.get(signVideo(sc.lesson.id, sc.stranger.auth_id))).status()).toBe(403)
  })
})