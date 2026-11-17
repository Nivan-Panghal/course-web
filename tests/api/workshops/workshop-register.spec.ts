/**
 * API: registering for a webinar (workshop).
 *   POST  /api/workshops/register              free registration, or step 1 of a manual UPI payment
 *   PATCH /api/workshops/register              the student submits their UPI reference (UTR)
 *   POST  /api/workshops/registrations/confirm the CREATOR marks a UPI payment as received
 *
 * Rules:
 *  - Only a published workshop that is still open takes registrations (not ended, not past its close time).
 *  - "free" only works on a free workshop; "upi_manual" only on a paid one.
 *  - A full workshop refuses new people. A person registering twice stays one registration.
 *  - Only the owning creator can confirm a payment.
 *  - Knowing someone's phone number must NOT hand out their private Telegram link token.
 */
import { test, expect } from '@playwright/test'
import { db } from '../../helpers/admin-db'
import { accessToken } from '../../helpers/clients'
import { createCreator, cleanup } from '../../helpers/factories'
import { createWorkshop, createRegistration, cleanupProducts } from '../../helpers/product-seed'

const URL = '/api/workshops/register'
const CONFIRM = '/api/workshops/registrations/confirm'
let creator: any
let rival: any
let phoneSeq = 0
const phone = () => `9000${String(100000 + ++phoneSeq + Math.floor(Math.random() * 800000)).slice(0, 6)}`

test.beforeAll(async () => {
  creator = await createCreator()
  rival = await createCreator()
})
test.afterAll(async () => { await cleanupProducts(); await cleanup() })

const reg = (request: any, data: object) => request.post(URL, { data })
const rowFor = async (workshopId: string, p: string) =>
  (await db().from('workshop_registrations').select('*').eq('workshop_id', workshopId).eq('phone', p)).data ?? []

test.describe('refused up front', () => {
  test('WS-001 missing name, phone or workshop is a 400', async ({ request }) => {
    const w = await createWorkshop(creator.id)
    expect((await reg(request, { workshopId: w.id, name: 'A', paymentMode: 'free' })).status()).toBe(400)
    expect((await reg(request, { workshopId: w.id, phone: phone(), paymentMode: 'free' })).status()).toBe(400)
  })
  test('WS-002 an unknown payment mode (including "gateway") is a 400 on this route', async ({ request }) => {
    const w = await createWorkshop(creator.id)
    expect((await reg(request, { workshopId: w.id, name: 'A', phone: phone(), paymentMode: 'gateway' })).status()).toBe(400)
    expect((await reg(request, { workshopId: w.id, name: 'A', phone: phone(), paymentMode: 'bogus' })).status()).toBe(400)
  })
  test('WS-003 an invalid phone number is a 400', async ({ request }) => {
    const w = await createWorkshop(creator.id)
    expect((await reg(request, { workshopId: w.id, name: 'A', phone: '123', paymentMode: 'free' })).status()).toBe(400)
  })
  test('WS-004 a draft, cancelled or unknown workshop is a 404 and creates nothing', async ({ request }) => {
    const draft = await createWorkshop(creator.id, { status: 'draft' })
    const p = phone()
    expect((await reg(request, { workshopId: draft.id, name: 'A', phone: p, paymentMode: 'free' })).status()).toBe(404)
    expect((await reg(request, { workshopId: '00000000-0000-4000-8000-000000000000', name: 'A', phone: p, paymentMode: 'free' })).status()).toBe(404)
    expect(await rowFor(draft.id, p)).toHaveLength(0)
  })
  test('WS-005 registration closed (past its close time) or workshop already ended is a 409', async ({ request }) => {
    const closed = await createWorkshop(creator.id, { closesAt: new Date(Date.now() - 3600_000).toISOString() })
    const ended = await createWorkshop(creator.id, { startsInDays: -2 })
    expect((await reg(request, { workshopId: closed.id, name: 'A', phone: phone(), paymentMode: 'free' })).status()).toBe(409)
    expect((await reg(request, { workshopId: ended.id, name: 'A', phone: phone(), paymentMode: 'free' })).status()).toBe(409)
  })
  test('WS-006 "free" on a paid workshop and "upi_manual" on a free one are both refused', async ({ request }) => {
    const paid = await createWorkshop(creator.id, { price: 499 })
    const free = await createWorkshop(creator.id, { price: 0 })
    expect((await reg(request, { workshopId: paid.id, name: 'A', phone: phone(), paymentMode: 'free' })).status()).toBe(400)
    expect((await reg(request, { workshopId: free.id, name: 'A', phone: phone(), paymentMode: 'upi_manual' })).status()).toBe(400)
  })
})

