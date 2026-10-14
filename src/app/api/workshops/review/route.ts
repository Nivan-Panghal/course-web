/**
 * /api/workshops/review   (PUBLIC, token based: for the student's review page)
 *   GET  ?token=...                 → what the page needs to show
 *   POST { token, rating, comment } → save (or update) the student's review
 *
 * The token is the private review_token on the student's registration.
 * Only confirmed registrations can review, and only after the workshop started.
 * Workshop reviews only; course ratings use /api/student/ratings.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_COMMENT = 1000

async function lookup(token: unknown) {
  if (typeof token !== 'string' || !UUID.test(token)) return { error: NextResponse.json({ error: 'This review link is not valid.' }, { status: 404 }) }
  const { data: reg, error } = await supabase
    .from('workshop_registrations')
    .select('id, workshop_id, name, payment_status')
    .eq('review_token', token)
    .maybeSingle()
  if (error || !reg) return { error: NextResponse.json({ error: 'This review link is not valid.' }, { status: 404 }) }
  const { data: workshop } = await supabase
    .from('workshops')
    .select('id, title, date_time, host_name, brand_name')
    .eq('id', reg.workshop_id)
    .maybeSingle()
  if (!workshop) return { error: NextResponse.json({ error: 'This review link is not valid.' }, { status: 404 }) }
  return { reg, workshop }
}

function blockedReason(reg: { payment_status: string }, workshop: { date_time: string }): string | null {
  if (reg.payment_status !== 'confirmed') return 'Only people with a confirmed registration can review this workshop.'
  if (new Date(workshop.date_time).getTime() > Date.now()) return 'You can review this workshop once it has started.'
  return null
}

export async function GET(req: NextRequest) {
  try {
    const found = await lookup(req.nextUrl.searchParams.get('token'))
    if ('error' in found && found.error) return found.error
    const { reg, workshop } = found as { reg: any; workshop: any }

    const { data: review } = await supabase
      .from('workshop_reviews')
      .select('rating, comment, creator_reply')
      .eq('registration_id', reg.id)
      .maybeSingle()

    const reason = blockedReason(reg, workshop)
    return NextResponse.json({
      workshopTitle: workshop.title,
      hostName: workshop.brand_name || workshop.host_name || '',
      firstName: String(reg.name || '').trim().split(/\s+/)[0] || '',
      canReview: !reason,
      reason,
      review: review ? { rating: review.rating, comment: review.comment || '', reply: review.creator_reply || '' } : null,
    })
  } catch (err: any) {
    console.error('[workshop-review] GET', err?.message)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const found = await lookup(body?.token)
    if ('error' in found && found.error) return found.error
    const { reg, workshop } = found as { reg: any; workshop: any }

    const reason = blockedReason(reg, workshop)
    if (reason) return NextResponse.json({ error: reason }, { status: 403 })

    const rating = Number(body?.rating)
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return NextResponse.json({ error: 'Please choose 1 to 5 stars.' }, { status: 400 })
    }
    const comment = typeof body?.comment === 'string' ? body.comment.trim() : ''
    if (comment.length > MAX_COMMENT) {
      return NextResponse.json({ error: `Please keep your comment under ${MAX_COMMENT} characters.` }, { status: 400 })
    }

    const { error } = await supabase.from('workshop_reviews').upsert(
      {
        workshop_id: workshop.id,
        registration_id: reg.id,
        rating,
        comment: comment || null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'registration_id' },
    )
    if (error) {
      console.error('[workshop-review] save failed', error.message)
      return NextResponse.json({ error: 'Could not save your review. Please try again.' }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    console.error('[workshop-review] POST', err?.message)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}