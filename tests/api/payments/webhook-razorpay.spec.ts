/**
 * API: Razorpay payment webhook, the moment a student gets access.
 * Route: POST /api/webhooks/razorpay. No real Razorpay needed: events are forged and
 * signed with the creator's own webhook secret, exactly as the app verifies them.
 * Money rule: 5% platform fee on the standard plan (499 -> fee 25, creator 474).
 */
import { test, expect } from '@playwright/test'
import { randomUUID } from 'crypto'
import { db } from '../../helpers/admin-db'
import { createCreator, createCourse, createGateway, createPendingTransaction, createStudent, cleanup } from '../../helpers/factories'
import { signedInClient } from '../../helpers/clients'
import { buildEvent, postWebhook, signedHeaders } from '../../helpers/signing'

test.afterAll(async () => { await cleanup() })

async function seedSale(opts: { price?: number; creator?: any; email?: string; gw?: any } = {}) {
  const creator = opts.creator ?? (await createCreator())
  const course = await createCourse(creator.id, { price: opts.price ?? 499 })
  const gw = opts.gw ?? (await createGateway(creator.id, 'razorpay'))
  const txn = await createPendingTransaction({ creatorId: creator.id, courseId: course.id, provider: 'razorpay', amount: course.price, studentEmail: opts.email })
  return { creator, course, gw, txn }
}
type Sale = Awaited<ReturnType<typeof seedSale>>
const captured = (s: Sale) => buildEvent('razorpay', { orderId: s.txn.gateway_order_id, amountRupees: Number(s.txn.amount) })
const txnNow = async (id: string) => (await db().from('transactions').select('*').eq('id', id).single()).data
const enrollmentsOf = async (courseId: string) => (await db().from('enrollments').select('*').eq('course_uuid', courseId)).data ?? []
const paymentsOf = async (courseId: string) => (await db().from('payments').select('*').eq('course_id', courseId)).data ?? []

test.describe('valid payment', () => {
  test('captured payment activates the enrollment and records the money split', async ({ request }) => {
    const s = await seedSale()
    const res = await postWebhook(request, 'razorpay', captured(s), s.gw.webhookSecret)
    expect(res.status()).toBe(200)
    expect((await res.json()).message).toBe('Enrollment activated')

    const txn = await txnNow(s.txn.id)
    expect(txn.status).toBe('success')
    expect(txn.enrollment_id).toBeTruthy()

    const [enr] = await enrollmentsOf(s.course.id)
    expect(enr.payment_status).toBe('paid')
    expect(enr.amount_paid).toBe(499)
    expect(enr.creator_id).toBe(s.creator.id)
    expect(enr.phone).toBe('9876543210')
    expect(enr.refund_window_days).toBe(s.course.refund_window_days) // snapshot at payment time
    expect(enr.delivery_method).toBe(s.course.delivery)

    const [pay] = await paymentsOf(s.course.id)
    expect(pay).toMatchObject({ status: 'paid', provider: 'razorpay', gross_amount: 499, platform_fee: 25, creator_earning: 474, revenue_share_rate_percent: 5 })
    expect(pay.platform_fee + pay.creator_earning).toBe(pay.gross_amount)
  })

  test('the same webhook delivered twice grants access only once', async ({ request }) => {
    const s = await seedSale()
    const evt = captured(s)
    await postWebhook(request, 'razorpay', evt, s.gw.webhookSecret)
    const second = await postWebhook(request, 'razorpay', evt, s.gw.webhookSecret)
    expect(second.status()).toBe(200)
    expect((await second.json()).message).toBe('Already processed')
    expect(await enrollmentsOf(s.course.id)).toHaveLength(1)
    expect(await paymentsOf(s.course.id)).toHaveLength(1)
  })

  test('RACE: two simultaneous deliveries still end with one enrollment and one payment', async ({ request }) => {
    const s = await seedSale()
    const evt = captured(s)
    const [r1, r2] = await Promise.all([
      postWebhook(request, 'razorpay', evt, s.gw.webhookSecret),
      postWebhook(request, 'razorpay', evt, s.gw.webhookSecret),
    ])
    expect([r1.status(), r2.status()]).toContain(200)
    expect(await enrollmentsOf(s.course.id)).toHaveLength(1)
    expect(await paymentsOf(s.course.id)).toHaveLength(1)
  })

  test('a returning student buying a second course reuses the same student record', async ({ request }) => {
    const email = `kurso.test+buyer-${randomUUID().slice(0, 8)}@example.com`
    const first = await seedSale({ email })
        const second = await seedSale({ creator: first.creator, email, gw: first.gw })
    await postWebhook(request, 'razorpay', captured(first), first.gw.webhookSecret)
    await postWebhook(request, 'razorpay', captured(second), first.gw.webhookSecret)
    const { data: students } = await db().from('students').select('id').eq('email', email)
    expect(students).toHaveLength(1)
    expect(await enrollmentsOf(first.course.id)).toHaveLength(1)
    expect(await enrollmentsOf(second.course.id)).toHaveLength(1)
  })
})

