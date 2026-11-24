/**
 * ═══════════════════════════════════════════════════════════════════
 * Set this up in Vercel dashboard → Settings → Cron Jobs (or vercel.json):
 *   Path:     /api/cron/live-session-recording-notify
 *   Schedule: 0 6 * * *   (once a day — any time works)
 *
 * WHAT THIS DOES:
 * Finds every live_sessions row whose scheduled end time
 * (scheduled_at + duration_minutes) has passed and that hasn't been
 * notified yet (recording_notified_at IS NULL), then sends each paid
 * enrolled student exactly one message:
 *   - a link to the recording, if the creator has uploaded one
 *   - "not available yet, we'll notify you" otherwise
 * Marks recording_notified_at once sent so it never re-notifies for the
 * same session, even across multiple daily runs. This is deliberately
 * a ONE-TIME notification per session, not a repeating nag — a student
 * who missed the "not available yet" message can still find the
 * recording via their dashboard once it's uploaded.
 * ═══════════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { signLiveSessionRecordingPageUrl } from '@/lib/signer'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function sendViaBot(
  channel: 'whatsapp' | 'telegram',
  identity: string,
  fields: { sessionTitle: string; courseName: string; hasRecording: boolean; recordingLink: string },
) {
  const baseUrl = channel === 'whatsapp' ? process.env.WHATSAPP_BOT_URL : process.env.TELEGRAM_BOT_URL
  const secret = process.env.INTERNAL_BOT_SECRET
  if (!baseUrl || !secret) {
    console.warn(`[live-recording-notify] ${channel} bot URL/secret not configured, skipping send to ${identity}`)
    return false
  }
  try {
    const res = await fetch(`${baseUrl}/internal/send-live-recording`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ identity, ...fields }),
    })
    if (!res.ok) {
      console.error(`[live-recording-notify] ${channel} bot rejected send for ${identity}:`, res.status, await res.text().catch(() => ''))
      return false
    }
    return true
  } catch (err) {
    console.error(`[live-recording-notify] failed to send via ${channel}:`, err)
    return false
  }
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const nowIso = new Date().toISOString()

  const { data: sessions, error: sessionsError } = await supabase
    .from('live_sessions')
    .select('id, title, scheduled_at, duration_minutes, course_id, recording_url, recording_storage_path, courses(name)')
    .is('recording_notified_at', null)
    .lte('scheduled_at', nowIso) // only even worth checking sessions that started in the past

  if (sessionsError) {
    console.error('[live-recording-notify] failed to fetch sessions:', sessionsError)
    return NextResponse.json({ error: 'DB error' }, { status: 500 })
  }

  let sessionsProcessed = 0
  let messagesSent = 0
  let messagesFailed = 0

  for (const session of sessions || []) {
    const endsAt = new Date(session.scheduled_at).getTime() + (session.duration_minutes || 0) * 60 * 1000
    if (Date.now() < endsAt) continue // hasn't actually ended yet, leave it for tomorrow's run

    const courseName = (session as any).courses?.name || 'your course'
    const hasRecording = !!(session.recording_url || session.recording_storage_path)

    const { data: students, error: studentsError } = await supabase
      .from('enrollments')
      .select('phone, telegram_chat_id, students(reminder_channel)')
      .eq('course_uuid', session.course_id)
      .eq('payment_status', 'paid')

    if (studentsError) {
      console.error(`[live-recording-notify] failed to fetch students for session ${session.id}:`, studentsError)
      continue
    }

    for (const s of students || []) {
      const channel = (s as any).students?.reminder_channel as 'whatsapp' | 'telegram' | undefined
      const identity = channel === 'telegram' ? s.telegram_chat_id : s.phone
      if (!channel || !identity) continue

      // The link is unique per student (their own signed identity), so
      // it always resolves to the *current* recording state at the
      // moment they click — even if uploaded well after this cron ran.
      const recordingLink = signLiveSessionRecordingPageUrl(session.id, String(identity))

      const ok = await sendViaBot(channel, String(identity), {
        sessionTitle: session.title,
        courseName,
        hasRecording,
        recordingLink,
      })
      if (ok) messagesSent++
      else messagesFailed++
    }

    // Marked once per session regardless of individual send failures —
    // a bot being briefly down shouldn't cause this to loop forever;
    // students who missed it can still reach the recording from their
    // dashboard once it's uploaded.
    await supabase.from('live_sessions').update({ recording_notified_at: new Date().toISOString() }).eq('id', session.id)
    sessionsProcessed++
  }

  return NextResponse.json({ ok: true, sessionsProcessed, messagesSent, messagesFailed })
}