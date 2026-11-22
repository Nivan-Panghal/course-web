import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'
import { resolveTokenIdentity, verifiedPaymentId } from '@/lib/messaging-token-auth'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const courseId = body?.courseId

    if (!courseId || typeof courseId !== 'string') {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    // The owner and the payment status come from our records, never from the browser.
    const { data: courseRow } = await supabase.from('courses').select('id, creator_id').eq('id', courseId).maybeSingle()
    if (!courseRow) return NextResponse.json({ error: 'Course not found' }, { status: 404 })

    // Who is this link for? A logged-in student gets their own link; people with no web login
    // (imported students) can still ask; someone else's account cannot be asked for without signing in.
    const resolved = await resolveTokenIdentity(supabase, req, body, courseRow.creator_id)
    if ('response' in resolved) return resolved.response
    const { identity } = resolved

    if (!identity.studentId && !identity.email && !identity.phone) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    const now = new Date().toISOString()

    // Dedup by student_auth_id first — most reliable, no false-match risk
    if (identity.studentId) {
      const { data: byId } = await supabase
        .from('telegram_tokens')
        .select('token')
        .eq('course_id', courseId)
        .eq('student_auth_id', identity.studentId)
        .eq('used', false)
        .gt('expires_at', now)
        .order('created_at', { ascending: false })
        .limit(1)

      if (byId?.[0]?.token) {
        return NextResponse.json({ token: byId[0].token })
      }
    }

    // Dedup by email — only if email is a non-empty string (prevents cross-student collisions)
    if (identity.email) {
      const { data: byEmail } = await supabase
        .from('telegram_tokens')
        .select('token')
        .eq('course_id', courseId)
        .eq('student_email', identity.email)
        .eq('used', false)
        .gt('expires_at', now)
        .order('created_at', { ascending: false })
        .limit(1)

      if (byEmail?.[0]?.token) {
        return NextResponse.json({ token: byEmail[0].token })
      }
    }

    const verifiedPayment = await verifiedPaymentId(supabase, courseId, identity)

    const token = crypto.randomBytes(24).toString('hex')
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()

    const { error } = await supabase.from('telegram_tokens').insert({
      token,
      student_auth_id: identity.studentId,
      student_email: identity.email,
      student_name: identity.name,
      student_phone: identity.phone,
      creator_id: courseRow.creator_id,
      course_id: courseId,
      payment_id: verifiedPayment,
      expires_at: expiresAt,
    })

    if (error) throw error

    return NextResponse.json({ token, expiresAt })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}