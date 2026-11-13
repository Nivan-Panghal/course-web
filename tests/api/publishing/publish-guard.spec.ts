/**
 * SECURITY (PUB-008): a creator with an OVERDUE Kurso invoice must not be able to publish a
 * course by talking to the database directly (the dashboard toggle is just a browser-side
 * update). Rule (a): a lapsed creator cannot republish, enforced on the server.
 * Server paths (billing cron, payment webhook, admin) must keep working. These tests act as the
 * creator through the public API, exactly like the browser does.
 */
import { test, expect } from '@playwright/test'
import { db } from '../../helpers/admin-db'
import { signedInClient } from '../../helpers/clients'
import { createCreator, createCourse, createInvoice, cleanup } from '../../helpers/factories'

test.afterAll(async () => { await cleanup() })

const isPublished = async (id: string) => (await db().from('courses').select('is_published').eq('id', id).single()).data?.is_published

async function lapsedCreator() {
  const creator = await createCreator()
  const invoice = await createInvoice(creator.id, { status: 'overdue' })
  const paused = await createCourse(creator.id, { published: false })
  await db().from('courses').update({ auto_unpublished_at: new Date().toISOString(), auto_unpublished_reason: 'revenue_share_overdue' }).eq('id', paused.id)
  const client = await signedInClient(creator.email, creator.password)
  return { creator, invoice, paused, client }
}

test.describe('a lapsed creator (overdue invoice)', () => {
  test('cannot republish a paused course with a direct update', async () => {
    const { paused, client } = await lapsedCreator()
    await client.from('courses').update({ is_published: true }).eq('id', paused.id)
    expect(await isPublished(paused.id)).toBe(false)
  })

  test('cannot get around it by also clearing the pause markers', async () => {
    const { paused, client } = await lapsedCreator()
    await client.from('courses').update({ is_published: true, auto_unpublished_at: null, auto_unpublished_reason: null }).eq('id', paused.id)
    expect(await isPublished(paused.id)).toBe(false)
  })

  test('cannot publish a never-paused draft either', async () => {
    const { creator, client } = await lapsedCreator()
    const draft = await createCourse(creator.id, { published: false })
    await client.from('courses').update({ is_published: true }).eq('id', draft.id)
    expect(await isPublished(draft.id)).toBe(false)
  })

  test('cannot create a new course that is already published', async () => {
    const { creator, client } = await lapsedCreator()
    const slug = `lapsed-${Date.now()}`
    await client.from('courses').insert({ creator_id: creator.id, name: 'Sneaky', slug, price: 100, is_published: true })
    const { data } = await db().from('courses').select('id').eq('slug', slug)
    expect(data).toHaveLength(0)
  })

  test('can still edit a paused course (only publishing is blocked)', async () => {
    const { paused, client } = await lapsedCreator()
    await client.from('courses').update({ name: 'Renamed while lapsed' }).eq('id', paused.id)
    expect((await db().from('courses').select('name').eq('id', paused.id).single()).data?.name).toBe('Renamed while lapsed')
  })

  test('can publish again once the invoice is paid', async () => {
    const { paused, invoice, client } = await lapsedCreator()
    await db().from('revenue_share_invoices').update({ status: 'paid' }).eq('id', invoice.id)
    await client.from('courses').update({ is_published: true }).eq('id', paused.id)
    expect(await isPublished(paused.id)).toBe(true)
  })
})

test.describe('creators who are NOT lapsed are never blocked', () => {
  test('no invoices: can publish, unpublish and create a published course', async () => {
    const creator = await createCreator()
    const course = await createCourse(creator.id, { published: false })
    const client = await signedInClient(creator.email, creator.password)
    await client.from('courses').update({ is_published: true }).eq('id', course.id)
    expect(await isPublished(course.id)).toBe(true)
    await client.from('courses').update({ is_published: false }).eq('id', course.id)
    expect(await isPublished(course.id)).toBe(false)
    const slug = `fine-${Date.now()}`
    await client.from('courses').insert({ creator_id: creator.id, name: 'Fine', slug, price: 100, is_published: true })
    expect((await db().from('courses').select('id').eq('slug', slug)).data).toHaveLength(1)
  })

  for (const [label, status, productType] of [
    ['a pending (not yet overdue) invoice', 'pending', 'course'],
    ['a paid invoice', 'paid', 'course'],
    ['an overdue EBOOK invoice', 'overdue', 'ebook'],
  ] as const) {
    test(`${label} does not block publishing courses`, async () => {
      const creator = await createCreator()
      await createInvoice(creator.id, { status, productType })
      const course = await createCourse(creator.id, { published: false })
      const client = await signedInClient(creator.email, creator.password)
      await client.from('courses').update({ is_published: true }).eq('id', course.id)
      expect(await isPublished(course.id)).toBe(true)
    })
  }
})

test('server paths still work: the service role can re-open a lapsed creator\'s course (webhook / cron / admin)', async () => {
  const { paused } = await lapsedCreator()
  const { error } = await db().from('courses').update({ is_published: true }).eq('id', paused.id)
  expect(error).toBeNull()
  expect(await isPublished(paused.id)).toBe(true)
})