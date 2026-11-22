/**
 * src/lib/messaging-token-auth.ts
 * ─────────────────────────────────────────────────────────────────
 * Shared by /api/telegram/create-token and /api/whatsapp/create-token.
 *
 * WHO is the start-link for, and is it a PAID link? Neither may come from what the browser says.
 *
 *  - Logged in (Authorization: Bearer <session token>): the link is for THAT user. Their verified
 *    account id and email are used; a different email/id in the request body is ignored.
 *    The course owner (creator "test mode") may supply a test identity.
 *  - Not logged in: allowed only for people who have NO web account (imported students using
 *    /claim/telegram). If the email/phone/id belongs to an account that has a web login, the
 *    caller must sign in as that account (401), so nobody can fetch another student's link.
 *
 * "Paid" is decided from our own enrollments (a paid enrollment already exists on this course for
 * this identity), never from a payment id sent by the browser.
 * ─────────────────────────────────────────────────────────────────
 */
import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizePhone } from '@/lib/phone'

export type TokenIdentity = {
  /** Verified auth user id; null when the caller is not logged in. */
  studentId: string | null
  email: string | null
  /** Normalized phone. Stored on the token; only used to look people up when `phoneTrusted`. */
  phone: string | null
  name: string | null
  /** May the phone be used to dedupe / find the paid enrollment? Not for logged-in students (their phone is self-declared). */
  phoneTrusted: boolean
}

type Resolved = { identity: TokenIdentity } | { response: NextResponse }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function resolveTokenIdentity(
  supabase: SupabaseClient,
  req: NextRequest,
  body: any,
  courseOwnerId: string
): Promise<Resolved> {
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim()
  const bodyEmail = typeof body?.studentEmail === 'string' ? body.studentEmail.trim().toLowerCase() : ''
  const bodyPhone = normalizePhone(typeof body?.studentPhone === 'string' ? body.studentPhone : '') || null
  const name = typeof body?.studentName === 'string' && body.studentName.trim() ? body.studentName.trim() : null

  let user: { id: string; email?: string | null } | null = null
  if (bearer) {
    const { data, error } = await supabase.auth.getUser(bearer)
    if (error || !data.user) {
      return { response: NextResponse.json({ error: 'Please sign in again' }, { status: 401 }) }
    }
    user = data.user
  }

  // The course owner testing their own course may name a test student.
  if (user && user.id === courseOwnerId) {
    return {
      identity: {
        studentId: typeof body?.studentId === 'string' && UUID.test(body.studentId) ? body.studentId : null,
        email: bodyEmail || null,
        phone: bodyPhone,
        name,
        phoneTrusted: true,
      },
    }
  }

  // Logged in as a student: the link is for this account only.
  if (user) {
    const email = (user.email || '').trim().toLowerCase() || null
    if (!email) {
      return { response: NextResponse.json({ error: 'This account has no email' }, { status: 403 }) }
    }
    return { identity: { studentId: user.id, email, phone: bodyPhone, name, phoneTrusted: false } }
  }

  // Not logged in: refuse if the details belong to an account that has a web login.
  const claimedId = typeof body?.studentId === 'string' && UUID.test(body.studentId) ? body.studentId : null
  const checks: any[] = []
  if (bodyEmail) checks.push(supabase.from('students').select('id').eq('email', bodyEmail).not('auth_id', 'is', null).limit(1))
  if (bodyPhone) checks.push(supabase.from('students').select('id').eq('phone', bodyPhone).not('auth_id', 'is', null).limit(1))
  if (claimedId) checks.push(supabase.from('students').select('id').or(`id.eq.${claimedId},auth_id.eq.${claimedId}`).not('auth_id', 'is', null).limit(1))
  const results = await Promise.all(checks)
  if (results.some((r: any) => (r.data?.length ?? 0) > 0)) {
    return { response: NextResponse.json({ error: 'Please sign in to continue' }, { status: 401 }) }
  }

  return { identity: { studentId: null, email: bodyEmail || null, phone: bodyPhone, name, phoneTrusted: true } }
}

/**
 * The payment id to put on a token: the OWN payment id of a paid enrollment on this course that belongs to
 * this identity, or null (a free link). `FREE`, web payments and `MIGRATED:...` enrollments all count.
 */
export async function verifiedPaymentId(
  supabase: SupabaseClient,
  courseId: string,
  identity: TokenIdentity
): Promise<string | null> {
  const keys = [identity.phoneTrusted ? identity.phone : null, identity.email].filter(Boolean) as string[]
  if (keys.length > 0) {
    const { data } = await supabase
      .from('enrollments')
      .select('payment_id')
      .eq('course_uuid', courseId)
      .eq('payment_status', 'paid')
      .in('phone', keys)
      .limit(1)
    if (data?.[0]) return data[0].payment_id || 'VERIFIED'
  }

  const studentIds: string[] = []
  if (identity.studentId) {
    const { data } = await supabase.from('students').select('id').eq('auth_id', identity.studentId).limit(5)
    studentIds.push(...(data || []).map((r: any) => r.id))
  }
  if (identity.email) {
    const { data } = await supabase.from('students').select('id').eq('email', identity.email).limit(5)
    studentIds.push(...(data || []).map((r: any) => r.id))
  }
  if (identity.phoneTrusted && identity.phone) {
    const { data } = await supabase.from('students').select('id').eq('phone', identity.phone).limit(5)
    studentIds.push(...(data || []).map((r: any) => r.id))
  }
  if (studentIds.length === 0) return null

  const { data } = await supabase
    .from('enrollments')
    .select('payment_id')
    .eq('course_uuid', courseId)
    .eq('payment_status', 'paid')
    .in('student_id', studentIds)
    .limit(1)
  return data?.[0] ? data[0].payment_id || 'VERIFIED' : null
}