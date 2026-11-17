/**
 * API: webinar refunds.
 *   Student side (no login, private link token):  GET/POST /api/workshops/refund
 *   Creator side (login):                         GET/POST /api/workshops/refunds
 *
 * Rules:
 *  - Only a confirmed, PAID, not-yet-refunded registration can ask, and only until 7 days after the webinar starts.
 *  - One request per registration. The private link token never exposes anyone's phone, email or meeting link.
 *  - Only the owning creator can decide. A request is decided once; a double tap never sends two refunds.
 *  - UPI payments cannot be refunded by Kurso: the creator refunds by hand and marks it. That removes the
 *    student's seat immediately (rule c) and gives the seat back to the webinar.
 *  - If the payment gateway refuses a refund, NO money is recorded as moved, the student keeps their seat,
 *    and the request goes back to pending.
 */
import { test, expect } from '@playwright/test'
import { db } from '../../helpers/admin-db'
import { accessToken } from '../../helpers/clients'
import { createCreator, createGateway, cleanup } from '../../helpers/factories'
import { createWorkshop, createRegistration } from '../../helpers/product-seed'
import { withReviewToken, createWorkshopPayment, newPhone, cleanupCheckout } from '../../helpers/checkout-seed'

const STUDENT = '/api/workshops/refund'
const CREATOR = '/api/workshops/refunds'
let creator: any
let rival: any
let auth: { authorization: string }
let rivalAuth: { authorization: string }

test.beforeAll(async () => {
  creator = await createCreator()
  rival = await createCreator()
  await createGateway(creator.id, 'razorpay', { credentials: { keyId: 'rzp_test_fake', keySecret: 'fake' } })
  auth = { authorization: `Bearer ${await accessToken(creator.email, creator.password)}` }
  rivalAuth = { authorization: `Bearer ${await accessToken(rival.email, rival.password)}` }
})
test.afterAll(async () => { await cleanupCheckout(); await cleanup() })

/** A paid (UPI, confirmed) registration with its private link token. */
async function paidAttendee(o: { startsInDays?: number; mode?: 'upi_manual' | 'gateway' | 'free'; refundedAt?: string | null; status?: 'confirmed' | 'pending_confirmation'; capacity?: number | null } = {}) {
  const workshop = await createWorkshop(creator.id, { price: o.mode === 'free' ? 0 : 499, startsInDays: o.startsInDays ?? 7, capacity: o.capacity })
  const reg = await withReviewToken(await createRegistration(workshop.id, { status: o.status ?? 'confirmed', mode: o.mode ?? 'upi_manual', refundedAt: o.refundedAt ?? null }))
  return { workshop, reg }
}
const ask = (request: any, token: string, reason?: string) => request.post(STUDENT, { data: { token, reason } })
const decide = (request: any, headers: any, data: object) => request.post(CREATOR, { headers, data })
const requestRow = async (regId: string) => (await db().from('refund_requests').select('*').eq('workshop_registration_id', regId).maybeSingle()).data
const regNow = async (id: string) => (await db().from('workshop_registrations').select('*').eq('id', id).single()).data

