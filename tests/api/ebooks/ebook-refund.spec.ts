/**
 * API: ebook refunds.
 *   Buyer (no login, knows the purchase link):  GET/POST /api/student/ebook-refund-request
 *   Creator (login):                            POST /api/creator/refund-requests
 *   Creator resets a buyer's downloads:         POST /api/creator/ebook-reset-downloads
 *
 * Rules:
 *  - Only a PAID purchase of an ebook that offers refunds, inside its refund window, can ask. One request per purchase.
 *  - Only the owning creator can decide. A request is decided once.
 *  - If the money cannot be refunded (no payment record, or the gateway refuses), nothing changes:
 *    the buyer keeps their download and no refund is recorded as done.
 *  - (c) Once refunded, the purchase can no longer be downloaded (covered by EBK-012 and EWH-009).
 */
import { test, expect } from '@playwright/test'
import { db } from '../../helpers/admin-db'
import { accessToken } from '../../helpers/clients'
import { createCreator, createGateway, cleanup } from '../../helpers/factories'
import { createEbook, createEbookPurchase } from '../../helpers/product-seed'
import { cleanupCheckout } from '../../helpers/checkout-seed'

const STUDENT = '/api/student/ebook-refund-request'
const CREATOR = '/api/creator/refund-requests'
const RESET = '/api/creator/ebook-reset-downloads'
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

async function purchase(o: { windowDays?: number; status?: string; ageDays?: number; downloadCount?: number } = {}) {
  const ebook = await createEbook(creator.id)
  await db().from('ebooks').update({ refund_window_days: o.windowDays ?? 7 }).eq('id', ebook.id)
  const p = await createEbookPurchase(creator.id, ebook.id, { status: o.status, downloadCount: o.downloadCount })
  if (o.ageDays) await db().from('transactions').update({ created_at: new Date(Date.now() - o.ageDays * 86_400_000).toISOString() }).eq('id', p.id)
  return { ebook, p }
}
const ask = (request: any, purchaseId: string, reason?: string) => request.post(STUDENT, { data: { purchaseId, reason } })
const decide = (request: any, headers: any, data: object) => request.post(CREATOR, { headers, data })
const requestFor = async (purchaseId: string) => (await db().from('refund_requests').select('*').eq('purchase_id', purchaseId).maybeSingle()).data
const txnNow = async (id: string) => (await db().from('transactions').select('*').eq('id', id).single()).data

test.describe('buyer asks for a refund', () => {
  test('ERF-001 missing purchase id is a 400; an unknown or unpaid purchase is not eligible', async ({ request }) => {
    expect((await request.get(STUDENT)).status()).toBe(400)
    expect((await request.post(STUDENT, { data: {} })).status()).toBe(400)
    const unknown = await (await request.get(`${STUDENT}?purchaseId=00000000-0000-4000-8000-000000000000`)).json()
    expect(unknown.eligible).toBe(false)
    const { p } = await purchase({ status: 'pending' })
    expect((await (await request.get(`${STUDENT}?purchaseId=${p.id}`)).json()).eligible).toBe(false)
    expect((await ask(request, p.id)).status()).toBe(400)
  })
  test('ERF-002 an ebook that offers no refunds refuses the request', async ({ request }) => {
    const { p } = await purchase({ windowDays: 0 })
    expect((await ask(request, p.id)).status()).toBe(400)
    expect(await requestFor(p.id)).toBeNull()
  })
  test('ERF-003 a paid purchase inside the window can ask once; a second ask is refused', async ({ request }) => {
    const { p } = await purchase()
    expect((await (await request.get(`${STUDENT}?purchaseId=${p.id}`)).json()).eligible).toBe(true)
    expect((await ask(request, p.id, 'Wrong book')).status()).toBe(200)
    expect(await requestFor(p.id)).toMatchObject({ type: 'ebook', status: 'pending', creator_id: creator.id, requested_by: 'student', reason: 'Wrong book' })
    expect((await ask(request, p.id)).status()).toBe(400)
  })
  test('ERF-004 after the window has closed (30 days old, 7 day window) the request is refused', async ({ request }) => {
    const { p } = await purchase({ ageDays: 30 })
    expect((await ask(request, p.id)).status()).toBe(400)
    expect(await requestFor(p.id)).toBeNull()
  })
  test('ERF-005 an already refunded purchase cannot ask again', async ({ request }) => {
    const { p } = await purchase({ status: 'refunded' })
    expect((await ask(request, p.id)).status()).toBe(400)
  })
})

