/**
 * Forges signed payment webhooks using each provider's real signature rules,
 * so tests can "pay" without a real payment.
 *  - Razorpay: HMAC-SHA256(secret, body) as hex, header x-razorpay-signature
 *  - Cashfree: HMAC-SHA256(secret, timestamp + body) as base64, headers x-webhook-signature + x-webhook-timestamp
 *  - Stripe:   header "t=<unix>,v1=<hex HMAC-SHA256(secret, `${t}.${body}`)>"
 */
import crypto from 'crypto'
import type { APIRequestContext } from '@playwright/test'

export type Provider = 'razorpay' | 'cashfree' | 'stripe'

export function buildEvent(p: Provider, o: { orderId: string; amountRupees: number; clientTxnId?: string; success?: boolean }) {
  const ok = o.success ?? true
  if (p === 'razorpay') {
    return {
      event: ok ? 'payment.captured' : 'payment.failed',
      payload: { payment: { entity: { id: `pay_${Date.now()}`, order_id: o.orderId, amount: Math.round(o.amountRupees * 100), status: ok ? 'captured' : 'failed' } } },
    }
  }
  if (p === 'cashfree') {
    return {
      type: ok ? 'PAYMENT_SUCCESS_WEBHOOK' : 'PAYMENT_FAILED_WEBHOOK',
      data: { order: { order_id: o.orderId }, payment: { cf_payment_id: `${Date.now()}`, payment_status: ok ? 'SUCCESS' : 'FAILED', payment_amount: o.amountRupees } },
    }
  }
  return {
    id: `evt_${Date.now()}`,
    type: 'checkout.session.completed',
    data: { object: { id: `cs_${Date.now()}`, client_reference_id: o.clientTxnId ?? o.orderId, payment_status: ok ? 'paid' : 'unpaid', amount_total: Math.round(o.amountRupees * 100), payment_intent: `pi_${Date.now()}` } },
  }
}

export function signedHeaders(p: Provider, rawBody: string, secret: string): Record<string, string> {
  if (p === 'razorpay') {
    return { 'x-razorpay-signature': crypto.createHmac('sha256', secret).update(rawBody).digest('hex') }
  }
  if (p === 'cashfree') {
    const ts = String(Date.now())
    return { 'x-webhook-timestamp': ts, 'x-webhook-signature': crypto.createHmac('sha256', secret).update(ts + rawBody).digest('base64') }
  }
  const t = Math.floor(Date.now() / 1000)
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')
  return { 'stripe-signature': `t=${t},v1=${v1}` }
}

/** POSTs a webhook to the running app. Pass a wrong `secret` to test forged-signature rejection. */
export async function postWebhook(request: APIRequestContext, p: Provider, event: object, secret: string) {
  const raw = JSON.stringify(event)
  return request.post(`/api/webhooks/${p}`, {
    data: raw,
    headers: { 'content-type': 'application/json', ...signedHeaders(p, raw, secret) },
  })
}