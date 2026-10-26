/**
 * src/app/course/[creatorName]/[courseName]/[courseId]/page.tsx
 * Key fixes:
 * 1. findPaidEnrollment uses all identifiers — no false "not enrolled"
 * 2. previous lesson button added
 * 3. markComplete sends lessonId for quiz tracking
 * 4. Quiz results loaded from enrollment and shown per-lesson
 * 5. Progress is cross-platform: shows telegram-completed lessons too
 * 6. linkStudentToEnrollment called on load to fix bot-created enrollments
 */

"use client"
import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter, useParams } from 'next/navigation'
import Link from 'next/link'

import {
  Shield, CheckCircle, ChevronRight, ChevronLeft,
  Award, Menu, Clock, Lock, FileText, Play, BookOpen,
  HelpCircle, Download, ExternalLink, Sparkles,
  Megaphone, CalendarClock
} from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { findPaidEnrollment, linkStudentToEnrollment } from '@/lib/enrollments'
import { ensureFreshEnrolledToken, fetchDemoToken } from '@/lib/messagingTokens'
import { resolveAccountType } from '@/lib/account'
import EnrollModal from '@/components/EnrollModal'
import AssignmentSubmit from '@/components/AssignmentSubmit'
import WatermarkedPlayer from '@/components/WatermarkedPlayer'
import { isLessonFree } from '@/lib/freeLesson'
import LessonQA from '@/components/LessonQA'
import LessonAI from '@/components/LessonAI'
import { useWhatsAppNumber } from '@/lib/use-whatsapp-number'


interface Lesson {
  id: string
  title: string
  content_url: string
  content_type: string
  order_num: number
  duration: string
  is_published: boolean
  is_last_lesson?: boolean
  module_id?: string | null
  summary_url?: string | null
  notes_url?: string | null
  quiz_questions?: { question: string; options: string[]; answerIndex: number }[] | null
  assignment_prompt?: string | null
  assignment_required?: boolean | null
  assignment_file_url?: string | null
  assignment_file_name?: string | null
  video_storage_path?: string | null
  live_recording_url?: string | null
  is_free?: boolean
  qa_enabled?: boolean
}

interface Course {
  id: string
  name: string
  slug: string
  creator_id: string
  host_name: string
  price: number
  total_lessons?: number
  next_lesson_date?: string
  course_end_date?: string
  student_update_message?: string
  is_free_course?: boolean
  is_published?: boolean
  delivery?: string
}

interface Enrollment {
  id: string
  current_lesson: number
  completed_lessons: number[]
  quiz_results: { lessonId: string; score: number; total: number }[]
  course_uuid: string
  phone?: string
  student_id?: string | null
  telegram_start_token?: string | null
  telegram_start_token_expires_at?: string | null
  certificate_student_name?: string | null
  delivery_method?: string | null
}

async function getSignedContentUrl(lessonId: string, type: 'video' | 'pdf'): Promise<{ url: string; expiresAt: string | null }> {
  const { data: { session } } = await supabase.auth.getSession()
  const res = await fetch('/api/content/sign', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
    },
    body: JSON.stringify({ lessonId, type }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    if (body?.reason === 'module_locked') {
      const err: any = new Error('Module locked')
      err.code = 'module_locked'
      err.unlockAt = body.unlockAt ?? null
      throw err
    }
    throw new Error('Failed to get signed URL')
  }
  const { url, expiresAt } = await res.json()
  return { url, expiresAt: expiresAt || null }
}

