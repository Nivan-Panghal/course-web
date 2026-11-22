/**
 * API: the admin deciding a revenue-share waiver request  (/api/admin/revenue-share/waiver-requests).
 * Needs ADMIN_EMAILS=kurso.test+admin@example.com in .env.test (a TEST-only address, never your real support email).
 *
 * Rules:
 *  - Only an admin can list or decide. No login, or a normal creator, is a 401.
 *  - Approving waives the invoice and re-opens ONLY what the overdue sweep paused for that reason
 *    (courses and webinars). A course the creator drafted, or one paused for another reason, stays as it is.
 *  - After approval the creator can publish again (the lapse is gone).
 *  - A request is decided once. Rejecting changes nothing and cannot be undone by a later approval.
 *  - If WhatsApp charges are on the invoice, only the commission is waived: the invoice stays open.
 */
import { test, expect } from '@playwright/test'
import { db } from '../../helpers/admin-db'
import { need } from '../../helpers/env'
import { accessToken, signedInClient } from '../../helpers/clients'
import { createCreator, createCourse, createInvoice, cleanup, TEST_PASSWORD } from '../../helpers/factories'
import { createWorkshop, cleanupProducts } from '../../helpers/product-seed'
import { daysAgo } from '../../helpers/time'

const URL = '/api/admin/revenue-share/waiver-requests'
const adminEmail = () => need('ADMIN_EMAILS').split(',')[0].trim().toLowerCase()
let adminId: string
let admin: { authorization: string }
let creatorTok: { authorization: string }
let normal: any

test.beforeAll(async () => {
  const email = adminEmail()
  const old = (await db().auth.admin.listUsers({ perPage: 1000 })).data.users.find((u) => u.email?.toLowerCase() === email)
  if (old) await db().auth.admin.deleteUser(old.id)
  const made = await db().auth.admin.createUser({ email, password: TEST_PASSWORD, email_confirm: true })
  if (made.error || !made.data.user) throw new Error(`admin user failed: ${made.error?.message}`)
  adminId = made.data.user.id
  admin = { authorization: `Bearer ${await accessToken(email, TEST_PASSWORD)}` }
  normal = await createCreator()
  creatorTok = { authorization: `Bearer ${await accessToken(normal.email, normal.password)}` }
})
test.afterAll(async () => {
  await db().auth.admin.deleteUser(adminId)
  await cleanupProducts()
  await cleanup()
})

/** A lapsed creator: overdue invoice, one course + one webinar paused by the sweep, one course paused for another reason, one drafted. */
async function lapsed(o: { whatsappAmount?: number } = {}) {
  const c = await createCreator()
  const inv = await createInvoice(c.id, { amount: 1500, status: 'overdue' })
  await db().from('revenue_share_invoices').update({ created_at: daysAgo(20), ...(o.whatsappAmount ? { whatsapp_amount: o.whatsappAmount } : {}) }).eq('id', inv.id)
  const paused = await createCourse(c.id)
  const otherReason = await createCourse(c.id)
  const drafted = await createCourse(c.id)
  const stamp = { is_published: false, auto_unpublished_at: new Date().toISOString() }
  await db().from('courses').update({ ...stamp, auto_unpublished_reason: 'revenue_share_overdue' }).eq('id', paused.id)
  await db().from('courses').update({ ...stamp, auto_unpublished_reason: 'something_else' }).eq('id', otherReason.id)
  await db().from('courses').update({ is_published: false }).eq('id', drafted.id)
  const ws = await createWorkshop(c.id, { status: 'draft' })
  await db().from('workshops').update({ auto_unpublished_at: new Date().toISOString(), auto_unpublished_reason: 'revenue_share_overdue' }).eq('id', ws.id)
  const req = (await db().from('revenue_share_waiver_requests').insert({ creator_id: c.id, invoice_id: inv.id, reason: 'slow month', status: 'pending' }).select().single()).data
  return { c, inv, paused, otherReason, drafted, ws, req }
}
const course = async (id: string) => (await db().from('courses').select('is_published, auto_unpublished_reason').eq('id', id).single()).data
const invoice = async (id: string) => (await db().from('revenue_share_invoices').select('*').eq('id', id).single()).data
const request_ = async (id: string) => (await db().from('revenue_share_waiver_requests').select('*').eq('id', id).single()).data
const decide = (request: any, headers: any, data: object) => request.post(URL, { headers, data })

