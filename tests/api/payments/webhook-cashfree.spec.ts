/**
 * API: Cashfree payment webhook for a CREATOR's own account. Route: POST /api/webhooks/cashfree.
 * Signature = base64( HMAC-SHA256(creator webhook secret, timestamp + rawBody) ), headers
 * x-webhook-signature + x-webhook-timestamp. Events are forged, no real Cashfree needed.
 */
import { test, expect } from '@playwright/test'
import { db } from '../../helpers/admin-db'
import { createCreator, createCourse, createGateway, createPendingTransaction, cleanup } from '../../helpers/factories'
import { buildEvent, postWebhook, signedHeaders } from '../../helpers/signing'

test.afterAll(async () => { await cleanup() })

async function seedSale(price = 499) {
  const creator = await createCreator()
  const course = await createCourse(creator.id, { price })
  const gw = await createGateway(creator.id, 'cashfree')
  const txn = await createPendingTransaction({ creatorId: creator.id, courseId: course.id, provider: 'cashfree', amount: course.price })
  return { creator, course, gw, txn }
}
type Sale = Awaited<ReturnType<typeof seedSale>>
const evt = (s: Sale, over: { amount?: number; status?: string } = {}) => {
  const e: any = buildEvent('cashfree', { orderId: s.txn.gateway_order_id, amountRupees: over.amount ?? Number(s.txn.amount) })
  if (over.status) e.data.payment.payment_status = over.status
  return e
}
const txnNow = async (id: string) => (await db().from('transactions').select('*').eq('id', id).single()).data
const enrollmentsOf = async (courseId: string) => (await db().from('enrollments').select('*').eq('course_uuid', courseId)).data ?? []
const paymentsOf = async (courseId: string) => (await db().from('payments').select('*').eq('course_id', courseId)).data ?? []
const noAccess = async (s: Sale) => {
  expect((await txnNow(s.txn.id)).status).toBe('pending')
  expect(await enrollmentsOf(s.course.id)).toHaveLength(0)
  expect(await paymentsOf(s.course.id)).toHaveLength(0)
}

test.describe('valid payment', () => {
  test('SUCCESS activates the enrollment and records the money split', async ({ request }) => {
    const s = await seedSale()
    const res = await postWebhook(request, 'cashfree', evt(s), s.gw.webhookSecret)
    expect(res.status()).toBe(200)
    expect((await res.json()).message).toBe('Enrollment activated')
    expect((await txnNow(s.txn.id)).status).toBe('success')
    const [enr] = await enrollmentsOf(s.course.id)
    expect(enr).toMatchObject({ payment_status: 'paid', amount_paid: 499, creator_id: s.creator.id, phone: '9876543210' })
    const [pay] = await paymentsOf(s.course.id)
    expect(pay).toMatchObject({ status: 'paid', provider: 'cashfree', gross_amount: 499, platform_fee: 25, creator_earning: 474 })
  })

  test('delivered twice -> access granted once', async ({ request }) => {
    const s = await seedSale()
    await postWebhook(request, 'cashfree', evt(s), s.gw.webhookSecret)
    const second = await postWebhook(request, 'cashfree', evt(s), s.gw.webhookSecret)
    expect((await second.json()).message).toBe('Already processed')
    expect(await enrollmentsOf(s.course.id)).toHaveLength(1)
    expect(await paymentsOf(s.course.id)).toHaveLength(1)
  })

  test('RACE: two simultaneous deliveries still end with one enrollment and one payment', async ({ request }) => {
    const s = await seedSale()
    const e = evt(s)
    const [a, b] = await Promise.all([postWebhook(request, 'cashfree', e, s.gw.webhookSecret), postWebhook(request, 'cashfree', e, s.gw.webhookSecret)])
    expect([a.status(), b.status()]).toContain(200)
    expect(await enrollmentsOf(s.course.id)).toHaveLength(1)
    expect(await paymentsOf(s.course.id)).toHaveLength(1)
  })
})

