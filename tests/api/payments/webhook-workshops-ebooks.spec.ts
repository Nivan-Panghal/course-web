/**
 * API: payment webhooks for EBOOKS and WEBINARS (workshops). Route: POST /api/webhooks/<provider>.
 * Events are forged and signed with the creator's own webhook secret, like the course webhook tests.
 *
 * Rules:
 *  - A verified payment for the RIGHT amount grants access (ebook: download opens; webinar: seat confirmed).
 *  - A payment for the WRONG amount never grants access (stays pending for manual checking).
 *  - The same event delivered twice, or twice at once, grants access once and records one payment.
 *  - (b) A payment that arrives late (expired order, full webinar, paused webinar, lapsed creator) STILL grants access.
 *  - (c) A refunded purchase is never re-opened by a replayed webhook.
 *  - A forged or failed event never grants access.
 */
import { test, expect } from '@playwright/test'
import { db } from '../../helpers/admin-db'
import { createCreator, createGateway, createInvoice, cleanup } from '../../helpers/factories'
import { createRegistration } from '../../helpers/product-seed'
import { createEbookSale, createWorkshopSale, cleanupCheckout, Provider } from '../../helpers/checkout-seed'
import { buildEvent, postWebhook } from '../../helpers/signing'

test.afterAll(async () => {
  test.setTimeout(300_000) // this file creates ~25 test creators, so cleanup is long
  await cleanupCheckout()
  await cleanup()
})

const evt = (provider: Provider, txn: any, amount?: number, success = true) =>
  buildEvent(provider, { orderId: txn.gateway_order_id, amountRupees: amount ?? Number(txn.amount), success })

async function ebookSale(provider: Provider = 'razorpay', o: { price?: number; invoice?: boolean } = {}) {
  const creator = await createCreator()
  const gw = await createGateway(creator.id, provider)
  if (o.invoice) await createInvoice(creator.id, { status: 'overdue', productType: 'ebook' })
  const sale = await createEbookSale(creator.id, provider, { price: o.price })
  return { creator, gw, ...sale }
}
async function workshopSale(provider: Provider = 'razorpay', o: { price?: number; amount?: number; originalAmount?: number; discount?: number; capacity?: number | null; status?: string; invoice?: boolean } = {}) {
  const creator = await createCreator()
  const gw = await createGateway(creator.id, provider)
  if (o.invoice) await createInvoice(creator.id, { status: 'overdue', productType: 'course' })
  const sale = await createWorkshopSale(creator.id, provider, o)
  return { creator, gw, ...sale }
}
const txnNow = async (id: string) => (await db().from('transactions').select('*').eq('id', id).single()).data
const regNow = async (id: string) => (await db().from('workshop_registrations').select('*').eq('id', id).single()).data
const ebookPayments = async (ebookId: string) => (await db().from('payments').select('*').eq('ebook_id', ebookId)).data ?? []
const workshopPayments = async (regId: string) => (await db().from('payments').select('*').eq('workshop_registration_id', regId)).data ?? []