test.describe('student asks for a refund', () => {
  test('WRF-001 an unknown or malformed link token is a 404 (GET and POST)', async ({ request }) => {
    for (const token of ['nope', '00000000-0000-4000-8000-000000000000', '']) {
      expect((await request.get(`${STUDENT}?token=${token}`)).status(), token).toBe(404)
      expect((await ask(request, token)).status(), token).toBe(404)
    }
  })
  test('WRF-002 the link shows only what the page needs: no phone, email or meeting link', async ({ request }) => {
    const { reg } = await paidAttendee()
    const res = await request.get(`${STUDENT}?token=${reg.review_token}`)
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ canRequest: true, amount: 499, isGateway: false })
    const text = JSON.stringify(body)
    for (const secret of [reg.phone, reg.email, 'zoom', reg.telegram_link_token]) expect(text).not.toContain(secret)
  })
  test('WRF-003 a paid, confirmed attendee can ask once; a second ask is a 409', async ({ request }) => {
    const { reg } = await paidAttendee()
    expect((await ask(request, reg.review_token, 'Cannot attend')).status()).toBe(200)
    const row = await requestRow(reg.id)
    expect(row).toMatchObject({ type: 'workshop', status: 'pending', creator_id: creator.id, requested_by: 'student', reason: 'Cannot attend' })
    expect((await ask(request, reg.review_token)).status()).toBe(409)
  })
  test('WRF-004 a free registration, an unpaid one and an already refunded one are all refused (403)', async ({ request }) => {
    const free = await paidAttendee({ mode: 'free' })
    const unpaid = await paidAttendee({ status: 'pending_confirmation' })
    const refunded = await paidAttendee({ refundedAt: new Date().toISOString() })
    for (const a of [free, unpaid, refunded]) {
      expect((await ask(request, a.reg.review_token)).status()).toBe(403)
      expect(await requestRow(a.reg.id)).toBeNull()
    }
  })
  test('WRF-005 the 7-day window: asking 3 days after the webinar works, 10 days after is refused', async ({ request }) => {
    const inside = await paidAttendee({ startsInDays: -3 })
    const outside = await paidAttendee({ startsInDays: -10 })
    expect((await ask(request, inside.reg.review_token)).status()).toBe(200)
    expect((await ask(request, outside.reg.review_token)).status()).toBe(403)
  })
  test('WRF-006 a reason longer than 500 characters is a 400', async ({ request }) => {
    const { reg } = await paidAttendee()
    expect((await ask(request, reg.review_token, 'x'.repeat(501))).status()).toBe(400)
    expect(await requestRow(reg.id)).toBeNull()
  })
})

