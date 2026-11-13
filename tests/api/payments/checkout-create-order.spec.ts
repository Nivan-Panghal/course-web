/**
 * API: a student starting checkout. Route: POST /api/checkout/create-order.
 * Rules under test: only published courses; creator must have a VERIFIED gateway;
 * price comes from the database (never from the request); free and over-limit prices
 * are refused; the order is created with the CREATOR's own Razorpay keys.
 * Tests marked [network] call Razorpay's real test API.
 * The last test is the full journey: create order -> forged signed webhook -> access.
 */
import { test, expect } from '@playwright/test'
import { randomUUID } from 'crypto'
import { db } from '../../helpers/admin-db'
import { createCreator, createCourse, createGateway, cleanup } from '../../helpers/factories'
import { buildEvent, postWebhook } from '../../helpers/signing'

const URL = '/api/checkout/create-order'
const KEY_ID = process.env.TEST_RAZORPAY_KEY_ID
const KEY_SECRET = process.env.TEST_RAZORPAY_KEY_SECRET
const haveKeys = !!(KEY_ID && KEY_SECRET)
const buyerEmail = () => `kurso.test+buyer-${randomUUID().slice(0, 8)}@example.com`

test.afterAll(async () => { await cleanup() })

async function setup(opts: { price?: number; published?: boolean; gateway?: 'real' | 'fake' | 'none' } = {}) {
  const creator = await createCreator()
  const course = await createCourse(creator.id, { price: opts.price ?? 499, published: opts.published ?? true })
  const kind = opts.gateway ?? 'fake'
  const gw = kind === 'none' ? null
    : await createGateway(creator.id, 'razorpay', {
        credentials: kind === 'real' ? { keyId: KEY_ID!, keySecret: KEY_SECRET! } : { keyId: 'rzp_test_fake', keySecret: 'fake' },
      })
  return { creator, course, gw }
}
const txnsFor = async (courseId: string) => (await db().from('transactions').select('*').eq('course_id', courseId)).data ?? []

test.describe('refused before any payment is started', () => {
  test('missing courseId -> 400', async ({ request }) => {
    const res = await request.post(URL, { data: {} })
    expect(res.status()).toBe(400)
    expect((await res.json()).error).toBe('Missing course ID')
  })
  test('unknown course -> 404', async ({ request }) => {
    expect((await request.post(URL, { data: { courseId: randomUUID() } })).status()).toBe(404)
  })
  test('unpublished course -> 403, no transaction created', async ({ request }) => {
    const s = await setup({ published: false })
    expect((await request.post(URL, { data: { courseId: s.course.id } })).status()).toBe(403)
    expect(await txnsFor(s.course.id)).toHaveLength(0)
  })
  test('creator with no gateway -> 409', async ({ request }) => {
    const s = await setup({ gateway: 'none' })
    const res = await request.post(URL, { data: { courseId: s.course.id } })
    expect(res.status()).toBe(409)
    expect((await res.json()).error).toMatch(/hasn't finished setting up payments/)
  })
  test('a gateway that is not verified is never used -> 409', async ({ request }) => {
    const s = await setup()
    await db().from('creator_payment_gateways').update({ status: 'failed' }).eq('creator_id', s.creator.id)
    expect((await request.post(URL, { data: { courseId: s.course.id } })).status()).toBe(409)
  })
  test('a free price (0) must use free enrollment -> 400', async ({ request }) => {
    const s = await setup({ price: 0 })
    const res = await request.post(URL, { data: { courseId: s.course.id } })
    expect(res.status()).toBe(400)
    expect((await res.json()).error).toMatch(/free enrollment/)
  })
  test('over the 1,00,000 limit -> 400', async ({ request }) => {
    const s = await setup({ price: 100001 })
    const res = await request.post(URL, { data: { courseId: s.course.id } })
    expect(res.status()).toBe(400)
    expect((await res.json()).error).toMatch(/exceeds/)
  })
})

test.describe('order creation [network]', () => {
  test('bad creator keys -> 502 and the transaction is marked failed', async ({ request }) => {
    const s = await setup({ gateway: 'fake' })
    const res = await request.post(URL, { data: { courseId: s.course.id, studentEmail: buyerEmail() } })
    expect(res.status()).toBe(502)
    const [txn] = await txnsFor(s.course.id)
    expect(txn.status).toBe('failed')
    expect(txn.error_message).toBeTruthy()
  })

  test('success: price comes from the DB, not the request; creator keys are used', async ({ request }) => {
    test.skip(!haveKeys, 'Set TEST_RAZORPAY_KEY_ID and TEST_RAZORPAY_KEY_SECRET in .env.test')
    const s = await setup({ price: 499, gateway: 'real' })
    const email = buyerEmail()
    // The request lies about the price; the server must ignore it.
    const res = await request.post(URL, { data: { courseId: s.course.id, studentName: 'Test Buyer', studentEmail: email, studentPhone: '9876543210', amount: 1, price: 1 } })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.order.provider).toBe('razorpay')
    expect(body.order.orderId).toMatch(/^order_/)
    expect(body.order.amountPaise).toBe(49900)
    expect(body.order.keyId).toBe(KEY_ID)
    expect(body.pricing.finalAmount).toBe(499)

    const [txn] = await txnsFor(s.course.id)
    expect(txn.id).toBe(body.clientTxnId)
    expect(txn.status).toBe('pending')
    expect(Number(txn.amount)).toBe(499)
    expect(txn.gateway_order_id).toBe(body.order.orderId)
    expect(txn.payment_provider).toBe('razorpay')
    expect(txn.student_email).toBe(email)
  })

  test('JOURNEY: create order -> signed webhook -> student is enrolled', async ({ request }) => {
    test.skip(!haveKeys, 'Set TEST_RAZORPAY_KEY_ID and TEST_RAZORPAY_KEY_SECRET in .env.test')
    const s = await setup({ price: 499, gateway: 'real' })
    const email = buyerEmail()
    const order = await (await request.post(URL, { data: { courseId: s.course.id, studentName: 'Journey Buyer', studentEmail: email, studentPhone: '9123456780' } })).json()

    const evt = buildEvent('razorpay', { orderId: order.order.orderId, amountRupees: 499 })
    const hook = await postWebhook(request, 'razorpay', evt, s.gw!.webhookSecret)
    expect(hook.status()).toBe(200)

    const { data: enrollments } = await db().from('enrollments').select('*').eq('course_uuid', s.course.id)
    expect(enrollments).toHaveLength(1)
    expect(enrollments![0].payment_status).toBe('paid')
    const [txn] = await txnsFor(s.course.id)
    expect(txn.status).toBe('success')
  })
})