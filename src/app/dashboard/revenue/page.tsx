'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import Sidebar from '@/components/Sidebar'
import AudienceSwitch, { useAudienceMode } from '@/components/AudienceSwitch'
import WorkshopRevenueView from '@/components/workshop-views/WorkshopRevenueView'
import { supabase } from '@/lib/supabase'
import {
  AlertCircle,
  ArrowUpRight,
  BarChart3,
  BookOpen,
  CheckCircle2,
  Clock3,
  IndianRupee,
  ReceiptText,
  RefreshCw,
  TrendingUp,
  Users,
  XCircle,
} from 'lucide-react'

type RevenueSummary = {
  creator_id: string
  total_revenue: number
  revenue_this_month: number
  revenue_last_month: number
  successful_payments: number
  pending_payments: number
  failed_payments: number
  refunded_payments: number
  average_order_value: number
  last_sale_at: string | null
}

type CourseRevenue = {
  course_id: string
  course_name: string
  course_slug: string
  current_course_price: number
  total_revenue: number
  revenue_this_month: number
  successful_payments: number
  paid_students: number
  average_order_value: number
  last_sale_at: string | null
}

type RecentPayment = {
  payment_id: string
  course_id: string | null
  course_name: string | null
  course_slug: string | null
  student_id: string | null
  buyer_name: string | null
  buyer_email: string | null
  buyer_phone: string | null
  provider: string
  provider_payment_id: string | null
  currency: string
  gross_amount: number
  discount_amount: number
  net_amount: number
  platform_fee: number
  creator_earning: number
  status: 'pending' | 'paid' | 'failed' | 'refunded' | 'partially_refunded' | string
  paid_at: string | null
  refunded_at: string | null
  failed_at: string | null
  created_at: string
}

type MonthlyRevenue = {
  month: string
  revenue: number
  successful_payments: number
  courses_sold: number
  paid_students: number
  average_order_value: number
}

const emptySummary: RevenueSummary = {
  creator_id: '',
  total_revenue: 0,
  revenue_this_month: 0,
  revenue_last_month: 0,
  successful_payments: 0,
  pending_payments: 0,
  failed_payments: 0,
  refunded_payments: 0,
  average_order_value: 0,
  last_sale_at: null,
}

type RevenueSectionErrors = Partial<Record<'summary' | 'courses' | 'payments' | 'monthly', string>>

const money = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
})

const compactMoney = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  notation: 'compact',
  maximumFractionDigits: 1,
})

function formatMoney(value: number | null | undefined) {
  return money.format(value || 0)
}

