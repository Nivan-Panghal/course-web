/**
 * SECURITY: who can see or change webinar (workshop) and ebook data.
 * Every check acts as a real visitor (anon / signed-in) through the public database API, never as admin.
 * "Blocked" means a permission error OR zero rows. Writes are verified by re-reading the row as admin.
 * If one of these FAILS, treat it as a real security finding, not a flaky test.
 *
 *  - Nobody but the owner reads registrations (names, phones, private tokens), purchases, refunds, payments.
 *  - The meeting (Zoom) link is never readable by the public, or by a logged-in student who is not the owner.
 *  - The private ebook file cannot be downloaded or guessed from the public side.
 *  - Nobody can write registrations, purchases or other creators' webinars/ebooks.
 *  - The public webinar page does not contain the meeting link.
 */
import { test, expect } from '@playwright/test'
import { PDFDocument } from 'pdf-lib'
import { db } from '../../helpers/admin-db'
import { anonClient, signedInClient, visibleRows } from '../../helpers/clients'
import { createCreator, createStudent, cleanup } from '../../helpers/factories'
import { createWorkshop, createRegistration, createEbook, createEbookPurchase } from '../../helpers/product-seed'
import { createWorkshopPayment, cleanupCheckout } from '../../helpers/checkout-seed'

const ZOOM = 'https://zoom.example.com/j/secret-room-4417'
let A: any
let B: any
let student: any
let workshop: any
let draftWorkshop: any
let registration: any
let ebook: any
let draftEbook: any
let purchase: any

test.beforeAll(async () => {
  A = await createCreator()
  B = await createCreator()
  student = await createStudent()
  workshop = await createWorkshop(A.id, { price: 499, zoomLink: ZOOM })
  draftWorkshop = await createWorkshop(A.id, { status: 'draft', zoomLink: ZOOM })
  registration = await createRegistration(workshop.id, { status: 'confirmed', mode: 'gateway' })
  await createWorkshopPayment(A.id, workshop.id, registration.id)
  ebook = await createEbook(A.id)
  draftEbook = await createEbook(A.id, { published: false })
  purchase = await createEbookPurchase(A.id, ebook.id)
})
test.afterAll(async () => { await cleanupCheckout(); await cleanup() })

const reread = async (table: string, id: string) => (await db().from(table).select('*').eq('id', id).maybeSingle()).data

test.describe('anonymous visitor', () => {
  for (const table of ['workshop_registrations', 'refund_requests', 'refunds', 'payments', 'ebook_downloads', 'workshop_nudges', 'workshop_certificates', 'workshop_reviews']) {
    test(`SEC-001 cannot read ${table}`, async () => {
      expect(visibleRows(await anonClient().from(table).select('*'))).toHaveLength(0)
    })
  }
  test('SEC-002 cannot read an ebook purchase (transactions)', async () => {
    expect(visibleRows(await anonClient().from('transactions').select('*').eq('id', purchase.id))).toHaveLength(0)
  })
  test('SEC-003 cannot read the meeting link of a published webinar', async () => {
    const rows = visibleRows(await anonClient().from('workshops').select('zoom_link').eq('id', workshop.id))
    expect(rows.filter((r) => r.zoom_link)).toHaveLength(0)
  })
  test('SEC-004 cannot read the meeting link with a select-all either', async () => {
    const rows = visibleRows(await anonClient().from('workshops').select('*').eq('id', workshop.id))
    expect(rows.filter((r) => r.zoom_link)).toHaveLength(0)
  })
  test('SEC-005 cannot see a draft webinar or an unpublished ebook', async () => {
    expect(visibleRows(await anonClient().from('workshops').select('id').eq('id', draftWorkshop.id))).toHaveLength(0)
    expect(visibleRows(await anonClient().from('ebooks').select('id').eq('id', draftEbook.id))).toHaveLength(0)
  })
  test('SEC-006 cannot create or change a registration', async () => {
    const phone = '9000000777'
    await anonClient().from('workshop_registrations').insert({ workshop_id: workshop.id, name: 'Sneaky', phone, payment_mode: 'free', payment_status: 'confirmed' })
    expect((await db().from('workshop_registrations').select('id').eq('phone', phone)).data).toHaveLength(0)
    await anonClient().from('workshop_registrations').update({ payment_status: 'pending_confirmation', name: 'HACKED' }).eq('id', registration.id)
    expect((await reread('workshop_registrations', registration.id)).name).toBe('Test Attendee')
    await anonClient().from('workshop_registrations').delete().eq('id', registration.id)
    expect(await reread('workshop_registrations', registration.id)).not.toBeNull()
  })
  test('SEC-007 cannot create a paid ebook purchase out of thin air', async () => {
    const email = 'kurso.test+buyer-sec7@example.com'
    await anonClient().from('transactions').insert({ creator_id: A.id, ebook_id: ebook.id, product_type: 'ebook', client_txn_id: 'txn_sec7', amount: 299, status: 'success', student_email: email })
    expect((await db().from('transactions').select('id').eq('student_email', email)).data).toHaveLength(0)
  })
  test('SEC-008 cannot raise or reset download counters', async () => {
    await anonClient().from('transactions').update({ ebook_download_limit: 9999, ebook_download_count: 0 }).eq('id', purchase.id)
    expect((await reread('transactions', purchase.id)).ebook_download_limit).toBe(5)
  })
  test('SEC-009 cannot modify or delete a webinar or an ebook', async () => {
    await anonClient().from('workshops').update({ title: 'HACKED', status: 'cancelled' }).eq('id', workshop.id)
    await anonClient().from('workshops').delete().eq('id', workshop.id)
    await anonClient().from('ebooks').update({ title: 'HACKED', price: 1 }).eq('id', ebook.id)
    await anonClient().from('ebooks').delete().eq('id', ebook.id)
    expect((await reread('workshops', workshop.id)).title).toBe(workshop.title)
    expect(Number((await reread('ebooks', ebook.id)).price)).toBe(299)
  })
})

