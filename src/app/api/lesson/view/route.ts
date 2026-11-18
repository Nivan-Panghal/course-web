/**
 * app/api/lesson/view/route.ts
 * ─────────────────────────────────────────────────────────────────
 * Entry point for Telegram lesson links.
 * Telegram bot sends:  https://yourapp.com/api/lesson/view?...signed params
 *
 * This route:
 *  1. Verifies the signed URL
 *  2. Verifies enrollment in Supabase
 *  3. Logs access (piracy detection)
 *  4. Returns HTML page with the lesson content — watermarked
 *     (video uses /api/video/stream, PDF uses /api/pdf/view)
 *
 * Rendering itself lives in src/lib/lessonPageHtml.ts, shared with the
 * WhatsApp lesson route (src/app/api/whatsapp/lesson/route.ts) so both
 * platforms get identical watermarking, controls, and content-type
 * handling (video/pdf/quiz/assignment/live) instead of two diverging
 * implementations.
 * ─────────────────────────────────────────────────────────────────
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { verifyLessonPageUrl, signVideoUrl, signPdfUrl, encodeFingerprint, signLessonResourceUrl } from '@/lib/signer'
import { renderLessonPage } from '@/lib/lessonPageHtml'
import { getLessonLock } from '@/lib/moduleLock'
import { isLessonFree } from '@/lib/freeLesson'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function logAccess(lessonId: string, courseId: string, identity: string) {
  try {
    await supabase.from('lesson_access_logs').insert({
      chat_id: identity,
      lesson_id: lessonId,
      course_id: courseId,
      accessed_at: new Date().toISOString(),
    })
  } catch {
    // non-critical
  }
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams

  const expParam = params.get('exp')
  const hasAllParams = !!(
    params.get('courseId') && params.get('lessonId') &&
    params.get('lesson') && params.get('identity') &&
    expParam && params.get('sig')
  )

  if (!hasAllParams) {
    return new NextResponse(invalidLinkHtml(), {
      status: 400,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  }

  if (Date.now() > parseInt(expParam, 10)) {
    return new NextResponse(expiredHtml(), {
      status: 410,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  }

  const { valid, courseId, lessonId, lessonNum, identity } = verifyLessonPageUrl(params)

  if (!valid) {
    return new NextResponse(invalidLinkHtml(), {
      status: 403,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  }

  const { data: lesson } = await supabase
    .from('lessons')
    .select(`
      id, title, content_type, order_num, duration, is_published, course_id, is_free,
      summary_url, notes_url, quiz_questions, qa_enabled,
      assignment_prompt, assignment_required, assignment_file_url, assignment_file_name,
      content_url, live_scheduled_at, live_recording_url, live_duration_minutes
    `)
    .eq('id', lessonId)
    .single()

  if (!lesson || !lesson.is_published) {
    return new NextResponse(notFoundHtml(), {
      status: 404,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  }

  const { data: course } = await supabase
    .from('courses')
    .select('id, name, host_name, creator_id, is_free_course')
    .eq('id', courseId)
    .single()

  let studentName = `User ${identity.slice(-6)}`
  const { data: enrollment } = await supabase
    .from('enrollments')
    .select('phone, payment_status, enrolled_at, completed_lessons, quiz_results')
    .eq('telegram_chat_id', identity)
    .eq('course_uuid', courseId)
    .limit(1)
    .single()

  if (enrollment?.phone) studentName = enrollment.phone

  // Rule (c): a refund removes access at once, even for a link that has not expired yet.
  if (enrollment?.payment_status === 'refunded') {
    return new NextResponse(invalidLinkHtml(), {
      status: 403,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, private' },
    })
  }

  // Module release schedule (drip). Links signed before a module was locked stay
  // cryptographically valid for their 2h lifetime, so the lock is enforced here too.
  if (!isLessonFree({ is_free: lesson.is_free ?? false }, { is_free_course: course?.is_free_course ?? false })) {
    const lock = await getLessonLock(supabase, lessonId, [enrollment?.enrolled_at ?? null])
    if (lock.locked) {
      return new NextResponse(moduleLockedHtml(lock.unlockAt), {
        status: 403,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, private' },
      })
    }
  }

  logAccess(lessonId, courseId, identity)

  const contentUrl =
    lesson.content_type === 'video' ? signVideoUrl(lessonId, identity) :
    lesson.content_type === 'pdf' ? signPdfUrl(lessonId, identity) :
    null

  const fingerprint = encodeFingerprint(identity)

  const summaryUrl = lesson.summary_url ? signLessonResourceUrl(lesson.id, 'summary', identity) : null
  const notesUrl = lesson.notes_url ? signLessonResourceUrl(lesson.id, 'notes', identity) : null
  const quizUrl = (Array.isArray(lesson.quiz_questions) && lesson.quiz_questions.length > 0)
    ? signLessonResourceUrl(lesson.id, 'quiz', identity)
    : null
  const qaUrl = lesson.qa_enabled !== false ? signLessonResourceUrl(lesson.id, 'qa', identity) : null

  const quizResult = Array.isArray(enrollment?.quiz_results)
    ? enrollment.quiz_results.find((r: any) => r.lessonId === lesson.id)
    : null

  const isCompleted = Array.isArray(enrollment?.completed_lessons) && enrollment.completed_lessons.includes(lesson.order_num)

  let telegramBotUsername = ''
  if (course?.creator_id) {
    const { data: creator } = await supabase
      .from('creators')
      .select('telegram_bot_username')
      .eq('id', course.creator_id)
      .single()
    if (creator?.telegram_bot_username) {
      telegramBotUsername = creator.telegram_bot_username.replace('@', '')
    }
  }

  const { data: reminderRow } = enrollment?.phone
    ? await supabase
        .from('students')
        .select('reminder_channel')
        .eq('phone', enrollment.phone)
        .maybeSingle()
    : { data: null }

  const html = renderLessonPage({
    reminderChannel: reminderRow?.reminder_channel ?? null,
    platform: 'telegram',
    lesson,
    course: course ? { id: course.id, name: course.name } : null,
    studentName,
    identity,
    contentUrl,
    fingerprint,
    summaryUrl,
    notesUrl,
    quizUrl,
    qaUrl,
    quizResult: quizResult || null,
    isCompleted,
    ctaUrl: telegramBotUsername ? `https://t.me/${telegramBotUsername}?start=done_${lesson.order_num}` : null,
    ctaLabel: 'Continue on Telegram',
    ctaColor: '#229ED9',
  })

  return new NextResponse(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, private',
      'X-Frame-Options': 'SAMEORIGIN',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

function expiredHtml() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link Expired</title>
  <style>body{background:#080808;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center;padding:24px}</style></head>
  <body><div><div style="font-size:48px;margin-bottom:16px">⏱</div><h2 style="margin-bottom:12px">Link Expired</h2>
  <p style="color:#71717a;margin-bottom:24px">This lesson link has expired. Go back to Telegram and tap the lesson button to get a fresh link.</p>
  </div></body></html>`
}

function invalidLinkHtml() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link Not Valid</title>
  <style>body{background:#080808;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center;padding:24px}</style></head>
  <body><div><div style="font-size:48px;margin-bottom:16px">⚠️</div><h2 style="margin-bottom:12px">Link Not Valid</h2>
  <p style="color:#71717a;margin-bottom:24px">This lesson link could not be verified. Go back to Telegram and tap the lesson button to get a fresh link. If this keeps happening, please let your instructor know — there may be a configuration issue.</p>
  </div></body></html>`
}

function moduleLockedHtml(unlockAt: string) {
  const when = new Date(unlockAt).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
  })
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not unlocked yet</title>
  <style>body{background:#080808;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center;padding:24px}</style></head>
  <body><div><div style="font-size:48px;margin-bottom:16px">🔒</div><h2 style="margin-bottom:12px">This module isn't unlocked yet</h2>
  <p style="color:#71717a">It unlocks on ${when} IST.</p>
  </div></body></html>`
}

function notFoundHtml() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not Found</title>
  <style>body{background:#080808;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center;padding:24px}</style></head>
  <body><div><div style="font-size:48px;margin-bottom:16px">🔍</div><h2 style="margin-bottom:12px">Lesson Not Found</h2>
  <p style="color:#71717a">This lesson may not be published yet. Contact your instructor.</p>
  </div></body></html>`
}