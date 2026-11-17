/**
 * API: paying for a webinar online (POST /api/workshops/checkout/create-order) and the rules around
 * registering again after a refund (POST /api/workshops/register).
 *
 * Rules:
 *  - Same entry rules as free/UPI registration: published, still open, valid phone, paid workshop only.
 *  - The creator needs a payment gateway. The price (and any coupon discount) is worked out on the server.
 *  - A seat is held for 30 minutes while paying; an abandoned attempt gives the seat back.
 *  - A coupon only works on its own webinar.
 *  - Someone whose registration was REFUNDED is told so, never shown a false "you're registered".
 * The test gateway keys are fake, so the real gateway call fails (502) AFTER our records are written.
 */
import { test, expect } from '@playwright/test'
import crypto from 'crypto'
import { db } from '../../helpers/admin-db'
import { accessToken } from '../../helpers/clients'
import { createCreator, createGateway, cleanup } from '../../helpers/factories'
import { createWorkshop, createRegistration } from '../../helpers/product-seed'
import { newPhone, cleanupCheckout } from '../../helpers/checkout-seed'

const ORDER = '/api/workshops/checkout/create-order'
const REGISTER = '/api/workshops/register'
let creator: any
let noGateway: any

test.beforeAll(async () => {
  creator = await createCreator()
  await createGateway(creator.id, 'razorpay', { credentials: { keyId: 'rzp_test_fake', keySecret: 'fake' } })
  noGateway = await createCreator()
})
test.afterAll(async () => { await cleanupCheckout(); await cleanup() })

const buyer = (workshopId: string, over: object = {}) => ({
  workshopId, name: 'Online Payer', email: `kurso.test+buyer-${crypto.randomBytes(4).toString('hex')}@example.com`, phone: newPhone(), ...over,
})
const order = (request: any, data: object) => request.post(ORDER, { data })
const txnsFor = async (workshopId: string) => (await db().from('transactions').select('*').eq('workshop_id', workshopId)).data ?? []
const regsFor = async (workshopId: string) => (await db().from('workshop_registrations').select('*').eq('workshop_id', workshopId)).data ?? []

test.describe('refused up front', () => {
  test('WCO-001 missing name/phone/workshop, missing email or a bad phone is a 400', async ({ request }) => {
    const w = await createWorkshop(creator.id, { price: 499 })
    expect((await order(request, { workshopId: w.id, phone: newPhone(), email: 'a@example.com' })).status()).toBe(400)
    expect((await order(request, buyer(w.id, { email: '' }))).status()).toBe(400)
    expect((await order(request, buyer(w.id, { phone: '123' }))).status()).toBe(400)
  })
  test('WCO-002 a draft or unknown workshop is a 404 and creates nothing', async ({ request }) => {
    const draft = await createWorkshop(creator.id, { price: 499, status: 'draft' })
    expect((await order(request, buyer(draft.id))).status()).toBe(404)
    expect((await order(request, buyer('00000000-0000-4000-8000-000000000000'))).status()).toBe(404)
    expect(await regsFor(draft.id)).toHaveLength(0)
    expect(await txnsFor(draft.id)).toHaveLength(0)
  })
  test('WCO-003 registration closed, or the webinar already ended, is a 409', async ({ request }) => {
    const closed = await createWorkshop(creator.id, { price: 499, closesAt: new Date(Date.now() - 3600_000).toISOString() })
    const ended = await createWorkshop(creator.id, { price: 499, startsInDays: -2 })
    expect((await order(request, buyer(closed.id))).status()).toBe(409)
    expect((await order(request, buyer(ended.id))).status()).toBe(409)
  })
  test('WCO-004 a FREE webinar has nothing to pay: 400', async ({ request }) => {
    const free = await createWorkshop(creator.id, { price: 0 })
    expect((await order(request, buyer(free.id))).status()).toBe(400)
  })
  test('WCO-005 a price above the gateway limit is refused (400)', async ({ request }) => {
    const huge = await createWorkshop(creator.id, { price: 100001 })
    expect((await order(request, buyer(huge.id))).status()).toBe(400)
  })
  test('WCO-006 a creator with no payment gateway is a 409 and nothing is created', async ({ request }) => {
    const w = await createWorkshop(noGateway.id, { price: 499 })
    expect((await order(request, buyer(w.id))).status()).toBe(409)
    expect(await regsFor(w.id)).toHaveLength(0)
    expect(await txnsFor(w.id)).toHaveLength(0)
  })
})

