import crypto from 'crypto'

// Kurso's OWN Cashfree merchant account — used ONLY for creators paying
// their Kurso subscription (Flow B). This is NOT a creator's BYOK
// credential — keys live in env vars, never in a per-creator DB row.
//
// Required env vars:
//   KURSO_CASHFREE_CLIENT_ID
//   KURSO_CASHFREE_CLIENT_SECRET
//   KURSO_CASHFREE_ENV            'sandbox' | 'production'

const CF_API_VERSION = '2023-08-01'

export class KursoCashfreeError extends Error {
  status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.status = status
  }
}

function baseUrl(): string {
  return process.env.KURSO_CASHFREE_ENV === 'sandbox'
    ? 'https://sandbox.cashfree.com'
    : 'https://api.cashfree.com'
}

function credentials() {
  const clientId = process.env.KURSO_CASHFREE_CLIENT_ID
  const clientSecret = process.env.KURSO_CASHFREE_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new KursoCashfreeError('Kurso Cashfree credentials are not configured on the server.')
  }
  return { clientId, clientSecret }
}

export type KursoCashfreeOrder = {
  order_id: string
  payment_session_id: string
  order_status: string
}

export async function createKursoSubscriptionOrder(params: {
  orderId: string
  amount: number
  customerName: string
  customerEmail: string
  customerPhone?: string
  returnUrl: string
}): Promise<KursoCashfreeOrder> {
  const { clientId, clientSecret } = credentials()

  const res = await fetch(`${baseUrl()}/pg/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-client-id': clientId,
      'x-client-secret': clientSecret,
      'x-api-version': CF_API_VERSION,
    },
    body: JSON.stringify({
      order_id: params.orderId,
      order_amount: params.amount,
      order_currency: 'INR',
      customer_details: {
        customer_id: params.orderId,
        customer_name: params.customerName,
        customer_email: params.customerEmail,
        customer_phone: params.customerPhone || '9999999999',
      },
      order_meta: {
        return_url: params.returnUrl,
        notify_url: `${process.env.NEXT_PUBLIC_SITE_URL}/api/cashfree/kurso-webhook`,
      },
      order_note: 'Kurso subscription payment',
    }),
  })

  const json = await res.json().catch(() => null)
  if (!res.ok) {
    throw new KursoCashfreeError(json?.message || `Cashfree order creation failed (${res.status})`, res.status)
  }
  return json
}

// Cashfree signs: base64( HMAC-SHA256( secret, timestamp + rawBody ) )
// Header names: x-webhook-signature, x-webhook-timestamp
export function verifyKursoCashfreeWebhookSignature(params: {
  timestamp: string
  rawBody: string
  signature: string
}): boolean {
  const { clientSecret } = credentials()
  const expected = crypto
    .createHmac('sha256', clientSecret)
    .update(params.timestamp + params.rawBody)
    .digest('base64')

  const a = Buffer.from(expected)
  const b = Buffer.from(params.signature)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

// Refunds a creator's Kurso subscription payment — this is Kurso's OWN
// money going back to a creator, through Kurso's own Cashfree account
// (never a creator's BYOK gateway; that's a completely separate flow
// in gateway-refund.ts for student refunds).
//
// Whatever Cashfree's own error message says gets thrown through as-is
// (json?.message), rather than a generic "refund failed" — that's what
// lets a genuine cause like insufficient settled balance in Kurso's
// Cashfree account surface clearly to the admin approving it, instead
// of a vague failure with no actionable next step.
export async function refundKursoSubscriptionPayment(params: {
  orderId: string
  amount: number // rupees
  refundId: string // idempotency/reference — pass a stable id so a retry can't double-refund
  reason?: string
}): Promise<{ providerRefundId: string; refundStatus: string }> {
  const { clientId, clientSecret } = credentials()

  const res = await fetch(`${baseUrl()}/pg/orders/${params.orderId}/refunds`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-client-id': clientId,
      'x-client-secret': clientSecret,
      'x-api-version': CF_API_VERSION,
    },
    body: JSON.stringify({
      refund_amount: params.amount,
      refund_id: params.refundId,
      refund_note: params.reason || 'Kurso subscription refund',
    }),
  })

    const json = await res.json().catch(() => null)
  if (!res.ok) {
    throw new KursoCashfreeError(json?.message || `Cashfree refund failed (${res.status})`, res.status)
  }
  // Cashfree refunds aren't always instant — refund_status can come back
  // PENDING here and only resolve to SUCCESS/FAILED later via the
  // REFUND_STATUS_WEBHOOK. Callers must not treat a 200 here as "money moved".
  return {
    providerRefundId: json.refund_id || json.cf_refund_id || params.refundId,
    refundStatus: json.refund_status || 'PENDING',
  }
}
/** Looks up an existing order (for Pay retries). Returns null if Cashfree has no such order. */
export async function getKursoOrder(orderId: string): Promise<(KursoCashfreeOrder & { order_amount?: number }) | null> {
  const { clientId, clientSecret } = credentials()
  const res = await fetch(`${baseUrl()}/pg/orders/${encodeURIComponent(orderId)}`, {
    headers: { 'x-client-id': clientId, 'x-client-secret': clientSecret, 'x-api-version': CF_API_VERSION },
  })
  if (res.status === 404) return null
  const json = await res.json().catch(() => null)
  if (!res.ok) throw new KursoCashfreeError(json?.message || `Cashfree order lookup failed (${res.status})`, res.status)
  return json
}