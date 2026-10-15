import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'
import { getCreatorGatewayByProvider } from '@/lib/gateway-checkout'
import { executeGatewayRefund, RefundExecutionError } from '@/lib/gateway-refund'
import { refundKursoSubscriptionPayment, KursoCashfreeError } from '@/lib/kurso-cashfree'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export type ActionResult =
  | { ok: true; message: string }
  | { ok: false; status: number; error: string }

// ── Flow A: course refund requests (student ↔ creator) ──────────────
export async function checkCourseRefundEligibility(enrollmentId: string): Promise<{ eligible: boolean; reason?: string }> {
  const { data: enrollment } = await supabase
    .from('enrollments')
    .select('id, payment_status, enrolled_at, refund_window_days')
    .eq('id', enrollmentId)
    .maybeSingle()

  if (!enrollment || enrollment.payment_status !== 'paid') return { eligible: false, reason: 'Not a paid enrollment' }

  // The refund window is snapshotted onto the enrollment at the moment of
  // payment (see api/webhooks/[provider]/route.ts) — this deliberately does
  // NOT re-read the course's current setting, so a creator changing it later
  // never retroactively shortens or lengthens what an already-paid student
  // was promised.
  const windowDays = enrollment.refund_window_days ?? 0
  if (windowDays <= 0) return { eligible: false, reason: 'This course does not accept refunds' }

  const daysSince = (Date.now() - new Date(enrollment.enrolled_at).getTime()) / (1000 * 60 * 60 * 24)
  if (daysSince > windowDays) return { eligible: false, reason: 'Refund window has closed' }

  const { data: existing } = await supabase
    .from('refund_requests')
    .select('id')
    .eq('enrollment_id', enrollmentId)
    .eq('type', 'course')
    .maybeSingle()
  if (existing) return { eligible: false, reason: 'A request already exists for this enrollment' }

  return { eligible: true }
}

export async function createCourseRefundRequest({ enrollmentId, reason }: { enrollmentId: string; reason?: string }): Promise<ActionResult> {
  const elig = await checkCourseRefundEligibility(enrollmentId)
  if (!elig.eligible) return { ok: false, status: 400, error: elig.reason || 'Not eligible for a refund' }

  const { data: enrollment } = await supabase
    .from('enrollments')
    .select('id, creator_id, student_id')
    .eq('id', enrollmentId)
    .maybeSingle()
  if (!enrollment) return { ok: false, status: 404, error: 'Enrollment not found' }

  const { error } = await supabase.from('refund_requests').insert({
    type: 'course',
    enrollment_id: enrollmentId,
    creator_id: enrollment.creator_id,
    student_id: enrollment.student_id,
    requested_by: 'student',
    reason: reason || null,
  })
  if (error) {
    if (error.code === '23505') return { ok: false, status: 400, error: 'A request already exists for this enrollment' }
    return { ok: false, status: 500, error: 'Could not submit your request' }
  }
  return { ok: true, message: 'Your refund request has been sent to the creator.' }
}

