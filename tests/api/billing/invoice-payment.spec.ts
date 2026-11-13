/**
 * API: a creator paying Kurso's monthly revenue-share invoice via KURSO's own Cashfree account.
 *  - Pay route:  POST /api/creator/revenue-share/pay  (creates the Cashfree order)
 *  - Webhook:    POST /api/cashfree/kurso-webhook      (marks paid, re-opens paused courses)
 * Webhook signing uses KURSO_CASHFREE_CLIENT_SECRET from .env.test.
 * Key rule: paying re-opens ONLY courses that were auto-paused for non-payment
 * (auto_unpublished_reason = 'revenue_share_overdue'), never a course the creator drafted.
 */
import { test, expect, APIRequestContext } from '@playwright/test'
import { db } from '../../helpers/admin-db'
import { accessToken } from '../../helpers/clients'
import { createCreator, createCourse, createInvoice, cleanup } from '../../helpers/factories'
import { buildEvent, signedHeaders } from '../../helpers/signing'

const PAY = '/api/creator/revenue-share/pay'
const HOOK = '/api/cashfree/kurso-webhook'
const KURSO_SECRET = process.env.KURSO_CASHFREE_CLIENT_SECRET!
const haveKurso = !!(process.env.KURSO_CASHFREE_CLIENT_ID && process.env.KURSO_CASHFREE_CLIENT_SECRET)

test.afterAll(async () => { await cleanup() })

async function creatorWithToken() {
  const creator = await createCreator()
  const token = await accessToken(creator.email, creator.password)
  return { creator, headers: { authorization: `Bearer ${token}` } }
}
async function pausedCourse(creatorId: string) {
  const c = await createCourse(creatorId, { published: false })
  await db().from('courses').update({ auto_unpublished_at: new Date().toISOString(), auto_unpublished_reason: 'revenue_share_overdue' }).eq('id', c.id)
  return c
}
const courseNow = async (id: string) => (await db().from('courses').select('is_published, auto_unpublished_at, auto_unpublished_reason').eq('id', id).single()).data
const invoiceNow = async (id: string) => (await db().from('revenue_share_invoices').select('*').eq('id', id).single()).data
async function kursoHook(request: APIRequestContext, evt: object, secret = KURSO_SECRET) {
  const raw = JSON.stringify(evt)
  return request.post(HOOK, { data: raw, headers: { 'content-type': 'application/json', ...signedHeaders('cashfree', raw, secret) } })
}

test.describe('paying an invoice: who and when', () => {
  test('no login -> 401', async ({ request }) => {
    expect((await request.post(PAY, { data: { invoiceId: 'x' } })).status()).toBe(401)
  })
  test('missing invoiceId -> 400', async ({ request }) => {
    const { headers } = await creatorWithToken()
    const res = await request.post(PAY, { headers, data: {} })
    expect(res.status()).toBe(400)
    expect((await res.json()).error).toBe('invoiceId is required')
  })
  test("another creator's invoice -> 404", async ({ request }) => {
    const owner = await createCreator()
    const invoice = await createInvoice(owner.id)
    const { headers } = await creatorWithToken()
    const res = await request.post(PAY, { headers, data: { invoiceId: invoice.id } })
    expect(res.status()).toBe(404)
    expect((await res.json()).error).toBe('Invoice not found')
  })
  test('already-paid invoice -> 400', async ({ request }) => {
    const { creator, headers } = await creatorWithToken()
    const invoice = await createInvoice(creator.id, { status: 'paid' })
    const res = await request.post(PAY, { headers, data: { invoiceId: invoice.id } })
    expect(res.status()).toBe(400)
    expect((await res.json()).error).toMatch(/already paid/)
  })
  test('waived invoice -> 400', async ({ request }) => {
    const { creator, headers } = await creatorWithToken()
    const invoice = await createInvoice(creator.id, { status: 'waived' })
    const res = await request.post(PAY, { headers, data: { invoiceId: invoice.id } })
    expect(res.status()).toBe(400)
    expect((await res.json()).error).toMatch(/waived/)
  })
  test('nothing due (₹0) -> 400', async ({ request }) => {
    const { creator, headers } = await creatorWithToken()
    const invoice = await createInvoice(creator.id, { status: 'not_due', amount: 0 })
    const res = await request.post(PAY, { headers, data: { invoiceId: invoice.id } })
    expect(res.status()).toBe(400)
    expect((await res.json()).error).toMatch(/Nothing due/)
  })
})

