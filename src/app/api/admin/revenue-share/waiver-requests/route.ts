import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { requireAdmin } from '@/lib/admin-auth'
import { friendlyErrorResponse } from '@/lib/payment-errors'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(req: NextRequest) {
  try {
    const admin = await requireAdmin(req, supabase)
    if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data, error } = await supabase
      .from('revenue_share_waiver_requests')
            .select('id, creator_id, invoice_id, status, reason, requested_at, reviewed_at, admin_note, creators(name, email), revenue_share_invoices(product_type, period_start, period_end, gross_revenue, total_amount_due)')
      .order('requested_at', { ascending: false })
    if (error) throw error
    return NextResponse.json({ requests: data || [] })
  } catch (err: any) {
    return friendlyErrorResponse(err, 'admin/revenue-share/waiver-requests GET')
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin(req, supabase)
    if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { requestId, decision, note } = await req.json()
    if (!requestId || !['approved', 'rejected'].includes(decision)) {
      return NextResponse.json({ error: 'Missing or invalid fields' }, { status: 400 })
    }

        const { data: reqRow, error: reqErr } = await supabase
      .from('revenue_share_waiver_requests')
      .select('id, creator_id, invoice_id, status, revenue_share_invoices(product_type, whatsapp_amount)')
      .eq('id', requestId)
      .maybeSingle()
    if (reqErr) throw reqErr
    if (!reqRow) return NextResponse.json({ error: 'Request not found' }, { status: 404 })
    if (reqRow.status !== 'pending') {
      return NextResponse.json({ error: `Already ${reqRow.status}` }, { status: 400 })
    }

    // WhatsApp message charges are Meta's real cost, so a waiver only removes the commission.
    // If any WhatsApp charges are on the invoice, they stay due and the invoice stays open.
    const whatsappPart = Number((reqRow as any).revenue_share_invoices?.whatsapp_amount) || 0

    if (decision === 'approved' && whatsappPart > 0) {
      const { error: partErr } = await supabase
        .from('revenue_share_invoices')
        .update({ commission_amount: 0, total_amount_due: Math.round(whatsappPart) })
        .eq('id', reqRow.invoice_id)
      if (partErr) throw partErr
    } else if (decision === 'approved') {
      const { error: waiveErr } = await supabase
        .from('revenue_share_invoices')
        .update({ status: 'waived' })
        .eq('id', reqRow.invoice_id)
      if (waiveErr) throw waiveErr

      const isEbook = (reqRow as any).revenue_share_invoices?.product_type === 'ebook'

      // Waiving effectively un-lapses this creator, even if the overdue
      // sweep already paused their courses/ebooks while this sat
      // unreviewed — re-publish only what THAT sweep paused for THIS
      // reason, never something the creator drafted themselves or
      // paused for another reason. Which table depends on which kind
      // of invoice this waiver was for.
      if (isEbook) {
        await supabase.from('ebooks')
          .update({ is_published: true, auto_unpublished_at: null, auto_unpublished_reason: null })
          .eq('creator_id', reqRow.creator_id)
          .eq('auto_unpublished_reason', 'ebook_revenue_share_overdue')
      } else {
        await supabase.from('courses')
          .update({ is_published: true, auto_unpublished_at: null, auto_unpublished_reason: null })
          .eq('creator_id', reqRow.creator_id)
          .eq('auto_unpublished_reason', 'revenue_share_overdue')
      }
    }

    const { error: decideErr } = await supabase
      .from('revenue_share_waiver_requests')
      .update({
        status: decision,
        reviewed_at: new Date().toISOString(),
        reviewed_by: admin.email,
        admin_note: note || null,
      })
      .eq('id', requestId)
    if (decideErr) throw decideErr

    return NextResponse.json({ success: true })
  } catch (err: any) {
    return friendlyErrorResponse(err, 'admin/revenue-share/waiver-requests POST')
  }
}