test.describe('ebook payment', () => {
  test('EWH-001 a correct payment marks the purchase paid and records the money', async ({ request }) => {
    const s = await ebookSale()
    const res = await postWebhook(request, 'razorpay', evt('razorpay', s.txn), s.gw.webhookSecret)
    expect(res.status()).toBe(200)
    expect((await txnNow(s.txn.id)).status).toBe('success')
    const [pay] = await ebookPayments(s.ebook.id)
    expect(pay).toMatchObject({ product_type: 'ebook', status: 'paid', provider: 'razorpay', creator_id: s.creator.id, gross_amount: 299, net_amount: 299 })
    // access now passes the payment check (the test PDF file does not exist, so the answer is NOT 402)
    expect((await request.get(`/api/ebook/download?purchaseId=${s.txn.id}`)).status()).not.toBe(402)
  })
  test('EWH-002 the same payment delivered twice records ONE payment', async ({ request }) => {
    const s = await ebookSale()
    const e = evt('razorpay', s.txn)
    await postWebhook(request, 'razorpay', e, s.gw.webhookSecret)
    const second = await postWebhook(request, 'razorpay', e, s.gw.webhookSecret)
    expect((await second.json()).message).toBe('Already processed')
    expect(await ebookPayments(s.ebook.id)).toHaveLength(1)
  })
  test('EWH-003 RACE: two simultaneous deliveries still end with one payment and a paid purchase', async ({ request }) => {
    const s = await ebookSale()
    const e = evt('razorpay', s.txn)
    const [a, b] = await Promise.all([postWebhook(request, 'razorpay', e, s.gw.webhookSecret), postWebhook(request, 'razorpay', e, s.gw.webhookSecret)])
    expect([a.status(), b.status()]).toContain(200)
    expect(await ebookPayments(s.ebook.id)).toHaveLength(1)
    expect((await txnNow(s.txn.id)).status).toBe('success')
  })
  test('EWH-004 a payment for the WRONG amount (₹1 for a ₹299 ebook) does not unlock the ebook', async ({ request }) => {
    const s = await ebookSale()
    const res = await postWebhook(request, 'razorpay', evt('razorpay', s.txn, 1), s.gw.webhookSecret)
    expect(res.status()).toBe(200)
    expect((await res.json()).message).toContain('Amount mismatch')
    expect((await txnNow(s.txn.id)).status).toBe('pending')
    expect(await ebookPayments(s.ebook.id)).toHaveLength(0)
    expect((await request.get(`/api/ebook/download?purchaseId=${s.txn.id}`)).status()).toBe(402)
  })
  test('EWH-005 a failed payment leaves no access', async ({ request }) => {
    const s = await ebookSale()
    await postWebhook(request, 'razorpay', evt('razorpay', s.txn, undefined, false), s.gw.webhookSecret)
    expect((await txnNow(s.txn.id)).status).toBe('failed')
    expect(await ebookPayments(s.ebook.id)).toHaveLength(0)
    expect((await request.get(`/api/ebook/download?purchaseId=${s.txn.id}`)).status()).toBe(402)
  })
  test('EWH-006 a forged signature is refused (400) and grants nothing', async ({ request }) => {
    const s = await ebookSale()
    const res = await postWebhook(request, 'razorpay', evt('razorpay', s.txn), s.gw.webhookSecret + '-wrong')
    expect(res.status()).toBe(400)
    expect((await txnNow(s.txn.id)).status).toBe('pending')
    expect(await ebookPayments(s.ebook.id)).toHaveLength(0)
  })
  test('EWH-007 (b) a payment that arrives AFTER the order was marked expired still grants the ebook', async ({ request }) => {
    const s = await ebookSale()
    await db().from('transactions').update({ status: 'expired' }).eq('id', s.txn.id)
    await postWebhook(request, 'razorpay', evt('razorpay', s.txn), s.gw.webhookSecret)
    expect((await txnNow(s.txn.id)).status).toBe('success')
    expect(await ebookPayments(s.ebook.id)).toHaveLength(1)
  })
  test('EWH-008 (b) a payment still grants the ebook when the creator is lapsed (overdue ebook invoice)', async ({ request }) => {
    const s = await ebookSale('razorpay', { invoice: true })
    await postWebhook(request, 'razorpay', evt('razorpay', s.txn), s.gw.webhookSecret)
    expect((await txnNow(s.txn.id)).status).toBe('success')
  })
  test('EWH-009 (c) a REPLAYED payment event cannot re-open a refunded purchase', async ({ request }) => {
    const s = await ebookSale()
    const e = evt('razorpay', s.txn)
    await postWebhook(request, 'razorpay', e, s.gw.webhookSecret)
    await db().from('transactions').update({ status: 'refunded', ebook_download_limit: 0 }).eq('id', s.txn.id)
    const replay = await postWebhook(request, 'razorpay', e, s.gw.webhookSecret)
    expect(replay.status(), 'a replay must be answered 200, not 500, or the gateway keeps retrying for days').toBe(200)
    expect((await txnNow(s.txn.id)).status).toBe('refunded')
    expect(await ebookPayments(s.ebook.id)).toHaveLength(1)
    expect((await request.get(`/api/ebook/download?purchaseId=${s.txn.id}`)).status()).toBe(402)
  })
  test('EWH-010 Cashfree: a correct payment works the same way', async ({ request }) => {
    const s = await ebookSale('cashfree')
    const res = await postWebhook(request, 'cashfree', evt('cashfree', s.txn), s.gw.webhookSecret)
    expect(res.status()).toBe(200)
    expect((await txnNow(s.txn.id)).status).toBe('success')
    expect((await ebookPayments(s.ebook.id))[0]).toMatchObject({ provider: 'cashfree', net_amount: 299 })
  })
  test('EWH-011 Cashfree: the wrong amount is refused too', async ({ request }) => {
    const s = await ebookSale('cashfree')
    const res = await postWebhook(request, 'cashfree', evt('cashfree', s.txn, 10), s.gw.webhookSecret)
    expect((await res.json()).message).toContain('Amount mismatch')
    expect((await txnNow(s.txn.id)).status).toBe('pending')
  })
})

