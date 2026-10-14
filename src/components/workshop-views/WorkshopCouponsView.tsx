'use client'
// Coupons page, Workshops side: percentage coupons for ONLINE workshop payments.
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Percent, Plus, Ticket } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { COUPON_CODE_PATTERN, MAX_PERCENT, MIN_PERCENT, normalizeCouponCode } from '@/lib/workshop-coupons'
import type { WorkshopRow } from '@/lib/workshop-overview'
import { Chip, EmptyBox, ErrorBox, Loading, Panel, WorkshopPicker, body, cardStyle, hint } from './ui'

type Coupon = { id: string; workshopId: string | null; code: string; percent: number; usageLimit: number | null; timesUsed: number; expiresAt: string | null; isActive: boolean }
type WorkshopInfo = { id: string; title: string; dateTime: string; status: string }

const PRESETS = [10, 20, 30, 50]
const field = 'w-full px-4 py-2.5 rounded-xl text-sm text-white outline-none placeholder:text-zinc-400'
const fieldStyle = { background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.14)' } as const

function statusOf(c: Coupon): { label: string; tone: 'good' | 'warn' | 'neutral' } {
  if (!c.isActive) return { label: 'Paused', tone: 'neutral' }
  if (c.expiresAt && new Date(c.expiresAt).getTime() < Date.now()) return { label: 'Expired', tone: 'warn' }
  if (c.usageLimit != null && c.timesUsed >= c.usageLimit) return { label: 'Limit reached', tone: 'warn' }
  return { label: 'Active', tone: 'good' }
}

