/**
 * API: a creator adding a CASHFREE key. Route: /api/creator/payment-gateway.
 * Credential fields for Cashfree are clientId + clientSecret. [network] tests call Cashfree's
 * sandbox (each successful verification creates a harmless ₹1 test order in your sandbox).
 * Keys: TEST_CASHFREE_APP_ID / TEST_CASHFREE_SECRET_KEY, falling back to KURSO_CASHFREE_*.
 */
import { test, expect } from '@playwright/test'
import { db } from '../../helpers/admin-db'
import { accessToken } from '../../helpers/clients'
import { createCreator, cleanup } from '../../helpers/factories'

const URL = '/api/creator/payment-gateway'
const CF_ID = process.env.TEST_CASHFREE_APP_ID || process.env.KURSO_CASHFREE_CLIENT_ID
const CF_SECRET = process.env.TEST_CASHFREE_SECRET_KEY || process.env.KURSO_CASHFREE_CLIENT_SECRET
const RZP_ID = process.env.TEST_RAZORPAY_KEY_ID
const RZP_SECRET = process.env.TEST_RAZORPAY_KEY_SECRET
const haveCf = !!(CF_ID && CF_SECRET)
const haveBoth = haveCf && !!(RZP_ID && RZP_SECRET)

test.afterAll(async () => { await cleanup() })

async function creatorWithToken() {
  const creator = await createCreator()
  const token = await accessToken(creator.email, creator.password)
  return { creator, headers: { authorization: `Bearer ${token}` } }
}
const rowFor = async (creatorId: string, provider = 'cashfree') =>
  (await db().from('creator_payment_gateways').select('*').eq('creator_id', creatorId).eq('provider', provider).maybeSingle()).data
const cashfreeBody = (extra: object = {}) => ({ provider: 'cashfree', environment: 'sandbox', credentials: { clientId: CF_ID, clientSecret: CF_SECRET }, ...extra })

test('empty Cashfree credentials -> 400, saved as FAILED, never verified', async ({ request }) => {
  const { creator, headers } = await creatorWithToken()
  const res = await request.post(URL, { headers, data: { provider: 'cashfree', environment: 'sandbox', credentials: {} } })
  expect(res.status()).toBe(400)
  expect((await res.json()).error).toMatch(/Please enter your/)
  expect((await rowFor(creator.id))?.status).toBe('failed')
})

test('[network] wrong credentials are rejected by Cashfree and NOT marked verified', async ({ request }) => {
  const { creator, headers } = await creatorWithToken()
  const res = await request.post(URL, { headers, data: { provider: 'cashfree', environment: 'sandbox', credentials: { clientId: 'TEST_wrong_id', clientSecret: 'cfsk_ma_test_wrong' } } })
  expect(res.status()).toBe(400)
  expect((await res.json()).error).toMatch(/rejected these credentials/)
  expect((await rowFor(creator.id))?.status).toBe('failed')
})

test('[network] valid keys -> verified; stored encrypted; never echoed back', async ({ request }) => {
  test.skip(!haveCf, 'Set TEST_CASHFREE_APP_ID / TEST_CASHFREE_SECRET_KEY (or KURSO_CASHFREE_*) in .env.test')
  const { creator, headers } = await creatorWithToken()
  const res = await request.post(URL, { headers, data: cashfreeBody({ webhookSecret: 'cf_plain_webhook_secret' }) })
  expect(res.status()).toBe(200)
  expect(await res.json()).toEqual({ success: true, status: 'verified' })

  const row = await rowFor(creator.id)
  expect(row?.status).toBe('verified')
  expect(row?.environment).toBe('sandbox')
  expect(row?.credentials_encrypted).not.toContain(CF_SECRET!)
  expect(row?.webhook_secret_encrypted).not.toContain('cf_plain_webhook_secret')

  const text = JSON.stringify(await (await request.get(URL, { headers })).json())
  expect(text).not.toContain(CF_SECRET!)
  expect(text).not.toContain('cf_plain_webhook_secret')
})

test('[network] choosing "default" moves the default flag to that gateway only', async ({ request }) => {
  test.skip(!haveBoth, 'Needs both Cashfree and Razorpay test keys in .env.test')
  const { creator, headers } = await creatorWithToken()
  await request.post(URL, { headers, data: cashfreeBody({ setDefault: true }) })
  await request.post(URL, { headers, data: { provider: 'razorpay', environment: 'sandbox', credentials: { keyId: RZP_ID, keySecret: RZP_SECRET }, setDefault: true } })
  expect((await rowFor(creator.id, 'razorpay'))?.is_default).toBe(true)
  expect((await rowFor(creator.id, 'cashfree'))?.is_default).toBe(false)
})

test('[network] EDGE: re-saving the default gateway (e.g. rotating its key) keeps it the default', async ({ request }) => {
  test.skip(!haveCf, 'Set Cashfree test keys in .env.test')
  const { creator, headers } = await creatorWithToken()
  await request.post(URL, { headers, data: cashfreeBody({ setDefault: true }) })
  await request.post(URL, { headers, data: cashfreeBody() }) // same gateway again, "make default" not ticked
  expect((await rowFor(creator.id))?.is_default).toBe(true)
})