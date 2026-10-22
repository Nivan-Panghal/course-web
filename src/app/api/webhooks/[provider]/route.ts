import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { createClient } from '@supabase/supabase-js'
import { decryptCredentials } from '@/lib/payment-gateways'
import { normalizePhone } from '@/lib/phone'
import { escapeHtml, sendLoggedEmail } from '@/lib/email'
import { generateInvoicePdfForPayment } from '@/lib/invoice'
import { computeRevenueShareSplit } from '@/lib/revenueShare'
import { notifyWorkshopConfirmed } from '@/lib/workshop-notify'
import { sendStudentWelcomeEmail } from '@/lib/student-welcome-email'
import { scheduleWorkshopMetaEvent } from '@/lib/workshop-meta-events'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function firstRow(query: any) {
  const { data, error } = await query.limit(1)
  if (error) throw error
  return data?.[0] ?? null
}

function safeParse(raw: string) {
  try { return JSON.parse(raw) } catch { return null }
}

async function logWebhook(fields: Record<string, any>) {
  try {
    await supabaseAdmin.from('webhook_logs').insert(fields)
  } catch (e) {
    console.error('Failed to write webhook_logs row:', e)
  }
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB)
}

// The creator's webhook secret is REQUIRED, not optional — this is a
// multi-tenant BYOK endpoint, so signature verification is the only thing
// stopping anyone from POSTing a fake "payment succeeded" event for any
// creator's order_id. No secret configured = reject, never fail open.
async function getCreatorWebhookSecret(creatorId: string, provider: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('creator_payment_gateways')
    .select('webhook_secret_encrypted')
    .eq('creator_id', creatorId)
    .eq('provider', provider)
    .maybeSingle()
  if (!data?.webhook_secret_encrypted) return null
  try {
    return decryptCredentials(data.webhook_secret_encrypted).secret || null
  } catch {
    return null
  }
}

type NormalizedEvent = {
  status: 'success' | 'failed' | 'expired' | 'pending'
  order_id: string
  upi_txn_id: string | null // reused as "provider's payment id" across all 3 gateways
  payer_vpa: string | null
  amount: number | null
  customer_name: string | null
  customer_email: string | null
  customer_mobile: string | null
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params
  const rawBody = await req.text()

  if (provider === 'cashfree') return handleCashfree(rawBody, req)
  if (provider === 'razorpay') return handleRazorpay(rawBody, req)
  if (provider === 'stripe') return handleStripe(rawBody, req)

  return NextResponse.json({ error: 'Unknown payment provider' }, { status: 400 })
}