test.describe('registering', () => {
  test('WS-010 a free workshop confirms the person at once', async ({ request }) => {
    const w = await createWorkshop(creator.id)
    const p = phone()
    const res = await reg(request, { workshopId: w.id, name: 'Free Person', email: 'kurso.test+ws@example.com', phone: p, paymentMode: 'free' })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.paymentStatus).toBe('confirmed')
    const [row] = await rowFor(w.id, p)
    expect(row).toMatchObject({ payment_status: 'confirmed', payment_mode: 'free', name: 'Free Person' })
    expect(row.confirmed_at).toBeTruthy()
  })
  test('WS-011 a paid workshop via UPI stays pending until the creator confirms, and the response has no meeting link', async ({ request }) => {
    const w = await createWorkshop(creator.id, { price: 499 })
    const p = phone()
    const res = await reg(request, { workshopId: w.id, name: 'UPI Person', phone: p, paymentMode: 'upi_manual' })
    const body = await res.json()
    expect(body.paymentStatus).toBe('pending_confirmation')
    expect(JSON.stringify(body)).not.toContain('zoom')
    expect((await rowFor(w.id, p))[0].confirmed_at).toBeNull()
  })
  test('WS-012 registering the same phone twice is still ONE registration', async ({ request }) => {
    const w = await createWorkshop(creator.id)
    const p = phone()
    await reg(request, { workshopId: w.id, name: 'Twice', phone: p, paymentMode: 'free' })
    const second = await (await reg(request, { workshopId: w.id, name: 'Twice', phone: p, paymentMode: 'free' })).json()
    expect(second.alreadyRegistered).toBe(true)
    expect(await rowFor(w.id, p)).toHaveLength(1)
  })
  test('WS-013 a full workshop refuses a new person (409) but the seat holder is unaffected', async ({ request }) => {
    const w = await createWorkshop(creator.id, { capacity: 1 })
    expect((await reg(request, { workshopId: w.id, name: 'First', phone: phone(), paymentMode: 'free' })).status()).toBe(200)
    const late = phone()
    expect((await reg(request, { workshopId: w.id, name: 'Late', phone: late, paymentMode: 'free' })).status()).toBe(409)
    expect(await rowFor(w.id, late)).toHaveLength(0)
  })
  test('WS-014 a REFUNDED attendee gives their seat back', async ({ request }) => {
    const w = await createWorkshop(creator.id, { capacity: 1 })
    await createRegistration(w.id, { status: 'confirmed', refundedAt: new Date().toISOString() })
    expect((await reg(request, { workshopId: w.id, name: 'New', phone: phone(), paymentMode: 'free' })).status()).toBe(200)
  })
})

test.describe('UPI reference (PATCH)', () => {
  test('WS-020 the reference is saved on a pending registration', async ({ request }) => {
    const w = await createWorkshop(creator.id, { price: 499 })
    const r = await createRegistration(w.id, { status: 'pending_confirmation', mode: 'upi_manual' })
    const res = await request.patch(URL, { data: { registrationId: r.id, utrReference: '  UTR123456  ' } })
    expect(res.status()).toBe(200)
    expect((await db().from('workshop_registrations').select('utr_reference').eq('id', r.id).single()).data!.utr_reference).toBe('UTR123456')
  })
  test('WS-021 missing fields is a 400, an unknown registration is a 404', async ({ request }) => {
    expect((await request.patch(URL, { data: {} })).status()).toBe(400)
    expect((await request.patch(URL, { data: { registrationId: '00000000-0000-4000-8000-000000000000', utrReference: 'X' } })).status()).toBe(404)
  })
  test('WS-022 an already confirmed registration is left untouched', async ({ request }) => {
    const w = await createWorkshop(creator.id, { price: 499 })
    const r = await createRegistration(w.id, { status: 'confirmed', mode: 'upi_manual' })
    await request.patch(URL, { data: { registrationId: r.id, utrReference: 'CHANGED' } })
    expect((await db().from('workshop_registrations').select('utr_reference').eq('id', r.id).single()).data!.utr_reference).toBeNull()
  })
})

