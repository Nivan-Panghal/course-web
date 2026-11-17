/**
 * Helpers for the webinar (workshop) and ebook tests.
 *  createWorkshop / createRegistration / createEbook / createEbookPurchase
 *  cleanupProducts(): removes everything these helpers created. Call it BEFORE factories.cleanup().
 */
import crypto from 'crypto'
import { db } from './admin-db'

const rand = () => crypto.randomBytes(4).toString('hex')
const DAY = 86_400_000
const creatorIds = new Set<string>()

function must(res: { data: any; error: any }, what: string): any {
  if (res.error || !res.data) throw new Error(`${what} failed: ${res.error?.message}`)
  return res.data
}

/** A webinar. Defaults: published, starts in 7 days, free, no capacity limit. */
export async function createWorkshop(
  creatorId: string,
  o: { price?: number; capacity?: number | null; status?: string; startsInDays?: number; closesAt?: string | null; zoomLink?: string } = {}
) {
  creatorIds.add(creatorId)
  const r = rand()
  return must(
    await db()
      .from('workshops')
      .insert({
        creator_id: creatorId,
        title: `Test Workshop ${r}`,
        slug: `test-workshop-${r}`,
        date_time: new Date(Date.now() + (o.startsInDays ?? 7) * DAY).toISOString(),
        price: o.price ?? 0,
        capacity: o.capacity ?? null,
        status: o.status ?? 'published',
        registration_closes_at: o.closesAt ?? null,
        zoom_link: o.zoomLink ?? 'https://zoom.example.com/j/secret-room',
      })
      .select()
      .single(),
    'workshop'
  )
}

/** A registration row created directly in the database. */
export async function createRegistration(
  workshopId: string,
  o: { phone?: string; status?: 'pending_confirmation' | 'confirmed' | 'n/a'; mode?: 'free' | 'upi_manual' | 'gateway'; refundedAt?: string | null; name?: string } = {}
) {
  return must(
    await db()
      .from('workshop_registrations')
      .insert({
        workshop_id: workshopId,
        name: o.name ?? 'Test Attendee',
        email: `kurso.test+attendee-${rand()}@example.com`,
        phone: o.phone ?? `90000${Math.floor(10000 + Math.random() * 89999)}`,
        payment_mode: o.mode ?? 'free',
        payment_status: o.status ?? 'confirmed',
        refunded_at: o.refundedAt ?? null,
      })
      .select()
      .single(),
    'registration'
  )
}

/** An ebook row. The PDF path is only used by the download tests. */
export async function createEbook(creatorId: string, o: { price?: number; published?: boolean; pdfPath?: string } = {}) {
  creatorIds.add(creatorId)
  const r = rand()
  return must(
    await db()
      .from('ebooks')
      .insert({
        creator_id: creatorId,
        title: `Test Ebook ${r}`,
        slug: `test-ebook-${r}`,
        price: o.price ?? 299,
        pdf_storage_path: o.pdfPath ?? `${creatorId}/test-${r}.pdf`,
        is_published: o.published ?? true,
      })
      .select()
      .single(),
    'ebook'
  )
}

/** An ebook purchase (a transactions row). */
export async function createEbookPurchase(
  creatorId: string,
  ebookId: string,
  o: { status?: string; downloadCount?: number; downloadLimit?: number; amount?: number } = {}
) {
  const r = rand()
  return must(
    await db()
      .from('transactions')
      .insert({
        creator_id: creatorId,
        ebook_id: ebookId,
        product_type: 'ebook',
        client_txn_id: `txn_${r}`,
        amount: o.amount ?? 299,
        status: o.status ?? 'success',
        payment_provider: 'razorpay',
        student_name: 'Test Reader',
        student_email: `kurso.test+buyer-${r}@example.com`,
        ebook_download_count: o.downloadCount ?? 0,
        ebook_download_limit: o.downloadLimit ?? 5,
      })
      .select()
      .single(),
    'ebook purchase'
  )
}

const chunk = <T>(a: T[], n = 50): T[][] => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, (i + 1) * n))

/** Deletes what the helpers above created, in dependency order, in batches (one call per table, not per creator). */
export async function cleanupProducts() {
  const d = db()
  const ids = [...creatorIds]
  creatorIds.clear()
  const warn = (what: string, error: any) => error && console.warn(`[cleanupProducts] ${what}: ${error.message}`)
  for (const part of chunk(ids)) {
    const { data: ws } = await d.from('workshops').select('id').in('creator_id', part)
    const workshopIds = (ws ?? []).map((w: any) => w.id)
    const { data: tx } = await d.from('transactions').select('id').in('creator_id', part).in('product_type', ['ebook', 'workshop'])
    const txIds = (tx ?? []).map((t: any) => t.id)

    warn('refund_requests', (await d.from('refund_requests').delete().in('creator_id', part)).error)
    for (const t of chunk(txIds)) warn('ebook_downloads', (await d.from('ebook_downloads').delete().in('purchase_id', t)).error)
    for (const w of chunk(workshopIds)) {
      const { data: regs } = await d.from('workshop_registrations').select('id').in('workshop_id', w)
      for (const r of chunk((regs ?? []).map((x: any) => x.id))) warn('workshop_nudges', (await d.from('workshop_nudges').delete().in('registration_id', r)).error)
      for (const t of ['workshop_reviews', 'workshop_certificates', 'workshop_referral_codes', 'workshop_coupons']) {
        warn(t, (await d.from(t).delete().in('workshop_id', w)).error)
      }
      warn('workshop_registrations', (await d.from('workshop_registrations').delete().in('workshop_id', w)).error)
    }
    warn('invoices', (await d.from('invoices').delete().in('creator_id', part)).error)
    warn('payments', (await d.from('payments').delete().in('creator_id', part).in('product_type', ['ebook', 'workshop'])).error)
    warn('transactions', (await d.from('transactions').delete().in('creator_id', part).in('product_type', ['ebook', 'workshop'])).error)
    warn('ebooks', (await d.from('ebooks').delete().in('creator_id', part)).error)
    warn('workshops', (await d.from('workshops').delete().in('creator_id', part)).error)
  }
}