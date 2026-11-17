/**
 * Helpers for the PAID webinar (workshop) and ebook tests: online checkout, payment webhooks, refunds.
 *
 *  createWorkshopSale(): a paid webinar + a registration that is waiting for payment + the pending
 *                        transaction the gateway will "pay" (the same shape the real checkout writes).
 *  createEbookSale():    a paid ebook + its pending transaction.
 *  withReviewToken():    makes sure a registration has the private refund/review link token.
 *  cleanupCheckout():    removes refunds, payments and transactions in the right order, then calls
 *                        cleanupProducts(). Call it BEFORE factories.cleanup().
 */
import crypto from 'crypto'
import { db } from './admin-db'
import { createWorkshop, createEbook, cleanupProducts } from './product-seed'

export type Provider = 'razorpay' | 'cashfree' | 'stripe'
const rand = () => crypto.randomBytes(4).toString('hex')

function must(res: { data: any; error: any }, what: string): any {
  if (res.error || !res.data) throw new Error(`${what} failed: ${res.error?.message}`)
  return res.data
}

/** A 10-digit phone number that is valid and unique enough for one test run. */
export const newPhone = () => '91' + String(Math.floor(10_000_000 + Math.random() * 89_999_999))

/** Paid webinar with one student who has started an online payment that is not finished yet. */
export async function createWorkshopSale(
  creatorId: string,
  provider: Provider,
  o: { price?: number; amount?: number; originalAmount?: number; discount?: number; capacity?: number | null; status?: string } = {}
) {
  const price = o.price ?? 499
  const workshop = await createWorkshop(creatorId, { price, capacity: o.capacity, status: o.status })
  const r = rand()
  const email = `kurso.test+buyer-${r}@example.com`
  const phone = newPhone()
  const reg = must(
    await db()
      .from('workshop_registrations')
      .insert({
        workshop_id: workshop.id,
        name: 'Test Payer',
        email,
        phone,
        payment_mode: 'gateway',
        payment_status: 'pending_confirmation',
        payment_attempted_at: new Date().toISOString(),
      })
      .select()
      .single(),
    'registration'
  )
  const txn = must(
    await db()
      .from('transactions')
      .insert({
        creator_id: creatorId,
        workshop_id: workshop.id,
        workshop_registration_id: reg.id,
        product_type: 'workshop',
        client_txn_id: `txn_${r}`,
        gateway_order_id: `order_${r}`,
        amount: o.amount ?? price,
        original_amount: o.originalAmount ?? price,
        discount_amount: o.discount ?? 0,
        status: 'pending',
        payment_provider: provider,
        student_name: 'Test Payer',
        student_email: email,
        student_phone: phone,
      })
      .select()
      .single(),
    'workshop transaction'
  )
  await db().from('workshop_registrations').update({ transaction_id: txn.id }).eq('id', reg.id)
  return { workshop, reg, txn }
}

/** Paid ebook with a buyer who has started an online payment that is not finished yet. */
export async function createEbookSale(creatorId: string, provider: Provider, o: { price?: number; amount?: number } = {}) {
  const price = o.price ?? 299
  const ebook = await createEbook(creatorId, { price })
  const r = rand()
  const txn = must(
    await db()
      .from('transactions')
      .insert({
        creator_id: creatorId,
        ebook_id: ebook.id,
        product_type: 'ebook',
        client_txn_id: `txn_${r}`,
        gateway_order_id: `order_${r}`,
        amount: o.amount ?? price,
        original_amount: price,
        status: 'pending',
        payment_provider: provider,
        student_name: 'Test Reader',
        student_email: `kurso.test+buyer-${r}@example.com`,
        student_phone: newPhone(),
        ebook_download_count: 0,
        ebook_download_limit: 5,
      })
      .select()
      .single(),
    'ebook transaction'
  )
  return { ebook, txn }
}

/** Returns the registration with its private refund/review link token (adds one if the database did not). */
export async function withReviewToken(reg: any) {
  if (reg.review_token) return reg
  const token = crypto.randomUUID()
  await db().from('workshop_registrations').update({ review_token: token }).eq('id', reg.id)
  return { ...reg, review_token: token }
}

/** A payments row for a paid webinar registration, as the payment webhook would write it. */
export async function createWorkshopPayment(creatorId: string, workshopId: string, registrationId: string, o: { amount?: number; provider?: Provider } = {}) {
  const amount = o.amount ?? 499
  const r = rand()
  return must(
    await db()
      .from('payments')
      .insert({
        creator_id: creatorId,
        product_type: 'workshop',
        workshop_id: workshopId,
        workshop_registration_id: registrationId,
        provider: o.provider ?? 'razorpay',
        provider_payment_id: `pay_${r}`,
        provider_order_id: `order_${r}`,
        buyer_name: 'Test Payer',
        buyer_email: `kurso.test+buyer-${r}@example.com`,
        currency: 'INR',
        gross_amount: amount,
        discount_amount: 0,
        net_amount: amount,
        platform_fee: 0,
        creator_earning: amount,
        status: 'paid',
        paid_at: new Date().toISOString(),
      })
      .select()
      .single(),
    'workshop payment'
  )
}

const chunk = <T>(a: T[], n = 50): T[][] => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, (i + 1) * n))

/** Removes refunds, invoices, payments and transactions for every test creator (in batches), then everything product-seed made. */
export async function cleanupCheckout() {
  const d = db()
  const warn = (what: string, error: any) => error && console.warn(`[cleanupCheckout] ${what}: ${error.message}`)
  const { data: creators } = await d.from('creators').select('id').like('email', 'kurso.test+creator-%')
  const ids = (creators ?? []).map((c: any) => c.id)
  for (const part of chunk(ids)) {
    const { data: tx } = await d.from('transactions').select('id').in('creator_id', part).in('product_type', ['ebook', 'workshop'])
    const txIds = (tx ?? []).map((t: any) => t.id)
    const { data: ws } = await d.from('workshops').select('id').in('creator_id', part)
    const wsIds = (ws ?? []).map((w: any) => w.id)

    warn('refund_requests', (await d.from('refund_requests').delete().in('creator_id', part)).error)
    warn('refunds', (await d.from('refunds').delete().in('creator_id', part)).error)
    for (const t of chunk(txIds)) warn('ebook_downloads', (await d.from('ebook_downloads').delete().in('purchase_id', t)).error)
    warn('invoices', (await d.from('invoices').delete().in('creator_id', part)).error)
    warn('payments', (await d.from('payments').delete().in('creator_id', part).in('product_type', ['ebook', 'workshop'])).error)
    // registrations and transactions point at each other: break the loop before deleting
    for (const w of chunk(wsIds)) warn('registration links', (await d.from('workshop_registrations').update({ transaction_id: null }).in('workshop_id', w)).error)
    warn('transactions', (await d.from('transactions').delete().in('creator_id', part).in('product_type', ['ebook', 'workshop'])).error)
  }
  await cleanupProducts()
}