test.describe('another creator', () => {
  test('SEC-020 cannot read my registrations, purchases or payments', async () => {
    const B_ = await signedInClient(B.email, B.password)
    expect(visibleRows(await B_.from('workshop_registrations').select('*').eq('workshop_id', workshop.id))).toHaveLength(0)
    expect(visibleRows(await B_.from('transactions').select('*').eq('id', purchase.id))).toHaveLength(0)
    expect(visibleRows(await B_.from('payments').select('*').eq('creator_id', A.id))).toHaveLength(0)
  })
  test('SEC-021 cannot read my meeting link', async () => {
    const B_ = await signedInClient(B.email, B.password)
    const rows = visibleRows(await B_.from('workshops').select('zoom_link').eq('id', workshop.id))
    expect(rows.filter((r) => r.zoom_link)).toHaveLength(0)
  })
  test('SEC-022 cannot change or delete my webinar or ebook', async () => {
    const B_ = await signedInClient(B.email, B.password)
    await B_.from('workshops').update({ title: 'HACKED' }).eq('id', workshop.id)
    await B_.from('ebooks').update({ price: 1 }).eq('id', ebook.id)
    await B_.from('workshops').delete().eq('id', workshop.id)
    await B_.from('ebooks').delete().eq('id', ebook.id)
    expect((await reread('workshops', workshop.id)).title).toBe(workshop.title)
    expect(Number((await reread('ebooks', ebook.id)).price)).toBe(299)
  })
  test('SEC-023 cannot create a webinar or ebook under MY account', async () => {
    const B_ = await signedInClient(B.email, B.password)
    const slug = `sneaky-${Date.now()}`
    await B_.from('workshops').insert({ creator_id: A.id, title: 'Sneaky', slug, date_time: new Date(Date.now() + 86_400_000).toISOString(), status: 'draft' })
    await B_.from('ebooks').insert({ creator_id: A.id, title: 'Sneaky', slug, price: 10, pdf_storage_path: 'x.pdf', is_published: false })
    expect((await db().from('workshops').select('id').eq('slug', slug)).data).toHaveLength(0)
    expect((await db().from('ebooks').select('id').eq('slug', slug)).data).toHaveLength(0)
  })
  test('SEC-024 cannot change a registration of mine (mark it paid or refunded)', async () => {
    const B_ = await signedInClient(B.email, B.password)
    await B_.from('workshop_registrations').update({ refunded_at: new Date().toISOString(), payment_status: 'pending_confirmation' }).eq('id', registration.id)
    const after = await reread('workshop_registrations', registration.id)
    expect(after.refunded_at).toBeNull()
    expect(after.payment_status).toBe('confirmed')
  })
})

test.describe('a logged-in student (not the owner)', () => {
  test('SEC-030 cannot read the meeting link straight from the database', async () => {
    const s = await signedInClient(student.email, student.password)
    const rows = visibleRows(await s.from('workshops').select('zoom_link').eq('id', workshop.id))
    expect(rows.filter((r) => r.zoom_link)).toHaveLength(0)
  })
  test('SEC-031 cannot read other people\'s registrations', async () => {
    const s = await signedInClient(student.email, student.password)
    expect(visibleRows(await s.from('workshop_registrations').select('*').eq('workshop_id', workshop.id))).toHaveLength(0)
  })
  test('SEC-032 cannot change a registration', async () => {
    const s = await signedInClient(student.email, student.password)
    await s.from('workshop_registrations').update({ name: 'HACKED' }).eq('id', registration.id)
    expect((await reread('workshop_registrations', registration.id)).name).toBe('Test Attendee')
  })
})

test.describe('the private ebook file and the public page', () => {
  test('SEC-040 the ebook PDF cannot be downloaded or opened by a public link', async ({ request }) => {
    const doc = await PDFDocument.create()
    doc.addPage([200, 200])
    const path = `${A.id}/sec-040.pdf`
    const up = await db().storage.from('ebook-files').upload(path, await doc.save(), { contentType: 'application/pdf', upsert: true })
    test.skip(!!up.error, 'the "ebook-files" storage bucket does not exist in the test project')
    try {
      const viaClient = await anonClient().storage.from('ebook-files').download(path)
      expect(viaClient.data, 'anon must not download from the private bucket').toBeNull()
      const url = anonClient().storage.from('ebook-files').getPublicUrl(path).data.publicUrl
      expect((await request.get(url)).status(), 'a public URL must not serve the private file').not.toBe(200)
      expect(visibleRows(await anonClient().storage.from('ebook-files').list(A.id))).toHaveLength(0)
    } finally {
      await db().storage.from('ebook-files').remove([path])
    }
  })
  test('SEC-041 the public webinar page does not contain the meeting link', async ({ request }) => {
    const res = await request.get(`/w/${A.creator_slug}/${workshop.slug}`)
    expect(res.status()).toBe(200)
    const html = await res.text()
    expect(html).toContain(workshop.title)
    expect(html).not.toContain('secret-room-4417')
  })
    test('SEC-042 a draft webinar shows nothing: no title, no meeting link', async ({ request }) => {
    const html = await (await request.get(`/w/${A.creator_slug}/${draftWorkshop.slug}`)).text()
    expect(html).not.toContain(draftWorkshop.title)
    expect(html).not.toContain('secret-room-4417')
  })
})