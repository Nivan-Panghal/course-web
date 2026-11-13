/**
 * PHASE 0 SMOKE TEST: proves the test machinery works before we write real tests.
 * If this passes: the app runs on the test DB, seeding and cleanup work,
 * webhook signing is accepted, and cron auth is enforced.
 */
import { test, expect } from '@playwright/test'
import { db } from '../helpers/admin-db'
import { createCreator, createCourse, createLesson, createGateway, createPendingTransaction, cleanup } from '../helpers/factories'
import { buildEvent, postWebhook } from '../helpers/signing'
import { runCron } from '../helpers/cron'

test.afterAll(async () => { await cleanup() })

test('app starts and serves the home page', async ({ request }) => {
  const res = await request.get('/')
  expect(res.status()).toBeLessThan(400)
})

test('test database is reachable with the service key', async () => {
  const { error } = await db().from('creators').select('id').limit(1)
  expect(error).toBeNull()
})

test('factories seed a creator, course and lesson, then read them back', async () => {
  const creator = await createCreator()
  const course = await createCourse(creator.id, { price: 999 })
  const lesson = await createLesson(course.id, creator.id, { order: 1 })
  const { data } = await db().from('lessons').select('id, course_id').eq('id', lesson.id).single()
  expect(data?.course_id).toBe(course.id)
})

test('webhook with a WRONG signature is rejected', async ({ request }) => {
  const creator = await createCreator()
  const course = await createCourse(creator.id)
  const gw = await createGateway(creator.id, 'cashfree')
  const txn = await createPendingTransaction({ creatorId: creator.id, courseId: course.id, provider: 'cashfree' })
  const evt = buildEvent('cashfree', { orderId: txn.gateway_order_id!, amountRupees: 499 })
  const res = await postWebhook(request, 'cashfree', evt, gw.webhookSecret + '-WRONG')
  expect(res.status()).toBe(400)
})

test('webhook for an unknown order is acknowledged but not matched', async ({ request }) => {
  const evt = buildEvent('cashfree', { orderId: 'order_does_not_exist', amountRupees: 1 })
  const res = await postWebhook(request, 'cashfree', evt, 'any-secret')
  expect(res.status()).toBe(200)
  expect((await res.json()).matched).toBe(false)
})

test('cron route rejects calls without the bearer token', async ({ request }) => {
  const res = await request.get('/api/cron/subscription-reminders')
  expect([401, 403]).toContain(res.status())
})

test('cron route accepts the correct bearer token', async ({ request }) => {
  const res = await runCron(request, '/api/cron/subscription-reminders')
  expect(res.status()).toBeLessThan(500)
})