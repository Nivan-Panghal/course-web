/**
 * E2E helpers for the course enroll popup (src/components/EnrollModal.tsx).
 * Students are created BY the popup in these tests (that is how real students are born),
 * so they must be tracked and removed here: factories.cleanup() does not know about them.
 */
import { expect, Page } from '@playwright/test'
import crypto from 'crypto'
import { db } from '../helpers/admin-db'
import { TEST_PASSWORD } from '../helpers/factories'

const PREFIX = 'kurso.test+ui-'
export const uiEmail = () => `${PREFIX}${crypto.randomBytes(4).toString('hex')}@example.com`
export const uiPassword = TEST_PASSWORD
/** 10-digit Indian mobile number that is unique per call. */
export const uiPhone = () => '9' + String(Date.now()).slice(-8) + String(Math.floor(Math.random() * 10))

/** Opens the standalone checkout page and clicks its Enroll button. The popup is the element with data-brand-scope. */
export async function openEnrollPopup(page: Page, courseId: string) {
  await page.goto(`/enroll/${courseId}`)
  await page.getByRole('button', { name: /^Enroll/ }).first().click()
  const popup = page.locator('[data-brand-scope]').last()
  await expect(popup.getByText('Enroll in Course')).toBeVisible({ timeout: 30_000 })
  return popup
}

/** Fills the "New Student" form and presses Sign Up. */
export async function fillSignup(popup: ReturnType<Page['locator']>, o: { name?: string; email: string; phone: string; password?: string; stayOnForm?: boolean }) {
  await popup.getByPlaceholder('Full name').fill(o.name ?? 'Browser Student')
  await popup.getByPlaceholder('Email address').fill(o.email)
  await popup.getByPlaceholder(/Mobile number/).fill(o.phone)
  await popup.getByPlaceholder(/Create password/).fill(o.password ?? uiPassword)
  await popup.getByRole('button', { name: /Sign Up & Continue/ }).click()
  // If the popup does not move on, fail with what it actually says (rate limit, email not confirmed, ...).
  await popup.getByRole('button', { name: /Please wait/ }).waitFor({ state: 'detached', timeout: 45_000 }).catch(() => {})
  if (!o.stayOnForm && await popup.getByRole('button', { name: /Sign Up & Continue/ }).isVisible()) {
    throw new Error(`Sign-up did not move on. The popup says: ${(await popup.innerText()).slice(0, 500)}`)
  }
}

/** Removes every student the popup created during a run. Call in afterAll BEFORE factories.cleanup(). */
export async function cleanupUiStudents() {
  const d = db()
  const { data } = await d.auth.admin.listUsers({ page: 1, perPage: 1000 })
  const users = (data?.users ?? []).filter((u) => u.email?.startsWith(PREFIX))
  for (const u of users) {
    const { data: rows } = await d.from('students').select('id').eq('auth_id', u.id)
    for (const r of rows ?? []) {
      await d.from('enrollments').delete().eq('student_id', r.id)
      await d.from('students').delete().eq('id', r.id)
    }
    await d.from('enrollments').delete().eq('phone', u.user_metadata?.phone ?? '__none__')
    const { error } = await d.auth.admin.deleteUser(u.id)
    if (error) console.warn(`[cleanup] ui student ${u.email}: ${error.message}`)
  }
}