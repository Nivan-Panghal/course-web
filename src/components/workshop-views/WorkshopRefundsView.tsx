'use client'
// Refund Requests page, Workshops side.
// Online payments: refunded through your own gateway. UPI payments: you refund the student, then mark it done.
import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, Undo2 } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { inr } from '@/lib/workshop-overview'
import { Chip, EmptyBox, ErrorBox, Loading, body, cardStyle, hint } from './ui'

type Req = {
  id: string; status: string; reason: string; note: string; requestedAt: string; completedAt: string | null
  workshopTitle: string; name: string; phone: string; email: string; amount: number; isGateway: boolean; canAutoRefund: boolean
}

const input = 'w-full px-3 py-2.5 rounded-xl text-sm text-white outline-none placeholder:text-zinc-400'
const inputStyle = { background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.14)' } as const

export default function WorkshopRefundsView() {
  const [requests, setRequests] = useState<Req[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [setupNeeded, setSetupNeeded] = useState(false)
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [confirming, setConfirming] = useState('')
  const [busy, setBusy] = useState('')
  const [done, setDone] = useState('')

  const headers = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token ? { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' } : null
  }, [])

  const load = useCallback(async () => {
    setLoading(true); setLoadError('')
    try {
      const h = await headers()
      if (!h) { setLoadError('Please log in again.'); return }
      const res = await fetch('/api/workshops/refunds', { headers: h })
      const data = await res.json().catch(() => ({}))
      if (res.status === 409) { setSetupNeeded(true); return }
      if (!res.ok) { setLoadError(data.error || 'Could not load refund requests.'); return }
      setRequests(data.requests || [])
    } catch {
      setLoadError('Could not reach the server. Check your internet and try again.')
    } finally {
      setLoading(false)
    }
  }, [headers])

  useEffect(() => { load() }, [load])

  async function decide(r: Req, decision: 'approved' | 'denied', manual = false) {
    setBusy(r.id); setConfirming(''); setDone('')
    setErrors(prev => ({ ...prev, [r.id]: '' }))
    try {
      const h = await headers()
      if (!h) { setErrors(prev => ({ ...prev, [r.id]: 'Please log in again.' })); return }
      const typed = amounts[r.id]
      const res = await fetch('/api/workshops/refunds', {
        method: 'POST', headers: h,
        body: JSON.stringify({ requestId: r.id, decision, note: notes[r.id] || '', manual, amount: decision === 'approved' && !manual && typed ? Number(typed) : undefined }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setErrors(prev => ({ ...prev, [r.id]: data.error || 'Could not process this request.' })); return }
      setDone(data.message || 'Done.')
      await load()
    } finally {
      setBusy('')
    }
  }

  if (loading) return <Loading />
  if (setupNeeded) return <EmptyBox icon={Undo2} title="One quick setup step" text="Workshop refunds need a small database update. Run the workshop coupons and refunds SQL in Supabase, then refresh this page." />
  if (loadError) return <ErrorBox message={loadError} onRetry={load} />

  const pending = requests.filter(r => r.status === 'pending')
  const past = requests.filter(r => r.status !== 'pending')

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-white mb-1">Workshop refund requests</h1>
        <p className="text-sm leading-relaxed" style={hint}>
          Paid online: approving sends the money back through your payment gateway. Paid by UPI: Kurso cannot send it, so you refund the student yourself and then tap “I’ve refunded this”. Students can ask until 7 days after the workshop starts.
        </p>
      </div>

      {done && <p role="status" className="text-sm" style={{ color: 'var(--kurso-success)' }}>{done}</p>}

      {pending.length === 0 ? (
        <EmptyBox icon={CheckCircle2} title="No pending requests" text="When a student asks for a refund, it shows up here." />
      ) : (
        <div className="flex flex-col gap-4">
          {pending.map(r => (
            <div key={r.id} className="rounded-2xl p-5 glass" style={cardStyle}>
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-white">{r.name}</p>
                  <p className="text-[13px]" style={hint}>{r.phone}{r.email ? ` · ${r.email}` : ''}</p>
                  <p className="text-[13px] truncate" style={body}>{r.workshopTitle}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Chip tone={r.isGateway ? 'info' : 'neutral'}>{r.isGateway ? 'Paid online' : 'Paid by UPI'}</Chip>
                  <span className="text-sm font-semibold text-white">{inr(r.amount)}</span>
                </div>
              </div>

              {r.reason && <p className="text-sm mt-3 italic whitespace-pre-wrap break-words" style={{ color: 'var(--kurso-text-secondary)' }}>“{r.reason}”</p>}

              <div className="mt-4 flex flex-col gap-3">
                {r.isGateway && r.canAutoRefund && (
                  <div>
                    <label className="text-[13px] block mb-1" style={hint}>Refund amount (₹). Leave empty to refund the full {inr(r.amount)}.</label>
                    <input type="number" min={1} value={amounts[r.id] || ''} onChange={e => setAmounts(prev => ({ ...prev, [r.id]: e.target.value }))}
                      placeholder={`Full amount: ${r.amount.toLocaleString('en-IN')}`} className={input} style={inputStyle} />
                  </div>
                )}
                {!r.isGateway && (
                  <p className="text-[14px] leading-relaxed rounded-xl p-3" style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.25)', color: 'var(--kurso-text-secondary)' }}>
                    This was paid by UPI. Send {inr(r.amount)} back to {r.phone || 'the student'} yourself, then tap “I’ve refunded this”.
                  </p>
                )}
                {r.isGateway && !r.canAutoRefund && (
                  <p className="text-[14px] leading-relaxed rounded-xl p-3" style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.25)', color: 'var(--kurso-text-secondary)' }}>
                    We could not find this online payment, so Kurso cannot refund it automatically. Refund it from your payment gateway dashboard, then tap “I’ve refunded this”.
                  </p>
                )}
                <div>
                  <label className="text-[13px] block mb-1" style={hint}>Note for the student (optional). They see it on their refund page.</label>
                  <input value={notes[r.id] || ''} onChange={e => setNotes(prev => ({ ...prev, [r.id]: e.target.value }))} maxLength={500} placeholder="For example: Sorry the session did not work out for you." className={input} style={inputStyle} />
                </div>
                {errors[r.id] && <p role="alert" className="text-sm px-3 py-2 rounded-xl" style={{ color: '#f87171', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)' }}>{errors[r.id]}</p>}

                {confirming === r.id ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm" style={body}>Send {inr(amounts[r.id] ? Number(amounts[r.id]) : r.amount)} back to {r.name} now? This cannot be undone.</p>
                    <button type="button" disabled={busy === r.id} onClick={() => decide(r, 'approved')} className="px-4 py-2 rounded-xl text-[13px] font-semibold disabled:opacity-50" style={{ background: 'rgba(74,222,128,0.15)', border: '1px solid rgba(74,222,128,0.3)', color: '#4ade80' }}>
                      {busy === r.id ? 'Processing…' : 'Yes, refund'}
                    </button>
                    <button type="button" disabled={busy === r.id} onClick={() => setConfirming('')} className="px-4 py-2 rounded-xl text-[13px] font-medium" style={{ background: 'rgba(255,255,255,0.08)', color: 'var(--kurso-text-secondary)' }}>Cancel</button>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {r.isGateway && r.canAutoRefund && (
                      <button type="button" disabled={busy === r.id} onClick={() => setConfirming(r.id)} className="px-4 py-2 rounded-xl text-[13px] font-semibold disabled:opacity-50" style={{ background: 'rgba(74,222,128,0.15)', border: '1px solid rgba(74,222,128,0.3)', color: '#4ade80' }}>
                        Approve and refund
                      </button>
                    )}
                    <button type="button" disabled={busy === r.id} onClick={() => decide(r, 'approved', true)} className="px-4 py-2 rounded-xl text-[13px] font-semibold disabled:opacity-50"
                      style={r.isGateway && r.canAutoRefund ? { background: 'rgba(255,255,255,0.08)', color: 'var(--kurso-text-secondary)' } : { background: 'rgba(74,222,128,0.15)', border: '1px solid rgba(74,222,128,0.3)', color: '#4ade80' }}>
                      I’ve refunded this
                    </button>
                    <button type="button" disabled={busy === r.id} onClick={() => decide(r, 'denied')} className="px-4 py-2 rounded-xl text-[13px] font-semibold disabled:opacity-50" style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', color: '#f87171' }}>
                      Decline
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {past.length > 0 && (
        <div>
          <h2 className="text-base font-semibold text-white mb-3">Past requests</h2>
          <div className="rounded-2xl overflow-hidden glass" style={cardStyle}>
            {past.map((r, i) => (
              <div key={r.id} className="flex items-center justify-between gap-3 flex-wrap px-5 py-3.5" style={{ borderTop: i === 0 ? 'none' : '1px solid rgba(255,255,255,0.07)' }}>
                <span className="min-w-0">
                  <span className="block text-sm text-white truncate">{r.name} · {r.workshopTitle}</span>
                  <span className="block text-[13px]" style={hint}>{inr(r.amount)} · {r.isGateway ? 'Paid online' : 'Paid by UPI'} · Asked {new Date(r.requestedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span>
                </span>
                <Chip tone={r.status === 'completed' ? 'good' : r.status === 'denied' ? 'warn' : 'neutral'}>
                  {r.status === 'completed' ? 'Refunded' : r.status === 'denied' ? 'Declined' : 'In progress'}
                </Chip>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}