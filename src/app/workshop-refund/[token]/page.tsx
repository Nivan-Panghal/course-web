'use client'
// Public page where a workshop attendee can ask for a refund (private link, no login).
import { use, useEffect, useState } from 'react'
import { CheckCircle2, Clock3, XCircle } from 'lucide-react'

type Info = {
  workshopTitle: string
  hostName: string
  firstName: string
  amount: number
  isGateway: boolean
  deadline: string
  canRequest: boolean
  reason: string | null
  request: { status: string; note: string; requestedAt: string } | null
}

const MAX_REASON = 500
const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`
const dateLabel = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })

export default function WorkshopRefundPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params)
  const [info, setInfo] = useState<Info | null>(null)
  const [loadError, setLoadError] = useState('')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/workshops/refund?token=${encodeURIComponent(token)}`)
        const data = await res.json().catch(() => ({}))
        if (cancelled) return
        if (!res.ok) { setLoadError(data.error || 'This refund link is not valid.'); return }
        setInfo(data)
      } catch {
        if (!cancelled) setLoadError('Could not load this page. Check your internet and try again.')
      }
    })()
    return () => { cancelled = true }
  }, [token])

  async function submit() {
    setSaving(true)
    setError('')
    try {
      const res = await fetch('/api/workshops/refund', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, reason }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.error || 'Could not send your request. Please try again.'); return }
      setSent(true)
    } catch {
      setError('Could not reach the server. Check your internet and try again.')
    } finally {
      setSaving(false)
    }
  }

  const shell = (children: React.ReactNode) => (
    <div className="min-h-screen bg-black flex items-center justify-center p-5">
      <div className="w-full max-w-md rounded-2xl p-6 md:p-8 glass" style={{ border: '1px solid rgba(255,255,255,0.1)' }}>{children}</div>
    </div>
  )
  const text2 = { color: 'var(--kurso-text-secondary)' } as const
  const hint = { color: 'var(--kurso-hint)' } as const

  if (loadError) return shell(<p role="alert" className="text-sm text-center" style={text2}>{loadError}</p>)
  if (!info) return shell(<p className="text-sm text-center" style={hint}>Loading…</p>)

  const hostWho = info.hostName || 'the host'

  if (sent) {
    return shell(
      <div className="text-center">
        <CheckCircle2 className="w-12 h-12 mx-auto mb-3" style={{ color: 'var(--kurso-success)' }} />
        <h1 className="text-xl font-bold text-white mb-2">Request sent</h1>
        <p className="text-sm" style={text2}>
          {hostWho} will look at your request. You can open this link again any time to see the answer.
        </p>
      </div>
    )
  }

  if (info.request) {
    const s = info.request.status
    const done = s === 'completed'
    const denied = s === 'denied'
    const Icon = done ? CheckCircle2 : denied ? XCircle : Clock3
    const color = done ? 'var(--kurso-success)' : denied ? 'var(--kurso-danger)' : '#fbbf24'
    return shell(
      <div className="text-center">
        <Icon className="w-12 h-12 mx-auto mb-3" style={{ color }} />
        <h1 className="text-xl font-bold text-white mb-1">{info.workshopTitle}</h1>
        <p className="text-sm font-semibold mb-2" style={{ color }}>
          {done ? 'Your refund has been processed' : denied ? 'Your request was declined' : 'Your request is waiting for a reply'}
        </p>
        <p className="text-sm" style={text2}>
          {done
            ? (info.isGateway ? `${inr(info.amount)} goes back to your original payment method. Banks can take a few working days.` : `${hostWho} has marked your ${inr(info.amount)} as refunded.`)
            : denied ? 'You can contact the host directly if you have questions.'
              : `You asked on ${dateLabel(info.request.requestedAt)}. ${hostWho} will reply soon.`}
        </p>
        {info.request.note && (
          <div className="mt-4 rounded-xl p-3 text-left" style={{ background: 'rgba(var(--kurso-primary-rgb), 0.1)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.25)' }}>
            <p className="text-[13px] mb-1" style={hint}>Note from {hostWho}</p>
            <p className="text-sm text-white whitespace-pre-wrap">{info.request.note}</p>
          </div>
        )}
      </div>
    )
  }

  if (!info.canRequest) {
    return shell(
      <div className="text-center">
        <h1 className="text-lg font-bold text-white mb-2">{info.workshopTitle}</h1>
        <p className="text-sm" style={text2}>{info.reason}</p>
      </div>
    )
  }

  return shell(
    <>
      <p className="text-[13px] mb-1" style={hint}>{info.hostName}</p>
      <h1 className="text-xl font-bold text-white mb-1">Ask for a refund</h1>
      <p className="text-sm mb-1" style={text2}>{info.workshopTitle}</p>
      <p className="text-sm mb-5" style={hint}>You paid {inr(info.amount)}. You can ask until {dateLabel(info.deadline)}.</p>

      <label htmlFor="refund-reason" className="text-sm font-medium text-white block mb-1.5">
        What went wrong? <span className="font-normal" style={hint}>(optional)</span>
      </label>
      <textarea id="refund-reason" rows={4} value={reason} maxLength={MAX_REASON} onChange={e => setReason(e.target.value)}
        placeholder="Tell the host why you are asking. It helps them decide."
        className="w-full px-4 py-3 rounded-xl text-sm text-white outline-none resize-none placeholder:text-zinc-400"
        style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.14)' }}
        onFocus={e => (e.target.style.borderColor = 'var(--kurso-primary)')}
        onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.14)')} />

      <p className="text-[13px] mt-3 leading-relaxed" style={hint}>
        {info.isGateway
          ? `${hostWho} decides on your request. If it is approved, the money goes back to the way you paid.`
          : `You paid by UPI. If ${hostWho} approves, they will send the money back to you directly.`}
      </p>

      {error && <p role="alert" className="text-sm mt-3" style={{ color: 'var(--kurso-danger)' }}>{error}</p>}

      <button type="button" onClick={submit} disabled={saving}
        className="w-full mt-5 py-3 rounded-xl text-sm font-semibold text-white violet-gradient hover:opacity-90 disabled:opacity-50">
        {saving ? 'Sending…' : 'Send refund request'}
      </button>
    </>,
  )
}