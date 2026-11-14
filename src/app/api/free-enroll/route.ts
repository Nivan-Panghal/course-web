import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { sendLoggedEmail, escapeHtml } from '@/lib/email';
import { slugify } from '@/lib/utils';
import { normalizePhone } from '@/lib/phone';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function firstRow(query: any): Promise<any | null> {
  const { data, error } = await query.limit(1);
  if (error) throw error;
  return data?.[0] ?? null;
}

export async function POST(req: NextRequest) {
  try {
       const {
      courseId,
      studentId,
      studentEmail,
      studentName,
      studentPhone: rawStudentPhone,
      couponCode,
    } = await req.json();
    const studentPhone = normalizePhone(rawStudentPhone) || rawStudentPhone || null;

    if (!courseId) {
      return NextResponse.json({ error: 'Missing course ID' }, { status: 400 });
    }
    if (!studentPhone && !studentEmail) {
      return NextResponse.json({ error: 'Missing student contact' }, { status: 400 });
    }

    // Get course
    const course = await firstRow(
      supabaseAdmin
        .from('courses')
        .select('*')
        .eq('id', courseId)
    );
    if (!course) {
      return NextResponse.json({ error: 'Course not found' }, { status: 404 });
    }
    if (!course.is_published) {
      return NextResponse.json({ error: 'Course not available for enrollment' }, { status: 403 });
    }

    // Check if this is a free course or valid coupon makes it free
    let isFree = course.is_free_course === true;
    let appliedCoupon = null;

    if (!isFree && couponCode) {
      const { data: couponRows, error: couponError } = await supabaseAdmin.rpc(
        'validate_coupon_for_course',
        {
          input_course_id: courseId,
          input_coupon_code: couponCode,
        }
      );
      if (couponError) throw couponError;

      const coupon = couponRows?.[0];
      if (coupon?.valid && coupon.final_amount <= 0) {
        isFree = true;
        appliedCoupon = coupon;
      }
    }

    if (!isFree) {
      return NextResponse.json({ error: 'This course is not free' }, { status: 400 });
    }

        // Who is really calling? Only a valid login token proves "I am this student".
    // The studentId / email / phone in the body are just claims: they must never let a
    // caller change or take over somebody else's student record.
    const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    let loginUser: any = null;
    if (bearer) {
      const { data: u } = await supabaseAdmin.auth.getUser(bearer);
      loginUser = u?.user ?? null;
    }
    const trustedAuthId: string | null =
      loginUser && studentId && loginUser.id === studentId ? loginUser.id : null;
    const emailKey = studentEmail ? String(studentEmail).trim() : null;

    // Upsert student
    let student: any = null;
    let isOwnerCall = false; // true only when the caller is logged in as this very student
    if (trustedAuthId) {
      student = await firstRow(
        supabaseAdmin.from('students').select('id').eq('auth_id', trustedAuthId)
      );
      isOwnerCall = !!student;
    }
    if (!student && emailKey) {
      student = await firstRow(
        supabaseAdmin
          .from('students')
          .select('id, auth_id')
          .ilike('email', emailKey.replace(/[\\%_]/g, '\\$&'))
      );
      // A logged-in user with the same verified email may claim a student row that has
      // no login yet (for example one created earlier through WhatsApp).
      if (
        student && !student.auth_id && trustedAuthId &&
        loginUser?.email?.toLowerCase() === emailKey.toLowerCase()
      ) {
        isOwnerCall = true;
      }
    }

    if (student) {
      // Only the logged-in owner may change their own details.
      // Anonymous callers just enrol: the existing student is left exactly as it is.
      if (isOwnerCall) {
        await supabaseAdmin
          .from('students')
          .update({
            email: studentEmail || undefined,
            name: studentName || undefined,
            phone: studentPhone || undefined,
            auth_id: trustedAuthId || undefined,
          })
          .eq('id', student.id);
      }
    } else {
      const { data: inserted, error: insertErr } = await supabaseAdmin
        .from('students')
        .insert({
          email: emailKey,
          name: studentName || null,
          phone: studentPhone || null,
          auth_id: trustedAuthId,
        })
        .select('id')
        .single();
      if (insertErr) throw insertErr;
      student = inserted;
    }

    // Check existing enrollment
    const phoneOrEmail = studentPhone || studentEmail!;
    let existingEnrollment: any = null;
    if (student?.id) {
      existingEnrollment = await firstRow(
        supabaseAdmin
          .from('enrollments')
          .select('id, payment_status, delivery_method')
          .eq('course_uuid', courseId)
          .eq('student_id', student.id)
      );
    }
        if (!existingEnrollment && phoneOrEmail) {
      const phoneMatch = await firstRow(
        supabaseAdmin
          .from('enrollments')
          .select('id, payment_status, delivery_method, student_id')
          .eq('course_uuid', courseId)
          .eq('phone', phoneOrEmail)
      );
      if (phoneMatch && (!phoneMatch.student_id || phoneMatch.student_id === student?.id)) {
        existingEnrollment = phoneMatch;
      }
    }

    if (existingEnrollment && existingEnrollment.payment_status === 'paid') {
      if (existingEnrollment.delivery_method == null) {
        await supabaseAdmin
          .from('enrollments')
          .update({
            delivery_method: course.delivery || 'both',
          })
          .eq('id', existingEnrollment.id)
      }

      return NextResponse.json({
        success: true,
        alreadyEnrolled: true,
        enrollmentId: existingEnrollment.id,
      })
    }

    const now = new Date().toISOString();
    let enrollmentId: string | null = null;

    if (existingEnrollment) {
      const { error: updateErr } = await supabaseAdmin
        .from('enrollments')
        .update({
          payment_status: 'paid',
          payment_id: 'FREE',
          amount_paid: 0,
          student_id: student?.id || null,
          creator_id: course.creator_id,
          phone: phoneOrEmail,
          last_web_sync: now,
          coupon_id: appliedCoupon?.coupon_id || null,
          delivery_method:
            existingEnrollment.delivery_method || course.delivery || 'both',
        })
        .eq('id', existingEnrollment.id);

      if (updateErr) throw updateErr;
      enrollmentId = existingEnrollment.id;
    } else {
      const { data: insertedEnrollment, error: insertEnrollErr } = await supabaseAdmin
        .from('enrollments')
        .insert({
          phone: phoneOrEmail,
          course_uuid: courseId,
          current_lesson: 1,
          student_id: student?.id || null,
          creator_id: course.creator_id,
          amount_paid: 0,
          payment_id: 'FREE',
          payment_status: 'paid',
          completed_lessons: [],
          quiz_results: [],
          last_web_sync: now,
          delivery_method: course.delivery || 'both',
          coupon_id: appliedCoupon?.coupon_id || null,
        })
        .select('id')
        .single();

      if (insertEnrollErr) throw insertEnrollErr;
      enrollmentId = insertedEnrollment?.id || null;
    }

    // Create payment record for tracking
    const existingPayment = await firstRow(
      supabaseAdmin
        .from('payments')
        .select('id')
        .eq('provider', 'FREE')
        .eq('enrollment_id', enrollmentId)
    );

    let paymentRecordId = existingPayment?.id || null;

    if (!paymentRecordId) {
      const { data: paymentRecord, error: paymentInsertError } = await supabaseAdmin
        .from('payments')
        .insert({
          creator_id: course.creator_id,
          course_id: courseId,
          student_id: student?.id || null,
          enrollment_id: enrollmentId,
          provider: 'FREE',
          provider_payment_id: 'FREE',
          provider_order_id: 'FREE',
          buyer_name: studentName || null,
          buyer_email: studentEmail || null,
          buyer_phone: studentPhone || null,
          currency: 'INR',
          gross_amount: course.price,
          discount_amount: course.price,
          net_amount: 0,
          platform_fee: 0,
          creator_earning: 0,
          status: 'paid',
          metadata: {
            source: 'free_enroll',
            coupon_code: appliedCoupon?.coupon_code || null,
          },
          paid_at: now,
        })
        .select('id')
        .single();

      if (paymentInsertError) throw paymentInsertError;
      paymentRecordId = paymentRecord?.id || null;
    }

    // Redeem coupon if applicable
    if (appliedCoupon?.coupon_code && paymentRecordId) {
      const { data: redemptionRows, error: redemptionError } = await supabaseAdmin.rpc(
        'redeem_coupon_for_payment',
        {
          input_coupon_code: appliedCoupon.coupon_code,
          input_course_id: courseId,
          input_creator_id: course.creator_id,
          input_student_id: student?.id || null,
          input_enrollment_id: enrollmentId,
          input_payment_id: paymentRecordId,
        }
      );

      if (redemptionError) throw redemptionError;

      const redemption = redemptionRows?.[0];
      if (!redemption?.success) {
        console.warn('Coupon redemption failed:', redemption?.reason);
      }
    }

    // Send emails
    const { data: creatorAuthData } = await supabaseAdmin.auth.admin.getUserById(course.creator_id);
    const creatorUser = creatorAuthData?.user;
    const creatorEmail = creatorUser?.email;
    const creatorPrefs = creatorUser?.user_metadata?.email_notifications || {};

    const safeCourse = escapeHtml(course.name || 'your course');
    const safeStudent = escapeHtml(studentName || studentEmail || studentPhone || 'A student');

    if (creatorEmail && creatorPrefs.newEnrollment !== false) {
      await sendLoggedEmail({
        supabase: supabaseAdmin,
        emailType: 'creator_new_enrollment',
        to: creatorEmail,
        subject: `New enrollment: ${course.name}`,
        creatorId: course.creator_id,
        courseId: courseId,
        paymentId: paymentRecordId,
        metadata: {
          student_name: studentName || null,
          student_email: studentEmail || null,
          student_phone: studentPhone || null,
        },
        html: `
          <div style="font-family:Inter,Arial,sans-serif;line-height:1.5;color:#111">
            <h2 style="margin:0 0 12px">New student enrolled (Free)</h2>
            <p style="margin:0 0 8px"><strong>${safeStudent}</strong> enrolled in <strong>${safeCourse}</strong>.</p>
            <a href="${process.env.NEXT_PUBLIC_SITE_URL || ''}/dashboard"
              style="display:inline-block;background:#f79514;color:white;padding:10px 14px;border-radius:10px;text-decoration:none">
              Open dashboard
            </a>
          </div>
        `,
      });
    }

    if (studentEmail) {
      const creatorProfile = await firstRow(
        supabaseAdmin
          .from('creators')
          .select('telegram_bot_username, name')
          .eq('id', course.creator_id)
      );

      const safeName = escapeHtml(studentName || 'there');
      const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || '';
      const creatorSlug = slugify(creatorProfile?.name || 'instructor');
      const courseSlug = slugify(course.name || 'course');
      const courseUrl = `${siteUrl}/course/${creatorSlug}/${courseSlug}/${courseId}`;
      const cleanBot = creatorProfile?.telegram_bot_username?.replace('@', '').trim();

      await sendLoggedEmail({
        supabase: supabaseAdmin,
        emailType: 'student_welcome',
        to: studentEmail,
        subject: `Welcome to ${course.name}`,
        creatorId: course.creator_id,
        studentId: student?.id || null,
        courseId: courseId,
        paymentId: paymentRecordId,
        metadata: {
          has_telegram: Boolean(cleanBot),
          telegram_bot_username: cleanBot || null,
        },
        html: `
          <div style="font-family:Inter,Arial,sans-serif;line-height:1.5;color:#111">
            <h2 style="margin:0 0 12px">Welcome to ${safeCourse}</h2>
            <p style="margin:0 0 12px">Hi ${safeName}, your course access is ready.</p>
            <a href="${courseUrl}"
              style="display:inline-block;background:#f79514;color:white;padding:10px 14px;border-radius:10px;text-decoration:none;margin:0 0 16px">
              Start learning
            </a>
            ${cleanBot ? `
              <div style="background:#eef8ff;border:1px solid #bae6fd;border-radius:12px;padding:14px;margin-top:16px">
                <p style="margin:0 0 6px"><strong>Telegram delivery is available.</strong></p>
                <p style="margin:0">Use the Telegram button on the success screen to link your account with @${escapeHtml(cleanBot)}.</p>
              </div>
            ` : ''}
          </div>
        `,
      });
    }

    return NextResponse.json({ success: true, alreadyEnrolled: false, enrollmentId });

  } catch (err: any) {
    console.error('Free enroll error:', err);
    return NextResponse.json({ error: err.message || 'Enrollment failed' }, { status: 500 });
  }
}
