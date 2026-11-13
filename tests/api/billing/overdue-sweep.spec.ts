/**
 * API: the daily billing cron (/api/cron/subscription-reminders), overdue part.
 * Rules: a PENDING invoice gets ONE reminder from day 10; at 14 days it goes OVERDUE and the
 * creator's published courses are paused (reason 'revenue_share_overdue'). A pending waiver
 * request holds it off. not_due / paid / waived / ₹0 invoices never go overdue. Students who
 * already enrolled keep access. Paying re-opens only the auto-paused courses.
 * Time is never waited for: we back-date invoice.created_at.
 */
import { test, expect, APIRequestContext } from '@playwright/test'
import { db } from '../../helpers/admin-db'
import { signedInClient, visibleRows } from '../../helpers/clients'
import { runCron } from '../../helpers/cron'
import { daysAgo } from '../../helpers/time'
import { createCreator, createCourse, createGateway, createInvoice, createPendingTransaction, createStudent, createEnrollment, cleanup } from '../../helpers/factories'
import { buildEvent, postWebhook, signedHeaders } from '../../helpers/signing'

const CRON = '/api/cron/subscription-reminders'
const KURSO_SECRET = process.env.KURSO_CASHFREE_CLIENT_SECRET!

test.afterAll(async () => { await cleanup() })

/** Runs the cron and fails if it reported an error about any of the given ids. */
async function sweep(request: APIRequestContext, ...ids: string[]) {
  const res = await runCron(request, CRON)
  expect(res.status()).toBe(200)
  const body = await res.json()
  const ours = (body.errors as string[]).filter((e) => ids.some((id) => e.includes(id)))
    expect(ours, 'cron errors about our test data').toEqual([])
  // A query-level failure in the billing sweep silently stops enforcement for EVERYONE.
  const structural = (body.errors as string[]).filter((e) => /pending invoices query|revenue-share invoices:|ebook payments query/.test(e))
  expect(structural, 'billing sweep itself failed').toEqual([])
  return body
}
const courseNow = async (id: string) => (await db().from('courses').select('is_published, auto_unpublished_at, auto_unpublished_reason').eq('id', id).single()).data
const invoiceNow = async (id: string) => (await db().from('revenue_share_invoices').select('*').eq('id', id).single()).data

async function lapsedSetup(ageDays: number, opts: { status?: string; amount?: number; productType?: 'course' | 'ebook' } = {}) {
  const creator = await createCreator()
  const live = await createCourse(creator.id, { published: true })
  const draft = await createCourse(creator.id, { published: false }) // creator's own draft
  const invoice = await createInvoice(creator.id, { amount: opts.amount ?? 1500, status: opts.status, productType: opts.productType })
  await db().from('revenue_share_invoices').update({ created_at: daysAgo(ageDays) }).eq('id', invoice.id)
  return { creator, live, draft, invoice }
}

test.describe('reminder and grace period', () => {
  test('a young invoice (5 days) is left completely alone', async ({ request }) => {
    const s = await lapsedSetup(5)
    await sweep(request, s.creator.id, s.invoice.id)
    expect((await invoiceNow(s.invoice.id)).status).toBe('pending')
    expect((await invoiceNow(s.invoice.id)).reminder_sent_at).toBeNull()
    expect((await courseNow(s.live.id))?.is_published).toBe(true)
  })

  test('day 11: exactly ONE reminder is sent; nothing is paused yet', async ({ request }) => {
    const s = await lapsedSetup(11)
    await sweep(request, s.creator.id, s.invoice.id)
    const first = (await invoiceNow(s.invoice.id)).reminder_sent_at
    expect(first).toBeTruthy()
    expect((await invoiceNow(s.invoice.id)).status).toBe('pending')
    expect((await courseNow(s.live.id))?.is_published).toBe(true)

    await sweep(request, s.creator.id, s.invoice.id) // a second daily run must not re-send
    expect((await invoiceNow(s.invoice.id)).reminder_sent_at).toBe(first)
  })

  test('boundary: 13.9 days is still pending, 14+ days is overdue', async ({ request }) => {
    const early = await lapsedSetup(13.9)
    const late = await lapsedSetup(14.05)
    await sweep(request, early.creator.id, early.invoice.id, late.creator.id, late.invoice.id)
    expect((await invoiceNow(early.invoice.id)).status).toBe('pending')
    expect((await courseNow(early.live.id))?.is_published).toBe(true)
    expect((await invoiceNow(late.invoice.id)).status).toBe('overdue')
    expect((await courseNow(late.live.id))?.is_published).toBe(false)
  })

  test('a pending waiver request holds everything off, even at 20 days', async ({ request }) => {
    const s = await lapsedSetup(20)
    await db().from('revenue_share_waiver_requests').insert({ creator_id: s.creator.id, invoice_id: s.invoice.id, reason: 'slow month', status: 'pending' })
    await sweep(request, s.creator.id, s.invoice.id)
    expect((await invoiceNow(s.invoice.id)).status).toBe('pending')
    expect((await courseNow(s.live.id))?.is_published).toBe(true)
  })
})

