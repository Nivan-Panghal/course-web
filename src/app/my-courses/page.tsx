'use client'
import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  Shield, BookOpen, CheckCircle, Clock, TrendingUp,
  Play, ChevronRight, User, Award, LayoutDashboard,
  LogOut, MessageCircle, Layers, Download, ExternalLink,
} from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useWhatsAppNumbers } from '@/lib/use-whatsapp-number'
import { resolveAccountType } from '@/lib/account'
import { slugify } from '@/lib/utils'
import RefundRequestButton from '@/components/RefundRequestButton'

interface EnrolledCourse {
  enrollmentId: string
  courseId: string
  creatorId: string
  courseName: string
  courseSlug: string
  creatorName: string
  enrolledAt: string
  currentLesson: number
  completedLessons: number[]
  totalLessons: number
  telegramToken: string | null
  telegramTokenExpiresAt: string | null
  whatsappToken: string | null
  whatsappTokenExpiresAt: string | null
  certificateId: string | null
  certificateUrl: string | null
  hasRated: boolean
  telegramBotUsername: string | null
  payment_status: string
  deliveryMethod: string | null
}

async function downloadInvoice(enrollmentId: string) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) return
  const res = await fetch(`/api/student/invoice?enrollmentId=${enrollmentId}`, {
    headers: { Authorization: `Bearer ${session.access_token}` },
  })
  if (!res.ok) {
    alert('Could not download invoice. Please try again.')
    return
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'invoice.pdf'
  a.click()
  URL.revokeObjectURL(url)
}
function ProgressRing({ pct, size = 48 }: { pct: number; size?: number }) {
  const r = (size - 6) / 2
  const circ = 2 * Math.PI * r
  const offset = circ - (pct / 100) * circ
  const color = pct >= 100 ? '#4ade80' : 'var(--kurso-primary-light)'
  return (
    <svg width={size} height={size} style={{ flexShrink: 0 }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={5} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={5}
        strokeDasharray={circ} strokeDashoffset={offset}
        strokeLinecap="round" transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dashoffset 0.6s ease' }} />
      <text x="50%" y="50%" dominantBaseline="middle" textAnchor="middle"
        style={{ fontSize: size < 48 ? 9 : 11, fontWeight: 800, fill: color }}>
        {pct}%
      </text>
    </svg>
  )
}

function SkeletonCard() {
  return (
    <div style={{ borderRadius: 16, border: '1px solid rgba(255,255,255,0.06)', padding: '24px', background: 'rgba(255,255,255,0.02)' }}>
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <div style={{ height: 12, width: '40%', borderRadius: 6, background: 'rgba(255,255,255,0.06)', marginBottom: 10 }} className="animate-pulse" />
          <div style={{ height: 20, width: '70%', borderRadius: 6, background: 'rgba(255,255,255,0.08)', marginBottom: 8 }} className="animate-pulse" />
          <div style={{ height: 12, width: '30%', borderRadius: 6, background: 'rgba(255,255,255,0.05)' }} className="animate-pulse" />
        </div>
        <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'rgba(255,255,255,0.06)' }} className="animate-pulse" />
      </div>
      <div style={{ height: 4, borderRadius: 4, background: 'rgba(255,255,255,0.05)', marginTop: 18 }} className="animate-pulse" />
    </div>
  )
}

