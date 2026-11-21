import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(req: NextRequest) {
  try {
    const { enrollmentId, token, expiresAt } = await req.json()

    if (!enrollmentId || !token || typeof token !== 'string') {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    // The token must be one our own create-token route issued, still unused and
    // unexpired, for the SAME course as this enrollment.
    const { data: enr } = await supabase
      .from('enrollments')
      .select('id, course_uuid')
      .eq('id', enrollmentId)
      .maybeSingle()
    if (!enr) return NextResponse.json({ error: 'Enrollment not found' }, { status: 404 })

    const { data: issued } = await supabase
      .from('whatsapp_tokens')
      .select('course_slug')
      .eq('token', token)
      .eq('used', false)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle()
    if (!issued || (enr.course_uuid && issued.course_slug !== enr.course_uuid)) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 400 })
    }

    const { error } = await supabase
      .from('enrollments')
      .update({
        whatsapp_start_token: token,
        whatsapp_start_token_expires_at:
          expiresAt || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .eq('id', enrollmentId)

    if (error) throw error

    return NextResponse.json({ ok: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}