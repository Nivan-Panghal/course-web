'use client'
import { useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import AudienceSwitch, { useAudienceMode } from '@/components/AudienceSwitch'
import WorkshopRefundsView from '@/components/workshop-views/WorkshopRefundsView'
import { supabase } from '@/lib/supabase'

export default function RefundRequestsPage() {
  const [audience, setAudience] = useAudienceMode()
  const [token, setToken] = useState('')
  const [requests, setRequests] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [decidingId, setDecidingId] = useState<string | null>(null)
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    async function load() {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return
      setToken(session.access_token)
      const res = await fetch('/api/creator/refund-requests', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (res.ok) {
        const d = await res.json()
        setRequests(d.requests || [])
      }
      setLoading(false)
    }
    load()
  }, [])

  async function decide(requestId: string, decision: 'approved' | 'denied') {
    setDecidingId(requestId)
    setErrors(prev => ({ ...prev, [requestId]: '' }))
    try {
      const amountEntered = amounts[requestId]
      const res = await fetch('/api/creator/refund-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          requestId, decision, note: notes[requestId] || '',
          amount: decision === 'approved' && amountEntered ? Number(amountEntered) : undefined,
        }),
      })
      const json = await res.json()
      if (res.ok) {
        setRequests(prev => prev.map(r => r.id === requestId ? { ...r, status: decision === 'approved' ? 'completed' : 'denied' } : r))
      } else {
        // Shown inline next to this specific request — a Cashfree/Razorpay/
        // Stripe error (e.g. an issue on the creator's own gateway account)
        // needs to be visible right where the creator is acting, not lost
        // in a dismissible popup.
        setErrors(prev => ({ ...prev, [requestId]: json.error || 'Could not process this refund.' }))
      }
    } finally {
      setDecidingId(null)
    }
  }

  const pending = requests.filter(r => r.status === 'pending')
  const past = requests.filter(r => r.status !== 'pending')

  return (
    <div className="min-h-screen flex" style={{ background: '#050505' }}>
      <Sidebar />
  <main className="flex-1 p-8 pt-20 md:pt-8 max-w-3xl mx-auto w-full">
    <AudienceSwitch value={audience} onChange={setAudience} />
    {audience === 'workshops' ? (
      <WorkshopRefundsView />
    ) : (
      <>
    <h1 className="text-2xl font-bold text-white mb-1">Refund Requests</h1>
        <p className="text-sm mb-8" style={{ color: '#a1a1aa' }}>
          Approving sends the refund through your connected payment gateway automatically and revokes the student's access — no manual transfer needed. Leave the amount blank for a full refund, or enter a smaller amount for a partial one.
        </p>

        {loading ? (
          <div className="w-6 h-6 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
        ) : pending.length === 0 ? (
          <p className="text-sm" style={{ color: '#52525b' }}>No pending refund requests.</p>
        ) : (
          <div className="flex flex-col gap-4 mb-10">
            {pending.map(r => (
              <div key={r.id} className="p-4 rounded-xl" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm font-semibold text-white">
                    {r.product_name} <span className="text-xs font-normal" style={{ color: 'var(--kurso-text-muted)' }}>({r.type})</span>
                  </p>
                  <span className="text-xs" style={{ color: '#71717a' }}>₹{Number(r.amount || 0).toLocaleString('en-IN')}</span>
                </div>
                <p className="text-xs mb-1" style={{ color: '#a1a1aa' }}>{r.buyer_name || r.buyer_email || 'Student'}</p>
                {r.reason && <p className="text-xs mb-3 italic" style={{ color: '#71717a' }}>&quot;{r.reason}&quot;</p>}
                <label className="text-xs block mb-1" style={{ color: '#71717a' }}>
                  Refund amount (₹) — leave blank for the full ₹{Number(r.amount || 0).toLocaleString('en-IN')}
                </label>
                <input
                  type="number"
                  placeholder={`Full amount: ${Number(r.amount || 0).toLocaleString('en-IN')}`}
                  value={amounts[r.id] || ''}
                  onChange={e => setAmounts(prev => ({ ...prev, [r.id]: e.target.value }))}
                  className="w-full mb-3 px-3 py-2 rounded-lg text-xs text-white outline-none"
                  style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
                />
                <input
                  placeholder="Optional note to yourself"
                  value={notes[r.id] || ''}
                  onChange={e => setNotes(prev => ({ ...prev, [r.id]: e.target.value }))}
                  className="w-full mb-3 px-3 py-2 rounded-lg text-xs text-white outline-none"
                  style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
                />
                {errors[r.id] && (
                  <p className="text-xs mb-3 px-3 py-2 rounded-lg" style={{ color: '#f87171', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)' }}>
                    {errors[r.id]}
                  </p>
                )}
                <div className="flex gap-2">
                  <button onClick={() => decide(r.id, 'approved')} disabled={decidingId === r.id}
                    className="flex-1 py-2 rounded-lg text-xs font-semibold disabled:opacity-50"
                    style={{ background: 'rgba(74,222,128,0.15)', border: '1px solid rgba(74,222,128,0.3)', color: '#4ade80' }}>
                    {decidingId === r.id ? 'Processing…' : 'Approve & Refund'}
                  </button>
                  <button onClick={() => decide(r.id, 'denied')} disabled={decidingId === r.id}
                    className="flex-1 py-2 rounded-lg text-xs font-semibold disabled:opacity-50"
                    style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', color: '#ef4444' }}>
                    Deny
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {past.length > 0 && (
          <>
            <p className="text-sm font-semibold text-white mb-3">Past requests</p>
            <div className="flex flex-col gap-2">
              {past.map(r => (
                <div key={r.id} className="flex items-center justify-between p-3 rounded-lg text-xs"
                  style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
                  <span style={{ color: '#a1a1aa' }}>{r.product_name} — {r.buyer_name || r.buyer_email}</span>
                  <span style={{ color: r.status === 'completed' ? '#4ade80' : '#ef4444' }}>
                    {r.status === 'completed' ? 'Refunded' : 'Denied'}
                  </span>
                </div>
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