'use client'
// src/app/dashboard/whatsapp/page.tsx
//
// "Your WhatsApp number": a creator connects their own business number with Meta's Embedded
// Signup. Messages then go out from their number and Meta bills them directly, so no WhatsApp
// charges appear on their Kurso invoice. Kurso keeps charging only its commission.
import { useCallback, useEffect, useRef, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import { supabase } from '@/lib/supabase'
import { CheckCircle2, Clock, AlertCircle, ExternalLink, Phone, RefreshCw } from 'lucide-react'

type Connection = {
  connected: boolean
  available?: boolean
  status?: 'pending' | 'connected' | 'problem'
  displayPhoneNumber?: string | null
  verifiedName?: string | null
  lastError?: string | null
  templates?: Record<string, string>
}

const APP_ID = process.env.NEXT_PUBLIC_META_APP_ID || ''
const CONFIG_ID = process.env.NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID || ''
const GRAPH_VERSION = process.env.NEXT_PUBLIC_META_GRAPH_VERSION || 'v25.0'
const META_PRICING_URL = 'https://developers.facebook.com/docs/whatsapp/pricing'

const hint = { color: 'var(--kurso-hint)' } as const
const body = { color: 'var(--kurso-text-secondary)' } as const
const card = { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)' } as const

const STATE = {
  connected: { label: 'Connected', color: '#4ade80', bg: 'rgba(74,222,128,0.12)', Icon: CheckCircle2, text: 'Your students get messages from your own WhatsApp number.' },
  pending: { label: 'Waiting for verification', color: '#facc15', bg: 'rgba(250,204,21,0.12)', Icon: Clock, text: 'Meta is still verifying your number or business. Until it finishes, Kurso sends through its own number (billed on your invoice as usual). This can take a few days.' },
  problem: { label: 'Problem', color: '#f87171', bg: 'rgba(248,113,113,0.12)', Icon: AlertCircle, text: 'Your number is not working right now. Kurso is sending through its own number so your students are not left waiting.' },
} as const

const TEMPLATE_LABEL: Record<string, string> = { APPROVED: 'Ready', PENDING: 'Waiting for Meta', REJECTED: 'Rejected by Meta', MISSING: 'Not available', FAILED: 'Could not create' }

// Loads Meta's browser SDK once.
function loadFacebookSdk(): Promise<any> {
  return new Promise((resolve, reject) => {
    const w = window as any
    if (w.FB) return resolve(w.FB)
    w.fbAsyncInit = () => {
      w.FB.init({ appId: APP_ID, autoLogAppEvents: true, xfbml: false, version: GRAPH_VERSION })
      resolve(w.FB)
    }
    if (document.getElementById('facebook-jssdk')) return
    const s = document.createElement('script')
    s.id = 'facebook-jssdk'
    s.async = true
    s.src = 'https://connect.facebook.net/en_US/sdk.js'
    s.onerror = () => reject(new Error('Could not load Meta. Check your connection and try again.'))
    document.body.appendChild(s)
  })
}

export default function WhatsAppNumberPage() {
  const [conn, setConn] = useState<Connection | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; isError: boolean } | null>(null)
  // The popup reports the ids first and the code second; we need both.
  const signup = useRef<{ phoneNumberId?: string; wabaId?: string }>({})

  const authHeader = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : null
  }, [])

  const load = useCallback(async (recheck = false) => {
    const h = await authHeader()
    if (!h) { window.location.href = '/login?role=creator'; return }
    const res = await fetch(`/api/whatsapp/connection${recheck ? '?recheck=1' : ''}`, { headers: h })
    if (res.ok) setConn(await res.json())
    else setMessage({ text: 'Could not load your WhatsApp connection. Please refresh.', isError: true })
  }, [authHeader])

  useEffect(() => { (async () => { await load(); setLoading(false) })() }, [load])

  // Meta's popup tells the page which account and number the creator chose.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (!/(^|\.)facebook\.com$/.test(new URL(e.origin).hostname)) return
      try {
        const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data
        if (data?.type !== 'WA_EMBEDDED_SIGNUP') return
        if (data.event === 'FINISH' || data.event === 'FINISH_ONLY_WABA') {
          signup.current = { phoneNumberId: String(data.data?.phone_number_id || ''), wabaId: String(data.data?.waba_id || '') }
        } else if (data.event === 'CANCEL') {
          setMessage({ text: 'Sign-up was cancelled. You can start again any time.', isError: false })
        }
      } catch { /* not a message for us */ }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  async function connect() {
    setMessage(null); setBusy(true); signup.current = {}
    try {
      const FB = await loadFacebookSdk()
      const code: string | null = await new Promise(resolve => {
        FB.login((r: any) => resolve(r?.authResponse?.code || null), {
          config_id: CONFIG_ID,
          response_type: 'code',
          override_default_response_type: true,
          extras: { setup: {} },
        })
      })
      if (!code) { setBusy(false); return } // closed the popup
      // The ids arrive by a separate message; give it a moment if it is slightly behind the code.
      for (let i = 0; i < 20 && !(signup.current.phoneNumberId && signup.current.wabaId); i++) await new Promise(r => setTimeout(r, 250))
      if (!signup.current.phoneNumberId || !signup.current.wabaId) throw new Error('The sign-up did not finish. Please try again and complete every step.')

      const h = await authHeader()
      if (!h) throw new Error('Please log in again.')
      const res = await fetch('/api/whatsapp/connect', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...h },
        body: JSON.stringify({ code, phoneNumberId: signup.current.phoneNumberId, wabaId: signup.current.wabaId }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Could not connect your number.')
      setConn({ ...json, available: true })
      setMessage({ text: 'Your number is connected.', isError: false })
    } catch (err: any) {
      setMessage({ text: err.message || 'Could not connect your number.', isError: true })
    }
    setBusy(false)
  }

  async function recheck() {
    setBusy(true); setMessage(null)
    await load(true)
    setBusy(false)
  }

  async function setupTemplates() {
    setBusy(true); setMessage(null)
    const h = await authHeader()
    const res = h ? await fetch('/api/whatsapp/connection', { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify({ action: 'setup' }) }) : null
    const json = res ? await res.json().catch(() => ({})) : {}
    setMessage(res?.ok
      ? { text: 'Setting up your messages. This takes a minute. Refresh to see the result.', isError: false }
      : { text: json.error || 'Could not start the setup.', isError: true })
    setBusy(false)
  }

  async function disconnect() {
    if (!window.confirm('Disconnect your WhatsApp number? Kurso will go back to sending from its own number, billed on your invoice at Meta\'s rate. You keep your number.')) return
    setBusy(true); setMessage(null)
    const h = await authHeader()
    const res = h ? await fetch('/api/whatsapp/connection', { method: 'DELETE', headers: h }) : null
    if (res?.ok) { setConn({ connected: false, available: conn?.available }); setMessage({ text: 'Disconnected.', isError: false }) }
    else setMessage({ text: 'Could not disconnect. Please try again.', isError: true })
    setBusy(false)
  }

  const state = conn?.connected && conn.status ? STATE[conn.status] : null
  const templates = Object.entries(conn?.templates || {})
  const canConnect = Boolean(conn?.available && APP_ID && CONFIG_ID)

  return (
    <div className="flex min-h-screen bg-black">
      <Sidebar />
      <main className="flex-1 p-6 md:p-10 max-w-3xl">
        <h1 className="text-2xl font-bold text-white mb-1">Your WhatsApp number</h1>
        <p className="text-sm mb-6" style={body}>Send messages from your own number, so students see your name. Meta charges you directly, so nothing for WhatsApp messages appears on your Kurso invoice.</p>

        {message && (
          <p role="status" className="text-sm px-4 py-3 rounded-xl mb-5"
            style={{ color: message.isError ? '#f87171' : '#4ade80', background: message.isError ? 'rgba(248,113,113,0.08)' : 'rgba(74,222,128,0.08)', border: `1px solid ${message.isError ? 'rgba(248,113,113,0.2)' : 'rgba(74,222,128,0.2)'}` }}>
            {message.text}
          </p>
        )}

        {loading ? <p style={hint}>Loading…</p> : conn?.connected && state ? (
          <div className="flex flex-col gap-4">
            <div className="p-5 rounded-2xl" style={card}>
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-3 min-w-0">
                  <Phone className="w-5 h-5 shrink-0" style={{ color: 'var(--kurso-primary-light)' }} />
                  <div className="min-w-0">
                    <p className="text-base font-semibold text-white">{conn.displayPhoneNumber || 'Your number'}</p>
                    {conn.verifiedName && <p className="text-[13px]" style={hint}>{conn.verifiedName}</p>}
                  </div>
                </div>
                <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold px-3 py-1 rounded-full" style={{ background: state.bg, color: state.color }}>
                  <state.Icon className="w-3.5 h-3.5" /> {state.label}
                </span>
              </div>
              <p className="text-sm mt-3" style={body}>{state.text}</p>
              {conn.status === 'problem' && conn.lastError && <p className="text-sm mt-2" style={{ color: '#f87171' }}>{conn.lastError}</p>}
              {conn.status === 'problem' && (
                <p className="text-[13px] mt-2" style={hint}>
                  The usual cause is a missing payment method on your WhatsApp account. Add one in{' '}
                  <a href="https://business.facebook.com/wa/manage/home/" target="_blank" rel="noopener noreferrer" className="underline" style={body}>WhatsApp Manager</a>, then tap Check again.
                </p>
              )}
              <div className="flex gap-2 mt-4 flex-wrap">
                <button onClick={recheck} disabled={busy} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-white disabled:opacity-50" style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)' }}>
                  <RefreshCw className="w-3.5 h-3.5" /> Check again
                </button>
                <button onClick={disconnect} disabled={busy} className="px-3 py-2 rounded-lg text-xs font-semibold disabled:opacity-50" style={{ color: '#f87171', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)' }}>
                  Disconnect
                </button>
              </div>
            </div>

            <div className="p-5 rounded-2xl" style={card}>
              <p className="text-sm font-semibold text-white mb-1">Your messages</p>
              <p className="text-[13px] mb-3" style={hint}>WhatsApp reminders and confirmations use message templates. Kurso copies its approved templates into your account, and Meta reviews each one (usually within a day).</p>
              {templates.length === 0 ? (
                <button onClick={setupTemplates} disabled={busy} className="px-3 py-2 rounded-lg text-xs font-semibold text-white disabled:opacity-50" style={{ background: 'var(--kurso-primary, #7c3aed)' }}>Set up my messages</button>
              ) : (
                <ul className="flex flex-col gap-2">
                  {templates.map(([name, status]) => (
                    <li key={name} className="flex items-center justify-between gap-3 text-sm">
                      <span className="text-white truncate">{name.replace(/_/g, ' ')}</span>
                      <span className="text-[13px] shrink-0" style={{ color: status === 'APPROVED' ? '#4ade80' : status === 'REJECTED' || status === 'FAILED' || status === 'MISSING' ? '#f87171' : '#facc15' }}>{TEMPLATE_LABEL[status] || status}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ) : (
          <div className="p-5 rounded-2xl" style={card}>
            <p className="text-sm font-semibold text-white mb-2">Connect your number</p>
            <ol className="text-sm list-decimal pl-5 flex flex-col gap-1.5 mb-4" style={body}>
              <li>Tap Connect and log in to Meta (Facebook).</li>
              <li>Choose or create your WhatsApp Business account.</li>
              <li>Verify your phone number with the code Meta sends.</li>
              <li>Add a payment method to that WhatsApp account. Meta charges you for messages directly.</li>
            </ol>
            <p className="text-[13px] mb-4" style={hint}>Meta may need to verify your business first, which can take 2 to 4 weeks. Until it finishes, Kurso keeps sending through its own number. Use a number that is not already on the WhatsApp app, or one you are happy to move to the business platform.</p>
            {canConnect ? (
              <button onClick={connect} disabled={busy} className="px-4 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-50" style={{ background: '#25D366' }}>
                {busy ? 'Connecting…' : 'Connect my WhatsApp number'}
              </button>
            ) : (
              <p className="text-sm" style={{ color: '#facc15' }}>Connecting your own number is not available yet. Kurso sends from its own number for now.</p>
            )}
          </div>
        )}

        <div className="p-5 rounded-2xl mt-4" style={card}>
          <p className="text-sm font-semibold text-white mb-2">Good to know</p>
          <ul className="text-[13px] list-disc pl-5 flex flex-col gap-1.5" style={body}>
            <li>With your own number, Kurso charges only its commission. WhatsApp charges go to Meta, on the payment method in your WhatsApp account.</li>
            <li>Telegram and email stay free and work exactly as before.</li>
            <li>If your number stops working, Kurso sends through its own number so students keep getting their lessons. Those messages are billed on your Kurso invoice at Meta&apos;s rate.</li>
            <li>
              Meta&apos;s current prices:{' '}
              <a href={META_PRICING_URL} target="_blank" rel="noopener noreferrer" className="underline inline-flex items-center gap-1">Meta&apos;s price list <ExternalLink className="w-3 h-3" /></a>
            </li>
          </ul>
        </div>
      </main>
    </div>
  )
}
