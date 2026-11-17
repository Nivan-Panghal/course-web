/**
 * API: the daily billing cron (/api/cron/subscription-reminders) and the invoice payment webhook,
 * for WEBINARS and EBOOKS (the course version is in overdue-sweep.spec.ts / invoice-payment.spec.ts).
 *
 * Rules:
 *  - An overdue COURSE invoice (it also covers webinar revenue) pauses the creator's published courses AND webinars
 *    (reason 'revenue_share_overdue'). Their ebooks are never touched.
 *  - An overdue EBOOK invoice pauses only ebooks (reason 'ebook_revenue_share_overdue').
 *  - People who already registered / bought keep full access.
 *  - Paying the invoice re-opens ONLY what the sweep paused for that reason, never a webinar or ebook the creator
 *    drafted themselves, and never another creator's.
 * Time is never waited for: invoice.created_at is back-dated.
 */
import { test, expect, APIRequestContext } from '@playwright/test'
import { db } from '../../helpers/admin-db'
import { runCron } from '../../helpers/cron'
import { daysAgo } from '../../helpers/time'
import { createCreator, createCourse, createInvoice, cleanup } from '../../helpers/factories'
import { createWorkshop, createRegistration, createEbook, createEbookPurchase } from '../../helpers/product-seed'
import { cleanupCheckout } from '../../helpers/checkout-seed'
import { buildEvent, signedHeaders } from '../../helpers/signing'

const CRON = '/api/cron/subscription-reminders'
const HOOK = '/api/cashfree/kurso-webhook'
const KURSO_SECRET = process.env.KURSO_CASHFREE_CLIENT_SECRET!

test.afterAll(async () => { await cleanupCheckout(); await cleanup() })

async function sweep(request: APIRequestContext, ...ids: string[]) {
  const res = await runCron(request, CRON)
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect((body.errors as string[]).filter((e) => ids.some((id) => e.includes(id))), 'cron errors about our test data').toEqual([])
  expect((body.errors as string[]).filter((e) => /pending invoices query|revenue-share invoices:|ebook payments query/.test(e)), 'billing sweep itself failed').toEqual([])
}
async function payInvoice(request: APIRequestContext, invoice: any) {
  const raw = JSON.stringify(buildEvent('cashfree', { orderId: invoice.gateway_order_id, amountRupees: Number(invoice.total_amount_due) }))
  return request.post(HOOK, { data: raw, headers: { 'content-type': 'application/json', ...signedHeaders('cashfree', raw, KURSO_SECRET) } })
}
const ws = async (id: string) => (await db().from('workshops').select('status, auto_unpublished_at, auto_unpublished_reason').eq('id', id).single()).data
const eb = async (id: string) => (await db().from('ebooks').select('is_published, auto_unpublished_at, auto_unpublished_reason').eq('id', id).single()).data
const crs = async (id: string) => (await db().from('courses').select('is_published').eq('id', id).single()).data

/** A creator with live + own-draft webinars and ebooks, a live course, and one overdue-by-age invoice. */
async function lapsed(productType: 'course' | 'ebook', ageDays = 15) {
  const creator = await createCreator()
  const invoice = await createInvoice(creator.id, { amount: 1500, productType })
  await db().from('revenue_share_invoices').update({ created_at: daysAgo(ageDays) }).eq('id', invoice.id)
  const liveWs = await createWorkshop(creator.id, { status: 'published' })
  const ownDraftWs = await createWorkshop(creator.id, { status: 'draft' })
  const liveEb = await createEbook(creator.id, { published: true })
  const ownDraftEb = await createEbook(creator.id, { published: false })
  const course = await createCourse(creator.id, { published: true })
  return { creator, invoice, liveWs, ownDraftWs, liveEb, ownDraftEb, course }
}