function formatDate(value: string | null | undefined) {
  if (!value) return 'No sales yet'
  return new Date(value).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return 'Not recorded'
  return new Date(value).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function statusStyle(status: string) {
  if (status === 'paid') return { icon: CheckCircle2, label: 'Paid', color: '#22c55e', bg: 'rgba(34,197,94,0.1)' }
  if (status === 'pending') return { icon: Clock3, label: 'Pending', color: 'var(--kurso-accent)', bg: 'rgba(245,158,11,0.1)' }
  if (status === 'failed') return { icon: XCircle, label: 'Failed', color: '#ef4444', bg: 'rgba(239,68,68,0.1)' }
  return { icon: AlertCircle, label: 'Refunded', color: '#60a5fa', bg: 'rgba(96,165,250,0.1)' }
}

export default function RevenuePage() {
  const [audience, setAudience] = useAudienceMode()
  const [summary, setSummary] = useState<RevenueSummary>(emptySummary)
  const [courses, setCourses] = useState<CourseRevenue[]>([])
  const [payments, setPayments] = useState<RecentPayment[]>([])
  const [monthly, setMonthly] = useState<MonthlyRevenue[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [sectionErrors, setSectionErrors] = useState<RevenueSectionErrors>({})

  async function fetchRevenue(showRefresh = false) {
    if (showRefresh) setRefreshing(true)
    setError('')
    setSectionErrors({})

    async function loadSection<T>(
      section: keyof RevenueSectionErrors,
      request: () => PromiseLike<{ data: T | null; error: any }>,
      fallback: T,
      nextErrors: RevenueSectionErrors
    ) {
      try {
        const { data, error } = await request()
        if (error) throw error
        return data ?? fallback
      } catch (err: any) {
        console.warn(`[revenue/${section}]`, err)
        nextErrors[section] = err?.message || 'Revenue data unavailable.'
        return fallback
      }
    }

    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      const nextErrors: RevenueSectionErrors = {}
      const summaryFallback = [{ ...emptySummary, creator_id: user.id }]

      const [summaryData, courseData, paymentData, monthlyData] = await Promise.all([
        loadSection('summary', () => supabase.rpc('get_my_revenue_summary'), summaryFallback, nextErrors),
        loadSection('courses', () => supabase.rpc('get_my_course_revenue'), [] as CourseRevenue[], nextErrors),
        loadSection('payments', () => supabase.rpc('get_my_recent_payments', { limit_count: 20 }), [] as RecentPayment[], nextErrors),
        loadSection('monthly', () => supabase.rpc('get_my_monthly_revenue', { month_count: 6 }), [] as MonthlyRevenue[], nextErrors),
      ])

      setSummary((summaryData?.[0] as RevenueSummary | undefined) || { ...emptySummary, creator_id: user.id })
      setCourses((courseData || []) as CourseRevenue[])
      setPayments((paymentData || []) as RecentPayment[])
      setMonthly((monthlyData || []) as MonthlyRevenue[])
      setSectionErrors(nextErrors)
    } catch (err: any) {
      console.error('Error loading revenue dashboard:', err)
      setError(err?.message || 'Could not load revenue data.')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    fetchRevenue()
  }, [])

  const monthChange = useMemo(() => {
    if (!summary.revenue_last_month && !summary.revenue_this_month) return 0
    if (!summary.revenue_last_month) return 100
    return Math.round(((summary.revenue_this_month - summary.revenue_last_month) / summary.revenue_last_month) * 100)
  }, [summary.revenue_last_month, summary.revenue_this_month])

  const maxMonthlyRevenue = Math.max(...monthly.map(item => item.revenue), 1)
  const hasRevenue = summary.total_revenue > 0 || payments.length > 0

  const statCards = [
    {
      label: 'This month',
      value: formatMoney(summary.revenue_this_month),
      helper: monthChange >= 0 ? `${monthChange}% vs last month` : `${Math.abs(monthChange)}% below last month`,
      icon: TrendingUp,
      color: monthChange >= 0 ? '#22c55e' : 'var(--kurso-accent)',
    },
    {
      label: 'Total revenue',
      value: formatMoney(summary.total_revenue),
      helper: `${summary.successful_payments} successful sale${summary.successful_payments === 1 ? '' : 's'}`,
      icon: IndianRupee,
      color: 'var(--kurso-primary-light)',
    },
    {
      label: 'Average order',
      value: formatMoney(Math.round(summary.average_order_value || 0)),
      helper: `Last sale: ${formatDate(summary.last_sale_at)}`,
      icon: ReceiptText,
      color: '#38bdf8',
    },
    {
      label: 'Needs attention',
      value: String(summary.pending_payments + summary.failed_payments),
      helper: `${summary.pending_payments} pending, ${summary.failed_payments} failed`,
      icon: AlertCircle,
      color: 'var(--kurso-accent)',
    },
  ]

  return (
    <div className="min-h-screen bg-black">
      <Sidebar />
  <main className="md:ml-56 p-6 md:p-8 pt-20 md:pt-8">
    <AudienceSwitch value={audience} onChange={setAudience} />
    {audience === 'workshops' ? (
      <WorkshopRevenueView />
    ) : (
      <>
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
      <div>
        <h1 className="text-2xl font-bold text-white mb-1">Revenue</h1>```
            <p className="text-sm" style={{ color: '#a1a1aa' }}>
              Track course sales, payment health, and revenue by course.
            </p>
          </div>

          <button
            onClick={() => fetchRevenue(true)}
            disabled={refreshing}
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all disabled:opacity-60"
            style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff' }}
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        {error && (
          <div className="mb-6 rounded-2xl p-4 flex items-start gap-3"
            style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.18)' }}>
            <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: '#ef4444' }} />
            <div>
              <p className="text-sm font-semibold text-white">Revenue data could not be loaded</p>
              <p className="text-xs mt-1" style={{ color: '#fca5a5' }}>{error}</p>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-24">
            <div className="w-8 h-8 violet-gradient rounded-lg animate-pulse-glow" />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-8">
              {statCards.map((card) => {
                const Icon = card.icon
                return (
                  <div key={card.label} className="rounded-2xl p-5 glass" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
                    <div className="flex items-start justify-between mb-5 gap-4">
                      <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: `${card.color}18` }}>
                        <Icon className="w-5 h-5" style={{ color: card.color }} />
                      </div>
                      <span className="text-[11px] px-2 py-1 rounded-full whitespace-nowrap" style={{ background: 'rgba(255,255,255,0.05)', color: '#a1a1aa' }}>
                        INR
                      </span>
                    </div>
                    <div className="text-2xl md:text-3xl font-bold text-white mb-1 break-words">{card.value}</div>
                    <div className="text-sm font-medium mb-1" style={{ color: '#d4d4d8' }}>{card.label}</div>
                    <div className="text-xs" style={{ color: '#71717a' }}>{card.helper}</div>
                  </div>
                )
              })}
            </div>

            {sectionErrors.summary && (
              <div className="mb-8 rounded-2xl p-4 flex items-start gap-3"
                style={{ background: 'rgba(245,158,11,0.07)', border: '1px solid rgba(245,158,11,0.16)' }}>
                <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: 'var(--kurso-accent)' }} />
                <div>
                  <p className="text-sm font-semibold text-white">Revenue totals are waiting for setup</p>
                  <p className="text-xs mt-1" style={{ color: '#fbbf24' }}>Course, chart, and payment sections will still load when their data is available.</p>
                </div>
              </div>
            )}

            {!hasRevenue && (
              <div className="rounded-2xl p-8 mb-8 glass flex flex-col md:flex-row md:items-center justify-between gap-5"
                style={{ border: '1px solid rgba(139,92,246,0.18)', background: 'rgba(139,92,246,0.05)' }}>
                <div className="flex items-start gap-4">
                  <div className="w-12 h-12 rounded-2xl flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(139,92,246,0.12)' }}>
                    <BarChart3 className="w-6 h-6" style={{ color: 'var(--kurso-primary-light)' }} />
                  </div>
                  <div>
                    <h2 className="text-lg font-semibold text-white mb-1">No revenue recorded yet</h2>
                    <p className="text-sm max-w-2xl" style={{ color: '#a1a1aa' }}>
                      Once students pay for your courses, sales will appear here with course-wise revenue and payment status.
                    </p>
                  </div>
                </div>
                <Link
                  href="/dashboard/courses"
                  className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold flex-shrink-0"
                  style={{ background: 'var(--kurso-primary)', color: '#fff' }}
                >
                  View courses
                  <ArrowUpRight className="w-4 h-4" />
                </Link>
              </div>
            )}

            <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 mb-8">
              <div className="xl:col-span-2 rounded-2xl p-6 glass" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
                <div className="flex items-center justify-between gap-4 mb-6">
                  <div>
                    <h2 className="font-semibold text-white">Monthly revenue</h2>
                    <p className="text-xs mt-1" style={{ color: '#71717a' }}>Last 6 months of successful payments</p>
                  </div>
                  <BarChart3 className="w-5 h-5" style={{ color: 'var(--kurso-primary-light)' }} />
                </div>

                {monthly.length === 0 ? (
                  <div className="h-64 flex items-center justify-center text-center">
                    <p className="text-sm" style={{ color: '#52525b' }}>
                      {sectionErrors.monthly
                        ? 'Monthly revenue setup is not installed yet.'
                        : 'Your revenue chart will appear after your first paid sale.'}
                    </p>
                  </div>
                ) : (
                  <div className="h-64 flex items-end gap-3">
                    {monthly.map((item) => {
                      const height = Math.max((item.revenue / maxMonthlyRevenue) * 100, 8)
                      return (
                        <div key={item.month} className="flex-1 min-w-0 flex flex-col items-center gap-3">
                          <div className="text-xs font-medium text-white truncate w-full text-center">{compactMoney.format(item.revenue)}</div>
                          <div className="w-full h-44 flex items-end">
                            <div
                              className="w-full rounded-t-lg transition-all"
                              style={{
                                height: `${height}%`,
                                background: 'linear-gradient(180deg, var(--kurso-primary-light) 0%, rgba(139,92,246,0.18) 100%)',
                                border: '1px solid rgba(139,92,246,0.3)',
                              }}
                              title={`${formatMoney(item.revenue)} in ${formatDate(item.month)}`}
                            />
                          </div>
                          <div className="text-[11px] truncate w-full text-center" style={{ color: '#71717a' }}>
                            {new Date(item.month).toLocaleDateString('en-IN', { month: 'short' })}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              <div className="rounded-2xl p-6 glass" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
                <h2 className="font-semibold text-white mb-5">Payment health</h2>
                <div className="flex flex-col gap-3">
                  {[
                    { label: 'Successful', value: summary.successful_payments, color: '#22c55e' },
                    { label: 'Pending', value: summary.pending_payments, color: 'var(--kurso-accent)' },
                    { label: 'Failed', value: summary.failed_payments, color: '#ef4444' },
                    { label: 'Refunded', value: summary.refunded_payments, color: '#60a5fa' },
                  ].map((item) => (
                    <div key={item.label} className="flex items-center justify-between rounded-xl px-4 py-3" style={{ background: 'rgba(255,255,255,0.035)' }}>
                      <div className="flex items-center gap-3">
                        <span className="w-2.5 h-2.5 rounded-full" style={{ background: item.color }} />
                        <span className="text-sm" style={{ color: '#d4d4d8' }}>{item.label}</span>
                      </div>
                      <span className="text-sm font-semibold text-white">{item.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-5 gap-6">
              <div className="xl:col-span-2 rounded-2xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
                <div className="px-5 py-4 flex items-center justify-between" style={{ background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                  <div>
                    <h2 className="font-semibold text-white">Revenue by course</h2>
                    <p className="text-xs mt-1" style={{ color: '#71717a' }}>{courses.length} course{courses.length === 1 ? '' : 's'}</p>
                  </div>
                  <BookOpen className="w-5 h-5" style={{ color: 'var(--kurso-primary-light)' }} />
                </div>

                {courses.length === 0 ? (
                  <div className="p-10 text-center">
                    <p className="text-sm" style={{ color: '#52525b' }}>
                      {sectionErrors.courses
                        ? 'Course revenue setup is not installed yet.'
                        : 'Create a course to start tracking sales.'}
                    </p>
                  </div>
                ) : (
                  <div className="divide-y divide-white/[0.05]">
                    {courses.map((course) => (
                      <div key={course.course_id} className="p-5">
                        <div className="flex items-start justify-between gap-4 mb-3">
                          <div className="min-w-0">
                            <h3 className="text-sm font-semibold text-white truncate">{course.course_name}</h3>
                            <p className="text-xs mt-1" style={{ color: '#71717a' }}>
                              {course.successful_payments} sale{course.successful_payments === 1 ? '' : 's'} · {course.paid_students} student{course.paid_students === 1 ? '' : 's'}
                            </p>
                          </div>
                          <div className="text-right flex-shrink-0">
                            <div className="text-sm font-bold text-white">{formatMoney(course.total_revenue)}</div>
                            <div className="text-[11px] mt-1" style={{ color: '#71717a' }}>total</div>
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-3 text-xs">
                          <div className="rounded-xl p-3" style={{ background: 'rgba(255,255,255,0.035)' }}>
                            <div style={{ color: '#71717a' }}>This month</div>
                            <div className="font-semibold text-white mt-1">{formatMoney(course.revenue_this_month)}</div>
                          </div>
                          <div className="rounded-xl p-3" style={{ background: 'rgba(255,255,255,0.035)' }}>
                            <div style={{ color: '#71717a' }}>Avg order</div>
                            <div className="font-semibold text-white mt-1">{formatMoney(Math.round(course.average_order_value || 0))}</div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="xl:col-span-3 rounded-2xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
                <div className="px-5 py-4 flex items-center justify-between" style={{ background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                  <div>
                    <h2 className="font-semibold text-white">Recent payments</h2>
                    <p className="text-xs mt-1" style={{ color: '#71717a' }}>Latest payment records across courses</p>
                  </div>
                  <ReceiptText className="w-5 h-5" style={{ color: 'var(--kurso-primary-light)' }} />
                </div>

                {payments.length === 0 ? (
                  <div className="p-10 text-center">
                    <p className="text-sm" style={{ color: '#52525b' }}>
                      {sectionErrors.payments
                        ? 'Recent payment setup is not installed yet.'
                        : 'No payment records yet.'}
                    </p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[720px]">
                      <thead>
                        <tr className="text-left text-[11px] uppercase tracking-wider" style={{ color: '#71717a', background: 'rgba(255,255,255,0.02)' }}>
                          <th className="px-5 py-3 font-semibold">Student</th>
                          <th className="px-5 py-3 font-semibold">Course</th>
                          <th className="px-5 py-3 font-semibold">Amount</th>
                          <th className="px-5 py-3 font-semibold">Status</th>
                          <th className="px-5 py-3 font-semibold">Date</th>
                        </tr>
                      </thead>
                      <tbody>
                        {payments.map((payment) => {
                          const state = statusStyle(payment.status)
                          const Icon = state.icon
                          return (
                            <tr key={payment.payment_id} className="border-t border-white/[0.05]">
                              <td className="px-5 py-4">
                                <div className="flex items-center gap-3">
                                  <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(139,92,246,0.1)' }}>
                                    <Users className="w-4 h-4" style={{ color: 'var(--kurso-primary-light)' }} />
                                  </div>
                                  <div className="min-w-0">
                                    <p className="text-sm text-white truncate">{payment.buyer_name || payment.buyer_phone || 'Student'}</p>
                                    <p className="text-xs truncate max-w-[180px]" style={{ color: '#71717a' }}>{payment.buyer_email || payment.buyer_phone || 'No contact saved'}</p>
                                  </div>
                                </div>
                              </td>
                              <td className="px-5 py-4">
                                <p className="text-sm text-white truncate max-w-[180px]">{payment.course_name || 'Course removed'}</p>
                                <p className="text-xs mt-0.5" style={{ color: '#71717a' }}>{payment.provider_payment_id || payment.provider}</p>
                              </td>
                              <td className="px-5 py-4">
                                <p className="text-sm font-semibold text-white">{formatMoney(payment.net_amount)}</p>
                                {payment.discount_amount > 0 && (
                                  <p className="text-xs mt-0.5" style={{ color: '#22c55e' }}>{formatMoney(payment.discount_amount)} discount</p>
                                )}
                              </td>
                              <td className="px-5 py-4">
                                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium" style={{ background: state.bg, color: state.color }}>
                                  <Icon className="w-3.5 h-3.5" />
                                  {state.label}
                                </span>
                              </td>
                              <td className="px-5 py-4 text-xs" style={{ color: '#a1a1aa' }}>
                                {formatDateTime(payment.paid_at || payment.created_at)}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
                </>
    )}
      </>
    )}
  </main>
</div>
  )
}
