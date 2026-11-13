/**
 * API: a creator adding / listing / removing payment-gateway keys (Razorpay).
 * Route: /api/creator/payment-gateway (POST verifies the key with Razorpay BEFORE saving).
 * Tests marked [network] call Razorpay's real test API. Those needing real keys are
 * skipped unless TEST_RAZORPAY_KEY_ID / TEST_RAZORPAY_KEY_SECRET are set in .env.test.
 */
import { test, expect } from '@playwright/test'
import { db } from '../../helpers/admin-db'
import { accessToken } from '../../helpers/clients'
import { createCreator, createGateway, cleanup } from '../../helpers/factories'

const URL = '/api/creator/payment-gateway'
const KEY_ID = process.env.TEST_RAZORPAY_KEY_ID
const KEY_SECRET = process.env.TEST_RAZORPAY_KEY_SECRET
const haveKeys = !!(KEY_ID && KEY_SECRET)

test.afterAll(async () => { await cleanup() })

async function creatorWithToken() {
  const creator = await createCreator()
  const token = await accessToken(creator.email, creator.password)
  return { creator, headers: { authorization: `Bearer ${token}` } }
}
const rowFor = async (creatorId: string) =>
  (await db().from('creator_payment_gateways').select('*').eq('creator_id', creatorId).eq('provider', 'razorpay').maybeSingle()).data

test.describe('who may call the route', () => {
  test('no login -> 401 on POST, GET and DELETE', async ({ request }) => {
    expect((await request.post(URL, { data: { provider: 'razorpay' } })).status()).toBe(401)
    expect((await request.get(URL)).status()).toBe(401)
    expect((await request.delete(`${URL}?provider=razorpay`)).status()).toBe(401)
  })
  test('invalid token -> 401', async ({ request }) => {
    const res = await request.get(URL, { headers: { authorization: 'Bearer not-a-real-token' } })
    expect(res.status()).toBe(401)
  })
})

test.describe('adding a key: validation that needs no network', () => {
  test('unknown provider -> 400', async ({ request }) => {
    const { headers } = await creatorWithToken()
    const res = await request.post(URL, { headers, data: { provider: 'paypal', credentials: {} } })
    expect(res.status()).toBe(400)
    expect((await res.json()).error).toBe('Unknown payment provider.')
  })

  test('empty credentials -> 400 and saved as FAILED, never verified', async ({ request }) => {
    const { creator, headers } = await creatorWithToken()
    const res = await request.post(URL, { headers, data: { provider: 'razorpay', environment: 'sandbox', credentials: {} } })
    expect(res.status()).toBe(400)
    expect((await res.json()).error).toMatch(/Please enter your/)
    const row = await rowFor(creator.id)
    expect(row?.status).toBe('failed')
    expect(row?.last_verification_error).toBeTruthy()
  })

  test('a TEST key with "Live" selected is rejected before any network call', async ({ request }) => {
    const { creator, headers } = await creatorWithToken()
    const res = await request.post(URL, { headers, data: { provider: 'razorpay', environment: 'production', credentials: { keyId: 'rzp_test_abc', keySecret: 'x' } } })
    expect(res.status()).toBe(400)
    expect((await res.json()).error).toMatch(/TEST key/)
    expect((await rowFor(creator.id))?.status).toBe('failed')
  })

  test('a LIVE key with "Sandbox" selected is rejected before any network call', async ({ request }) => {
    const { headers } = await creatorWithToken()
    const res = await request.post(URL, { headers, data: { provider: 'razorpay', environment: 'sandbox', credentials: { keyId: 'rzp_live_abc', keySecret: 'x' } } })
    expect(res.status()).toBe(400)
    expect((await res.json()).error).toMatch(/LIVE key/)
  })
})

