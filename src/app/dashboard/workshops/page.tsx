// src/app/dashboard/workshops/page.tsx
'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import Sidebar from '@/components/Sidebar'
import { supabase } from '@/lib/supabase'
import { Award, Plus, Calendar, Users, Check, ExternalLink, Pencil, ChevronDown, AlertTriangle } from 'lucide-react'
import {
  formatWorkshopDateTime,
  getWorkshopRegistrationState,
  workshopEndsAt,
  workshopStatusLabel,
} from '@/lib/workshops'

interface Workshop {
  id: string
  title: string
  slug: string
  date_time: string
  price: number
  capacity: number | null
  status: string
  duration_minutes: number | null
  registration_closes_at: string | null
}

interface Registration {
  id: string
  name: string
  email: string | null
  phone: string
  payment_mode: string
  payment_status: string
  utr_reference: string | null
  amount_paid: number | null
}

export default function WorkshopsPage() {
  const [workshops, setWorkshops] = useState<Workshop[]>([])
  const [loading, setLoading] = useState(true)
  const [creatorSlug, setCreatorSlug] = useState('')
  const [token, setToken] = useState('')

  // UPI settings
  const [upiId, setUpiId] = useState('')
  const [upiDisplayName, setUpiDisplayName] = useState('')
  const [upiSaving, setUpiSaving] = useState(false)
  const [upiSaved, setUpiSaved] = useState(false)

  // Payment reminders (WhatsApp nudges to unpaid registrants)
  const [nudgeEnabled, setNudgeEnabled] = useState(false)
  const [nudgeSavedEnabled, setNudgeSavedEnabled] = useState(false)
  const [nudgeNote, setNudgeNote] = useState('')
  const [nudgeSaving, setNudgeSaving] = useState(false)
  const [nudgeSaved, setNudgeSaved] = useState(false)

  // Meta Pixel + Conversions API
  interface MetaStats { sentLead: number; sentPurchase: number; failed: number; skipped: number; pending: number; lastError: string | null }
  const [metaPixelId, setMetaPixelId] = useState('')
  const [metaToken, setMetaToken] = useState('')
  const [metaTestCode, setMetaTestCode] = useState('')
  const [metaHasToken, setMetaHasToken] = useState(false)
  const [metaSaved, setMetaSaved] = useState(false)
  const [metaStats, setMetaStats] = useState<MetaStats | null>(null)
  const [metaBusy, setMetaBusy] = useState<'save' | 'remove' | 'retry' | null>(null)
  const [metaMessage, setMetaMessage] = useState<{ kind: 'ok' | 'warn' | 'error'; text: string } | null>(null)

  // Creating a workshop happens on /dashboard/workshops/create, editing on /dashboard/workshops/[id].
  // The three settings panels (UPI, Meta Pixel, reminders) open one at a time.
  const [openPanel, setOpenPanel] = useState<'upi' | 'meta' | 'nudge' | null>(null)

  // Expanded registrations per workshop
  const [expanded, setExpanded] = useState<string | null>(null)
  const [registrations, setRegistrations] = useState<Record<string, Registration[]>>({})
  const [confirming, setConfirming] = useState<string | null>(null)

  // Referral stats: confirmed-via-student-link count per workshop, and who referred each registration
  const [referralCounts, setReferralCounts] = useState<Record<string, number>>({})
  const [referredBy, setReferredBy] = useState<Record<string, string>>({})

  useEffect(() => {
    load()
  }, [])

  async function load() {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { setLoading(false); return }

    const { data: { session } } = await supabase.auth.getSession()
    if (session?.access_token) {
      setToken(session.access_token)
      loadReferralStats(session.access_token)
      loadMetaSettings(session.access_token)
    }

    const { data: creator } = await supabase
      .from('creators')
      .select('creator_slug, upi_id, upi_display_name, nudge_enabled, nudge_note')
      .eq('id', user.id)
      .maybeSingle()
    if (creator) {
      setCreatorSlug(creator.creator_slug || '')
      setUpiId(creator.upi_id || '')
      setUpiDisplayName(creator.upi_display_name || '')
      setNudgeEnabled(!!creator.nudge_enabled)
      setNudgeSavedEnabled(!!creator.nudge_enabled)
      setNudgeNote(creator.nudge_note || '')
    }

    const { data } = await supabase
      .from('workshops')
      .select('id, title, slug, date_time, price, capacity, status, duration_minutes, registration_closes_at')
      .eq('creator_id', user.id)
      .order('date_time', { ascending: false })

    setWorkshops(data || [])
    setLoading(false)
  }

  async function loadReferralStats(accessToken: string) {
    try {
      const res = await fetch('/api/workshops/referrals', { headers: { Authorization: `Bearer ${accessToken}` } })
      if (!res.ok) return
      const data = await res.json()
      setReferralCounts(data.counts || {})
      setReferredBy(data.referredBy || {})
    } catch {
      // Stats are a bonus — the page works without them.
    }
  }

  async function handleSaveUpi() {
    setUpiSaving(true)
    setUpiSaved(false)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { setUpiSaving(false); return }
    const { error } = await supabase
      .from('creators')
      .update({ upi_id: upiId.trim() || null, upi_display_name: upiDisplayName.trim() || null })
      .eq('id', user.id)
    setUpiSaving(false)
    if (!error) { setUpiSaved(true); setTimeout(() => setUpiSaved(false), 2000) }
  }

  async function loadMetaSettings(accessToken: string) {
    try {
      const res = await fetch('/api/workshops/meta-settings', { headers: { Authorization: `Bearer ${accessToken}` } })
      if (!res.ok) return
      const data = await res.json()
      setMetaPixelId(data.pixelId || '')
      setMetaHasToken(!!data.hasToken)
      setMetaTestCode(data.testEventCode || '')
      setMetaSaved(!!data.pixelId)
      setMetaStats(data.stats || null)
    } catch {
      // Optional feature — the page works without it.
    }
  }

  async function handleSaveMeta() {
    if (!token) return
    setMetaBusy('save')
    setMetaMessage(null)
    try {
      const res = await fetch('/api/workshops/meta-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ pixelId: metaPixelId, accessToken: metaToken, testEventCode: metaTestCode }),
      })
      const data = await res.json()
      if (!res.ok) { setMetaMessage({ kind: 'error', text: data.error || 'Could not save' }); return }
      setMetaToken('')
      setMetaHasToken(!!data.hasToken)
      setMetaSaved(true)
      if (data.verification?.ok) {
        setMetaMessage({ kind: 'ok', text: `Saved. Meta confirmed access to your pixel${data.verification.name ? ` "${data.verification.name}"` : ''}.` })
      } else if (data.verification) {
        setMetaMessage({ kind: 'warn', text: `Saved, but Meta couldn't confirm this token: ${data.verification.error}. Events may fail — check the status below after a registration.` })
      } else {
        setMetaMessage({ kind: 'warn', text: 'Saved. Add the access token as well to also send server-side events.' })
      }
      loadMetaSettings(token)
    } finally {
      setMetaBusy(null)
    }
  }

  async function handleRemoveMeta() {
    if (!token || !window.confirm('Remove your Meta Pixel setup? Tracking on your workshop pages will stop.')) return
    setMetaBusy('remove')
    setMetaMessage(null)
    try {
      const res = await fetch('/api/workshops/meta-settings', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
      if (res.ok) {
        setMetaPixelId(''); setMetaToken(''); setMetaTestCode(''); setMetaHasToken(false); setMetaSaved(false); setMetaStats(null)
      }
    } finally {
      setMetaBusy(null)
    }
  }

  async function handleRetryMeta() {
    if (!token) return
    setMetaBusy('retry')
    setMetaMessage(null)
    try {
      const res = await fetch('/api/workshops/meta-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'retry' }),
      })
      const data = await res.json()
      if (!res.ok) { setMetaMessage({ kind: 'error', text: data.error || 'Retry failed' }); return }
      setMetaStats(data.stats || null)
      setMetaMessage({
        kind: data.failed > 0 ? 'warn' : 'ok',
        text: data.attempted === 0 ? 'Nothing to retry.' : `Retried ${data.attempted}: ${data.sent} sent, ${data.failed} still failing.`,
      })
    } finally {
      setMetaBusy(null)
    }
  }

  async function handleSaveNudge() {
    setNudgeSaving(true)
    setNudgeSaved(false)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { setNudgeSaving(false); return }
    // Turning reminders ON stamps the moment — only registrations made after it are ever nudged.
    const turningOn = nudgeEnabled && !nudgeSavedEnabled
    const { error } = await supabase
      .from('creators')
      .update({
        nudge_enabled: nudgeEnabled,
        nudge_note: nudgeNote.replace(/\s+/g, ' ').trim() || null,
        ...(turningOn ? { nudge_enabled_at: new Date().toISOString() } : {}),
      })
      .eq('id', user.id)
    setNudgeSaving(false)
    if (!error) {
      setNudgeSavedEnabled(nudgeEnabled)
      setNudgeSaved(true)
      setTimeout(() => setNudgeSaved(false), 2000)
    }
  }

  async function toggleExpand(workshopId: string) {
    if (expanded === workshopId) { setExpanded(null); return }
    setExpanded(workshopId)
    if (!registrations[workshopId]) {
      const { data } = await supabase
        .from('workshop_registrations')
        .select('id, name, email, phone, payment_mode, payment_status, utr_reference, amount_paid')
        .eq('workshop_id', workshopId)
        .order('created_at', { ascending: false })
      setRegistrations(prev => ({ ...prev, [workshopId]: data || [] }))
    }
  }

  async function handleMarkPaid(workshopId: string, registrationId: string) {
    if (!token) return
    setConfirming(registrationId)
    try {
      const res = await fetch('/api/workshops/registrations/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ registrationId }),
      })
      if (res.ok) {
        setRegistrations(prev => ({
          ...prev,
          [workshopId]: prev[workshopId].map(r => r.id === registrationId ? { ...r, payment_status: 'confirmed' } : r),
        }))
        loadReferralStats(token)
      }
    } finally {
      setConfirming(null)
    }
  }

  // ─── What to show ────────────────────────────────────────────────────────
  const nowMs = Date.now()
  const isPast = (w: Workshop) =>
    w.status === 'completed' || w.status === 'cancelled' || workshopEndsAt(w.date_time, w.duration_minutes).getTime() <= nowMs
  const upcoming = workshops
    .filter(w => !isPast(w))
    .sort((a, b) => new Date(a.date_time).getTime() - new Date(b.date_time).getTime())
  const past = workshops.filter(isPast) // already newest first from the query
  const needsUpiHint = !upiId.trim() && upcoming.some(w => w.price > 0)

  function openSettings(panel: 'upi' | 'meta' | 'nudge') {
    setOpenPanel(panel)
    requestAnimationFrame(() => document.getElementById('workshop-settings')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  const metaSummary = metaSaved
    ? `Connected${metaPixelId ? ` · pixel ${metaPixelId}` : ''}${metaStats && metaStats.failed > 0 ? ` · ${metaStats.failed} failed events` : ''}`
    : 'Not connected'

  function renderWorkshop(w: Workshop) {
    const registerUrl = `/w/${creatorSlug}/${w.slug}`
    const chip = statusChip(w)
    return (
      <div key={w.id} className="rounded-2xl p-5 glass" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-semibold text-white">{w.title}</h3>
              <span className="text-[12px] font-medium px-2 py-0.5 rounded-full whitespace-nowrap" style={chip.style}>{chip.label}</span>
            </div>
            <p className="text-[13px] mt-1" style={{ color: 'var(--kurso-text-muted)' }}>
              {formatWorkshopDateTime(w.date_time)} IST
              {' · '}{w.price > 0 ? `₹${w.price}` : 'Free'}
              {w.capacity != null ? ` · ${w.capacity} seats` : ''}
              {referralCounts[w.id] ? ` · ${referralCounts[w.id]} referred by students` : ''}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Link href={`/dashboard/workshops/${w.id}`}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-[13px] font-medium"
              style={{ background: 'rgba(255,255,255,0.08)', color: 'var(--kurso-text-secondary)' }}>
              <Pencil className="w-3.5 h-3.5" /> Edit
            </Link>
            <Link href={`/dashboard/workshops/${w.id}/certificates`}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-[13px] font-medium"
              style={{ background: 'rgba(255,255,255,0.08)', color: 'var(--kurso-text-secondary)' }}>
              <Award className="w-3.5 h-3.5" /> Certificates
            </Link>
            {w.status === 'published' && creatorSlug && (
              <a href={registerUrl} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-[13px] font-medium"
                style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--kurso-text-secondary)' }}>
                <ExternalLink className="w-3.5 h-3.5" /> View page
              </a>
            )}
            <button onClick={() => toggleExpand(w.id)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-[13px] font-medium"
              style={{ background: 'rgba(var(--kurso-primary-rgb), 0.15)', color: 'var(--kurso-primary-lightest)' }}>
              <Users className="w-3.5 h-3.5" /> {expanded === w.id ? 'Hide' : 'Registrations'}
            </button>
          </div>
        </div>

        {expanded === w.id && (
          <div className="mt-4 pt-4" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
            {(registrations[w.id] || []).length === 0 ? (
              <p className="text-[13px]" style={{ color: 'var(--kurso-text-muted)' }}>No registrations yet.</p>
            ) : (
              <div className="space-y-2">
                {(registrations[w.id] || []).map(r => (
                  <div key={r.id} className="flex items-center justify-between gap-3 p-3 rounded-xl flex-wrap"
                    style={{ background: 'rgba(255,255,255,0.04)' }}>
                    <div className="min-w-0">
                      <p className="text-sm text-white truncate">{r.name} · {r.phone}</p>
                      <p className="text-[13px]" style={{ color: 'var(--kurso-text-muted)' }}>
                        {r.payment_mode}{r.utr_reference ? ` · UTR ${r.utr_reference}` : ''}{r.amount_paid ? ` · ₹${r.amount_paid} paid online` : ''}{referredBy[r.id] ? ` · referred by ${referredBy[r.id]}` : ''}
                      </p>
                    </div>
                    {r.payment_status === 'confirmed' ? (
                      <span className="text-[13px] flex items-center gap-1" style={{ color: 'var(--kurso-success)' }}>
                        <Check className="w-3.5 h-3.5" /> Confirmed
                      </span>
                    ) : r.payment_status === 'pending_confirmation' ? (
                      <button onClick={() => handleMarkPaid(w.id, r.id)} disabled={confirming === r.id}
                        className="px-3 py-1.5 rounded-lg text-[13px] font-medium disabled:opacity-50"
                        style={{ background: 'rgba(var(--kurso-primary-rgb), 0.18)', color: 'var(--kurso-primary-lightest)' }}>
                        {confirming === r.id ? 'Confirming…' : 'Mark Paid'}
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-black">
      <Sidebar />
      <main className="md:ml-56 p-6 md:p-8 pt-20 md:pt-8 max-w-5xl">
        <div className="flex items-center justify-between gap-4 flex-wrap mb-6">
          <div>
            <h1 className="text-2xl font-bold text-white mb-1">Workshops</h1>
            <p className="text-sm" style={{ color: 'var(--kurso-text-muted)' }}>
              {workshops.length} workshop{workshops.length !== 1 ? 's' : ''} created
            </p>
          </div>
          <Link href="/dashboard/workshops/create"
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium text-white violet-gradient hover:opacity-90 glow">
            <Plus className="w-4 h-4" />
            New Workshop
          </Link>
        </div>

        {needsUpiHint && (
          <div className="flex items-start gap-3 rounded-xl p-4 mb-6"
            style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.35)' }}>
            <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" style={{ color: '#f59e0b' }} />
            <div className="min-w-0">
              <p className="text-sm" style={{ color: 'var(--kurso-text-secondary)' }}>
                You have a paid workshop but no UPI ID saved. If you also haven't connected a payment gateway, people won't be able to pay.
              </p>
              <button type="button" onClick={() => openSettings('upi')} className="text-sm font-medium underline mt-1"
                style={{ color: 'var(--kurso-primary-lightest)' }}>
                Add your UPI ID
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-24">
            <div className="w-8 h-8 violet-gradient rounded-lg animate-pulse-glow" />
          </div>
        ) : workshops.length === 0 ? (
          <div className="rounded-2xl p-16 text-center glass" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
            <Calendar className="w-10 h-10 mx-auto mb-4" style={{ color: 'var(--kurso-primary-light)' }} />
            <h3 className="text-lg font-semibold text-white mb-2">No workshops yet</h3>
            <p className="text-sm mb-5" style={{ color: 'var(--kurso-text-muted)' }}>Create your first live workshop. It takes about two minutes.</p>
            <Link href="/dashboard/workshops/create"
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium text-white violet-gradient hover:opacity-90">
              <Plus className="w-4 h-4" /> Create a workshop
            </Link>
          </div>
        ) : (
          <div className="space-y-8">
            {upcoming.length > 0 && (
              <section>
                <h2 className="text-base font-semibold text-white mb-3">Upcoming &amp; live</h2>
                <div className="space-y-3">{upcoming.map(renderWorkshop)}</div>
              </section>
            )}
            {past.length > 0 && (
              <section>
                <h2 className="text-base font-semibold text-white mb-3">Past</h2>
                <div className="space-y-3">{past.map(renderWorkshop)}</div>
              </section>
            )}
          </div>
        )}

        {/* Settings that apply to ALL your workshops */}
        <section id="workshop-settings" className="mt-12" style={{ scrollMarginTop: '1.5rem' }}>
          <h2 className="text-base font-semibold text-white mb-1">Payments, ads and reminders</h2>
          <p className="text-sm mb-4" style={{ color: 'var(--kurso-text-muted)' }}>These apply to all of your workshops.</p>

          <div className="space-y-3">
            <SettingsPanel id="upi" title="UPI payout details"
              summary={upiId.trim() ? `${upiId.trim()}${upiDisplayName.trim() ? ` · ${upiDisplayName.trim()}` : ''}` : 'Not set. Needed for people to pay you by UPI.'}
              open={openPanel === 'upi'} onToggle={() => setOpenPanel(openPanel === 'upi' ? null : 'upi')}>
              <p className="text-[13px] mb-3" style={{ color: 'var(--kurso-text-muted)' }}>
                Used to show students where to pay for paid workshops. This isn't a payment gateway — students pay you
                directly and you confirm manually once you see it land.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
                <input
                  value={upiId} onChange={e => setUpiId(e.target.value)} aria-label="UPI ID"
                  placeholder="yourname@upi"
                  className={FIELD_CLASS} style={FIELD_STYLE}
                />
                <input
                  value={upiDisplayName} onChange={e => setUpiDisplayName(e.target.value)} aria-label="UPI display name"
                  placeholder="Display name (shown to students)"
                  className={FIELD_CLASS} style={FIELD_STYLE}
                />
              </div>
              <button onClick={handleSaveUpi} disabled={upiSaving} className={SAVE_CLASS} style={SAVE_STYLE}>
                {upiSaving ? 'Saving…' : upiSaved ? 'Saved ✓' : 'Save'}
              </button>
            </SettingsPanel>

            <SettingsPanel id="meta" title="Meta Pixel & Conversions API" summary={metaSummary}
              open={openPanel === 'meta'} onToggle={() => setOpenPanel(openPanel === 'meta' ? null : 'meta')}>
              <p className="text-[13px] mb-3" style={{ color: 'var(--kurso-text-muted)' }}>
                Tracks registrations (Lead) and confirmed payments (Purchase) for your Facebook/Instagram ads. Only your workshop
                pages are tracked. The pixel alone gives you Leads from the browser; add the access token to also send server-side
                events, including Purchase.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
                <input value={metaPixelId} onChange={e => setMetaPixelId(e.target.value)} inputMode="numeric" aria-label="Pixel ID"
                  placeholder="Pixel ID (digits only)"
                  className={FIELD_CLASS} style={FIELD_STYLE} />
                <input value={metaTestCode} onChange={e => setMetaTestCode(e.target.value)} aria-label="Test event code"
                  placeholder="Test event code (optional)"
                  className={FIELD_CLASS} style={FIELD_STYLE} />
              </div>
              <input value={metaToken} onChange={e => setMetaToken(e.target.value)} type="password" autoComplete="off" aria-label="Conversions API access token"
                placeholder={metaHasToken ? 'Access token saved — paste a new one only to replace it' : 'Conversions API access token'}
                className={`w-full ${FIELD_CLASS} mb-2`} style={FIELD_STYLE} />
              {metaTestCode.trim() && (
                <p className="text-[13px] mb-2" style={{ color: '#f59e0b' }}>
                  While a test event code is set, Meta treats events as tests and they won't help your ads. Clear it once testing is done.
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <button onClick={handleSaveMeta} disabled={metaBusy !== null || !metaPixelId.trim()} className={SAVE_CLASS} style={SAVE_STYLE}>
                  {metaBusy === 'save' ? 'Saving…' : 'Save'}
                </button>
                {metaSaved && (
                  <button onClick={handleRemoveMeta} disabled={metaBusy !== null}
                    className="px-4 py-2 rounded-xl text-sm disabled:opacity-50"
                    style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--kurso-text-secondary)', border: '1px solid rgba(255,255,255,0.1)' }}>
                    {metaBusy === 'remove' ? 'Removing…' : 'Remove'}
                  </button>
                )}
              </div>
              {metaMessage && (
                <p className="text-[13px] mt-3" role="status"
                  style={{ color: metaMessage.kind === 'ok' ? 'var(--kurso-success)' : metaMessage.kind === 'warn' ? '#f59e0b' : 'var(--kurso-danger)' }}>
                  {metaMessage.text}
                </p>
              )}
              {metaStats && (
                <div className="mt-4 pt-3" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                  <p className="text-[13px]" style={{ color: 'var(--kurso-text-muted)' }}>
                    Last 30 days: {metaStats.sentLead} Lead and {metaStats.sentPurchase} Purchase events sent to Meta
                    {metaStats.failed > 0 ? ` · ${metaStats.failed} failed` : ''}
                    {metaStats.skipped > 0 ? ` · ${metaStats.skipped} skipped` : ''}
                    {metaStats.pending > 0 ? ` · ${metaStats.pending} in progress` : ''}
                  </p>
                  {metaStats.failed > 0 && (
                    <div className="mt-2">
                      {metaStats.lastError && <p className="text-[13px] mb-2" style={{ color: 'var(--kurso-danger)' }}>Latest error: {metaStats.lastError}</p>}
                      <button onClick={handleRetryMeta} disabled={metaBusy !== null}
                        className="px-3 py-1.5 rounded-lg text-[13px] font-medium disabled:opacity-50"
                        style={{ background: 'rgba(var(--kurso-primary-rgb), 0.18)', color: 'var(--kurso-primary-lightest)' }}>
                        {metaBusy === 'retry' ? 'Retrying…' : 'Retry failed events'}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </SettingsPanel>

            <SettingsPanel id="nudge" title="Payment reminders" summary={nudgeSavedEnabled ? 'On' : 'Off'}
              open={openPanel === 'nudge'} onToggle={() => setOpenPanel(openPanel === 'nudge' ? null : 'nudge')}>
              <div className="flex items-start justify-between gap-3 mb-3">
                <p className="text-[13px]" style={{ color: 'var(--kurso-text-muted)' }}>
                  Sends up to 2 WhatsApp reminders (about 2 hours and 24 hours after they register) to people who signed up
                  for a paid workshop but haven't paid. Only sent between 9am and 9pm IST, and never to someone who has
                  already submitted a UTR. Applies to registrations made after you switch this on.
                </p>
                <button type="button" onClick={() => setNudgeEnabled(v => !v)}
                  aria-pressed={nudgeEnabled}
                  className="shrink-0 px-3 py-1.5 rounded-lg text-[13px] font-medium"
                  style={nudgeEnabled
                    ? { background: 'rgba(74,222,128,0.15)', color: 'var(--kurso-success)', border: '1px solid rgba(74,222,128,0.3)' }
                    : { background: 'rgba(255,255,255,0.05)', color: 'var(--kurso-text-secondary)', border: '1px solid rgba(255,255,255,0.1)' }}>
                  {nudgeEnabled ? 'On' : 'Off'}
                </button>
              </div>
              <input
                value={nudgeNote} onChange={e => setNudgeNote(e.target.value)} maxLength={120} aria-label="Reminder note"
                placeholder="Optional note in the message, e.g. Seats are filling fast"
                className={`w-full ${FIELD_CLASS} mb-1`} style={FIELD_STYLE}
              />
              <p className="text-[13px] mb-3" style={{ color: 'var(--kurso-text-muted)' }}>
                The rest of the message wording is fixed (WhatsApp requires pre-approved templates). {nudgeNote.length}/120
              </p>
              <button onClick={handleSaveNudge} disabled={nudgeSaving} className={SAVE_CLASS} style={SAVE_STYLE}>
                {nudgeSaving ? 'Saving…' : nudgeSaved ? 'Saved ✓' : 'Save'}
              </button>
            </SettingsPanel>
          </div>
        </section>
      </main>
    </div>
  )
}

// ─── Small helpers (outside the component) ──────────────────────────────────

const FIELD_CLASS = 'px-4 py-2.5 rounded-xl text-sm text-white outline-none placeholder:text-zinc-400'
const FIELD_STYLE = { background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.14)' } as const
const SAVE_CLASS = 'px-4 py-2 rounded-xl text-sm font-medium transition-all disabled:opacity-50'
const SAVE_STYLE = { background: 'rgba(var(--kurso-primary-rgb), 0.18)', color: 'var(--kurso-primary-lightest)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.3)' } as const

/** The pill next to a workshop's title. Derived from the same registration rules the public page and APIs use. */
function statusChip(w: Workshop): { label: string; style: React.CSSProperties } {
  const green = { background: 'rgba(74,222,128,0.15)', color: 'var(--kurso-success)' }
  const amber = { background: 'rgba(245,158,11,0.15)', color: 'var(--kurso-text-secondary)' }
  const grey = { background: 'rgba(255,255,255,0.08)', color: 'var(--kurso-text-secondary)' }
  if (w.status !== 'published') return { label: workshopStatusLabel(w.status), style: w.status === 'draft' ? amber : grey }
  const state = getWorkshopRegistrationState(w)
  if (state === 'ended') return { label: 'Ended', style: grey }
  if (state === 'closed') return { label: 'Registration closed', style: amber }
  return { label: 'Live', style: green }
}

/** One collapsible settings block: title and a one-line status are always visible. */
function SettingsPanel({ id, title, summary, open, onToggle, children }: {
  id: string
  title: string
  summary: string
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div className="rounded-2xl glass" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
      <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={`panel-${id}`}
        className="w-full flex items-center justify-between gap-3 p-5 text-left">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-white">{title}</p>
          <p className="text-[13px] mt-0.5 truncate" style={{ color: 'var(--kurso-text-muted)' }}>{summary}</p>
        </div>
        <ChevronDown className="w-5 h-5 shrink-0 transition-transform"
          style={{ color: 'var(--kurso-text-secondary)', transform: open ? 'rotate(180deg)' : 'none' }} />
      </button>
      {open && <div id={`panel-${id}`} className="px-5 pb-5">{children}</div>}
    </div>
  )
}