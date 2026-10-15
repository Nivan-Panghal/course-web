// src/lib/workshop-refund.ts
//
// Workshop refunds (workshops only; course and ebook refunds keep using lib/refund-actions.ts).
//
//  - Students ask from a private link (the review_token on their registration).
//  - Online (gateway) payments are refunded through the creator's own gateway,
//    the same way course refunds are.
//  - UPI payments cannot be refunded by Kurso. The request still shows up, and the
//    creator refunds the student themselves, then taps "I've refunded this".
//
// Server side only.

import { randomUUID } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { executeGatewayRefund, RefundExecutionError } from '@/lib/gateway-refund'
import { getCreatorGatewayByProvider } from '@/lib/gateway-checkout'
import { escapeHtml, sendLoggedEmail } from '@/lib/email'

export const WORKSHOP_REFUND_WINDOW_DAYS = 7
export const MAX_REFUND_REASON = 500

export type RefundResult = { ok: true; message: string } | { ok: false; status: number; error: string }

const SITE = () => (process.env.NEXT_PUBLIC_SITE_URL || 'https://kurso.in').replace(/\/$/, '')

async function sendTelegramText(chatId: string | number, text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return false
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    })
    return res.ok
  } catch {
    return false
  }
}

type RefundOutcome = 'refunded_online' | 'refunded_by_hand' | 'declined'

/**
 * Tells the student what was decided, on Telegram and by email.
 * Best effort: it never throws and never blocks the decision itself.
 */
async function notifyStudentOfRefundDecision(
  supabase: SupabaseClient,
  p: { registrationId: string; creatorId: string; outcome: RefundOutcome; amount?: number; note: string | null },
): Promise<{ telegram: boolean; email: boolean }> {
  const none = { telegram: false, email: false }
  try {
    const { data: reg } = await supabase
      .from('workshop_registrations')
      .select('name, email, telegram_chat_id, review_token, workshop_id, payment_status, payment_mode, amount_paid')
      .eq('id', p.registrationId)
      .maybeSingle()
    if (!reg || (!reg.email && !reg.telegram_chat_id)) return none
    const { data: w } = await supabase.from('workshops').select('title, host_name, brand_name, price').eq('id', reg.workshop_id).maybeSingle()

    const host = w?.brand_name || w?.host_name || 'The host'
    const title = w?.title || 'the workshop'
    const first = String(reg.name || '').trim().split(/\s+/)[0] || 'there'
    const amount = p.amount ?? amountPaidFor(reg, Number(w?.price) || 0)
    const money = `₹${Math.round(amount).toLocaleString('en-IN')}`
    const url = `${SITE()}/workshop-refund/${reg.review_token}`

    let subject: string
    let lines: string[]
    if (p.outcome === 'refunded_online') {
      subject = `Your refund for ${title}`
      lines = [`Your refund of ${money} for “${title}” has been sent back to the payment method you used.`, 'Banks can take a few working days to show it.']
    } else if (p.outcome === 'refunded_by_hand') {
      subject = `Your refund for ${title}`
      lines = [`${host} has marked your refund of ${money} for “${title}” as sent.`, 'Please check your UPI app or bank account. If you do not see it, contact the host directly.']
    } else {
      subject = `About your refund request for ${title}`
      lines = [`${host} could not approve your refund request for “${title}”.`, ...(p.note ? [`Note from ${host}: ${p.note}`] : []), 'If you have questions, please contact the host directly.']
    }

    const [telegram, email] = await Promise.all([
      reg.telegram_chat_id ? sendTelegramText(reg.telegram_chat_id, `Hi ${first},\n\n${lines.join('\n\n')}\n\nDetails: ${url}`) : Promise.resolve(false),
      reg.email
        ? sendLoggedEmail({
            supabase,
            creatorId: p.creatorId,
            emailType: 'workshop_refund_update',
            to: reg.email,
            subject,
            html: `
              <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1f2937;line-height:1.6">
                <p>Hi ${escapeHtml(first)},</p>
                ${lines.map(l => `<p style="white-space:pre-wrap">${escapeHtml(l)}</p>`).join('')}
                <p><a href="${url}">See your refund status</a></p>
              </div>`,
            metadata: { workshop_registration_id: p.registrationId, outcome: p.outcome },
          }).then(r => !!r.sent)
        : Promise.resolve(false),
    ])
    return { telegram, email }
  } catch (err) {
    console.error('[workshop-refund] could not notify the student:', err)
    return none
  }
}

