/**
 * POST /api/internal/whatsapp-connection-problem        (called by the WhatsApp bot only)
 *   { creatorId, message }
 *
 * The bot calls this when a creator's own WhatsApp number stops working (for example Meta
 * rejects it for an unpaid balance). It emails the creator, at most once a day.
 * Auth: the shared INTERNAL_BOT_SECRET.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { escapeHtml, sendLoggedEmail } from '@/lib/email'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const ONE_DAY_MS = 24 * 60 * 60 * 1000
const SITE = () => (process.env.NEXT_PUBLIC_SITE_URL || 'https://kurso.in').replace(/\/$/, '')

export async function POST(req: NextRequest) {
  const secret = process.env.INTERNAL_BOT_SECRET
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const body = await req.json().catch(() => ({}))
    const creatorId = typeof body?.creatorId === 'string' ? body.creatorId : ''
    const message = typeof body?.message === 'string' ? body.message.slice(0, 500) : ''
    if (!creatorId) return NextResponse.json({ error: 'creatorId is required' }, { status: 400 })

    const { data: conn } = await supabase
      .from('whatsapp_connections')
      .select('creator_id, display_phone_number, problem_notified_at')
      .eq('creator_id', creatorId)
      .maybeSingle()
    if (!conn) return NextResponse.json({ ok: true, emailed: false })
    if (conn.problem_notified_at && Date.now() - new Date(conn.problem_notified_at).getTime() < ONE_DAY_MS) {
      return NextResponse.json({ ok: true, emailed: false })
    }

    const { data: authData } = await supabase.auth.admin.getUserById(creatorId)
    const to = authData?.user?.email || null
    if (!to) return NextResponse.json({ ok: true, emailed: false })

    const result = await sendLoggedEmail({
      supabase,
      emailType: 'whatsapp_number_problem',
      to,
      creatorId,
      subject: 'Your WhatsApp number needs attention',
      html: `
        <div style="font-family:Inter,Arial,sans-serif;line-height:1.5;color:#111;max-width:520px">
          <h2 style="margin:0 0 12px">Your WhatsApp number stopped working</h2>
          <p style="margin:0 0 12px">Kurso could not send a message from your own WhatsApp number${conn.display_phone_number ? ` (${escapeHtml(conn.display_phone_number)})` : ''}.</p>
          ${message ? `<p style="margin:0 0 12px"><strong>Meta said:</strong> ${escapeHtml(message)}</p>` : ''}
          <p style="margin:0 0 12px">Your students are not left without messages: Kurso is sending through its own number until you fix this. Those messages are billed on your Kurso invoice at Meta's rate, as before.</p>
          <p style="margin:0 0 16px">The most common cause is a missing or failed payment method on your WhatsApp account in Meta Business Suite.</p>
          <p style="margin:0"><a href="${SITE()}/dashboard/whatsapp" style="display:inline-block;background:#f79514;color:#fff;padding:10px 16px;border-radius:10px;text-decoration:none">Open WhatsApp settings</a></p>
        </div>`,
      metadata: { phone_number: conn.display_phone_number },
    })

    if (result.sent) {
      await supabase.from('whatsapp_connections').update({ problem_notified_at: new Date().toISOString() }).eq('creator_id', creatorId)
    }
    return NextResponse.json({ ok: true, emailed: !!result.sent })
  } catch (err: any) {
    console.error('[whatsapp-connection-problem] POST', err?.message)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
