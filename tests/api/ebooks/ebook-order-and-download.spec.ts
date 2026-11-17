/**
 * API: buying and downloading an ebook.
 *   POST /api/checkout/create-ebook-order   starts a purchase
 *   GET  /api/ebook/download?purchaseId=    the buyer's download (stamped with their name)
 *
 * Rules:
 *  - Only a PUBLISHED ebook with a valid price can be bought; the creator needs a payment gateway.
 *  - The price always comes from the database, never from the request.
 *  - Download needs a successful payment, is capped at the download limit, and is counted.
 *  - A refunded purchase cannot be downloaded again.
 * The download tests use a real tiny PDF in the TEST project's "ebook-files" bucket and skip
 * themselves if that bucket does not exist.
 */
import { test, expect } from '@playwright/test'
import crypto from 'crypto'
import { PDFDocument } from 'pdf-lib'
import { db } from '../../helpers/admin-db'
import { createCreator, createGateway, cleanup } from '../../helpers/factories'
import { createEbook, createEbookPurchase, cleanupProducts } from '../../helpers/product-seed'

const ORDER = '/api/checkout/create-ebook-order'
const DOWNLOAD = '/api/ebook/download'
const buyer = () => ({ buyerName: 'Test Reader', buyerEmail: `kurso.test+buyer-${crypto.randomBytes(4).toString('hex')}@example.com` })

let creator: any
let noGateway: any
test.beforeAll(async () => {
  creator = await createCreator()
  await createGateway(creator.id, 'razorpay', { credentials: { keyId: 'rzp_test_fake', keySecret: 'fake' } })
  noGateway = await createCreator()
})
test.afterAll(async () => { await cleanupProducts(); await cleanup() })

test.describe('starting a purchase', () => {
  test('EBK-001 missing ebook id, or missing name/email, is a 400', async ({ request }) => {
    expect((await request.post(ORDER, { data: buyer() })).status()).toBe(400)
    const e = await createEbook(creator.id)
    expect((await request.post(ORDER, { data: { ebookId: e.id, buyerName: '', buyerEmail: '' } })).status()).toBe(400)
  })
  test('EBK-002 an unknown ebook is a 404', async ({ request }) => {
    expect((await request.post(ORDER, { data: { ebookId: '00000000-0000-4000-8000-000000000000', ...buyer() } })).status()).toBe(404)
  })
  test('EBK-003 an unpublished ebook is a 403 and no transaction is created', async ({ request }) => {
    const e = await createEbook(creator.id, { published: false })
    expect((await request.post(ORDER, { data: { ebookId: e.id, ...buyer() } })).status()).toBe(403)
    expect((await db().from('transactions').select('id').eq('ebook_id', e.id)).data).toHaveLength(0)
  })
  test('EBK-004 a free (price 0) or over-limit ebook is refused', async ({ request }) => {
    const free = await createEbook(creator.id, { price: 0 })
    const huge = await createEbook(creator.id, { price: 100001 })
    expect((await request.post(ORDER, { data: { ebookId: free.id, ...buyer() } })).status()).toBe(400)
    expect((await request.post(ORDER, { data: { ebookId: huge.id, ...buyer() } })).status()).toBe(400)
  })
  test('EBK-005 a creator with no payment gateway is a 409', async ({ request }) => {
    const e = await createEbook(noGateway.id)
    expect((await request.post(ORDER, { data: { ebookId: e.id, ...buyer() } })).status()).toBe(409)
  })
  test('EBK-006 the price is read from the database: a price sent by the buyer is ignored', async ({ request }) => {
    const e = await createEbook(creator.id, { price: 299 })
    // The fake gateway keys make the gateway call fail (502), but the pending transaction is written first.
    await request.post(ORDER, { data: { ebookId: e.id, price: 1, amount: 1, ...buyer() } })
    const txns = (await db().from('transactions').select('*').eq('ebook_id', e.id)).data ?? []
    expect(txns).toHaveLength(1)
    expect(txns[0]).toMatchObject({ product_type: 'ebook', creator_id: creator.id })
    expect(Number(txns[0].amount)).toBe(299)
    expect(Number(txns[0].original_amount)).toBe(299)
  })
})

