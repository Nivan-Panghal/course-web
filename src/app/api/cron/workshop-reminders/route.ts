/**
 * Same Vercel-Hobby-tier constraint as live-session-reminders: this cron
 * runs once a day, so it can't hit a precise "24 hours before" — it uses a
 * 24–48h wide window instead. The precise 1h-before reminder is NOT handled
 * here; it's handled by Whatsapp-bot's own pollWorkshopReminders (5-minute
 * internal timer, no cron-frequency limit on Railway). See index.js there.
 *
 * Vercel dashboard → Settings → Cron Jobs:
 *   Path:     /api/cron/workshop-reminders
 *   Schedule: 0 5 * * *
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { escapeHtml, sendLoggedEmail } from '@/lib/email'
import { getWorkshopChannels } from '@/lib/workshop-channels'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function sendViaBot(phone: string, fields: { workshopTitle: string; dateTimeLabel: string; zoomLink: string; creatorId?: string | null; workshopId?: string }) {
  const baseUrl = process.env.WHATSAPP_BOT_URL
  const secret = process.env.INTERNAL_BOT_SECRET
  if (!baseUrl || !secret) {
    console.warn(`[workshop-reminders] bot URL/secret not configured, skipping send to ${phone}`)
    return
  }
  try {
    const res = await fetch(`${baseUrl}/internal/send-workshop-reminder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ phone, ...fields }),
    })
    if (!res.ok) {
      console.error(`[workshop-reminders] bot rejected reminder for ${phone}:`, res.status, await res.text().catch(() => ''))
    }
  } catch (err) {
    console.error('[workshop-reminders] failed to send via bot:', err)
  }
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const windowStart = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    const windowEnd = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()

    const { data: dueWorkshops, error: workshopsError } = await supabase
      .from('workshops')
      .select('id, creator_id, title, date_time, zoom_link')
      .eq('status', 'published')
      .is('reminder_24h_sent_at', null)
      .gte('date_time', windowStart)
      .lte('date_time', windowEnd)

    if (workshopsError) throw workshopsError
    if (!dueWorkshops?.length) return NextResponse.json({ ok: true, sent: 0 })

    let sentCount = 0

    for (const workshop of dueWorkshops) {
      const { data: regs, error: regsError } = await supabase
        .from('workshop_registrations')
        .select('phone, email, name')
        .eq('workshop_id', workshop.id)
        .eq('payment_status', 'confirmed')
        .is('refunded_at', null)

      if (regsError) {
        console.error('[workshop-reminders] registration lookup failed for', workshop.id, regsError)
        continue
      }

      const dateTimeLabel = new Date(workshop.date_time).toLocaleString('en-IN', {
        weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata',
      })

      // The creator chooses WhatsApp per workshop. Email is always on.
      const channels = await getWorkshopChannels(supabase, workshop.id)
      const joinLink = workshop.zoom_link && /^https?:\/\//i.test(workshop.zoom_link) ? workshop.zoom_link : null

      for (const r of regs || []) {
        if (channels.whatsapp && r.phone) {
          await sendViaBot(r.phone, {
            workshopTitle: workshop.title,
            dateTimeLabel,
            zoomLink: workshop.zoom_link || 'Link will follow shortly',
            creatorId: workshop.creator_id,
            workshopId: workshop.id,
          })
        }
        if (r.email) {
          await sendLoggedEmail({
            supabase,
            emailType: 'workshop_reminder_24h',
            to: r.email,
            subject: `Tomorrow: ${workshop.title}`,
            creatorId: workshop.creator_id,
            html: `
              <div style="font-family:Inter,Arial,sans-serif;line-height:1.5;color:#111;max-width:520px">
                <h2 style="margin:0 0 12px">Your workshop is coming up</h2>
                <p style="margin:0 0 12px"><strong>${escapeHtml(workshop.title)}</strong></p>
                <p style="margin:0 0 12px"><strong>When:</strong> ${escapeHtml(dateTimeLabel)} (IST)</p>
                ${joinLink
                  ? `<p style="margin:0"><a href="${escapeHtml(joinLink)}" style="display:inline-block;background:#f79514;color:#fff;padding:10px 16px;border-radius:10px;text-decoration:none">Join the session</a></p>`
                  : '<p style="margin:0">The joining link will be sent to you before the session starts.</p>'}
              </div>`,
          })
        }
        sentCount++
      }

      await supabase.from('workshops').update({ reminder_24h_sent_at: new Date().toISOString() }).eq('id', workshop.id)
    }

    return NextResponse.json({ ok: true, sent: sentCount })
  } catch (err: any) {
    console.error('[workshop-reminders]', err)
    return NextResponse.json({ error: err.message || 'Server error' }, { status: 500 })
  }
}