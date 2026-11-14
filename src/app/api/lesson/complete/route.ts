/**
 * src/app/api/lesson/complete/route.ts
 * ─────────────────────────────────────────────────────────────────
 * Mark a lesson complete. Called by:
 *  - Web player (enrollmentId in body)
 *  - Telegram viewer page (identity = chat_id in body)
 *
 * Also handles quiz result storage.
 * Updates current_lesson to max(existing, lessonNum+1) so progress
 * never goes backwards even if requests arrive out of order.
 * ─────────────────────────────────────────────────────────────────
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { escapeHtml, sendLoggedEmail } from '@/lib/email'
import { issueCertificate, type CertTemplate } from '@/lib/certificate'
import { normalizePhone } from '@/lib/phone'
import { getWebAccessContext } from '@/lib/webAccess'
import { getLessonLock } from '@/lib/moduleLock'
import { isLessonFree } from '@/lib/freeLesson'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const {
      identity,         // telegram_chat_id (Telegram) or phone (WhatsApp)
      enrollmentId,     // enrollment UUID — web path (preferred)
      lessonId,         // lesson UUID (for quiz tracking)
      lessonNum,        // order_num of the completed lesson
      courseId,
      source = 'web',   // 'web' | 'telegram' | 'whatsapp'
      // Optional quiz result
      quizScore,        // number of correct answers
      quizTotal,        // total questions
    } = body

    if (!lessonNum || !courseId) {
      return NextResponse.json({ error: 'lessonNum and courseId required' }, { status: 400 })
    }
    if (!identity && !enrollmentId) {
      return NextResponse.json({ error: 'identity or enrollmentId required' }, { status: 400 })
    }

    const webAccess = await getWebAccessContext(req)

    // ── Find enrollment ───────────────────────────────────────────
    let query = supabase
      .from('enrollments')
      .select(`
    id,
    course_uuid,
    payment_status,
    enrolled_at,
    completed_lessons,
    current_lesson,
    quiz_results,
    student_id,
    creator_id
  `)
      .eq('course_uuid', courseId)
      .order('enrolled_at', { ascending: false })

    if (enrollmentId) {
      query = query.eq('id', enrollmentId)
    } else if (source === 'whatsapp') {
      query = query.eq('phone', normalizePhone(identity) || String(identity))
    } else {
      query = query.eq('telegram_chat_id', String(identity))
    }



    const { data: rows, error } = await query.limit(1)
    const enrollment = rows?.[0]

    if (error || !enrollment) {
      return NextResponse.json({ error: 'Enrollment not found' }, { status: 404 })
    }

        // Only a PAID enrollment may record progress. A refunded or never-paid one must not
    // finish the course or earn a certificate.
    if (enrollment.payment_status !== 'paid') {
      return NextResponse.json({ error: 'Enrollment is not active' }, { status: 403 })
    }

    if (webAccess) {
      if (
        webAccess.courseId !== courseId ||
        webAccess.enrollment.id !== enrollment.id ||
        enrollment.payment_status !== 'paid'
      ) {
        return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
      }
    }


        // ── Module release schedule (drip) ────────────────────────────
    // A lesson whose module is still locked for this student can't be marked
    // complete — otherwise progress (and the certificate) could skip the schedule.
    // Free lessons / free courses are never held back. Fails open on missing data.
    const { data: lessonRow } = await supabase
      .from('lessons')
      .select('id, is_free')
      .eq('course_id', courseId)
      .eq('order_num', lessonNum)
      .maybeSingle()

    if (lessonRow) {
      const { data: courseRow } = await supabase
        .from('courses')
        .select('is_free_course')
        .eq('id', courseId)
        .maybeSingle()

      const free = isLessonFree(
        { is_free: lessonRow.is_free ?? false },
        { is_free_course: courseRow?.is_free_course ?? false }
      )
      if (!free) {
        const lock = await getLessonLock(supabase, lessonRow.id, [enrollment.enrolled_at])
        if (lock.locked) {
          return NextResponse.json(
            { error: 'This module is not unlocked yet', reason: 'module_locked', unlockAt: lock.unlockAt, moduleName: lock.moduleName },
            { status: 403 }
          )
        }
      }
    }

    
    // ── Update completed_lessons (idempotent) ─────────────────────
    const completed: number[] = Array.isArray(enrollment.completed_lessons)
      ? [...enrollment.completed_lessons]
      : []

    if (!completed.includes(lessonNum)) {
      completed.push(lessonNum)
    }

    // ── Update quiz_results if quiz was submitted ─────────────────
    let quizResults: any[] = Array.isArray(enrollment.quiz_results)
      ? [...enrollment.quiz_results]
      : []

    if (lessonId && typeof quizScore === 'number' && typeof quizTotal === 'number') {
      // Replace existing result for this lesson or add new
      const existingIdx = quizResults.findIndex((r: any) => r.lessonId === lessonId)
      const result = {
        lessonId,
        lessonNum,
        score: quizScore,
        total: quizTotal,
        completedAt: new Date().toISOString(),
        source,
      }
      if (existingIdx >= 0) {
        quizResults[existingIdx] = result
      } else {
        quizResults.push(result)
      }
    }

    // ── Advance current_lesson (never go backwards) ───────────────
    const newCurrentLesson = Math.max(
      enrollment.current_lesson ?? 1,
      lessonNum + 1
    )

    const syncField = source === 'telegram' ? 'last_telegram_sync' : 'last_web_sync'

    const { error: updateErr } = await supabase
      .from('enrollments')
      .update({
        completed_lessons: completed,
        current_lesson: newCurrentLesson,
        quiz_results: quizResults,
        last_accessed: new Date().toISOString(),
        [syncField]: new Date().toISOString(),
      })
      .eq('id', enrollment.id)

        if (updateErr) throw updateErr

    const { data: courseRow } = await supabase
      .from('courses')
      .select('name, creator_id, host_name, cert_enabled, cert_template, cert_palette, cert_custom_message, cert_logo_url, cert_signature_url, brand_logo_url, use_logo_on_certificate')
      .eq('id', courseId)
      .maybeSingle()

    // Count only published lessons — this is the baseline "course length" now
    // that manual total_lessons overrides are gone.
    const { count: publishedCount } = await supabase
      .from('lessons')
      .select('*', { count: 'exact', head: true })
      .eq('course_id', courseId)
      .eq('is_published', true)

    // If the creator has explicitly marked a lesson as the last one, THAT lesson
    // alone is the certificate gate. Otherwise, every published lesson must be done.
    const { data: lastLessonRow } = await supabase
      .from('lessons')
      .select('order_num')
      .eq('course_id', courseId)
      .eq('is_last_lesson', true)
      .maybeSingle()

        const plannedTotal: number = lastLessonRow ? lastLessonRow.order_num : (publishedCount ?? 0)

    // Certificate eligibility now requires an explicit "last lesson" mark —
    // no more implicit completion just from finishing every published lesson.
    const courseCompleted = !!lastLessonRow && completed.includes(lastLessonRow.order_num)

    let certResult: { certificateId: string; pdfUrl: string } | null = null

    if (courseCompleted) {
      // ── Send completion emails (idempotent via email_logs) ───────────────
      const { data: existingCompletionEmail } = await supabase
        .from('email_logs')
        .select('id')
        .eq('email_type', 'student_course_completion')
        .eq('course_id', courseId)
        .eq('student_id', enrollment.student_id)
        .limit(1)

      if (!existingCompletionEmail?.length) {
        const { data: studentRows } = await supabase
          .from('students')
          .select('email, name')
          .eq('id', enrollment.student_id)
          .limit(1)

        const course = courseRow
        const student = studentRows?.[0]
        const creatorId = enrollment.creator_id || course?.creator_id || null

        if (student?.email && creatorId) {
          await sendLoggedEmail({
            supabase,
            emailType: 'student_course_completion',
            to: student.email,
            subject: `Completed: ${course?.name || 'Your course'}`,
            creatorId,
            studentId: enrollment.student_id,
            courseId,
            metadata: {
              completed_lessons: completed.length,
              total_lessons: plannedTotal,
            },
            html: `
              <div style="font-family:Inter,Arial,sans-serif;line-height:1.5;color:#111">
                <h2 style="margin:0 0 12px">Course completed</h2>
                <p style="margin:0 0 12px">Hi ${escapeHtml(student.name || 'there')}, you completed <strong>${escapeHtml(course?.name || 'your course')}</strong>.</p>
                <p style="margin:0">Your progress is saved in Kurso.</p>
              </div>
            `,
          })
        }

        if (creatorId) {
          const { data } = await supabase.auth.admin.getUserById(creatorId)
          const creator = data?.user
          const prefs = creator?.user_metadata?.email_notifications || {}
          if (creator?.email && prefs.courseCompletion !== false) {
            await sendLoggedEmail({
              supabase,
              emailType: 'creator_course_completion',
              to: creator.email,
              subject: `Course completed: ${course?.name || 'Your course'}`,
              creatorId,
              studentId: enrollment.student_id,
              courseId,
              metadata: {
                student_name: student?.name || null,
                student_email: student?.email || null,
              },
              html: `
                <div style="font-family:Inter,Arial,sans-serif;line-height:1.5;color:#111">
                  <h2 style="margin:0 0 12px">Student completed a course</h2>
                  <p style="margin:0 0 12px"><strong>${escapeHtml(student?.name || student?.email || 'A student')}</strong> completed <strong>${escapeHtml(course?.name || 'your course')}</strong>.</p>
                  <a href="${process.env.NEXT_PUBLIC_SITE_URL || ''}/dashboard"
                    style="display:inline-block;background:#f79514;color:white;padding:10px 14px;border-radius:10px;text-decoration:none">
                    Open dashboard
                  </a>
                </div>
              `,
            })
          }
        }
      }

      // ── Auto-issue certificate (only on true completion, idempotent, non-fatal) ─
      try {
        if (courseRow?.cert_enabled !== false) {
          let certStudentName = 'Student'
          if (enrollment.student_id) {
            const { data: certStudent } = await supabase
              .from('students')
              .select('name, phone')
              .eq('id', enrollment.student_id)
              .maybeSingle()
            if (certStudent?.name?.trim()) {
              certStudentName = certStudent.name.trim()
            } else if (certStudent?.phone) {
              certStudentName = `Student ****${String(certStudent.phone).slice(-4)}`
            }
          }
          certResult = await issueCertificate(supabase, {
            enrollmentId: enrollment.id,
            courseId,
            studentId: enrollment.student_id ?? null,
            studentName: certStudentName,
            courseName: courseRow!.name,
            creatorName: courseRow!.host_name || 'Creator',
            template: (courseRow!.cert_template ?? 'classic') as CertTemplate,
            paletteId: courseRow!.cert_palette ?? 'classic-gold',
            customMessage: courseRow!.cert_custom_message ?? undefined,
            logoUrl: courseRow!.use_logo_on_certificate
              ? (courseRow!.brand_logo_url || undefined)
              : (courseRow!.cert_logo_url || undefined),
            signatureUrl: courseRow!.cert_signature_url || undefined,
          })
        }
      } catch (certErr: any) {
        // Non-fatal — certificate failure must never block lesson progress
        console.error('[lesson/complete] certificate error:', certErr.message)
      }
    }



    return NextResponse.json({
      ok: true,
      completed,
      currentLesson: newCurrentLesson,
      quizResults,
      ...(certResult
        ? { certificateIssued: true, certificateId: certResult.certificateId, certificateUrl: certResult.pdfUrl }
        : {}),
    })
  } catch (err: any) {
    console.error('[lesson/complete]', err.message)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