test.describe('creator decides', () => {
  test('WRF-010 no login is a 401 (list and decide)', async ({ request }) => {
    expect((await request.get(CREATOR)).status()).toBe(401)
    expect((await request.post(CREATOR, { data: { requestId: 'x', decision: 'approved' } })).status()).toBe(401)
  })
  test('WRF-011 the list shows only MY requests', async ({ request }) => {
    const { reg } = await paidAttendee()
    await ask(request, reg.review_token)
    const mine = (await (await request.get(CREATOR, { headers: auth })).json()).requests
    expect(mine.map((r: any) => r.name)).toContain(reg.name)
    const theirs = (await (await request.get(CREATOR, { headers: rivalAuth })).json()).requests
    expect(theirs).toHaveLength(0)
  })
  test('WRF-012 missing or invalid fields are a 400', async ({ request }) => {
    expect((await decide(request, auth, {})).status()).toBe(400)
    expect((await decide(request, auth, { requestId: 'x', decision: 'maybe' })).status()).toBe(400)
  })
  test('WRF-013 ANOTHER creator cannot decide my request (403) and it stays pending', async ({ request }) => {
    const { reg } = await paidAttendee()
    await ask(request, reg.review_token)
    const row = await requestRow(reg.id)
    expect((await decide(request, rivalAuth, { requestId: row.id, decision: 'approved', manual: true })).status()).toBe(403)
    expect((await requestRow(reg.id)).status).toBe('pending')
    expect((await regNow(reg.id)).refunded_at).toBeNull()
  })
  test('WRF-014 declining keeps the seat and records the note', async ({ request }) => {
    const { reg } = await paidAttendee()
    await ask(request, reg.review_token)
    const row = await requestRow(reg.id)
    expect((await decide(request, auth, { requestId: row.id, decision: 'denied', note: 'Outside policy' })).status()).toBe(200)
    expect(await requestRow(reg.id)).toMatchObject({ status: 'denied', decision_note: 'Outside policy' })
    expect((await regNow(reg.id)).refunded_at).toBeNull()
  })
  test('WRF-015 (c) approving a UPI refund by hand removes the seat at once and gives it back to the webinar', async ({ request }) => {
    const { workshop, reg } = await paidAttendee({ capacity: 1 })
    const newcomer = { workshopId: workshop.id, name: 'Next In Line', phone: newPhone(), paymentMode: 'upi_manual' }
    expect((await request.post('/api/workshops/register', { data: newcomer })).status(), 'webinar is full before the refund').toBe(409)

    await ask(request, reg.review_token)
    const row = await requestRow(reg.id)
    const res = await decide(request, auth, { requestId: row.id, decision: 'approved', manual: true })
    expect(res.status()).toBe(200)
    expect(await requestRow(reg.id)).toMatchObject({ status: 'completed' })
    expect((await regNow(reg.id)).refunded_at).not.toBeNull()
    expect((await request.post('/api/workshops/register', { data: newcomer })).status(), 'the refunded seat is free again').toBe(200)
  })
  test('WRF-016 approving a UPI payment WITHOUT marking it as refunded by hand is a 400 and the request returns to pending', async ({ request }) => {
    const { reg } = await paidAttendee()
    await ask(request, reg.review_token)
    const row = await requestRow(reg.id)
    expect((await decide(request, auth, { requestId: row.id, decision: 'approved' })).status()).toBe(400)
    expect((await requestRow(reg.id)).status).toBe('pending')
    expect((await regNow(reg.id)).refunded_at).toBeNull()
  })
  test('WRF-017 deciding the same request twice is refused the second time', async ({ request }) => {
    const { reg } = await paidAttendee()
    await ask(request, reg.review_token)
    const row = await requestRow(reg.id)
    expect((await decide(request, auth, { requestId: row.id, decision: 'approved', manual: true })).status()).toBe(200)
    expect((await decide(request, auth, { requestId: row.id, decision: 'approved', manual: true })).status()).toBe(400)
  })
  test('WRF-018 two simultaneous approvals: exactly one succeeds', async ({ request }) => {
    const { reg } = await paidAttendee()
    await ask(request, reg.review_token)
    const row = await requestRow(reg.id)
    const results = await Promise.all([1, 2].map(() => decide(request, auth, { requestId: row.id, decision: 'approved', manual: true })))
    expect(results.filter((r) => r.status() === 200)).toHaveLength(1)
  })
  test('WRF-019 an online refund the gateway rejects moves no money, keeps the seat and re-opens the request', async ({ request }) => {
    const { workshop, reg } = await paidAttendee({ mode: 'gateway' })
    await db().from('workshop_registrations').update({ amount_paid: 499 }).eq('id', reg.id)
    const payment = await createWorkshopPayment(creator.id, workshop.id, reg.id, { amount: 499 })
    await ask(request, reg.review_token)
    const row = await requestRow(reg.id)
    const res = await decide(request, auth, { requestId: row.id, decision: 'approved' })
    expect(res.status(), 'fake gateway keys: the gateway must refuse').not.toBe(200)
    expect((await requestRow(reg.id)).status).toBe('pending')
    expect((await regNow(reg.id)).refunded_at).toBeNull()
    const refunds = (await db().from('refunds').select('status').eq('payment_id', payment.id)).data ?? []
    expect(refunds.filter((r: any) => r.status === 'succeeded')).toHaveLength(0)
  })
  test('WRF-020 a refund larger than what was paid is refused (400)', async ({ request }) => {
    const { workshop, reg } = await paidAttendee({ mode: 'gateway' })
    await db().from('workshop_registrations').update({ amount_paid: 499 }).eq('id', reg.id)
    await createWorkshopPayment(creator.id, workshop.id, reg.id, { amount: 499 })
    await ask(request, reg.review_token)
    const row = await requestRow(reg.id)
    expect((await decide(request, auth, { requestId: row.id, decision: 'approved', amount: 5000 })).status()).toBe(400)
    expect((await regNow(reg.id)).refunded_at).toBeNull()
  })
})