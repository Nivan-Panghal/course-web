/**
 * /api/whatsapp/connection        (the creator's own WhatsApp number)
 *   GET              -> the connection's status. ?recheck=1 re-tests it with Meta and clears a recorded problem
 *                       if the number is healthy again.
 *   POST {action:'setup'}  -> asks the bot to copy Kurso's approved templates into the creator's account again
 *   DELETE           -> disconnects (the creator keeps their number; Kurso goes back to sending from its own)
 *
 * Auth: Bearer token of the creator. The access token is never returned.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { decryptWhatsappSecret } from '@/lib/whatsapp-token-crypto'
import { graph, publicView, refreshConnection, requestTemplateSetup, type ConnectionRow } from '@/lib/whatsapp-connection'

export const maxDuration = 30

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

async function rowFor(creatorId: string): Promise<ConnectionRow | null> {
  const { data } = await supabase.from('whatsapp_connections').select('*').eq('creator_id', creatorId).maybeSingle()
  return (data as ConnectionRow | null) || null
}

export async function GET(req: NextRequest) {
  try {
    const user = await creatorFrom(req)
    if (!user) return NextResponse.json({ error: 'Please log in again.' }, { status: 401 })
    let row = await rowFor(user.id)
    if (row) row = await refreshConnection(supabase, row, { recheck: req.nextUrl.searchParams.get('recheck') === '1' })
    return NextResponse.json({
      ...publicView(row),
      available: Boolean(process.env.WHATSAPP_TOKENS_KEY && (process.env.META_APP_ID || process.env.NEXT_PUBLIC_META_APP_ID) && process.env.META_APP_SECRET && process.env.NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID),
    })
  } catch (err: any) {
    console.error('[whatsapp-connection] GET', err?.message)
    return NextResponse.json({ error: 'Could not load your WhatsApp connection.' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await creatorFrom(req)
    if (!user) return NextResponse.json({ error: 'Please log in again.' }, { status: 401 })
    const body = await req.json().catch(() => ({}))
    if (body?.action !== 'setup') return NextResponse.json({ error: 'Unknown action.' }, { status: 400 })
    const row = await rowFor(user.id)
    if (!row) return NextResponse.json({ error: 'Connect your number first.' }, { status: 404 })
    const ok = await requestTemplateSetup(user.id)
    return ok
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ error: 'Could not reach the WhatsApp service. Please try again in a minute.' }, { status: 502 })
  } catch (err: any) {
    console.error('[whatsapp-connection] POST', err?.message)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const user = await creatorFrom(req)
    if (!user) return NextResponse.json({ error: 'Please log in again.' }, { status: 401 })
    const row = await rowFor(user.id)
    if (!row) return NextResponse.json({ ok: true })

    // Best effort: stop Kurso receiving this account's messages. The row is removed either way.
    try {
      const token = decryptWhatsappSecret(row.token_encrypted)
      await graph(`/${row.waba_id}/subscribed_apps`, token, { method: 'DELETE' })
    } catch (err: any) {
      console.warn('[whatsapp-connection] could not unsubscribe:', err?.message)
    }
    const { error } = await supabase.from('whatsapp_connections').delete().eq('creator_id', user.id)
    if (error) return NextResponse.json({ error: 'Could not disconnect. Please try again.' }, { status: 500 })
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    console.error('[whatsapp-connection] DELETE', err?.message)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
