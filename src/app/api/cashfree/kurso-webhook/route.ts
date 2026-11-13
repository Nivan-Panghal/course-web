import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { verifyKursoCashfreeWebhookSignature } from '@/lib/kurso-cashfree'
import { getSubscriptionPlan } from '@/app/api/razorpay/subscription-plans'
import { finalizeKursoSubscriptionRefundSuccess, markKursoSubscriptionRefundFailed } from '@/lib/refund-actions'

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

// Cashfree's REFUND_STATUS_WEBHOOK payload shape is completely different
// from the payment one above — refund info lives under data.refund, not
// data.payment, and there is no data.payment.payment_status field at all.
// This only ever finalizes a refund that decideSubscriptionRefundRequest
// already marked 'processing' with a matching refund_reference_id — a
// refund_id on the payload that doesn't match whatever's currently pending
// on that payment (a retried webhook for an old, already-finalized, or
// superseded attempt) is ignored rather than reapplied.
async function handleRefundWebhook(body: any) {
  const refund = body?.data?.refund
  const orderId = refund?.order_id
  const refundReferenceId = refund?.refund_id // the refundId WE generated and passed at creation time
  const refundStatus = refund?.refund_status // SUCCESS | PENDING | FAILED | CANCELLED
  const refundAmount = Number(refund?.refund_amount)

  if (!orderId || !refundReferenceId) {
    await logWebhook({ provider: 'cashfree', flow: 'flow_b_refund', signature_valid: true, http_status_returned: 400, error_message: 'Malformed refund payload', raw_payload: body })
    return NextResponse.json({ error: 'Malformed payload' }, { status: 400 })
  }

  const payment = await firstRow(
    supabaseAdmin.from('kurso_subscription_payments').select('id, refund_reference_id').eq('order_id', orderId)
  )

  if (!payment) {
    await logWebhook({ provider: 'cashfree', flow: 'flow_b_refund', signature_valid: true, http_status_returned: 200, gateway_order_id: orderId, error_message: 'No matching subscription payment for this order_id', raw_payload: body })
    return NextResponse.json({ received: true, matched: false })
  }

  if (payment.refund_reference_id !== refundReferenceId) {
    await logWebhook({ provider: 'cashfree', flow: 'flow_b_refund', signature_valid: true, http_status_returned: 200, gateway_order_id: orderId, error_message: 'refund_id does not match the pending refund on this payment — ignored', raw_payload: body })
    return NextResponse.json({ received: true, matched: false })
  }

  await logWebhook({ provider: 'cashfree', flow: 'flow_b_refund', signature_valid: true, http_status_returned: 200, gateway_order_id: orderId, event: body?.type, raw_payload: body })

  try {
    if (refundStatus === 'SUCCESS') {
      await finalizeKursoSubscriptionRefundSuccess({ paymentId: payment.id, refundReferenceId, refundAmount })
      return NextResponse.json({ received: true, message: 'Refund finalized' })
    }
    if (refundStatus === 'FAILED' || refundStatus === 'CANCELLED') {
      await markKursoSubscriptionRefundFailed({ paymentId: payment.id, refundReferenceId, errorMessage: `Cashfree refund ${String(refundStatus).toLowerCase()}` })
      return NextResponse.json({ received: true, message: `Refund ${String(refundStatus).toLowerCase()}` })
    }
    // PENDING (or anything else) — still processing, nothing to finalize yet.
    return NextResponse.json({ received: true, message: `Refund still ${refundStatus || 'processing'}` })
  } catch (err: any) {
    console.error('Cashfree kurso-webhook refund processing error:', err)
    await logWebhook({ provider: 'cashfree', flow: 'flow_b_refund', signature_valid: true, http_status_returned: 500, gateway_order_id: orderId, error_message: err?.message || 'Unknown refund processing error', raw_payload: body })
    return NextResponse.json({ error: 'Processing error — left pending for reconciliation' }, { status: 500 })
  }
}