export default function MyCoursesPage() {
  const router = useRouter()
  const [user, setUser] = useState<any>(null)
  const [courses, setCourses] = useState<EnrolledCourse[]>([])
  const waNumbers = useWhatsAppNumbers(courses.map(c => c.courseId)) // each course's creator may have their own number
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
    const [certGenerating, setCertGenerating] = useState<Set<string>>(new Set())
  const [ratingDrafts, setRatingDrafts] = useState<Record<string, { rating: number; reviewText: string }>>({})
  const [ratingSubmitting, setRatingSubmitting] = useState<Set<string>>(new Set())
  const [ratingError, setRatingError] = useState<Record<string, string>>({})
  const botUsername = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME || ''
  const displayName = user?.user_metadata?.full_name || user?.user_metadata?.name || ''
  const displayEmail = user?.email || ''

  useEffect(() => {
    async function load() {
      const { data: { user: me } } = await supabase.auth.getUser()
      if (!me) {
        router.push('/login?redirect=/my-courses')
        return
      }
      const accountType = await resolveAccountType(me)
      if (accountType === 'creator') {
        router.push('/dashboard')
        return
      }
      setUser(me)

      try {
        // Look up the student record
        const { data: studentRow } = await supabase
          .from('students')
          .select('id')
          .eq('auth_id', me.id)
          .limit(1)
          .maybeSingle()

        // Build a deduplicated list of enrollments across all identifier strategies
        const seen = new Set<string>()
        const allEnrollments: any[] = []

        async function absorb(query: any) {
          const { data } = await query
          if (!data) return
          for (const e of data) {
            if (!seen.has(e.course_uuid)) {
              seen.add(e.course_uuid)
              allEnrollments.push(e)
            }
          }
        }
        const baseSelect = 'id, course_uuid, current_lesson, completed_lessons, enrolled_at, telegram_start_token, telegram_start_token_expires_at, whatsapp_start_token, whatsapp_start_token_expires_at, payment_status, amount_paid, certificate_id, certificate_url, delivery_method'

        function makeBase() {
          return supabase
            .from('enrollments')
            .select(baseSelect)
            .order('enrolled_at', { ascending: false })
        }

        const fetches: Promise<void>[] = []

        if (studentRow?.id) {
          fetches.push(absorb(makeBase().eq('student_id', studentRow.id)))
        }

        const phones: string[] = [
          me.user_metadata?.phone,
          me.phone,
        ].filter(Boolean) as string[]

        for (const p of phones) {
          fetches.push(absorb(makeBase().eq('phone', p)))
        }

        if (me.email) {
          fetches.push(absorb(makeBase().eq('phone', me.email)))
        }

        await Promise.all(fetches)



        if (allEnrollments.length === 0) {
          setLoading(false)
          return
        }

        const courseIds = allEnrollments.map(e => e.course_uuid)
        const enrollmentIds = allEnrollments.map(e => e.id)

        // Fetch course metadata, published lesson counts, each course's
        // marked "last lesson" order_num, and which enrollments already
        // have a rating, all in parallel. `total_lessons` on the course
        // row is a stale column no longer kept in sync — the real total
        // is the last-lesson mark (same value certificate issuance uses),
        // or the published-lesson count if no lesson is marked last.
        const [{ data: courseData }, { data: lessonData }, { data: lastLessonData }, { data: ratingData }] = await Promise.all([
          supabase
            .from('courses')
            .select('id, name, slug, host_name, creator_id, delivery')
            .in('id', courseIds),
          supabase
            .from('lessons')
            .select('course_id')
            .in('course_id', courseIds)
            .eq('is_published', true),
          supabase
            .from('lessons')
            .select('course_id, order_num')
            .in('course_id', courseIds)
            .eq('is_last_lesson', true),
          supabase
            .from('course_ratings')
            .select('enrollment_id')
            .in('enrollment_id', enrollmentIds),
        ])

        const ratedEnrollmentIds = new Set((ratingData || []).map(r => r.enrollment_id))
        const lessonCountByCourse: Record<string, number> = {}
        for (const l of lessonData || []) {
          lessonCountByCourse[l.course_id] = (lessonCountByCourse[l.course_id] || 0) + 1
        }

        const lastLessonOrderByCourse: Record<string, number> = {}
        for (const l of lastLessonData || []) {
          lastLessonOrderByCourse[l.course_id] = l.order_num
        }

        const courseById: Record<string, any> = {}
        for (const c of courseData || []) courseById[c.id] = c

        const enriched: EnrolledCourse[] = allEnrollments
          .map(e => {
            const c = courseById[e.course_uuid]
            if (!c) return null
            const published = lessonCountByCourse[e.course_uuid] || 0
            const total = lastLessonOrderByCourse[e.course_uuid] || published
            return {
              enrollmentId: e.id,
              courseId: c.id,
              courseName: c.name,
              courseSlug: c.slug || '',
              creatorName: c.host_name || 'Creator',
              enrolledAt: e.enrolled_at,
              currentLesson: e.current_lesson || 1,
              completedLessons: Array.isArray(e.completed_lessons) ? e.completed_lessons : [],
              totalLessons: total,
              creatorId: c.creator_id || '',
              telegramToken: e.telegram_start_token || null,
              telegramTokenExpiresAt: e.telegram_start_token_expires_at || null,
              whatsappToken: e.whatsapp_start_token || null,
              whatsappTokenExpiresAt: e.whatsapp_start_token_expires_at || null,
              certificateId: e.certificate_id || null,
              certificateUrl: e.certificate_url || null,
              hasRated: ratedEnrollmentIds.has(e.id),
              telegramBotUsername: process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME || null,
              payment_status: e.payment_status || 'free',
              // No-leakage: prefer the enrollment's own snapshot; fall back to the
              // course's current value for enrollments created before this column existed.
              deliveryMethod: e.delivery_method || c.delivery || 'both',
            }
          })
          .filter(Boolean) as EnrolledCourse[]

        setCourses(enriched)
      } catch (err: any) {
        setError(err.message || 'Failed to load courses')
      }
      setLoading(false)
    }
    load()
  }, [])

  // ── Auto-refresh expired / missing tokens on page load ──────────────────────
  // Runs once after courses load. Silently regenerates any token that is missing
  // or will expire within the next 30 minutes, then saves the fresh token back
  // to the enrollment row so every page sees the same link.
  const tokenRefreshRef = useRef(false)
  useEffect(() => {
    if (loading || tokenRefreshRef.current || courses.length === 0 || !user) return
    tokenRefreshRef.current = true

    const botUsername = (process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME || '').replace('@', '')
    const waNumber = process.env.NEXT_PUBLIC_WHATSAPP_NUMBER || ''
    const THRESHOLD_MS = 30 * 60 * 1000  // refresh if < 30 min left

    async function refreshOne(c: EnrolledCourse) {
      const now = Date.now()
      const tgExpiry = c.telegramTokenExpiresAt ? new Date(c.telegramTokenExpiresAt).getTime() : 0
      const waExpiry = c.whatsappTokenExpiresAt ? new Date(c.whatsappTokenExpiresAt).getTime() : 0

      const needsTg = botUsername && (!c.telegramToken || tgExpiry - now < THRESHOLD_MS)
      const needsWa = waNumber && (!c.whatsappToken || waExpiry - now < THRESHOLD_MS)
      if (!needsTg && !needsWa) return null

      const phone = user.user_metadata?.phone || ''
      const email = user.email || ''
      const name = user.user_metadata?.full_name || user.user_metadata?.name || ''
      const updates: Partial<EnrolledCourse> = {}

      const jobs: Promise<void>[] = []

      if (needsTg) {
        jobs.push(
          fetch('/api/telegram/create-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              studentId: user.id, studentPhone: phone, studentEmail: email,
              studentName: name, creatorId: c.creatorId, courseId: c.courseId, paymentId: null,
            }),
          })
            .then(r => r.json())
            .then(({ token, expiresAt }) => {
              if (!token) return
              updates.telegramToken = token
              updates.telegramTokenExpiresAt = expiresAt
              fetch('/api/telegram/save-enrollment-token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enrollmentId: c.enrollmentId, token, expiresAt }),
              }).catch(() => { })
            })
            .catch(() => { })
        )
      }

      if (needsWa) {
        jobs.push(
          fetch('/api/whatsapp/create-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              studentId: user.id, studentPhone: phone, studentEmail: email,
              studentName: name, creatorId: c.creatorId, courseId: c.courseId, paymentId: null,
            }),
          })
            .then(r => r.json())
            .then(({ token, expiresAt }) => {
              if (!token) return
              updates.whatsappToken = token
              updates.whatsappTokenExpiresAt = expiresAt
              fetch('/api/whatsapp/save-enrollment-token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enrollmentId: c.enrollmentId, token, expiresAt }),
              }).catch(() => { })
            })
            .catch(() => { })
        )
      }

      await Promise.all(jobs)
      return Object.keys(updates).length > 0 ? { courseId: c.courseId, updates } : null
    }

    async function doRefresh() {
      const results = await Promise.allSettled(courses.map(refreshOne))
      const patches = results
        .filter((r): r is PromiseFulfilledResult<{ courseId: string; updates: Partial<EnrolledCourse> } | null> =>
          r.status === 'fulfilled' && r.value !== null
        )
        .map(r => r.value!)

      if (patches.length === 0) return
      setCourses(prev =>
        prev.map(c => {
          const patch = patches.find(p => p.courseId === c.courseId)
          return patch ? { ...c, ...patch.updates } : c
        })
      )
    }

    doRefresh().catch(() => { })
  }, [loading, user, courses.length])



  function getProgress(c: EnrolledCourse) {
    if (!c.totalLessons) return 0
    return Math.min(Math.round((c.completedLessons.length / c.totalLessons) * 100), 100)
  }

  function getStatus(c: EnrolledCourse) {
    const p = getProgress(c)
    if (p >= 100) return { label: 'Completed', bg: 'rgba(74,222,128,0.1)', color: '#4ade80' }
    if (c.completedLessons.length > 0 || c.currentLesson > 1) return { label: 'In Progress', bg: 'rgba(139,92,246,0.1)', color: 'var(--kurso-primary-light)' }
    return { label: 'Just Started', bg: 'rgba(250,204,21,0.08)', color: '#facc15' }
  }

  function getCourseUrl(c: EnrolledCourse) {
    const creator = slugify(c.creatorName || 'instructor')
    const course = c.courseSlug || slugify(c.courseName)
    return `/course/${creator}/${course}/${c.courseId}?lesson=${c.currentLesson || 1}`
  }

  async function requestCertificate(c: EnrolledCourse) {
    console.log('[my-courses] requestCertificate called for:', { enrollmentId: c.enrollmentId, courseId: c.courseId })
    setCertGenerating(prev => new Set(prev).add(c.enrollmentId))
    try {
      const payload = { enrollmentId: c.enrollmentId, courseId: c.courseId }
      console.log('[my-courses] Sending certificate request:', payload)

      const res = await fetch(`/api/certificate/issue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      console.log('[my-courses] Response status:', res.status, res.statusText)

      const data = await res.json()
      console.log('[my-courses] Response data:', data)

      if (!res.ok) {
        console.error('[my-courses] API returned error:', res.status, data)
        return
      }

      if ((data.issued || data.alreadyIssued) && data.pdfUrl) {
        console.log('[my-courses] Certificate issued successfully')
        setCourses(prev => prev.map(course =>
          course.enrollmentId === c.enrollmentId
            ? { ...course, certificateId: data.certificateId, certificateUrl: data.pdfUrl }
            : course
        ))
      } else {
        console.warn('[my-courses] Certificate not ready:', data)
      }
        } catch (err) {
      console.error('[my-courses] Error calling certificate API:', err)
    }
    setCertGenerating(prev => { const s = new Set(prev); s.delete(c.enrollmentId); return s })
  }

  async function submitRating(c: EnrolledCourse, rating: number, reviewText: string) {
    setRatingSubmitting(prev => new Set(prev).add(c.enrollmentId))
    setRatingError(prev => { const n = { ...prev }; delete n[c.enrollmentId]; return n })
    try {
      const res = await fetch('/api/student/ratings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enrollmentId: c.enrollmentId,
          courseId: c.courseId,
          rating,
          reviewText: reviewText.trim() || null,
        }),
      })
      if (res.ok) {
        setCourses(prev => prev.map(course =>
          course.enrollmentId === c.enrollmentId ? { ...course, hasRated: true } : course
        ))
      } else {
        const data = await res.json().catch(() => ({}))
        setRatingError(prev => ({ ...prev, [c.enrollmentId]: data.error || 'Could not submit rating.' }))
      }
    } catch {
      setRatingError(prev => ({ ...prev, [c.enrollmentId]: 'Could not submit rating. Please try again.' }))
    }
    setRatingSubmitting(prev => { const s = new Set(prev); s.delete(c.enrollmentId); return s })
  }

  function getTelegramLink(c: EnrolledCourse, botUsername?: string) {
    if (!botUsername || !c.telegramToken) return null
    if (c.telegramTokenExpiresAt && new Date(c.telegramTokenExpiresAt) < new Date()) return null
    return `https://t.me/${botUsername.replace('@', '')}?start=${c.telegramToken}`
  }


  const completedCount = courses.filter(c => getProgress(c) >= 100).length
  const inProgressCount = courses.filter(c => { const p = getProgress(c); return p > 0 && p < 100 }).length
  const totalLessonsDone = courses.reduce((sum, c) => sum + c.completedLessons.length, 0)

  return (
    <div style={{ minHeight: '100vh', background: '#080808', fontFamily: "'DM Sans', sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700;800&display=swap');
        * { box-sizing: border-box; }
      `}</style>

      {/* Nav */}
      <nav style={{
        height: 54, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 24px', borderBottom: '1px solid rgba(255,255,255,0.06)',
        background: 'rgba(8,8,8,0.97)', backdropFilter: 'blur(16px)',
        position: 'sticky', top: 0, zIndex: 50,
      }}>
        <Link href="/" style={{ display: 'flex', alignItems: 'center', gap: 8, textDecoration: 'none' }}>
          <div style={{ width: 28, height: 28, borderRadius: 8, background: 'linear-gradient(135deg,var(--kurso-primary),var(--kurso-secondary))', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Shield className="w-3.5 h-3.5 text-white" />
          </div>
          <span style={{ fontWeight: 700, color: '#fff', fontSize: 14 }}>Kurso</span>
        </Link>
        <button
          onClick={async () => { await supabase.auth.signOut(); router.push('/') }}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 8, fontSize: 12, color: '#71717a', background: 'none', border: '1px solid rgba(255,255,255,0.07)', cursor: 'pointer' }}>
          <LogOut className="w-3.5 h-3.5" /> Sign out
        </button>
      </nav>

      <div style={{ maxWidth: 760, margin: '0 auto', padding: '40px 20px 80px' }}>

        {/* User info header */}
        <div style={{ marginBottom: 36 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 6 }}>
            <div style={{
              width: 44, height: 44, borderRadius: 12,
              background: 'linear-gradient(135deg,var(--kurso-primary),var(--kurso-secondary))',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 18, fontWeight: 700, color: '#fff', flexShrink: 0,
            }}>
              {displayName ? displayName.charAt(0).toUpperCase() : displayEmail.charAt(0).toUpperCase()}
            </div>
            <div>
              {displayName && (
                <p style={{ fontSize: 18, fontWeight: 700, color: '#fff', margin: 0 }}>{displayName}</p>
              )}
              <p style={{ fontSize: 13, color: '#71717a', margin: 0 }}>{displayEmail}</p>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', margin: '16px 0 4px' }}>
            <h1 style={{ fontSize: 26, fontWeight: 800, color: '#fff', margin: 0 }}>
              My Learning
            </h1>
            <Link href="/my-schedule" style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              fontSize: 12, fontWeight: 700, color: 'var(--kurso-primary-lighter)',
              textDecoration: 'none', padding: '5px 12px', borderRadius: 8,
              background: 'rgba(var(--kurso-primary-rgb), 0.1)',
              border: '1px solid rgba(var(--kurso-primary-rgb), 0.2)',
            }}>
              📅 My Schedule
            </Link>
          </div>
          <p style={{ fontSize: 13, color: '#52525b', margin: 0 }}>
            {loading
              ? 'Loading your courses…'
              : courses.length === 0
                ? 'No enrollments yet.'
                : `${courses.length} course${courses.length !== 1 ? 's' : ''} · ${courses.filter(c => getProgress(c) >= 100).length} completed`
            }
          </p>
        </div>

        {/* Error */}
        {error && (
          <div style={{ padding: '12px 16px', borderRadius: 10, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', color: '#f87171', fontSize: 13, marginBottom: 24 }}>
            {error}
          </div>
        )}

        {/* Loading skeletons */}
        {loading && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {[1, 2].map(i => (
              <div key={i} style={{ height: 110, borderRadius: 14, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', animation: 'pulse 1.5s ease-in-out infinite' }} />
            ))}
          </div>
        )}

        {/* Empty state — no browse button */}
        {!loading && !error && courses.length === 0 && (
          <div style={{ textAlign: 'center', padding: '64px 20px' }}>
            <div style={{
              width: 56, height: 56, borderRadius: 16,
              background: 'rgba(var(--kurso-primary-rgb), 0.08)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.15)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px',
            }}>
              <BookOpen className="w-6 h-6" style={{ color: '#6d28d9' }} />
            </div>
            <p style={{ fontSize: 16, fontWeight: 600, color: '#e4e4e7', marginBottom: 8 }}>No courses yet</p>
            <p style={{ fontSize: 13, color: '#52525b', maxWidth: 280, margin: '0 auto' }}>
              Once you enroll in a course, your progress will appear here.
            </p>
          </div>
        )}

        {/* Course cards */}
        {!loading && courses.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {courses.map(c => {
              const progress = getProgress(c)
              const isComplete = progress >= 100
              const isPaid = c.payment_status === 'paid'
              const courseUrl = getCourseUrl(c)
              const hasValidToken = c.telegramToken && c.telegramTokenExpiresAt && new Date(c.telegramTokenExpiresAt) > new Date()

              return (
                <div key={c.enrollmentId} style={{
                  borderRadius: 14,
                  background: 'rgba(255,255,255,0.02)',
                  border: isComplete
                    ? '1px solid rgba(74,222,128,0.2)'
                    : '1px solid rgba(255,255,255,0.07)',
                  overflow: 'hidden',
                  transition: 'border-color 0.2s',
                }}
                  onMouseEnter={e => (e.currentTarget.style.borderColor = isComplete ? 'rgba(74,222,128,0.35)' : 'rgba(var(--kurso-primary-rgb), 0.3)')}
                  onMouseLeave={e => (e.currentTarget.style.borderColor = isComplete ? 'rgba(74,222,128,0.2)' : 'rgba(255,255,255,0.07)')}
                >
                  <div style={{ padding: '18px 20px' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap' }}>

                      {/* Left: info */}
                      <div style={{ flex: 1, minWidth: 0 }}>

                        {/* Badges row */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
                          {isComplete ? (
                            <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: 'rgba(74,222,128,0.1)', color: '#4ade80', border: '1px solid rgba(74,222,128,0.2)', letterSpacing: '0.04em' }}>
                              ✓ COMPLETE
                            </span>
                          ) : (
                            <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: 'rgba(var(--kurso-primary-rgb), 0.1)', color: 'var(--kurso-primary-lighter)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.2)', letterSpacing: '0.04em' }}>
                              IN PROGRESS
                            </span>
                          )}
                          <span style={{
                            fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20, letterSpacing: '0.04em',
                            background: isPaid ? 'rgba(34,197,94,0.08)' : 'rgba(245,158,11,0.08)',
                            color: isPaid ? '#22c55e' : 'var(--kurso-accent)',
                            border: isPaid ? '1px solid rgba(34,197,94,0.2)' : '1px solid rgba(245,158,11,0.2)',
                          }}>
                            {isPaid ? 'PAID' : 'FREE PREVIEW'}
                          </span>
                          <span style={{ fontSize: 11, color: '#3f3f46' }}>
                            {c.creatorName}
                          </span>
                        </div>

                        {/* Course name */}
                        <p style={{ fontSize: 15, fontWeight: 700, color: '#fff', margin: '0 0 6px', lineHeight: 1.3 }}>
                          {c.courseName}
                        </p>

                        {/* Lessons count */}
                        <p style={{ fontSize: 12, color: '#52525b', margin: 0 }}>
                          {c.completedLessons.length} of {c.totalLessons} lessons complete
                          {c.enrolledAt && (
                            <span style={{ marginLeft: 10 }}>
                              · Enrolled {new Date(c.enrolledAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                            </span>
                          )}
                        </p>
                      </div>

                      {/* Right: progress + CTA */}
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8, flexShrink: 0 }}>
                        <span style={{ fontSize: 22, fontWeight: 800, color: isComplete ? '#4ade80' : '#fff', lineHeight: 1 }}>
                          {progress}%
                        </span>
                        <Link href={courseUrl} style={{
                          display: 'flex', alignItems: 'center', gap: 5,
                          padding: '7px 14px', borderRadius: 8,
                          background: isComplete ? 'rgba(74,222,128,0.08)' : 'linear-gradient(135deg,var(--kurso-primary),var(--kurso-secondary))',
                          color: isComplete ? '#4ade80' : '#fff',
                          fontSize: 12, fontWeight: 700, textDecoration: 'none',
                          border: isComplete ? '1px solid rgba(74,222,128,0.2)' : 'none',
                          whiteSpace: 'nowrap',
                        }}>
                          {isComplete ? 'Review' : 'Continue'} →
                        </Link>
                      </div>
                    </div>

                    {/* Progress bar */}
                    <div style={{ marginTop: 14, height: 3, borderRadius: 3, background: 'rgba(255,255,255,0.05)' }}>
                      <div style={{
                        height: '100%', borderRadius: 3,
                        width: `${progress}%`,
                        background: isComplete ? '#4ade80' : 'linear-gradient(90deg,var(--kurso-primary),var(--kurso-secondary))',
                        transition: 'width 0.6s ease',
                      }} />
                    </div>
                  </div>

                  {/* Telegram strip */}
                  {hasValidToken && botUsername && (c.deliveryMethod === 'telegram' || c.deliveryMethod === 'both') && (
                    <div style={{
                      padding: '9px 20px',
                      background: 'rgba(34,158,217,0.04)',
                      borderTop: '1px solid rgba(34,158,217,0.1)',
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
                    }}>
                      <span style={{ fontSize: 11, color: '#52525b', display: 'flex', alignItems: 'center', gap: 5 }}>
                        <MessageCircle className="w-3.5 h-3.5 inline" style={{ color: '#229ED9' }} />
                        Continue on Telegram
                      </span>
                      <a
                        href={`https://t.me/${botUsername}?start=${c.telegramToken}`}
                        target="_blank" rel="noopener noreferrer"
                        style={{ fontSize: 11, fontWeight: 700, color: '#229ED9', textDecoration: 'none' }}>
                        Open →
                      </a>
                    </div>
                  )}

                  {/* WhatsApp strip */}
                  {(() => {
                    const waNumber = waNumbers[c.courseId]
                    const hasWaToken = c.whatsappToken && c.whatsappTokenExpiresAt && new Date(c.whatsappTokenExpiresAt) > new Date()
                    const waDeliveryAllowed = c.deliveryMethod === 'whatsapp' || c.deliveryMethod === 'both'
                    if (!waNumber || !hasWaToken || !waDeliveryAllowed) return null
                    const waHref = `https://wa.me/${waNumber}?text=${encodeURIComponent('/start ' + c.whatsappToken)}`
                    return (
                      <div style={{
                        padding: '9px 20px',
                        background: 'rgba(37,211,102,0.04)',
                        borderTop: '1px solid rgba(37,211,102,0.1)',
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
                      }}>
                        <span style={{ fontSize: 11, color: '#52525b', display: 'flex', alignItems: 'center', gap: 5 }}>
                          <svg style={{ width: 14, height: 14, color: '#25D366', flexShrink: 0 }} viewBox="0 0 24 24" fill="currentColor">
                            <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
                          </svg>
                          Continue on WhatsApp
                        </span>
                        <a href={waHref} target="_blank" rel="noopener noreferrer"
                          style={{ fontSize: 11, fontWeight: 700, color: '#25D366', textDecoration: 'none' }}>
                          Open →
                        </a>
                      </div>
                    )
                  })()}



                  {/* Invoice — available any time a payment exists, not just on completion */}
                  {c.payment_status !== 'free' && (
                    <div style={{
                      padding: '8px 22px',
                      borderTop: '1px solid rgba(255,255,255,0.05)',
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    }}>
                      <RefundRequestButton enrollmentId={c.enrollmentId} />
                      <button
                        onClick={() => downloadInvoice(c.enrollmentId)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 5,
                          fontSize: 11, fontWeight: 700, color: '#a1a1aa',
                          background: 'none', border: '1px solid rgba(255,255,255,0.1)',
                          borderRadius: 8, padding: '4px 12px', cursor: 'pointer',
                        }}>
                        <Download className="w-3 h-3" /> Download Invoice
                      </button>
                    </div>
                  )}

                  {/* Certificate strip — shown only for completed courses */}
                  {isComplete && (
                    <div style={{
                      padding: '11px 22px',
                      borderTop: '1px solid rgba(212,175,55,0.12)',
                      background: 'rgba(212,175,55,0.03)',
                      display: 'flex', alignItems: 'center',
                      justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
                    }}>
                      {c.certificateUrl ? (
                        <>
                          <span style={{ fontSize: 12, color: '#c9a227', display: 'flex', alignItems: 'center', gap: 6 }}>
                            <Award className="w-3.5 h-3.5" />
                            Certificate of Completion
                          </span>
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <a
                              href={`${c.certificateUrl}${c.certificateUrl?.includes('?') ? '&' : '?'}v=${c.enrollmentId}`}

                              target="_blank" rel="noopener noreferrer"
                              style={{
                                display: 'flex', alignItems: 'center', gap: 5,
                                fontSize: 11, fontWeight: 700, color: '#c9a227',
                                textDecoration: 'none', padding: '4px 12px',
                                border: '1px solid rgba(201,162,39,0.3)', borderRadius: 8,
                              }}>
                              <Download className="w-3 h-3" /> Download PDF
                            </a>
                            {c.certificateId && (
                              <Link
                                href={`/certificate/${c.certificateId}`}
                                style={{
                                  display: 'flex', alignItems: 'center', gap: 4,
                                  fontSize: 11, fontWeight: 700, color: 'var(--kurso-primary-lighter)',
                                  textDecoration: 'none',
                                }}>
                                <ExternalLink className="w-3 h-3" /> Verify
                              </Link>
                            )}
                          </div>
                        </>
                      ) : (
                        <>
                          <span style={{ fontSize: 12, color: '#52525b', display: 'flex', alignItems: 'center', gap: 6 }}>
                            <Award className="w-3.5 h-3.5" />
                            Certificate available
                          </span>
                          <button
                            onClick={() => requestCertificate(c)}
                            disabled={certGenerating.has(c.enrollmentId)}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 5,
                              fontSize: 11, fontWeight: 700,
                              color: certGenerating.has(c.enrollmentId) ? '#52525b' : '#c9a227',
                              background: 'none', border: '1px solid rgba(201,162,39,0.2)',
                              padding: '4px 12px', borderRadius: 8, cursor: 'pointer',
                            }}>
                            {certGenerating.has(c.enrollmentId) ? 'Generating…' : 'Get Certificate'}
                          </button>
                        </>
                                            )}
                    </div>
                  )}

                  {/* Rate this course — shown once a certificate exists and no rating submitted yet */}
                  {isComplete && c.certificateUrl && !c.hasRated && (
                    <div style={{
                      padding: '14px 22px',
                      borderTop: '1px solid rgba(255,255,255,0.05)',
                      display: 'flex', flexDirection: 'column', gap: 8,
                    }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: '#a1a1aa' }}>Rate this course</span>
                      <div style={{ display: 'flex', gap: 4 }}>
                        {[1, 2, 3, 4, 5].map(star => (
                          <button key={star} type="button"
                            onClick={() => setRatingDrafts(prev => ({
                              ...prev,
                              [c.enrollmentId]: { rating: star, reviewText: prev[c.enrollmentId]?.reviewText || '' },
                            }))}
                            style={{
                              color: star <= (ratingDrafts[c.enrollmentId]?.rating || 0) ? 'var(--kurso-accent)' : '#3f3f46',
                              fontSize: 20, background: 'none', border: 'none', cursor: 'pointer', padding: '0 1px',
                            }}>★</button>
                        ))}
                      </div>
                      {(ratingDrafts[c.enrollmentId]?.rating || 0) > 0 && (
                        <>
                          <textarea
                            value={ratingDrafts[c.enrollmentId]?.reviewText || ''}
                            onChange={e => setRatingDrafts(prev => ({
                              ...prev,
                              [c.enrollmentId]: { rating: prev[c.enrollmentId]?.rating || 0, reviewText: e.target.value },
                            }))}
                            placeholder="Optional written feedback..."
                            rows={2}
                            style={{
                              width: '100%', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.1)',
                              borderRadius: 8, padding: '8px 10px', fontSize: 12, color: '#e4e4e7', outline: 'none', resize: 'none',
                            }} />
                          <button
                            onClick={() => submitRating(c, ratingDrafts[c.enrollmentId].rating, ratingDrafts[c.enrollmentId]?.reviewText || '')}
                            disabled={ratingSubmitting.has(c.enrollmentId)}
                            style={{
                              alignSelf: 'flex-start', fontSize: 11, fontWeight: 700,
                              color: ratingSubmitting.has(c.enrollmentId) ? '#52525b' : 'var(--kurso-primary-lighter)',
                              background: 'none', border: '1px solid rgba(255,255,255,0.15)',
                              padding: '5px 14px', borderRadius: 8, cursor: 'pointer',
                            }}>
                            {ratingSubmitting.has(c.enrollmentId) ? 'Submitting…' : 'Submit Rating'}
                          </button>
                        </>
                      )}
                      {ratingError[c.enrollmentId] && (
                        <span style={{ fontSize: 11, color: '#f87171' }}>{ratingError[c.enrollmentId]}</span>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
