/**
 * E2E (real browser): the creator's Ebooks page and the publish lock.
 *  - a creator in good standing can publish and unpublish an ebook
 *  - a LAPSED creator (overdue ebook invoice) clicks Publish and it does NOT go live (server-side lock)
 */
import { test, expect } from '@playwright/test'
import { db } from '../helpers/admin-db'
import { daysAgo } from '../helpers/time'
import { createCreator, createInvoice, cleanup } from '../helpers/factories'
import { createEbook } from '../helpers/product-seed'
import { cleanupCheckout } from '../helpers/checkout-seed'
import { loginViaUi } from './ui'

test.afterAll(async () => { await cleanupCheckout(); await cleanup() })

const isLive = async (id: string) => (await db().from('ebooks').select('is_published').eq('id', id).single()).data!.is_published

test('CRE-E01 a creator publishes then unpublishes an ebook from the dashboard', async ({ page }) => {
  const c = await createCreator()
  const eb = await createEbook(c.id, { published: false })
  await loginViaUi(page, c.email, c.password)
  await page.goto('/dashboard/ebooks')
  const row = page.locator('div', { hasText: eb.title }).filter({ has: page.getByRole('button', { name: 'Publish' }) }).last()
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.getByRole('button', { name: 'Publish' }).click()
  await expect.poll(() => isLive(eb.id), { timeout: 20_000 }).toBe(true)
  await page.getByRole('button', { name: 'Unpublish' }).first().click()
  await expect.poll(() => isLive(eb.id), { timeout: 20_000 }).toBe(false)
})

test('CRE-E02 a lapsed creator cannot publish an ebook: it stays a draft in the page and in the database', async ({ page }) => {
  const c = await createCreator()
  const inv = await createInvoice(c.id, { amount: 1500, productType: 'ebook', status: 'overdue' })
  await db().from('revenue_share_invoices').update({ created_at: daysAgo(20) }).eq('id', inv.id)
  const eb = await createEbook(c.id, { published: false })
  await loginViaUi(page, c.email, c.password)
  await page.goto('/dashboard/ebooks')
  await page.getByRole('button', { name: 'Publish' }).first().click()
  await expect(page.locator('p', { hasText: /overdue|revenue|lapsed|pay|blocked|cannot|can't/i }).first()).toBeVisible({ timeout: 20_000 })
  expect(await isLive(eb.id)).toBe(false)
})