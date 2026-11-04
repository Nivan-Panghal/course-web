/**
 * src/app/api/course/lessons/route.ts
 * ──────────────────────────────────────────────────────
 * Serves lesson lists to the browser so the lessons table itself can be
 * locked down (owner-only). Two modes:
 *
 *  ?courseIds=a,b,c  -> safe summary only (course_id, order_num, is_last_lesson)
 *                       used by /my-courses for counts. No login needed.
 *
 *  ?courseId=a       -> the full lesson list for the course player.
 *                       Enrolled students (bot-link session or login) and the
 *                       course owner get everything. Everyone else gets the
 *                       list with the content columns blanked out.
 * ──────────────────────────────────────────────────────
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getWebAccessContext } from '@/lib/webAccess'
import { normalizePhone } from '@/lib/phone'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Columns that point at the real lesson content or live-class links.
const SENSITIVE_COLUMNS = [
  'content_url',
  'video_storage_path',
  'pdf_storage_path',
  'live_join_url',
  'live_recording_url',
]

async function hasPaidEnrollment(courseId: string, user: any): Promise<boolean> {
  // 1. By the student record linked to this login
  const { data: student } = await supabase
    .from('students')
    .select('id')
    .eq('auth_id', user.id)
    .maybeSingle()

  if (student?.id) {
    const { data } = await supabase
      .from('enrollments')
      .select('id')
      .eq('course_uuid', courseId)
      .eq('payment_status', 'paid')
      .eq('student_id', student.id)
      .limit(1)
    if (data && data.length > 0) return true
  }

  // 2. By phone (web and Telegram enrollments store a bare phone number)
  const rawPhones = [user.user_metadata?.phone, user.phone].filter(Boolean).map(String)
  const phones = Array.from(
    new Set(rawPhones.flatMap(p => [p, normalizePhone(p)]).filter(Boolean) as string[])
  )
  for (const p of phones) {
    const { data } = await supabase
      .from('enrollments')
      .select('id')
      .eq('course_uuid', courseId)
      .eq('payment_status', 'paid')
      .eq('phone', p)
      .limit(1)
    if (data && data.length > 0) return true
  }

  // 3. By email stored in the phone field (email-based delivery)
  if (user.email) {
    const { data } = await supabase
      .from('enrollments')
      .select('id')
      .eq('course_uuid', courseId)
      .eq('payment_status', 'paid')
      .eq('phone', user.email)
      .limit(1)
    if (data && data.length > 0) return true
  }

  return false
}

export async function GET(req: NextRequest) {
  try {
    const params = req.nextUrl.searchParams
    const noStore = { headers: { 'Cache-Control': 'no-store' } }

    // ── Mode 1: safe summary for My Courses ──
    const courseIdsParam = params.get('courseIds')
    if (courseIdsParam) {
      const ids = courseIdsParam
        .split(',')
        .map(s => s.trim())
        .filter(id => UUID_RE.test(id))
        .slice(0, 50)

      if (ids.length === 0) return NextResponse.json({ lessons: [] }, noStore)

      const { data } = await supabase
        .from('lessons')
        .select('course_id, order_num, is_last_lesson')
        .in('course_id', ids)
        .eq('is_published', true)

      return NextResponse.json({ lessons: data || [] }, noStore)
    }

    // ── Mode 2: full list for the course player ──
    const courseId = params.get('courseId') || ''
    if (!UUID_RE.test(courseId)) {
      return NextResponse.json({ error: 'courseId required' }, { status: 400 })
    }

    const { data: course } = await supabase
      .from('courses')
      .select('id, creator_id')
      .eq('id', courseId)
      .maybeSingle()

    if (!course) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    let fullAccess = false

    // a) Student who arrived through a bot link (cookie session)
    const ctx = await getWebAccessContext(req)
    if (ctx && ctx.courseId === courseId) fullAccess = true

    // b) Logged-in user: the course owner, or a paid student
    if (!fullAccess) {
      const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim()
      if (token) {
        const { data } = await supabase.auth.getUser(token)
        const user = data?.user
        if (user) {
          fullAccess =
            course.creator_id === user.id || (await hasPaidEnrollment(courseId, user))
        }
      }
    }

    const { data: lessons } = await supabase
      .from('lessons')
      .select('*')
      .eq('course_id', courseId)
      .eq('is_published', true)
      .order('order_num', { ascending: true })

    const rows = (lessons || []).map((l: any) => {
      if (fullAccess) return l
      const safe: Record<string, any> = { ...l }
      for (const col of SENSITIVE_COLUMNS) safe[col] = null
      safe.content_url = '' // this field is typed as a plain string in the page
      return safe
    })

    return NextResponse.json(
      { lessons: rows, access: fullAccess ? 'full' : 'preview' },
      noStore
    )
  } catch (err: any) {
    console.error('[course/lessons]', err.message)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}