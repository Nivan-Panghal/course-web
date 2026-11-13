import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createKursoSubscriptionOrder, getKursoOrder, KursoCashfreeError } from '@/lib/kurso-cashfree'
import { friendlyErrorResponse } from '@/lib/payment-errors'
import { isImpersonationActive, IMPERSONATION_BLOCK_MESSAGE } from '@/lib/impersonation-guard'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(req: NextRequest) {
  try {
    const token = (req.headers.get('authorization') || '').replace('Bearer ', '').trim()
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { data: userData, error: userErr } = await supabase.auth.getUser(token)
    if (userErr || !userData.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const creatorId = userData.user.id

    if (await isImpersonationActive(creatorId)) {
      return NextResponse.json({ error: IMPERSONATION_BLOCK_MESSAGE }, { status: 403 })
    }

    const { invoiceId } = await req.json()
    if (!invoiceId) return NextResponse.json({ error: 'invoiceId is required' }, { status: 400 })

    const { data: invoice, error: invErr } = await supabase
      .from('revenue_share_invoices')
            .select('id, creator_id, total_amount_due, status, period_start, gateway_order_id')
      .eq('id', invoiceId)
      .maybeSingle()
    if (invErr) throw invErr
    if (!invoice || invoice.creator_id !== creatorId) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }
    if (invoice.status === 'paid') {
      return NextResponse.json({ error: 'This invoice is already paid.' }, { status: 400 })
    }
    if (invoice.status === 'waived') {
      return NextResponse.json({ error: 'This invoice was waived — nothing to pay.' }, { status: 400 })
    }
    if (invoice.total_amount_due <= 0) {
      return NextResponse.json({ error: 'Nothing due for this period.' }, { status: 400 })
    }

    const { data: creator } = await supabase
      .from('creators')
      .select('name, email')
      .eq('id', creatorId)
      .maybeSingle()

    try {
            // Retry safety: if an order already exists for this invoice, reuse it while it can still
      // be paid. Cashfree refuses a repeated order_id, and a paid order must not be duplicated.
      if (invoice.gateway_order_id) {
        const existing = await getKursoOrder(invoice.gateway_order_id)
        if (existing?.order_status === 'PAID') {
          return NextResponse.json({ error: 'A payment for this invoice was already received and is being confirmed. Please check again in a few minutes.' }, { status: 409 })
        }
        if (existing?.order_status === 'ACTIVE' && Number(existing.order_amount) === Number(invoice.total_amount_due)) {
          return NextResponse.json({ clientTxnId: invoice.id, orderId: existing.order_id, paymentSessionId: existing.payment_session_id, amount: invoice.total_amount_due })
        }
      }
      // A previous order exists but is no longer usable: start a new one under a fresh id.
      const orderId = invoice.gateway_order_id ? `${invoice.id}-${Date.now().toString(36)}` : invoice.id
      const order = await createKursoSubscriptionOrder({
                orderId,
        amount: invoice.total_amount_due,
        customerName: creator?.name || creator?.email || 'Creator',
        customerEmail: creator?.email || '',
        returnUrl: `${process.env.NEXT_PUBLIC_SITE_URL}/upgrade?revenue_share_invoice=${invoice.id}`,
      })

      await supabase
        .from('revenue_share_invoices')
        .update({ gateway_order_id: order.order_id })
        .eq('id', invoice.id)

      return NextResponse.json({
        clientTxnId: invoice.id,
        orderId: order.order_id,
        paymentSessionId: order.payment_session_id,
        amount: invoice.total_amount_due,
      })
    } catch (err: any) {
      const msg = err instanceof KursoCashfreeError ? err.message : 'Could not start this payment.'
      return NextResponse.json({ error: msg }, { status: 502 })
    }
  } catch (err: any) {
    return friendlyErrorResponse(err, 'creator/revenue-share/pay POST')
  }
}