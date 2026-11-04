/**
 * src/app/api/resource/lesson/route.ts
 * Serves ONLY summary / notes / quiz fields for /resource/[lessonId].
 * Open to everyone for published lessons. Unpublished lessons are visible
 * only to the creator who owns them.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(req: NextRequest) {
  try {
    const lessonId = req.nextUrl.searchParams.get('lessonId') || ''
    if (!UUID_RE.test(lessonId)) {
      return NextResponse.json({ error: 'lessonId required' }, { status: 400 })
    }

    const { data: lesson } = await supabase
      .from('lessons')
      .select(
        'id, title, course_id, creator_id, order_num, is_published, summary_url, summary_name, notes_url, notes_name, quiz_questions'
      )
      .eq('id', lessonId)
      .maybeSingle()

    if (!lesson) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    if (lesson.is_published !== true) {
      const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim()
      let isOwner = false
      if (token) {
        const { data } = await supabase.auth.getUser(token)
        isOwner = Boolean(data?.user && data.user.id === lesson.creator_id)
      }
      if (!isOwner) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 })
      }
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