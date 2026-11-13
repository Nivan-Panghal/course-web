/**
 * API: checkout with a CASHFREE creator gateway. Route: POST /api/checkout/create-order.
 * Cashfree order_id is our own transaction id. [network] tests call Cashfree's sandbox.
 * If the order calls fail complaining about notify_url / return_url, it is because the app
 * runs on http://localhost in tests: tell me and we'll adjust the test environment.
 */
import { test, expect } from '@playwright/test'
import { randomUUID } from 'crypto'
import { db } from '../../helpers/admin-db'
import { createCreator, createCourse, createGateway, cleanup } from '../../helpers/factories'
import { buildEvent, postWebhook } from '../../helpers/signing'

const URL = '/api/checkout/create-order'
const CF_ID = process.env.TEST_CASHFREE_APP_ID || process.env.KURSO_CASHFREE_CLIENT_ID
const CF_SECRET = process.env.TEST_CASHFREE_SECRET_KEY || process.env.KURSO_CASHFREE_CLIENT_SECRET
const haveCf = !!(CF_ID && CF_SECRET)
const buyerEmail = () => `kurso.test+buyer-${randomUUID().slice(0, 8)}@example.com`

test.afterAll(async () => { await cleanup() })

const txnsFor = async (courseId: string) =>
  (await db().from('transactions').select('*').eq('course_id', courseId).order('created_at', { ascending: true })).data ?? []

async function setup(real: boolean, price = 499) {
  const creator = await createCreator()
  const course = await createCourse(creator.id, { price })
  const gw = await createGateway(creator.id, 'cashfree', {
    credentials: real ? { clientId: CF_ID!, clientSecret: CF_SECRET! } : { clientId: 'fake', clientSecret: 'fake' },
  })
  return { creator, course, gw }
}

test('[network] bad creator keys -> 502 and the transaction is marked failed', async ({ request }) => {
  const s = await setup(false)
  const res = await request.post(URL, { data: { courseId: s.course.id, studentEmail: buyerEmail() } })
  expect(res.status()).toBe(502)
  const [txn] = await txnsFor(s.course.id)
  expect(txn.payment_provider).toBe('cashfree')
  expect(txn.status).toBe('failed')
  expect(txn.error_message).toBeTruthy()
})

test('with two gateways, the DEFAULT one is used for checkout', async ({ request }) => {
  const s = await setup(false)
  const rzp = await createGateway(s.creator.id, 'razorpay')
  await db().from('creator_payment_gateways').update({ is_default: true }).eq('id', s.gw.id)
  await db().from('creator_payment_gateways').update({ is_default: false }).eq('id', rzp.id)
  await request.post(URL, { data: { courseId: s.course.id } })

  await db().from('creator_payment_gateways').update({ is_default: false }).eq('id', s.gw.id)
  await db().from('creator_payment_gateways').update({ is_default: true }).eq('id', rzp.id)
  await request.post(URL, { data: { courseId: s.course.id } })

  const txns = await txnsFor(s.course.id)
  expect(txns.map((t: any) => t.payment_provider)).toEqual(['cashfree', 'razorpay'])
})

test('[network] success: price from the DB; order id is our transaction id', async ({ request }) => {
  test.skip(!haveCf, 'Set Cashfree test keys in .env.test')
  const s = await setup(true, 499)
  const res = await request.post(URL, { data: { courseId: s.course.id, studentName: 'Test Buyer', studentEmail: buyerEmail(), studentPhone: '+91 98765 43210', amount: 1 } })
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(body.order.provider).toBe('cashfree')
  expect(body.order.orderId).toBe(body.clientTxnId)
  expect(body.order.paymentSessionId).toBeTruthy()
  expect(body.order.mode).toBe('sandbox')
  expect(body.pricing.finalAmount).toBe(499)

  const [txn] = await txnsFor(s.course.id)
  expect(txn.status).toBe('pending')
  expect(Number(txn.amount)).toBe(499)
  expect(txn.gateway_order_id).toBe(body.clientTxnId)
})

test('[network] JOURNEY: create order -> signed Cashfree webhook -> student is enrolled', async ({ request }) => {
  test.skip(!haveCf, 'Set Cashfree test keys in .env.test')
  const s = await setup(true, 499)
  const order = await (await request.post(URL, { data: { courseId: s.course.id, studentName: 'Journey Buyer', studentEmail: buyerEmail(), studentPhone: '9123456780' } })).json()
  const hook = await postWebhook(request, 'cashfree', buildEvent('cashfree', { orderId: order.order.orderId, amountRupees: 499 }), s.gw.webhookSecret)
  expect(hook.status()).toBe(200)
  const { data: enrollments } = await db().from('enrollments').select('payment_status').eq('course_uuid', s.course.id)
  expect(enrollments).toEqual([{ payment_status: 'paid' }])
  expect((await txnsFor(s.course.id))[0].status).toBe('success')
})