test.describe('forged or broken webhooks never grant access', () => {
  test('wrong secret -> 400', async ({ request }) => {
    const s = await seedSale()
    const res = await postWebhook(request, 'cashfree', evt(s), s.gw.webhookSecret + '-wrong')
    expect(res.status()).toBe(400)
    expect((await res.json()).error).toBe('Invalid signature')
    await noAccess(s)
  })

  test('body changed after signing -> 400', async ({ request }) => {
    const s = await seedSale()
    const signedRaw = JSON.stringify(evt(s))
    const tampered = signedRaw.replace('"payment_amount":499', '"payment_amount":1')
    const res = await request.post('/api/webhooks/cashfree', { data: tampered, headers: { 'content-type': 'application/json', ...signedHeaders('cashfree', signedRaw, s.gw.webhookSecret) } })
    expect(res.status()).toBe(400)
    await noAccess(s)
  })

  test('missing signature OR missing timestamp -> 400', async ({ request }) => {
    const s = await seedSale()
    const raw = JSON.stringify(evt(s))
    const h = signedHeaders('cashfree', raw, s.gw.webhookSecret)
    const noSig = await request.post('/api/webhooks/cashfree', { data: raw, headers: { 'content-type': 'application/json', 'x-webhook-timestamp': h['x-webhook-timestamp'] } })
    const noTs = await request.post('/api/webhooks/cashfree', { data: raw, headers: { 'content-type': 'application/json', 'x-webhook-signature': h['x-webhook-signature'] } })
    expect([noSig.status(), noTs.status()]).toEqual([400, 400])
    await noAccess(s)
  })

  test("another creator's secret cannot confirm this order", async ({ request }) => {
    const victim = await seedSale()
    const attacker = await seedSale()
    const res = await postWebhook(request, 'cashfree', evt(victim), attacker.gw.webhookSecret)
    expect(res.status()).toBe(400)
    await noAccess(victim)
  })

  test('creator with NO webhook secret is rejected, never failed open', async ({ request }) => {
    const s = await seedSale()
    await db().from('creator_payment_gateways').update({ webhook_secret_encrypted: null }).eq('creator_id', s.creator.id)
    const res = await postWebhook(request, 'cashfree', evt(s), 'anything')
    expect(res.status()).toBe(400)
    expect((await res.json()).error).toBe('Webhook not configured for this account')
    await noAccess(s)
  })

  test('unknown order id is acknowledged but changes nothing', async ({ request }) => {
    const res = await postWebhook(request, 'cashfree', buildEvent('cashfree', { orderId: 'order_nope', amountRupees: 1 }), 'whatever')
    expect(res.status()).toBe(200)
    expect((await res.json()).matched).toBe(false)
  })
})

test.describe('other outcomes', () => {
  test('FAILED payment -> transaction failed, nothing granted', async ({ request }) => {
    const s = await seedSale()
    const res = await postWebhook(request, 'cashfree', evt(s, { status: 'FAILED' }), s.gw.webhookSecret)
    expect((await res.json()).message).toBe('Marked failed')
    expect((await txnNow(s.txn.id)).status).toBe('failed')
    expect(await enrollmentsOf(s.course.id)).toHaveLength(0)
  })

  test('USER_DROPPED (closed the payment page) -> transaction expired, nothing granted', async ({ request }) => {
    const s = await seedSale()
    const res = await postWebhook(request, 'cashfree', evt(s, { status: 'USER_DROPPED' }), s.gw.webhookSecret)
    expect((await res.json()).message).toBe('Marked expired')
    expect((await txnNow(s.txn.id)).status).toBe('expired')
    expect(await enrollmentsOf(s.course.id)).toHaveLength(0)
  })

  test('RULE (b): SUCCESS arriving AFTER a failure or expiry still grants access', async ({ request }) => {
    const s = await seedSale()
    await postWebhook(request, 'cashfree', evt(s, { status: 'USER_DROPPED' }), s.gw.webhookSecret)
    const res = await postWebhook(request, 'cashfree', evt(s), s.gw.webhookSecret)
    expect((await res.json()).message).toBe('Enrollment activated')
    expect(await enrollmentsOf(s.course.id)).toHaveLength(1)
  })

  test('a PENDING status is ignored', async ({ request }) => {
    const s = await seedSale()
    const res = await postWebhook(request, 'cashfree', evt(s, { status: 'PENDING' }), s.gw.webhookSecret)
    expect((await res.json()).message).toMatch(/Ignored status/)
    await noAccess(s)
  })

  test('amount mismatch is NOT activated; the correct amount afterwards still is', async ({ request }) => {
    const s = await seedSale()
    const bad = await postWebhook(request, 'cashfree', evt(s, { amount: 1 }), s.gw.webhookSecret)
    expect((await bad.json()).message).toBe('Amount mismatch — not activated')
    expect((await txnNow(s.txn.id)).error_message).toMatch(/Amount mismatch/)
    await noAccess(s)
    const good = await postWebhook(request, 'cashfree', evt(s), s.gw.webhookSecret)
    expect((await good.json()).message).toBe('Enrollment activated')
  })
})