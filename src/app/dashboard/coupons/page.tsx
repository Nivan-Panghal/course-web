'use client'

import { useEffect, useMemo, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import AudienceSwitch, { useAudienceMode } from '@/components/AudienceSwitch'
import WorkshopCouponsView from '@/components/workshop-views/WorkshopCouponsView'
import { supabase } from '@/lib/supabase'
import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  Copy,
  IndianRupee,
  Percent,
  Plus,
  Power,
  RefreshCw,
  Ticket,
} from 'lucide-react'

type Course = {
  id: string
  name: string
  price: number
}

type Coupon = {
  id: string
  creator_id: string
  course_id: string | null
  code: string
  name: string | null
  discount_type: 'percentage' | 'fixed'
  discount_value: number
  usage_limit: number | null
  times_used: number
  starts_at: string | null
  expires_at: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

type DiscountType = 'percentage' | 'fixed'

const initialForm = {
  code: '',
  name: '',
  courseId: '',
  discountType: 'percentage' as DiscountType,
  discountValue: '',
  usageLimit: '',
  expiresAt: '',
}

function formatDate(value: string | null) {
  if (!value) return 'No expiry'
  return new Date(value).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

function couponState(coupon: Coupon) {
  if (!coupon.is_active) return { label: 'Paused', color: '#a1a1aa', bg: 'rgba(255,255,255,0.06)' }
  if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
    return { label: 'Expired', color: '#ef4444', bg: 'rgba(239,68,68,0.1)' }
  }
  if (coupon.usage_limit && coupon.times_used >= coupon.usage_limit) {
    return { label: 'Used up', color: 'var(--kurso-accent)', bg: 'rgba(245,158,11,0.1)' }
  }
  return { label: 'Active', color: '#22c55e', bg: 'rgba(34,197,94,0.1)' }
}

export default function CouponsPage() {
  const [audience, setAudience] = useAudienceMode()
  const [courses, setCourses] = useState<Course[]>([])
  const [coupons, setCoupons] = useState<Coupon[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [copiedCode, setCopiedCode] = useState('')
  const [form, setForm] = useState(initialForm)

  async function fetchData(showRefresh = false) {
    if (showRefresh) setRefreshing(true)
    setError('')

    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      const [courseRes, couponRes] = await Promise.all([
        supabase
          .from('courses')
          .select('id, name, price')
          .eq('creator_id', user.id)
          .order('created_at', { ascending: false }),
        supabase
          .from('coupons')
          .select('*')
          .eq('creator_id', user.id)
          .order('created_at', { ascending: false }),
      ])

      if (courseRes.error) throw courseRes.error
      if (couponRes.error) throw couponRes.error

      setCourses(courseRes.data || [])
      setCoupons((couponRes.data || []) as Coupon[])
    } catch (err: any) {
      setError(err?.message || 'Could not load coupons.')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    fetchData()
  }, [])

  const courseNameById = useMemo(() => {
    return courses.reduce<Record<string, string>>((acc, course) => {
      acc[course.id] = course.name
      return acc
    }, {})
  }, [courses])

  const stats = useMemo(() => {
    const active = coupons.filter(c => couponState(c).label === 'Active').length
    const redemptions = coupons.reduce((sum, c) => sum + (c.times_used || 0), 0)
    const limited = coupons.filter(c => Boolean(c.usage_limit)).length
    return { active, redemptions, limited }
  }, [coupons])

  function updateForm(key: keyof typeof form, value: string) {
    setForm(current => ({ ...current, [key]: value }))
    setError('')
    setSuccess('')
  }

 
  async function createCoupon(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault()
    setError('')
    setSuccess('')

    const code = form.code.trim().toUpperCase()
    const discountValue = Number(form.discountValue)
    const usageLimit = form.usageLimit ? Number(form.usageLimit) : null

    if (!code) {
      setError('Coupon code is required.')
      return
    }

    if (!/^[A-Z0-9_-]{3,24}$/.test(code)) {
      setError('Use 3-24 letters, numbers, hyphens, or underscores.')
      return
    }

    if (!Number.isFinite(discountValue) || discountValue <= 0) {
      setError('Enter a valid discount value.')
      return
    }

    if (form.discountType === 'percentage' && discountValue > 100) {
      setError('Discount cannot be more than 100%.');
      return;
    }

    if (form.discountType === 'fixed' && form.courseId) {
      const selectedCourse = courses.find(course => course.id === form.courseId)
      if (selectedCourse && discountValue > selectedCourse.price) {
        setError('Fixed discount cannot exceed the selected course price.')
        return
      }
    }

    if (usageLimit !== null && (!Number.isInteger(usageLimit) || usageLimit <= 0)) {
      setError('Usage limit must be a whole number greater than zero.')
      return
    }

    setSaving(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error('Please sign in again.')

      const expiresAt = form.expiresAt ? `${form.expiresAt}T23:59:59+05:30` : null

      const { error: insertError } = await supabase
        .from('coupons')
        .insert({
          creator_id: user.id,
          course_id: form.courseId || null,
          code,
          name: form.name.trim() || null,
          discount_type: form.discountType,
          discount_value: Math.round(discountValue),
          usage_limit: usageLimit,
          expires_at: expiresAt,
          is_active: true,
        })

      if (insertError) {
        if (insertError.message.toLowerCase().includes('duplicate')) {
          throw new Error('A coupon with this code already exists.')
        }
        throw insertError
      }

      setForm(initialForm)
      setSuccess(`${code} created successfully.`)
      await fetchData()
    } catch (err: any) {
      setError(err?.message || 'Could not create coupon.')
    } finally {
      setSaving(false)
    }
  }

  async function toggleCoupon(coupon: Coupon) {
    setError('')
    setSuccess('')
    const { error: updateError } = await supabase
      .from('coupons')
      .update({ is_active: !coupon.is_active })
      .eq('id', coupon.id)

    if (updateError) {
      setError(updateError.message)
      return
    }

    setCoupons(current =>
      current.map(item => item.id === coupon.id ? { ...item, is_active: !item.is_active } : item)
    )
  }

  async function copyCode(code: string) {
    try {
      await navigator.clipboard.writeText(code)
      setCopiedCode(code)
      setTimeout(() => setCopiedCode(''), 1400)
    } catch {
      setError('Could not copy coupon code.')
    }
  }

  return (
    <div className="min-h-screen bg-black">
      <Sidebar />
  <main className="md:ml-56 p-6 md:p-8 pt-20 md:pt-8">
    <AudienceSwitch value={audience} onChange={setAudience} />
    {audience === 'workshops' ? (
      <WorkshopCouponsView />
    ) : (
      <>
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
      <div>
        <h1 className="text-2xl font-bold text-white mb-1">Coupons</h1>
            <p className="text-sm" style={{ color: '#a1a1aa' }}>
              Create launch discounts, limit redemptions, and pause offers anytime.
            </p>
          </div>

          <button
            onClick={() => fetchData(true)}
            disabled={refreshing}
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all disabled:opacity-60"
            style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff' }}
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
          {[
            { label: 'Active coupons', value: stats.active, icon: Ticket, color: 'var(--kurso-primary-light)' },
            { label: 'Total redemptions', value: stats.redemptions, icon: CheckCircle2, color: '#22c55e' },
            { label: 'Limited offers', value: stats.limited, icon: Power, color: 'var(--kurso-accent)' },
          ].map(item => {
            const Icon = item.icon
            return (
              <div key={item.label} className="rounded-2xl p-5 glass" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: `${item.color}18` }}>
                    <Icon className="w-5 h-5" style={{ color: item.color }} />
                  </div>
                  <p className="text-sm" style={{ color: '#a1a1aa' }}>{item.label}</p>
                </div>
                <p className="text-3xl font-bold text-white">{item.value}</p>
              </div>
            )
          })}
        </div>

        <form onSubmit={createCoupon} className="rounded-2xl p-5 mb-8 glass" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
            <div className="flex items-center gap-2">
              <Plus className="w-5 h-5" style={{ color: 'var(--kurso-primary-light)' }} />
              <h2 className="font-semibold text-white">Create coupon</h2>
            </div>

          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
            <div className="lg:col-span-2">
              <label className="block text-xs mb-2" style={{ color: '#71717a' }}>Code</label>
              <input
                value={form.code}
                onChange={e => updateForm('code', e.target.value.toUpperCase())}
                placeholder="LAUNCH50"
                className="w-full px-3 py-3 rounded-xl text-sm text-white outline-none uppercase"
                style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
              />
            </div>

            <div className="lg:col-span-2">
              <label className="block text-xs mb-2" style={{ color: '#71717a' }}>Name</label>
              <input
                value={form.name}
                onChange={e => updateForm('name', e.target.value)}
                placeholder="Launch offer"
                className="w-full px-3 py-3 rounded-xl text-sm text-white outline-none"
                style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
              />
            </div>

            <div className="lg:col-span-3">
              <label className="block text-xs mb-2" style={{ color: '#71717a' }}>Course</label>
              <select
                value={form.courseId}
                onChange={e => updateForm('courseId', e.target.value)}
                className="w-full px-3 py-3 rounded-xl text-sm text-white outline-none"
                style={{ background: '#111', border: '1px solid rgba(255,255,255,0.1)' }}
              >
                <option value="">All courses</option>
                {courses.map(course => (
                  <option key={course.id} value={course.id}>{course.name}</option>
                ))}
              </select>
            </div>

            <div className="lg:col-span-2">
              <label className="block text-xs mb-2" style={{ color: '#71717a' }}>Discount</label>
              <div className="flex">
                <button
                  type="button"
                  onClick={() => {
                    updateForm('discountType', 'percentage')
                    updateForm('discountValue', '')
                  }}
                  className="w-12 rounded-l-xl flex items-center justify-center"
                  style={{
                    background: form.discountType === 'percentage' ? 'rgba(var(--kurso-primary-rgb), 0.25)' : 'rgba(255,255,255,0.05)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    color: form.discountType === 'percentage' ? 'var(--kurso-primary-lightest)' : '#71717a',
                  }}
                >
                  <Percent className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    updateForm('discountType', 'fixed')
                    updateForm('discountValue', '')
                  }}
                  className="w-12 flex items-center justify-center"
                  style={{
                    background: form.discountType === 'fixed' ? 'rgba(var(--kurso-primary-rgb), 0.25)' : 'rgba(255,255,255,0.05)',
                    borderTop: '1px solid rgba(255,255,255,0.1)',
                    borderBottom: '1px solid rgba(255,255,255,0.1)',
                    color: form.discountType === 'fixed' ? 'var(--kurso-primary-lightest)' : '#71717a',
                  }}
                >
                  <IndianRupee className="w-4 h-4" />
                </button>
                <input
                  value={form.discountValue}
                  onChange={e => updateForm('discountValue', e.target.value.replace(/\D/g, ''))}
                  placeholder={form.discountType === 'percentage' ? '50' : '500'}
                  className="min-w-0 flex-1 px-3 py-3 rounded-r-xl text-sm text-white outline-none"
                  style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
                />
              </div>
            </div>

            <div className="lg:col-span-1">
              <label className="block text-xs mb-2" style={{ color: '#71717a' }}>Limit</label>
              <input
                value={form.usageLimit}
                onChange={e => updateForm('usageLimit', e.target.value.replace(/\D/g, ''))}
                placeholder="100"
                className="w-full px-3 py-3 rounded-xl text-sm text-white outline-none"
                style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
              />
            </div>

            <div className="lg:col-span-2">
              <label className="block text-xs mb-2" style={{ color: '#71717a' }}>Expires</label>
              <input
                type="date"
                value={form.expiresAt}
                onChange={e => updateForm('expiresAt', e.target.value)}
                className="w-full px-3 py-3 rounded-xl text-sm text-white outline-none"
                style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
              />
            </div>
          </div>

          {(error || success) && (
            <div className="mt-4 rounded-xl p-3 flex items-start gap-2"
              style={{
                background: error ? 'rgba(239,68,68,0.1)' : 'rgba(34,197,94,0.1)',
                border: error ? '1px solid rgba(239,68,68,0.2)' : '1px solid rgba(34,197,94,0.2)',
              }}>
              {error ? <AlertCircle className="w-4 h-4 mt-0.5" style={{ color: '#ef4444' }} /> : <CheckCircle2 className="w-4 h-4 mt-0.5" style={{ color: '#22c55e' }} />}
              <p className="text-sm" style={{ color: error ? '#fca5a5' : '#86efac' }}>{error || success}</p>
            </div>
          )}

          <div className="flex justify-end mt-5">
            <button
              type="submit"
              disabled={saving || courses.length === 0}
              className="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl text-sm font-semibold text-white violet-gradient disabled:opacity-50"
            >
              <Plus className="w-4 h-4" />
              {saving ? 'Creating...' : 'Create coupon'}
            </button>
          </div>
        </form>

        {loading ? (
          <div className="flex items-center justify-center py-24">
            <div className="w-8 h-8 violet-gradient rounded-lg animate-pulse-glow" />
          </div>
        ) : courses.length === 0 ? (
          <div className="rounded-2xl p-12 text-center glass" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
            <BookOpen className="w-10 h-10 mx-auto mb-4" style={{ color: 'var(--kurso-primary-light)' }} />
            <h3 className="text-lg font-semibold text-white mb-2">Create a course first</h3>
            <p className="text-sm" style={{ color: '#a1a1aa' }}>Coupons need at least one course to be useful at checkout.</p>
          </div>
        ) : coupons.length === 0 ? (
          <div className="rounded-2xl p-12 text-center glass" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
            <Ticket className="w-10 h-10 mx-auto mb-4" style={{ color: 'var(--kurso-primary-light)' }} />
            <h3 className="text-lg font-semibold text-white mb-2">No coupons yet</h3>
            <p className="text-sm" style={{ color: '#a1a1aa' }}>Create a launch code like LAUNCH50 and share it with students.</p>
          </div>
        ) : (
          <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
            <div className="overflow-x-auto">
            <div className="grid grid-cols-12 gap-4 px-5 py-3 text-xs font-semibold uppercase tracking-wider min-w-[720px]"
              style={{ background: 'rgba(255,255,255,0.03)', color: '#71717a', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
              <div className="col-span-3">Coupon</div>
              <div className="col-span-3">Course</div>
              <div className="col-span-2">Discount</div>
              <div className="col-span-2">Usage</div>
              <div className="col-span-1">Status</div>
              <div className="col-span-1 text-right">Action</div>
            </div>

            {coupons.map(coupon => {
              const state = couponState(coupon)
              const usagePercent = coupon.usage_limit ? Math.min((coupon.times_used / coupon.usage_limit) * 100, 100) : 0
              return (
                <div key={coupon.id}
                  className="grid grid-cols-12 gap-4 px-5 py-4 items-center min-w-[720px]"
                  style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <div className="col-span-3 min-w-0">
                    <button
                      onClick={() => copyCode(coupon.code)}
                      className="inline-flex items-center gap-2 max-w-full rounded-lg px-2 py-1 transition-all"
                      style={{ background: 'rgba(var(--kurso-primary-rgb), 0.12)', color: 'var(--kurso-primary-lightest)' }}
                    >
                      <span className="font-mono text-sm font-semibold truncate">{coupon.code}</span>
                      <Copy className="w-3.5 h-3.5 flex-shrink-0" />
                    </button>
                    <p className="text-xs mt-1 truncate" style={{ color: '#71717a' }}>
                      {copiedCode === coupon.code ? 'Copied' : coupon.name || 'No internal name'}
                    </p>
                  </div>

                  <div className="col-span-3 min-w-0">
                    <p className="text-sm text-white truncate">{coupon.course_id ? courseNameById[coupon.course_id] || 'Course removed' : 'All courses'}</p>
                    <p className="text-xs mt-1" style={{ color: '#71717a' }}>Expires: {formatDate(coupon.expires_at)}</p>
                  </div>

                  <div className="col-span-2">
                    <p className="text-sm font-semibold text-white">
                      {coupon.discount_type === 'percentage'
                        ? `${coupon.discount_value}% off`
                        : `₹${coupon.discount_value.toLocaleString()} off`}
                    </p>
                  </div>

                  <div className="col-span-2">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs" style={{ color: '#a1a1aa' }}>
                        {coupon.times_used}{coupon.usage_limit ? ` / ${coupon.usage_limit}` : ' used'}
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: coupon.usage_limit ? `${usagePercent}%` : coupon.times_used > 0 ? '100%' : '0%',
                          background: coupon.usage_limit ? 'var(--kurso-primary-light)' : '#22c55e',
                        }}
                      />
                    </div>
                  </div>

                  <div className="col-span-1">
                    <span className="inline-flex px-2.5 py-1 rounded-full text-xs font-medium" style={{ background: state.bg, color: state.color }}>
                      {state.label}
                    </span>
                  </div>

                  <div className="col-span-1 flex justify-end">
                    <button
                      onClick={() => toggleCoupon(coupon)}
                      className="w-9 h-9 rounded-xl flex items-center justify-center transition-all"
                      style={{ background: 'rgba(255,255,255,0.05)', color: coupon.is_active ? '#ef4444' : '#22c55e' }}
                      title={coupon.is_active ? 'Pause coupon' : 'Activate coupon'}
                    >
                      <Power className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )
            })}
            </div>
          </div>
 )}
      </>
    )}
  </main>
</div>

) }
