'use client'
import { useEffect, useState, useRef } from 'react'
import Sidebar from '@/components/Sidebar'
import AudienceSwitch, { useAudienceMode } from '@/components/AudienceSwitch'
import WorkshopOverviewView from '@/components/workshop-views/WorkshopOverviewView'
import { supabase } from '@/lib/supabase'
import Link from 'next/link'
import {
  Users, BookOpen, IndianRupee, Megaphone,
  BarChart3, Shield, ClipboardList, Ticket,
  ChevronRight, ArrowUpRight, ChevronDown, Check,
  TrendingUp, AlertCircle, Play, Eye, EyeOff,
  Zap, Clock, CheckCircle2, XCircle, Download
} from 'lucide-react'

interface Course {
  id: string
  name: string
  price: number
  total_lessons: number
  is_published: boolean
  created_at: string
}

interface CourseStats {
  // lessons
  plannedLessons: number
  uploadedLessons: number
  publishedLessons: number
  // students
  totalStudents: number
  activeStudents: number // accessed in last 7d
  completedStudents: number
  avgProgress: number
  // revenue
  totalRevenue: number
  thisMonthRevenue: number
  avgOrderValue: number
  paidCount: number
  // coupons
  activeCoupons: number
  couponUses: number
  // assignments
  pendingAssignments: number
  totalAssignments: number
  // broadcasts
  totalBroadcasts: number
  latestBroadcast: any
}

const emptyStats: CourseStats = {
  plannedLessons: 0, uploadedLessons: 0, publishedLessons: 0,
  totalStudents: 0, activeStudents: 0, completedStudents: 0, avgProgress: 0,
  totalRevenue: 0, thisMonthRevenue: 0, avgOrderValue: 0, paidCount: 0,
  activeCoupons: 0, couponUses: 0,
  pendingAssignments: 0, totalAssignments: 0,
  totalBroadcasts: 0, latestBroadcast: null,
}