test.describe('overdue sweep', () => {
  test('SWP-001 an overdue COURSE invoice pauses live webinars (with the reason) but not drafts or ebooks', async ({ request }) => {
    const s = await lapsed('course')
    await sweep(request, s.creator.id, s.invoice.id)
    expect(await ws(s.liveWs.id)).toMatchObject({ status: 'draft', auto_unpublished_reason: 'revenue_share_overdue' })
    expect((await ws(s.liveWs.id)).auto_unpublished_at).toBeTruthy()
    expect(await ws(s.ownDraftWs.id)).toMatchObject({ status: 'draft', auto_unpublished_reason: null })
    expect((await crs(s.course.id))?.is_published).toBe(false)
    expect((await eb(s.liveEb.id))?.is_published).toBe(true)
  })
  test('SWP-002 people already registered for a paused webinar keep their confirmed seat', async ({ request }) => {
    const s = await lapsed('course')
    const attendee = await createRegistration(s.liveWs.id, { status: 'confirmed' })
    await sweep(request, s.creator.id, s.invoice.id)
    const reg = (await db().from('workshop_registrations').select('payment_status, refunded_at').eq('id', attendee.id).single()).data!
    expect(reg).toMatchObject({ payment_status: 'confirmed', refunded_at: null })
  })
  test('SWP-003 a paused webinar takes no NEW registrations (404)', async ({ request }) => {
    const s = await lapsed('course')
    await sweep(request, s.creator.id, s.invoice.id)
    const res = await request.post('/api/workshops/register', { data: { workshopId: s.liveWs.id, name: 'Late', phone: '9123456780', paymentMode: 'free' } })
    expect(res.status()).toBe(404)
  })
  test('SWP-004 an overdue EBOOK invoice pauses live ebooks only (with the ebook reason)', async ({ request }) => {
    const s = await lapsed('ebook')
    await sweep(request, s.creator.id, s.invoice.id)
    expect(await eb(s.liveEb.id)).toMatchObject({ is_published: false, auto_unpublished_reason: 'ebook_revenue_share_overdue' })
    expect(await eb(s.ownDraftEb.id)).toMatchObject({ is_published: false, auto_unpublished_reason: null })
    expect((await ws(s.liveWs.id))?.status).toBe('published')
    expect((await crs(s.course.id))?.is_published).toBe(true)
  })
  test('SWP-005 a paused ebook takes no NEW purchase (403) but an existing buyer is not locked out', async ({ request }) => {
    const s = await lapsed('ebook')
    const bought = await createEbookPurchase(s.creator.id, s.liveEb.id)
    await sweep(request, s.creator.id, s.invoice.id)
    const res = await request.post('/api/checkout/create-ebook-order', { data: { ebookId: s.liveEb.id, buyerName: 'New', buyerEmail: 'kurso.test+buyer-swp5@example.com' } })
    expect(res.status()).toBe(403)
    expect((await request.get(`/api/ebook/download?purchaseId=${bought.id}`)).status(), 'existing buyers keep access').not.toBe(402)
  })
  test('SWP-006 running the sweep again does not change the pause time', async ({ request }) => {
    const s = await lapsed('course')
    await sweep(request, s.creator.id, s.invoice.id)
    const first = (await ws(s.liveWs.id)).auto_unpublished_at
    await sweep(request, s.creator.id, s.invoice.id)
    expect((await ws(s.liveWs.id)).auto_unpublished_at).toBe(first)
  })
  test('SWP-007 a young invoice (5 days) pauses nothing', async ({ request }) => {
    const s = await lapsed('course', 5)
    await sweep(request, s.creator.id, s.invoice.id)
    expect((await ws(s.liveWs.id))?.status).toBe('published')
    expect((await eb(s.liveEb.id))?.is_published).toBe(true)
  })
})

test.describe('paying the invoice re-opens what was paused', () => {
  test.beforeAll(() => { if (!KURSO_SECRET) throw new Error('KURSO_CASHFREE_CLIENT_SECRET missing in .env.test') })

  test('SWP-010 paying a COURSE invoice re-opens the auto-paused webinars, not the creator\'s own drafts, not ebooks, not other creators\'', async ({ request }) => {
    const s = await lapsed('course')
    await sweep(request, s.creator.id, s.invoice.id)
    const other = await lapsed('course')
    await sweep(request, other.creator.id, other.invoice.id)

    expect((await payInvoice(request, s.invoice)).status()).toBe(200)
    expect(await ws(s.liveWs.id), 'paused webinar is live again').toMatchObject({ status: 'published', auto_unpublished_reason: null, auto_unpublished_at: null })
    expect((await ws(s.ownDraftWs.id))?.status, "creator's own draft stays a draft").toBe('draft')
    expect((await crs(s.course.id))?.is_published).toBe(true)
    expect((await ws(other.liveWs.id))?.status, "another creator's paused webinar is untouched").toBe('draft')
  })
  test('SWP-011 paying a COURSE invoice does not re-open a paused EBOOK', async ({ request }) => {
    const s = await lapsed('course')
    await db().from('ebooks').update({ is_published: false, auto_unpublished_at: new Date().toISOString(), auto_unpublished_reason: 'ebook_revenue_share_overdue' }).eq('id', s.liveEb.id)
    await payInvoice(request, s.invoice)
    expect((await eb(s.liveEb.id))?.is_published).toBe(false)
  })
  test('SWP-012 paying an EBOOK invoice re-opens the paused ebooks and leaves webinars alone', async ({ request }) => {
    const s = await lapsed('ebook')
    await sweep(request, s.creator.id, s.invoice.id)
    await db().from('workshops').update({ status: 'draft', auto_unpublished_at: new Date().toISOString(), auto_unpublished_reason: 'revenue_share_overdue' }).eq('id', s.liveWs.id)
    expect((await payInvoice(request, s.invoice)).status()).toBe(200)
    expect(await eb(s.liveEb.id)).toMatchObject({ is_published: true, auto_unpublished_reason: null })
    expect((await eb(s.ownDraftEb.id))?.is_published, "creator's own draft ebook stays a draft").toBe(false)
    expect((await ws(s.liveWs.id))?.status, 'a course-invoice pause is not cleared by an ebook payment').toBe('draft')
  })
  test('SWP-013 a webinar the creator CANCELLED after it was paused is not re-opened by paying', async ({ request }) => {
    const s = await lapsed('course')
    await db().from('workshops').update({ status: 'cancelled', auto_unpublished_reason: 'revenue_share_overdue' }).eq('id', s.liveWs.id)
    await payInvoice(request, s.invoice)
    expect((await ws(s.liveWs.id))?.status).toBe('cancelled')
  })
})