test.describe('paying an invoice: order creation [network]', () => {
  test('creates a Cashfree order for the invoice and remembers its order id', async ({ request }) => {
    test.skip(!haveKurso, 'Set KURSO_CASHFREE_CLIENT_ID / SECRET in .env.test')
    const { creator, headers } = await creatorWithToken()
    const invoice = await createInvoice(creator.id, { amount: 1500, orderId: null })
    const res = await request.post(PAY, { headers, data: { invoiceId: invoice.id } })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.orderId).toBe(invoice.id)
    expect(body.paymentSessionId).toBeTruthy()
    expect(body.amount).toBe(1500)
    expect((await invoiceNow(invoice.id)).gateway_order_id).toBe(body.orderId)
  })

  test('RETRY: clicking Pay a second time (closed the tab) still gives a usable payment session', async ({ request }) => {
    test.skip(!haveKurso, 'Set KURSO_CASHFREE_CLIENT_ID / SECRET in .env.test')
    const { creator, headers } = await creatorWithToken()
    const invoice = await createInvoice(creator.id, { amount: 1500, orderId: null })
    await request.post(PAY, { headers, data: { invoiceId: invoice.id } })
    const second = await request.post(PAY, { headers, data: { invoiceId: invoice.id } })
    expect(second.status()).toBe(200)
    expect((await second.json()).paymentSessionId).toBeTruthy()
  })
})

test.describe('Kurso invoice webhook', () => {
  test.beforeAll(() => { if (!KURSO_SECRET) throw new Error('KURSO_CASHFREE_CLIENT_SECRET missing in .env.test') })

  test('wrong signature -> 400; missing headers -> 400', async ({ request }) => {
    const evt = buildEvent('cashfree', { orderId: 'whatever', amountRupees: 1 })
    expect((await kursoHook(request, evt, KURSO_SECRET + 'x')).status()).toBe(400)
    const noHeaders = await request.post(HOOK, { data: JSON.stringify(evt), headers: { 'content-type': 'application/json' } })
    expect(noHeaders.status()).toBe(400)
  })

  test('unknown order id is acknowledged but changes nothing', async ({ request }) => {
    const res = await kursoHook(request, buildEvent('cashfree', { orderId: 'inv_nope', amountRupees: 1 }))
    expect(res.status()).toBe(200)
    expect((await res.json()).matched).toBe(false)
  })

  test('SUCCESS marks the invoice paid and re-opens ONLY auto-paused courses', async ({ request }) => {
    const creator = await createCreator()
    const invoice = await createInvoice(creator.id, { status: 'overdue', amount: 1500 })
    const paused = await pausedCourse(creator.id)
    const draft = await createCourse(creator.id, { published: false }) // creator's own draft
    const live = await createCourse(creator.id, { published: true })

    const res = await kursoHook(request, buildEvent('cashfree', { orderId: invoice.gateway_order_id, amountRupees: 1500 }))
    expect((await res.json()).message).toBe('Revenue-share invoice paid')

    const inv = await invoiceNow(invoice.id)
    expect(inv.status).toBe('paid')
    expect(inv.paid_at).toBeTruthy()
    expect(await courseNow(paused.id)).toEqual({ is_published: true, auto_unpublished_at: null, auto_unpublished_reason: null })
    expect((await courseNow(draft.id))?.is_published).toBe(false) // stays a draft
    expect((await courseNow(live.id))?.is_published).toBe(true)
  })

  test("paying does not touch another creator's paused courses", async ({ request }) => {
    const payer = await createCreator()
    const other = await createCreator()
    const invoice = await createInvoice(payer.id, { amount: 1500 })
    const othersPaused = await pausedCourse(other.id)
    await kursoHook(request, buildEvent('cashfree', { orderId: invoice.gateway_order_id, amountRupees: 1500 }))
    expect((await courseNow(othersPaused.id))?.is_published).toBe(false)
  })

  test('delivered twice -> Already processed', async ({ request }) => {
    const creator = await createCreator()
    const invoice = await createInvoice(creator.id, { amount: 1500 })
    const evt = buildEvent('cashfree', { orderId: invoice.gateway_order_id, amountRupees: 1500 })
    await kursoHook(request, evt)
    const second = await kursoHook(request, evt)
    expect((await second.json()).message).toBe('Already processed')
  })

  test('FAILED payment leaves the invoice unpaid and courses paused', async ({ request }) => {
    const creator = await createCreator()
    const invoice = await createInvoice(creator.id, { status: 'overdue', amount: 1500 })
    const paused = await pausedCourse(creator.id)
    const evt: any = buildEvent('cashfree', { orderId: invoice.gateway_order_id, amountRupees: 1500 })
    evt.data.payment.payment_status = 'FAILED'
    expect((await (await kursoHook(request, evt)).json()).message).toBe('Marked FAILED')
    expect((await invoiceNow(invoice.id)).status).toBe('overdue')
    expect((await courseNow(paused.id))?.is_published).toBe(false)
  })

  test('amount mismatch does NOT mark the invoice paid or re-open courses', async ({ request }) => {
    const creator = await createCreator()
    const invoice = await createInvoice(creator.id, { status: 'overdue', amount: 1500 })
    const paused = await pausedCourse(creator.id)
    const res = await kursoHook(request, buildEvent('cashfree', { orderId: invoice.gateway_order_id, amountRupees: 1 }))
    expect((await res.json()).message).toBe('Amount mismatch — not marked paid')
    expect((await invoiceNow(invoice.id)).status).toBe('overdue')
    expect((await courseNow(paused.id))?.is_published).toBe(false)
  })
})