test.describe('downloading', () => {
  let pdfBytes: Uint8Array
  let bucketOk = true
  const uploaded: string[] = []

  async function ebookWithFile() {
    const e = await createEbook(creator.id)
    const { error } = await db().storage.from('ebook-files').upload(e.pdf_storage_path, pdfBytes, { contentType: 'application/pdf', upsert: true })
    if (error) bucketOk = false
    else uploaded.push(e.pdf_storage_path)
    return e
  }

  test.beforeAll(async () => {
    const doc = await PDFDocument.create()
    doc.addPage([300, 300])
    pdfBytes = await doc.save()
  })
  test.afterAll(async () => {
    if (uploaded.length) await db().storage.from('ebook-files').remove(uploaded)
  })

  test('EBK-010 no purchase id is a 400, an unknown one a 404', async ({ request }) => {
    expect((await request.get(DOWNLOAD)).status()).toBe(400)
    expect((await request.get(`${DOWNLOAD}?purchaseId=00000000-0000-4000-8000-000000000000`)).status()).toBe(404)
  })
  test('EBK-011 a purchase that is not paid yet is refused (402)', async ({ request }) => {
    const e = await createEbook(creator.id)
    for (const status of ['pending', 'failed', 'expired']) {
      const p = await createEbookPurchase(creator.id, e.id, { status })
      expect((await request.get(`${DOWNLOAD}?purchaseId=${p.id}`)).status(), status).toBe(402)
    }
  })
  test('EBK-012 a REFUNDED purchase can no longer be downloaded (rule c)', async ({ request }) => {
    const e = await createEbook(creator.id)
    const p = await createEbookPurchase(creator.id, e.id, { status: 'refunded' })
    expect((await request.get(`${DOWNLOAD}?purchaseId=${p.id}`)).status()).toBe(402)
  })
  test('EBK-013 once the download limit is used up, the file is refused (403)', async ({ request }) => {
    const e = await createEbook(creator.id)
    const p = await createEbookPurchase(creator.id, e.id, { downloadCount: 5, downloadLimit: 5 })
    expect((await request.get(`${DOWNLOAD}?purchaseId=${p.id}`)).status()).toBe(403)
  })
  test('EBK-014 a paid buyer receives a real PDF and the download is counted and logged', async ({ request }) => {
    const e = await ebookWithFile()
    test.skip(!bucketOk, 'the "ebook-files" storage bucket does not exist in the test project')
    const p = await createEbookPurchase(creator.id, e.id, { downloadLimit: 2 })
    const res = await request.get(`${DOWNLOAD}?purchaseId=${p.id}`)
    expect(res.status()).toBe(200)
    expect(res.headers()['content-type']).toBe('application/pdf')
    expect(res.headers()['content-disposition']).toContain('attachment')
    expect(res.headers()['cache-control']).toContain('no-store')
    expect(Buffer.from(await res.body()).subarray(0, 4).toString()).toBe('%PDF')
    expect((await db().from('transactions').select('ebook_download_count').eq('id', p.id).single()).data!.ebook_download_count).toBe(1)
    expect((await db().from('ebook_downloads').select('id').eq('purchase_id', p.id)).data).toHaveLength(1)
  })
  test('EBK-015 downloads stop exactly at the limit', async ({ request }) => {
    const e = await ebookWithFile()
    test.skip(!bucketOk, 'the "ebook-files" storage bucket does not exist in the test project')
    const p = await createEbookPurchase(creator.id, e.id, { downloadLimit: 2 })
    const codes: number[] = []
    for (let i = 0; i < 3; i++) codes.push((await request.get(`${DOWNLOAD}?purchaseId=${p.id}`)).status())
    expect(codes).toEqual([200, 200, 403])
  })
  test('EBK-016 two simultaneous downloads cannot exceed the limit', async ({ request }) => {
    const e = await ebookWithFile()
    test.skip(!bucketOk, 'the "ebook-files" storage bucket does not exist in the test project')
    const p = await createEbookPurchase(creator.id, e.id, { downloadLimit: 1 })
    const res = await Promise.all([1, 2, 3].map(() => request.get(`${DOWNLOAD}?purchaseId=${p.id}`)))
    expect(res.filter((r) => r.status() === 200)).toHaveLength(1)
  })
})