/**
 * SECURITY: the same lock as courses (PUB-008), for EBOOKS and WEBINARS.
 * A creator with an overdue Kurso invoice must not publish by talking to the database
 * directly (the dashboard buttons are just browser-side updates):
 *   - overdue COURSE invoice -> courses AND webinars are blocked
 *   - overdue EBOOK invoice  -> ebooks are blocked
 * One kind of invoice never blocks the other kind. Server paths (billing cron, payment
 * webhook, admin) use the service role and must keep working.
 * Needs the "block_publish_when_lapsed_products" SQL on the test database.
 */
import { test, expect } from '@playwright/test'
import { db } from '../../helpers/admin-db'
import { signedInClient } from '../../helpers/clients'
import { createCreator, createInvoice, cleanup } from '../../helpers/factories'
import { createWorkshop, createEbook, cleanupProducts } from '../../helpers/product-seed'

test.afterAll(async () => { await cleanupProducts(); await cleanup() })

const wsStatus = async (id: string) => (await db().from('workshops').select('status').eq('id', id).single()).data?.status
const ebPublished = async (id: string) => (await db().from('ebooks').select('is_published').eq('id', id).single()).data?.is_published

async function creatorWith(invoice?: 'course' | 'ebook') {
  const creator = await createCreator()
  if (invoice) await createInvoice(creator.id, { status: 'overdue', productType: invoice })
  const client = await signedInClient(creator.email, creator.password)
  return { creator, client }
}

test.describe('webinars', () => {
  test('WPUB-001 a creator with an overdue COURSE invoice cannot publish a draft webinar', async () => {
    const { creator, client } = await creatorWith('course')
    const w = await createWorkshop(creator.id, { status: 'draft' })
    await client.from('workshops').update({ status: 'published' }).eq('id', w.id)
    expect(await wsStatus(w.id)).toBe('draft')
  })
  test('WPUB-002 ...nor republish a paused one, even if they also clear the pause markers', async () => {
    const { creator, client } = await creatorWith('course')
    const w = await createWorkshop(creator.id, { status: 'draft' })
    await db().from('workshops').update({ auto_unpublished_at: new Date().toISOString(), auto_unpublished_reason: 'revenue_share_overdue' }).eq('id', w.id)
    await client.from('workshops').update({ status: 'published', auto_unpublished_at: null, auto_unpublished_reason: null }).eq('id', w.id)
    expect(await wsStatus(w.id)).toBe('draft')
  })
  test('WPUB-003 ...nor create a new webinar that is already published', async () => {
    const { creator, client } = await creatorWith('course')
    const { error } = await client.from('workshops').insert({
      creator_id: creator.id, title: 'Sneaky', slug: `sneaky-${Date.now()}`, date_time: new Date(Date.now() + 86_400_000).toISOString(), status: 'published',
    })
    expect(error).not.toBeNull()
  })
  test('WPUB-004 a creator who is up to date CAN publish (positive control)', async () => {
    const { creator, client } = await creatorWith()
    const w = await createWorkshop(creator.id, { status: 'draft' })
    const { error } = await client.from('workshops').update({ status: 'published' }).eq('id', w.id)
    expect(error).toBeNull()
    expect(await wsStatus(w.id)).toBe('published')
  })
  test('WPUB-005 an overdue EBOOK invoice does not block webinars', async () => {
    const { creator, client } = await creatorWith('ebook')
    const w = await createWorkshop(creator.id, { status: 'draft' })
    await client.from('workshops').update({ status: 'published' }).eq('id', w.id)
    expect(await wsStatus(w.id)).toBe('published')
  })
  test('WPUB-006 a lapsed creator can still edit, cancel or unpublish a webinar they already have', async () => {
    const { creator, client } = await creatorWith('course')
    const w = await createWorkshop(creator.id, { status: 'published' })
    const { error } = await client.from('workshops').update({ title: 'Renamed', status: 'cancelled' }).eq('id', w.id)
    expect(error).toBeNull()
    expect(await wsStatus(w.id)).toBe('cancelled')
  })
  test('WPUB-007 the server (service role) can still republish, as the payment webhook does', async () => {
    const { creator } = await creatorWith('course')
    const w = await createWorkshop(creator.id, { status: 'draft' })
    const { error } = await db().from('workshops').update({ status: 'published' }).eq('id', w.id)
    expect(error).toBeNull()
    expect(await wsStatus(w.id)).toBe('published')
  })
})

test.describe('ebooks', () => {
  test('EPUB-001 a creator with an overdue EBOOK invoice cannot publish an ebook', async () => {
    const { creator, client } = await creatorWith('ebook')
    const e = await createEbook(creator.id, { published: false })
    await client.from('ebooks').update({ is_published: true }).eq('id', e.id)
    expect(await ebPublished(e.id)).toBe(false)
  })
  test('EPUB-002 ...even when they also clear the pause markers', async () => {
    const { creator, client } = await creatorWith('ebook')
    const e = await createEbook(creator.id, { published: false })
    await db().from('ebooks').update({ auto_unpublished_at: new Date().toISOString(), auto_unpublished_reason: 'revenue_share_overdue' }).eq('id', e.id)
    await client.from('ebooks').update({ is_published: true, auto_unpublished_at: null, auto_unpublished_reason: null }).eq('id', e.id)
    expect(await ebPublished(e.id)).toBe(false)
  })
  test('EPUB-003 ...nor create a new ebook that is already published', async () => {
    const { creator, client } = await creatorWith('ebook')
    const { error } = await client.from('ebooks').insert({
      creator_id: creator.id, title: 'Sneaky', slug: `sneaky-${Date.now()}`, price: 100, pdf_storage_path: `${creator.id}/x.pdf`, is_published: true,
    })
    expect(error).not.toBeNull()
  })
  test('EPUB-004 a creator who is up to date CAN publish (positive control)', async () => {
    const { creator, client } = await creatorWith()
    const e = await createEbook(creator.id, { published: false })
    const { error } = await client.from('ebooks').update({ is_published: true }).eq('id', e.id)
    expect(error).toBeNull()
    expect(await ebPublished(e.id)).toBe(true)
  })
  test('EPUB-005 an overdue COURSE invoice does not block ebooks', async () => {
    const { creator, client } = await creatorWith('course')
    const e = await createEbook(creator.id, { published: false })
    await client.from('ebooks').update({ is_published: true }).eq('id', e.id)
    expect(await ebPublished(e.id)).toBe(true)
  })
  test('EPUB-006 a lapsed creator can still unpublish or edit an ebook they already have', async () => {
    const { creator, client } = await creatorWith('ebook')
    const e = await createEbook(creator.id, { published: true })
    const { error } = await client.from('ebooks').update({ title: 'Renamed', is_published: false }).eq('id', e.id)
    expect(error).toBeNull()
    expect(await ebPublished(e.id)).toBe(false)
  })
  test('EPUB-007 the server (service role) can still republish', async () => {
    const { creator } = await creatorWith('ebook')
    const e = await createEbook(creator.id, { published: false })
    const { error } = await db().from('ebooks').update({ is_published: true }).eq('id', e.id)
    expect(error).toBeNull()
    expect(await ebPublished(e.id)).toBe(true)
  })
})