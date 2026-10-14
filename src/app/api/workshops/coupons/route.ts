/**
 * /api/workshops/coupons   (WORKSHOP coupons, creator side)
 *   GET                                       → this creator's coupons
 *   POST   { code, workshopId|null, percent, usageLimit|null, expiresOn|null }   → create
 *   PATCH  { id, isActive }                   → pause / resume
 *   DELETE { id }                             → delete (a coupon already used is paused instead)
 * Auth: Bearer token of the creator. Course coupons live in the courses area.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { COUPON_CODE_PATTERN, MAX_PERCENT, MIN_PERCENT, endOfDayIst, normalizeCouponCode } from '@/lib/workshop-coupons'

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

const setup = (message: string) =>
  /workshop_coupons/.test(message)
    ? NextResponse.json({ error: 'setup_needed' }, { status: 409 })
    : NextResponse.json({ error: 'Could not load coupons.' }, { status: 500 })

export async function GET(req: NextRequest) {
  try {
    const user = await creatorFrom(req)
    if (!user) return NextResponse.json({ error: 'Please log in again.' }, { status: 401 })
    const [{ data: coupons, error }, { data: workshops }] = await Promise.all([
      supabase.from('workshop_coupons')
        .select('id, workshop_id, code, discount_value, usage_limit, times_used, starts_at, expires_at, is_active, created_at')
        .eq('creator_id', user.id).order('created_at', { ascending: false }),
      supabase.from('workshops').select('id, title, date_time, status').eq('creator_id', user.id).order('date_time', { ascending: false }),
    ])
    if (error) return setup(error.message)
    return NextResponse.json({
      coupons: (coupons || []).map(c => ({
        id: c.id, workshopId: c.workshop_id, code: c.code, percent: c.discount_value,
        usageLimit: c.usage_limit, timesUsed: c.times_used, expiresAt: c.expires_at, isActive: c.is_active,
      })),
      workshops: (workshops || []).map(w => ({ id: w.id, title: w.title, dateTime: w.date_time, status: w.status })),
    })
  } catch (err: any) {
    console.error('[workshop-coupons] GET', err?.message)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await creatorFrom(req)
    if (!user) return NextResponse.json({ error: 'Please log in again.' }, { status: 401 })
    const body = await req.json().catch(() => ({}))

    const code = normalizeCouponCode(body?.code)
    if (!COUPON_CODE_PATTERN.test(code)) {
      return NextResponse.json({ error: 'Use 3 to 20 letters, numbers, - or _ for the code (for example EARLY20).' }, { status: 400 })
    }
    const percent = Number(body?.percent)
    if (!Number.isInteger(percent) || percent < MIN_PERCENT || percent > MAX_PERCENT) {
      return NextResponse.json({ error: `Discount must be a whole number from ${MIN_PERCENT} to ${MAX_PERCENT}%.` }, { status: 400 })
    }
    let usageLimit: number | null = null
    if (body?.usageLimit !== null && body?.usageLimit !== undefined && body?.usageLimit !== '') {
      usageLimit = Number(body.usageLimit)
      if (!Number.isInteger(usageLimit) || usageLimit < 1 || usageLimit > 100000) {
        return NextResponse.json({ error: 'Usage limit must be a whole number of 1 or more, or left empty for no limit.' }, { status: 400 })
      }
    }
    let expiresAt: string | null = null
    if (body?.expiresOn) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.expiresOn))) return NextResponse.json({ error: 'Pick a valid expiry date.' }, { status: 400 })
      expiresAt = endOfDayIst(String(body.expiresOn))
      if (new Date(expiresAt).getTime() <= Date.now()) return NextResponse.json({ error: 'The expiry date must be today or later.' }, { status: 400 })
    }

    let workshopId: string | null = null
    if (body?.workshopId) {
      const { data: owns } = await supabase.from('workshops').select('id').eq('id', body.workshopId).eq('creator_id', user.id).maybeSingle()
      if (!owns) return NextResponse.json({ error: 'Workshop not found.' }, { status: 404 })
      workshopId = owns.id
    }

    const { error } = await supabase.from('workshop_coupons').insert({
      creator_id: user.id, workshop_id: workshopId, code, discount_type: 'percentage',
      discount_value: percent, usage_limit: usageLimit, expires_at: expiresAt,
    })
    if (error) {
      if (error.code === '23505') return NextResponse.json({ error: `You already have a coupon called ${code}.` }, { status: 409 })
      console.error('[workshop-coupons] create failed', error.message)
      return setup(error.message)
    }
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    console.error('[workshop-coupons] POST', err?.message)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const user = await creatorFrom(req)
    if (!user) return NextResponse.json({ error: 'Please log in again.' }, { status: 401 })
    const body = await req.json().catch(() => ({}))
    if (typeof body?.id !== 'string' || typeof body?.isActive !== 'boolean') return NextResponse.json({ error: 'Missing fields.' }, { status: 400 })
    const { data, error } = await supabase.from('workshop_coupons')
      .update({ is_active: body.isActive, updated_at: new Date().toISOString() })
      .eq('id', body.id).eq('creator_id', user.id).select('id').maybeSingle()
    if (error) return NextResponse.json({ error: 'Could not update this coupon.' }, { status: 500 })
    if (!data) return NextResponse.json({ error: 'Coupon not found.' }, { status: 404 })
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    console.error('[workshop-coupons] PATCH', err?.message)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const user = await creatorFrom(req)
    if (!user) return NextResponse.json({ error: 'Please log in again.' }, { status: 401 })
    const body = await req.json().catch(() => ({}))
    if (typeof body?.id !== 'string') return NextResponse.json({ error: 'Missing coupon.' }, { status: 400 })
    const { data: coupon } = await supabase.from('workshop_coupons').select('id, times_used').eq('id', body.id).eq('creator_id', user.id).maybeSingle()
    if (!coupon) return NextResponse.json({ error: 'Coupon not found.' }, { status: 404 })
    if (coupon.times_used > 0) {
      // Keep the record so past payments still show which coupon they used.
      await supabase.from('workshop_coupons').update({ is_active: false, updated_at: new Date().toISOString() }).eq('id', coupon.id)
      return NextResponse.json({ ok: true, paused: true })
    }
    const { error } = await supabase.from('workshop_coupons').delete().eq('id', coupon.id)
    if (error) return NextResponse.json({ error: 'Could not delete this coupon.' }, { status: 500 })
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    console.error('[workshop-coupons] DELETE', err?.message)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}