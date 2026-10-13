/**
 * GET /api/certificate/[id]
 * ─────────────────────────────────────────────────────────────────────────────
 * Public, no-auth required.
 * Returns certificate metadata for the public verification page (Step 4).
 * Anyone with a certificate ID can verify it's real.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(
  _req: NextRequest,
  props: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await props.params
    const certificateId = id?.trim()

    if (!certificateId) {
      return NextResponse.json({ error: 'Certificate ID is required' }, { status: 400 })
    }

    const { data: cert, error } = await supabase
      .from('certificates')
      .select('certificate_id, student_name, course_name, creator_name, issued_at, pdf_url')
      .eq('certificate_id', certificateId)
      .maybeSingle()

    if (cert) return NextResponse.json(cert)

    // Not a course certificate: check workshop certificates (ids start with WS-).
    // The answer has the same shape, so the verify page works for both.
    if (!error) {
      const { data: ws } = await supabase
        .from('workshop_certificates')
        .select('certificate_id, attendee_name, workshop_title, creator_name, issued_at, pdf_url')
        .eq('certificate_id', certificateId)
        .maybeSingle()
      if (ws) {
        return NextResponse.json({
          certificate_id: ws.certificate_id,
          student_name: ws.attendee_name,
          course_name: ws.workshop_title,
          creator_name: ws.creator_name,
          issued_at: ws.issued_at,
          pdf_url: ws.pdf_url,
        })
      }
    }

    return NextResponse.json({ error: 'Certificate not found' }, { status: 404 })

  } catch (err: any) {
    console.error('[certificate/get]', err.message)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