export async function decideCourseRefundRequest({ requestId, creatorId, decision, note, amount }: { requestId: string; creatorId: string; decision: 'approved' | 'denied'; note?: string; amount?: number }): Promise<ActionResult> {
  const { data: request } = await supabase
    .from('refund_requests')
    .select('id, enrollment_id, creator_id, status, type')
    .eq('id', requestId)
    .maybeSingle()

  if (!request || request.type !== 'course') return { ok: false, status: 404, error: 'Request not found' }
  if (request.creator_id !== creatorId) return { ok: false, status: 403, error: 'Not your request to decide' }
  if (request.status !== 'pending') return { ok: false, status: 400, error: 'This request has already been decided' }

  if (decision === 'denied') {
    await supabase.from('refund_requests').update({
      status: 'denied', decision_note: note || null, decided_at: new Date().toISOString(), decided_by: 'creator',
    }).eq('id', requestId)
    return { ok: true, message: 'Request denied.' }
  }

  // Approved — actually move the money before touching any status field.
  const { data: payment } = await supabase
    .from('payments')
    .select('id, provider, provider_order_id, provider_payment_id, net_amount')
    .eq('enrollment_id', request.enrollment_id)
    .eq('status', 'paid')
    .order('paid_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!payment) return { ok: false, status: 404, error: 'No completed payment record found for this enrollment — cannot refund automatically. Please refund manually from your gateway dashboard.' }

  const { data: refundRows } = await supabase.from('refunds').select('amount, status').eq('payment_id', payment.id)
  const alreadyRefunded = (refundRows || []).filter(r => r.status === 'succeeded').reduce((sum, r) => sum + Number(r.amount), 0)
  const refundable = Number(payment.net_amount) - alreadyRefunded

  const requestedAmount = amount === undefined || amount === null ? refundable : Number(amount)
  if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) return { ok: false, status: 400, error: 'Enter a valid refund amount.' }
  if (requestedAmount > refundable + 0.01) {
    return { ok: false, status: 400, error: `You can refund at most ₹${refundable.toLocaleString('en-IN')} on this payment.` }
  }

  const gateway = await getCreatorGatewayByProvider(creatorId, payment.provider as 'cashfree' | 'razorpay' | 'stripe')
  if (!gateway) return { ok: false, status: 409, error: `Your ${payment.provider} connection isn't active — reconnect it in Settings before issuing refunds.` }

  const refundId = randomUUID()
  const { error: refundInsertError } = await supabase.from('refunds').insert({
    id: refundId, payment_id: payment.id, creator_id: creatorId, enrollment_id: request.enrollment_id,
    amount: requestedAmount, reason: note || null, revoke_access: true, provider: payment.provider, status: 'pending',
  })
  // If the record cannot be saved, stop here. Sending money without a record would let the same payment be refunded twice.
  if (refundInsertError) {
    console.error('[refund] could not save the refund record:', refundInsertError.message)
    return { ok: false, status: 500, error: 'We could not record this refund, so nothing was sent. Please try again.' }
  }

  try {
    const { providerRefundId } = await executeGatewayRefund({
      gateway,
      target: { provider: payment.provider as any, providerOrderId: payment.provider_order_id, providerPaymentId: payment.provider_payment_id },
      amount: requestedAmount,
      refundId,
      reason: note,
    })

    await supabase.from('refunds').update({ status: 'succeeded', provider_refund_id: providerRefundId }).eq('id', refundId)
    await supabase.from('enrollments').update({ payment_status: 'refunded' }).eq('id', request.enrollment_id)
    await supabase.from('transactions').update({ status: 'refunded' }).eq('enrollment_id', request.enrollment_id)
    await supabase.from('refund_requests').update({
      status: 'completed', decision_note: note || null, decided_at: new Date().toISOString(), decided_by: 'creator', completed_at: new Date().toISOString(),
    }).eq('id', requestId)

    return { ok: true, message: `Refund of ₹${requestedAmount.toLocaleString('en-IN')} issued. The student's access has been revoked.` }
  } catch (err: any) {
    const msg = err instanceof RefundExecutionError ? err.message : 'The payment gateway rejected this refund. No money was moved and nothing was changed — please try again or refund manually from your gateway dashboard.'
    await supabase.from('refunds').update({ status: 'failed', error_message: msg }).eq('id', refundId)
    return { ok: false, status: 502, error: msg }
  }
}

// ── Flow B: subscription refund requests (creator ↔ Kurso) ──────────
export async function checkSubscriptionRefundEligibility(creatorId: string): Promise<{ eligible: boolean; reason?: string; subscriptionId?: string }> {
  const { data: subscription } = await supabase
    .from('subscriptions')
    .select('id, status, current_period_start')
    .eq('creator_id', creatorId)
    .maybeSingle()

  if (!subscription || subscription.status !== 'active') return { eligible: false, reason: 'No active subscription found' }

  const daysSince = (Date.now() - new Date(subscription.current_period_start).getTime()) / (1000 * 60 * 60 * 24)
  if (daysSince > 15) return { eligible: false, reason: 'Refunds are only available within 15 days of your billing date' }

  const { data: existing } = await supabase
    .from('refund_requests')
    .select('id')
    .eq('subscription_id', subscription.id)
    .eq('type', 'subscription')
    .in('status', ['pending', 'approved'])
    .maybeSingle()
  if (existing) return { eligible: false, reason: 'A request is already pending for this subscription' }

  return { eligible: true, subscriptionId: subscription.id }
}