// ── Course Selector Dropdown ──────────────────────────────────────────────────
function CourseSelector({
  courses,
  selected,
  onSelect,
}: {
  courses: Course[]
  selected: string
  onSelect: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function close(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  const selectedCourse = courses.find(c => c.id === selected)
  const label = selectedCourse ? selectedCourse.name : ''

  return (
    <div ref={ref} className="relative w-full sm:w-[280px]">
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-2 px-5 py-3 rounded-xl text-sm font-semibold transition-all"
        style={{
          background: 'rgba(var(--kurso-primary-rgb), 0.2)',
          border: '2px solid rgba(var(--kurso-primary-rgb), 0.5)',
          color: '#e4e4e7',
          width: '100%',
        }}
        onMouseEnter={e => {
          e.currentTarget.style.background = 'rgba(var(--kurso-primary-rgb), 0.25)'
          e.currentTarget.style.borderColor = 'rgba(var(--kurso-primary-rgb), 0.7)'
        }}
        onMouseLeave={e => {
          e.currentTarget.style.background = 'rgba(var(--kurso-primary-rgb), 0.2)'
          e.currentTarget.style.borderColor = 'rgba(var(--kurso-primary-rgb), 0.5)'
        }}
      >
        <BookOpen className="w-5 h-5 flex-shrink-0" style={{ color: 'var(--kurso-primary-lighter)' }} />
        <span className="flex-1 text-left truncate font-bold">{label}</span>
        <ChevronDown
          className="w-5 h-5 flex-shrink-0 transition-transform"
          style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)', color: 'var(--kurso-primary-lighter)' }}
        />
      </button>

      {open && (
        <div
          className="absolute left-0 right-0 mt-1.5 rounded-xl overflow-hidden z-50"
          style={{
            background: '#111',
            border: '2px solid rgba(var(--kurso-primary-rgb), 0.5)',
            boxShadow: '0 16px 48px rgba(0,0,0,0.6)',
            top: '100%',
          }}
        >
          {/* Individual courses */}
          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            {courses.map(course => {
              const isActive = selected === course.id
              return (
                <button
                  key={course.id}
                  onClick={() => { onSelect(course.id); setOpen(false) }}
                  className="w-full flex items-center gap-3 px-5 py-3 text-sm transition-all text-left group"
                  style={{
                    background: isActive ? 'rgba(var(--kurso-primary-rgb), 0.15)' : 'transparent',
                    color: isActive ? '#e4e4e7' : '#a1a1aa',
                    borderBottom: '1px solid rgba(255,255,255,0.05)',
                  }}
                  onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = 'rgba(255,255,255,0.04)' }}
                  onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent' }}
                >
                  <div className="w-5 h-5 flex items-center justify-center flex-shrink-0">
                    {isActive && <Check className="w-4 h-4" style={{ color: 'var(--kurso-primary-lighter)' }} />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p
                      className="font-semibold truncate"
                      style={{ color: isActive ? '#e4e4e7' : '#d4d4d8' }}
                      title={course.name}
                    >
                      {course.name}
                    </p>
                    <p className="text-xs mt-0.5" style={{ color: '#52525b' }}>
                      ₹{course.price.toLocaleString('en-IN')} · {course.total_lessons} lessons
                      · {course.is_published ? 'Live' : 'Draft'}
                    </p>
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Stat Pill ─────────────────────────────────────────────────────────────────
function Pill({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: color }} />
      <span className="text-xs font-medium" style={{ color: 'var(--kurso-text-muted)' }}>{label}</span>
      <span className="text-xs font-bold" style={{ color }}>{value}</span>
    </div>
  )
}

// ── Progress Bar ──────────────────────────────────────────────────────────────
function ProgressBar({ value, max, color = 'var(--kurso-primary)' }: { value: number; max: number; color?: string }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0
  return (
    <div className="w-full rounded-full overflow-hidden" style={{ height: 4, background: 'rgba(255,255,255,0.07)' }}>
      <div
        className="h-full rounded-full transition-all duration-500"
        style={{ width: `${pct}%`, background: color }}
      />
    </div>
  )
}

// ── Big Number Card ───────────────────────────────────────────────────────────
function BigCard({
  title,
  subtitle,
  value,
  unit,
  accent,
  href,
  children,
  badge,
}: {
  title: string
  subtitle: string
  value: string | number
  unit?: string
  accent: string
  href: string
  children?: React.ReactNode
  badge?: React.ReactNode
}) {
  return (
    <Link
      href={href}
      className="group rounded-2xl p-5 flex flex-col gap-4 transition-all duration-200"
      style={{
        background: 'rgba(255,255,255,0.025)',
        border: '1px solid rgba(255,255,255,0.07)',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.borderColor = `${accent}55`
        e.currentTarget.style.background = `${accent}08`
      }}
      onMouseLeave={e => {
        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)'
        e.currentTarget.style.background = 'rgba(255,255,255,0.025)'
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider mb-0.5" style={{ color: 'var(--kurso-text-muted)' }}>{title}</p>
          <p className="text-xs" style={{ color: 'var(--kurso-text-muted)', opacity: 0.8 }}>{subtitle}</p>
        </div>
        {badge}
      </div>

      <div className="flex items-baseline gap-1.5">
        {unit && <span className="text-sm font-bold" style={{ color: accent }}>{unit}</span>}
        <span className="text-3xl font-black tracking-tight text-white">{value}</span>
      </div>

      {children && <div>{children}</div>}

      <div
        className="flex items-center gap-1 text-xs font-medium mt-auto opacity-0 group-hover:opacity-100 transition-opacity"
        style={{ color: accent }}
      >
        View details <ChevronRight className="w-3 h-3" />
      </div>
    </Link>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const [audience, setAudience] = useAudienceMode()
  const [user, setUser] = useState<any>(null)
  const [courses, setCourses] = useState<Course[]>([])
  const [selectedCourseId, setSelectedCourseId] = useState<string>('')
  const [stats, setStats] = useState<CourseStats>(emptyStats)
  const [totalAllRevenue, setTotalAllRevenue] = useState(0)
  const [loading, setLoading] = useState(true)

  // Fetch all courses on mount and set default to most recent
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUser(data.user))
    async function loadCourses() {
      const { data: { user: currentUser } } = await supabase.auth.getUser()
      if (!currentUser) return
      const { data } = await supabase
        .from('courses')
        .select('id, name, price, total_lessons, is_published, created_at')
        .eq('creator_id', currentUser.id)
        .order('created_at', { ascending: false })
      const loadedCourses = data || []
      setCourses(loadedCourses)
      if (loadedCourses.length > 0) {
        setSelectedCourseId(loadedCourses[0].id)
      }
    }
    loadCourses()
  }, [])

  // Load total revenue across all courses separately
  useEffect(() => {
    async function loadTotalRevenue() {
      const { data: { user: currentUser } } = await supabase.auth.getUser()
      if (!currentUser) return
      const { data: enrolls } = await supabase
        .from('enrollments')
        .select('amount_paid, payment_status')
        .eq('creator_id', currentUser.id)
        .eq('is_test', false)
      const paid = (enrolls || []).filter(e => e.payment_status === 'paid')
      const total = paid.reduce((acc, e) => acc + (e.amount_paid || 0), 0)
      setTotalAllRevenue(total)
    }
    loadTotalRevenue()
  }, [])

  // Re-fetch stats whenever selected course changes
  useEffect(() => {
    if (courses.length === 0) {
      // No courses yet — stop showing the loading skeleton and fall
      // through to the normal card grid with zeroed-out stats, instead of
      // returning early and leaving `loading` stuck true forever (which
      // is what was rendering as permanently-blank grey boxes).
      setStats(emptyStats)
      setLoading(false)
      return
    }
    if (!selectedCourseId) return
    loadStats()
  }, [selectedCourseId, courses])

  async function loadStats() {
    setLoading(true)
    const { data: { user: currentUser } } = await supabase.auth.getUser()
    if (!currentUser) return

    const courseIds = [selectedCourseId]

    try {
      // ── Lessons ──
      let uploadedLessons = 0
      let publishedLessons = 0
      let plannedLessons = 0

      if (courseIds.length > 0) {
        const { data: lessonRows } = await supabase
          .from('lessons')
          .select('id, is_published, course_id')
          .in('course_id', courseIds)

        uploadedLessons = lessonRows?.length || 0
        publishedLessons = lessonRows?.filter(l => l.is_published).length || 0

        const course = courses.find(c => c.id === selectedCourseId)
        plannedLessons = Math.max(course?.total_lessons || 0, uploadedLessons)
      }

      // ── Enrollments / Students ──
      let enrollQ = supabase
        .from('enrollments')
        .select('id, amount_paid, completed_lessons, current_lesson, last_accessed, payment_status, enrolled_at')
        .eq('creator_id', currentUser.id)
        .eq('course_uuid', selectedCourseId)
        .eq('is_test', false)

      const { data: enrolls } = await enrollQ
      const paid = (enrolls || []).filter(e => e.payment_status === 'paid')

      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
      const activeStudents = paid.filter(e => e.last_accessed && e.last_accessed >= sevenDaysAgo).length
      const completedStudents = paid.filter(e => {
        const target = courses.find(c => c.id === selectedCourseId)?.total_lessons || publishedLessons
        return Array.isArray(e.completed_lessons) && e.completed_lessons.length >= target && target > 0
      }).length

      const totalRevenue = paid.reduce((acc, e) => acc + (e.amount_paid || 0), 0)

      const thisMonthStart = new Date()
      thisMonthStart.setDate(1)
      thisMonthStart.setHours(0, 0, 0, 0)
      const thisMonthRevenue = paid
        .filter(e => new Date(e.enrolled_at) >= thisMonthStart)
        .reduce((acc, e) => acc + (e.amount_paid || 0), 0)

      const avgOrderValue = paid.length > 0 ? Math.round(totalRevenue / paid.length) : 0

      // avg progress
      let avgProgress = 0
      if (paid.length > 0 && publishedLessons > 0) {
        const totalPct = paid.reduce((acc, e) => {
          const done = Array.isArray(e.completed_lessons) ? e.completed_lessons.length : 0
          return acc + Math.min(done / publishedLessons, 1) * 100
        }, 0)
        avgProgress = Math.round(totalPct / paid.length)
      }

      // ── Assignments ──
      let totalAssignments = 0
      let pendingAssignments = 0
      if (courseIds.length > 0) {
        try {
          const { data: assignments } = await supabase
            .from('assignments')
            .select('id, status')
            .in('course_id', courseIds)
          if (assignments) {
            totalAssignments = assignments.length
            pendingAssignments = assignments.filter(a => a.status === 'pending').length
          }
        } catch { /* non-fatal */ }
      }

      // ── Coupons ──
      let activeCoupons = 0
      let couponUses = 0
      try {
        let couponQ = supabase.from('coupons').select('id, times_used, is_active').eq('creator_id', currentUser.id).eq('course_id', selectedCourseId)
        const { data: coupons } = await couponQ
        if (coupons) {
          activeCoupons = coupons.filter(c => c.is_active).length
          couponUses = coupons.reduce((acc, c) => acc + (c.times_used || 0), 0)
        }
      } catch { /* non-fatal */ }

      // ── Broadcasts ──
      let totalBroadcasts = 0
      let latestBroadcast = null
      try {
        let bcQ = supabase
          .from('broadcasts')
          .select('*')
          .eq('creator_id', currentUser.id)
          .eq('course_id', selectedCourseId)
          .order('sent_at', { ascending: false })
        const { data: broadcasts } = await bcQ
        if (broadcasts) {
          totalBroadcasts = broadcasts.length
          latestBroadcast = broadcasts[0] || null
        }
      } catch { /* non-fatal */ }

      setStats({
        plannedLessons,
        uploadedLessons,
        publishedLessons,
        totalStudents: paid.length,
        activeStudents,
        completedStudents,
        avgProgress,
        totalRevenue,
        thisMonthRevenue,
        avgOrderValue,
        paidCount: paid.length,
        activeCoupons,
        couponUses,
        pendingAssignments,
        totalAssignments,
        totalBroadcasts,
        latestBroadcast,
      })
    } catch (err) {
      console.error('Dashboard stats error:', err)
    }

    setLoading(false)
  }

  const selectedCourse = courses.find(c => c.id === selectedCourseId)
  const greeting = user?.user_metadata?.full_name
    ? user.user_metadata.full_name.split(' ')[0]
    : user?.email?.split('@')[0] || ''

  return (
    <div className="min-h-screen bg-black text-white">
      <Sidebar />
      <main className="md:ml-56 p-5 md:p-8 pt-20 md:pt-8 font-sans">
        <AudienceSwitch value={audience} onChange={setAudience} />
        {audience === 'workshops' ? (
          <WorkshopOverviewView />
        ) : (
          <>

        {/* ── HEADER ── */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-7">
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight text-white">
              {greeting ? `Hey, ${greeting}` : 'Dashboard'}
            </h1>
            <p className="text-sm mt-1 font-medium" style={{ color: 'var(--kurso-text-secondary)' }}>
              {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
            </p>
          </div>
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 w-full sm:w-auto">
            <span className="text-xs font-semibold uppercase tracking-wider flex-shrink-0" style={{ color: 'var(--kurso-text-muted)' }}>
              Select course
            </span>
                        <CourseSelector
              courses={courses}
              selected={selectedCourseId}
              onSelect={setSelectedCourseId}
            />
            <button
              onClick={async () => {
                const { data: { session } } = await supabase.auth.getSession()
                if (!session) return
                const res = await fetch('/api/creator/students/export', {
                  headers: { Authorization: `Bearer ${session.access_token}` },
                })
                if (!res.ok) return
                const blob = await res.blob()
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = `all-students-${new Date().toISOString().slice(0, 10)}.csv`
                a.click()
                URL.revokeObjectURL(url)
              }}
              className="hidden sm:flex items-center gap-1.5 px-3 py-2.5 rounded-xl text-xs font-semibold transition-all flex-shrink-0"
              style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#e4e4e7' }}
            >
              <Download className="w-3.5 h-3.5" /> Export all students
            </button>
            <Link
              href="/contact"
              className="hidden sm:flex items-center gap-1.5 px-3 py-2.5 rounded-xl text-xs font-semibold transition-all flex-shrink-0"
              style={{ background: 'rgba(var(--kurso-primary-rgb), 0.1)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.2)', color: 'var(--kurso-primary-lighter)' }}
            >
              <ArrowUpRight className="w-3.5 h-3.5" /> Support
            </Link>
          </div>
        </div>

        {/* ── CONTEXT BANNER (when a course is selected) ── */}
        {selectedCourse && (
          <div
            className="flex items-center justify-between gap-4 px-4 py-3 rounded-xl mb-6 flex-wrap"
            style={{ background: 'rgba(var(--kurso-primary-rgb), 0.07)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.2)' }}
          >
            <div className="flex items-center gap-3 min-w-0">
              <div
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ background: selectedCourse.is_published ? '#4ade80' : 'var(--kurso-accent)' }}
              />
              <span className="text-sm font-semibold text-white truncate">{selectedCourse.name}</span>
              <span className="text-xs px-2 py-0.5 rounded-full flex-shrink-0" style={{ background: 'rgba(255,255,255,0.06)', color: '#71717a' }}>
                {selectedCourse.is_published ? 'Live' : 'Draft'}
              </span>
            </div>
            <div className="flex items-center gap-4 flex-shrink-0 text-xs" style={{ color: '#52525b' }}>
              <span>₹{selectedCourse.price.toLocaleString('en-IN')}</span>
              <Link href={`/dashboard/courses/${selectedCourse.id}`} className="text-violet-400 font-semibold hover:underline">
                Manage →
              </Link>
            </div>
          </div>
        )}

        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-40 rounded-2xl animate-pulse" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }} />
            ))}
          </div>
        ) : (
          <>
            {courses.length === 0 && (
              <div className="rounded-2xl p-5 mb-4 flex items-center justify-between gap-4 flex-wrap"
                style={{ background: 'rgba(var(--kurso-primary-rgb), 0.08)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.2)' }}>
                <div>
                  <p className="text-sm font-semibold text-white">No courses yet</p>
                  <p className="text-xs mt-0.5" style={{ color: '#a1a1aa' }}>The cards below will fill in once you create your first course.</p>
                </div>
                <Link href="/dashboard/courses/create"
                  className="px-4 py-2 rounded-xl text-sm font-medium text-white flex-shrink-0"
                  style={{ background: 'linear-gradient(135deg, var(--kurso-primary), var(--kurso-primary-light))' }}>
                  Create your first course
                </Link>
              </div>
            )}
            {/* ── ROW 1: Top-line numbers ── */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-4">

              {/* Lessons */}
              <BigCard
                title="Lessons"
                subtitle="Content library"
                value={stats.uploadedLessons}
                accent="var(--kurso-primary-lighter)"
                href={selectedCourseId ? `/dashboard/courses/${selectedCourseId}` : '/dashboard/courses/create'}
                badge={
                  <span
                    className="text-xs px-2 py-0.5 rounded-full font-bold flex-shrink-0"
                    style={{
                      background: stats.publishedLessons === stats.uploadedLessons && stats.uploadedLessons > 0
                        ? 'rgba(74,222,128,0.12)' : 'rgba(245,158,11,0.12)',
                      color: stats.publishedLessons === stats.uploadedLessons && stats.uploadedLessons > 0
                        ? 'var(--kurso-success)' : 'var(--kurso-accent)',
                    }}
                  >
                    {stats.publishedLessons === stats.uploadedLessons && stats.uploadedLessons > 0 ? 'All live' : `${stats.publishedLessons} live`}
                  </span>
                }
              >
                <div className="flex flex-col gap-1.5">
                  <ProgressBar value={stats.publishedLessons} max={stats.uploadedLessons || 1} color="var(--kurso-primary-lighter)" />
                  <div className="flex justify-between text-xs" style={{ color: 'var(--kurso-text-muted)' }}>
                    <span>{stats.publishedLessons} published</span>
                    <span>{stats.plannedLessons} planned</span>
                  </div>
                </div>
              </BigCard>

              {/* Students */}
              <BigCard
                title="Students"
                subtitle="Paid enrollments"
                value={stats.totalStudents}
                accent="var(--kurso-info)"
                href="/dashboard/students"
                badge={
                  stats.totalStudents > 0 ? (
                    <span className="text-xs px-2 py-0.5 rounded-full font-bold flex-shrink-0"
                      style={{ background: 'rgba(56,189,248,0.1)', color: 'var(--kurso-info)' }}>
                      {stats.activeStudents} active
                    </span>
                  ) : undefined
                }
              >
                <div className="flex flex-col gap-1.5">
                  <ProgressBar value={stats.completedStudents} max={stats.totalStudents || 1} color="var(--kurso-info)" />
                  <div className="flex justify-between text-xs" style={{ color: 'var(--kurso-text-muted)' }}>
                    <span>{stats.completedStudents} completed</span>
                    <span>{stats.avgProgress}% avg</span>
                  </div>
                </div>
              </BigCard>

              {/* Revenue (selected course) */}
              <BigCard
                title="Course Revenue"
                subtitle="Gross sales for this course"
                value={stats.totalRevenue.toLocaleString('en-IN')}
                unit="₹"
                accent="var(--kurso-success)"
                href="/dashboard/revenue"
                badge={
                  stats.thisMonthRevenue > 0 ? (
                    <span className="text-xs px-2 py-0.5 rounded-full font-bold flex-shrink-0"
                      style={{ background: 'rgba(74,222,128,0.1)', color: 'var(--kurso-success)' }}>
                      +₹{stats.thisMonthRevenue.toLocaleString('en-IN')} this month
                    </span>
                  ) : undefined
                }
              >
                <div className="flex gap-3">
                  <Pill label="orders" value={stats.paidCount} color="var(--kurso-success)" />
                  {stats.avgOrderValue > 0 && (
                    <Pill label="avg" value={`₹${stats.avgOrderValue.toLocaleString('en-IN')}`} color="var(--kurso-success)" />
                  )}
                </div>
              </BigCard>
            </div>

            {/* ── ROW 2: Secondary stats ── */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-4">

              {/* Assignments */}
              <BigCard
                title="Assignments"
                subtitle="Student submissions"
                value={stats.totalAssignments}
                accent="var(--kurso-accent)"
                href="/dashboard/assignments"
                badge={
                  stats.pendingAssignments > 0 ? (
                    <span className="text-xs px-2 py-0.5 rounded-full font-bold animate-pulse flex-shrink-0"
                      style={{ background: 'rgba(245,158,11,0.15)', color: 'var(--kurso-accent)' }}>
                      {stats.pendingAssignments} pending
                    </span>
                  ) : stats.totalAssignments > 0 ? (
                    <span className="text-xs px-2 py-0.5 rounded-full font-bold flex-shrink-0"
                      style={{ background: 'rgba(74,222,128,0.1)', color: 'var(--kurso-success)' }}>
                      All reviewed
                    </span>
                  ) : undefined
                }
              >
                {stats.pendingAssignments > 0 ? (
                  <div className="flex items-center gap-1.5">
                    <AlertCircle className="w-3.5 h-3.5" style={{ color: 'var(--kurso-accent)' }} />
                    <span className="text-xs" style={{ color: 'var(--kurso-accent)' }}>
                      {stats.pendingAssignments} need your review
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5" style={{ color: stats.totalAssignments > 0 ? 'var(--kurso-success)' : 'var(--kurso-text-muted)' }} />
                    <span className="text-xs" style={{ color: 'var(--kurso-text-muted)' }}>
                      {stats.totalAssignments > 0 ? 'Inbox clear' : 'No submissions yet'}
                    </span>
                  </div>
                )}
              </BigCard>

              {/* Coupons */}
              <BigCard
                title="Coupons"
                subtitle="Promo codes"
                value={stats.activeCoupons}
                accent="var(--kurso-purple)"
                href="/dashboard/coupons"
                badge={
                  stats.couponUses > 0 ? (
                    <span className="text-xs px-2 py-0.5 rounded-full font-bold flex-shrink-0"
                      style={{ background: 'rgba(192,132,252,0.12)', color: 'var(--kurso-purple)' }}>
                      {stats.couponUses} uses
                    </span>
                  ) : undefined
                }
              >
                <div className="flex gap-3">
                  <Pill label="active" value={stats.activeCoupons} color="var(--kurso-purple)" />
                  <Pill label="redeemed" value={stats.couponUses} color="var(--kurso-primary-lighter)" />
                </div>
              </BigCard>

              {/* Total Revenue (all courses) — moved here, Broadcasts widget removed */}
              <BigCard
                title="Total Revenue"
                subtitle="Gross sales across all courses"
                value={totalAllRevenue.toLocaleString('en-IN')}
                unit="₹"
                accent="var(--kurso-success)"
                href="/dashboard/revenue"
                badge={
                  <span className="text-xs px-2 py-0.5 rounded-full font-bold flex-shrink-0"
                    style={{ background: 'rgba(74,222,128,0.12)', color: 'var(--kurso-success)' }}>
                    All courses
                  </span>
                }
              >
                <div className="flex items-center gap-2">
                  <TrendingUp className="w-4 h-4" style={{ color: 'var(--kurso-success)' }} />
                  <span className="text-xs" style={{ color: 'var(--kurso-text-muted)' }}>
                    View detailed report
                  </span>
                </div>
              </BigCard>
            </div>

            {/* ── QUICK ACTIONS — hidden on mobile ── */}
            <div
              className="hidden md:grid grid-cols-2 sm:grid-cols-4 gap-2 mt-2"
            >
              {[
                { label: 'Add lesson', href: `/dashboard/courses/${selectedCourseId}`, icon: BookOpen, color: 'var(--kurso-primary-lighter)' },
                { label: 'View students', href: '/dashboard/students', icon: Users, color: '#38bdf8' },
                { label: 'Send broadcast', href: '/dashboard/broadcast', icon: Megaphone, color: '#fbbf24' },
                { label: 'Revenue report', href: '/dashboard/revenue', icon: TrendingUp, color: '#4ade80' },
              ].map(({ label, href, icon: Icon, color }) => (
                <Link
                  key={label}
                  href={href}
                  className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-semibold transition-all group"
                  style={{
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(255,255,255,0.06)',
                    color: '#a1a1aa',
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.background = `${color}12`
                    e.currentTarget.style.borderColor = `${color}40`
                    e.currentTarget.style.color = color
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.background = 'rgba(255,255,255,0.03)'
                    e.currentTarget.style.borderColor = 'rgba(255,255,255,0.06)'
                    e.currentTarget.style.color = '#a1a1aa'
                  }}
                >
                  <Icon className="w-4 h-4 flex-shrink-0" />
                  {label}
                  <ChevronRight className="w-3.5 h-3.5 ml-auto opacity-0 group-hover:opacity-100 transition-opacity" />
                </Link>
              ))}
            </div>
          </>
    )}
      </>
    )}
  </main>
</div>
  )
}
