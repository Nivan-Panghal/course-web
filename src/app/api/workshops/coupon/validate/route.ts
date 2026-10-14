/**
 * POST /api/workshops/coupon/validate   (PUBLIC)   { workshopId, code }
 * Used by the registration form to show the discounted price before paying.
 * Read only: nothing is counted until a payment is confirmed.
 * The real price is always worked out again on the server at checkout.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { normalizeCouponCode } from '@/lib/workshop-coupons'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(req: NextRequest) {
  try {
    const { workshopId, code } = await req.json().catch(() => ({}))
    const normalized = normalizeCouponCode(code)
    if (typeof workshopId !== 'string' || !workshopId) return NextResponse.json({ valid: false, reason: 'Workshop is missing.' }, { status: 400 })
    if (!normalized) return NextResponse.json({ valid: false, reason: 'Enter a coupon code.' }, { status: 400 })

    const { data, error } = await supabase.rpc('validate_coupon_for_workshop', {
      input_workshop_id: workshopId,
      input_coupon_code: normalized,
    })
    if (error) {
      console.error('[workshop coupon validate]', error.message)
      return NextResponse.json({ valid: false, reason: 'Could not check this coupon. Please try again.' }, { status: 500 })
    }
    const row = data?.[0]
    if (!row?.valid) return NextResponse.json({ valid: false, reason: row?.reason || 'Invalid coupon code' })
    return NextResponse.json({
      valid: true,
      code: row.coupon_code,
      percent: Number(row.discount_value),
      originalAmount: Number(row.original_amount),
      discountAmount: Number(row.discount_amount),
      finalAmount: Number(row.final_amount),
    })
  } catch (err: any) {
    console.error('[workshop coupon validate]', err?.message)
    return NextResponse.json({ valid: false, reason: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}