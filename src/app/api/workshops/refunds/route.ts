/**
 * /api/workshops/refunds   (WORKSHOP refund requests, creator side)
 *   GET                                                       → this creator's workshop refund requests
 *   POST { requestId, decision: 'approved'|'denied', note?, amount?, manual? }
 * Online (gateway) payments are refunded through the creator's own gateway.
 * UPI payments cannot be, so the creator refunds the student and sends manual: true.
 * Auth: Bearer token of the creator. Course refunds use /api/creator/refund-requests.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { amountPaidFor, decideWorkshopRefundRequest } from '@/lib/workshop-refund'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function creatorFrom(req: NextRequest) {
  const token = (req.headers.get('authorization') || '').replace('Bearer ', '').trim()
  if (!token) return null
  const { data: { user }, error } = await supabase.auth.getUser(token)
  return error || !user ? null : user
}

export async function GET(req: NextRequest) {
  try {
    const user = await creatorFrom(req)
    if (!user) return NextResponse.json({ error: 'Please log in again.' }, { status: 401 })

    const { data: requests, error } = await supabase
      .from('refund_requests')
      .select('id, status, reason, decision_note, requested_at, completed_at, workshop_registration_id')
      .eq('creator_id', user.id)
      .eq('type', 'workshop')
      .order('requested_at', { ascending: false })
    if (error) {
      console.error('[workshop-refunds] list failed', error.message)
      return NextResponse.json({ error: /workshop_registration_id|type/.test(error.message) ? 'setup_needed' : 'Could not load refund requests.' }, { status: /workshop_registration_id/.test(error.message) ? 409 : 500 })
    }
    if (!requests || requests.length === 0) return NextResponse.json({ requests: [] })

    const regIds = [...new Set(requests.map(r => r.workshop_registration_id).filter(Boolean))] as string[]
    const { data: regs } = await supabase
      .from('workshop_registrations')
      .select('id, workshop_id, name, phone, email, payment_status, payment_mode, amount_paid')
      .in('id', regIds)
    const workshopIds = [...new Set((regs || []).map(r => r.workshop_id))]
    const { data: workshops } = await supabase.from('workshops').select('id, title, price').in('id', workshopIds)
    const { data: payments } = await supabase
      .from('payments').select('workshop_registration_id').in('workshop_registration_id', regIds).eq('status', 'paid')

    const regOf = new Map((regs || []).map(r => [r.id, r]))
    const workshopOf = new Map((workshops || []).map(w => [w.id, w]))
    const hasPayment = new Set((payments || []).map(p => p.workshop_registration_id))

    return NextResponse.json({
      requests: requests.map(r => {
        const reg = regOf.get(r.workshop_registration_id)
        const w = reg ? workshopOf.get(reg.workshop_id) : null
        const isGateway = reg?.payment_mode === 'gateway'
        return {
          id: r.id,
          status: r.status,
          reason: r.reason || '',
          note: r.decision_note || '',
          requestedAt: r.requested_at,
          completedAt: r.completed_at,
          workshopTitle: w?.title || 'Workshop',
          name: reg?.name || 'Attendee',
          phone: reg?.phone || '',
          email: reg?.email || '',
          amount: reg && w ? amountPaidFor(reg, Number(w.price)) : 0,
          isGateway,
          canAutoRefund: isGateway && hasPayment.has(r.workshop_registration_id),
        }
      }),
    })
  } catch (err: any) {
    console.error('[workshop-refunds] GET', err?.message)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await creatorFrom(req)
    if (!user) return NextResponse.json({ error: 'Please log in again.' }, { status: 401 })
    const body = await req.json().catch(() => ({}))
    if (typeof body?.requestId !== 'string' || !['approved', 'denied'].includes(body?.decision)) {
      return NextResponse.json({ error: 'Missing or invalid fields.' }, { status: 400 })
    }
    const result = await decideWorkshopRefundRequest(supabase, {
      requestId: body.requestId,
      creatorId: user.id,
      decision: body.decision,
      note: typeof body.note === 'string' ? body.note : '',
      amount: body.amount === undefined || body.amount === null || body.amount === '' ? undefined : Number(body.amount),
      manual: body.manual === true,
    })
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json({ success: true, message: result.message })
  } catch (err: any) {
    console.error('[workshop-refunds] POST', err?.message)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}