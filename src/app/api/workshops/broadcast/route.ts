/**
 * POST /api/workshops/broadcast   (WORKSHOP registrants only)
 *   { workshopId, message }
 * Sends one message to everyone with a CONFIRMED registration for the workshop:
 * on Telegram (if they linked their chat) and by email (if they gave one).
 * Course broadcasts keep using /api/broadcast.
 *
 * Auth: Bearer token of the workshop's creator.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { escapeHtml, sendLoggedEmail } from '@/lib/email'

export const maxDuration = 60

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const MAX_MESSAGE = 500
const MAX_RECIPIENTS = 400
const CHUNK = 5 // people at a time; with the pause below this stays under Telegram's limit

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function sendTelegram(chatId: string | number, text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return false
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Plain text on purpose: the creator's words are never read as formatting.
      body: JSON.stringify({ chat_id: chatId, text }),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function POST(req: NextRequest) {
  try {
    const token = (req.headers.get('authorization') || '').replace('Bearer ', '').trim()
    if (!token) return NextResponse.json({ error: 'Please log in again.' }, { status: 401 })
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token)
    if (authErr || !user) return NextResponse.json({ error: 'Please log in again.' }, { status: 401 })

    const body = await req.json().catch(() => ({}))
    const workshopId = typeof body?.workshopId === 'string' ? body.workshopId : ''
    const message = typeof body?.message === 'string' ? body.message.trim() : ''
    if (!workshopId) return NextResponse.json({ error: 'Choose a workshop.' }, { status: 400 })
    if (!message) return NextResponse.json({ error: 'Write a message first.' }, { status: 400 })
    if (message.length > MAX_MESSAGE) {
      return NextResponse.json({ error: `Keep your message under ${MAX_MESSAGE} characters.` }, { status: 400 })
    }

    const { data: workshop } = await supabase
      .from('workshops')
      .select('id, title')
      .eq('id', workshopId)
      .eq('creator_id', user.id)
      .maybeSingle()
    if (!workshop) return NextResponse.json({ error: 'Workshop not found.' }, { status: 404 })

    const { data: people, error } = await supabase
      .from('workshop_registrations')
      .select('id, name, email, telegram_chat_id')
      .eq('workshop_id', workshop.id)
      .eq('payment_status', 'confirmed')
      .is('refunded_at', null)
    if (error) {
      console.error('[workshop-broadcast] lookup failed', error.message)
      return NextResponse.json({ error: 'Could not load the people to message.' }, { status: 500 })
    }

    const reachable = (people || []).filter(p => p.telegram_chat_id || p.email)
    const unreachable = (people || []).length - reachable.length
    if (reachable.length === 0) {
      return NextResponse.json({ error: 'No one in this workshop has Telegram or an email yet.' }, { status: 400 })
    }
    if (reachable.length > MAX_RECIPIENTS) {
      return NextResponse.json({ error: `This workshop has more than ${MAX_RECIPIENTS} people. Please contact support to send to a large group.` }, { status: 400 })
    }

    const telegramText = `📣 ${workshop.title}\n\n${message}`
    const emailHtml = (name: string) => `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1f2937;line-height:1.6">
        <p>Hi ${escapeHtml(name)},</p>
        <p style="white-space:pre-wrap">${escapeHtml(message)}</p>
        <p style="color:#6b7280;font-size:13px">About: ${escapeHtml(workshop.title)}</p>
      </div>`

    let telegram = 0
    let email = 0
    let failed = 0

    for (let i = 0; i < reachable.length; i += CHUNK) {
      const group = reachable.slice(i, i + CHUNK)
      await Promise.all(group.map(async p => {
        const [t, e] = await Promise.all([
          p.telegram_chat_id ? sendTelegram(p.telegram_chat_id, telegramText) : Promise.resolve(null),
          p.email
            ? sendLoggedEmail({
                supabase,
                creatorId: user.id,
                emailType: 'workshop_broadcast',
                to: p.email,
                subject: `Update: ${workshop.title}`,
                html: emailHtml(p.name),
                metadata: { workshop_id: workshop.id, workshop_registration_id: p.id },
              }).then(r => !!r.sent)
            : Promise.resolve(null),
        ])
        if (t) telegram++
        if (e) email++
        // Someone counts as failed only if every way we tried to reach them failed.
        if ((t === false || t === null) && (e === false || e === null)) failed++
      }))
      await sleep(250)
    }

    return NextResponse.json({ total: reachable.length, telegram, email, failed, unreachable })
  } catch (err: any) {
    console.error('[workshop-broadcast] POST', err?.message)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}