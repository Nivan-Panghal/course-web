/**
 * E2E (real browser): the creator's course editor and payment settings.
 *  - the course list shows Live and Draft
 *  - the Publish switch takes a course live and back to draft
 *  - a LAPSED creator (overdue course invoice) flips the switch and the course stays a draft
 *    (the database refuses; the page shows the reason in an alert box)
 *  - fake payment keys are refused by "Verify & Connect" and nothing is saved
 */
import { test, expect } from '@playwright/test'
import { db } from '../helpers/admin-db'
import { daysAgo } from '../helpers/time'
import { createCreator, createCourse, createLesson, createInvoice, cleanup } from '../helpers/factories'
import { loginViaUi } from './ui'

test.afterAll(async () => { await cleanup() })

const isLive = async (id: string) => (await db().from('courses').select('is_published').eq('id', id).single()).data!.is_published

/** The switch sits next to the "Course is Draft/Live" text. */
const publishSwitch = (page: import('@playwright/test').Page, label: 'Course is Draft' | 'Course is Live') =>
  page.getByText(label, { exact: true }).locator('xpath=../..').getByRole('button').first()

test('CCR-E01 the course list shows a live course and a draft course', async ({ page }) => {
  const c = await createCreator()
  const live = await createCourse(c.id, { published: true })
  const draft = await createCourse(c.id, { published: false })
  await loginViaUi(page, c.email, c.password)
  await page.goto('/dashboard/courses')
  await expect(page.getByText(live.name).first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(draft.name).first()).toBeVisible()
  await expect(page.getByText('Live', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Draft', { exact: true }).first()).toBeVisible()
})

test('CCR-E02 the Publish switch takes a course live and back to draft', async ({ page }) => {
  const c = await createCreator()
  const course = await createCourse(c.id, { published: false })
  await createLesson(course.id, c.id, { order: 1 })
  await loginViaUi(page, c.email, c.password)
  await page.goto(`/dashboard/courses/${course.id}`)
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByText('Course is Draft', { exact: true })).toBeVisible({ timeout: 30_000 })
  await publishSwitch(page, 'Course is Draft').click()
  await expect(page.getByText('Course is Live', { exact: true })).toBeVisible({ timeout: 20_000 })
  expect(await isLive(course.id)).toBe(true)
  await publishSwitch(page, 'Course is Live').click()
  await expect(page.getByText('Course is Draft', { exact: true })).toBeVisible({ timeout: 20_000 })
  expect(await isLive(course.id)).toBe(false)
})

test('CCR-E03 a LAPSED creator cannot publish: an alert explains it and the course stays a draft', async ({ page }) => {
  const c = await createCreator()
  const inv = await createInvoice(c.id, { amount: 1500, productType: 'course', status: 'overdue' })
  await db().from('revenue_share_invoices').update({ created_at: daysAgo(20) }).eq('id', inv.id)
  const course = await createCourse(c.id, { published: false })
  await createLesson(course.id, c.id, { order: 1 })
  await loginViaUi(page, c.email, c.password)
  await page.goto(`/dashboard/courses/${course.id}`)
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByText('Course is Draft', { exact: true })).toBeVisible({ timeout: 30_000 })
  let alertText = ''
  page.once('dialog', async (d) => { alertText = d.message(); await d.dismiss() })
  await publishSwitch(page, 'Course is Draft').click()
  await expect.poll(() => alertText, { timeout: 20_000 }).not.toBe('')
  await expect(page.getByText('Course is Draft', { exact: true })).toBeVisible()
  expect(await isLive(course.id)).toBe(false)
})

test('CCR-E04 fake payment keys are refused by "Verify & Connect" and nothing is saved', async ({ page }) => {
  const c = await createCreator()
  await loginViaUi(page, c.email, c.password)
  await page.goto('/dashboard/settings')
  const connect = page.getByRole('button', { name: 'Verify & Connect' })
  await connect.scrollIntoViewIfNeeded()
  const secrets = page.locator('input[type="password"]')
  const n = await secrets.count()
  for (let i = 0; i < n; i++) await secrets.nth(i).fill(`fake-key-${i}-abc123`)
  await connect.click()
  await expect(connect).toBeEnabled({ timeout: 45_000 })
  const { data } = await db().from('creator_payment_gateways').select('id, status').eq('creator_id', c.id)
  expect((data ?? []).filter((g: any) => g.status === 'verified')).toHaveLength(0)
})