// ── Cashfree (creator BYOK) ──────────────────────────────────────
async function handleCashfree(rawBody: string, req: NextRequest) {
  const signature = req.headers.get('x-webhook-signature')
  const timestamp = req.headers.get('x-webhook-timestamp')
  const body = safeParse(rawBody)
  const orderId = body?.data?.order?.order_id

  if (!signature || !timestamp || !orderId) {
    await logWebhook({ provider: 'cashfree', flow: 'flow_a', signature_valid: false, http_status_returned: 400, error_message: 'Missing headers or order_id', raw_payload: body })
    return NextResponse.json({ error: 'Malformed request' }, { status: 400 })
  }

  const transaction = await firstRow(supabaseAdmin.from('transactions').select('*').eq('gateway_order_id', orderId))
  if (!transaction) {
    await logWebhook({ provider: 'cashfree', flow: 'flow_a', signature_valid: false, http_status_returned: 200, gateway_order_id: orderId, error_message: 'No matching transaction', raw_payload: body })
    return NextResponse.json({ received: true, matched: false })
  }

  const secret = await getCreatorWebhookSecret(transaction.creator_id, 'cashfree')
  if (!secret) {
    await logWebhook({ provider: 'cashfree', flow: 'flow_a', signature_valid: false, http_status_returned: 400, gateway_order_id: orderId, error_message: 'No webhook secret configured for this creator', raw_payload: body })
    return NextResponse.json({ error: 'Webhook not configured for this account' }, { status: 400 })
  }

  const expected = crypto.createHmac('sha256', secret).update(timestamp + rawBody).digest('base64')
  if (!timingSafeEqualStr(expected, signature)) {
    await logWebhook({ provider: 'cashfree', flow: 'flow_a', signature_valid: false, http_status_returned: 400, gateway_order_id: orderId, error_message: 'Signature mismatch', raw_payload: body })
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  const statusMap: Record<string, NormalizedEvent['status']> = { SUCCESS: 'success', FAILED: 'failed', USER_DROPPED: 'expired' }
  const normalized: NormalizedEvent = {
    status: statusMap[body?.data?.payment?.payment_status] || 'pending',
    order_id: orderId,
    upi_txn_id: body?.data?.payment?.cf_payment_id || null,
    payer_vpa: null,
    amount: body?.data?.payment?.payment_amount ?? null,
    customer_name: body?.data?.customer_details?.customer_name || null,
    customer_email: body?.data?.customer_details?.customer_email || null,
    customer_mobile: body?.data?.customer_details?.customer_phone || null,
  }

  await logWebhook({ provider: 'cashfree', flow: 'flow_a', signature_valid: true, http_status_returned: 200, gateway_order_id: orderId, event: body?.type, raw_payload: body })
  return dispatchFlowA(transaction, normalized, signature, 'cashfree')
}

// ── Razorpay (creator BYOK) ──────────────────────────────────────
async function handleRazorpay(rawBody: string, req: NextRequest) {
  const signature = req.headers.get('x-razorpay-signature')
  const body = safeParse(rawBody)
  const entity = body?.payload?.payment?.entity
  const orderId = entity?.order_id

  if (!signature || !orderId) {
    await logWebhook({ provider: 'razorpay', flow: 'flow_a', signature_valid: false, http_status_returned: 400, error_message: 'Missing signature or order_id', raw_payload: body })
    return NextResponse.json({ error: 'Malformed request' }, { status: 400 })
  }

  const transaction = await firstRow(supabaseAdmin.from('transactions').select('*').eq('gateway_order_id', orderId))
  if (!transaction) {
    await logWebhook({ provider: 'razorpay', flow: 'flow_a', signature_valid: false, http_status_returned: 200, gateway_order_id: orderId, error_message: 'No matching transaction', raw_payload: body })
    return NextResponse.json({ received: true, matched: false })
  }

  const secret = await getCreatorWebhookSecret(transaction.creator_id, 'razorpay')
  if (!secret) {
    await logWebhook({ provider: 'razorpay', flow: 'flow_a', signature_valid: false, http_status_returned: 400, gateway_order_id: orderId, error_message: 'No webhook secret configured for this creator', raw_payload: body })
    return NextResponse.json({ error: 'Webhook not configured for this account' }, { status: 400 })
  }

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  if (!timingSafeEqualStr(expected, signature)) {
    await logWebhook({ provider: 'razorpay', flow: 'flow_a', signature_valid: false, http_status_returned: 400, gateway_order_id: orderId, error_message: 'Signature mismatch', raw_payload: body })
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  const event = body?.event
  const status: NormalizedEvent['status'] =
    event === 'payment.captured' ? 'success' : event === 'payment.failed' ? 'failed' : 'pending'

  const normalized: NormalizedEvent = {
    status,
    order_id: orderId,
    upi_txn_id: entity?.id || null,
    payer_vpa: entity?.vpa || null,
    amount: typeof entity?.amount === 'number' ? entity.amount / 100 : null, // paise → rupees
    customer_name: null,
    customer_email: entity?.email || null,
    customer_mobile: entity?.contact || null,
  }

  await logWebhook({ provider: 'razorpay', flow: 'flow_a', signature_valid: true, http_status_returned: 200, gateway_order_id: orderId, event, raw_payload: body })
  return dispatchFlowA(transaction, normalized, signature, 'razorpay')
}

// ── Stripe (creator BYOK) ─────────────────────────────────────────
async function handleStripe(rawBody: string, req: NextRequest) {
  const sigHeader = req.headers.get('stripe-signature')
  const body = safeParse(rawBody)
  const session = body?.data?.object
  // Stripe's correlation id is client_reference_id — we set this to our
  // OWN transactions.id at order-creation time, so we look up by id here,
  // not by gateway_order_id (Stripe's session id isn't stored as that).
  const transactionId = session?.client_reference_id

  if (!sigHeader || !transactionId) {
    await logWebhook({ provider: 'stripe', flow: 'flow_a', signature_valid: false, http_status_returned: 400, error_message: 'Missing signature or client_reference_id', raw_payload: body })
    return NextResponse.json({ error: 'Malformed request' }, { status: 400 })
  }

  const transaction = await firstRow(supabaseAdmin.from('transactions').select('*').eq('id', transactionId))
  if (!transaction) {
    await logWebhook({ provider: 'stripe', flow: 'flow_a', signature_valid: false, http_status_returned: 200, gateway_order_id: transactionId, error_message: 'No matching transaction', raw_payload: body })
    return NextResponse.json({ received: true, matched: false })
  }

  const secret = await getCreatorWebhookSecret(transaction.creator_id, 'stripe')
  if (!secret) {
    await logWebhook({ provider: 'stripe', flow: 'flow_a', signature_valid: false, http_status_returned: 400, gateway_order_id: transactionId, error_message: 'No webhook secret configured for this creator', raw_payload: body })
    return NextResponse.json({ error: 'Webhook not configured for this account' }, { status: 400 })
  }

  // Parse "t=<timestamp>,v1=<sig>" — reject stale signatures (replay guard)
  const parts = Object.fromEntries(sigHeader.split(',').map((p) => p.split('=') as [string, string]))
  const timestamp = parts.t
  const v1 = parts.v1
  if (!timestamp || !v1) {
    await logWebhook({ provider: 'stripe', flow: 'flow_a', signature_valid: false, http_status_returned: 400, gateway_order_id: transactionId, error_message: 'Malformed Stripe-Signature header' })
    return NextResponse.json({ error: 'Malformed signature header' }, { status: 400 })
  }
  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp))
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')
  if (ageSeconds > 300 || !timingSafeEqualStr(expected, v1)) {
    await logWebhook({ provider: 'stripe', flow: 'flow_a', signature_valid: false, http_status_returned: 400, gateway_order_id: transactionId, error_message: ageSeconds > 300 ? 'Stale signature (possible replay)' : 'Signature mismatch', raw_payload: body })
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  const eventType = body?.type
  const status: NormalizedEvent['status'] =
    eventType === 'checkout.session.completed' && session.payment_status === 'paid' ? 'success'
      : eventType === 'checkout.session.expired' ? 'expired'
        : 'pending'

  const normalized: NormalizedEvent = {
    status,
    order_id: transactionId,
    upi_txn_id: session?.payment_intent || null,
    payer_vpa: null,
    amount: typeof session?.amount_total === 'number' ? session.amount_total / 100 : null, // cents → rupees
    customer_name: session?.customer_details?.name || null,
    customer_email: session?.customer_details?.email || null,
    customer_mobile: session?.customer_details?.phone || null,
  }

  await logWebhook({ provider: 'stripe', flow: 'flow_a', signature_valid: true, http_status_returned: 200, gateway_order_id: transactionId, event: eventType, raw_payload: body })
  return dispatchFlowA(transaction, normalized, v1, 'stripe')
}

// ── Shared dispatcher — routes to course vs ebook handler ─────────
async function dispatchFlowA(transaction: any, body: NormalizedEvent, signature: string, provider: string) {
  try {
    if (transaction.product_type === 'ebook') {
      return await handleFlowAEbook(transaction, body, signature, provider)
    }
    if (transaction.product_type === 'workshop') {
      return await handleFlowAWorkshop(transaction, body, signature, provider)
    }
    return await handleFlowA(transaction, body, signature, provider)
  } catch (err: any) {
    // Payment was genuinely verified but OUR processing failed — leave the
    // record 'pending' rather than guessing, log the real error, and
    // return 500 so this surfaces for manual reconciliation instead of
    // silently marking a real payment as failed.
    console.error(`${provider} webhook processing error:`, err)
    await logWebhook({ provider, flow: 'flow_a', signature_valid: true, http_status_returned: 500, gateway_order_id: body.order_id, error_message: err?.message || 'Unknown processing error' })
    return NextResponse.json({ error: 'Processing error — left pending for reconciliation' }, { status: 500 })
  }
}

// ── Flow A: course purchase ────────────────────────────────────────
async function handleFlowA(transaction: any, body: NormalizedEvent, signature: string, provider: string) {
  if (transaction.status === 'success') {
    return NextResponse.json({ received: true, message: 'Already processed' })
  }
  if (body.status === 'failed' || body.status === 'expired') {
    await supabaseAdmin.from('transactions').update({ status: body.status }).eq('id', transaction.id)
    return NextResponse.json({ received: true, message: `Marked ${body.status}` })
  }
  if (body.status !== 'success') {
    return NextResponse.json({ received: true, message: `Ignored status: ${body.status}` })
  }

  const cleanedPhone = body.customer_mobile
    ? normalizePhone(String(body.customer_mobile))
    : transaction.student_phone ? normalizePhone(transaction.student_phone) : null
  const email = body.customer_email || transaction.student_email
  const phoneOrEmail = cleanedPhone || email

  let student: any = null
  if (email) student = await firstRow(supabaseAdmin.from('students').select('*').eq('email', email))
  if (!student && cleanedPhone) {
    const phoneMatch = await firstRow(supabaseAdmin.from('students').select('*').eq('phone', cleanedPhone))
    if (phoneMatch && (!phoneMatch.auth_id || phoneMatch.auth_id === transaction.student_auth_id)) {
      student = phoneMatch
    }
  }

  if (student) {
    await supabaseAdmin.from('students').update({
      email: email || undefined,
      phone: cleanedPhone || undefined,
      name: body.customer_name || student.name || undefined,
      auth_id: student.auth_id || transaction.student_auth_id || undefined,
    }).eq('id', student.id)
  } else {
    const { data: inserted, error: insertErr } = await supabaseAdmin.from('students').insert({
      email: email || null, phone: cleanedPhone || null, name: body.customer_name || transaction.student_name || null,
      auth_id: transaction.student_auth_id || null,
    }).select('*').single()
    if (insertErr?.code === '23505') {
      student = cleanedPhone
        ? await firstRow(supabaseAdmin.from('students').select('*').eq('phone', cleanedPhone))
        : await firstRow(supabaseAdmin.from('students').select('*').eq('email', email))
      if (!student) throw insertErr
    } else if (insertErr) {
      throw insertErr
    } else {
      student = inserted
    }
  }

  let existingEnrollment = await firstRow(
    supabaseAdmin.from('enrollments').select('*').eq('course_uuid', transaction.course_id).eq('student_id', student.id)
  )
  if (!existingEnrollment && phoneOrEmail) {
    const phoneMatch = await firstRow(
      supabaseAdmin.from('enrollments').select('*').eq('course_uuid', transaction.course_id).eq('phone', phoneOrEmail)
    )
    if (phoneMatch && (!phoneMatch.student_id || phoneMatch.student_id === student.id)) {
      existingEnrollment = phoneMatch
    }
  }

  const now = new Date().toISOString()
  let enrollmentId: string

  const { data: deliveryCourse } = await supabaseAdmin
    .from('courses')
    .select('delivery, refund_window_days')
    .eq('id', transaction.course_id)
    .maybeSingle()

  const enrollmentDeliveryMethod = deliveryCourse?.delivery || 'both'
  // Snapshot the refund window at the moment of payment, so a later change
  // to the course's setting never retroactively shortens or lengthens what
  // a student who already paid was promised.
  const enrollmentRefundWindowDays = deliveryCourse?.refund_window_days ?? 0
  if (existingEnrollment) {
    enrollmentId = existingEnrollment.id

    if (existingEnrollment.payment_status !== 'paid') {
      await supabaseAdmin
        .from('enrollments')
        .update({
          payment_status: 'paid',
          payment_id: body.upi_txn_id,
          amount_paid: body.amount,
          student_id: student.id,
          creator_id: transaction.creator_id,
          phone: phoneOrEmail,
          last_web_sync: now,
          delivery_method:
            existingEnrollment.delivery_method || enrollmentDeliveryMethod,
          refund_window_days: enrollmentRefundWindowDays,
        })
        .eq('id', enrollmentId)
    } else if (existingEnrollment.delivery_method == null) {
      await supabaseAdmin
        .from('enrollments')
        .update({
          delivery_method: enrollmentDeliveryMethod,
        })
        .eq('id', enrollmentId)
    }
  } else {
    const { data: newEnrollment, error: enrollErr } = await supabaseAdmin.from('enrollments').insert({
      course_uuid: transaction.course_id, student_id: student.id, creator_id: transaction.creator_id,
      payment_status: 'paid',
      payment_id: body.upi_txn_id,
      amount_paid: body.amount,
      phone: phoneOrEmail,
      last_web_sync: now,
      delivery_method: enrollmentDeliveryMethod,
      refund_window_days: enrollmentRefundWindowDays,
    }).select('id').single()
    if (enrollErr) throw enrollErr
    enrollmentId = newEnrollment.id
  }

  const existingPayment = await firstRow(
    supabaseAdmin.from('payments').select('id').eq('enrollment_id', enrollmentId)
  )
  if (existingPayment) {
    await supabaseAdmin.from('transactions').update({
      status: 'success', rrn: body.upi_txn_id, payer_vpa: body.payer_vpa,
      signature_hash: signature, student_id: student.id, enrollment_id: enrollmentId,
    }).eq('id', transaction.id)
    return NextResponse.json({ received: true, message: 'Enrollment already has a payment on record' })
  }

  // Mirror into the legacy `payments` table so the existing invoice system
  // (numbering, GST, download route) keeps working unchanged.
  const { data: course } = await supabaseAdmin.from('courses').select('name').eq('id', transaction.course_id).maybeSingle()
  const { platformFee, creatorEarning, ratePercent } = await computeRevenueShareSplit(transaction.creator_id, body.amount ?? 0)
  const { data: paymentRow, error: paymentInsertError } = await supabaseAdmin
    .from('payments')
    .insert({
      creator_id: transaction.creator_id,
      course_id: transaction.course_id,
      student_id: student.id,
      enrollment_id: enrollmentId,
      provider,
      provider_payment_id: body.upi_txn_id,
      provider_order_id: body.order_id,
      buyer_name: body.customer_name || transaction.student_name || null,
      buyer_email: email || null,
      buyer_phone: cleanedPhone || null,
      currency: 'INR',
      gross_amount: body.amount,
      discount_amount: 0,
      net_amount: body.amount,
      platform_fee: platformFee,
      creator_earning: creatorEarning,
      revenue_share_rate_percent: ratePercent,
      status: 'paid',
      metadata: { source: `${provider}_webhook` },
      paid_at: new Date().toISOString(),
    })
    .select('id')
    .single()

  // Only mark the transaction 'success' once the receipt is actually
  // saved — otherwise a failed insert here still leaves the transaction
  // looking done, so Razorpay's retry gets skipped as "already processed"
  // instead of getting a chance to fix it.
  if (paymentInsertError) {
    console.error(`[${provider}-webhook] Failed to mirror payments row — leaving transaction pending so a retry can fix it:`, paymentInsertError)
    return NextResponse.json({ error: 'Payment recorded, receipt pending — left unresolved for retry' }, { status: 500 })
  }

  await supabaseAdmin.from('transactions').update({
    status: 'success', rrn: body.upi_txn_id, payer_vpa: body.payer_vpa,
    signature_hash: signature, student_id: student.id, enrollment_id: enrollmentId,
  }).eq('id', transaction.id)

  // Best-effort notifications — none of these should block the webhook
  // from returning success, since the payment itself is already final.
  await maybeSendInvoiceEmails({
    paymentId: paymentRow.id,
    creatorId: transaction.creator_id,
    courseId: transaction.course_id,
    studentId: student.id,
    studentEmail: email,
  })
  await maybeSendCreatorEnrollmentEmail({
    creatorId: transaction.creator_id,
    courseId: transaction.course_id,
    courseName: course?.name || 'a course',
    studentName: body.customer_name,
    studentEmail: email,
    studentPhone: cleanedPhone,
  })

// Welcome email with the access link. Email is always on and free. Best effort, never blocks the payment. 
await sendStudentWelcomeEmail(supabaseAdmin, { courseId: transaction.course_id, creatorId: transaction.creator_id, studentId: student.id, studentEmail: email, studentName: body.customer_name || transaction.student_name, paymentId: paymentRow.id, })

return NextResponse.json({ received: true, message: 'Enrollment activated' })
}

// ── Flow A: ebook purchase ───────────────────────────────────────
async function handleFlowAEbook(transaction: any, body: NormalizedEvent, signature: string, provider: string) {
  if (transaction.status === 'success') return NextResponse.json({ received: true, message: 'Already processed' })
  if (body.status === 'failed' || body.status === 'expired') {
    await supabaseAdmin.from('transactions').update({ status: body.status }).eq('id', transaction.id)
    return NextResponse.json({ received: true, message: `Marked ${body.status}` })
  }
  if (body.status !== 'success') return NextResponse.json({ received: true, message: `Ignored status: ${body.status}` })

  const { data: ebook } = await supabaseAdmin.from('ebooks').select('title').eq('id', transaction.ebook_id).maybeSingle()
  const email = body.customer_email || transaction.student_email
  const downloadUrl = `${process.env.NEXT_PUBLIC_SITE_URL}/ebook-download/${transaction.id}`

  const { data: paymentRow, error: paymentInsertError } = await supabaseAdmin
    .from('payments')
    .insert({
      creator_id: transaction.creator_id,
      product_type: 'ebook',
      ebook_id: transaction.ebook_id,
      provider,
      provider_payment_id: body.upi_txn_id,
      provider_order_id: body.order_id,
      buyer_name: body.customer_name || transaction.student_name || null,
      buyer_email: email || null,
      buyer_phone: body.customer_mobile || transaction.student_phone || null,
      currency: 'INR',
      gross_amount: body.amount,
      discount_amount: 0,
      net_amount: body.amount,
      platform_fee: 0,
      creator_earning: body.amount,
      status: 'paid',
      metadata: { source: `${provider}_webhook` },
      paid_at: new Date().toISOString(),
    })
    .select('id')
    .single()

  if (paymentInsertError) {
    console.error(
      `[${provider}-webhook] Failed to record ebook payment — leaving transaction pending so a retry can fix it:`,
      paymentInsertError
    )
    return NextResponse.json(
      { error: 'Payment recorded, receipt pending — left unresolved for retry' },
      { status: 500 }
    )
  }

  // Only mark the transaction success AFTER the payments row is safely written.
  await supabaseAdmin
    .from('transactions')
    .update({
      status: 'success',
      rrn: body.upi_txn_id,
      payer_vpa: body.payer_vpa,
      signature_hash: signature,
    })
    .eq('id', transaction.id)

  // Best-effort invoice + emails — failures here must not turn a real payment
  // into a failed webhook response.
  try {
    const { pdfBuffer, invoiceRow } = await generateInvoicePdfForPayment(
      supabaseAdmin,
      paymentRow.id
    )
    const base64Pdf = Buffer.from(pdfBuffer).toString('base64')
    const filename = `${invoiceRow.invoice_number}.pdf`

    if (email) {
      await sendLoggedEmail({
        supabase: supabaseAdmin,
        emailType: 'ebook_purchase_download_link',
        to: email,
        subject: `Your download: ${ebook?.title || 'Your ebook'}`,
        creatorId: transaction.creator_id,
        html: `
          <div style="font-family:Inter,Arial,sans-serif;line-height:1.5;color:#111">
            <h2 style="margin:0 0 12px">Thanks for your purchase!</h2>
            <p style="margin:0 0 16px">Your copy of <strong>${escapeHtml(
          ebook?.title || 'your ebook'
        )}</strong> is ready — invoice ${invoiceRow.invoice_number} is attached.</p>
            <a href="${downloadUrl}" style="display:inline-block;background:#f79514;color:white;padding:12px 18px;border-radius:10px;text-decoration:none">Download your ebook</a>
            <p style="margin:16px 0 0;font-size:12px;color:#666">This link is personal to you and limited to 5 downloads.</p>
          </div>
        `,
        attachments: [{ filename, content: base64Pdf }],
      })
    }

    const { data } = await supabaseAdmin.auth.admin.getUserById(transaction.creator_id)
    const creatorEmail = data?.user?.email
    if (creatorEmail) {
      await sendLoggedEmail({
        supabase: supabaseAdmin,
        emailType: 'creator_ebook_sale',
        to: creatorEmail,
        subject: `New ebook sale: ${invoiceRow.invoice_number} — ₹${Number(
          invoiceRow.amount
        ).toLocaleString('en-IN')}`,
        creatorId: transaction.creator_id,
        html: `
          <div style="font-family:Inter,Arial,sans-serif;line-height:1.5;color:#111">
            <h2 style="margin:0 0 12px">New ebook sale</h2>
            <p style="margin:0 0 8px"><strong>${escapeHtml(
          invoiceRow.student_name || 'A reader'
        )}</strong> bought <strong>${escapeHtml(
          ebook?.title || 'your ebook'
        )}</strong> for ₹${Number(invoiceRow.amount).toLocaleString('en-IN')}.</p>
            <p style="margin:0">Invoice ${invoiceRow.invoice_number} is attached for your records.</p>
          </div>
        `,
        attachments: [{ filename, content: base64Pdf }],
      })
    }
  } catch (err) {
    console.error('[webhook-email/ebook-invoice]', err)
  }

  return NextResponse.json({ received: true, message: 'Ebook purchase activated' })
}

// ── Flow A: workshop registration ──────────────────────────────────
// Signature is already verified by the provider handler before we get here.
// Mirrors handleFlowAEbook's payments/invoice/email shape, with the platform
// fee fixed at 0 — no PAYE agreement applies to workshops (see revenueShare.ts).
async function handleFlowAWorkshop(transaction: any, body: NormalizedEvent, signature: string, provider: string) {
  if (transaction.status === 'success') return NextResponse.json({ received: true, message: 'Already processed' })
  if (body.status === 'failed' || body.status === 'expired') {
    await supabaseAdmin.from('transactions').update({ status: body.status }).eq('id', transaction.id)
    return NextResponse.json({ received: true, message: `Marked ${body.status}` })
  }
  if (body.status !== 'success') return NextResponse.json({ received: true, message: `Ignored status: ${body.status}` })

  const registrationId = transaction.workshop_registration_id
  if (!registrationId) {
    console.error(`[${provider}-webhook] workshop transaction ${transaction.id} has no workshop_registration_id — leaving pending`)
    return NextResponse.json({ error: 'Registration link missing — left pending for reconciliation' }, { status: 500 })
  }

  const { data: workshop } = await supabaseAdmin
    .from('workshops')
    .select('title')
    .eq('id', transaction.workshop_id)
    .maybeSingle()

  const now = new Date().toISOString()
  const amountPaid = Math.round(Number(transaction.amount))

  // Guarded transition: only rows NOT already confirmed come back, so a
  // webhook retry (or a creator who already tapped "Mark Paid") never
  // triggers a second notification.
  const { data: transitioned, error: registrationError } = await supabaseAdmin
    .from('workshop_registrations')
    .update({
      payment_status: 'confirmed',
      payment_mode: 'gateway',
      transaction_id: transaction.id,
      amount_paid: amountPaid,
      confirmed_at: now,
    })
    .eq('id', registrationId)
    .neq('payment_status', 'confirmed')
    .select('id')

  if (registrationError) {
    console.error(`[${provider}-webhook] Failed to confirm workshop registration — leaving transaction pending so a retry can fix it:`, registrationError)
    return NextResponse.json({ error: 'Registration update failed — left pending for retry' }, { status: 500 })
  }

  const justConfirmed = !!transitioned && transitioned.length > 0
  if (!justConfirmed) {
    // Already confirmed earlier — still attach the payment details.
    await supabaseAdmin
      .from('workshop_registrations')
      .update({ transaction_id: transaction.id, amount_paid: amountPaid })
      .eq('id', registrationId)
  }

  // Dedup on retry — mirrors the course flow's existingPayment check.
  const existingPayment = await firstRow(
    supabaseAdmin.from('payments').select('id').eq('workshop_registration_id', registrationId)
  )
  if (existingPayment) {
    await supabaseAdmin.from('transactions').update({
      status: 'success', rrn: body.upi_txn_id, payer_vpa: body.payer_vpa, signature_hash: signature,
    }).eq('id', transaction.id)
    return NextResponse.json({ received: true, message: 'Registration already has a payment on record' })
  }

  const email = body.customer_email || transaction.student_email

  // Same treatment as courses — same PAYE agreement, same base/overflow
  // rate. A creator with no active agreement still gets platformFee: 0
  // here, exactly like a course-only creator does.
  const { platformFee, creatorEarning, ratePercent } = await computeRevenueShareSplit(transaction.creator_id, body.amount ?? 0, 'workshop')
  const { data: paymentRow, error: paymentInsertError } = await supabaseAdmin
    .from('payments')
    .insert({
      creator_id: transaction.creator_id,
      product_type: 'workshop',
      workshop_id: transaction.workshop_id,
      workshop_registration_id: registrationId,
      provider,
      provider_payment_id: body.upi_txn_id,
      provider_order_id: body.order_id,
      buyer_name: body.customer_name || transaction.student_name || null,
      buyer_email: email || null,
      buyer_phone: body.customer_mobile || transaction.student_phone || null,
      currency: 'INR',
      // With a coupon: gross is the listed price, discount is what was taken off, net is what was paid.
      gross_amount: transaction.original_amount ? Math.round(Number(transaction.original_amount)) : body.amount,
      discount_amount: Math.round(Number(transaction.discount_amount) || 0),
      net_amount: body.amount,
      platform_fee: platformFee,
      creator_earning: creatorEarning,
      revenue_share_rate_percent: ratePercent,
      status: 'paid',
      metadata: { source: `${provider}_webhook` },
      paid_at: now,
    })
    .select('id')
    .single()

  if (paymentInsertError) {
    console.error(`[${provider}-webhook] Failed to record workshop payment — leaving transaction pending so a retry can fix it:`, paymentInsertError)
    return NextResponse.json({ error: 'Payment recorded, receipt pending — left unresolved for retry' }, { status: 500 })
  }

  // Only mark the transaction success AFTER the payments row is safely written.
  await supabaseAdmin
    .from('transactions')
    .update({
      status: 'success',
      rrn: body.upi_txn_id,
      payer_vpa: body.payer_vpa,
      signature_hash: signature,
    })
    .eq('id', transaction.id)

  // Meta Purchase (server side), after the response. Idempotent per registration, so webhook retries can't double-count.
  scheduleWorkshopMetaEvent({ registrationId, eventName: 'Purchase' })

// Count one use of the workshop coupon (best-effort, never blocks a real payment).
 if (justConfirmed && transaction.workshop_coupon_id) { try { await supabaseAdmin.rpc('redeem_workshop_coupon', { input_coupon_id: transaction.workshop_coupon_id }) } catch (err) { console.error('[webhook-workshop-coupon]', err) } }

if (justConfirmed) { try { await notifyWorkshopConfirmed(registrationId)
    } catch (err) {
      // Best-effort — a failed message must not turn a real payment into a failed webhook.
      console.error('[webhook-workshop-notify]', err)
    }
  }

  // Best-effort invoice + emails — failures here must not turn a real
  // payment into a failed webhook response.
  try {
    const { pdfBuffer, invoiceRow } = await generateInvoicePdfForPayment(supabaseAdmin, paymentRow.id)
    const base64Pdf = Buffer.from(pdfBuffer).toString('base64')
    const filename = `${invoiceRow.invoice_number}.pdf`

    if (email) {
      await sendLoggedEmail({
        supabase: supabaseAdmin,
        emailType: 'workshop_registration_confirmation',
        to: email,
        subject: `Your invoice for ${workshop?.title || 'the workshop'}`,
        creatorId: transaction.creator_id,
        html: `
          <div style="font-family:Inter,Arial,sans-serif;line-height:1.5;color:#111">
            <h2 style="margin:0 0 12px">Payment received</h2>
            <p style="margin:0 0 16px">Your spot for <strong>${escapeHtml(
          workshop?.title || 'the workshop'
        )}</strong> is confirmed — invoice ${invoiceRow.invoice_number} is attached. Your joining details are in a separate email.</p>
          </div>
        `,
        attachments: [{ filename, content: base64Pdf }],
      })
    }

    const { data } = await supabaseAdmin.auth.admin.getUserById(transaction.creator_id)
    const creatorEmail = data?.user?.email
    if (creatorEmail) {
      await sendLoggedEmail({
        supabase: supabaseAdmin,
        emailType: 'creator_workshop_sale',
        to: creatorEmail,
        subject: `New workshop registration: ${invoiceRow.invoice_number} — ₹${Number(
          invoiceRow.amount
        ).toLocaleString('en-IN')}`,
        creatorId: transaction.creator_id,
        html: `
          <div style="font-family:Inter,Arial,sans-serif;line-height:1.5;color:#111">
            <h2 style="margin:0 0 12px">New workshop registration</h2>
            <p style="margin:0 0 8px"><strong>${escapeHtml(
          invoiceRow.student_name || 'A student'
        )}</strong> paid <strong>₹${Number(invoiceRow.amount).toLocaleString('en-IN')}</strong> for <strong>${escapeHtml(
          workshop?.title || invoiceRow.course_name
        )}</strong>.</p>
            <p style="margin:0">Invoice ${invoiceRow.invoice_number} is attached for your records.</p>
          </div>
        `,
        attachments: [{ filename, content: base64Pdf }],
      })
    }
  } catch (err) {
    console.error('[webhook-email/workshop-invoice]', err)
  }

  return NextResponse.json({ received: true, message: 'Workshop registration confirmed' })
}

// ── Notification emails ──────────────────────────────────────────
async function maybeSendInvoiceEmails({
  paymentId, creatorId, courseId, studentId, studentEmail,
}: {
  paymentId: string; creatorId: string; courseId: string; studentId?: string | null; studentEmail?: string | null
}) {
  try {
    const { pdfBuffer, invoiceRow } = await generateInvoicePdfForPayment(supabaseAdmin, paymentId)
    const base64Pdf = Buffer.from(pdfBuffer).toString('base64')
    const filename = `${invoiceRow.invoice_number}.pdf`

    const { data } = await supabaseAdmin.auth.admin.getUserById(creatorId)
    const creatorEmail = data?.user?.email
    const prefs = data?.user?.user_metadata?.email_notifications || {}

    if (creatorEmail && prefs.paidSale !== false) {
      await sendLoggedEmail({
        supabase: supabaseAdmin,
        emailType: 'creator_invoice_copy',
        to: creatorEmail,
        subject: `Invoice ${invoiceRow.invoice_number} — ₹${Number(invoiceRow.amount).toLocaleString('en-IN')}`,
        creatorId, courseId, paymentId,
        html: `
          <div style="font-family:Inter,Arial,sans-serif;line-height:1.5;color:#111">
            <h2 style="margin:0 0 12px">New sale — invoice attached</h2>
            <p style="margin:0 0 8px"><strong>${escapeHtml(invoiceRow.student_name || 'A student')}</strong> paid <strong>₹${Number(invoiceRow.amount).toLocaleString('en-IN')}</strong> for <strong>${escapeHtml(invoiceRow.course_name)}</strong>.</p>
            <p style="margin:0">Invoice ${invoiceRow.invoice_number} is attached for your records.</p>
          </div>
        `,
        attachments: [{ filename, content: base64Pdf }],
      })
    }

    if (studentEmail) {
      await sendLoggedEmail({
        supabase: supabaseAdmin,
        emailType: 'student_invoice_copy',
        to: studentEmail,
        subject: `Your invoice for ${invoiceRow.course_name}`,
        creatorId, studentId: studentId || null, courseId, paymentId,
        html: `
          <div style="font-family:Inter,Arial,sans-serif;line-height:1.5;color:#111">
            <h2 style="margin:0 0 12px">Payment confirmed</h2>
            <p style="margin:0 0 8px">Your invoice ${invoiceRow.invoice_number} is attached.</p>
          </div>
        `,
        attachments: [{ filename, content: base64Pdf }],
      })
    }
  } catch (err) {
    console.error('[webhook-email/invoice]', err)
  }
}

async function maybeSendCreatorEnrollmentEmail({
  creatorId, courseId, courseName, studentName, studentEmail, studentPhone,
}: {
  creatorId: string; courseId: string; courseName: string
  studentName?: string | null; studentEmail?: string | null; studentPhone?: string | null
}) {
  try {
    const { data } = await supabaseAdmin.auth.admin.getUserById(creatorId)
    const creator = data?.user
    const prefs = creator?.user_metadata?.email_notifications || {}
    if (prefs.newEnrollment === false || !creator?.email) return

    const safeCourse = escapeHtml(courseName || 'your course')
    const safeStudent = escapeHtml(studentName || studentEmail || studentPhone || 'A student')

    await sendLoggedEmail({
      supabase: supabaseAdmin,
      emailType: 'creator_new_enrollment',
      to: creator.email,
      subject: `New enrollment: ${courseName}`,
      creatorId, courseId,
      metadata: { student_name: studentName || null, student_email: studentEmail || null, student_phone: studentPhone || null },
      html: `
        <div style="font-family:Inter,Arial,sans-serif;line-height:1.5;color:#111">
          <h2 style="margin:0 0 12px">New student enrolled</h2>
          <p style="margin:0 0 8px"><strong>${safeStudent}</strong> enrolled in <strong>${safeCourse}</strong>.</p>
          <a href="${process.env.NEXT_PUBLIC_SITE_URL || ''}/dashboard"
            style="display:inline-block;background:#f79514;color:white;padding:10px 14px;border-radius:10px;text-decoration:none">
            Open dashboard
          </a>
        </div>
      `,
    })
  } catch (err) {
    console.error('[webhook-email/creator-enrollment]', err)
  }
}
