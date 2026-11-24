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
    const courseId = body?.courseId // Course UUID

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

    // ── Dedup: re-use valid unused token for this student+course ──────────────

    // 1. By auth UUID (most reliable)
    if (identity.studentId) {
      const { data: byId } = await supabase
        .from('whatsapp_tokens')
        .select('token, expires_at')
        .eq('course_slug', courseId)           // We store UUID in course_slug column
        .eq('student_auth_id', identity.studentId)
        .eq('used', false)
        .gt('expires_at', now)
        .order('created_at', { ascending: false })
        .limit(1)

      if (byId?.[0]?.token) {
        return NextResponse.json({ token: byId[0].token, expiresAt: byId[0].expires_at })
      }
    }

    // 2. By email
    if (identity.email) {
      const { data: byEmail } = await supabase
        .from('whatsapp_tokens')
        .select('token, expires_at')
        .eq('course_slug', courseId)
        .eq('student_email', identity.email)
        .eq('used', false)
        .gt('expires_at', now)
        .order('created_at', { ascending: false })
        .limit(1)

      if (byEmail?.[0]?.token) {
        return NextResponse.json({ token: byEmail[0].token, expiresAt: byEmail[0].expires_at })
      }
    }

    // 3. By phone — only when the phone is trustworthy (not for logged-in students: it is self-declared)
    if (identity.phone && identity.phoneTrusted) {
      const { data: byPhone } = await supabase
        .from('whatsapp_tokens')
        .select('token, expires_at')
        .eq('course_slug', courseId)
        .eq('student_phone', identity.phone)
        .eq('used', false)
        .gt('expires_at', now)
        .order('created_at', { ascending: false })
        .limit(1)

      if (byPhone?.[0]?.token) {
        return NextResponse.json({ token: byPhone[0].token, expiresAt: byPhone[0].expires_at })
      }
    }

    // ── Create new token ──────────────────────────────────────────────────────
    const verifiedPayment = await verifiedPaymentId(supabase, courseId, identity)

    const token = crypto.randomBytes(24).toString('hex')
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()

    const { error } = await supabase.from('whatsapp_tokens').insert({
      token,
      student_auth_id: identity.studentId,
      student_phone: identity.phone,
      student_email: identity.email,
      student_name: identity.name,
      creator_id: courseRow.creator_id,
      course_slug: courseId,    // Always store UUID here; bot handles UUID format
      payment_id: verifiedPayment,
      expires_at: expiresAt,
      used: false,
    })

    if (error) throw error

    return NextResponse.json({ token, expiresAt })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}