/**
 * E2E (real browser): a creator creating a webinar on /dashboard/workshops/create.
 * The form publishes at once ("Your page goes live as soon as you publish"), so:
 *  - a good form goes live and its public page opens
 *  - missing title, a start time in the past, and a paid webinar without a price are refused with a message
 *  - a LAPSED creator (overdue course invoice, which also covers webinar revenue) cannot publish: the
 *    database refuses, the page shows the reason, and no webinar is created
 */
import { test, expect, Page } from '@playwright/test'
import { db } from '../helpers/admin-db'
import { daysAgo } from '../helpers/time'
import { createCreator, createInvoice, cleanup } from '../helpers/factories'
import { cleanupCheckout } from '../helpers/checkout-seed'
import { loginViaUi } from './ui'

test.afterAll(async () => { await cleanupCheckout(); await cleanup() })

/** A date in India (IST) n days from now, as YYYY-MM-DD. */
const istDate = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })

const workshopsOf = async (creatorId: string) =>
  (await db().from('workshops').select('id, slug, title, status').eq('creator_id', creatorId)).data ?? []

async function fillForm(page: Page, o: { title?: string; date?: string; time?: string; host?: string }) {
  await page.locator('#ws-title').fill(o.title ?? '')
  await page.locator('#ws-date').fill(o.date ?? istDate(2))
  await page.locator('#ws-time').fill(o.time ?? '10:00')
  await page.locator('#ws-host').fill(o.host ?? 'Test Host')
}

test('WSC-E01 a good form publishes the webinar and its public page opens', async ({ page }) => {
  const c = await createCreator()
  await loginViaUi(page, c.email, c.password)
  await page.goto('/dashboard/workshops/create')
  const title = `Browser Webinar ${Date.now()}`
  await fillForm(page, { title })
  await page.getByRole('button', { name: 'Publish workshop' }).click()
  await expect(page.getByText('Your workshop is live')).toBeVisible({ timeout: 30_000 })
  const rows = await workshopsOf(c.id)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ title, status: 'published' })
  await page.goto(`/w/${c.creator_slug}/${rows[0].slug}`)
  await expect(page.getByText(title).first()).toBeVisible({ timeout: 30_000 })
})

test('WSC-E02 a missing title is refused with a message and nothing is created', async ({ page }) => {
  const c = await createCreator()
  await loginViaUi(page, c.email, c.password)
  await page.goto('/dashboard/workshops/create')
  await fillForm(page, { title: '' })
  await page.getByRole('button', { name: 'Publish workshop' }).click()
  await expect(page.getByText('Give your workshop a title.')).toBeVisible({ timeout: 20_000 })
  expect(await workshopsOf(c.id)).toHaveLength(0)
})

test('WSC-E03 a start time in the past is refused and nothing is created', async ({ page }) => {
  const c = await createCreator()
  await loginViaUi(page, c.email, c.password)
  await page.goto('/dashboard/workshops/create')
  await fillForm(page, { title: 'Past Webinar', date: istDate(0), time: '00:00' })
  await page.getByRole('button', { name: 'Publish workshop' }).click()
  await expect(page.getByText(/already passed/i)).toBeVisible({ timeout: 20_000 })
  expect(await workshopsOf(c.id)).toHaveLength(0)
})

test('WSC-E03b a date in the past is blocked by the date box itself, so the form is never sent', async ({ page }) => {
  const c = await createCreator()
  await loginViaUi(page, c.email, c.password)
  await page.goto('/dashboard/workshops/create')
  await fillForm(page, { title: 'Past Date Webinar', date: istDate(-2) })
  await page.getByRole('button', { name: 'Publish workshop' }).click()
  const tooEarly = await page.locator('#ws-date').evaluate((el) => (el as HTMLInputElement).validity.rangeUnderflow)
  expect(tooEarly).toBe(true)
  await expect(page.getByText('Your workshop is live')).toHaveCount(0)
  expect(await workshopsOf(c.id)).toHaveLength(0)
})

test('WSC-E04 a paid webinar without a price is refused', async ({ page }) => {
  const c = await createCreator()
  await loginViaUi(page, c.email, c.password)
  await page.goto('/dashboard/workshops/create')
  await fillForm(page, { title: 'Paid No Price' })
  await page.getByRole('button', { name: 'Paid', exact: true }).click()
  await page.getByRole('button', { name: 'Publish workshop' }).click()
  await expect(page.getByText(/price of ₹1 or more/i)).toBeVisible({ timeout: 20_000 })
  expect(await workshopsOf(c.id)).toHaveLength(0)
})

test('WSC-E05 a LAPSED creator cannot publish a webinar: the page shows an error and nothing is created', async ({ page }) => {
  const c = await createCreator()
  const inv = await createInvoice(c.id, { amount: 1500, productType: 'course', status: 'overdue' })
  await db().from('revenue_share_invoices').update({ created_at: daysAgo(20) }).eq('id', inv.id)
  await loginViaUi(page, c.email, c.password)
  await page.goto('/dashboard/workshops/create')
  await fillForm(page, { title: 'Lapsed Webinar' })
  await page.getByRole('button', { name: 'Publish workshop' }).click()
  await expect(page.getByRole('alert')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('Your workshop is live')).toHaveCount(0)
  expect(await workshopsOf(c.id)).toHaveLength(0)
})