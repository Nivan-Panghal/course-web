// src/lib/student-welcome-email.ts
//
// The welcome email a student gets right after a PAID course purchase (free enrolments
// already send their own welcome from /api/free-enroll). Email is always on and free.
// Best effort: it never throws, so it can never turn a real payment into a failed webhook.
import type { SupabaseClient } from '@supabase/supabase-js'
import { escapeHtml, sendLoggedEmail } from '@/lib/email'
import { slugify } from '@/lib/utils'

export async function sendStudentWelcomeEmail(
  supabase: SupabaseClient,
  p: { courseId: string; creatorId: string; studentId?: string | null; studentEmail?: string | null; studentName?: string | null; paymentId?: string | null },
): Promise<void> {
  try {
    if (!p.studentEmail) return
    const { data: course } = await supabase.from('courses').select('id, name, delivery').eq('id', p.courseId).maybeSingle()
    if (!course) return
    const { data: creator } = await supabase.from('creators').select('name, telegram_bot_username').eq('id', p.creatorId).maybeSingle()

    const site = (process.env.NEXT_PUBLIC_SITE_URL || '').replace(/\/$/, '')
    const courseUrl = `${site}/course/${slugify(creator?.name || 'instructor')}/${slugify(course.name || 'course')}/${course.id}`
    const delivery = course.delivery || 'both'
    const usesWhatsapp = delivery === 'whatsapp' || delivery === 'both'
    const bot = delivery === 'telegram' || delivery === 'both' ? creator?.telegram_bot_username?.replace('@', '').trim() : ''
    const first = escapeHtml(String(p.studentName || 'there').trim().split(/\s+/)[0] || 'there')

    const channelNotes = [
      usesWhatsapp ? 'Your lessons also arrive on WhatsApp.' : '',
      bot ? `You can also get lessons on Telegram. Use the Telegram button on the success screen to connect with @${escapeHtml(bot)}.` : '',
    ].filter(Boolean)

    await sendLoggedEmail({
      supabase,
      emailType: 'student_welcome',
      to: p.studentEmail,
      subject: `Welcome to ${course.name}`,
      creatorId: p.creatorId,
      studentId: p.studentId || null,
      courseId: course.id,
      paymentId: p.paymentId || null,
      html: `
        <div style="font-family:Inter,Arial,sans-serif;line-height:1.5;color:#111">
          <h2 style="margin:0 0 12px">Welcome to ${escapeHtml(course.name)}</h2>
          <p style="margin:0 0 12px">Hi ${first}, your payment is confirmed and your course access is ready.</p>
          <a href="${courseUrl}" style="display:inline-block;background:#f79514;color:white;padding:10px 14px;border-radius:10px;text-decoration:none;margin:0 0 16px">Start learning</a>
          ${channelNotes.map(n => `<p style="margin:12px 0 0;color:#374151">${n}</p>`).join('')}
        </div>`,
    })
  } catch (err) {
    console.error('[student welcome email]', err)
  }
}