export async function createSubscriptionRefundRequest({ creatorId, reason }: { creatorId: string; reason?: string }): Promise<ActionResult> {
  const elig = await checkSubscriptionRefundEligibility(creatorId)
  if (!elig.eligible) return { ok: false, status: 400, error: elig.reason || 'Not eligible for a refund' }

  const { error } = await supabase.from('refund_requests').insert({
    type: 'subscription',
    subscription_id: elig.subscriptionId,
    creator_id: creatorId,
    requested_by: 'creator',
    reason: reason || null,
  })
  if (error) return { ok: false, status: 500, error: 'Could not submit your request' }
  return { ok: true, message: 'Your refund request has been sent to Kurso for review.' }
}
// ── Ebook refund requests (student ↔ creator) ────────────────────────
export async function checkEbookRefundEligibility(purchaseId: string): Promise<{ eligible: boolean; reason?: string }> {
  const { data: purchase } = await supabase
    .from('transactions')
    .select('id, status, ebook_id, created_at')
    .eq('id', purchaseId)
    .eq('product_type', 'ebook')
    .maybeSingle()

  if (!purchase || purchase.status !== 'success') return { eligible: false, reason: 'Not a completed purchase' }

  const { data: ebook } = await supabase.from('ebooks').select('refund_window_days').eq('id', purchase.ebook_id).maybeSingle()
  const windowDays = ebook?.refund_window_days ?? 0
  if (windowDays <= 0) return { eligible: false, reason: 'This ebook does not accept refunds' }

  const daysSince = (Date.now() - new Date(purchase.created_at).getTime()) / (1000 * 60 * 60 * 24)
  if (daysSince > windowDays) return { eligible: false, reason: 'Refund window has closed' }

  const { data: existing } = await supabase.from('refund_requests').select('id').eq('purchase_id', purchaseId).eq('type', 'ebook').maybeSingle()
  if (existing) return { eligible: false, reason: 'A request already exists for this purchase' }

  return { eligible: true }
}

export async function createEbookRefundRequest({ purchaseId, reason }: { purchaseId: string; reason?: string }): Promise<ActionResult> {
  const elig = await checkEbookRefundEligibility(purchaseId)
  if (!elig.eligible) return { ok: false, status: 400, error: elig.reason || 'Not eligible for a refund' }

  const { data: purchase } = await supabase.from('transactions').select('id, creator_id, student_id').eq('id', purchaseId).maybeSingle()
  if (!purchase) return { ok: false, status: 404, error: 'Purchase not found' }

  const { error } = await supabase.from('refund_requests').insert({
    type: 'ebook',
    purchase_id: purchaseId,
    creator_id: purchase.creator_id,
    student_id: purchase.student_id,
    requested_by: 'student',
    reason: reason || null,
  })
  if (error) {
    if (error.code === '23505') return { ok: false, status: 400, error: 'A request already exists for this purchase' }
    return { ok: false, status: 500, error: 'Could not submit your request' }
  }
  return { ok: true, message: 'Your refund request has been sent to the creator.' }
}