test('WAV-001 no login or a normal creator is a 401, for listing and for deciding', async ({ request }) => {
  const s = await lapsed()
  expect((await request.get(URL)).status()).toBe(401)
  expect((await request.get(URL, { headers: creatorTok })).status()).toBe(401)
  expect((await decide(request, {}, { requestId: s.req.id, decision: 'approved' })).status()).toBe(401)
  expect((await decide(request, creatorTok, { requestId: s.req.id, decision: 'approved' })).status()).toBe(401)
  expect((await request_(s.req.id)).status).toBe('pending')
  expect((await invoice(s.inv.id)).status).toBe('overdue')
})

test('WAV-002 the admin can list requests; bad fields are a 400; an unknown request a 404', async ({ request }) => {
  const s = await lapsed()
  const list = await request.get(URL, { headers: admin })
  expect(list.status()).toBe(200)
  expect(((await list.json()).requests as any[]).some((r) => r.id === s.req.id)).toBe(true)
  expect((await decide(request, admin, {})).status()).toBe(400)
  expect((await decide(request, admin, { requestId: s.req.id, decision: 'maybe' })).status()).toBe(400)
  expect((await decide(request, admin, { requestId: '00000000-0000-4000-8000-000000000000', decision: 'approved' })).status()).toBe(404)
})

test('WAV-003 approving waives the invoice and re-opens ONLY what the sweep paused', async ({ request }) => {
  const s = await lapsed()
  const res = await decide(request, admin, { requestId: s.req.id, decision: 'approved', note: 'ok' })
  expect(res.status()).toBe(200)
  expect((await invoice(s.inv.id)).status).toBe('waived')
  expect(await request_(s.req.id)).toMatchObject({ status: 'approved', reviewed_by: adminEmail(), admin_note: 'ok' })
  expect((await course(s.paused.id)).is_published).toBe(true)
  expect((await course(s.paused.id)).auto_unpublished_reason).toBeNull()
  expect((await course(s.otherReason.id)).is_published).toBe(false)
  expect((await course(s.drafted.id)).is_published).toBe(false)
  expect((await db().from('workshops').select('status').eq('id', s.ws.id).single()).data?.status).toBe('published')
})

test('WAV-004 after approval the creator can publish a draft again', async ({ request }) => {
  const s = await lapsed()
  const mine = await signedInClient(s.c.email, s.c.password)
  const before = await mine.from('courses').update({ is_published: true }).eq('id', s.drafted.id).select('id')
  expect(before.data ?? [], 'lapsed: the database refuses the publish').toHaveLength(0)
  expect((await decide(request, admin, { requestId: s.req.id, decision: 'approved' })).status()).toBe(200)
  const after = await mine.from('courses').update({ is_published: true }).eq('id', s.drafted.id).select('id')
  expect(after.error).toBeNull()
  expect(after.data ?? []).toHaveLength(1)
})

test('WAV-005 a request is decided once: a second decision is a 400 and changes nothing', async ({ request }) => {
  const s = await lapsed()
  expect((await decide(request, admin, { requestId: s.req.id, decision: 'approved' })).status()).toBe(200)
  expect((await decide(request, admin, { requestId: s.req.id, decision: 'rejected' })).status()).toBe(400)
  expect((await request_(s.req.id)).status).toBe('approved')
  expect((await invoice(s.inv.id)).status).toBe('waived')
})

test('WAV-006 rejecting changes nothing on the invoice or courses, and a later approval is refused', async ({ request }) => {
  const s = await lapsed()
  expect((await decide(request, admin, { requestId: s.req.id, decision: 'rejected', note: 'No' })).status()).toBe(200)
  expect(await request_(s.req.id)).toMatchObject({ status: 'rejected', admin_note: 'No' })
  expect((await invoice(s.inv.id)).status).toBe('overdue')
  expect((await course(s.paused.id)).is_published).toBe(false)
  expect((await decide(request, admin, { requestId: s.req.id, decision: 'approved' })).status()).toBe(400)
  expect((await invoice(s.inv.id)).status).toBe('overdue')
})

test('WAV-007 with WhatsApp charges on the invoice only the commission is waived: it stays open and nothing re-opens', async ({ request }) => {
  const s = await lapsed({ whatsappAmount: 400 })
  expect((await decide(request, admin, { requestId: s.req.id, decision: 'approved' })).status()).toBe(200)
  const inv = await invoice(s.inv.id)
  expect(inv.status).not.toBe('waived')
  expect(Number(inv.commission_amount)).toBe(0)
  expect(Number(inv.total_amount_due)).toBe(400)
  expect((await course(s.paused.id)).is_published).toBe(false)
})