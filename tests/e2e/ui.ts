/**
 * E2E helpers: small, shared browser actions so every spec reads like a story.
 */
import { expect, Page } from '@playwright/test'

/** Sign in through the real login form and wait until we have left /login. */
export async function loginViaUi(page: Page, email: string, password: string) {
  await page.goto('/login')
  await page.getByPlaceholder('you@example.com').fill(email)
  await page.getByPlaceholder('Your password').fill(password)
  await page.getByRole('button', { name: 'Sign In', exact: true }).last().click()
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 })
}

/** The page ended up on this path (query string ignored). */
export async function expectPath(page: Page, path: string) {
  await expect.poll(() => new URL(page.url()).pathname, { timeout: 30_000 }).toBe(path)
}