export async function decideEbookRefundRequest({ requestId, creatorId, decision, note, amount }: { requestId: string; creatorId: string; decision: 'approved' | 'denied'; note?: string; amount?: number }): Promise<ActionResult> {
  const { data: request } = await supabase.from('refund_requests').select('id, purchase_id, creator_id, status, type').eq('id', requestId).maybeSingle()
  if (!request || request.type !== 'ebook') return { ok: false, status: 404, error: 'Request not found' }
  if (request.creator_id !== creatorId) return { ok: false, status: 403, error: 'Not your request to decide' }
  if (request.status !== 'pending') return { ok: false, status: 400, error: 'This request has already been decided' }

  if (decision === 'denied') {
    await supabase.from('refund_requests').update({
      status: 'denied', decision_note: note || null, decided_at: new Date().toISOString(), decided_by: 'creator',
    }).eq('id', requestId)
    return { ok: true, message: 'Request denied.' }
  }

  const { data: purchase } = await supabase.from('transactions').select('id, ebook_id, rrn, ebook_download_count').eq('id', request.purchase_id).maybeSingle()
  if (!purchase) return { ok: false, status: 404, error: 'Purchase not found' }
  if (!purchase.rrn) return { ok: false, status: 404, error: 'No completed payment record found for this purchase — cannot refund automatically. Please refund manually from your gateway dashboard.' }

  // transactions and payments are two separate tables written by the same
  // webhook event — they don't share a foreign key, but both get the
  // same provider transaction reference at write time, which is what
  // ties a purchase back to the specific payment record to refund.
  const { data: payment } = await supabase
    .from('payments')
    .select('id, provider, provider_order_id, provider_payment_id, net_amount')
    .eq('provider_payment_id', purchase.rrn)
    .eq('product_type', 'ebook')
    .eq('ebook_id', purchase.ebook_id)
    .eq('status', 'paid')
    .maybeSingle()

  if (!payment) return { ok: false, status: 404, error: 'No completed payment record found for this purchase — cannot refund automatically. Please refund manually from your gateway dashboard.' }

  const { data: refundRows } = await supabase.from('refunds').select('amount, status').eq('payment_id', payment.id)
  const alreadyRefunded = (refundRows || []).filter(r => r.status === 'succeeded').reduce((sum, r) => sum + Number(r.amount), 0)
  const refundable = Number(payment.net_amount) - alreadyRefunded

  const requestedAmount = amount === undefined || amount === null ? refundable : Number(amount)
  if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) return { ok: false, status: 400, error: 'Enter a valid refund amount.' }
  if (requestedAmount > refundable + 0.01) {
    return { ok: false, status: 400, error: `You can refund at most ₹${refundable.toLocaleString('en-IN')} on this payment.` }
  }

  const gateway = await getCreatorGatewayByProvider(creatorId, payment.provider as 'cashfree' | 'razorpay' | 'stripe')
  if (!gateway) return { ok: false, status: 409, error: `Your ${payment.provider} connection isn't active — reconnect it in Settings before issuing refunds.` }

  const refundId = randomUUID()
  // The refunds table has no purchase_id column (the old insert asked for one, so it always failed).
  // The refund is linked through payment_id instead.
  const { error: refundInsertError } = await supabase.from('refunds').insert({
    id: refundId, payment_id: payment.id, creator_id: creatorId,
    amount: requestedAmount, reason: note || null, revoke_access: true, provider: payment.provider, status: 'pending',
  })
  // If the record cannot be saved, stop here. Sending money without a record would let the same payment be refunded twice.
  if (refundInsertError) {
    console.error('[refund] could not save the refund record:', refundInsertError.message)
    return { ok: false, status: 500, error: 'We could not record this refund, so nothing was sent. Please try again.' }
  }

  try {
    const { providerRefundId } = await executeGatewayRefund({
      gateway,
      target: { provider: payment.provider as any, providerOrderId: payment.provider_order_id, providerPaymentId: payment.provider_payment_id },
      amount: requestedAmount,
      refundId,
      reason: note,
    })

    await supabase.from('refunds').update({ status: 'succeeded', provider_refund_id: providerRefundId }).eq('id', refundId)
    // Block further downloads immediately rather than deleting the record
    await supabase.from('transactions').update({
      status: 'refunded',
      ebook_download_limit: purchase.ebook_download_count ?? 0,
    }).eq('id', request.purchase_id)
    await supabase.from('refund_requests').update({
      status: 'completed', decision_note: note || null, decided_at: new Date().toISOString(), decided_by: 'creator', completed_at: new Date().toISOString(),
    }).eq('id', requestId)

    return { ok: true, message: `Refund of ₹${requestedAmount.toLocaleString('en-IN')} issued. Further downloads have been blocked.` }
  } catch (err: any) {
    const msg = err instanceof RefundExecutionError ? err.message : 'The payment gateway rejected this refund. No money was moved and nothing was changed — please try again or refund manually from your gateway dashboard.'
    await supabase.from('refunds').update({ status: 'failed', error_message: msg }).eq('id', refundId)
    return { ok: false, status: 502, error: msg }
  }
}

