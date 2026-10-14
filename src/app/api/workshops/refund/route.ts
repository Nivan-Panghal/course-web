/**
 * /api/workshops/refund   (PUBLIC, token based: the student's refund page)
 *   GET  ?token=...            → what the page needs to show
 *   POST { token, reason? }    → ask for a refund
 * The token is the private review_token on the student's registration.
 * Workshop refunds only; course refunds use the course flow.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { MAX_REFUND_REASON, checkWorkshopRefundEligibility } from '@/lib/workshop-refund'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const bad = () => NextResponse.json({ error: 'This refund link is not valid.' }, { status: 404 })

async function lookup(token: unknown) {
  if (typeof token !== 'string' || !UUID.test(token)) return null
  const { data: reg, error } = await supabase
    .from('workshop_registrations')
    .select('id, workshop_id, name, payment_status, payment_mode, amount_paid, refunded_at, transaction_id')
    .eq('review_token', token)
    .maybeSingle()
  if (error || !reg) return null
  const { data: workshop } = await supabase
    .from('workshops')
    .select('id, creator_id, title, date_time, price, host_name, brand_name')
    .eq('id', reg.workshop_id)
    .maybeSingle()
  if (!workshop) return null
  const { data: existing } = await supabase
    .from('refund_requests')
    .select('id, status, decision_note, requested_at')
    .eq('workshop_registration_id', reg.id)
    .eq('type', 'workshop')
    .order('requested_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return { reg, workshop, existing }
}

export async function GET(req: NextRequest) {
  try {
    const found = await lookup(req.nextUrl.searchParams.get('token'))
    if (!found) return bad()
    const { reg, workshop, existing } = found
    const check = checkWorkshopRefundEligibility(reg, workshop)
    return NextResponse.json({
      workshopTitle: workshop.title,
      hostName: workshop.brand_name || workshop.host_name || '',
      firstName: String(reg.name || '').trim().split(/\s+/)[0] || '',
      amount: check.amount,
      isGateway: check.isGateway,
      deadline: check.deadline,
      canRequest: check.eligible && !existing,
      reason: existing ? null : check.reason,
      request: existing ? { status: existing.status, note: existing.decision_note || '', requestedAt: existing.requested_at } : null,
    })
  } catch (err: any) {
    console.error('[workshop-refund] GET', err?.message)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const found = await lookup(body?.token)
    if (!found) return bad()
    const { reg, workshop, existing } = found
    if (existing) return NextResponse.json({ error: 'You have already asked for a refund for this workshop.' }, { status: 409 })
    const check = checkWorkshopRefundEligibility(reg, workshop)
    if (!check.eligible) return NextResponse.json({ error: check.reason }, { status: 403 })

    const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
    if (reason.length > MAX_REFUND_REASON) {
      return NextResponse.json({ error: `Please keep your reason under ${MAX_REFUND_REASON} characters.` }, { status: 400 })
    }

    const { error } = await supabase.from('refund_requests').insert({
      type: 'workshop',
      creator_id: workshop.creator_id,
      workshop_registration_id: reg.id,
      purchase_id: reg.transaction_id || null,
      requested_by: 'student',
      reason: reason || null,
      status: 'pending',
    })
    if (error) {
      if (error.code === '23505') return NextResponse.json({ error: 'You have already asked for a refund for this workshop.' }, { status: 409 })
      console.error('[workshop-refund] insert failed', error.message)
      return NextResponse.json({ error: 'Could not send your request. Please try again.' }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    console.error('[workshop-refund] POST', err?.message)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}