/**
 * src/lib/kurso-checkout.ts
 * ─────────────────────────────────────────────────────────────────
 * Shared Cashfree checkout helpers for Kurso's own subscription
 * payments (creator → Kurso). Used by /upgrade and by the
 * DeliveryMethodPicker component (inline "pay the difference to
 * unlock this channel" flow on create-course / course settings).
 *
 * Kept framework-agnostic (no React) so both call sites share one
 * implementation instead of drifting apart.
 * ─────────────────────────────────────────────────────────────────
 */
import { supabase } from './supabase'
import type { SubscriptionPlanId } from '@/app/api/razorpay/subscription-plans'

/** Loads Cashfree's checkout SDK once and caches the instance on window. */
export async function loadCashfreeSdk(): Promise<any> {
  if ((window as any).__cashfreeInstance) return (window as any).__cashfreeInstance
  await new Promise<void>((resolve, reject) => {
    if (document.getElementById('cashfree-sdk-script')) return resolve()
    const script = document.createElement('script')
    script.id = 'cashfree-sdk-script'
    script.src = 'https://sdk.cashfree.com/js/v3/cashfree.js'
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Could not load the payment SDK. Check your connection and try again.'))
    document.body.appendChild(script)
  })
  const mode = process.env.NEXT_PUBLIC_KURSO_CASHFREE_ENV === 'sandbox' ? 'sandbox' : 'production'
  const instance = (window as any).Cashfree({ mode })
  ;(window as any).__cashfreeInstance = instance
  return instance
}

export async function pollOrderStatus(clientTxnId: string, attemptsLeft = 8): Promise<string | null> {
  if (attemptsLeft <= 0) return null
  const res = await fetch(`/api/order-status?clientTxnId=${clientTxnId}`)
  const data = await res.json().catch(() => null)
  if (data?.status === 'active' || data?.status === 'success') return data.status
  await new Promise((r) => setTimeout(r, 2000))
  return pollOrderStatus(clientTxnId, attemptsLeft - 1)
}

/**
 * Resolves the delivery-plan tier the creator currently has unlocked:
 *  - an active Pay-As-You-Earn revenue-share agreement → 'both' (the whole
 *    point of PAYE is zero upfront cost for full access — commission is
 *    billed after the fact, per sale, never gating what's unlocked)
 *  - an active paid subscription → its plan_tier
 *  - no active subscription but trial not yet expired → 'both' (full
 *    access during the trial, so nothing blocks testing/onboarding)
 *  - trial expired and no active subscription/agreement → null (nothing unlocked)
 */
export async function getEffectivePlanId(creatorId: string, trialEndsAt?: string | null): Promise<SubscriptionPlanId | null> { // Everyone is Pay As You Earn now: every creator can use every channel (WhatsApp, Telegram, web). // WhatsApp message charges are billed on the monthly invoice instead of being locked behind a plan. // The older flat-plan logic below is kept only for reference and is no longer reached. if (creatorId) return 'both'

const { data: revShare } = await supabase
    .from('revenue_share_agreements')
    .select('id')
    .eq('creator_id', creatorId)
    .eq('status', 'active')
    .maybeSingle()

  if (revShare) return 'both'

  const { data: sub } = await supabase
    .from('subscriptions')
    .select('plan_tier, status, current_period_end')
    .eq('creator_id', creatorId)
    .maybeSingle()

  const active =
    sub?.status === 'active' &&
    sub.current_period_end &&
    new Date(sub.current_period_end) > new Date()

  if (active) return sub!.plan_tier as SubscriptionPlanId

  if (trialEndsAt && new Date(trialEndsAt) > new Date()) return 'both'

  return null
}

export type PayForPlanResult =
  | { ok: true; amountPaid: number; isUpgrade: boolean }
  | { ok: false; error: string; blocked?: boolean }

/**
 * Opens Cashfree checkout for the given target plan, charging only the
 * upgrade delta if the creator already has an active plan (server-enforced
 * in create-subscription-order — this never trusts client-side math).
 * Resolves only once payment is independently confirmed via polling, never
 * on the checkout modal's close event alone.
 *
 * Deliberately kept on Popup ('_modal'), not Redirect: this is the inline
 * "pay to unlock" flow inside DeliveryMethodPicker, called from the middle
 * of the create-course draft form and the course settings page. A full-page
 * redirect away and back would either lose the unsaved draft or require
 * persisting/restoring the whole form — not worth it for a same-page inline
 * upgrade. The standalone checkout pages (/upgrade, ebook purchase, course
 * enrollment) use Redirect instead — see their own files.
 */
export async function payForPlan(planId: SubscriptionPlanId): Promise<PayForPlanResult> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) return { ok: false, error: 'Please log in before upgrading.' }

  const orderRes = await fetch('/api/kurso/create-subscription-order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ planId }),
  })
  const data = await orderRes.json().catch(() => ({}))
  if (data.error) {
    if (data.error === 'downgrade_blocked') return { ok: false, error: data.message, blocked: true }
    return { ok: false, error: data.error }
  }

  const cashfree = await loadCashfreeSdk()
  await cashfree.checkout({ paymentSessionId: data.paymentSessionId, redirectTarget: '_modal' })

  const status = await pollOrderStatus(data.clientTxnId)
  if (status === 'active' || status === 'success') {
    return { ok: true, amountPaid: data.amount, isUpgrade: !!data.isUpgrade }
  }
  return {
    ok: false,
    error: 'We could not confirm this payment yet. If money was deducted, it will reflect within a few minutes — refresh and check, or contact support if it does not.',
  }
}
