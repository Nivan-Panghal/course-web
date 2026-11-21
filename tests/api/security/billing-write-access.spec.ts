/**
 * SECURITY: can a signed-in CREATOR change what they owe Kurso by writing to the billing tables directly?
 * Real creators only change these through our server routes. Here a logged-in creator tries the database API
 * directly. "Blocked" means a permission error or no change; each result is re-read as admin.
 * If one of these FAILS it is a real finding: a creator could lower their commission, mark an invoice
 * paid, delete a debt, or approve their own waiver without paying Kurso.
 */
import { test, expect } from '@playwright/test'
import { db } from '../../helpers/admin-db'
import { signedInClient } from '../../helpers/clients'
import { createCreator, createInvoice, cleanup } from '../../helpers/factories'

let A: any, B: any, C: any, invoice: any, agreement: any, waiver: any
test.beforeAll(async () => {
  A = await createCreator()
  B = await createCreator()
  C = await createCreator() // has no agreement at all
  invoice = await createInvoice(A.id, { amount: 1500, status: 'pending' })
  // Every new creator already gets an active agreement automatically; clear them so the test controls the terms.
  await db().from('revenue_share_agreements').delete().eq('creator_id', A.id)
  await db().from('revenue_share_agreements').delete().eq('creator_id', C.id)
  const ag = await db().from('revenue_share_agreements')
    .insert({ creator_id: A.id, status: 'active', base_rate_percent: 5, overflow_rate_percent: 3, overflow_threshold_students: 100 })
    .select().single()
  if (ag.error) throw new Error(`agreement seed failed: ${ag.error.message}`)
  agreement = ag.data
  const w = await db().from('revenue_share_waiver_requests')
    .insert({ creator_id: A.id, invoice_id: invoice.id, status: 'pending', reason: 'seed' })
    .select().single()
  if (w.error) throw new Error(`waiver seed failed: ${w.error.message}`)
  waiver = w.data
})
test.afterAll(async () => { await cleanup() })

const agreementNow = async () => (await db().from('revenue_share_agreements').select('*').eq('id', agreement.id).maybeSingle()).data
const invoiceNow = async () => (await db().from('revenue_share_invoices').select('*').eq('id', invoice.id).maybeSingle()).data
const waiverNow = async () => (await db().from('revenue_share_waiver_requests').select('*').eq('id', waiver.id).maybeSingle()).data

test.describe('the creator who owes the money', () => {
  test('BIL-001 cannot lower their own commission rate', async () => {
    const a = await signedInClient(A.email, A.password)
    await a.from('revenue_share_agreements').update({ base_rate_percent: 0, overflow_rate_percent: 0 }).eq('id', agreement.id)
    const row = await agreementNow()
    expect(Number(row.base_rate_percent)).toBe(5)
    expect(Number(row.overflow_rate_percent)).toBe(3)
  })
  test('BIL-002 cannot create themselves a 0% agreement', async () => {
    const c = await signedInClient(C.email, C.password)
    await c.from('revenue_share_agreements').insert({ creator_id: C.id, status: 'active', base_rate_percent: 0, overflow_rate_percent: 0, overflow_threshold_students: 100 })
    expect((await db().from('revenue_share_agreements').select('id').eq('creator_id', C.id)).data).toHaveLength(0)
  })
  test('BIL-003 cannot delete their agreement', async () => {
    const a = await signedInClient(A.email, A.password)
    await a.from('revenue_share_agreements').delete().eq('id', agreement.id)
    expect(await agreementNow()).not.toBeNull()
  })
  test('BIL-004 cannot mark their own invoice paid or reduce what is due', async () => {
    const a = await signedInClient(A.email, A.password)
    await a.from('revenue_share_invoices').update({ status: 'paid', paid_at: new Date().toISOString(), total_amount_due: 0, commission_amount: 0 }).eq('id', invoice.id)
    const row = await invoiceNow()
    expect(row.status).toBe('pending')
    expect(Number(row.total_amount_due)).toBe(1500)
  })
  test('BIL-005 cannot delete their own invoice', async () => {
    const a = await signedInClient(A.email, A.password)
    await a.from('revenue_share_invoices').delete().eq('id', invoice.id)
    expect(await invoiceNow()).not.toBeNull()
  })
  test('BIL-006 cannot create an invoice for themselves marked as paid', async () => {
    const a = await signedInClient(A.email, A.password)
    const start = '2026-01-01'
    await a.from('revenue_share_invoices').insert({ creator_id: A.id, period_start: start, period_end: '2026-01-28', gross_revenue: 0, total_amount_due: 0, commission_amount: 0, status: 'paid', product_type: 'course' })
    expect((await db().from('revenue_share_invoices').select('id').eq('creator_id', A.id).eq('period_start', start)).data).toHaveLength(0)
  })
  test('BIL-007 cannot approve their own waiver request', async () => {
    const a = await signedInClient(A.email, A.password)
    await a.from('revenue_share_waiver_requests').update({ status: 'approved', reviewed_at: new Date().toISOString(), admin_note: 'self' }).eq('id', waiver.id)
    const row = await waiverNow()
    expect(row.status).toBe('pending')
    expect(row.admin_note).not.toBe('self')
  })
})

test.describe('another creator', () => {
  test('BIL-010 cannot change or delete my invoice', async () => {
    const b = await signedInClient(B.email, B.password)
    await b.from('revenue_share_invoices').update({ status: 'paid', total_amount_due: 0 }).eq('id', invoice.id)
    await b.from('revenue_share_invoices').delete().eq('id', invoice.id)
    const row = await invoiceNow()
    expect(row).not.toBeNull()
    expect(row.status).toBe('pending')
  })
  test('BIL-011 cannot change my agreement or approve my waiver', async () => {
    const b = await signedInClient(B.email, B.password)
    await b.from('revenue_share_agreements').update({ base_rate_percent: 0 }).eq('id', agreement.id)
    await b.from('revenue_share_waiver_requests').update({ status: 'approved' }).eq('id', waiver.id)
    expect(Number((await agreementNow()).base_rate_percent)).toBe(5)
    expect((await waiverNow()).status).toBe('pending')
  })
})