export default function WorkshopCouponsView() {
  const [coupons, setCoupons] = useState<Coupon[]>([])
  const [workshops, setWorkshops] = useState<WorkshopInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [setupNeeded, setSetupNeeded] = useState(false)

  const [code, setCode] = useState('')
  const [percent, setPercent] = useState('20')
  const [workshopId, setWorkshopId] = useState('')
  const [limit, setLimit] = useState('')
  const [expiresOn, setExpiresOn] = useState('')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [created, setCreated] = useState('')
  const [busyId, setBusyId] = useState('')
  const [rowError, setRowError] = useState('')

  const headers = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token ? { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' } : null
  }, [])

  const load = useCallback(async () => {
    setLoading(true); setLoadError('')
    try {
      const h = await headers()
      if (!h) { setLoadError('Please log in again.'); return }
      const res = await fetch('/api/workshops/coupons', { headers: h })
      const data = await res.json().catch(() => ({}))
      if (res.status === 409) { setSetupNeeded(true); return }
      if (!res.ok) { setLoadError(data.error || 'Could not load coupons.'); return }
      setCoupons(data.coupons || []); setWorkshops(data.workshops || [])
    } catch {
      setLoadError('Could not reach the server. Check your internet and try again.')
    } finally {
      setLoading(false)
    }
  }, [headers])

  useEffect(() => { load() }, [load])

  const pickerRows: WorkshopRow[] = workshops.map(w => ({ id: w.id, title: w.title, slug: '', status: w.status, dateTime: w.dateTime, price: 0, capacity: null, durationMinutes: null }))
  const titleOf = (id: string | null) => (id ? workshops.find(w => w.id === id)?.title ?? 'Workshop' : 'All your workshops')

  async function create() {
    setFormError(''); setCreated('')
    const normalized = normalizeCouponCode(code)
    if (!COUPON_CODE_PATTERN.test(normalized)) { setFormError('Use 3 to 20 letters, numbers, - or _ for the code, for example EARLY20.'); return }
    const p = Number(percent)
    if (!Number.isInteger(p) || p < MIN_PERCENT || p > MAX_PERCENT) { setFormError(`Discount must be a whole number from ${MIN_PERCENT} to ${MAX_PERCENT}.`); return }
    setSaving(true)
    try {
      const h = await headers()
      if (!h) { setFormError('Please log in again.'); return }
      const res = await fetch('/api/workshops/coupons', {
        method: 'POST', headers: h,
        body: JSON.stringify({ code: normalized, percent: p, workshopId: workshopId || null, usageLimit: limit.trim() === '' ? null : Number(limit), expiresOn: expiresOn || null }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setFormError(data.error || 'Could not create this coupon.'); return }
      setCreated(`${normalized} is ready. Students see it when they choose “Pay online”.`)
      setCode(''); setLimit(''); setExpiresOn('')
      await load()
    } finally {
      setSaving(false)
    }
  }

  async function toggle(c: Coupon) {
    setBusyId(c.id); setRowError('')
    try {
      const h = await headers()
      if (!h) { setRowError('Please log in again.'); return }
      const res = await fetch('/api/workshops/coupons', { method: 'PATCH', headers: h, body: JSON.stringify({ id: c.id, isActive: !c.isActive }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setRowError(data.error || 'Could not update this coupon.'); return }
      setCoupons(prev => prev.map(x => (x.id === c.id ? { ...x, isActive: !c.isActive } : x)))
    } finally { setBusyId('') }
  }

  async function remove(c: Coupon) {
    setBusyId(c.id); setRowError('')
    try {
      const h = await headers()
      if (!h) { setRowError('Please log in again.'); return }
      const res = await fetch('/api/workshops/coupons', { method: 'DELETE', headers: h, body: JSON.stringify({ id: c.id }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setRowError(data.error || 'Could not delete this coupon.'); return }
      if (data.paused) setCoupons(prev => prev.map(x => (x.id === c.id ? { ...x, isActive: false } : x)))
      else setCoupons(prev => prev.filter(x => x.id !== c.id))
      if (data.paused) setRowError(`${c.code} was already used, so it was paused instead of deleted.`)
    } finally { setBusyId('') }
  }

  if (loading) return <Loading />
  if (setupNeeded) return <EmptyBox icon={Ticket} title="One quick setup step" text="Workshop coupons need a small database update. Run the workshop coupons and refunds SQL in Supabase, then refresh this page." />
  if (loadError) return <ErrorBox message={loadError} onRetry={load} />
  if (workshops.length === 0) {
    return (
      <EmptyBox icon={Ticket} title="No workshops yet" text="Create a paid workshop first. Then you can offer coupons for it.">
        <Link href="/dashboard/workshops/create" className="px-4 py-2.5 rounded-xl text-sm font-semibold text-white violet-gradient">Create a workshop</Link>
      </EmptyBox>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-white mb-1">Workshop coupons</h1>
        <p className="text-sm" style={hint}>Give a percentage off to people who pay online. Coupons do not work for UPI payments you confirm by hand.</p>
      </div>

      <Panel title="Create a coupon">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="wc-code" className="text-sm font-medium text-white block mb-1.5">Coupon code</label>
            <input id="wc-code" value={code} maxLength={20} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="EARLY20" className={field} style={fieldStyle} />
            <p className="text-[13px] mt-1" style={hint}>Students type this at checkout. Letters and numbers only.</p>
          </div>
          <div>
            <label htmlFor="wc-percent" className="text-sm font-medium text-white block mb-1.5">Discount (%)</label>
            <input id="wc-percent" type="number" min={MIN_PERCENT} max={MAX_PERCENT} value={percent} onChange={e => setPercent(e.target.value)} className={field} style={fieldStyle} />
            <div className="flex gap-2 mt-2" role="group" aria-label="Quick discounts">
              {PRESETS.map(n => (
                <button key={n} type="button" onClick={() => setPercent(String(n))}
                  className="px-3 py-1 rounded-full text-[13px] font-medium"
                  style={Number(percent) === n
                    ? { background: 'rgba(var(--kurso-primary-rgb), 0.2)', color: 'var(--kurso-primary-lightest)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.45)' }
                    : { background: 'rgba(255,255,255,0.05)', color: 'var(--kurso-text-secondary)', border: '1px solid rgba(255,255,255,0.12)' }}>
                  {n}%
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="text-sm font-medium text-white mb-1.5">Works for</p>
            <WorkshopPicker workshops={pickerRows} value={workshopId} onChange={setWorkshopId} allLabel="All my workshops" label="Workshop this coupon works for" />
          </div>
          <div>
            <label htmlFor="wc-limit" className="text-sm font-medium text-white block mb-1.5">How many times can it be used? <span className="font-normal" style={hint}>(optional)</span></label>
            <input id="wc-limit" type="number" min={1} value={limit} onChange={e => setLimit(e.target.value)} placeholder="No limit" className={field} style={fieldStyle} />
            <p className="text-[13px] mt-1" style={hint}>Counted when a payment is confirmed.</p>
          </div>
          <div className="sm:col-span-2 sm:max-w-xs">
            <label htmlFor="wc-expiry" className="text-sm font-medium text-white block mb-1.5">Last day it works <span className="font-normal" style={hint}>(optional)</span></label>
            <input id="wc-expiry" type="date" value={expiresOn} min={new Date().toISOString().slice(0, 10)} onChange={e => setExpiresOn(e.target.value)} className={field} style={{ ...fieldStyle, colorScheme: 'dark' }} />
            <p className="text-[13px] mt-1" style={hint}>It stops working at the end of this day, Indian time.</p>
          </div>
        </div>
        {formError && <p role="alert" className="text-sm mt-4" style={{ color: 'var(--kurso-danger)' }}>{formError}</p>}
        {created && <p role="status" className="text-sm mt-4" style={{ color: 'var(--kurso-success)' }}>{created}</p>}
        <button type="button" onClick={create} disabled={saving}
          className="mt-4 inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white violet-gradient hover:opacity-90 disabled:opacity-50">
          <Plus className="w-4 h-4" /> {saving ? 'Creating…' : 'Create coupon'}
        </button>
      </Panel>

      <div>
        <h2 className="text-base font-semibold text-white mb-3">Your coupons</h2>
        {rowError && <p role="alert" className="text-sm mb-3" style={{ color: 'var(--kurso-danger)' }}>{rowError}</p>}
        {coupons.length === 0 ? (
          <EmptyBox icon={Percent} title="No coupons yet" text="Create your first one above. Share the code with the people you want to give a discount." />
        ) : (
          <div className="flex flex-col gap-3">
            {coupons.map(c => {
              const st = statusOf(c)
              return (
                <div key={c.id} className="rounded-2xl p-5 glass" style={cardStyle}>
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <p className="text-base font-bold text-white tracking-wide">{c.code} <span className="text-sm font-medium" style={{ color: 'var(--kurso-primary-lightest)' }}>· {c.percent}% off</span></p>
                      <p className="text-[13px] mt-0.5 truncate" style={hint}>{titleOf(c.workshopId)}</p>
                    </div>
                    <Chip tone={st.tone}>{st.label}</Chip>
                  </div>
                  <p className="text-sm mt-3" style={body}>
                    Used {c.timesUsed}{c.usageLimit != null ? ` of ${c.usageLimit}` : ''} time{c.timesUsed === 1 ? '' : 's'}
                    {c.expiresAt ? ` · Works until ${new Date(c.expiresAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}` : ' · No expiry'}
                  </p>
                  <div className="flex gap-2 mt-3">
                    <button type="button" disabled={busyId === c.id} onClick={() => toggle(c)} className="px-3.5 py-2 rounded-xl text-[13px] font-medium disabled:opacity-50"
                      style={{ background: 'rgba(255,255,255,0.08)', color: 'var(--kurso-text-secondary)' }}>
                      {c.isActive ? 'Pause' : 'Resume'}
                    </button>
                    <button type="button" disabled={busyId === c.id} onClick={() => remove(c)} className="px-3.5 py-2 rounded-xl text-[13px] font-medium disabled:opacity-50"
                      style={{ background: 'rgba(239,68,68,0.1)', color: '#f87171' }}>
                      Delete
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}