function LockedScreen({ course, onEnroll, expectedDeliveryText }: { course: Course; onEnroll: () => void; expectedDeliveryText?: string | null }) {
  if (course.is_published === false) {
    return (
      <div className="flex-1 flex items-center justify-center p-8" style={{ background: '#0a0a0a' }}>
        <div className="text-center max-w-md">
          <div className="w-20 h-20 rounded-2xl flex items-center justify-center mx-auto mb-5"
            style={{ background: 'rgba(var(--kurso-primary-rgb), 0.1)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.2)' }}>
            <Lock className="w-10 h-10" style={{ color: 'var(--kurso-primary-light)' }} />
          </div>
          <h2 className="text-2xl font-bold text-white mb-3">Course Not Available</h2>
          <p style={{ color: '#a1a1aa' }}>
            This course is currently unavailable. It may be under maintenance or not yet launched.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex items-center justify-center p-8" style={{ background: '#0a0a0a' }}>
      <div className="text-center max-w-md">
        <div className="w-20 h-20 rounded-2xl flex items-center justify-center mx-auto mb-5"
          style={{ background: 'rgba(var(--kurso-primary-rgb), 0.1)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.2)' }}>
          <Lock className="w-10 h-10" style={{ color: 'var(--kurso-primary-light)' }} />
        </div>
        <h2 className="text-2xl font-bold text-white mb-3">This lesson is locked</h2>
        <p className="mb-4" style={{ color: '#a1a1aa' }}>
          Enroll in <strong className="text-white">{course.name}</strong> to unlock all lessons.
        </p>
        {expectedDeliveryText && (
          <div className="mb-6 px-4 py-3 rounded-xl text-sm"
            style={{ background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.2)', color: '#eab308' }}>
            📅 {expectedDeliveryText}
          </div>
        )}
        <button onClick={onEnroll}
          className="inline-flex items-center gap-2 px-8 py-4 rounded-xl font-semibold text-white"
          style={{ background: 'linear-gradient(135deg,var(--kurso-primary),var(--kurso-secondary))', boxShadow: '0 8px 24px rgba(var(--kurso-primary-rgb), 0.4)' }}>
          Enroll Now — ₹{course.price.toLocaleString()}
          <ChevronRight className="w-5 h-5" />
        </button>
      </div>
    </div>
  )
}

function PdfViewer({ src, isMobile }: { src: string; isMobile: boolean }) {
  if (isMobile) {
    return (
      <div style={{ width: '100%', minHeight: 220, background: '#111', borderRadius: 12, border: '1px solid rgba(255,255,255,0.07)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24, textAlign: 'center' }}>
        <FileText className="w-8 h-8" style={{ color: '#71717a' }} />
        <p style={{ color: '#a1a1aa', fontSize: 13 }}>PDF preview isn't supported on mobile browsers — download it to view.</p>
        <a href={src} download target="_blank" rel="noopener noreferrer"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '10px 20px', borderRadius: 10, fontWeight: 700, fontSize: 13, color: '#fff', background: 'linear-gradient(135deg,var(--kurso-primary),var(--kurso-secondary))', textDecoration: 'none' }}>
          <Download className="w-4 h-4" /> Download PDF
        </a>
      </div>
    )
  }

  return (
    <div>
      <div style={{ width: '100%', height: '75vh', background: '#111', borderRadius: 12, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.07)' }}>
        <iframe src={src} style={{ width: '100%', height: '100%', border: 'none' }} title="Lesson PDF" />
      </div>
      <a href={src} download target="_blank" rel="noopener noreferrer"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 10, fontSize: 12, color: '#a1a1aa', textDecoration: 'none' }}>
        <Download className="w-3.5 h-3.5" /> Download PDF
      </a>
    </div>
  )
}

export default function CourseLearnPage() {
  const { courseId } = useParams<{ creatorName: string; courseName: string; courseId: string }>()
  const router = useRouter()
  const waNumber = useWhatsAppNumber(courseId) // the creator's own number if they connected one

  const [mounted, setMounted] = useState(false)
  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    if (typeof navigator === 'undefined') return
    setIsMobile(/Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(navigator.userAgent))
  }, [])
  const [loading, setLoading] = useState(true)
  const [course, setCourse] = useState<Course | null>(null)
  const [lessons, setLessons] = useState<Lesson[]>([])
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null)
  const [currentId, setCurrentId] = useState('')
  const [lessonNote, setLessonNote] = useState<string | null>(null)
  const [nextAvailabilityMessage, setNextAvailabilityMessage] = useState<string | null>(null)
  const [completed, setCompleted] = useState<number[]>([])
  const [quizResults, setQuizResults] = useState<Enrollment['quiz_results']>([])
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [aiPanelOpen, setAiPanelOpen] = useState(false)
  const [qaPanelOpen, setQaPanelOpen] = useState(false)
  const [isEnrolled, setIsEnrolled] = useState(false)
  const [user, setUser] = useState<any>(null)
  const [showEnroll, setShowEnroll] = useState(false)

  // Redirect-mode payment return: if the student lands back here with
  // ?order_id= in the URL (from Cashfree's hosted checkout), reopen the
  // enroll modal so its own return-handling effect can confirm the payment.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('order_id')) setShowEnroll(true)
  }, [])
  const [creatorProfile, setCreatorProfile] = useState<any>(null)
  const [contentUrl, setContentUrl] = useState<string | null>(null)
  const [loadingContent, setLoadingContent] = useState(false)
  const [moduleLock, setModuleLock] = useState<{ unlockAt: string | null } | null>(null)
  const [savingProgress, setSavingProgress] = useState(false)
  const [demoTelegramToken, setDemoTelegramToken] = useState('')
  const [generatingDemoToken, setGeneratingDemoToken] = useState(false)
  const [enrolledTelegramToken, setEnrolledTelegramToken] = useState('')
  const [demoWhatsappToken, setDemoWhatsappToken] = useState('')
  const [enrolledWhatsappToken, setEnrolledWhatsappToken] = useState('')
  const [generatingDemoWaToken, setGeneratingDemoWaToken] = useState(false)
  const [showCertModal, setShowCertModal] = useState(false)
  const [certGenerating, setCertGenerating] = useState(false)
  const [certId, setCertId] = useState<string | null>(null)
  const [studentFullName, setStudentFullName] = useState('')
  const [savingStudentName, setSavingStudentName] = useState(false)

  const [assignmentSubmission, setAssignmentSubmission] = useState<any>(null)
  const [assignmentLoadedForLesson, setAssignmentLoadedForLesson] = useState<string | null>(null)
  const [certPdfUrl, setCertPdfUrl] = useState<string | null>(null)
  const [certError, setCertError] = useState('')
  const [sessionToken, setSessionToken] = useState('')

  useEffect(() => {
    async function load() {
      const webAccessResponse = await fetch('/api/web-access/session')
      const webAccess = webAccessResponse.ok
        ? await webAccessResponse.json()
        : null

      const { data: { user: me } } = await supabase.auth.getUser()

      setUser(me)
      const { data: { session } } = await supabase.auth.getSession()
      if (session?.access_token) setSessionToken(session.access_token)

      const { data: courseData } = await supabase
        .from('courses').select('*').eq('id', courseId).single()
      if (!courseData) {
        if (me) {
          const type = await resolveAccountType(me)
          router.push(type === 'creator' ? '/dashboard' : '/my-courses')
        } else {
          router.push('/my-courses')
        }
        return
      }
      setCourse(courseData)

      try {
        const creatorRes = await fetch(`/api/creator/${courseData.creator_id}`)
        if (creatorRes.ok) {
          const creatorData = await creatorRes.json()
          setCreatorProfile(creatorData)
        } else {
          setCreatorProfile(null)
        }
      } catch (err) {
        console.error('Failed to load creator profile:', err)
        setCreatorProfile(null)
      }

      const { data: lessonData } = await supabase
        .from('lessons').select('*')
        .eq('course_id', courseData.id)
        .eq('is_published', true)
        .order('order_num', { ascending: true })
      const fetchedLessons = lessonData || []
      setLessons(fetchedLessons)

      const initialSearchParams = new URLSearchParams(window.location.search)
      const lessonFromUrl = Number(initialSearchParams.get('lesson') || '')
      const fromUrl = fetchedLessons.find((l: Lesson) => l.order_num === lessonFromUrl)

      if (webAccess?.authenticated && webAccess.courseId === courseData.id) {
        const enrollData = webAccess.enrollment

        setIsEnrolled(true)
        setEnrollment(enrollData)
        setCompleted(enrollData.completed_lessons || [])
        setQuizResults(enrollData.quiz_results || [])

        const resume =
          fromUrl ||
          fetchedLessons.find(
            (l: Lesson) => l.order_num === (enrollData.current_lesson || 1)
          ) ||
          fetchedLessons[0]

        if (resume) setCurrentId(resume.id)
      } else if (me) {
        const enrollData = await findPaidEnrollment({
          courseId: courseData.id,
          user: me,
        })

        if (enrollData) {
          setIsEnrolled(true)
          setEnrollment(enrollData)
          setCompleted(enrollData.completed_lessons || [])
          setQuizResults(enrollData.quiz_results || [])

          // Link student_id to this enrollment if missing (bot-created enrollment fix)
          if (!enrollData.student_id && me.id) {
            const { data: studentRow } = await supabase
              .from('students')
              .select('id')
              .eq('auth_id', me.id)
              .limit(1)
              .single()
            if (studentRow?.id) {
              await linkStudentToEnrollment(enrollData.id, studentRow.id)
            }
          }

          // Resume from URL param, or from saved current_lesson, or lesson 1
          const resume = fromUrl
            || fetchedLessons.find((l: Lesson) => l.order_num === (enrollData.current_lesson || 1))
            || fetchedLessons[0]
          if (resume) setCurrentId(resume.id)
        } else {
          // Not enrolled — start from URL param or lesson 1
          setCurrentId(fromUrl?.id || fetchedLessons[0]?.id || '')
        }
      } else {
        setCurrentId(fromUrl?.id || fetchedLessons[0]?.id || '')
      }

      setLoading(false)
      setMounted(true)
    }
    load()
  }, [courseId, router])

  // Load (or generate + persist) the enrolled student's Telegram deep-link token.
  // Runs once when enrollment + creatorProfile + course are all ready.
  useEffect(() => {
    async function getEnrolledToken() {
      if (!isEnrolled || !enrollment || !creatorProfile?.telegram_bot_username || !course || enrolledTelegramToken) return

      // Re-use the persisted token if it exists and hasn't expired
      const stored = enrollment.telegram_start_token
      const expiresAt = enrollment.telegram_start_token_expires_at
      if (stored && expiresAt && new Date(expiresAt) > new Date()) {
        setEnrolledTelegramToken(stored)
        return
      }

      // No valid stored token — generate a fresh one and persist it
      try {
        const res = await fetch('/api/telegram/create-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            studentId: user?.id,
            studentPhone: user?.user_metadata?.phone || '',
            studentEmail: user?.email || '',
            studentName: user?.user_metadata?.full_name || user?.user_metadata?.name || '',
            creatorId: course.creator_id,
            courseId: course.id,
            paymentId: null,
          }),
        })
        const { token, expiresAt: newExpiry } = await res.json()
        if (token) {
          setEnrolledTelegramToken(token)
          // Persist so the next page load skips regeneration
          fetch('/api/telegram/save-enrollment-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enrollmentId: enrollment.id, token, expiresAt: newExpiry }),
          }).catch(e => console.error('[enrolledToken save]', e))
        }
      } catch (e) {
        console.error('[enrolledToken]', e)
      }
    }
    getEnrolledToken()
  }, [isEnrolled, enrollment, creatorProfile, course, user, enrolledTelegramToken])

  // (old duplicate WhatsApp enrolled/demo token effects removed — consolidated
  // into one auto-refreshing pair further below, using src/lib/messagingTokens.ts)

  useEffect(() => {
    async function getDemoToken() {
      if (!user || isEnrolled || !creatorProfile?.telegram_bot_username || !course || demoTelegramToken || generatingDemoToken) return
      setGeneratingDemoToken(true)
      try {
        const res = await fetch('/api/telegram/create-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            studentId: user.id,
            studentPhone: user.phone || user.user_metadata?.phone || '',
            studentEmail: user.email || '',
            studentName: user.user_metadata?.full_name || user.user_metadata?.name || '',
            creatorId: course.creator_id,
            courseId: course.id,
            paymentId: null,
          }),
        })
        const data = await res.json()
        if (data?.token) {
          setDemoTelegramToken(data.token)
        }
      } catch (e) {
        console.error('[demoToken]', e)
      }
      setGeneratingDemoToken(false)
    }
    getDemoToken()
  }, [user, isEnrolled, creatorProfile, course, demoTelegramToken, generatingDemoToken])

  // ── WhatsApp enrolled token — confirms a usable token on load. Always
  //    asks create-token (which checks the live used=false flag), so it
  //    never re-sends an already-consumed token the way a local cache
  //    check used to. The button's own onClick re-confirms once more
  //    right before opening WhatsApp, so this no longer needs polling.
  useEffect(() => {
    if (!isEnrolled || !enrollment || !course) return
    if (!waNumber) return

    let cancelled = false

    async function refresh() {
      const fresh = await ensureFreshEnrolledToken('whatsapp', {
        enrollmentId: enrollment!.id,
        currentToken: (enrollment as any).whatsapp_start_token || null,
        currentExpiresAt: (enrollment as any).whatsapp_start_token_expires_at || null,
        identity: {
          studentId: user?.id,
          studentPhone: user?.user_metadata?.phone || '',
          studentEmail: user?.email || '',
          studentName: user?.user_metadata?.full_name || user?.user_metadata?.name || '',
          creatorId: course!.creator_id,
          courseId: course!.id,
        },
      })
      if (fresh.token && !cancelled) setEnrolledWhatsappToken(fresh.token)
    }

    refresh()
    return () => { cancelled = true }
  }, [isEnrolled, enrollment?.id, course?.id, user?.id])


  // ── WhatsApp demo token (free preview, not yet enrolled) ─────────────────────
  useEffect(() => {
    if (!user || isEnrolled || !course || demoWhatsappToken) return
    if (!waNumber) return

    fetchDemoToken('whatsapp', {
      studentId: user.id,
      studentPhone: user.phone || user.user_metadata?.phone || '',
      studentEmail: user.email || '',
      studentName: user.user_metadata?.full_name || user.user_metadata?.name || '',
      creatorId: course.creator_id,
      courseId: course.id,
    }).then(({ token }) => { if (token) setDemoWhatsappToken(token) })
  }, [user?.id, isEnrolled, course?.id, demoWhatsappToken])


  const currentLesson = lessons.find(l => l.id === currentId) || lessons[0]
  const currentIndex = lessons.findIndex(l => l.id === currentId)
  const prevLesson = currentIndex > 0 ? lessons[currentIndex - 1] : null
  const nextLesson = currentIndex < lessons.length - 1 ? lessons[currentIndex + 1] : null
  const plannedTotal = Math.max(course?.total_lessons || 0, lessons.length)

  // Creator-set "note" for the lesson currently being viewed — shown as a
  // banner above the lesson widgets, per lesson, so it re-fetches on navigation.
  useEffect(() => {
    if (!course?.id || !currentLesson) { setLessonNote(null); return }
    let cancelled = false
    fetch(`/api/lesson-messages/public?courseId=${course.id}&lessonNumber=${currentLesson.order_num}`)
      .then(r => r.json())
      .then(json => { if (!cancelled) setLessonNote(json.type === 'note' ? json.text : null) })
      .catch(() => { if (!cancelled) setLessonNote(null) })
    return () => { cancelled = true }
  }, [course?.id, currentLesson?.id])

  // Creator-set "availability" message for the slot right after the last
  // lesson the student can currently see — covers both an existing-but-
  // unpublished/incomplete lesson and a genuine future "next lesson" slot.
  useEffect(() => {
    if (!course?.id || nextLesson) { setNextAvailabilityMessage(null); return }
    const upcomingNumber = (currentLesson?.order_num || 0) + 1
    let cancelled = false
    fetch(`/api/lesson-messages/public?courseId=${course.id}&lessonNumber=${upcomingNumber}`)
      .then(r => r.json())
      .then(json => { if (!cancelled) setNextAvailabilityMessage(json.type === 'availability' ? json.text : null) })
      .catch(() => { if (!cancelled) setNextAvailabilityMessage(null) })
    return () => { cancelled = true }
  }, [course?.id, nextLesson, currentLesson?.order_num])
  const progress = lessons.length > 0
    ? Math.round((completed.length / Math.max(plannedTotal, lessons.length)) * 100)
    : 0
  const remainingPlanned = Math.max(plannedTotal - lessons.length, 0)
  const lastLesson = lessons.find(l => l.is_last_lesson)
  const isFree = currentLesson && course?.is_published !== false && isLessonFree(
    { is_free: currentLesson.is_free ?? false },
    { is_free_course: course?.is_free_course ?? false }
  )
  const canAccess = isEnrolled || isFree

  // No-leakage: effective delivery method is the enrollment's snapshotted
  // value if enrolled (falls back to the course's current value for older
  // enrollments predating the delivery_method column), otherwise the
  // course's current value for preview/demo visitors.
  const effectiveDeliveryMethod = (isEnrolled ? (enrollment?.delivery_method || course?.delivery) : course?.delivery) || 'both'
  const telegramDeliveryAllowed = effectiveDeliveryMethod === 'telegram' || effectiveDeliveryMethod === 'both'
  const whatsappDeliveryAllowed = effectiveDeliveryMethod === 'whatsapp' || effectiveDeliveryMethod === 'both'
    // Certificate eligibility requires an explicit "last lesson" mark — no
  // implicit completion just from finishing every published lesson.
  const allDone = !!lastLesson && completed.includes(lastLesson.order_num)
  const currentQuizResult = quizResults.find(r => r.lessonId === currentLesson?.id)


  const contentRetryRef = useRef(false)

  // Load signed content URL — and silently re-issue it a couple of minutes
  // before it expires, so a long-running lesson never goes dead on its own.
  // Only video/pdf lessons have signable content — assignment/quiz/live
  // lessons render their own dedicated UI further down instead.
  useEffect(() => {
    setModuleLock(null)
    if (!currentLesson || !canAccess) { setContentUrl(null); return }
    const isRecordedLive = currentLesson.content_type === 'live' && !!currentLesson.video_storage_path
    if (currentLesson.content_type !== 'video' && currentLesson.content_type !== 'pdf' && !isRecordedLive) {
      setContentUrl(null)
      setLoadingContent(false)
      return
    }
    contentRetryRef.current = false
    setLoadingContent(true)
    setContentUrl(null)
    const type = currentLesson.content_type === 'pdf' ? 'pdf' : 'video'
    let refreshTimer: ReturnType<typeof setTimeout> | null = null
    let cancelled = false

        function load(attempt = 0) {
      getSignedContentUrl(currentLesson!.id, type)
        .then(({ url, expiresAt }) => {
          if (cancelled) return
          setContentUrl(url)
          setLoadingContent(false)
          contentRetryRef.current = false
          if (expiresAt) {
            const msLeft = new Date(expiresAt).getTime() - Date.now() - 2 * 60 * 1000
            if (msLeft > 0) refreshTimer = setTimeout(load, msLeft)
          }
        })
        .catch((err: any) => {
          if (cancelled) return
          if (err?.code === 'module_locked') {
            setModuleLock({ unlockAt: err.unlockAt ?? null })
            setLoadingContent(false)
            return
          }
          // First failure is very often the Supabase client's session not
          // having finished hydrating yet on a fresh page load (not a real
          // network/auth problem) — retry once, shortly, before giving up.
          if (attempt < 1) {
            setTimeout(() => { if (!cancelled) load(attempt + 1) }, 900)
            return
          }
          setLoadingContent(false)
        })
    }
    load()

    return () => { cancelled = true; if (refreshTimer) clearTimeout(refreshTimer) }
  }, [currentLesson?.id, canAccess])

  // Last-resort fallback: if playback still fails (network blip, the signed
  // URL died early, etc.) fetch one fresh URL before showing a dead end.
  // Passed to WatermarkedPlayer as onExpired.
  const refreshContentUrl = useCallback(() => {
    if (!currentLesson || contentRetryRef.current) return
    const isRecordedLive = currentLesson.content_type === 'live' && !!currentLesson.video_storage_path
    if (currentLesson.content_type !== 'video' && currentLesson.content_type !== 'pdf' && !isRecordedLive) return
    contentRetryRef.current = true
    const type = currentLesson.content_type === 'pdf' ? 'pdf' : 'video'
    getSignedContentUrl(currentLesson.id, type)
      .then(({ url }) => setContentUrl(url))
      .catch(() => { })
  }, [currentLesson])

  // Load assignment submission when lesson changes
  useEffect(() => {
    async function loadAssignment() {
      if (!enrollment?.id || !currentLesson?.id || !sessionToken) return
      if (assignmentLoadedForLesson === currentLesson.id) return
      setAssignmentLoadedForLesson(currentLesson.id)
      setAssignmentSubmission(null)
      try {
        const res = await fetch(
          `/api/assignments/my?lessonId=${currentLesson.id}&enrollmentId=${enrollment.id}`,
          { headers: { Authorization: `Bearer ${sessionToken}` } }
        )
        if (res.ok) {
          const json = await res.json()
          setAssignmentSubmission(json.assignment || null)
        }
      } catch { /* non-fatal */ }
    }
    loadAssignment()
  }, [currentLesson?.id, enrollment?.id, sessionToken])

  async function markComplete(orderNum: number) {
    if (completed.includes(orderNum)) return
    const next = [...completed, orderNum]
    setCompleted(next)

    if (enrollment && isEnrolled) {
      setSavingProgress(true)
      const res = await fetch('/api/lesson/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enrollmentId: enrollment.id,
          lessonId: currentLesson?.id,
          lessonNum: orderNum,
          currentLesson: orderNum + 1,
          courseId: course?.id,
          source: 'web',
        }),
      })
      const data = await res.json()
      if (data.ok) {
        setEnrollment(e => e ? {
          ...e,
          completed_lessons: data.completed,
          current_lesson: data.currentLesson,
        } : e)
      }
      setSavingProgress(false)
    }
  }

  async function submitQuiz(score: number, total: number) {
    if (!currentLesson || !enrollment) return
    const res = await fetch('/api/lesson/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enrollmentId: enrollment.id,
        lessonId: currentLesson.id,
        lessonNum: currentLesson.order_num,
        courseId: course?.id,
        source: 'web',
        quizScore: score,
        quizTotal: total,
      }),
    })
    const data = await res.json()
    if (data.ok && data.quizResults) {
      setQuizResults(data.quizResults)
    }
  }

  async function goTo(lesson: Lesson) {
    setCurrentId(lesson.id)
    setSidebarOpen(false)

    const nextParams = new URLSearchParams(window.location.search)
    nextParams.set('lesson', String(lesson.order_num))
    router.replace(`${window.location.pathname}?${nextParams.toString()}`, { scroll: false })

    if (enrollment && isEnrolled) {
      // Update current_lesson to max(current, target) — don't go backwards
      const newCurrent = Math.max(enrollment.current_lesson ?? 1, lesson.order_num)
      setEnrollment({ ...enrollment, current_lesson: newCurrent })
      await supabase
        .from('enrollments')
        .update({
          current_lesson: newCurrent,
          last_accessed: new Date().toISOString(),
          last_web_sync: new Date().toISOString(),
        })
        .eq('id', enrollment.id)
    }
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function openCertificate() {
    setShowCertModal(true)
    if (!studentFullName && enrollment?.certificate_student_name) {
      setStudentFullName(enrollment.certificate_student_name)
    }
    // no fetch here — user must confirm the name and click Generate
  }

  async function generateCertificate() {
    if (!enrollment?.id || !course?.id) return
    const name = studentFullName.trim()
    if (!name) return

    setCertGenerating(true)
    setCertError('')
    try {
      await supabase
        .from('enrollments')
        .update({ certificate_student_name: name })
        .eq('id', enrollment.id)

      const res = await fetch('/api/certificate/issue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enrollmentId: enrollment.id,
          courseId: course.id,
          studentName: name,
        }),
      })
      const data = await res.json()
      if ((data.issued || data.alreadyIssued) && data.pdfUrl) {
        setCertId(data.certificateId)
        setCertPdfUrl(data.pdfUrl)
      } else {
        console.error('[certificate] issue failed:', data)
        setCertError(data.error || data.reason || 'Could not generate certificate. Please try again.')
      }
    } catch (err) {
      console.error('[certificate]', err)
      setCertError('Network error while generating certificate.')
    }
    setCertGenerating(false)
  }

  async function saveStudentNameToEnrollment() {
    if (!enrollment?.id || !studentFullName.trim()) return
    setSavingStudentName(true)
    try {
      await supabase
        .from('enrollments')
        .update({ certificate_student_name: studentFullName.trim() })
        .eq('id', enrollment.id)
    } catch (err) {
      console.error('[saveStudentName]', err)
    }
    setSavingStudentName(false)
  }

  if (!mounted || loading) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="w-8 h-8 rounded-lg animate-pulse" style={{ background: 'linear-gradient(135deg,var(--kurso-primary),var(--kurso-secondary))' }} />
      </div>
    )
  }
  if (!course) return null

  const freeLessons = lessons.filter(l => isLessonFree(
    { is_free: l.is_free ?? false },
    { is_free_course: course.is_free_course ?? false }
  )).length
  const isNextLocked = nextLesson && !isEnrolled && !isLessonFree(
    { is_free: nextLesson.is_free ?? false },
    { is_free_course: course.is_free_course ?? false }
  )
  const quizQuestions = Array.isArray(currentLesson?.quiz_questions) && currentLesson!.quiz_questions!.length > 0
    ? currentLesson!.quiz_questions!
    : null

  return (
    <div className="min-h-screen flex flex-col text-white" style={{ background: '#080808' }}>
      {currentLesson && currentLesson.qa_enabled !== false && canAccess && (
        <LessonQA lessonId={currentLesson.id} enrollmentId={enrollment?.id} open={qaPanelOpen} onOpenChange={setQaPanelOpen} />
      )}
      {currentLesson && canAccess && (
        <LessonAI lessonId={currentLesson.id} enrollmentId={enrollment?.id} open={aiPanelOpen} onOpenChange={setAiPanelOpen} />
      )}
      {showEnroll && (
        <EnrollModal
          onClose={() => setShowEnroll(false)}
          course={{
            id: course.id, name: course.name, price: course.price,
            creatorSlug: course.slug,
            creatorName: course.host_name || creatorProfile?.name || '',
            creatorId: course.creator_id,
            telegramBotUsername: creatorProfile?.telegram_bot_username,
            is_free_course: course.is_free_course,
          }}
        />
      )}

      {/* NAV */}
      <nav style={{
        height: 52, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 16px', background: 'rgba(8,8,8,0.95)',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        position: 'sticky', top: 0, zIndex: 50, backdropFilter: 'blur(16px)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={() => setSidebarOpen(v => !v)} className="md:hidden"
            style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer' }}>
            <Menu className="w-5 h-5" />
          </button>
          <Link href="/" style={{ display: 'flex', alignItems: 'center', gap: 8, textDecoration: 'none' }}>
            <div style={{ width: 26, height: 26, borderRadius: 7, background: 'linear-gradient(135deg,var(--kurso-primary),var(--kurso-secondary))', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Shield className="w-3.5 h-3.5 text-white" />
            </div>
            <span style={{ fontSize: 13, fontWeight: 700, color: '#fff' }} className="hidden sm:block">Kurso</span>
          </Link>
          <span style={{ fontSize: 12, color: '#3f3f46' }} className="hidden md:block">/ {course.name}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }} className="hidden sm:flex">
            <div style={{ width: 80, height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.06)' }}>
              <div style={{ height: '100%', width: `${progress}%`, background: 'linear-gradient(90deg,var(--kurso-primary),var(--kurso-secondary))', borderRadius: 2 }} />
            </div>
            <span style={{ fontSize: 10, fontWeight: 700, color: '#52525b' }}>
              {completed.length}/{plannedTotal || lessons.length}
            </span>
          </div>
          {allDone && (
            <button
              onClick={openCertificate}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 8, background: 'rgba(234,179,8,0.08)', color: '#eab308', border: '1px solid rgba(234,179,8,0.2)', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
              <Award className="w-3.5 h-3.5" /> Certificate
            </button>
          )}
          {isEnrolled && (
            <a href="/my-courses"
              style={{
                fontSize: 11, color: '#52525b',
                textDecoration: 'none', whiteSpace: 'nowrap',
              }}
              className="hidden sm:block hover:text-white transition-colors">
              ← My Courses
            </a>
          )}
        </div>
      </nav>

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

        {/* Mobile sidebar backdrop — tap outside to close the lesson list */}
        {sidebarOpen && (
          <div
            className="md:hidden"
            onClick={() => setSidebarOpen(false)}
            style={{ position: 'fixed', inset: 0, top: 52, background: 'rgba(0,0,0,0.6)', zIndex: 39 }}
          />
        )}

        {/* SIDEBAR */}
        <aside style={{
          position: 'fixed', left: 0, top: 52, bottom: 0, zIndex: 40,
          width: 272, background: '#0a0a0a',
          borderRight: '1px solid rgba(255,255,255,0.05)',
          transform: sidebarOpen ? 'translateX(0)' : 'translateX(-100%)',
          transition: 'transform 0.25s',
          overflowY: 'auto',
        }} className="md:relative md:translate-x-0 md:flex-shrink-0">
          <div style={{ padding: '14px 16px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
            <p style={{ fontSize: 10, fontWeight: 700, color: '#3f3f46', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>
              {course.host_name || 'Instructor'}
            </p>
            <p style={{ fontSize: 13, fontWeight: 700, color: '#e4e4e7' }} className="truncate">{course.name}</p>
          </div>

          <div style={{ paddingBottom: 40 }}>
            {lessons.map(lesson => {
              const isActive = lesson.id === currentId
              const isDone = completed.includes(lesson.order_num)
              const isLocked = !isEnrolled && !isLessonFree(
                { is_free: lesson.is_free ?? false },
                { is_free_course: course.is_free_course ?? false }
              )
              const lessonQuizResult = quizResults.find(r => r.lessonId === lesson.id)
              const hasQuiz = Array.isArray(lesson.quiz_questions) && lesson.quiz_questions.length > 0

              return (
                <button key={lesson.id} onClick={() => goTo(lesson)} style={{
                  width: '100%', padding: '10px 16px',
                  display: 'flex', alignItems: 'flex-start', gap: 10,
                  background: isActive ? 'rgba(var(--kurso-primary-rgb), 0.1)' : 'transparent',
                  borderRight: isActive ? '2px solid var(--kurso-primary)' : '2px solid transparent',
                  borderLeft: 'none', borderTop: 'none', borderBottom: 'none',
                  cursor: 'pointer', textAlign: 'left', transition: 'background 0.15s',
                }}>
                  <div style={{ marginTop: 2, flexShrink: 0 }}>
                    {isLocked
                      ? <Lock className="w-3.5 h-3.5" style={{ color: '#3f3f46' }} />
                      : isDone
                        ? <CheckCircle className="w-3.5 h-3.5" style={{ color: '#4ade80' }} />
                        : isActive
                          ? <Play className="w-3.5 h-3.5 fill-current" style={{ color: 'var(--kurso-primary-lighter)' }} />
                          : <span style={{ fontSize: 10, fontWeight: 700, color: '#3f3f46' }}>{lesson.order_num}</span>
                    }
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontSize: 12, fontWeight: 500, color: isLocked ? '#3f3f46' : isActive ? '#fff' : '#a1a1aa' }} className="truncate">
                      {lesson.title}
                    </p>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
                      {lesson.duration && <span style={{ fontSize: 10, color: '#3f3f46' }}>{lesson.duration}</span>}
                      {(lesson as any).expected_delivery_text && isLocked && (
                        <span style={{ fontSize: 9, color: '#eab308', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          📅 {(lesson as any).expected_delivery_text}
                        </span>
                      )}
                      {hasQuiz && (
                        <span style={{
                          fontSize: 9, padding: '1px 5px', borderRadius: 4,
                          background: lessonQuizResult ? 'rgba(74,222,128,0.08)' : 'rgba(var(--kurso-primary-rgb), 0.08)',
                          color: lessonQuizResult ? '#4ade80' : 'var(--kurso-primary-lighter)',
                          fontWeight: 700, textTransform: 'uppercase',
                        }}>
                          {lessonQuizResult ? `Quiz ${lessonQuizResult.score}/${lessonQuizResult.total}` : 'Quiz'}
                        </span>
                      )}
                      {!isEnrolled && isLessonFree(
                        { is_free: lesson.is_free ?? false },
                        { is_free_course: course.is_free_course ?? false }
                      ) && (
                          <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 4, background: 'rgba(74,222,128,0.08)', color: '#4ade80', fontWeight: 700 }}>Free</span>
                        )}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>

          {isEnrolled && (
            <LiveSessionsSidebarSection
              courseId={course.id}
              sessionToken={sessionToken}
              studentName={user?.email || 'Student'}
              studentId={enrollment?.phone || user?.phone || user?.user_metadata?.phone || ''}
            />
          )}
        </aside>

        {/* MAIN */}
        <main style={{ flex: 1, overflowY: 'auto' }}>
          {!canAccess ? (
            <LockedScreen
              course={course}
              onEnroll={() => setShowEnroll(true)}
              expectedDeliveryText={(currentLesson as any)?.expected_delivery_text}
            />
          ) : (
            <div style={{ maxWidth: 860, margin: '0 auto', padding: '24px 16px 60px' }}>

              {!isEnrolled && (
                <div style={{ marginBottom: 18, padding: 16, borderRadius: 12, background: 'rgba(var(--kurso-primary-rgb), 0.09)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.22)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                  <div>
                    <p style={{ color: '#fff', fontSize: 14, fontWeight: 800, marginBottom: 4 }}>
                      Free preview — {freeLessons} lesson{freeLessons !== 1 ? 's' : ''} available
                    </p>
                    <p style={{ color: '#a1a1aa', fontSize: 12 }}>
                      Enroll to unlock all {plannedTotal || lessons.length} lessons + Telegram delivery.
                    </p>
                  </div>
                  <button onClick={() => setShowEnroll(true)}
                    style={{ padding: '10px 18px', borderRadius: 10, background: 'linear-gradient(135deg,var(--kurso-primary),var(--kurso-secondary))', border: 'none', color: '#fff', fontSize: 13, fontWeight: 800, cursor: 'pointer' }}>
                    Enroll — ₹{course.price.toLocaleString()}
                  </button>
                </div>
              )}

              {/* Creator note for this lesson — one prominent banner, not small print */}
              {lessonNote && (
                <div style={{
                  marginBottom: 18, padding: '14px 18px', borderRadius: 12,
                  background: 'linear-gradient(135deg, rgba(var(--kurso-primary-rgb), 0.14), rgba(var(--kurso-primary-rgb), 0.05))',
                  border: '1px solid rgba(var(--kurso-primary-rgb), 0.3)',
                  display: 'flex', alignItems: 'flex-start', gap: 12,
                }}>
                  <div style={{
                    width: 30, height: 30, borderRadius: 9, flexShrink: 0,
                    background: 'linear-gradient(135deg,var(--kurso-primary),var(--kurso-secondary))',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <Megaphone className="w-4 h-4 text-white" />
                  </div>
                  <p style={{ color: '#fff', fontSize: 14, fontWeight: 600, lineHeight: 1.5, margin: 0 }}>
                    {lessonNote}
                  </p>
                </div>
              )}

              {/* Content */}
              {currentLesson?.content_type === 'quiz' ? (
                <div style={{ aspectRatio: '16/9', background: 'rgba(var(--kurso-primary-rgb), 0.06)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.2)', borderRadius: 12, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, marginBottom: 24, padding: 24, textAlign: 'center' }}>
                  {quizQuestions ? (
                    <>
                      <p style={{ color: '#fff', fontSize: 15, fontWeight: 700 }}>🧠 This lesson is a quiz</p>
                      <Link href={`/resource/${currentLesson.id}?type=quiz`} target="_blank"
                        style={{ padding: '10px 20px', borderRadius: 10, background: 'linear-gradient(135deg,var(--kurso-primary),var(--kurso-secondary))', color: '#fff', fontSize: 13, fontWeight: 700, textDecoration: 'none' }}>
                        {currentQuizResult ? `Retake Quiz (Last score: ${currentQuizResult.score}/${currentQuizResult.total})` : 'Take the Quiz'}
                      </Link>
                    </>
                  ) : (
                    <p style={{ color: '#71717a', fontSize: 14 }}>This quiz hasn't been added yet. Check back soon.</p>
                  )}
                </div>
              ) : currentLesson?.content_type === 'assignment' ? (
                (currentLesson?.assignment_prompt || currentLesson?.assignment_file_url || currentLesson?.content_type === 'assignment') && isEnrolled && (
                  <div style={{
                    marginBottom: 24, padding: 16, borderRadius: 12,
                    background: 'rgba(245,158,11,0.06)',
                    border: '1px solid rgba(245,158,11,0.2)',
                  }}>
                    <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--kurso-accent)', marginBottom: 6 }}>
                      📝 Assignment{currentLesson.assignment_required ? ' (Required)' : ' (Optional)'}
                    </p>

                    {!currentLesson.assignment_prompt && !currentLesson.assignment_file_url ? (
                      <p style={{ fontSize: 13, color: '#71717a', marginBottom: 12 }}>
                        This assignment hasn't been added yet. Check back soon.
                      </p>
                    ) : (
                      <>
                        {currentLesson.assignment_prompt && (
                          <p style={{ fontSize: 13, color: '#e4e4e7', marginBottom: 12, lineHeight: 1.6 }}>
                            {currentLesson.assignment_prompt}
                          </p>
                        )}

                        {currentLesson.assignment_file_url && (
                          /\.(jpe?g|png|gif|webp)$/i.test(currentLesson.assignment_file_name || currentLesson.assignment_file_url) ? (
                            <a href={currentLesson.assignment_file_url} target="_blank" rel="noopener noreferrer" style={{ display: 'block', marginBottom: 12 }}>
                              <img
                                src={currentLesson.assignment_file_url}
                                alt={currentLesson.assignment_file_name || 'Assignment attachment'}
                                style={{ maxWidth: '100%', borderRadius: 10, border: '1px solid rgba(255,255,255,0.08)' }}
                              />
                            </a>
                          ) : (
                            <a
                              href={currentLesson.assignment_file_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 6,
                                fontSize: 12,
                                color: 'var(--kurso-primary-lightest)',
                                marginBottom: 12,
                                padding: '6px 12px',
                                borderRadius: 8,
                                background: 'rgba(var(--kurso-primary-rgb), 0.12)',
                                border: '1px solid rgba(var(--kurso-primary-rgb), 0.22)',
                                textDecoration: 'none',
                              }}
                            >
                              <FileText className="w-3.5 h-3.5" />
                              {currentLesson.assignment_file_name || 'Download Assignment File'}
                            </a>
                          )
                        )}
                      </>
                    )}

                    {assignmentSubmission ? (
                      <div style={{ padding: 12, borderRadius: 10, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
                        <p style={{ fontSize: 12, fontWeight: 700, color: '#4ade80', marginBottom: 4 }}>
                          ✅ Submitted {new Date(assignmentSubmission.submitted_at).toLocaleDateString('en-IN')}
                        </p>
                        {assignmentSubmission.submission_text && (
                          <p style={{ fontSize: 12, color: '#a1a1aa', marginBottom: 8 }}>
                            {assignmentSubmission.submission_text.slice(0, 200)}
                            {assignmentSubmission.submission_text.length > 200 ? '…' : ''}
                          </p>
                        )}
                        {assignmentSubmission.submission_url && (
                          <a
                            href={assignmentSubmission.submission_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ fontSize: 12, color: 'var(--kurso-primary-lighter)', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                          >
                            <Download className="w-3.5 h-3.5" /> View attached file
                          </a>
                        )}
                        {assignmentSubmission.status === 'reviewed' && (
                          <div style={{ marginTop: 8, padding: 10, borderRadius: 8, background: 'rgba(var(--kurso-primary-rgb), 0.08)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.2)' }}>
                            <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--kurso-primary-lighter)', marginBottom: 4 }}>
                              Instructor Feedback:
                            </p>
                            <p style={{ fontSize: 12, color: '#e4e4e7' }}>{assignmentSubmission.creator_feedback}</p>
                            {assignmentSubmission.score !== null && assignmentSubmission.score !== undefined && (
                              <p style={{ fontSize: 12, fontWeight: 700, color: 'var(--kurso-primary-lighter)', marginTop: 6 }}>
                                Score: {assignmentSubmission.score}/10
                              </p>
                            )}
                          </div>
                        )}
                        {assignmentSubmission.status === 'pending' && (
                          <p style={{ fontSize: 11, color: '#71717a' }}>Awaiting instructor review…</p>
                        )}
                      </div>
                    ) : currentLesson && enrollment?.id && course?.id && sessionToken ? (
                      <AssignmentSubmit
                        key={currentLesson.id}
                        sessionToken={sessionToken}
                        lessonId={currentLesson.id}
                        courseId={course.id}
                        enrollmentId={enrollment.id}
                        onSubmitted={setAssignmentSubmission}
                      />
                    ) : null}
                  </div>
                )
              )
                : currentLesson?.content_type === 'live' && !currentLesson?.video_storage_path ? (
                  <div style={{ aspectRatio: '16/9', background: 'rgba(234,179,8,0.06)', border: '1px solid rgba(234,179,8,0.2)', borderRadius: 12, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, marginBottom: 24, padding: 24, textAlign: 'center' }}>
                    {currentLesson.content_url ? (
                      <>
                        <p style={{ color: '#fff', fontSize: 15, fontWeight: 700 }}>🔴 This is a live class</p>
                        <a href={currentLesson.content_url} target="_blank" rel="noopener noreferrer"
                          style={{ padding: '10px 20px', borderRadius: 10, background: '#eab308', color: '#000', fontSize: 13, fontWeight: 700, textDecoration: 'none' }}>
                          Join Live Class
                        </a>
                      </>
                    ) : (
                      <p style={{ color: '#71717a', fontSize: 14 }}>Live class details haven't been added yet. Check back soon.</p>
                    )}
                  </div>
                ) : moduleLock ? (
                  <div style={{ aspectRatio: '16/9', background: '#111', borderRadius: 12, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 24, padding: 24, textAlign: 'center', border: '1px solid rgba(255,255,255,0.06)' }}>
                    <Lock className="w-8 h-8" style={{ color: 'var(--kurso-primary-light)' }} />
                    <p style={{ color: '#fff', fontSize: 15, fontWeight: 700 }}>This module isn&apos;t unlocked yet</p>
                    <p style={{ color: '#a1a1aa', fontSize: 13 }}>
                      {moduleLock.unlockAt
                        ? `It unlocks on ${new Date(moduleLock.unlockAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })} IST.`
                        : 'Check back soon.'}
                    </p>
                  </div>
                ) : loadingContent ? (
                  <div style={{ aspectRatio: '16/9', background: '#111', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 24 }}>
                    <div style={{ width: 32, height: 32, borderRadius: 8, background: 'linear-gradient(135deg,var(--kurso-primary),var(--kurso-secondary))', animation: 'pulse 1s infinite' }} />
                  </div>
                ) : contentUrl ? (
                  <div style={{ marginBottom: 24 }}>
                    {currentLesson?.content_type === 'live' && (
                      <p style={{ fontSize: 12, fontWeight: 700, color: '#eab308', marginBottom: 8 }}>🎬 Class Recording</p>
                    )}
                    {currentLesson?.content_type === 'pdf' ? (
                      <PdfViewer src={contentUrl} isMobile={isMobile} />
                    ) : (
                      <WatermarkedPlayer
                        src={contentUrl}
                        studentName={user?.email || 'Preview Student'}
                        studentId={enrollment?.phone || user?.phone || user?.user_metadata?.phone || ''}
                        lessonTitle={currentLesson?.title}
                        lessonId={currentLesson?.id}
                        onEnded={() => currentLesson && markComplete(currentLesson.order_num)}
                        onExpired={refreshContentUrl}
                      />
                    )}
                  </div>
                ) : (
                  <div style={{ aspectRatio: '16/9', background: '#111', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 24, border: '1px solid rgba(255,255,255,0.06)' }}>
                    <p style={{ color: '#52525b', fontSize: 14 }}>Content unavailable</p>
                  </div>
                )}

              {/* Ask AI / Q&A — sits right below the lesson, above Mark as Complete, on every device */}
              {canAccess && (
                <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
                  <button
                    onClick={() => setAiPanelOpen(o => !o)}
                    aria-expanded={aiPanelOpen}
                    style={{
                      flex: '1 1 200px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                      padding: '12px 14px', borderRadius: 12, fontSize: 13, fontWeight: 700, color: '#fff',
                      background: 'linear-gradient(135deg,var(--kurso-secondary),var(--kurso-primary))',
                      border: 'none', cursor: 'pointer',
                    }}>
                    <ChevronLeft className="w-3.5 h-3.5 md:w-4 md:h-4 lg:w-5 lg:h-5" style={{ transition: 'transform 0.25s ease', transform: aiPanelOpen ? 'rotate(180deg)' : 'none', opacity: 0.85, flexShrink: 0 }} />
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Sparkles className="w-4 h-4 md:w-[18px] md:h-[18px] lg:w-5 lg:h-5" /> Ask AI
                    </span>
                    <ChevronRight className="w-3.5 h-3.5 md:w-4 md:h-4 lg:w-5 lg:h-5" style={{ transition: 'transform 0.25s ease', transform: aiPanelOpen ? 'rotate(180deg)' : 'none', opacity: 0.85, flexShrink: 0 }} />
                  </button>
                  {currentLesson && currentLesson.qa_enabled !== false && (
                    <button
                      onClick={() => setQaPanelOpen(o => !o)}
                      aria-expanded={qaPanelOpen}
                      style={{
                        flex: '1 1 200px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                        padding: '12px 14px', borderRadius: 12, fontSize: 13, fontWeight: 700, color: '#fff',
                        background: 'linear-gradient(135deg,var(--kurso-primary),var(--kurso-secondary))',
                        border: 'none', cursor: 'pointer',
                      }}>
                      <ChevronLeft className="w-3.5 h-3.5 md:w-4 md:h-4 lg:w-5 lg:h-5" style={{ transition: 'transform 0.25s ease', transform: qaPanelOpen ? 'rotate(180deg)' : 'none', opacity: 0.85, flexShrink: 0 }} />
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <HelpCircle className="w-4 h-4 md:w-[18px] md:h-[18px] lg:w-5 lg:h-5" /> Q&amp;A
                      </span>
                      <ChevronRight className="w-3.5 h-3.5 md:w-4 md:h-4 lg:w-5 lg:h-5" style={{ transition: 'transform 0.25s ease', transform: qaPanelOpen ? 'rotate(180deg)' : 'none', opacity: 0.85, flexShrink: 0 }} />
                    </button>
                  )}
                </div>
              )}

              {/* Title + complete */}
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
                <div>
                  <h1 style={{ fontSize: 'clamp(1.1rem,3vw,1.5rem)', fontWeight: 800, color: '#fff', marginBottom: 6 }}>
                    {currentLesson?.title}
                  </h1>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    {currentLesson?.duration && (
                      <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#52525b' }}>
                        <Clock className="w-3.5 h-3.5" /> {currentLesson.duration}
                      </span>
                    )}
                    <span style={{ fontSize: 12, color: '#52525b' }}>
                      Lesson {currentLesson?.order_num} of {plannedTotal || lessons.length}
                    </span>
                  </div>
                </div>

                {currentLesson && (
                  completed.includes(currentLesson.order_num) ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderRadius: 10, background: 'rgba(74,222,128,0.08)', border: '1px solid rgba(74,222,128,0.2)', color: '#4ade80', fontSize: 13, fontWeight: 700 }}>
                      <CheckCircle className="w-4 h-4" /> Completed
                    </div>
                  ) : (
                    <button onClick={() => markComplete(currentLesson.order_num)} disabled={savingProgress}
                      style={{ padding: '8px 20px', borderRadius: 10, background: 'linear-gradient(135deg,var(--kurso-primary),var(--kurso-secondary))', border: 'none', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', opacity: savingProgress ? 0.6 : 1 }}>
                      {savingProgress ? 'Saving…' : 'Mark as Complete'}
                    </button>
                  )
                )}
              </div>

              {/* Resources row */}
              {currentLesson && (currentLesson.summary_url || currentLesson.notes_url || quizQuestions) && (
                <div style={{ display: 'flex', gap: 10, marginBottom: 18, flexWrap: 'wrap' }}>
                  {currentLesson.summary_url && (
                    <Link href={`/resource/${currentLesson.id}?type=summary`} target="_blank"
                      style={{ padding: '8px 14px', borderRadius: 10, background: 'rgba(var(--kurso-primary-rgb), 0.12)', color: 'var(--kurso-primary-lightest)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.22)', fontSize: 12, fontWeight: 700 }}>
                      📄 Summary
                    </Link>
                  )}
                  {currentLesson.notes_url && (
                    <Link href={`/resource/${currentLesson.id}?type=notes`} target="_blank"
                      style={{ padding: '8px 14px', borderRadius: 10, background: 'rgba(var(--kurso-primary-rgb), 0.12)', color: 'var(--kurso-primary-lightest)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.22)', fontSize: 12, fontWeight: 700 }}>
                      📝 Notes
                    </Link>
                  )}
                  {quizQuestions && (
                    <Link href={`/resource/${currentLesson.id}?type=quiz`} target="_blank"
                      style={{
                        padding: '8px 14px', borderRadius: 10, fontSize: 12, fontWeight: 700,
                        background: currentQuizResult ? 'rgba(74,222,128,0.1)' : 'rgba(var(--kurso-primary-rgb), 0.12)',
                        color: currentQuizResult ? '#4ade80' : 'var(--kurso-primary-lightest)',
                        border: currentQuizResult ? '1px solid rgba(74,222,128,0.22)' : '1px solid rgba(var(--kurso-primary-rgb), 0.22)',
                      }}>
                      🧠 {currentQuizResult ? `Quiz: ${currentQuizResult.score}/${currentQuizResult.total}` : 'Take Quiz'}
                    </Link>
                  )}
                </div>
              )}

              {/* Prev / Next */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 0', borderTop: '1px solid rgba(255,255,255,0.05)', borderBottom: '1px solid rgba(255,255,255,0.05)', marginBottom: 18 }}>
                <button
                  onClick={() => prevLesson && goTo(prevLesson)}
                  disabled={!prevLesson}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#a1a1aa', background: 'none', border: 'none', cursor: prevLesson ? 'pointer' : 'default', opacity: prevLesson ? 1 : 0.3 }}>
                  <ChevronLeft className="w-4 h-4" />
                  {prevLesson ? prevLesson.title : 'Previous'}
                </button>

                {nextLesson ? (
                  isNextLocked ? (
                    <button onClick={() => setShowEnroll(true)}
                      style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 20px', borderRadius: 10, background: 'linear-gradient(135deg,var(--kurso-primary),var(--kurso-secondary))', border: 'none', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                      Enroll to unlock — ₹{course.price.toLocaleString()} <ChevronRight className="w-4 h-4" />
                    </button>
                  ) : (
                    <button onClick={() => goTo(nextLesson)}
                      style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700, color: '#fff', background: 'none', border: 'none', cursor: 'pointer' }}>
                      {nextLesson.title} <ChevronRight className="w-4 h-4" />
                    </button>
                  )
                ) : remainingPlanned > 0 ? (
                  <div style={{ textAlign: 'right' }}>
                    <p style={{ color: '#eab308', fontSize: 13, fontWeight: 800 }}>Next lesson upcoming</p>
                    {!nextAvailabilityMessage && (
                      <p style={{ color: '#71717a', fontSize: 11 }}>
                        {course.next_lesson_date
                          ? `Next: ${new Date(course.next_lesson_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`
                          : `${remainingPlanned} more lesson${remainingPlanned > 1 ? 's' : ''} planned`}
                      </p>
                    )}
                  </div>

                ) : allDone ? (
                  <button
                    onClick={openCertificate}
                    style={{ padding: '8px 16px', borderRadius: 10, background: 'rgba(234,179,8,0.08)', color: '#eab308', border: '1px solid rgba(234,179,8,0.2)', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                    <Award className="w-4 h-4 inline mr-1" />Get Certificate
                  </button>
                                ) : (
                  // No next lesson to go to — regardless of completion state, just say so.
                  <p style={{ color: '#71717a', fontSize: 12, fontWeight: 600 }}>
                    Not available
                  </p>
                )}
              </div>

              {/* Creator's lesson-availability message — the actual widget the
                  student sees in place of a locked/future lesson. Prominent card,
                  not a small caption, per spec. Only shown when the creator has
                  set one; otherwise the compact "Next lesson upcoming" line above
                  already covers it. */}
              {!nextLesson && nextAvailabilityMessage && (
                <div style={{
                  marginBottom: 24, padding: '22px 24px', borderRadius: 16,
                  background: 'linear-gradient(135deg, rgba(234,179,8,0.1), rgba(234,179,8,0.03))',
                  border: '1px solid rgba(234,179,8,0.25)',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 12,
                }}>
                  <div style={{
                    width: 48, height: 48, borderRadius: 14,
                    background: 'rgba(234,179,8,0.15)', border: '1px solid rgba(234,179,8,0.3)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <CalendarClock className="w-6 h-6" style={{ color: '#eab308' }} />
                  </div>
                  <p style={{ color: '#fff', fontSize: 15, fontWeight: 700, lineHeight: 1.6, margin: 0, maxWidth: 520 }}>
                    {nextAvailabilityMessage}
                  </p>
                  {course.next_lesson_date && (
                    <p style={{ color: '#eab308', fontSize: 12, fontWeight: 700, margin: 0 }}>
                      Next: {new Date(course.next_lesson_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </p>
                  )}
                </div>
              )}

              {/* Assignment as an activity attached to a video/pdf/live lesson —
                  separate from a lesson whose content_type IS 'assignment', which
                  renders its assignment content in the main content slot above. */}
              {currentLesson?.content_type !== 'assignment' && (currentLesson?.assignment_prompt || currentLesson?.assignment_file_url) && isEnrolled && (
                <div style={{
                  marginBottom: 18, padding: 16, borderRadius: 12,
                  background: 'rgba(245,158,11,0.06)',
                  border: '1px solid rgba(245,158,11,0.2)',
                }}>
                  <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--kurso-accent)', marginBottom: 6 }}>
                    📝 Assignment{currentLesson.assignment_required ? ' (Required)' : ' (Optional)'}
                  </p>

                  {currentLesson.assignment_prompt && (
                    <p style={{ fontSize: 13, color: '#e4e4e7', marginBottom: 12, lineHeight: 1.6 }}>
                      {currentLesson.assignment_prompt}
                    </p>
                  )}

                  {currentLesson.assignment_file_url && (
                    /\.(jpe?g|png|gif|webp)$/i.test(currentLesson.assignment_file_name || currentLesson.assignment_file_url) ? (
                      <a href={currentLesson.assignment_file_url} target="_blank" rel="noopener noreferrer" style={{ display: 'block', marginBottom: 12 }}>
                        <img
                          src={currentLesson.assignment_file_url}
                          alt={currentLesson.assignment_file_name || 'Assignment attachment'}
                          style={{ maxWidth: '100%', borderRadius: 10, border: '1px solid rgba(255,255,255,0.08)' }}
                        />
                      </a>
                    ) : (
                      <a
                        href={currentLesson.assignment_file_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          fontSize: 12,
                          color: 'var(--kurso-primary-lightest)',
                          marginBottom: 12,
                          padding: '6px 12px',
                          borderRadius: 8,
                          background: 'rgba(var(--kurso-primary-rgb), 0.12)',
                          border: '1px solid rgba(var(--kurso-primary-rgb), 0.22)',
                          textDecoration: 'none',
                        }}
                      >
                        <FileText className="w-3.5 h-3.5" />
                        {currentLesson.assignment_file_name || 'Download Assignment File'}
                      </a>
                    )
                  )}

                  {assignmentSubmission ? (
                    <div style={{ padding: 12, borderRadius: 10, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
                      <p style={{ fontSize: 12, fontWeight: 700, color: '#4ade80', marginBottom: 4 }}>
                        ✅ Submitted {new Date(assignmentSubmission.submitted_at).toLocaleDateString('en-IN')}
                      </p>
                      {assignmentSubmission.submission_text && (
                        <p style={{ fontSize: 12, color: '#a1a1aa', marginBottom: 8 }}>
                          {assignmentSubmission.submission_text.slice(0, 200)}
                          {assignmentSubmission.submission_text.length > 200 ? '…' : ''}
                        </p>
                      )}
                      {assignmentSubmission.submission_url && (
                        <a
                          href={assignmentSubmission.submission_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ fontSize: 12, color: 'var(--kurso-primary-lighter)', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                        >
                          <Download className="w-3.5 h-3.5" /> View attached file
                        </a>
                      )}
                      {assignmentSubmission.status === 'reviewed' && (
                        <div style={{ marginTop: 8, padding: 10, borderRadius: 8, background: 'rgba(var(--kurso-primary-rgb), 0.08)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.2)' }}>
                          <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--kurso-primary-lighter)', marginBottom: 4 }}>
                            Instructor Feedback:
                          </p>
                          <p style={{ fontSize: 12, color: '#e4e4e7' }}>{assignmentSubmission.creator_feedback}</p>
                          {assignmentSubmission.score !== null && assignmentSubmission.score !== undefined && (
                            <p style={{ fontSize: 12, fontWeight: 700, color: 'var(--kurso-primary-lighter)', marginTop: 6 }}>
                              Score: {assignmentSubmission.score}/10
                            </p>
                          )}
                        </div>
                      )}
                      {assignmentSubmission.status === 'pending' && (
                        <p style={{ fontSize: 11, color: '#71717a' }}>Awaiting instructor review…</p>
                      )}
                    </div>
                  ) : currentLesson && enrollment?.id && course?.id && sessionToken ? (
                    <AssignmentSubmit
                      key={currentLesson.id}
                      sessionToken={sessionToken}
                      lessonId={currentLesson.id}
                      courseId={course.id}
                      enrollmentId={enrollment.id}
                      onSubmitted={setAssignmentSubmission}
                    />
                  ) : null}
                </div>
              )}

              {/* No-leakage: only show CTAs for channels this course/enrollment actually
                  covers. Enrolled students use their enrollment's snapshotted delivery
                  method (so a later change to the course doesn't silently affect them
                  unless the creator explicitly opts them in); everyone else uses the
                  course's current delivery method. */}
              {/* Telegram + WhatsApp CTAs for all users (enrolled or previewing) */}
              {creatorProfile?.telegram_bot_username && telegramDeliveryAllowed && (
                isEnrolled ? (
                  <div style={{ padding: 16, borderRadius: 12, background: 'rgba(34,158,217,0.06)', border: '1px solid rgba(34,158,217,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
                    <div>
                      <p style={{ color: '#fff', fontSize: 13, fontWeight: 700, marginBottom: 2 }}>Continue on Telegram</p>
                      <p style={{ color: '#71717a', fontSize: 12 }}>Lessons delivered to your chat. Progress syncs automatically.</p>
                    </div>
                    {enrolledTelegramToken ? (
                      <a
                        href={`https://t.me/${creatorProfile.telegram_bot_username.replace('@', '')}?start=${enrolledTelegramToken}`}
                        target="_blank" rel="noopener noreferrer"
                        style={{ padding: '8px 16px', borderRadius: 10, background: '#229ED9', color: '#fff', fontSize: 12, fontWeight: 700, textDecoration: 'none', whiteSpace: 'nowrap' }}>
                        Open Telegram
                      </a>
                    ) : (
                      <button disabled
                        style={{ padding: '8px 16px', borderRadius: 10, background: 'rgba(34,158,217,0.5)', color: '#fff', fontSize: 12, fontWeight: 700, border: 'none', cursor: 'not-allowed', whiteSpace: 'nowrap' }}>
                        Preparing Link...
                      </button>
                    )}
                  </div>



                ) : (
                  <div style={{ padding: 16, borderRadius: 12, background: 'rgba(34,158,217,0.06)', border: '1px solid rgba(34,158,217,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
                    <div>
                      <p style={{ color: '#fff', fontSize: 13, fontWeight: 700, marginBottom: 2 }}>Learn on Telegram</p>
                      <p style={{ color: '#71717a', fontSize: 12 }}>Get these free preview lessons delivered straight to your chat.</p>
                    </div>
                    {user ? (
                      demoTelegramToken ? (
                        <a href={`https://t.me/${creatorProfile.telegram_bot_username.replace('@', '')}?start=${demoTelegramToken}`}
                          target="_blank" rel="noopener noreferrer"
                          style={{ padding: '8px 16px', borderRadius: 10, background: '#229ED9', color: '#fff', fontSize: 12, fontWeight: 700, textDecoration: 'none', whiteSpace: 'nowrap' }}>
                          Start Free on Telegram
                        </a>
                      ) : (
                        <button disabled
                          style={{ padding: '8px 16px', borderRadius: 10, background: 'rgba(34,158,217,0.5)', color: '#fff', fontSize: 12, fontWeight: 700, border: 'none', cursor: 'not-allowed', whiteSpace: 'nowrap' }}>
                          Preparing Link...
                        </button>
                      )
                    ) : (
                      <button onClick={() => setShowEnroll(true)}
                        style={{ padding: '8px 16px', borderRadius: 10, background: '#229ED9', color: '#fff', fontSize: 12, fontWeight: 700, border: 'none', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                        Start Free on Telegram
                      </button>
                    )}
                  </div>
                )
              )}


              {/* WhatsApp CTA — enrolled students get "Continue", preview visitors get "Start Free" */}
              {waNumber && whatsappDeliveryAllowed && (
                isEnrolled ? (
                  <div style={{ padding: 16, borderRadius: 12, background: 'rgba(37,211,102,0.06)', border: '1px solid rgba(37,211,102,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
                    <div>
                      <p style={{ color: '#fff', fontSize: 13, fontWeight: 700, marginBottom: 2 }}>Continue on WhatsApp</p>
                      <p style={{ color: '#71717a', fontSize: 12 }}>Lessons delivered to your chat. Progress syncs automatically.</p>
                    </div>
                    {enrolledWhatsappToken ? (
                      <a
                        href={`https://wa.me/${waNumber}?text=${encodeURIComponent('/start ' + enrolledWhatsappToken)}`}
                        target="_blank" rel="noopener noreferrer"
                        onClick={(e) => {
                          if (!enrollment || !course) return
                          e.preventDefault()
                          const fallbackHref = e.currentTarget.href
                          ensureFreshEnrolledToken('whatsapp', {
                            enrollmentId: enrollment.id,
                            currentToken: enrolledWhatsappToken,
                            currentExpiresAt: (enrollment as any).whatsapp_start_token_expires_at || null,
                            identity: {
                              studentId: user?.id,
                              studentPhone: user?.user_metadata?.phone || '',
                              studentEmail: user?.email || '',
                              studentName: user?.user_metadata?.full_name || user?.user_metadata?.name || '',
                              creatorId: course.creator_id,
                              courseId: course.id,
                            },
                          }).then(fresh => {
                            const liveToken = fresh.token || enrolledWhatsappToken
                            if (fresh.token && fresh.token !== enrolledWhatsappToken) setEnrolledWhatsappToken(fresh.token)
                            window.open(
                              `https://wa.me/${waNumber}?text=${encodeURIComponent('/start ' + liveToken)}`,
                              '_blank', 'noopener,noreferrer'
                            )
                          }).catch(() => window.open(fallbackHref, '_blank', 'noopener,noreferrer'))
                        }}
                        style={{ padding: '8px 16px', borderRadius: 10, background: '#25D366', color: '#fff', fontSize: 12, fontWeight: 700, textDecoration: 'none', whiteSpace: 'nowrap' }}>
                        Open WhatsApp
                      </a>
                    ) : (
                      <button disabled
                        style={{ padding: '8px 16px', borderRadius: 10, background: 'rgba(37,211,102,0.5)', color: '#fff', fontSize: 12, fontWeight: 700, border: 'none', cursor: 'not-allowed', whiteSpace: 'nowrap' }}>
                        Preparing Link...
                      </button>
                    )}
                  </div>
                ) : (
                  <div style={{ padding: 16, borderRadius: 12, background: 'rgba(37,211,102,0.06)', border: '1px solid rgba(37,211,102,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
                    <div>
                      <p style={{ color: '#fff', fontSize: 13, fontWeight: 700, marginBottom: 2 }}>Learn on WhatsApp</p>
                      <p style={{ color: '#71717a', fontSize: 12 }}>Get free preview lessons delivered to your WhatsApp.</p>
                    </div>
                    {user ? (
                      demoWhatsappToken ? (
                        <a
                          href={`https://wa.me/${waNumber}?text=${encodeURIComponent('/start ' + demoWhatsappToken)}`}
                          target="_blank" rel="noopener noreferrer"
                          style={{ padding: '8px 16px', borderRadius: 10, background: '#25D366', color: '#fff', fontSize: 12, fontWeight: 700, textDecoration: 'none', whiteSpace: 'nowrap' }}>
                          Start Free on WhatsApp
                        </a>
                      ) : (
                        <button disabled
                          style={{ padding: '8px 16px', borderRadius: 10, background: 'rgba(37,211,102,0.5)', color: '#fff', fontSize: 12, fontWeight: 700, border: 'none', cursor: 'not-allowed', whiteSpace: 'nowrap' }}>
                          Preparing Link...
                        </button>
                      )
                    ) : (
                      <button onClick={() => setShowEnroll(true)}
                        style={{ padding: '8px 16px', borderRadius: 10, background: '#25D366', color: '#fff', fontSize: 12, fontWeight: 700, border: 'none', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                        Start Free on WhatsApp
                      </button>
                    )}
                  </div>
                )
              )}

            </div>
          )}
        </main>
      </div>

      {/* ── CERTIFICATE MODAL ── */}
      {showCertModal && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setShowCertModal(false) }}
          style={{
            position: 'fixed', inset: 0, zIndex: 60,
            background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(12px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
          }}>
          <div style={{
            width: '100%', maxWidth: 420, borderRadius: 20, padding: 32,
            background: '#0a0a0a', border: '1px solid rgba(234,179,8,0.25)',
            textAlign: 'center',
          }}>
            <div style={{
              width: 72, height: 72, borderRadius: 18, margin: '0 auto 20px',
              background: 'rgba(234,179,8,0.1)', border: '1px solid rgba(234,179,8,0.2)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Award style={{ width: 36, height: 36, color: '#eab308' }} />
            </div>

            <h2 style={{ fontSize: 22, fontWeight: 800, color: '#fff', marginBottom: 8 }}>
              Course Completed! 🎉
            </h2>
            <p style={{ color: '#a1a1aa', fontSize: 14, marginBottom: 24 }}>
              You've completed <strong style={{ color: '#fff' }}>{course?.name}</strong>
            </p>

            {/* Name input field */}
            <div style={{ marginBottom: 20, textAlign: 'left' }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#a1a1aa', marginBottom: 8 }}>
                Enter your full name for the certificate:
              </label>
              <input
                type="text"
                value={studentFullName}
                onChange={(e) => {
                  setStudentFullName(e.target.value)
                  setCertPdfUrl(null)
                  setCertId(null)
                  setCertError('')
                }}
                placeholder="John Doe"
                autoComplete="name"
                style={{
                  width: '100%', padding: '12px 16px', borderRadius: 10,
                  fontSize: 14, fontWeight: 600, color: '#fff',
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  outline: 'none',
                }}
                onFocus={(e) => e.target.style.borderColor = 'rgba(234,179,8,0.5)'}
                onBlur={(e) => {
                  e.target.style.borderColor = 'rgba(255,255,255,0.1)'

                }}
              />
              <p style={{ fontSize: 11, color: '#52525b', marginTop: 6 }}>
                This name will appear on your certificate. Make sure it's spelled correctly.
                {savingStudentName && ' Saving...'}
              </p>
            </div>

            {/* Certificate preview card */}
            <div style={{
              borderRadius: 12, padding: 18, marginBottom: 24, textAlign: 'left',
              background: 'rgba(234,179,8,0.04)', border: '1px solid rgba(234,179,8,0.12)',
            }}>
              <p style={{ fontSize: 10, color: '#52525b', marginBottom: 4 }}>This certifies that</p>
              <p style={{ fontSize: 18, fontWeight: 800, color: '#fff', marginBottom: 4 }}>
                {studentFullName.trim() || user?.user_metadata?.full_name || user?.email || 'Your Name'}
              </p>
              <p style={{ fontSize: 11, color: '#52525b', marginBottom: 4 }}>has successfully completed</p>
              <p style={{ fontSize: 14, fontWeight: 700, color: '#eab308', marginBottom: 8 }}>{course?.name}</p>
              <p style={{ fontSize: 11, color: '#52525b' }}>
                Issued by {course?.host_name || 'Creator'} · {new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}
              </p>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {studentFullName.trim() && !certPdfUrl && !certGenerating && (
                <button
                  onClick={() => generateCertificate()}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                    padding: '12px 0', borderRadius: 12, fontWeight: 700, fontSize: 14,
                    color: '#eab308', background: 'rgba(234,179,8,0.1)',
                    border: '1px solid rgba(234,179,8,0.25)', cursor: 'pointer',
                  }}>
                  <Download style={{ width: 16, height: 16 }} /> Generate Certificate
                </button>
              )}

              {certGenerating && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '10px 0', color: '#a1a1aa', fontSize: 13 }}>
                  <div style={{ width: 14, height: 14, borderRadius: '50%', background: 'var(--kurso-primary)', animation: 'pulse 1s infinite' }} />
                  Generating certificate…
                </div>
              )}
              {certError && !certGenerating && (
                <p style={{ color: '#f87171', fontSize: 12, textAlign: 'center' }}>
                  {certError}
                </p>
              )}

              {certPdfUrl && (
                <a
                  href={certPdfUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                    padding: '12px 0', borderRadius: 12, fontWeight: 700, fontSize: 14,
                    color: '#eab308', background: 'rgba(234,179,8,0.1)',
                    border: '1px solid rgba(234,179,8,0.25)', textDecoration: 'none',
                  }}>
                  <Download style={{ width: 16, height: 16 }} /> Download Certificate PDF
                </a>
              )}

              {certId && (
                <Link
                  href={`/certificate/${certId}`}
                  target="_blank"
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                    padding: '10px 0', fontSize: 12, fontWeight: 600,
                    color: 'var(--kurso-primary-lighter)', textDecoration: 'none',
                  }}>
                  <ExternalLink style={{ width: 13, height: 13 }} /> View verification page
                </Link>
              )}

              <button
                onClick={() => setShowCertModal(false)}
                style={{
                  padding: '11px 0', borderRadius: 12, fontWeight: 700, fontSize: 13,
                  color: '#a1a1aa', background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.08)', cursor: 'pointer',
                }}>
                Back to Course
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── LIVE SESSIONS (sidebar) ──
// Separate from the `lessons` list above — these come from the
// live_sessions table (scheduled multi-session live classes, distinct
// from a per-lesson content_type of 'live'). Enrolled students only.
interface LiveSessionItem {
  id: string
  title: string
  scheduled_at: string
  duration_minutes: number
  join_url: string
  has_recording?: boolean
}

function LiveSessionsSidebarSection({ courseId, sessionToken, studentName, studentId }: { courseId: string; sessionToken: string | null; studentName: string; studentId: string }) {
  const [sessions, setSessions] = useState<LiveSessionItem[]>([])
  const [playingSessionId, setPlayingSessionId] = useState<string | null>(null)
  const [playerUrl, setPlayerUrl] = useState<string | null>(null)
  const [playerIsExternal, setPlayerIsExternal] = useState(false)
  const [loadingPlayback, setLoadingPlayback] = useState(false)
  const [playbackError, setPlaybackError] = useState('')

  useEffect(() => {
    let cancelled = false
    fetch(`/api/live-sessions?courseId=${courseId}`)
      .then(res => res.json())
      .then(json => { if (!cancelled) setSessions(json.sessions || []) })
      .catch(() => { })
    return () => { cancelled = true }
  }, [courseId])

  async function watchRecording(sessionId: string) {
    if (!sessionToken) {
      setPlaybackError('Please log in again to watch this recording.')
      return
    }
    setPlayingSessionId(sessionId)
    setLoadingPlayback(true)
    setPlaybackError('')
    setPlayerUrl(null)
    setPlayerIsExternal(false)
    try {
      const res = await fetch(`/api/live-sessions/${sessionId}/sign-recording`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${sessionToken}` },
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Could not load recording')
      setPlayerUrl(json.url)
      setPlayerIsExternal(!!json.external)
    } catch (err: any) {
      setPlaybackError(err.message || 'Could not load recording')
    } finally {
      setLoadingPlayback(false)
    }
  }

  if (sessions.length === 0) return null

  const now = Date.now()
  const upcoming = sessions.filter(s => new Date(s.scheduled_at).getTime() >= now)
  const pastWithRecording = sessions.filter(s => new Date(s.scheduled_at).getTime() < now && s.has_recording)

  return (
    <>
      <div style={{ padding: '14px 16px', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
        <p style={{ fontSize: 10, fontWeight: 700, color: '#3f3f46', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 10 }}>
          Live Sessions
        </p>

        {upcoming.map(s => (
          <a key={s.id} href={s.join_url} target="_blank" rel="noopener noreferrer"
            style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '8px 0', textDecoration: 'none' }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: '#e4e4e7' }}>🔴 {s.title}</span>
            <span style={{ fontSize: 10, color: 'var(--kurso-primary-light)' }}>
              {new Date(s.scheduled_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true })} — Join link
            </span>
          </a>
        ))}

        {pastWithRecording.map(s => (
          <button key={s.id} onClick={() => watchRecording(s.id)}
            style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '8px 0', width: '100%', textAlign: 'left', background: 'transparent', border: 'none', cursor: 'pointer' }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: '#e4e4e7' }}>📼 {s.title}</span>
            <span style={{ fontSize: 10, color: '#4ade80' }}>Watch recording</span>
          </button>
        ))}
      </div>

      {playingSessionId && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
          onClick={() => setPlayingSessionId(null)}>
          <div style={{ width: '100%', maxWidth: 720 }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
              <button onClick={() => setPlayingSessionId(null)}
                style={{ background: 'rgba(255,255,255,0.08)', border: 'none', borderRadius: 8, color: '#fff', padding: '6px 12px', fontSize: 12, cursor: 'pointer' }}>
                Close
              </button>
            </div>
            {loadingPlayback ? (
              <div style={{ aspectRatio: '16/9', background: '#111', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ width: 32, height: 32, borderRadius: 8, background: 'linear-gradient(135deg,var(--kurso-primary),var(--kurso-secondary))', animation: 'pulse 1s infinite' }} />
              </div>
            ) : playbackError ? (
              <div style={{ aspectRatio: '16/9', background: '#111', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center' }}>
                <p style={{ color: '#ef4444', fontSize: 13 }}>{playbackError}</p>
              </div>
            ) : playerUrl && playerIsExternal ? (
              <div style={{ aspectRatio: '16/9', background: '#111', borderRadius: 12, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center', gap: 12 }}>
                <p style={{ color: '#a1a1aa', fontSize: 13, maxWidth: 420 }}>
                  Your instructor shared this recording as an external link — it opens outside Kurso, so playback protection doesn't apply to it the way it does for uploaded recordings.
                </p>
                <a href={playerUrl} target="_blank" rel="noopener noreferrer"
                  style={{ display: 'inline-block', padding: '10px 24px', borderRadius: 999, background: '#fff', color: '#000', fontWeight: 600, textDecoration: 'none', fontSize: 13 }}>
                  Watch recording →
                </a>
              </div>
            ) : playerUrl ? (
              <WatermarkedPlayer
                src={playerUrl}
                studentName={studentName}
                studentId={studentId}
                lessonTitle="Live class recording"
                lessonId={playingSessionId ?? undefined}
                onExpired={() => watchRecording(playingSessionId)}
              />
            ) : null}
          </div>
        </div>
      )}
    </>
  )
}