test.describe('webinar payment', () => {
  test('WWH-001 a correct payment confirms the seat and records the money', async ({ request }) => {
    const s = await workshopSale()
    const res = await postWebhook(request, 'razorpay', evt('razorpay', s.txn), s.gw.webhookSecret)
    expect(res.status()).toBe(200)
    expect((await txnNow(s.txn.id)).status).toBe('success')
    const reg = await regNow(s.reg.id)
    expect(reg).toMatchObject({ payment_status: 'confirmed', payment_mode: 'gateway', amount_paid: 499, transaction_id: s.txn.id })
    expect(reg.confirmed_at).toBeTruthy()
    const [pay] = await workshopPayments(s.reg.id)
    expect(pay).toMatchObject({ product_type: 'workshop', status: 'paid', creator_id: s.creator.id, gross_amount: 499, net_amount: 499, platform_fee: 25, creator_earning: 474 })
    // webinars pay the standard 5% share (the course invoice covers them): 5% of 499 = 25
  })

    test('WWH-013 the buyer gets a numbered invoice for the webinar payment', async ({ request }) => {
    const s = await workshopSale()
    await postWebhook(request, 'razorpay', evt('razorpay', s.txn), s.gw.webhookSecret)
    const [pay] = await workshopPayments(s.reg.id)
    // the invoice is written just after the response, so wait for it
    await expect.poll(async () => (await db().from('invoices').select('id').eq('payment_id', pay.id)).data?.length ?? 0, { timeout: 15_000 }).toBe(1)
    const [inv] = (await db().from('invoices').select('*').eq('payment_id', pay.id)).data!
    expect(inv).toMatchObject({ product_type: 'workshop', workshop_id: s.workshop.id, creator_id: s.creator.id })
    expect(Number(inv.amount)).toBe(499)
  })
  test('WWH-002 the same payment delivered twice records ONE payment', async ({ request }) => {
    const s = await workshopSale()
    const e = evt('razorpay', s.txn)
    await postWebhook(request, 'razorpay', e, s.gw.webhookSecret)
    const second = await postWebhook(request, 'razorpay', e, s.gw.webhookSecret)
    expect((await second.json()).message).toBe('Already processed')
    expect(await workshopPayments(s.reg.id)).toHaveLength(1)
  })
  test('WWH-003 RACE: two simultaneous deliveries still end with one payment and a confirmed seat', async ({ request }) => {
    const s = await workshopSale()
    const e = evt('razorpay', s.txn)
    const [a, b] = await Promise.all([postWebhook(request, 'razorpay', e, s.gw.webhookSecret), postWebhook(request, 'razorpay', e, s.gw.webhookSecret)])
    expect([a.status(), b.status()]).toContain(200)
    expect(await workshopPayments(s.reg.id)).toHaveLength(1)
    expect((await regNow(s.reg.id)).payment_status).toBe('confirmed')
  })
  test('WWH-004 a payment for the WRONG amount (₹1 for a ₹499 webinar) does not confirm the seat', async ({ request }) => {
    const s = await workshopSale()
    const res = await postWebhook(request, 'razorpay', evt('razorpay', s.txn, 1), s.gw.webhookSecret)
    expect((await res.json()).message).toContain('Amount mismatch')
    expect((await txnNow(s.txn.id)).status).toBe('pending')
    expect((await regNow(s.reg.id)).payment_status).toBe('pending_confirmation')
    expect(await workshopPayments(s.reg.id)).toHaveLength(0)
  })
  test('WWH-005 with a coupon, the payment records the listed price, the discount and what was paid', async ({ request }) => {
    const s = await workshopSale('razorpay', { price: 500, amount: 400, originalAmount: 500, discount: 100 })
    await postWebhook(request, 'razorpay', evt('razorpay', s.txn), s.gw.webhookSecret)
    const [pay] = await workshopPayments(s.reg.id)
    expect(pay).toMatchObject({ gross_amount: 500, discount_amount: 100, net_amount: 400 })
    expect((await regNow(s.reg.id)).amount_paid).toBe(400)
  })
  test('WWH-006 a failed payment leaves the registration unpaid', async ({ request }) => {
    const s = await workshopSale()
    await postWebhook(request, 'razorpay', evt('razorpay', s.txn, undefined, false), s.gw.webhookSecret)
    expect((await txnNow(s.txn.id)).status).toBe('failed')
    expect((await regNow(s.reg.id)).payment_status).toBe('pending_confirmation')
    expect(await workshopPayments(s.reg.id)).toHaveLength(0)
  })
  test('WWH-007 a forged signature is refused (400) and confirms nothing', async ({ request }) => {
    const s = await workshopSale()
    const res = await postWebhook(request, 'razorpay', evt('razorpay', s.txn), s.gw.webhookSecret + '-wrong')
    expect(res.status()).toBe(400)
    expect((await regNow(s.reg.id)).payment_status).toBe('pending_confirmation')
  })
  test('WWH-008 (b) money taken after the seat hold expired and the webinar filled up STILL confirms the person', async ({ request }) => {
    const s = await workshopSale('razorpay', { capacity: 1 })
    await db().from('workshop_registrations').update({ payment_attempted_at: new Date(Date.now() - 2 * 3600_000).toISOString() }).eq('id', s.reg.id)
    await createRegistration(s.workshop.id, { status: 'confirmed' }) // someone else took the last seat meanwhile
    await postWebhook(request, 'razorpay', evt('razorpay', s.txn), s.gw.webhookSecret)
    expect((await regNow(s.reg.id)).payment_status).toBe('confirmed')
  })
  test('WWH-009 (b) a payment for a webinar that was paused or unpublished meanwhile still confirms', async ({ request }) => {
    const s = await workshopSale('razorpay', { status: 'draft' })
    await postWebhook(request, 'razorpay', evt('razorpay', s.txn), s.gw.webhookSecret)
    expect((await regNow(s.reg.id)).payment_status).toBe('confirmed')
  })
  test('WWH-010 (b) a payment still confirms when the creator is lapsed (overdue course invoice)', async ({ request }) => {
    const s = await workshopSale('razorpay', { invoice: true })
    await postWebhook(request, 'razorpay', evt('razorpay', s.txn), s.gw.webhookSecret)
    expect((await regNow(s.reg.id)).payment_status).toBe('confirmed')
  })
  test('WWH-011 (c) a REPLAYED payment event cannot re-confirm a refunded registration', async ({ request }) => {
    const s = await workshopSale()
    const e = evt('razorpay', s.txn)
    await postWebhook(request, 'razorpay', e, s.gw.webhookSecret)
    const refundedAt = new Date().toISOString()
    await db().from('workshop_registrations').update({ refunded_at: refundedAt }).eq('id', s.reg.id)
    const replay = await postWebhook(request, 'razorpay', e, s.gw.webhookSecret)
    expect(replay.status()).toBe(200)
    expect((await regNow(s.reg.id)).refunded_at).not.toBeNull()
    expect(await workshopPayments(s.reg.id)).toHaveLength(1)
  })
  test('WWH-012 Cashfree: a correct payment confirms the seat, a wrong amount does not', async ({ request }) => {
    const ok = await workshopSale('cashfree')
    await postWebhook(request, 'cashfree', evt('cashfree', ok.txn), ok.gw.webhookSecret)
    expect((await regNow(ok.reg.id)).payment_status).toBe('confirmed')
    const bad = await workshopSale('cashfree')
    const res = await postWebhook(request, 'cashfree', evt('cashfree', bad.txn, 10), bad.gw.webhookSecret)
    expect((await res.json()).message).toContain('Amount mismatch')
    expect((await regNow(bad.reg.id)).payment_status).toBe('pending_confirmation')
  })
})