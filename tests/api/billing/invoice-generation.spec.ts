/**
 * API: the daily cron generating LAST MONTH's invoice per creator.
 * Rules: sales paid last month are billed once (idempotent); this month's sales, failed payments
 * and creators with no sales get nothing; ebooks are a separate invoice with a ₹500 monthly floor
 * (below it -> 'not_due', above it -> 4%).
 */
import { test, expect, APIRequestContext } from '@playwright/test'
import { db } from '../../helpers/admin-db'
import { runCron } from '../../helpers/cron'
import { createCreator, cleanup } from '../../helpers/factories'
import { previousMonthRange } from '../../../src/lib/revenueShare'

const CRON = '/api/cron/subscription-reminders'
const { start, end } = previousMonthRange(new Date())

test.afterAll(async () => { await cleanup() })

async function sweep(request: APIRequestContext, ...ids: string[]) {
  const res = await runCron(request, CRON)
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect((body.errors as string[]).filter((e) => ids.some((id) => e.includes(id))), 'cron errors about our test data').toEqual([])
}

async function addPayment(creatorId: string, o: { net: number; fee: number; gross?: number; status?: string; paidAt?: string; productType?: 'course' | 'ebook' }) {
  const { error } = await db().from('payments').insert({
    creator_id: creatorId, provider: 'manual', status: o.status ?? 'paid', product_type: o.productType ?? 'course',
    gross_amount: o.gross ?? o.net, net_amount: o.net, platform_fee: o.fee, creator_earning: o.net - o.fee,
    paid_at: o.paidAt ?? `${start}T12:00:00.000Z`,
  })
  if (error) throw new Error(`payment seed failed: ${error.message}`)
}
const invoicesFor = async (creatorId: string, productType = 'course') =>
  (await db().from('revenue_share_invoices').select('*').eq('creator_id', creatorId).eq('product_type', productType)).data ?? []

test('last month\'s sales produce ONE pending course invoice with the right numbers', async ({ request }) => {
  const c = await createCreator()
  await addPayment(c.id, { net: 499, fee: 25 })
  await addPayment(c.id, { net: 499, fee: 25 })
  await sweep(request, c.id)
  const [inv] = await invoicesFor(c.id)
  expect(inv).toBeTruthy()
  expect(inv.status).toBe('pending')
  expect(inv.period_start).toBe(start)
  expect(inv.period_end).toBe(end)
  expect(Number(inv.gross_revenue)).toBe(998)
  expect(Number(inv.commission_amount)).toBe(50)
  expect(inv.total_amount_due).toBe(50)
  expect(inv.line_items.map((l: any) => l.type)).toEqual(expect.arrayContaining(['sales', 'commission']))
})

test('running the cron several times never creates a second invoice', async ({ request }) => {
  const c = await createCreator()
  await addPayment(c.id, { net: 499, fee: 25 })
  await sweep(request, c.id)
  await sweep(request, c.id)
  expect(await invoicesFor(c.id)).toHaveLength(1)
})

test('each creator is billed only for their own sales', async ({ request }) => {
  const a = await createCreator()
  const b = await createCreator()
  await addPayment(a.id, { net: 1000, fee: 50 })
  await addPayment(b.id, { net: 200, fee: 10 })
  await sweep(request, a.id, b.id)
  expect((await invoicesFor(a.id))[0].total_amount_due).toBe(50)
  expect((await invoicesFor(b.id))[0].total_amount_due).toBe(10)
})

test('a creator with no sales gets no invoice', async ({ request }) => {
  const c = await createCreator()
  await sweep(request, c.id)
  expect(await invoicesFor(c.id)).toHaveLength(0)
})

test('sales from THIS month are not billed yet', async ({ request }) => {
  const c = await createCreator()
  await addPayment(c.id, { net: 499, fee: 25, paidAt: new Date().toISOString() })
  await sweep(request, c.id)
  expect(await invoicesFor(c.id)).toHaveLength(0)
})

test('failed payments are not billed', async ({ request }) => {
  const c = await createCreator()
  await addPayment(c.id, { net: 499, fee: 25, status: 'failed' })
  await sweep(request, c.id)
  expect(await invoicesFor(c.id)).toHaveLength(0)
})

test.describe('ebooks are a separate invoice with a ₹500 floor', () => {
  test('below the floor -> not_due, ₹0, and no course invoice', async ({ request }) => {
    const c = await createCreator()
    await addPayment(c.id, { net: 400, fee: 0, productType: 'ebook' })
    await sweep(request, c.id)
    const [ebook] = await invoicesFor(c.id, 'ebook')
    expect(ebook.status).toBe('not_due')
    expect(ebook.total_amount_due).toBe(0)
    expect(await invoicesFor(c.id, 'course')).toHaveLength(0)
  })

  test('above the floor -> 4% commission, pending', async ({ request }) => {
    const c = await createCreator()
    await addPayment(c.id, { net: 1000, fee: 0, productType: 'ebook' })
    await sweep(request, c.id)
    const [ebook] = await invoicesFor(c.id, 'ebook')
    expect(ebook.status).toBe('pending')
    expect(ebook.total_amount_due).toBe(40)
  })
})