/** " We also told the student on Telegram and by email." (only what really went out) */
function toldNote(r: { telegram: boolean; email: boolean }): string {
  const ways = [r.telegram && 'on Telegram', r.email && 'by email'].filter(Boolean).join(' and ')
  return ways ? ` We also told the student ${ways}.` : ''
}

/** Students can ask until this many days after the workshop starts. */
export const refundDeadline = (workshopDateTime: string) =>
  new Date(new Date(workshopDateTime).getTime() + WORKSHOP_REFUND_WINDOW_DAYS * 24 * 60 * 60 * 1000)

/** What the student paid (rupees): the online amount, 0 for free, or the listed price for hand-confirmed UPI. */
export function amountPaidFor(reg: { payment_status: string; payment_mode: string | null; amount_paid: number | null }, listedPrice: number): number {
  if (reg.payment_status !== 'confirmed') return 0
  const online = Number(reg.amount_paid) || 0
  if (online > 0) return online
  return reg.payment_mode === 'free' ? 0 : Math.max(0, Number(listedPrice) || 0)
}

export type RefundEligibility = {
  eligible: boolean
  reason: string | null
  amount: number
  isGateway: boolean
  deadline: string
}

export function checkWorkshopRefundEligibility(
  reg: { payment_status: string; payment_mode: string | null; amount_paid: number | null; refunded_at: string | null },
  workshop: { date_time: string; price: number },
): RefundEligibility {
  const amount = amountPaidFor(reg, workshop.price)
  const deadline = refundDeadline(workshop.date_time)
  const base = { amount, isGateway: reg.payment_mode === 'gateway', deadline: deadline.toISOString() }
  if (reg.payment_status !== 'confirmed') return { ...base, eligible: false, reason: 'Only confirmed, paid registrations can ask for a refund.' }
  if (reg.refunded_at) return { ...base, eligible: false, reason: 'This registration has already been refunded.' }
  if (amount <= 0) return { ...base, eligible: false, reason: 'This workshop was free, so there is nothing to refund.' }
  if (Date.now() > deadline.getTime()) {
    return { ...base, eligible: false, reason: `The refund window ended on ${deadline.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' })}.` }
  }
  return { ...base, eligible: true, reason: null }
}

