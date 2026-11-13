/**
 * Seed data for tests. Every row created here is tracked and removed by cleanup(),
 * so call `await cleanup()` in afterAll. Only real columns from the schema are used.
 */
import crypto from 'crypto'
import { db } from './admin-db'
import { encryptCredentials } from '../../src/lib/payment-gateways'

const rand = () => crypto.randomBytes(4).toString('hex')
export const TEST_PASSWORD = 'Test-Password-123!'

const tracked = { creatorIds: [] as string[], studentAuthIds: [] as string[] }

function ok(res: { data: any; error: any }, what: string): any {
  if (res.error || !res.data) throw new Error(`Factory failed (${what}): ${res.error?.message ?? 'no data'}`)
  return res.data
}

async function makeAuthUser(email: string) {
  const res = await db().auth.admin.createUser({ email, password: TEST_PASSWORD, email_confirm: true })
  if (res.error || !res.data.user) throw new Error(`createUser failed: ${res.error?.message}`)
  return res.data.user.id
}

export async function createCreator(opts: { plan?: string } = {}) {
  const id_ = rand()
  const email = `kurso.test+creator-${id_}@example.com`
  const id = await makeAuthUser(email)
  tracked.creatorIds.push(id)
  const row = ok(
    await db()
      .from('creators')
      .upsert({ id, email, name: `Test Creator ${id_}`, username: `tc${id_}`, creator_slug: `tc${id_}`, plan: opts.plan ?? 'trial' })
      .select()
      .single(),
    'creator'
  )
  return { ...row, email, password: TEST_PASSWORD }
}

export async function createCourse(creatorId: string, opts: { price?: number; published?: boolean; name?: string } = {}) {
  const r = rand()
  return ok(
    await db()
      .from('courses')
      .insert({
        creator_id: creatorId,
        name: opts.name ?? `Test Course ${r}`,
        slug: `test-course-${r}`,
        price: opts.price ?? 499,
        is_published: opts.published ?? true,
      })
      .select()
      .single(),
    'course'
  )
}

export async function createLesson(
  courseId: string,
  creatorId: string,
  opts: { order?: number; title?: string; isFree?: boolean; published?: boolean } = {}
) {
  return ok(
    await db()
      .from('lessons')
      .insert({
        course_id: courseId,
        creator_id: creatorId,
        title: opts.title ?? `Lesson ${opts.order ?? 1}`,
        order_num: opts.order ?? 1,
        content_type: 'video',
        is_published: opts.published ?? true,
        is_free: opts.isFree ?? false,
      })
      .select()
      .single(),
    'lesson'
  )
}

export async function createStudent() {
  const r = rand()
  const email = `kurso.test+student-${r}@example.com`
  const authId = await makeAuthUser(email)
  tracked.studentAuthIds.push(authId)
  const row = ok(
    await db().from('students').insert({ auth_id: authId, email, name: `Test Student ${r}`, phone: '9' + String(Date.now()).slice(-9) }).select().single(),
    'student'
  )
  return { ...row, email, password: TEST_PASSWORD }
}

export async function createEnrollment(opts: { studentId: string; creatorId: string; courseId: string; phone: string; amountPaid?: number }) {
  return ok(
    await db()
      .from('enrollments')
      .insert({
        student_id: opts.studentId,
        creator_id: opts.creatorId,
        course_uuid: opts.courseId,
        phone: opts.phone,
        payment_status: 'paid',
        amount_paid: opts.amountPaid ?? 499,
      })
      .select()
      .single(),
    'enrollment'
  )
}

/** A creator's payment-gateway row. The webhook secret is stored encrypted, exactly like the app does. */
export async function createGateway(
  creatorId: string,
  provider: 'razorpay' | 'cashfree' | 'stripe',
  opts: { webhookSecret?: string; credentials?: Record<string, string> } = {}
) {
  const webhookSecret = opts.webhookSecret ?? `whsec_test_${rand()}`
  const row = ok(
    await db()
      .from('creator_payment_gateways')
      .insert({
        creator_id: creatorId,
        provider,
        environment: 'sandbox',
        credentials_encrypted: encryptCredentials(opts.credentials ?? { keyId: 'test', keySecret: 'test' }),
        webhook_secret_encrypted: encryptCredentials({ secret: webhookSecret }),
        status: 'verified',
        is_default: true,
      })
      .select()
      .single(),
    'gateway'
  )
  return { ...row, webhookSecret }
}

/** A pending transaction waiting for its payment webhook. */
export async function createPendingTransaction(opts: {
  creatorId: string
  courseId: string
  provider: 'razorpay' | 'cashfree' | 'stripe'
  amount?: number
  studentEmail?: string
}) {
  const r = rand()
  return ok(
    await db()
      .from('transactions')
      .insert({
        creator_id: opts.creatorId,
        course_id: opts.courseId,
        client_txn_id: `txn_${r}`,
        gateway_order_id: `order_${r}`,
        amount: opts.amount ?? 499,
        status: 'pending',
        payment_provider: opts.provider,
        student_name: 'Test Student',
        student_email: opts.studentEmail ?? `kurso.test+buyer-${r}@example.com`,
        student_phone: '9876543210',
      })
      .select()
      .single(),
    'transaction'
  )
}

/** A monthly revenue-share invoice the creator owes Kurso. */
export async function createInvoice(
  creatorId: string,
  opts: { status?: string; amount?: number; orderId?: string | null; productType?: 'course' | 'ebook'; periodStart?: string } = {}
) {
  const start = opts.periodStart ?? '2026-09-01'
  return ok(
    await db()
      .from('revenue_share_invoices')
      .insert({
        creator_id: creatorId,
        period_start: start,
        period_end: start.slice(0, 8) + '28',
        gross_revenue: 30000,
        total_amount_due: opts.amount ?? 1500,
        commission_amount: opts.amount ?? 1500,
        status: opts.status ?? 'pending',
        product_type: opts.productType ?? 'course',
        gateway_order_id: opts.orderId === undefined ? `inv_${rand()}` : opts.orderId,
      })
      .select()
      .single(),
    'invoice'
  )
}

/** Removes everything the factories created. Call in afterAll. */
export async function cleanup() {
  const d = db()
  const warn = (what: string, e: any) => e && console.warn(`[cleanup] ${what}: ${e.message}`)
  const creators = tracked.creatorIds.splice(0)
  const students = tracked.studentAuthIds.splice(0)

  // Each creator's data is independent, so creators are cleaned in parallel (keeps afterAll fast).
  await Promise.all(
    creators.map(async (cid) => {
            for (const t of ['revenue_share_waiver_requests', 'invoices', 'payments', 'transactions', 'enrollments', 'lessons', 'courses', 'creator_payment_gateways', 'revenue_share_invoices', 'revenue_share_agreements']) {
        warn(t, (await d.from(t).delete().eq('creator_id', cid)).error)
      }
      warn('creators', (await d.from('creators').delete().eq('id', cid)).error)
      warn('auth', (await d.auth.admin.deleteUser(cid)).error)
    })
  )

  // Students created by the payment webhook (buyers) are matched by email prefix.
  warn('buyer students', (await d.from('students').delete().like('email', 'kurso.test+buyer-%')).error)

  await Promise.all(
    students.map(async (aid) => {
      warn('students', (await d.from('students').delete().eq('auth_id', aid)).error)
      warn('auth', (await d.auth.admin.deleteUser(aid)).error)
    })
  )
}