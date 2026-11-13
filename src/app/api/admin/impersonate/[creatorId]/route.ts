/**
 * src/app/api/admin/impersonate/[creatorId]/route.ts
 * ─────────────────────────────────────────────────────────────────
 * POST   — Admin starts impersonating a creator. Returns a Supabase
 *          magic-link token_hash the browser exchanges (via
 *          supabase.auth.verifyOtp) for a real session for that
 *          creator's account — see isImpersonationActive() for why a
 *          real session is used and what stays blocked regardless.
 * DELETE — ends an impersonation session. Called after the admin's
 *          own session has been restored client-side, using her own
 *          Bearer token — see ImpersonationBanner.
 * Gated by requireAdmin() on both.
 * ─────────────────────────────────────────────────────────────────
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { requireAdmin } from '@/lib/admin-auth'
import { friendlyErrorResponse } from '@/lib/payment-errors'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const SESSION_MINUTES = 45

export async function POST(
  req: NextRequest,
  props: { params: Promise<{ creatorId: string }> }
) {
  try {
    const admin = await requireAdmin(req, supabase)
    if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { creatorId } = await props.params

    const { data: creator, error: creatorError } = await supabase
      .from('creators')
      .select('id, name, email')
      .eq('id', creatorId)
      .maybeSingle()

    if (creatorError) throw creatorError
    if (!creator || !creator.email) {
      return NextResponse.json({ error: 'Creator not found or has no email on file.' }, { status: 404 })
    }

    // Opportunistic cleanup — keeps this table down to live sessions only,
    // never a growing history (no session logging, per admin's decision).
    await supabase
      .from('admin_impersonation_sessions')
      .delete()
      .lt('expires_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())

    const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email: creator.email,
    })
    if (linkError || !linkData?.properties?.hashed_token) {
      throw linkError || new Error('Could not generate an impersonation session.')
    }

    const expiresAt = new Date(Date.now() + SESSION_MINUTES * 60 * 1000).toISOString()

    const { data: session, error: sessionError } = await supabase
      .from('admin_impersonation_sessions')
      .insert({ creator_id: creator.id, admin_email: admin.email, expires_at: expiresAt })
      .select('id')
      .single()
    if (sessionError) throw sessionError

    return NextResponse.json({
      email: creator.email,
      tokenHash: linkData.properties.hashed_token,
      creatorName: creator.name || creator.email,
      sessionId: session.id,
      expiresAt,
    })
  } catch (err: any) {
    return friendlyErrorResponse(err, 'admin/impersonate POST')
  }
}

// No requireAdmin() here on purpose: exiting reliably — even if the
// admin's own bearer token has gone stale by the time Exit is clicked —
// matters more than gating this one call. sessionId is an unguessable
// UUID the browser already holds and isn't exposed anywhere else; all
// it can do is end one already-live impersonation session early.
export async function DELETE(
  req: NextRequest,
  props: { params: Promise<{ creatorId: string }> }
) {
  try {
    const { creatorId } = await props.params
    const sessionId = req.nextUrl.searchParams.get('sessionId')
    if (!sessionId) return NextResponse.json({ error: 'sessionId is required' }, { status: 400 })

    const { error } = await supabase
      .from('admin_impersonation_sessions')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', sessionId)
      .eq('creator_id', creatorId)
      .is('revoked_at', null)
    if (error) throw error

    return NextResponse.json({ success: true })
  } catch (err: any) {
    return friendlyErrorResponse(err, 'admin/impersonate DELETE')
  }
}