// Called once Cashfree has actually confirmed a refund succeeded — either
// synchronously (decideSubscriptionRefundRequest got refund_status: SUCCESS
// on its first call) or asynchronously (kurso-webhook's REFUND_STATUS_WEBHOOK
// handler). Either caller must pass the refundReferenceId it initiated the
// refund with, so a stale/duplicate webhook for a superseded attempt can
// never be applied to whatever refund is currently pending on this payment.
export async function finalizeKursoSubscriptionRefundSuccess({ paymentId, refundReferenceId, refundAmount }: { paymentId: string; refundReferenceId: string; refundAmount: number }): Promise<void> {
  const { data: payment } = await supabase
    .from('kurso_subscription_payments')
    .select('id, subscription_id, amount, refunded_amount, refund_reference_id, pending_refund_request_id')
    .eq('id', paymentId)
    .maybeSingle()

  if (!payment || payment.refund_reference_id !== refundReferenceId) return

  const newRefundedAmount = Number(payment.refunded_amount || 0) + refundAmount
  const isFullRefund = newRefundedAmount >= Number(payment.amount) - 0.01

  await supabase.from('kurso_subscription_payments').update({
    refund_status: 'succeeded',
    refunded_amount: newRefundedAmount,
    refund_error: null,
    refund_reference_id: null,
    pending_refund_amount: null,
  }).eq('id', paymentId)

  // Only cancel the subscription on a full refund — a partial refund
  // (e.g. Kurso choosing to refund less than the full amount to a
  // heavy-usage creator) doesn't necessarily mean the subscription
  // itself should end.
  if (isFullRefund && payment.subscription_id) {
    await supabase.from('subscriptions').update({ status: 'cancelled' }).eq('id', payment.subscription_id)
  }

  if (payment.pending_refund_request_id) {
    await supabase.from('refund_requests').update({
      status: 'completed', completed_at: new Date().toISOString(),
    }).eq('id', payment.pending_refund_request_id)
  }
}

// Mirror of finalizeKursoSubscriptionRefundSuccess for the FAILED/CANCELLED
// case — puts the request back to 'pending' (instead of leaving it stuck on
// 'approved') so the admin can see it needs another attempt.
export async function markKursoSubscriptionRefundFailed({ paymentId, refundReferenceId, errorMessage }: { paymentId: string; refundReferenceId: string; errorMessage: string }): Promise<void> {
  const { data: payment } = await supabase
    .from('kurso_subscription_payments')
    .select('id, refund_reference_id, pending_refund_request_id')
    .eq('id', paymentId)
    .maybeSingle()

  if (!payment || payment.refund_reference_id !== refundReferenceId) return

  await supabase.from('kurso_subscription_payments').update({
    refund_status: 'failed',
    refund_error: errorMessage,
    refund_reference_id: null,
    pending_refund_amount: null,
  }).eq('id', paymentId)

  if (payment.pending_refund_request_id) {
    await supabase.from('refund_requests').update({
      status: 'pending',
      decision_note: `Refund attempt failed via Cashfree: ${errorMessage}. Please retry.`,
    }).eq('id', payment.pending_refund_request_id)
  }
}

