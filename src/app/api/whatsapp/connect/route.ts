/**
 * POST /api/whatsapp/connect        (creator connects their OWN WhatsApp number)
 *   { code, phoneNumberId, wabaId }
 *
 * The creator finishes Meta's Embedded Signup popup in the browser. That gives the page:
 *   - a one-time `code`
 *   - the ids of the creator's WhatsApp account (wabaId) and number (phoneNumberId)
 * Here we:
 *   1. swap the code for the creator's access token
 *   2. check the token really owns that account and number (the ids from the browser are not trusted)
 *   3. register the number for the Cloud API with a random PIN
 *   4. save everything (token and PIN encrypted)
 *   5. subscribe Kurso's webhook to the account
 *   6. ask the WhatsApp bot to copy Kurso's approved templates into the account
 *
 * Auth: Bearer token of the creator.
 */
import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { createClient } from '@supabase/supabase-js'
import { encryptWhatsappSecret } from '@/lib/whatsapp-token-crypto'
import {
  exchangeSignupCode, fetchNumberInfo, graph, graphErrorText, mapNumberStatus, publicView,
  requestTemplateSetup, subscribeApp, type ConnectionRow,
} from '@/lib/whatsapp-connection'

export const maxDuration = 60

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const isId = (v: unknown): v is string => typeof v === 'string' && /^\d{5,30}$/.test(v)

export async function POST(req: NextRequest) {
  try {
    const bearer = (req.headers.get('authorization') || '').replace('Bearer ', '').trim()
    if (!bearer) return NextResponse.json({ error: 'Please log in again.' }, { status: 401 })
    const { data: { user }, error: authErr } = await supabase.auth.getUser(bearer)
    if (authErr || !user) return NextResponse.json({ error: 'Please log in again.' }, { status: 401 })

    const body = await req.json().catch(() => ({}))
    const code = typeof body?.code === 'string' ? body.code.trim() : ''
    const { phoneNumberId, wabaId } = body || {}
    if (!code || !isId(phoneNumberId) || !isId(wabaId)) {
      return NextResponse.json({ error: 'The sign-up did not finish. Please try again.' }, { status: 400 })
    }
    if (!process.env.WHATSAPP_TOKENS_KEY) {
      console.error('[whatsapp-connect] WHATSAPP_TOKENS_KEY is not set')
      return NextResponse.json({ error: 'Connecting your own number is not available yet.' }, { status: 503 })
    }

    // One number belongs to one creator.
    const { data: taken } = await supabase
      .from('whatsapp_connections')
      .select('creator_id')
      .eq('phone_number_id', phoneNumberId)
      .maybeSingle()
    if (taken && taken.creator_id !== user.id) {
      return NextResponse.json({ error: 'This number is already connected to another Kurso account.' }, { status: 409 })
    }

    // 1. code -> token
    const exchanged = await exchangeSignupCode(code)
    if (!exchanged.token) {
      console.error('[whatsapp-connect] code exchange failed:', exchanged.error)
      return NextResponse.json({ error: 'Meta did not accept the sign-up. Please try again.' }, { status: 400 })
    }
    const token = exchanged.token

    // 2. the token must really see this account and number
    const owned = await graph(`/${wabaId}/phone_numbers?fields=id`, token)
    const ids: string[] = Array.isArray(owned.json?.data) ? owned.json.data.map((n: any) => String(n.id)) : []
    if (!owned.ok || !ids.includes(phoneNumberId)) {
      console.error('[whatsapp-connect] ownership check failed:', owned.status, graphErrorText(owned))
      return NextResponse.json({ error: 'We could not confirm that number on your WhatsApp account. Please try again.' }, { status: 400 })
    }

    // 3. register for the Cloud API. If it is already registered Meta says so; the status check below decides.
    const pin = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
    const registered = await graph(`/${phoneNumberId}/register`, token, { method: 'POST', body: { messaging_product: 'whatsapp', pin } })
    if (!registered.ok) console.warn('[whatsapp-connect] register:', registered.status, graphErrorText(registered))

    const info = await fetchNumberInfo(phoneNumberId, token)
    const mapped = mapNumberStatus(info.ok ? info.json?.status : 'PENDING')

    // 4. save (a row saved here means the bot can already find this number when its first webhook arrives)
    const { data: saved, error: saveErr } = await supabase
      .from('whatsapp_connections')
      .upsert({
        creator_id: user.id,
        waba_id: wabaId,
        phone_number_id: phoneNumberId,
        display_phone_number: info.ok ? info.json?.display_phone_number ?? null : null,
        verified_name: info.ok ? info.json?.verified_name ?? null : null,
        status: mapped.status,
        last_error: mapped.error,
        last_error_at: mapped.error ? new Date().toISOString() : null,
        problem_notified_at: null,
        token_encrypted: encryptWhatsappSecret(token),
        pin_encrypted: registered.ok ? encryptWhatsappSecret(pin) : null,
        templates: {},
        connected_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'creator_id' })
      .select('*')
      .single()
    if (saveErr || !saved) {
      console.error('[whatsapp-connect] save failed:', saveErr?.message)
      return NextResponse.json({ error: 'We could not save your connection. Please try again.' }, { status: 500 })
    }

    // 5. webhook subscription
    let row = saved as ConnectionRow
    const sub = await subscribeApp(wabaId, token)
    if (!sub.ok) {
      console.error('[whatsapp-connect] subscribe failed:', sub.status, graphErrorText(sub))
      const { data } = await supabase
        .from('whatsapp_connections')
        .update({ status: 'problem', last_error: `Kurso could not subscribe to your WhatsApp account: ${graphErrorText(sub)}`, last_error_at: new Date().toISOString() })
        .eq('creator_id', user.id)
        .select('*')
        .maybeSingle()
      if (data) row = data as ConnectionRow
    }

    // 6. templates (the bot does this in the background)
    await requestTemplateSetup(user.id)

    return NextResponse.json(publicView(row))
  } catch (err: any) {
    console.error('[whatsapp-connect] POST', err?.message)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