test.describe('creator decides', () => {
  async function pendingRequest(request: any, o: Parameters<typeof purchase>[0] = {}) {
    const s = await purchase(o)
    await ask(request, s.p.id)
    return { ...s, row: await requestFor(s.p.id) }
  }
  test('ERF-010 no login is a 401; missing fields a 400; unknown request a 404', async ({ request }) => {
    expect((await request.post(CREATOR, { data: { requestId: 'x', decision: 'approved' } })).status()).toBe(401)
    expect((await decide(request, auth, {})).status()).toBe(400)
    expect((await decide(request, auth, { requestId: '00000000-0000-4000-8000-000000000000', decision: 'denied' })).status()).toBe(404)
  })
  test('ERF-011 ANOTHER creator cannot decide my request (403) and it stays pending', async ({ request }) => {
    const { row } = await pendingRequest(request)
    expect((await decide(request, rivalAuth, { requestId: row.id, decision: 'denied' })).status()).toBe(403)
    expect((await requestFor(row.purchase_id)).status).toBe('pending')
  })
  test('ERF-012 declining records the note and leaves the purchase intact; a second decision is refused', async ({ request }) => {
    const { p, row } = await pendingRequest(request)
    expect((await decide(request, auth, { requestId: row.id, decision: 'denied', note: 'Outside policy' })).status()).toBe(200)
    expect(await requestFor(p.id)).toMatchObject({ status: 'denied', decision_note: 'Outside policy' })
    expect((await txnNow(p.id)).status).toBe('success')
    expect((await decide(request, auth, { requestId: row.id, decision: 'approved' })).status()).toBe(400)
  })
  test('ERF-013 approving with NO payment record is refused (404): nothing changes', async ({ request }) => {
    const { p, row } = await pendingRequest(request)
    expect((await decide(request, auth, { requestId: row.id, decision: 'approved' })).status()).toBe(404)
    expect((await requestFor(p.id)).status).toBe('pending')
    expect((await txnNow(p.id)).status).toBe('success')
  })
  test('ERF-014 a refund the gateway rejects keeps the download and records no completed refund', async ({ request }) => {
    const { ebook, p, row } = await pendingRequest(request)
    const rrn = `pay_${Date.now()}`
    await db().from('transactions').update({ rrn }).eq('id', p.id)
    const { data: pay } = await db().from('payments').insert({
      creator_id: creator.id, product_type: 'ebook', ebook_id: ebook.id, provider: 'razorpay', provider_payment_id: rrn, provider_order_id: `order_${rrn}`,
      currency: 'INR', gross_amount: 299, discount_amount: 0, net_amount: 299, platform_fee: 0, creator_earning: 299, status: 'paid', paid_at: new Date().toISOString(),
    }).select().single()
    const res = await decide(request, auth, { requestId: row.id, decision: 'approved' })
    expect(res.status(), 'fake gateway keys: the gateway must refuse').not.toBe(200)
    expect((await txnNow(p.id)).status).toBe('success')
    expect((await txnNow(p.id)).ebook_download_limit).toBe(5)
    const refunds = (await db().from('refunds').select('status').eq('payment_id', pay!.id)).data ?? []
    expect(refunds.filter((r: any) => r.status === 'succeeded')).toHaveLength(0)
  })
  test('ERF-015 a refund larger than what was paid is refused (400)', async ({ request }) => {
    const { ebook, p, row } = await pendingRequest(request)
    const rrn = `pay_${Date.now()}`
    await db().from('transactions').update({ rrn }).eq('id', p.id)
    await db().from('payments').insert({
      creator_id: creator.id, product_type: 'ebook', ebook_id: ebook.id, provider: 'razorpay', provider_payment_id: rrn, provider_order_id: `order_${rrn}`,
      currency: 'INR', gross_amount: 299, discount_amount: 0, net_amount: 299, platform_fee: 0, creator_earning: 299, status: 'paid', paid_at: new Date().toISOString(),
    })
    expect((await decide(request, auth, { requestId: row.id, decision: 'approved', amount: 5000 })).status()).toBe(400)
    expect((await txnNow(p.id)).status).toBe('success')
  })
})

test.describe('resetting downloads', () => {
  test('ERF-020 the owner can reset a buyer\'s download count; another creator cannot; no login is a 401', async ({ request }) => {
    const { p } = await purchase({ downloadCount: 5 })
    expect((await request.post(RESET, { data: { purchaseId: p.id } })).status()).toBe(401)
    expect((await request.post(RESET, { headers: rivalAuth, data: { purchaseId: p.id } })).status()).toBe(404)
    expect((await txnNow(p.id)).ebook_download_count).toBe(5)
    expect((await request.post(RESET, { headers: auth, data: { purchaseId: p.id } })).status()).toBe(200)
    expect((await txnNow(p.id)).ebook_download_count).toBe(0)
  })
  test('ERF-021 resetting does NOT re-open a refunded purchase', async ({ request }) => {
    const { p } = await purchase({ status: 'refunded', downloadCount: 2 })
    await request.post(RESET, { headers: auth, data: { purchaseId: p.id } })
    expect((await request.get(`/api/ebook/download?purchaseId=${p.id}`)).status()).toBe(402)
  })
})