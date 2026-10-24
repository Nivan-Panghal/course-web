/**
 * /api/workshops/reviews   (WORKSHOP reviews, creator side)
 *   GET                              → reviews, averages, and who can still be asked
 *   POST { action: 'reply', reviewId, reply }
 *   POST { action: 'request', workshopId }
 *        → sends "How was it?" with a private review link, on Telegram and by email,
 *          to confirmed people who have not reviewed yet (and were not asked in the last 3 days)
 * Auth: Bearer token of the creator. Course ratings use /api/creator/ratings.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { escapeHtml, sendLoggedEmail } from '@/lib/email'
import { getWorkshopChannels } from '@/lib/workshop-channels'

export const maxDuration = 60

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const MAX_REPLY = 500
const MAX_RECIPIENTS = 400
const CHUNK = 5
const ASK_AGAIN_AFTER_MS = 3 * 24 * 60 * 60 * 1000
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const SITE = () => (process.env.NEXT_PUBLIC_SITE_URL || 'https://kurso.in').replace(/\/$/, '')

async function creatorFrom(req: NextRequest) {
  const token = (req.headers.get('authorization') || '').replace('Bearer ', '').trim()
  if (!token) return null
  const { data: { user }, error } = await supabase.auth.getUser(token)
  return error || !user ? null : user
}

function setupError(message: string) {
  return /review_token|review_requested_at|workshop_reviews/.test(message)
    ? NextResponse.json({ error: 'setup_needed' }, { status: 409 })
    : NextResponse.json({ error: 'Could not load reviews.' }, { status: 500 })
}

async function sendTelegram(chatId: string | number, text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return false
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    })
    return res.ok
  } catch {
    return false
  }
}

// ── GET ────────────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  try {
    const user = await creatorFrom(req)
    if (!user) return NextResponse.json({ error: 'Please log in again.' }, { status: 401 })

    const { data: workshops, error: wErr } = await supabase
      .from('workshops')
      .select('id, title, date_time')
      .eq('creator_id', user.id)
      .order('date_time', { ascending: false })
    if (wErr) return NextResponse.json({ error: 'Could not load your workshops.' }, { status: 500 })
    if (!workshops || workshops.length === 0) return NextResponse.json({ workshops: [], reviews: [] })

    const ids = workshops.map(w => w.id)
    const { data: reviews, error: rErr } = await supabase
      .from('workshop_reviews')
      .select('id, workshop_id, registration_id, rating, comment, creator_reply, creator_replied_at, created_at')
      .in('workshop_id', ids)
      .order('created_at', { ascending: false })
    if (rErr) return setupError(rErr.message)

    const { data: regs, error: regErr } = await supabase
      .from('workshop_registrations')
      .select('id, workshop_id, name, email, telegram_chat_id, review_requested_at')
      .in('workshop_id', ids)
      .eq('payment_status', 'confirmed')
      .is('refunded_at', null)
    if (regErr) return setupError(regErr.message)

    const nameOf = new Map((regs || []).map(r => [r.id, r.name]))
    const reviewed = new Set((reviews || []).map(r => r.registration_id))
    const now = Date.now()

    // Telegram can be switched off per workshop. Email is always on.
    const channelList = await Promise.all(workshops.map(w => getWorkshopChannels(supabase, w.id)))
    const channelsOf = new Map(workshops.map((w, i) => [w.id, channelList[i]]))

    return NextResponse.json({
      workshops: workshops.map(w => {
        const mine = (regs || []).filter(r => r.workshop_id === w.id)
        const started = new Date(w.date_time).getTime() <= now
        const telegramOn = channelsOf.get(w.id)?.telegram !== false
        const askable = started
          ? mine.filter(r =>
              ((r.telegram_chat_id && telegramOn) || r.email) &&
              !reviewed.has(r.id) &&
              (!r.review_requested_at || now - new Date(r.review_requested_at).getTime() > ASK_AGAIN_AFTER_MS)
            ).length
          : 0
        return { id: w.id, title: w.title, dateTime: w.date_time, started, confirmed: mine.length, askable }
      }),
      reviews: (reviews || []).map(r => ({
        id: r.id,
        workshopId: r.workshop_id,
        name: nameOf.get(r.registration_id) || 'Attendee',
        rating: r.rating,
        comment: r.comment || '',
        reply: r.creator_reply || '',
        createdAt: r.created_at,
      })),
    })
  } catch (err: any) {
    console.error('[workshop-reviews] GET', err?.message)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}

// ── POST ───────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const user = await creatorFrom(req)
    if (!user) return NextResponse.json({ error: 'Please log in again.' }, { status: 401 })
    const body = await req.json().catch(() => ({}))

    if (body?.action === 'reply') {
      const reply = typeof body.reply === 'string' ? body.reply.trim() : ''
      if (reply.length > MAX_REPLY) return NextResponse.json({ error: `Keep your reply under ${MAX_REPLY} characters.` }, { status: 400 })
      const { data: review } = await supabase.from('workshop_reviews').select('id, workshop_id').eq('id', body.reviewId).maybeSingle()
      if (!review) return NextResponse.json({ error: 'Review not found.' }, { status: 404 })
      const { data: owns } = await supabase.from('workshops').select('id').eq('id', review.workshop_id).eq('creator_id', user.id).maybeSingle()
      if (!owns) return NextResponse.json({ error: 'Review not found.' }, { status: 404 })
      const { error } = await supabase
        .from('workshop_reviews')
        .update({ creator_reply: reply || null, creator_replied_at: reply ? new Date().toISOString() : null })
        .eq('id', review.id)
      if (error) return NextResponse.json({ error: 'Could not save your reply. Please try again.' }, { status: 500 })
      return NextResponse.json({ ok: true })
    }

    if (body?.action === 'request') {
      const { data: workshop } = await supabase
        .from('workshops')
        .select('id, title, date_time')
        .eq('id', body.workshopId)
        .eq('creator_id', user.id)
        .maybeSingle()
      if (!workshop) return NextResponse.json({ error: 'Workshop not found.' }, { status: 404 })
      if (new Date(workshop.date_time).getTime() > Date.now()) {
        return NextResponse.json({ error: 'You can ask for reviews once the workshop has started.' }, { status: 400 })
      }

      const { data: regs, error: regErr } = await supabase
        .from('workshop_registrations')
        .select('id, name, email, telegram_chat_id, review_token, review_requested_at')
        .eq('workshop_id', workshop.id)
        .eq('payment_status', 'confirmed')
        .is('refunded_at', null)
      if (regErr) return setupError(regErr.message)
      const { data: done } = await supabase.from('workshop_reviews').select('registration_id').eq('workshop_id', workshop.id)
      const reviewed = new Set((done || []).map(d => d.registration_id))
      const now = Date.now()

      // Telegram can be switched off for this workshop. Email is always on.
      const channels = await getWorkshopChannels(supabase, workshop.id)

      const people = (regs || []).filter(r =>
        ((r.telegram_chat_id && channels.telegram) || r.email) &&
        !reviewed.has(r.id) &&
        (!r.review_requested_at || now - new Date(r.review_requested_at).getTime() > ASK_AGAIN_AFTER_MS)
      )
      if (people.length === 0) {
        return NextResponse.json({ error: 'No one to ask right now. Everyone has either reviewed, was asked in the last 3 days, or has no Telegram or email.' }, { status: 400 })
      }
      if (people.length > MAX_RECIPIENTS) {
        return NextResponse.json({ error: `More than ${MAX_RECIPIENTS} people. Please contact support to send to a large group.` }, { status: 400 })
      }

      let telegram = 0, email = 0, failed = 0
      const asked: string[] = []
      for (let i = 0; i < people.length; i += CHUNK) {
        await Promise.all(people.slice(i, i + CHUNK).map(async p => {
          const url = `${SITE()}/workshop-review/${p.review_token}`
          const [t, e] = await Promise.all([
            p.telegram_chat_id && channels.telegram ? sendTelegram(p.telegram_chat_id, `⭐ How was “${workshop.title}”?\n\nRate it in about 20 seconds:\n${url}\n\nNot happy? You can ask for a refund here:\n${SITE()}/workshop-refund/${p.review_token}`) : Promise.resolve(null),
            p.email
              ? sendLoggedEmail({
                  supabase,
                  creatorId: user.id,
                  emailType: 'workshop_review_request',
                  to: p.email,
                  subject: `How was ${workshop.title}?`,
                  html: `
                    <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1f2937;line-height:1.6">
                      <p>Hi ${escapeHtml(p.name)},</p>
                      <p>Thank you for joining <strong>${escapeHtml(workshop.title)}</strong>. Could you rate it? It takes about 20 seconds and helps the host a lot.</p>
                      <p><a href="${url}" style="display:inline-block;background:#7c3aed;color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:bold">Rate the workshop</a></p>
                      <p style="color:#6b7280;font-size:13px">Not happy with the workshop? <a href="${SITE()}/workshop-refund/${p.review_token}">Ask for a refund</a>.</p>
                    </div>`,
                  metadata: { workshop_id: workshop.id, workshop_registration_id: p.id },
                }).then(r => !!r.sent)
              : Promise.resolve(null),
          ])
          if (t) telegram++
          if (e) email++
          if (t || e) asked.push(p.id)
          else failed++
        }))
        await sleep(250)
      }

      if (asked.length) {
        await supabase.from('workshop_registrations').update({ review_requested_at: new Date().toISOString() }).in('id', asked)
      }
      return NextResponse.json({ total: people.length, telegram, email, failed })
    }

    return NextResponse.json({ error: 'Unknown action.' }, { status: 400 })
  } catch (err: any) {
    console.error('[workshop-reviews] POST', err?.message)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}