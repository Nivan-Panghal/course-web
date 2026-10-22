import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { friendlyErrorResponse } from '@/lib/payment-errors'
import {
  REVENUE_SHARE_BASE_RATE_PERCENT,
  REVENUE_SHARE_OVERFLOW_RATE_PERCENT,
  REVENUE_SHARE_STUDENT_THRESHOLD,
  REVENUE_SHARE_INVOICE_GRACE_DAYS,
  EBOOK_REVENUE_SHARE_RATE_PERCENT,
  EBOOK_MONTHLY_REVENUE_FLOOR,
  monthStart,
} from '@/lib/revenueShare'
import { computeCourseWorkshopMonth } from '@/lib/invoiceCalc'
import { META_PRICING_URL, WHATSAPP_CATEGORY_LABEL, loadWhatsappSettings, previewWhatsappUsage, priceWhatsappUsage, type WhatsappCategory } from '@/lib/whatsappBilling'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function getCreatorId(req: NextRequest): Promise<string | null> {
  const token = (req.headers.get('authorization') || '').replace('Bearer ', '').trim()
  if (!token) return null
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) return null
  return data.user.id
}

/** Opt a creator into Pay-As-You-Earn. Safe to call again — reactivates a cancelled agreement instead of duplicating it. */
export async function POST(req: NextRequest) {
  try {
    const creatorId = await getCreatorId(req)
    if (!creatorId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: existing } = await supabase
      .from('revenue_share_agreements')
      .select('id, status')
      .eq('creator_id', creatorId)
      .maybeSingle()

    if (existing?.status === 'active') {
      return NextResponse.json({ success: true, alreadyActive: true })
    }

    if (existing) {
      const { error } = await supabase
        .from('revenue_share_agreements')
        .update({ status: 'active', cancelled_at: null, started_at: new Date().toISOString() })
        .eq('id', existing.id)
      if (error) throw error
    } else {
      const { error } = await supabase.from('revenue_share_agreements').insert({
        creator_id: creatorId,
        base_rate_percent: REVENUE_SHARE_BASE_RATE_PERCENT,
        overflow_rate_percent: REVENUE_SHARE_OVERFLOW_RATE_PERCENT,
        overflow_threshold_students: REVENUE_SHARE_STUDENT_THRESHOLD,
        status: 'active',
      })
      if (error) throw error
    }

    return NextResponse.json({ success: true })
  } catch (err: any) {
    return friendlyErrorResponse(err, 'creator/revenue-share POST')
  }
}

export async function GET(req: NextRequest) {
  try {
    const creatorId = await getCreatorId(req)
    if (!creatorId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // This month so far: what students paid, the commission it comes to, and WhatsApp messages
    // sent but not yet on an invoice. An estimate: the real invoice is made after the month ends.
    const now = new Date()
    const monthStartIso = `${monthStart(now)}T00:00:00.000Z`
    const [{ data: monthSales }, { data: monthRefunds }, settings, usage] = await Promise.all([
      supabase.from('payments').select('net_amount, platform_fee')
        .eq('creator_id', creatorId).eq('status', 'paid').in('product_type', ['course', 'workshop']).gte('paid_at', monthStartIso),
      supabase.from('refunds').select('amount, payments(net_amount, platform_fee, product_type)')
        .eq('creator_id', creatorId).eq('status', 'succeeded').gte('created_at', monthStartIso),
      loadWhatsappSettings(supabase),
      previewWhatsappUsage(supabase, creatorId, now).catch(() => [] as { category: string; messages: number }[]),
    ])
    const month = computeCourseWorkshopMonth(
      (monthSales || []).map((s: any) => ({ net_amount: s.net_amount, platform_fee: s.platform_fee })),
      (monthRefunds || [])
        .filter((r: any) => ['course', 'workshop'].includes(r.payments?.product_type))
        .map((r: any) => ({ refund_amount: r.amount, sale_net_amount: r.payments?.net_amount, sale_platform_fee: r.payments?.platform_fee })),
    )
    const whatsapp = priceWhatsappUsage(usage, settings)

    const [{ data: agreement }, { data: invoices }] = await Promise.all([
      supabase
        .from('revenue_share_agreements')
        .select('id, base_rate_percent, overflow_rate_percent, overflow_threshold_students, status, started_at')
        .eq('creator_id', creatorId)
        .maybeSingle(),
      supabase
        .from('revenue_share_invoices')
                .select('id, product_type, period_start, period_end, gross_revenue, total_amount_due, commission_amount, whatsapp_amount, line_items, status, paid_at, overdue_at')
        .eq('creator_id', creatorId)
        .order('period_start', { ascending: false })
        .limit(24),
    ])

    return NextResponse.json({
      agreement: agreement || null,
      invoices: invoices || [],
      rates: {
        baseRatePercent: Number(agreement?.base_rate_percent ?? REVENUE_SHARE_BASE_RATE_PERCENT),
        overflowRatePercent: Number(agreement?.overflow_rate_percent ?? REVENUE_SHARE_OVERFLOW_RATE_PERCENT),
        thresholdStudents: Number(agreement?.overflow_threshold_students ?? REVENUE_SHARE_STUDENT_THRESHOLD),
        ebookRatePercent: EBOOK_REVENUE_SHARE_RATE_PERCENT,
        ebookMonthlyFloor: EBOOK_MONTHLY_REVENUE_FLOOR,
        graceDays: REVENUE_SHARE_INVOICE_GRACE_DAYS,
      },
      thisMonth: {
        collected: month.collected,
        commission: month.commission,
        whatsappLines: whatsapp.lines,
        whatsappTotal: whatsapp.total,
        whatsappMarkupPercent: settings.markupPercent,
        estimatedTotal: Math.round(month.commission + whatsapp.total),
      },
      whatsappRates: (Object.keys(settings.rates) as WhatsappCategory[]).map(category => ({
        category,
        label: WHATSAPP_CATEGORY_LABEL[category],
        rate: Math.round(settings.rates[category] * (1 + settings.markupPercent / 100) * 10000) / 10000,
      })),
      meta: { pricingUrl: META_PRICING_URL, minWhatsappInvoice: settings.minInvoiceInr },
    })
  } catch (err: any) {
    return friendlyErrorResponse(err, 'creator/revenue-share GET')
  }
}