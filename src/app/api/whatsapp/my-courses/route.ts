/**
 * src/app/api/whatsapp/my-courses/route.ts
 * ─────────────────────────────────────────────────────────────────
 * Backs the /wa/my-courses page — the "My Courses" button shown on
 * WhatsApp when a lesson has no notes/quiz/assignment attached.
 * Verifies the signed identity link (see lib/signer.ts
 * signMyCoursesUrl / verifyMyCoursesUrl) and returns that phone
 * number's enrollments. No Supabase login required — this is the
 * whole point, since WhatsApp-only students never create one.
 * ─────────────────────────────────────────────────────────────────
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { verifyMyCoursesUrl } from '@/lib/signer'
import { normalizePhone } from '@/lib/phone'
import { slugify } from '@/lib/utils'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(req: NextRequest) {
  try {
    const params = req.nextUrl.searchParams
    const verified = verifyMyCoursesUrl(params)
    if (!verified.valid) {
      return NextResponse.json({ valid: false, error: 'Invalid or expired link' }, { status: 403 })
    }

    const phone = normalizePhone(verified.identity) || verified.identity

    const { data: enrollments, error } = await supabase
      .from('enrollments')
      .select('id, current_lesson, completed_lessons, payment_status, enrolled_at, courses:course_uuid(id, name, host_name, total_lessons)')
      .eq('phone', phone)
      .neq('payment_status', 'refunded')
      .order('enrolled_at', { ascending: false })

    if (error) throw error

    const courses = (enrollments || [])
      .filter((e: any) => e.courses)
      .map((e: any) => ({
        enrollmentId: e.id,
        courseId: e.courses.id,
        courseName: e.courses.name,
        courseSlug: slugify(e.courses.name || 'course'),
        creatorName: e.courses.host_name || 'Creator',
        creatorSlug: slugify(e.courses.host_name || 'creator'),
        currentLesson: e.current_lesson || 1,
        completedCount: Array.isArray(e.completed_lessons) ? e.completed_lessons.length : 0,
        totalLessons: e.courses.total_lessons || 0,
        paymentStatus: e.payment_status,
      }))

    return NextResponse.json({ valid: true, courses })
  } catch (err: any) {
    console.error('[whatsapp/my-courses]', err.message)
    return NextResponse.json({ valid: false, error: 'Server error' }, { status: 500 })
  }
}