export async function decideWorkshopRefundRequest(
  supabase: SupabaseClient,
  p: { requestId: string; creatorId: string; decision: 'approved' | 'denied'; note?: string; amount?: number; manual?: boolean },
): Promise<RefundResult> {
  const { requestId, creatorId, decision, amount } = p
  const note = (p.note || '').trim().slice(0, 500) || null
  const now = () => new Date().toISOString()

  const { data: request } = await supabase
    .from('refund_requests')
    .select('id, creator_id, status, type, workshop_registration_id')
    .eq('id', requestId)
    .maybeSingle()
  if (!request || request.type !== 'workshop') return { ok: false, status: 404, error: 'Request not found' }
  if (request.creator_id !== creatorId) return { ok: false, status: 403, error: 'Not your request to decide' }
  if (request.status !== 'pending') return { ok: false, status: 400, error: 'This request has already been decided' }

  if (decision === 'denied') {
    await supabase.from('refund_requests').update({ status: 'denied', decision_note: note, decided_at: now(), decided_by: 'creator' }).eq('id', requestId).eq('status', 'pending')
    const told = await notifyStudentOfRefundDecision(supabase, { registrationId: request.workshop_registration_id, creatorId, outcome: 'declined', note })
    return { ok: true, message: `Request declined.${toldNote(told)}` }
  }

  // Claim the request first, so a double tap can never send two refunds.
  const { data: claimed } = await supabase
    .from('refund_requests')
    .update({ status: 'approved', decided_at: now(), decided_by: 'creator' })
    .eq('id', requestId)
    .eq('status', 'pending')
    .select('id')
  if (!claimed || claimed.length === 0) return { ok: false, status: 400, error: 'This request has already been decided' }
  const release = () => supabase.from('refund_requests').update({ status: 'pending', decided_at: null, decided_by: null }).eq('id', requestId)

  const { data: reg } = await supabase
    .from('workshop_registrations')
    .select('id, payment_mode, refunded_at')
    .eq('id', request.workshop_registration_id)
    .maybeSingle()
  if (!reg) { await release(); return { ok: false, status: 404, error: 'Registration not found' } }

  // Creator already refunded outside Kurso (UPI, or straight from the gateway dashboard).
  if (p.manual) {
    await supabase.from('refund_requests').update({ status: 'completed', decision_note: note, completed_at: now() }).eq('id', requestId)
    if (!reg.refunded_at) await supabase.from('workshop_registrations').update({ refunded_at: now() }).eq('id', reg.id)
    const told = await notifyStudentOfRefundDecision(supabase, { registrationId: reg.id, creatorId, outcome: 'refunded_by_hand', note })
    return { ok: true, message: `Marked as refunded. Their spot is now removed from your workshop numbers.${toldNote(told)}` }
  }

  if (reg.payment_mode !== 'gateway') {
    await release()
    return { ok: false, status: 400, error: 'This was paid by UPI, so Kurso cannot send the money back. Refund the student yourself, then tap “I’ve refunded this”.' }
  }

  const { data: payment } = await supabase
    .from('payments')
    .select('id, provider, provider_order_id, provider_payment_id, net_amount')
    .eq('workshop_registration_id', reg.id)
    .eq('status', 'paid')
    .order('paid_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!payment) {
    await release()
    return { ok: false, status: 404, error: 'We could not find the online payment for this registration. Refund it from your payment gateway dashboard, then tap “I’ve refunded this”.' }
  }

  const { data: refundRows } = await supabase.from('refunds').select('amount, status').eq('payment_id', payment.id)
  const alreadyRefunded = (refundRows || []).filter(r => r.status === 'succeeded').reduce((sum, r) => sum + Number(r.amount), 0)
  const refundable = Number(payment.net_amount) - alreadyRefunded
  const requestedAmount = amount === undefined || amount === null ? refundable : Number(amount)
  if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) { await release(); return { ok: false, status: 400, error: 'Enter a valid refund amount.' } }
  if (requestedAmount > refundable + 0.01) {
    await release()
    return { ok: false, status: 400, error: `You can refund at most ₹${refundable.toLocaleString('en-IN')} on this payment.` }
  }

  const gateway = await getCreatorGatewayByProvider(creatorId, payment.provider as 'cashfree' | 'razorpay' | 'stripe')
  if (!gateway) {
    await release()
    return { ok: false, status: 409, error: `Your ${payment.provider} connection isn't active. Reconnect it in Settings before issuing refunds.` }
  }

  const refundId = randomUUID()
  const { error: refundInsertError } = await supabase.from('refunds').insert({
    id: refundId, payment_id: payment.id, creator_id: creatorId,
    amount: requestedAmount, reason: note, revoke_access: true, provider: payment.provider, status: 'pending',
  })
  // If the record cannot be saved, stop here. Sending money without a record would let the same payment be refunded twice.
  if (refundInsertError) {
    console.error('[workshop-refund] could not save the refund record:', refundInsertError.message)
    await release()
    return { ok: false, status: 500, error: 'We could not record this refund, so nothing was sent. Please try again.' }
  }

  try {
    const { providerRefundId } = await executeGatewayRefund({
      gateway,
      target: { provider: payment.provider as any, providerOrderId: payment.provider_order_id, providerPaymentId: payment.provider_payment_id },
      amount: requestedAmount,
      refundId,
      reason: note || undefined,
    })
    await supabase.from('refunds').update({ status: 'succeeded', provider_refund_id: providerRefundId }).eq('id', refundId)
    const full = requestedAmount >= refundable - 0.01
    if (full) await supabase.from('workshop_registrations').update({ refunded_at: now() }).eq('id', reg.id)
    await supabase.from('refund_requests').update({ status: 'completed', decision_note: note, completed_at: now() }).eq('id', requestId)
    const told = await notifyStudentOfRefundDecision(supabase, { registrationId: reg.id, creatorId, outcome: 'refunded_online', amount: requestedAmount, note })
    return { ok: true, message: `Refund of ₹${requestedAmount.toLocaleString('en-IN')} sent to the student's original payment method.${full ? ' Their spot is now removed from your workshop numbers.' : ''}${toldNote(told)}` }
  } catch (err: any) {
    const msg = err instanceof RefundExecutionError
      ? err.message
      : 'The payment gateway rejected this refund. No money was moved and nothing was changed. Please try again, or refund from your gateway dashboard.'
    await supabase.from('refunds').update({ status: 'failed', error_message: msg }).eq('id', refundId)
    await release()
    return { ok: false, status: 502, error: msg }
  }
}