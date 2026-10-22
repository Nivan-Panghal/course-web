// src/app/api/workshops/checkout/create-order/route.ts
// Mirrors /api/checkout/create-ebook-order. The webhook finishes the job
// (see handleFlowAWorkshop in api/webhooks/[provider]/route.ts).
import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { createClient } from '@supabase/supabase-js'
import { getCreatorCheckoutGateway, createCheckoutOrder, CheckoutOrderError } from '@/lib/gateway-checkout'
import { friendlyErrorResponse } from '@/lib/payment-errors'
import { normalizePhone } from '@/lib/phone'
import { GATEWAY_HOLD_MINUTES, countHeldSpots, getWorkshopRegistrationState, registrationClosedMessage } from '@/lib/workshops'
import { resolveReferralCodeId } from '@/lib/referrals'
import { scheduleWorkshopMetaEvent, getMetaRequestContext, leadEventId } from '@/lib/workshop-meta-events'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(req: NextRequest) {
  try {
    const { workshopId, name, email, phone: rawPhone, ref, couponCode } = await req.json()

    if (!workshopId || !name?.trim() || !rawPhone) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }
    if (!email?.trim()) {
      return NextResponse.json({ error: 'Email is required for online payment.' }, { status: 400 })
    }
    const phone = normalizePhone(rawPhone)
    if (!phone) {
      return NextResponse.json({ error: 'Invalid phone number' }, { status: 400 })
    }

    const { data: workshop, error: workshopError } = await supabase
      .from('workshops')
      .select('id, title, slug, price, capacity, status, creator_id, date_time, duration_minutes, registration_closes_at')
      .eq('id', workshopId)
      .maybeSingle()
    if (workshopError) throw workshopError
    if (!workshop || workshop.status !== 'published') {
      return NextResponse.json({ error: 'This workshop is not open for registration' }, { status: 404 })
    }
    const registrationState = getWorkshopRegistrationState(workshop)
    if (registrationState !== 'open') {
      console.warn('[workshop create-order] blocked, registration', registrationState, 'for workshop', workshopId)
      return NextResponse.json({ error: registrationClosedMessage(registrationState) }, { status: 409 })
    }

    const listedPrice = Number(workshop.price)
    if (!Number.isFinite(listedPrice) || listedPrice <= 0) {
      return NextResponse.json({ error: 'This workshop does not require payment' }, { status: 400 })
    }
    if (listedPrice > 100000) {
      return NextResponse.json(
        { error: 'This amount exceeds what the payment gateway supports (₹1,00,000 max). Please contact the creator.' },
        { status: 400 }
      )
    }

    // Coupon (online checkout only). The price is always worked out here on the
    // server; the figure the page showed is never trusted.
    let amount = listedPrice
    let discountAmount = 0
    let couponId: string | null = null
    let appliedCouponCode: string | null = null
    const normalizedCoupon = String(couponCode || '').trim()
    if (normalizedCoupon) {
      const { data: couponRows, error: couponError } = await supabase.rpc('validate_coupon_for_workshop', {
        input_workshop_id: workshopId,
        input_coupon_code: normalizedCoupon,
      })
      if (couponError) throw couponError
      const coupon = couponRows?.[0]
      if (!coupon?.valid) {
        return NextResponse.json({ error: coupon?.reason || 'Invalid coupon code' }, { status: 400 })
      }
      amount = Number(coupon.final_amount)
      discountAmount = Number(coupon.discount_amount)
      couponId = coupon.coupon_id
      appliedCouponCode = coupon.coupon_code
      if (!Number.isFinite(amount) || amount <= 0) {
        return NextResponse.json({ error: 'This coupon cannot be used on this workshop.' }, { status: 400 })
      }
    }

    const { data: creator } = await supabase
      .from('creators')
      .select('creator_slug')
      .eq('id', workshop.creator_id)
      .maybeSingle()
    if (!creator?.creator_slug) {
      return NextResponse.json({ error: 'Workshop not found' }, { status: 404 })
    }

    const gateway = await getCreatorCheckoutGateway(workshop.creator_id)
    if (!gateway) {
      return NextResponse.json(
        { error: "This creator hasn't finished setting up online payments yet. Please try paying via UPI or contact them directly." },
        { status: 409 }
      )
    }

    // Existing registration for this phone?
    const { data: existing } = await supabase
      .from('workshop_registrations')
      .select('id, payment_status, telegram_link_token, referred_by_code_id')
      .eq('workshop_id', workshopId)
      .eq('phone', phone)
      .maybeSingle()

    if (existing?.payment_status === 'confirmed') {
      return NextResponse.json({
        alreadyRegistered: true,
        registrationId: existing.id,
        telegramToken: existing.telegram_link_token,
      })
    }

    // Capacity — a retrying registrant isn't counted against themselves.
    if (workshop.capacity != null) {
      const held = await countHeldSpots(supabase, workshopId, existing?.id)
      if (held >= workshop.capacity) {
        return NextResponse.json({ error: 'This workshop is fully booked' }, { status: 409 })
      }
    }

    // Referral attribution (?ref= on the workshop link). Invalid/self codes resolve to null.
    const referredByCodeId = await resolveReferralCodeId(supabase, workshopId, ref, phone)

    const now = new Date().toISOString()
    let registrationId: string
    let telegramToken: string

    if (existing) {
      const { error: updateError } = await supabase
        .from('workshop_registrations')
        .update({
          name: name.trim(),
          email: email.trim(),
          payment_mode: 'gateway',
          payment_status: 'pending_confirmation',
          payment_attempted_at: now,
          // First referrer wins — a later link never overwrites an earlier one.
          ...(referredByCodeId && !existing.referred_by_code_id ? { referred_by_code_id: referredByCodeId } : {}),
        })
        .eq('id', existing.id)
      if (updateError) throw updateError
      registrationId = existing.id
      telegramToken = existing.telegram_link_token
    } else {
      const { data: inserted, error: insertError } = await supabase
        .from('workshop_registrations')
        .insert({
          workshop_id: workshopId,
          name: name.trim(),
          email: email.trim(),
          phone,
          payment_mode: 'gateway',
          payment_status: 'pending_confirmation',
          payment_attempted_at: now,
          referred_by_code_id: referredByCodeId,
        })
        .select('id, telegram_link_token')
        .single()
      if (insertError) throw insertError
      registrationId = inserted.id
      telegramToken = inserted.telegram_link_token
    }

    const transactionId = randomUUID()
    const { error: txnError } = await supabase.from('transactions').insert({
      id: transactionId,
      client_txn_id: transactionId,
      workshop_id: workshopId,
      workshop_registration_id: registrationId,
      product_type: 'workshop',
      creator_id: workshop.creator_id,
      student_name: name.trim(),
      student_email: email.trim(),
      student_phone: phone,
      amount,
      original_amount: listedPrice,
      discount_amount: discountAmount,
      // Only written when a coupon is used, so checkouts without one never touch the new column.
      ...(couponId ? { coupon_code: appliedCouponCode, workshop_coupon_id: couponId } : {}),
      status: 'pending',
      payment_provider: gateway.provider,
    })
    if (txnError) throw txnError

    // A limited coupon is held for the person checking out. If someone who started
    // earlier is still paying for the last use, this checkout does not get the coupon.
    if (couponId) {
      const { data: claimed, error: claimError } = await supabase.rpc('claim_workshop_coupon_use', {
        input_coupon_id: couponId,
        input_transaction_id: transactionId,
        hold_minutes: GATEWAY_HOLD_MINUTES,
      })
      if (claimError || claimed !== true) {
        await supabase
          .from('transactions')
          .update({ status: 'failed', error_message: claimError ? 'Coupon check failed' : 'Coupon limit reached' })
          .eq('id', transactionId)
        // Release the spot hold: no checkout is actually open.
        await supabase.from('workshop_registrations').update({ payment_attempted_at: null }).eq('id', registrationId)
        if (claimError) console.error('[workshop-create-order] coupon claim failed', claimError.message)
        return NextResponse.json(
          {
            error: claimError
              ? 'We could not apply the coupon right now. Remove it to pay the full price, or try again in a moment.'
              : 'This coupon was just used by someone else, so it is no longer available. Remove it to pay the full price.',
          },
          { status: 409 }
        )
      }
    }

    try {
      const order = await createCheckoutOrder({
        gateway,
        transactionId,
        amount,
        description: workshop.title,
        customerName: name.trim(),
        customerEmail: email.trim(),
        customerPhone: phone,
        returnUrl: `${process.env.NEXT_PUBLIC_SITE_URL}/w/${creator.creator_slug}/${workshop.slug}?order_id=${transactionId}&tg=${telegramToken}`,
      })

      // Stripe has no orderId — it's correlated by client_reference_id
      // (= our transactionId) in the webhook.
      const gatewayOrderId = 'orderId' in order ? order.orderId : null
      await supabase.from('transactions').update({ gateway_order_id: gatewayOrderId }).eq('id', transactionId)
      await supabase.from('workshop_registrations').update({ transaction_id: transactionId }).eq('id', registrationId)

      // Meta Lead (server side) — the registration exists as soon as checkout starts.
      scheduleWorkshopMetaEvent({ registrationId, eventName: 'Lead', context: getMetaRequestContext(req) })

      return NextResponse.json({ clientTxnId: transactionId, registrationId, telegramToken, order, metaLeadEventId: leadEventId(registrationId) })
    } catch (err: any) {
      await supabase
        .from('transactions')
        .update({ status: 'failed', error_message: err?.message || 'Order creation failed' })
        .eq('id', transactionId)
      // Release the spot hold — no checkout is actually open.
      await supabase.from('workshop_registrations').update({ payment_attempted_at: null }).eq('id', registrationId)
      const msg = err instanceof CheckoutOrderError
        ? err.message
        : 'Could not start the payment. Please try again in a moment.'
      return NextResponse.json({ error: msg }, { status: 502 })
    }
  } catch (err: any) {
    return friendlyErrorResponse(err, 'workshops/checkout/create-order')
  }
}