test.describe('what overdue does', () => {
  test('overdue invoice pauses published courses; the creator\'s own draft is untouched', async ({ request }) => {
    const s = await lapsedSetup(15)
    await sweep(request, s.creator.id, s.invoice.id)
    const inv = await invoiceNow(s.invoice.id)
    expect(inv.status).toBe('overdue')
    expect(inv.overdue_at).toBeTruthy()
    const live = await courseNow(s.live.id)
    expect(live?.is_published).toBe(false)
    expect(live?.auto_unpublished_reason).toBe('revenue_share_overdue')
    expect(live?.auto_unpublished_at).toBeTruthy()
    expect(await courseNow(s.draft.id)).toEqual({ is_published: false, auto_unpublished_at: null, auto_unpublished_reason: null })
  })

  test('only the lapsed creator is affected', async ({ request }) => {
    const lapsed = await lapsedSetup(15)
    const fine = await createCreator()
    const fineCourse = await createCourse(fine.id, { published: true })
    await sweep(request, lapsed.creator.id, lapsed.invoice.id, fine.id)
    expect((await courseNow(fineCourse.id))?.is_published).toBe(true)
  })

  test('running the sweep again does not change anything', async ({ request }) => {
    const s = await lapsedSetup(15)
    await sweep(request, s.creator.id, s.invoice.id)
    const first = (await invoiceNow(s.invoice.id)).overdue_at
    await sweep(request, s.creator.id, s.invoice.id)
    expect((await invoiceNow(s.invoice.id)).overdue_at).toBe(first)
  })

  test('not_due, paid, waived and ₹0 invoices never go overdue, however old', async ({ request }) => {
    const creator = await createCreator()
    const live = await createCourse(creator.id, { published: true })
    const specs = [
      { status: 'not_due', amount: 0, periodStart: '2026-05-01' },
      { status: 'paid', amount: 1500, periodStart: '2026-06-01' },
      { status: 'waived', amount: 1500, periodStart: '2026-07-01' },
      { status: 'pending', amount: 0, periodStart: '2026-08-01' },
    ]
    const invoices = []
    for (const sp of specs) {
      const inv = await createInvoice(creator.id, sp)
      await db().from('revenue_share_invoices').update({ created_at: daysAgo(30) }).eq('id', inv.id)
      invoices.push(inv)
    }
    await sweep(request, creator.id, ...invoices.map((i) => i.id))
    for (let i = 0; i < specs.length; i++) expect((await invoiceNow(invoices[i].id)).status).toBe(specs[i].status)
    expect((await courseNow(live.id))?.is_published).toBe(true)
  })

  test('an overdue EBOOK invoice never pauses courses', async ({ request }) => {
    const s = await lapsedSetup(15, { productType: 'ebook' })
    await sweep(request, s.creator.id, s.invoice.id)
    expect((await invoiceNow(s.invoice.id)).status).toBe('overdue')
    expect((await courseNow(s.live.id))?.is_published).toBe(true)
  })
})

test.describe('what students experience', () => {
  test('a student who already enrolled keeps their enrollment and can still see it', async ({ request }) => {
    const s = await lapsedSetup(15)
    const student = await createStudent()
    const enr = await createEnrollment({ studentId: student.id, creatorId: s.creator.id, courseId: s.live.id, phone: student.phone })
    await sweep(request, s.creator.id, s.invoice.id)
    expect((await courseNow(s.live.id))?.is_published).toBe(false)
    expect((await db().from('enrollments').select('payment_status').eq('id', enr.id).single()).data?.payment_status).toBe('paid')
    const me = await signedInClient(student.email, student.password)
    expect(visibleRows(await me.from('enrollments').select('id').eq('id', enr.id))).toHaveLength(1)
  })

  test('NEW purchases of a paused course are refused', async ({ request }) => {
    const s = await lapsedSetup(15)
    await sweep(request, s.creator.id, s.invoice.id)
    const res = await request.post('/api/checkout/create-order', { data: { courseId: s.live.id } })
    expect(res.status()).toBe(403)
    expect((await res.json()).error).toMatch(/not currently available/)
  })

  test('RULE (b): a payment started BEFORE the pause still grants access when it lands after', async ({ request }) => {
    const s = await lapsedSetup(15)
    const gw = await createGateway(s.creator.id, 'razorpay')
    const txn = await createPendingTransaction({ creatorId: s.creator.id, courseId: s.live.id, provider: 'razorpay', amount: s.live.price })
    await sweep(request, s.creator.id, s.invoice.id)
    expect((await courseNow(s.live.id))?.is_published).toBe(false)
    const res = await postWebhook(request, 'razorpay', buildEvent('razorpay', { orderId: txn.gateway_order_id, amountRupees: Number(txn.amount) }), gw.webhookSecret)
    expect((await res.json()).message).toBe('Enrollment activated')
    const { data } = await db().from('enrollments').select('id').eq('course_uuid', s.live.id)
    expect(data).toHaveLength(1)
  })
})

test('FULL LIFECYCLE: overdue -> courses paused -> creator pays -> courses live -> sales possible again', async ({ request }) => {
  const s = await lapsedSetup(15)
  await sweep(request, s.creator.id, s.invoice.id)
  expect((await courseNow(s.live.id))?.is_published).toBe(false)
  expect((await request.post('/api/checkout/create-order', { data: { courseId: s.live.id } })).status()).toBe(403)

  const raw = JSON.stringify(buildEvent('cashfree', { orderId: s.invoice.gateway_order_id, amountRupees: 1500 }))
  const paid = await request.post('/api/cashfree/kurso-webhook', { data: raw, headers: { 'content-type': 'application/json', ...signedHeaders('cashfree', raw, KURSO_SECRET) } })
  expect((await paid.json()).message).toBe('Revenue-share invoice paid')

  expect((await courseNow(s.live.id))?.is_published).toBe(true)
  expect((await courseNow(s.draft.id))?.is_published).toBe(false) // draft stays a draft
  const checkout = await request.post('/api/checkout/create-order', { data: { courseId: s.live.id } })
  expect(checkout.status()).toBe(409) // no longer blocked by "not available"; this creator just has no gateway set up
})