// Cashfree auto-refunds a payment on its own in edge cases like a duplicate
// charge on the same order — Kurso never initiates these, so there's no
// refund_reference_id or refund_requests row behind one. This just logs it
// for manual reconciliation rather than touching any refund/subscription
// state, and returns 200 so Cashfree doesn't keep retrying it.
async function handleAutoRefundWebhook(body: any) {
  const autoRefund = body?.data?.auto_refund
  const orderId = autoRefund?.order_id

  await logWebhook({
    provider: 'cashfree',
    flow: 'flow_b_auto_refund',
    signature_valid: true,
    http_status_returned: 200,
    gateway_order_id: orderId || null,
    event: body?.type,
    error_message: autoRefund ? null : 'Malformed auto-refund payload',
    raw_payload: body,
  })

  return NextResponse.json({ received: true, message: 'Auto-refund logged for reconciliation' })
}

export async function POST(req: NextRequest) {
  // Cashfree signs the RAW body — must read as text before any parsing,
  // or the signature will never match (JSON re-serialization changes bytes).
  const rawBody = await req.text()
  const signature = req.headers.get('x-webhook-signature')
  const timestamp = req.headers.get('x-webhook-timestamp')

  if (!signature || !timestamp) {
    await logWebhook({ provider: 'cashfree', flow: 'flow_b', signature_valid: false, http_status_returned: 400, error_message: 'Missing webhook headers', raw_payload: safeParse(rawBody) })
    return NextResponse.json({ error: 'Missing required webhook headers' }, { status: 400 })
  }

  let validSignature = false
  try {
    validSignature = verifyKursoCashfreeWebhookSignature({ timestamp, rawBody, signature })
  } catch (err: any) {
    await logWebhook({ provider: 'cashfree', flow: 'flow_b', signature_valid: false, http_status_returned: 500, error_message: err?.message || 'Signature verification error' })
    return NextResponse.json({ error: 'Verification unavailable' }, { status: 500 })
  }

  if (!validSignature) {
    await logWebhook({ provider: 'cashfree', flow: 'flow_b', signature_valid: false, http_status_returned: 400, error_message: 'Signature mismatch', raw_payload: safeParse(rawBody) })
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

    const body = safeParse(rawBody)

    if (body?.type === 'REFUND_STATUS_WEBHOOK') {
    return handleRefundWebhook(body)
  }
  if (body?.type === 'AUTO_REFUND_STATUS_WEBHOOK') {
    return handleAutoRefundWebhook(body)
  }

  const orderId = body?.data?.order?.order_id
  const paymentStatus = body?.data?.payment?.payment_status // SUCCESS | FAILED | USER_DROPPED
  const amount = body?.data?.payment?.payment_amount

  if (!orderId) {
    await logWebhook({ provider: 'cashfree', flow: 'flow_b', signature_valid: true, http_status_returned: 400, error_message: 'No order_id in payload', raw_payload: body })
    return NextResponse.json({ error: 'Malformed payload' }, { status: 400 })
  }

    const subscription = await firstRow(
    supabaseAdmin.from('subscriptions').select('id, creator_id, plan_tier, status').eq('gateway_order_id', orderId)
  )

  if (!subscription) {
        const invoice = await firstRow(
      supabaseAdmin.from('revenue_share_invoices').select('id, creator_id, product_type, status, total_amount_due').eq('gateway_order_id', orderId)
    )

    if (invoice) {
      await logWebhook({ provider: 'cashfree', flow: 'flow_b', signature_valid: true, http_status_returned: 200, gateway_order_id: orderId, event: body?.type, raw_payload: body })

      if (paymentStatus === 'FAILED' || paymentStatus === 'USER_DROPPED') {
        return NextResponse.json({ received: true, message: `Marked ${paymentStatus}` })
      }
      if (paymentStatus !== 'SUCCESS') {
        return NextResponse.json({ received: true, message: `Ignored status: ${paymentStatus}` })
      }
      if (invoice.status === 'paid') {
        return NextResponse.json({ received: true, message: 'Already processed' })
      }
            // Safety net: never mark an invoice paid (and re-open courses) for a different
      // amount than was billed. It stays unpaid and is logged for manual reconciliation.
      if (typeof amount === 'number' && Math.abs(amount - Number(invoice.total_amount_due)) > 0.01) {
        await logWebhook({ provider: 'cashfree', flow: 'flow_b', signature_valid: true, http_status_returned: 200, gateway_order_id: orderId, error_message: `Amount mismatch: invoice is ₹${invoice.total_amount_due}, Cashfree reported ₹${amount}` })
        return NextResponse.json({ received: true, message: 'Amount mismatch — not marked paid' })
      }

           await supabaseAdmin.from('revenue_share_invoices').update({
        status: 'paid',
        paid_at: new Date().toISOString(),
      }).eq('id', invoice.id)

      // A course/ebook only ever goes offline here if the auto-expiry
      // sweep already paused it for THIS invoice going overdue — paying
      // re-opens exactly that, never something the creator drafted
      // themselves. Which table depends on which kind of invoice this was.
      if (invoice.product_type === 'ebook') {
        await supabaseAdmin.from('ebooks')
          .update({ is_published: true, auto_unpublished_at: null, auto_unpublished_reason: null })
          .eq('creator_id', invoice.creator_id)
          .eq('auto_unpublished_reason', 'ebook_revenue_share_overdue')
      } else {
        await supabaseAdmin.from('courses')
          .update({ is_published: true, auto_unpublished_at: null, auto_unpublished_reason: null })
          .eq('creator_id', invoice.creator_id)
          .eq('auto_unpublished_reason', 'revenue_share_overdue')
      }

      return NextResponse.json({ received: true, message: 'Revenue-share invoice paid' })
    }

    await logWebhook({ provider: 'cashfree', flow: 'flow_b', signature_valid: true, http_status_returned: 200, gateway_order_id: orderId, error_message: 'No matching subscription or invoice for this order_id', raw_payload: body })
    // 200 so Cashfree doesn't retry an order we'll never recognize.
    return NextResponse.json({ received: true, matched: false })
  }

  await logWebhook({ provider: 'cashfree', flow: 'flow_b', signature_valid: true, http_status_returned: 200, gateway_order_id: orderId, event: body?.type, raw_payload: body })

  try {
    if (paymentStatus === 'FAILED' || paymentStatus === 'USER_DROPPED') {
      await supabaseAdmin.from('subscriptions').update({ status: 'past_due' }).eq('id', subscription.id)
      return NextResponse.json({ received: true, message: `Marked ${paymentStatus}` })
    }
    if (paymentStatus !== 'SUCCESS') {
      return NextResponse.json({ received: true, message: `Ignored status: ${paymentStatus}` })
    }
    if (subscription.status === 'active') {
      return NextResponse.json({ received: true, message: 'Already processed' })
    }

    const periodStart = new Date()
    const periodEnd = new Date(periodStart)
    periodEnd.setDate(periodEnd.getDate() + 30)

    await supabaseAdmin.from('subscriptions').update({
      status: 'active',
      current_period_start: periodStart.toISOString(),
      current_period_end: periodEnd.toISOString(),
    }).eq('id', subscription.id)

    // Auto-republish courses that were paused by the auto-expiry cron
    // (never a course the creator chose to draft themselves — that's the
    // whole reason auto_unpublished_at exists, to tell the two apart).
        await supabaseAdmin.from('courses')
      .update({ is_published: true, auto_unpublished_at: null, auto_unpublished_reason: null })
      .eq('creator_id', subscription.creator_id)
      .not('auto_unpublished_at', 'is', null)

    await supabaseAdmin.from('creators').update({ plan: subscription.plan_tier }).eq('id', subscription.creator_id)

        const plan = getSubscriptionPlan(subscription.plan_tier)
    await supabaseAdmin.from('kurso_subscription_payments').insert({
      creator_id: subscription.creator_id,
      subscription_id: subscription.id,
      order_id: orderId,
      plan_name: plan?.name || subscription.plan_tier,
      amount: amount ?? plan?.amount,
      paid_at: new Date().toISOString(),
    })

    return NextResponse.json({ received: true, message: 'Subscription activated' })
  } catch (err: any) {
    // Payment was genuinely verified but our processing failed — leave the
    // record as-is and log for manual reconciliation, don't guess.
    console.error('Cashfree kurso-webhook processing error:', err)
    await logWebhook({ provider: 'cashfree', flow: 'flow_b', signature_valid: true, http_status_returned: 500, gateway_order_id: orderId, error_message: err?.message || 'Unknown processing error', raw_payload: body })
    return NextResponse.json({ error: 'Processing error — left pending for reconciliation' }, { status: 500 })
  }
}