test.describe('creator confirms a UPI payment', () => {
  test('WS-030 no login is a 401', async ({ request }) => {
    expect((await request.post(CONFIRM, { data: { registrationId: '00000000-0000-4000-8000-000000000000' } })).status()).toBe(401)
  })
  test('WS-031 the owner confirms, and the row records who and when', async ({ request }) => {
    const w = await createWorkshop(creator.id, { price: 499 })
    const r = await createRegistration(w.id, { status: 'pending_confirmation', mode: 'upi_manual' })
    const res = await request.post(CONFIRM, { data: { registrationId: r.id }, headers: { authorization: `Bearer ${await accessToken(creator.email, creator.password)}` } })
    expect(res.status()).toBe(200)
    const row = (await db().from('workshop_registrations').select('*').eq('id', r.id).single()).data!
    expect(row).toMatchObject({ payment_status: 'confirmed', confirmed_by: creator.id })
    expect(row.confirmed_at).toBeTruthy()
  })
  test('WS-032 ANOTHER creator cannot confirm it (404) and nothing changes', async ({ request }) => {
    const w = await createWorkshop(creator.id, { price: 499 })
    const r = await createRegistration(w.id, { status: 'pending_confirmation', mode: 'upi_manual' })
    const res = await request.post(CONFIRM, { data: { registrationId: r.id }, headers: { authorization: `Bearer ${await accessToken(rival.email, rival.password)}` } })
    expect(res.status()).toBe(404)
    expect((await db().from('workshop_registrations').select('payment_status').eq('id', r.id).single()).data!.payment_status).toBe('pending_confirmation')
  })
  test('WS-033 confirming twice is harmless', async ({ request }) => {
    const w = await createWorkshop(creator.id, { price: 499 })
    const r = await createRegistration(w.id, { status: 'confirmed', mode: 'upi_manual' })
    const res = await request.post(CONFIRM, { data: { registrationId: r.id }, headers: { authorization: `Bearer ${await accessToken(creator.email, creator.password)}` } })
    expect((await res.json()).alreadyConfirmed).toBe(true)
  })
})

test.describe('privacy', () => {
  test('WS-040 someone who only knows an attendee\'s phone number does NOT receive that attendee\'s Telegram link token', async ({ request }) => {
    const w = await createWorkshop(creator.id, { price: 499 })
    const victim = await createRegistration(w.id, { status: 'confirmed', mode: 'upi_manual' })
    const res = await reg(request, { workshopId: w.id, name: 'Stranger', phone: victim.phone, paymentMode: 'upi_manual' })
    const body = await res.json()
    expect(body.telegramToken, 'private token must not be returned to an unauthenticated caller').toBeUndefined()
    expect(JSON.stringify(body)).not.toContain(victim.telegram_link_token)
  })
  test('WS-041 and the stranger cannot rename or change the confirmed attendee\'s details', async ({ request }) => {
    const w = await createWorkshop(creator.id, { price: 499 })
    const victim = await createRegistration(w.id, { status: 'confirmed', mode: 'upi_manual', name: 'Real Name' })
    await reg(request, { workshopId: w.id, name: 'Hacked', email: 'evil@example.com', phone: victim.phone, paymentMode: 'upi_manual' })
    const after = (await db().from('workshop_registrations').select('name, email, payment_status').eq('id', victim.id).single()).data!
    expect(after).toMatchObject({ name: 'Real Name', email: victim.email, payment_status: 'confirmed' })
  })
})