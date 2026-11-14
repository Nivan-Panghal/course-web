/**
 * src/app/api/resource/lesson/route.ts
 * Serves ONLY summary / notes / quiz fields for /resource/[lessonId].
 * Allowed for: free lessons, the owning creator, a valid signed link (WhatsApp/Telegram),
 * or a logged-in student with a PAID enrollment. Unpublished lessons: owner only.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { verifyLessonResourceUrl } from '@/lib/signer'
import { normalizePhone } from '@/lib/phone'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function hasPaidEnrollment(courseId: string, user: any): Promise<boolean> {
  const paid = () =>
    supabase.from('enrollments').select('id').eq('course_uuid', courseId).eq('payment_status', 'paid').limit(1)

  const { data: student } = await supabase.from('students').select('id').eq('auth_id', user.id).maybeSingle()
  if (student?.id) {
    const { data } = await paid().eq('student_id', student.id)
    if (data?.length) return true
  }
  const phones = Array.from(
    new Set(
      [user.user_metadata?.phone, user.phone]
        .filter(Boolean)
        .flatMap((p: any) => [String(p), normalizePhone(String(p))])
        .filter(Boolean) as string[]
    )
  )
  for (const p of phones) {
    const { data } = await paid().eq('phone', p)
    if (data?.length) return true
  }
  if (user.email) {
    const { data } = await paid().eq('phone', user.email)
    if (data?.length) return true
  }
  return false
}

export async function GET(req: NextRequest) {
  try {
    const lessonId = req.nextUrl.searchParams.get('lessonId') || ''
    if (!UUID_RE.test(lessonId)) {
      return NextResponse.json({ error: 'lessonId required' }, { status: 400 })
    }

    const { data: lesson } = await supabase
      .from('lessons')
      .select(
        'id, title, course_id, creator_id, order_num, is_free, is_published, summary_url, summary_name, notes_url, notes_name, quiz_questions'
      )
      .eq('id', lessonId)
      .maybeSingle()

    if (!lesson) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    // Who is calling?
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim()
    let user: any = null
    if (token) {
      const { data } = await supabase.auth.getUser(token)
      user = data?.user ?? null
    }
    const isOwner = Boolean(user && user.id === lesson.creator_id)

    if (lesson.is_published !== true && !isOwner) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const { data: course } = await supabase
      .from('courses')
      .select('is_free_course')
      .eq('id', lesson.course_id)
      .maybeSingle()

    let allowed = lesson.is_free === true || course?.is_free_course === true || isOwner
    if (!allowed && verifyLessonResourceUrl(lessonId, req.nextUrl.searchParams).valid) allowed = true
    if (!allowed && user) allowed = await hasPaidEnrollment(lesson.course_id, user)

    if (!allowed) {
      return NextResponse.json({ error: 'Not allowed' }, { status: 403 })
    }

    return NextResponse.json(
      {
        lesson: {
          id: lesson.id,
          title: lesson.title,
          course_id: lesson.course_id,
          order_num: lesson.order_num,
          summary_url: lesson.summary_url,
          summary_name: lesson.summary_name,
          notes_url: lesson.notes_url,
          notes_name: lesson.notes_name,
          quiz_questions: lesson.quiz_questions,
        },
      },
      { headers: { 'Cache-Control': 'no-store' } }
    )
  } catch (err: any) {
    console.error('[resource/lesson]', err.message)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}