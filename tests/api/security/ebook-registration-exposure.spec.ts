/**
 * SECURITY: what the public can read from a PUBLISHED ebook, and registration moves between webinars.
 *  - EXP: a signed-out visitor can read the shop-page fields of a published ebook (CONTROL) but never the
 *    private file path or any secret-looking column
 *  - REG: a creator cannot move a registration of theirs into ANOTHER creator's webinar
 * If EXP-001 or EXP-002 FAILS it is a real finding: tell Claude, who gives the exact SQL to hide the column.
 */
import { test, expect } from '@playwright/test'
import { db } from '../../helpers/admin-db'
import { anonClient, signedInClient, visibleRows } from '../../helpers/clients'
import { createCreator, cleanup } from '../../helpers/factories'
import { createEbook, createWorkshop, createRegistration } from '../../helpers/product-seed'
import { cleanupCheckout } from '../../helpers/checkout-seed'

let A: any, B: any, ebook: any, workshopA: any, workshopB: any, registration: any
test.beforeAll(async () => {
  A = await createCreator()
  B = await createCreator()
  ebook = await createEbook(A.id, { published: true })
  workshopA = await createWorkshop(A.id, { price: 499 })
  workshopB = await createWorkshop(B.id, { price: 499 })
  registration = await createRegistration(workshopA.id, { status: 'confirmed', mode: 'gateway' })
})
test.afterAll(async () => { await cleanupCheckout(); await cleanup() })

test.describe('published ebook, read by a signed-out visitor', () => {
  test('EXP-000 CONTROL: the shop-page fields are readable', async () => {
    const rows = visibleRows(await anonClient().from('ebooks').select('id, title, price').eq('id', ebook.id))
    expect(rows, 'control failed: a published ebook must be readable').toHaveLength(1)
    expect(rows[0].title).toBe(ebook.title)
  })
  test('EXP-001 the private file path is not readable', async () => {
    const res = await anonClient().from('ebooks').select('pdf_storage_path').eq('id', ebook.id)
    const leaked = visibleRows(res).filter((r) => r.pdf_storage_path)
    expect(leaked, 'a signed-out visitor can read where the private PDF is stored').toHaveLength(0)
  })
  test('EXP-002 a select-all returns no file path and no secret-looking column', async () => {
    const rows = visibleRows(await anonClient().from('ebooks').select('*').eq('id', ebook.id))
    for (const row of rows) {
      const bad = Object.keys(row).filter((k) => /pdf_storage_path|secret|token|password|webhook|api_key/i.test(k) && row[k])
      expect(bad, `columns a visitor should not see: ${bad.join(', ')}`).toEqual([])
    }
  })
})

test.describe('moving a registration', () => {
  test('REG-001 a creator cannot move their registration into ANOTHER creator\'s webinar', async () => {
    const a = await signedInClient(A.email, A.password)
    await a.from('workshop_registrations').update({ workshop_id: workshopB.id }).eq('id', registration.id)
    const row = (await db().from('workshop_registrations').select('workshop_id').eq('id', registration.id).single()).data!
    expect(row.workshop_id).toBe(workshopA.id)
  })
})