test.describe('forged or broken webhooks never grant access', () => {
  const noAccess = async (s: Sale) => {
    expect((await txnNow(s.txn.id)).status).toBe('pending')
    expect(await enrollmentsOf(s.course.id)).toHaveLength(0)
    expect(await paymentsOf(s.course.id)).toHaveLength(0)
  }

  test('wrong secret -> 400', async ({ request }) => {
    const s = await seedSale()
    const res = await postWebhook(request, 'razorpay', captured(s), s.gw.webhookSecret + '-wrong')
    expect(res.status()).toBe(400)
    expect((await res.json()).error).toBe('Invalid signature')
    await noAccess(s)
  })

  test('body changed after signing (price tampering) -> 400', async ({ request }) => {
    const s = await seedSale()
    const signedRaw = JSON.stringify(captured(s))
    const tampered = signedRaw.replace('49900', '100')
    const res = await request.post('/api/webhooks/razorpay', {
      data: tampered,
      headers: { 'content-type': 'application/json', ...signedHeaders('razorpay', signedRaw, s.gw.webhookSecret) },
    })
    expect(res.status()).toBe(400)
    await noAccess(s)
  })

  test('missing signature header -> 400', async ({ request }) => {
    const s = await seedSale()
    const res = await request.post('/api/webhooks/razorpay', { data: JSON.stringify(captured(s)), headers: { 'content-type': 'application/json' } })
    expect(res.status()).toBe(400)
    await noAccess(s)
  })

  test("another creator's secret cannot confirm this creator's order", async ({ request }) => {
    const victim = await seedSale()
    const attacker = await seedSale()
    const res = await postWebhook(request, 'razorpay', captured(victim), attacker.gw.webhookSecret)
    expect(res.status()).toBe(400)
    await noAccess(victim)
  })

  test('creator with NO webhook secret configured is rejected, never failed open', async ({ request }) => {
    const s = await seedSale()
    await db().from('creator_payment_gateways').update({ webhook_secret_encrypted: null }).eq('creator_id', s.creator.id)
    const res = await postWebhook(request, 'razorpay', captured(s), 'anything')
    expect(res.status()).toBe(400)
    expect((await res.json()).error).toBe('Webhook not configured for this account')
    await noAccess(s)
  })

  test('unknown order id is acknowledged but changes nothing', async ({ request }) => {
    const res = await postWebhook(request, 'razorpay', buildEvent('razorpay', { orderId: 'order_nope', amountRupees: 1 }), 'whatever')
    expect(res.status()).toBe(200)
    expect((await res.json()).matched).toBe(false)
  })
})

test.describe('other payment outcomes', () => {
  test('failed payment marks the transaction failed and grants nothing', async ({ request }) => {
    const s = await seedSale()
    const res = await postWebhook(request, 'razorpay', buildEvent('razorpay', { orderId: s.txn.gateway_order_id, amountRupees: 499, success: false }), s.gw.webhookSecret)
    expect((await res.json()).message).toBe('Marked failed')
    expect((await txnNow(s.txn.id)).status).toBe('failed')
    expect(await enrollmentsOf(s.course.id)).toHaveLength(0)
  })

  test('RULE (b): a payment that succeeds AFTER an earlier failure still grants access', async ({ request }) => {
    const s = await seedSale()
    await postWebhook(request, 'razorpay', buildEvent('razorpay', { orderId: s.txn.gateway_order_id, amountRupees: 499, success: false }), s.gw.webhookSecret)
    const res = await postWebhook(request, 'razorpay', captured(s), s.gw.webhookSecret)
    expect(res.status()).toBe(200)
    expect((await txnNow(s.txn.id)).status).toBe('success')
    expect(await enrollmentsOf(s.course.id)).toHaveLength(1)
  })

  test('an unrelated event type (payment.authorized) is ignored', async ({ request }) => {
    const s = await seedSale()
    const evt = { ...captured(s), event: 'payment.authorized' }
    const res = await postWebhook(request, 'razorpay', evt, s.gw.webhookSecret)
    expect(res.status()).toBe(200)
    expect((await res.json()).message).toMatch(/Ignored status/)
    expect((await txnNow(s.txn.id)).status).toBe('pending')
    expect(await enrollmentsOf(s.course.id)).toHaveLength(0)
  })
})

test.describe('amount safety net', () => {
  for (const [label, rupees] of [['underpaid', 1], ['overpaid', 999]] as const) {
    test(`${label} payment (₹${rupees} vs ₹499 order) is NOT activated`, async ({ request }) => {
      const s = await seedSale()
      const res = await postWebhook(request, 'razorpay', buildEvent('razorpay', { orderId: s.txn.gateway_order_id, amountRupees: rupees }), s.gw.webhookSecret)
      expect(res.status()).toBe(200)
      expect((await res.json()).message).toBe('Amount mismatch — not activated')
      const txn = await txnNow(s.txn.id)
      expect(txn.status).toBe('pending')
      expect(txn.error_message).toMatch(/Amount mismatch/)
      expect(await enrollmentsOf(s.course.id)).toHaveLength(0)
      expect(await paymentsOf(s.course.id)).toHaveLength(0)
    })
  }

  test('a mismatch does not poison the order: the correct amount afterwards still activates', async ({ request }) => {
    const s = await seedSale()
    await postWebhook(request, 'razorpay', buildEvent('razorpay', { orderId: s.txn.gateway_order_id, amountRupees: 1 }), s.gw.webhookSecret)
    const res = await postWebhook(request, 'razorpay', captured(s), s.gw.webhookSecret)
    expect((await res.json()).message).toBe('Enrollment activated')
    expect(await enrollmentsOf(s.course.id)).toHaveLength(1)
  })
})

test('a logged-in student who buys sees the enrollment under their own account', async ({ request }) => {
  const student = await createStudent()
  const s = await seedSale({ email: student.email })
  await db().from('transactions').update({ student_auth_id: student.auth_id, student_phone: student.phone }).eq('id', s.txn.id)
  await postWebhook(request, 'razorpay', captured(s), s.gw.webhookSecret)
  const [enr] = await enrollmentsOf(s.course.id)
  expect(enr.student_id).toBe(student.id)
  const me = await signedInClient(student.email, student.password)
  const { data } = await me.from('enrollments').select('id').eq('course_uuid', s.course.id)
  expect(data).toHaveLength(1) // visible through the real login, as in /my-courses
})