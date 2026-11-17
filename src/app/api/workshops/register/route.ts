// src/app/api/workshops/register/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { normalizePhone, isValidPhone } from '@/lib/phone'
import { friendlyErrorResponse } from '@/lib/payment-errors'
import { countHeldSpots, getWorkshopRegistrationState, registrationClosedMessage } from '@/lib/workshops'
import { notifyWorkshopConfirmed } from '@/lib/workshop-notify'
import { resolveReferralCodeId } from '@/lib/referrals'
import { scheduleWorkshopMetaEvent, getMetaRequestContext, leadEventId } from '@/lib/workshop-meta-events'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// POST — free registration, or the first step of a manual-UPI registration.
// (Online-gateway payments go through /api/workshops/checkout/create-order.)
export async function POST(req: NextRequest) {
  try {
    const { workshopId, name, email, phone: rawPhone, paymentMode, ref } = await req.json()

    if (!workshopId || !name || !rawPhone) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }
    if (!['free', 'upi_manual'].includes(paymentMode)) {
      return NextResponse.json({ error: 'Unsupported payment mode' }, { status: 400 })
    }

    const phone = normalizePhone(rawPhone)
    if (!isValidPhone(phone)) {
      return NextResponse.json({ error: 'Invalid phone number' }, { status: 400 })
    }

    const { data: workshop, error: workshopError } = await supabaseAdmin
      .from('workshops')
      .select('id, price, capacity, status, date_time, duration_minutes, registration_closes_at')
      .eq('id', workshopId)
      .maybeSingle()

    if (workshopError) throw workshopError
    if (!workshop || workshop.status !== 'published') {
      return NextResponse.json({ error: 'This workshop is not open for registration' }, { status: 404 })
    }
    const registrationState = getWorkshopRegistrationState(workshop)
    if (registrationState !== 'open') {
      console.warn('[workshop register] blocked, registration', registrationState, 'for workshop', workshopId)
      return NextResponse.json({ error: registrationClosedMessage(registrationState) }, { status: 409 })
    }
    if (paymentMode === 'free' && workshop.price > 0) {
      return NextResponse.json({ error: 'This workshop is not free' }, { status: 400 })
    }
    if (paymentMode === 'upi_manual' && workshop.price <= 0) {
      return NextResponse.json({ error: 'This workshop does not require payment' }, { status: 400 })
    }

    const { data: existing } = await supabaseAdmin
      .from('workshop_registrations')
      .select('id, payment_status, payment_mode, telegram_link_token, referred_by_code_id, refunded_at')
      .eq('workshop_id', workshopId)
      .eq('phone', phone)
      .maybeSingle()

    // A refunded attendee gave their seat back: never show them a false "you're registered".
    if (existing?.refunded_at) {
      return NextResponse.json({ error: 'This registration was refunded. Please contact the host if you would like to join again.' }, { status: 409 })
    }
    // Already confirmed — never re-insert or reset.
    if (existing?.payment_status === 'confirmed') {
      return NextResponse.json({
        registrationId: existing.id,
        paymentStatus: 'confirmed',
        alreadyRegistered: true,
      })
    }

    // Capacity: check for brand-new rows, and for an existing row that was an
    // online-checkout attempt (its hold may have expired and been given away).
    if (workshop.capacity != null && (!existing || existing.payment_mode === 'gateway')) {
      const held = await countHeldSpots(supabaseAdmin, workshopId, existing?.id)
      if (held >= workshop.capacity) {
        return NextResponse.json({ error: 'This workshop is fully booked' }, { status: 409 })
      }
    }

    // Referral attribution (?ref= on the workshop link). Invalid/self codes resolve to null.
    const referredByCodeId = await resolveReferralCodeId(supabaseAdmin, workshopId, ref, phone)

    const paymentStatus = paymentMode === 'free' ? 'confirmed' : 'pending_confirmation'
    let registrationId: string
    let telegramToken: string | undefined

    if (existing) {
      const { error: updateError } = await supabaseAdmin
        .from('workshop_registrations')
        .update({
          name,
          email: email || null,
          payment_mode: paymentMode,
          payment_status: paymentStatus,
          payment_attempted_at: null,
          // First referrer wins — a later link never overwrites an earlier one.
          ...(referredByCodeId && !existing.referred_by_code_id ? { referred_by_code_id: referredByCodeId } : {}),
        })
        .eq('id', existing.id)
      if (updateError) throw updateError
      registrationId = existing.id
      telegramToken = undefined // never hand a stored token to whoever knows the phone number
    } else {
      const { data: inserted, error: insertError } = await supabaseAdmin
        .from('workshop_registrations')
        .insert({
          workshop_id: workshopId,
          name,
          email: email || null,
          phone,
          payment_mode: paymentMode,
          payment_status: paymentStatus,
          referred_by_code_id: referredByCodeId,
        })
        .select('id, telegram_link_token')
        .single()
      if (insertError) throw insertError
      registrationId = inserted.id
      telegramToken = inserted.telegram_link_token
    }

    if (paymentStatus === 'confirmed') {
      await supabaseAdmin
        .from('workshop_registrations')
        .update({ confirmed_at: new Date().toISOString() })
        .eq('id', registrationId)
      await notifyWorkshopConfirmed(registrationId)
    }

    // Meta Lead (server side). Runs after the response is sent — a Meta problem can never block a registration.
    scheduleWorkshopMetaEvent({ registrationId, eventName: 'Lead', context: getMetaRequestContext(req) })

    return NextResponse.json({ registrationId, paymentStatus, telegramToken, metaLeadEventId: leadEventId(registrationId) })
  } catch (err: any) {
    return friendlyErrorResponse(err, 'workshops/register POST')
  }
}

// PATCH — student submits their UPI UTR after paying manually.
export async function PATCH(req: NextRequest) {
  try {
    const { registrationId, utrReference } = await req.json()
    if (!registrationId || !utrReference) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    const { data: registration, error: fetchError } = await supabaseAdmin
      .from('workshop_registrations')
      .select('id, payment_status')
      .eq('id', registrationId)
      .maybeSingle()
    if (fetchError) throw fetchError
    if (!registration) {
      return NextResponse.json({ error: 'Registration not found' }, { status: 404 })
    }
    if (registration.payment_status === 'confirmed') {
      return NextResponse.json({ ok: true, paymentStatus: 'confirmed' })
    }

    const { error: updateError } = await supabaseAdmin
      .from('workshop_registrations')
      .update({ utr_reference: String(utrReference).trim() })
      .eq('id', registrationId)
    if (updateError) throw updateError

    return NextResponse.json({ ok: true, paymentStatus: 'pending_confirmation' })
  } catch (err: any) {
    return friendlyErrorResponse(err, 'workshops/register PATCH')
  }
}