/**
 * ═══════════════════════════════════════════════════════════════════
 * Scheduled by vercel.json:
 *   Path:     /api/cron/live-session-recording-notify
 *   Schedule: once a day
 *
 * WHAT THIS DOES:
 * Finds every live_sessions row whose scheduled end time
 * (scheduled_at + duration_minutes) has passed and that hasn't been
 * notified yet (recording_notified_at IS NULL), then sends each paid
 * enrolled student exactly one message:
 *   - a link to the recording, if the creator has uploaded one
 *   - "not available yet, we'll notify you" otherwise
 *
 * The session is CLAIMED (recording_notified_at set) before anything is sent, so two overlapping runs
 * can never message the same students twice. This is deliberately a ONE-TIME notification per session,
 * not a repeating nag. Students are read in pages of 500, so classes of any size are reached.
 * ═══════════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { signLiveSessionRecordingPageUrl } from '@/lib/signer'

export const maxDuration = 60

const PAGE_SIZE = 500
const SEND_CONCURRENCY = 10

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
    console.warn(`[live-recording-notify] ${channel} bot URL/secret not configured, skipping send`)
    return false
  }
  try {
    const res = await fetch(`${baseUrl}/internal/send-live-recording`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ identity, ...fields }),
    })
    if (!res.ok) {
      console.error(`[live-recording-notify] ${channel} bot rejected a send:`, res.status, await res.text().catch(() => ''))
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

    // Claim first: only the run that flips recording_notified_at from NULL sends.
    const { data: claimed } = await supabase
      .from('live_sessions')
      .update({ recording_notified_at: new Date().toISOString() })
      .eq('id', session.id)
      .is('recording_notified_at', null)
      .select('id')
    if (!claimed || claimed.length === 0) continue

    const courseName = (session as any).courses?.name || 'your course'
    const hasRecording = !!(session.recording_url || session.recording_storage_path)

    for (let from = 0; ; from += PAGE_SIZE) {
      const { data: students, error: studentsError } = await supabase
        .from('enrollments')
        .select('id, phone, telegram_chat_id, students(reminder_channel)')
        .eq('course_uuid', session.course_id)
        .eq('payment_status', 'paid')
        .order('id', { ascending: true })
        .range(from, from + PAGE_SIZE - 1)

      if (studentsError) {
        console.error(`[live-recording-notify] failed to fetch students for session ${session.id}:`, studentsError)
        // Nothing was sent yet: give the claim back so tomorrow's run retries. Later pages: keep the claim,
        // re-running would message the first pages again.
        if (from === 0) await supabase.from('live_sessions').update({ recording_notified_at: null }).eq('id', session.id)
        break
      }

      const rows = students || []
      for (let i = 0; i < rows.length; i += SEND_CONCURRENCY) {
        const results = await Promise.all(
          rows.slice(i, i + SEND_CONCURRENCY).map(async (s: any) => {
            const channel = s.students?.reminder_channel as 'whatsapp' | 'telegram' | undefined
            const identity = channel === 'telegram' ? s.telegram_chat_id : s.phone
            if (!channel || !identity) return null
            // The link is unique per student (their own signed identity), so it always resolves to the
            // *current* recording state at the moment they click.
            const recordingLink = signLiveSessionRecordingPageUrl(session.id, String(identity))
            return sendViaBot(channel, String(identity), { sessionTitle: session.title, courseName, hasRecording, recordingLink })
          })
        )
        for (const ok of results) {
          if (ok === null) continue
          if (ok) messagesSent++
          else messagesFailed++
        }
      }

      if (rows.length < PAGE_SIZE) break
    }

    sessionsProcessed++
  }

  return NextResponse.json({ ok: true, sessionsProcessed, messagesSent, messagesFailed })
}