export async function decideSubscriptionRefundRequest({ requestId, decision, note, amount }: { requestId: string; decision: 'approved' | 'denied'; note?: string; amount?: number }): Promise<ActionResult> {
  const { data: request } = await supabase
    .from('refund_requests')
    .select('id, subscription_id, status, type')
    .eq('id', requestId)
    .maybeSingle()

  if (!request || request.type !== 'subscription') return { ok: false, status: 404, error: 'Request not found' }
  if (request.status !== 'pending') return { ok: false, status: 400, error: 'This request has already been decided' }

  if (decision === 'denied') {
    await supabase.from('refund_requests').update({
      status: 'denied', decision_note: note || null, decided_at: new Date().toISOString(), decided_by: 'admin',
    }).eq('id', requestId)
    return { ok: true, message: 'Request denied.' }
  }

  // Most recent payment on this subscription — eligibility already only
  // allows a request within 15 days of the current billing period, so
  // there's no ambiguity about which cycle's payment this refers to.
  const { data: payment } = await supabase
    .from('kurso_subscription_payments')
    .select('id, order_id, amount, refund_status, refunded_amount')
    .eq('subscription_id', request.subscription_id)
    .order('paid_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!payment) return { ok: false, status: 404, error: 'No payment record found for this subscription — refund manually and contact support.' }
  if (!payment.order_id) {
    return { ok: false, status: 404, error: 'This payment predates automatic refund tracking and has no stored order ID — it must be refunded manually from the Cashfree dashboard.' }
  }
  if (payment.refund_status === 'processing') {
    return { ok: false, status: 409, error: 'A refund is already processing on this payment — wait for Cashfree to confirm it before starting another.' }
  }

  const alreadyRefunded = Number(payment.refunded_amount || 0)
  const refundable = Number(payment.amount) - alreadyRefunded
  const requestedAmount = amount === undefined || amount === null ? refundable : Number(amount)

  if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) return { ok: false, status: 400, error: 'Enter a valid refund amount.' }
  if (requestedAmount > refundable + 0.01) {
    return { ok: false, status: 400, error: `You can refund at most ₹${refundable.toLocaleString('en-IN')} on this payment.` }
  }

  const refundId = randomUUID()

  // Recorded BEFORE calling Cashfree — refund_reference_id is what the
  // REFUND_STATUS_WEBHOOK uses to find its way back to this exact payment +
  // request, so it must already be there by the time Cashfree can possibly
  // notify us.
  await supabase.from('kurso_subscription_payments').update({
    refund_status: 'processing',
    refund_reference_id: refundId,
    pending_refund_amount: requestedAmount,
    pending_refund_request_id: requestId,
    refund_error: null,
  }).eq('id', payment.id)

  await supabase.from('refund_requests').update({
    status: 'approved', decision_note: note || null, decided_at: new Date().toISOString(), decided_by: 'admin',
  }).eq('id', requestId)

  try {
    const { refundStatus } = await refundKursoSubscriptionPayment({
      orderId: payment.order_id,
      amount: requestedAmount,
      refundId,
      reason: note,
    })

    if (refundStatus === 'SUCCESS') {
      await finalizeKursoSubscriptionRefundSuccess({ paymentId: payment.id, refundReferenceId: refundId, refundAmount: requestedAmount })
      return { ok: true, message: `Refund of ₹${requestedAmount.toLocaleString('en-IN')} issued via Cashfree.` }
    }

    // Cashfree accepted the refund but hasn't settled it — the
    // REFUND_STATUS_WEBHOOK handler in kurso-webhook/route.ts finalizes this
    // once Cashfree confirms SUCCESS or FAILED/CANCELLED.
    return { ok: true, message: `Refund of ₹${requestedAmount.toLocaleString('en-IN')} submitted to Cashfree and is processing — it'll confirm automatically once settled.` }
  } catch (err: any) {
    const msg = err instanceof KursoCashfreeError ? err.message : 'Cashfree rejected this refund. No money was moved and nothing was changed.'
    await markKursoSubscriptionRefundFailed({ paymentId: payment.id, refundReferenceId: refundId, errorMessage: msg })
    return { ok: false, status: 502, error: msg }
  }
}