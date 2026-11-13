'use client'
/**
 * Admin's entry point into the impersonation panel. Lists creators;
 * "Log in as this creator" swaps her browser's Supabase session for a
 * genuine session for that creator's account — see
 * /api/admin/impersonate/[creatorId] for the mechanism and what stays
 * blocked regardless (payment gateway, revenue-share payment, account
 * deletion). Gated server-side by requireAdmin().
 */
import { useCallback, useEffect, useState } from 'react'
import { supabase, getSessionOrRefresh } from '@/lib/supabase'
import { Loader2, LogIn, Search, ShieldAlert, User } from 'lucide-react'

interface CreatorRow {
  id: string
  name: string
  email: string
  payout_account_status?: string | null
}

export default function AdminCreatorsPage() {
  const [authorized, setAuthorized] = useState(true)
  const [loading, setLoading] = useState(true)
  const [creators, setCreators] = useState<CreatorRow[]>([])
  const [search, setSearch] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [selfId, setSelfId] = useState<string | null>(null)
  const [expiredNotice, setExpiredNotice] = useState(false)

  useEffect(() => {
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('impersonation') === 'expired') {
      setExpiredNotice(true)
    }
  }, [])

  const authHeader = useCallback(async () => {
    const { session } = await getSessionOrRefresh()
    if (!session?.access_token) return null
    setSelfId(session.user.id)
    return { Authorization: `Bearer ${session.access_token}` }
  }, [])

  const load = useCallback(async () => {
    const headers = await authHeader()
    if (!headers) { setAuthorized(false); setLoading(false); return }
    const res = await fetch('/api/admin/creators', { headers })
    if (res.status === 401) { setAuthorized(false); setLoading(false); return }
    const json = await res.json()
    if (res.ok) setCreators(json.creators || [])
    setLoading(false)
  }, [authHeader])

  useEffect(() => { load() }, [load])

  async function startImpersonation(creator: CreatorRow) {
    if (busyId) return
    const confirmed = window.confirm(
      `Log in as ${creator.name || 'this creator'}?\n\nYou'll see and use their dashboard exactly as they would. Payment gateway, revenue-share payment, and account-deletion actions stay blocked while you're viewing as them.`
    )
    if (!confirmed) return

    setBusyId(creator.id)
    setError('')
    try {
      const { session } = await getSessionOrRefresh()
      if (!session?.access_token) throw new Error('Your session expired — please sign in again.')

      sessionStorage.setItem('kurso_admin_return_session', JSON.stringify({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
      }))

      const res = await fetch(`/api/admin/impersonate/${creator.id}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Could not start impersonation.')

      const { error: otpError } = await supabase.auth.verifyOtp({
        type: 'magiclink',
        token_hash: json.tokenHash,
      })
      if (otpError) throw otpError

      sessionStorage.setItem('kurso_impersonation', JSON.stringify({
        creatorId: creator.id,
        creatorName: json.creatorName,
        sessionId: json.sessionId,
        expiresAt: json.expiresAt,
      }))

      window.location.href = '/dashboard'
    } catch (e: any) {
      sessionStorage.removeItem('kurso_admin_return_session')
      setError(e.message || 'Could not start impersonation.')
      setBusyId(null)
    }
  }

  const filtered = creators.filter(c => {
    if (c.id === selfId) return false
    const q = search.toLowerCase()
    return (c.name || '').toLowerCase().includes(q) || (c.email || '').toLowerCase().includes(q)
  })

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', background: '#050505', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Loader2 className="w-6 h-6 animate-spin" style={{ color: 'var(--kurso-primary)' }} />
      </div>
    )
  }

  if (!authorized) {
    return (
      <div style={{ minHeight: '100vh', background: '#050505', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: '#a1a1aa' }}>Not authorized.</p>
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', background: '#050505' }} className="px-4 py-6 sm:px-6 sm:py-8">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-lg sm:text-xl font-bold text-white mb-1">Log in as a creator</h1>
        <p className="text-xs sm:text-sm mb-5" style={{ color: 'var(--kurso-text-muted)' }}>
          Pick a creator to view and use their dashboard. Exit any time from the banner at the top.
        </p>

        {expiredNotice && (
          <div className="mb-4 px-3.5 py-2.5 rounded-xl flex items-center gap-2" style={{ background: 'rgba(247,149,20,0.08)', border: '1px solid rgba(247,149,20,0.25)' }}>
            <ShieldAlert className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--kurso-primary)' }} />
            <p className="text-xs sm:text-sm" style={{ color: 'var(--kurso-primary-lighter)' }}>
              Your last impersonation session expired automatically and was exited for you.
            </p>
          </div>
        )}

        {error && (
          <div className="mb-4 px-3.5 py-2.5 rounded-xl" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}>
            <p className="text-xs sm:text-sm" style={{ color: '#fca5a5' }}>{error}</p>
          </div>
        )}

        <div className="relative mb-4">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--kurso-text-muted)' }} />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by name or email…"
            className="w-full pl-9 pr-3 py-2.5 rounded-xl text-sm text-white outline-none"
            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
          />
        </div>

        {filtered.length === 0 ? (
          <p className="text-sm text-center py-10" style={{ color: 'var(--kurso-text-muted)' }}>No creators found.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {filtered.map(c => (
              <div
                key={c.id}
                className="flex items-center gap-3 px-4 py-3 rounded-xl"
                style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}
              >
                <div className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(255,255,255,0.08)' }}>
                  <User className="w-4 h-4" style={{ color: 'var(--kurso-text-muted)' }} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-white truncate">{c.name || 'Unnamed creator'}</p>
                  <p className="text-xs truncate" style={{ color: 'var(--kurso-text-muted)' }}>{c.email}</p>
                  {c.payout_account_status && (
                    <p className="text-[11px] truncate" style={{ color: 'var(--kurso-text-muted)' }}>
                      Payout: {c.payout_account_status}
                    </p>
                  )}
                </div>
                <button
                  onClick={() => startImpersonation(c)}
                  disabled={busyId === c.id}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs sm:text-sm font-semibold flex-shrink-0 disabled:opacity-60"
                  style={{ background: 'var(--kurso-primary)', color: '#000' }}
                >
                  {busyId === c.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <LogIn className="w-3.5 h-3.5" />}
                  <span className="hidden sm:inline">Log in as this creator</span>
                  <span className="sm:hidden">Log in</span>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}