test.describe('starting a payment', () => {
  test('WCO-010 the price comes from the database; a price sent by the buyer is ignored', async ({ request }) => {
    const w = await createWorkshop(creator.id, { price: 499 })
    const body = buyer(w.id)
    const res = await order(request, { ...body, price: 1, amount: 1 })
    expect(res.status(), 'fake gateway keys make the gateway step fail').not.toBe(200)
    const [txn] = await txnsFor(w.id)
    expect(txn).toMatchObject({ product_type: 'workshop', creator_id: creator.id })
    expect(Number(txn.amount)).toBe(499)
    expect(Number(txn.original_amount)).toBe(499)
    const [reg] = await regsFor(w.id)
    expect(reg).toMatchObject({ payment_mode: 'gateway', payment_status: 'pending_confirmation' })
  })
  test('WCO-011 when the gateway step fails the transaction is marked failed and the seat hold is released', async ({ request }) => {
    const w = await createWorkshop(creator.id, { price: 499 })
    await order(request, buyer(w.id))
    expect((await txnsFor(w.id))[0].status).toBe('failed')
    expect((await regsFor(w.id))[0].payment_attempted_at).toBeNull()
  })
  test('WCO-012 an unfinished payment HOLDS the last seat for others; an abandoned one (over 30 minutes) does not', async ({ request }) => {
    const w = await createWorkshop(creator.id, { price: 499, capacity: 1 })
    const holder = await createRegistration(w.id, { status: 'pending_confirmation', mode: 'gateway' })
    await db().from('workshop_registrations').update({ payment_attempted_at: new Date().toISOString() }).eq('id', holder.id)
    expect((await order(request, buyer(w.id))).status(), 'seat is held by a payment in progress').toBe(409)

    await db().from('workshop_registrations').update({ payment_attempted_at: new Date(Date.now() - 2 * 3600_000).toISOString() }).eq('id', holder.id)
    expect((await order(request, buyer(w.id))).status(), 'abandoned hold no longer blocks').not.toBe(409)
  })
  test('WCO-013 a CONFIRMED attendee asking to pay again is told they are registered; no new payment is started and no token is returned', async ({ request }) => {
    const w = await createWorkshop(creator.id, { price: 499 })
    const attendee = await createRegistration(w.id, { status: 'confirmed', mode: 'gateway' })
    const res = await order(request, buyer(w.id, { phone: attendee.phone }))
    const body = await res.json()
    expect(body.alreadyRegistered).toBe(true)
    expect(body.telegramToken).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain(attendee.telegram_link_token)
    expect(await txnsFor(w.id)).toHaveLength(0)
  })
})

test.describe('coupons', () => {
  async function makeCoupon(request: any, workshopId: string, percent = 20) {
    const code = `TEST${crypto.randomBytes(3).toString('hex')}`.toUpperCase()
    const res = await request.post('/api/workshops/coupons', {
      headers: { authorization: `Bearer ${await accessToken(creator.email, creator.password)}` },
      data: { code, workshopId, percent, usageLimit: null, expiresOn: null },
    })
    expect(res.ok(), `coupon creation: ${await res.text()}`).toBe(true)
    return code
  }
  test('WCO-020 a valid coupon is applied on the server: amount, discount and code are recorded', async ({ request }) => {
    const w = await createWorkshop(creator.id, { price: 500 })
    const code = await makeCoupon(request, w.id, 20)
    await order(request, buyer(w.id, { couponCode: code }))
    const [txn] = await txnsFor(w.id)
    expect(Number(txn.amount)).toBe(400)
    expect(Number(txn.original_amount)).toBe(500)
    expect(Number(txn.discount_amount)).toBe(100)
    expect(txn.coupon_code).toBe(code)
  })
  test('WCO-021 an unknown coupon code is a 400 and creates nothing', async ({ request }) => {
    const w = await createWorkshop(creator.id, { price: 500 })
    expect((await order(request, buyer(w.id, { couponCode: 'NOSUCHCODE' }))).status()).toBe(400)
    expect(await regsFor(w.id)).toHaveLength(0)
    expect(await txnsFor(w.id)).toHaveLength(0)
  })
  test('WCO-022 a coupon made for ANOTHER webinar does not work here', async ({ request }) => {
    const mine = await createWorkshop(creator.id, { price: 500 })
    const other = await createWorkshop(creator.id, { price: 500 })
    const code = await makeCoupon(request, other.id, 50)
    expect((await order(request, buyer(mine.id, { couponCode: code }))).status()).toBe(400)
    expect(await txnsFor(mine.id)).toHaveLength(0)
  })
})

test.describe('registering again after a refund', () => {
  test('WS-015 a refunded attendee registering again (UPI) is told it was refunded: 409, and nothing is reset', async ({ request }) => {
    const w = await createWorkshop(creator.id, { price: 499 })
    const refunded = await createRegistration(w.id, { status: 'confirmed', mode: 'upi_manual', refundedAt: new Date().toISOString() })
    const res = await request.post(REGISTER, { data: { workshopId: w.id, name: 'Back Again', phone: refunded.phone, paymentMode: 'upi_manual' } })
    expect(res.status()).toBe(409)
    const after = (await db().from('workshop_registrations').select('refunded_at, name').eq('id', refunded.id).single()).data!
    expect(after.refunded_at).not.toBeNull()
    expect(after.name).toBe('Test Attendee')
  })
  test('WCO-030 the same for an online payment attempt: 409, and no new transaction', async ({ request }) => {
    const w = await createWorkshop(creator.id, { price: 499 })
    const refunded = await createRegistration(w.id, { status: 'confirmed', mode: 'gateway', refundedAt: new Date().toISOString() })
    const res = await order(request, buyer(w.id, { phone: refunded.phone }))
    expect(res.status()).toBe(409)
    expect(await txnsFor(w.id)).toHaveLength(0)
  })
})