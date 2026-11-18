/**
 * E2E (real browser): the public webinar page /w/<creator>/<webinar>.
 *  - the page shows the title and never the meeting link
 *  - the form refuses a short phone number
 *  - a free registration succeeds, the "You're registered" message shows, and the Telegram
 *    token is kept in the browser so a reload does not lose it
 *  - a paused (draft) webinar shows the not-found page
 */
import { test, expect } from '@playwright/test'
import { db } from '../helpers/admin-db'
import { createCreator, cleanup } from '../helpers/factories'
import { createWorkshop } from '../helpers/product-seed'
import { cleanupCheckout, newPhone } from '../helpers/checkout-seed'

let creator: any
let free: any
test.beforeAll(async () => {
  creator = await createCreator()
  free = await createWorkshop(creator.id, { price: 0, zoomLink: 'https://zoom.example.com/j/secret-room-9921' })
})
test.afterAll(async () => { await cleanupCheckout(); await cleanup() })

const url = (w: any) => `/w/${creator.creator_slug}/${w.slug}`

test('WEB-E01 the page shows the title and hides the meeting link', async ({ page }) => {
  await page.goto(url(free))
  await expect(page.getByText(free.title).first()).toBeVisible({ timeout: 30_000 })
  expect(await page.content()).not.toContain('secret-room-9921')
})

test('WEB-E02 a 3-digit phone number is refused and nothing is registered', async ({ page }) => {
  await page.goto(url(free))
  await page.getByPlaceholder('Full name').fill('Short Phone')
  await page.getByPlaceholder('WhatsApp number').fill('123')
  await page.getByRole('button', { name: 'Register for free' }).click()
  await expect(page.getByText('Please enter a valid 10-digit WhatsApp number')).toBeVisible({ timeout: 20_000 })
  const { data } = await db().from('workshop_registrations').select('id').eq('workshop_id', free.id).eq('name', 'Short Phone')
  expect(data).toHaveLength(0)
})

test('WEB-E03 a free registration succeeds and the Telegram token survives a reload', async ({ page }) => {
  await page.goto(url(free))
  await page.getByPlaceholder('Full name').fill('Browser Attendee')
  await page.getByPlaceholder('WhatsApp number').fill(newPhone())
  await page.getByRole('button', { name: 'Register for free' }).click()
  await expect(page.getByText(/You're registered/i)).toBeVisible({ timeout: 30_000 })
  const key = `kurso_ws_tg_${free.id}`
  const stored = await page.evaluate((k) => localStorage.getItem(k), key)
  expect(stored, 'token saved in the browser').toBeTruthy()
  expect(JSON.parse(stored!)).toHaveProperty('token')
  await page.reload()
  expect(await page.evaluate((k) => localStorage.getItem(k), key)).toBe(stored)
  const { data } = await db().from('workshop_registrations').select('payment_status').eq('workshop_id', free.id).eq('name', 'Browser Attendee')
  expect(data).toHaveLength(1)
})

test('WEB-E04 a draft (paused) webinar shows no title and no form', async ({ page }) => {
  const draft = await createWorkshop(creator.id, { status: 'draft', zoomLink: 'https://zoom.example.com/j/secret-room-9921' })
  await page.goto(url(draft))
  await expect(page.getByText(draft.title)).toHaveCount(0)
  await expect(page.getByPlaceholder('Full name')).toHaveCount(0)
})

test('WEB-E05 the page fits a phone screen (no sideways scroll)', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 700 } })
  const page = await ctx.newPage()
  await page.goto(url(free))
  await expect(page.getByPlaceholder('Full name')).toBeVisible({ timeout: 30_000 })
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(1)
  await ctx.close()
})