test.describe('adding a key: live verification [network]', () => {
  test('wrong credentials are rejected by Razorpay and NOT marked verified', async ({ request }) => {
    const { creator, headers } = await creatorWithToken()
    const res = await request.post(URL, { headers, data: { provider: 'razorpay', environment: 'sandbox', credentials: { keyId: 'rzp_test_doesnotexist01', keySecret: 'wrong-secret' } } })
    expect(res.status()).toBe(400)
    expect((await res.json()).error).toMatch(/rejected these credentials/)
    expect((await rowFor(creator.id))?.status).toBe('failed')
  })

  test('valid keys -> verified; stored encrypted; never echoed back', async ({ request }) => {
    test.skip(!haveKeys, 'Set TEST_RAZORPAY_KEY_ID and TEST_RAZORPAY_KEY_SECRET in .env.test')
    const { creator, headers } = await creatorWithToken()
    const res = await request.post(URL, { headers, data: { provider: 'razorpay', environment: 'sandbox', credentials: { keyId: KEY_ID, keySecret: KEY_SECRET } } })
    expect(res.status()).toBe(200)
    expect(await res.json()).toEqual({ success: true, status: 'verified' })

    const row = await rowFor(creator.id)
    expect(row?.status).toBe('verified')
    expect(row?.verified_at).toBeTruthy()
    expect(row?.credentials_encrypted).not.toContain(KEY_SECRET!)
    expect(row?.credentials_encrypted).not.toContain(KEY_ID!)
    expect(row?.webhook_secret_encrypted).toBeNull() // none was supplied

    const list = await request.get(URL, { headers })
    const text = JSON.stringify(await list.json())
    expect(text).not.toContain(KEY_SECRET!)
    const gw = JSON.parse(text).gateways[0]
    expect(Object.keys(gw).sort()).toEqual(['environment', 'is_default', 'last_verification_error', 'provider', 'status', 'updated_at', 'verified_at'])
  })

  test('a webhook secret, when given, is stored encrypted', async ({ request }) => {
    test.skip(!haveKeys, 'Set TEST_RAZORPAY_KEY_ID and TEST_RAZORPAY_KEY_SECRET in .env.test')
    const { creator, headers } = await creatorWithToken()
    await request.post(URL, { headers, data: { provider: 'razorpay', environment: 'sandbox', credentials: { keyId: KEY_ID, keySecret: KEY_SECRET }, webhookSecret: 'whsec_plain_text_secret' } })
    const row = await rowFor(creator.id)
    expect(row?.webhook_secret_encrypted).toBeTruthy()
    expect(row?.webhook_secret_encrypted).not.toContain('whsec_plain_text_secret')
  })

  test('fixing a failed attempt flips the same row to verified', async ({ request }) => {
    test.skip(!haveKeys, 'Set TEST_RAZORPAY_KEY_ID and TEST_RAZORPAY_KEY_SECRET in .env.test')
    const { creator, headers } = await creatorWithToken()
    await request.post(URL, { headers, data: { provider: 'razorpay', environment: 'sandbox', credentials: { keyId: 'rzp_test_bad', keySecret: 'bad' } } })
    expect((await rowFor(creator.id))?.status).toBe('failed')
    await request.post(URL, { headers, data: { provider: 'razorpay', environment: 'sandbox', credentials: { keyId: KEY_ID, keySecret: KEY_SECRET } } })
    const row = await rowFor(creator.id)
    expect(row?.status).toBe('verified')
    expect(row?.last_verification_error).toBeNull()
    const { data } = await db().from('creator_payment_gateways').select('id').eq('creator_id', creator.id).eq('provider', 'razorpay')
    expect(data).toHaveLength(1) // upsert, not a duplicate row
  })
})

test.describe('isolation between creators', () => {
  test('GET lists only my own gateways', async ({ request }) => {
    const a = await creatorWithToken()
    const b = await creatorWithToken()
    await createGateway(a.creator.id, 'razorpay')
    expect((await (await request.get(URL, { headers: a.headers })).json()).gateways).toHaveLength(1)
    expect((await (await request.get(URL, { headers: b.headers })).json()).gateways).toHaveLength(0)
  })

  test('DELETE removes only my own gateway', async ({ request }) => {
    const a = await creatorWithToken()
    const b = await creatorWithToken()
    await createGateway(a.creator.id, 'razorpay')
    await createGateway(b.creator.id, 'razorpay')
    expect((await request.delete(`${URL}?provider=razorpay`, { headers: b.headers })).status()).toBe(200)
    expect(await rowFor(b.creator.id)).toBeNull()
    expect(await rowFor(a.creator.id)).not.toBeNull()
  })

  test('DELETE with an unknown provider -> 400', async ({ request }) => {
    const { headers } = await creatorWithToken()
    expect((await request.delete(`${URL}?provider=paypal`, { headers })).status()).toBe(400)
  })
})