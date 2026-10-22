'use client'
// src/app/upgrade/page.tsx
//
// Billing page. Everyone is on Pay As You Earn: no monthly plan.
//   - Commission on courses, workshops and ebooks
//   - WhatsApp message charges, passed through at Meta's rates (Telegram and email are free)
// One invoice per month. Commission only appears in months with sales; WhatsApp charges
// appear in any month where messages were sent.
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Shield, ArrowLeft, MessageCircle, Send, Mail, BookOpen, Calendar, Book, ExternalLink, CheckCircle2, Info } from 'lucide-react'
import { supabase } from '@/lib/supabase'

type LineItem =
  | { type: 'sales' | 'commission' | 'refund_credit'; label: string; amount: number; detail?: string }
  | { type: 'whatsapp'; category: string; label: string; count: number; rate: number; amount: number }

type Invoice = {
  id: string; product_type: string; period_start: string; gross_revenue: number; total_amount_due: number
  commission_amount?: number; whatsapp_amount?: number; line_items?: LineItem[]; status: string
}

type Billing = {
  invoices: Invoice[]
  rates: { baseRatePercent: number; overflowRatePercent: number; thresholdStudents: number; ebookRatePercent: number; ebookMonthlyFloor: number; graceDays: number }
  thisMonth: { collected: number; commission: number; whatsappLines: { category: string; label: string; count: number; rate: number; amount: number }[]; whatsappTotal: number; estimatedTotal: number }
  whatsappRates: { category: string; label: string; rate: number }[]
  meta: { pricingUrl: string; minWhatsappInvoice: number }
}

const inr = (n: number) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
const hint = { color: 'var(--kurso-hint)' } as const
const body = { color: 'var(--kurso-text-secondary)' } as const
const card = { border: '1px solid rgba(255,255,255,0.08)' } as const

const STATUS: Record<string, { bg: string; color: string; label: string }> = {
  pending: { bg: 'rgba(250,204,21,0.12)', color: '#facc15', label: 'Due' },
  not_due: { bg: 'rgba(255,255,255,0.08)', color: 'var(--kurso-text-secondary)', label: 'Nothing due' },
  paid: { bg: 'rgba(74,222,128,0.12)', color: '#4ade80', label: 'Paid' },
  waived: { bg: 'rgba(59,130,246,0.12)', color: '#60a5fa', label: 'Waived' },
  overdue: { bg: 'rgba(239,68,68,0.12)', color: '#f87171', label: 'Overdue' },
}

const FAQ = [
  { q: 'When do I get billed?', a: 'Once a month. After the month ends we add up the commission on your sales and your WhatsApp message charges into one invoice. You have 14 days to pay it.' },
  { q: 'What if I earned nothing this month?', a: 'You owe no commission. If you sent WhatsApp messages, those charges are still due, because Meta bills Kurso for every message. Telegram and email never cost you anything.' },
  { q: 'Why are WhatsApp messages charged separately?', a: 'Meta charges a small fee for each business message it delivers. We pass that cost on at the same rate Meta charges us, with no extra markup. You can read Meta\'s own price list using the link on this page.' },
  { q: 'How do I keep WhatsApp costs low?', a: 'Telegram and email are free, so students who use them cost you nothing. Replies a student starts themselves are the cheapest WhatsApp messages. Promotional messages cost the most.' },
  { q: 'Can I ask for a waiver in a slow month?', a: 'Yes, for the commission part, from the invoice below. WhatsApp charges are Meta\'s real cost, so they stay due.' },
  { q: 'What happens if I do not pay?', a: 'After 14 days your courses and workshops stop taking new students until the invoice is paid, and promotional WhatsApp messages (like payment reminders) pause. Students who already joined keep full access, including their lessons and reminders.' },
]

export default function BillingPage() {
  const [loading, setLoading] = useState(true)
  const [billing, setBilling] = useState<Billing | null>(null)
  const [waivers, setWaivers] = useState<{ invoice_id: string; status: string }[]>([])
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [message, setMessage] = useState<{ text: string; isError: boolean } | null>(null)
  const [payingId, setPayingId] = useState<string | null>(null)
  const [waiverFor, setWaiverFor] = useState<string | null>(null)
  const [reasonDraft, setReasonDraft] = useState<Record<string, string>>({})
  const [checking, setChecking] = useState(false)

  async function authHeader() {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : null
  }

  async function load() {
    const h = await authHeader()
    if (!h) { window.location.href = '/login?role=creator'; return }
    const [b, w] = await Promise.all([
      fetch('/api/creator/revenue-share', { headers: h }),
      fetch('/api/creator/revenue-share/waiver-request', { headers: h }),
    ])
    if (b.ok) setBilling(await b.json()); else setError('Could not load your billing details. Please refresh.')
    if (w.ok) setWaivers((await w.json()).requests || [])
  }

  useEffect(() => { (async () => { await load(); setLoading(false) })() }, [])

  async function loadCashfreeSdk(): Promise<any> {
    if ((window as any).__cashfreeInstance) return (window as any).__cashfreeInstance
    await new Promise<void>((resolve, reject) => {
      if (document.getElementById('cashfree-sdk-script')) return resolve()
      const script = document.createElement('script')
      script.id = 'cashfree-sdk-script'
      script.src = 'https://sdk.cashfree.com/js/v3/cashfree.js'
      script.onload = () => resolve()
      script.onerror = () => reject(new Error('Could not load the payment SDK. Check your connection and try again.'))
      document.body.appendChild(script)
    })
    const mode = process.env.NEXT_PUBLIC_KURSO_CASHFREE_ENV === 'sandbox' ? 'sandbox' : 'production'
    const instance = (window as any).Cashfree({ mode })
    ;(window as any).__cashfreeInstance = instance
    return instance
  }

  async function pollOrderStatus(id: string, attemptsLeft = 8): Promise<string | null> {
    if (attemptsLeft <= 0) return null
    const res = await fetch(`/api/order-status?clientTxnId=${id}`)
    const data = await res.json().catch(() => null)
    if (data?.status === 'active' || data?.status === 'success') return data.status
    await new Promise(r => setTimeout(r, 2000))
    return pollOrderStatus(id, attemptsLeft - 1)
  }

  // Back from the payment page: confirm the payment before saying it worked.
  useEffect(() => {
    if (loading) return
    const params = new URLSearchParams(window.location.search)
    const orderId = params.get('order_id') || params.get('revenue_share_invoice')
    if (!orderId) return
    setChecking(true)
    pollOrderStatus(orderId).then(async status => {
      setChecking(false)
      if (status) { setSuccess('Payment received. Thank you!'); await load() }
      else setError('We could not confirm this payment yet. If money was deducted, it will show within a few minutes. Refresh this page, or contact support if it does not.')
      window.history.replaceState({}, '', window.location.pathname)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading])

  async function pay(invoiceId: string) {
    setPayingId(invoiceId); setMessage(null)
    try {
      const h = await authHeader()
      if (!h) throw new Error('Please log in again.')
      const res = await fetch('/api/creator/revenue-share/pay', { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify({ invoiceId }) })
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      const cashfree = await loadCashfreeSdk()
      await cashfree.checkout({ paymentSessionId: data.paymentSessionId, redirectTarget: '_self' })
    } catch (err: any) {
      setMessage({ text: err.message, isError: true })
      setPayingId(null)
    }
  }

  async function requestWaiver(invoiceId: string) {
    setWaiverFor(invoiceId); setMessage(null)
    try {
      const h = await authHeader()
      if (!h) throw new Error('Please log in again.')
      const res = await fetch('/api/creator/revenue-share/waiver-request', { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify({ invoiceId, reason: reasonDraft[invoiceId] || '' }) })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Could not send the request.')
      setMessage({ text: 'Request sent. Your courses stay live while we review it.', isError: false })
      await load()
    } catch (err: any) {
      setMessage({ text: err.message, isError: true })
    } finally {
      setWaiverFor(null)
    }
  }

  // A function (not a component) so typing in the waiver box never loses focus.
  function renderInvoice(inv: Invoice) {
    const month = new Date(inv.period_start).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
    const isEbook = inv.product_type === 'ebook'
    const st = STATUS[inv.status] || STATUS.pending
    const pendingWaiver = waivers.find(w => w.invoice_id === inv.id && w.status === 'pending')
    const items = inv.line_items || []
    return (
      <div key={inv.id} className="rounded-xl p-5" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <p className="text-sm font-semibold text-white">{month}{isEbook ? ' · Ebooks' : ' · Courses, workshops and WhatsApp'}</p>
          <span className="text-[13px] font-semibold px-2.5 py-1 rounded-full" style={{ background: st.bg, color: st.color }}>{st.label}</span>
        </div>

        {items.length > 0 ? (
          <div className="flex flex-col gap-1.5 mb-3">
            {items.map((li, i) => (
              <div key={i} className="flex items-start justify-between gap-3 text-sm">
                <span style={body}>
                  {li.label}
                  {li.type === 'whatsapp' && <span style={hint}> · {li.count.toLocaleString('en-IN')} × {inr(li.rate)}</span>}
                  {li.type !== 'whatsapp' && li.detail && <span style={hint}> · {li.detail}</span>}
                </span>
                <span className="text-white whitespace-nowrap">{li.amount < 0 ? `− ${inr(Math.abs(li.amount))}` : inr(li.amount)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm mb-3" style={body}>
            Students paid you {inr(inv.gross_revenue)}. {isEbook ? 'Ebook commission' : 'Charges'}: {inr(inv.total_amount_due)}.
          </p>
        )}

        <div className="flex items-center justify-between pt-3" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          <span className="text-sm font-semibold text-white">Total {inv.status === 'paid' ? 'paid' : 'due'}</span>
          <span className="text-base font-bold text-white">{inr(inv.total_amount_due)}</span>
        </div>

        {(inv.status === 'pending' || inv.status === 'overdue') && inv.total_amount_due > 0 && !pendingWaiver && (
          <div className="flex flex-wrap items-center gap-2 mt-4">
            <button onClick={() => pay(inv.id)} disabled={payingId === inv.id}
              className="px-5 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
              style={{ background: 'linear-gradient(135deg, var(--kurso-primary), var(--kurso-primary-light))' }}>
              {payingId === inv.id ? 'Opening payment…' : `Pay ${inr(inv.total_amount_due)}`}
            </button>
            {Number(inv.commission_amount ?? inv.total_amount_due) > 0 && (
              <>
                <input value={reasonDraft[inv.id] || ''} onChange={e => setReasonDraft(prev => ({ ...prev, [inv.id]: e.target.value }))}
                  placeholder="Slow month? Tell us why (optional)" aria-label="Reason for waiver request"
                  className="flex-1 min-w-[180px] px-3 py-2.5 rounded-xl text-sm text-white outline-none placeholder:text-zinc-400"
                  style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.14)' }} />
                <button onClick={() => requestWaiver(inv.id)} disabled={waiverFor === inv.id}
                  className="px-4 py-2.5 rounded-xl text-sm font-medium disabled:opacity-50"
                  style={{ background: 'rgba(255,255,255,0.08)', color: 'var(--kurso-text-secondary)', border: '1px solid rgba(255,255,255,0.14)' }}>
                  {waiverFor === inv.id ? 'Sending…' : 'Ask to waive the commission'}
                </button>
              </>
            )}
          </div>
        )}
        {pendingWaiver && <p className="text-sm mt-3" style={{ color: '#60a5fa' }}>Waiver requested. Your courses stay live while we review it.</p>}
      </div>
    )
  }

  if (loading) {
    return <div className="min-h-screen bg-black flex items-center justify-center"><div className="w-10 h-10 violet-gradient rounded-xl animate-pulse-glow" /></div>
  }

  const rates = billing?.rates
  const month = billing?.thisMonth
  const invoices = billing?.invoices || []

  return (
    <div className="min-h-screen bg-black grid-bg">
      <div className="border-b px-6 py-4 flex items-center justify-between" style={{ borderColor: 'rgba(255,255,255,0.08)', background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(20px)' }}>
        <Link href="/" className="flex items-center gap-2">
          <div className="w-7 h-7 violet-gradient rounded-lg flex items-center justify-center"><Shield className="w-3.5 h-3.5 text-white" /></div>
          <span className="font-semibold text-white">Kurso</span>
        </Link>
        <Link href="/dashboard" className="flex items-center gap-2 text-sm" style={body}><ArrowLeft className="w-4 h-4" /> Back to Dashboard</Link>
      </div>

      <div className="max-w-4xl mx-auto px-6 py-14">
        <div className="text-center mb-10">
          <h1 className="text-4xl font-bold text-white mb-3">Billing</h1>
          <p className="max-w-xl mx-auto" style={body}>Everyone is on Pay As You Earn. There is no monthly plan and nothing to pay to get started. You are billed once a month, and only for what you used.</p>
        </div>

        {success && <div role="status" className="mb-6 p-4 rounded-xl text-sm flex items-center gap-2" style={{ background: 'rgba(74,222,128,0.1)', color: '#4ade80', border: '1px solid rgba(74,222,128,0.25)' }}><CheckCircle2 className="w-4 h-4" />{success}</div>}
        {error && <div role="alert" className="mb-6 p-4 rounded-xl text-sm" style={{ background: 'rgba(239,68,68,0.1)', color: '#f87171', border: '1px solid rgba(239,68,68,0.25)' }}>{error}</div>}
        {checking && <p className="mb-6 text-sm text-center" style={hint}>Checking your payment…</p>}

        {/* How you pay */}
        <h2 className="text-xl font-bold text-white mb-4">How you pay</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          <div className="rounded-2xl p-6 glass" style={card}>
            <div className="flex items-center gap-2 mb-3"><Calendar className="w-5 h-5" style={{ color: 'var(--kurso-primary-light)' }} /><BookOpen className="w-5 h-5" style={{ color: 'var(--kurso-primary-light)' }} /></div>
            <p className="text-sm font-semibold text-white mb-1">Courses and workshops</p>
            <p className="text-3xl font-bold" style={{ color: 'var(--kurso-primary)' }}>{rates?.baseRatePercent ?? 5}%</p>
            <p className="text-sm mt-2" style={body}>of what students pay you, after coupons. It becomes {rates?.overflowRatePercent ?? 6.5}% beyond {rates?.thresholdStudents ?? 300} paid students. Courses and workshops are counted separately.</p>
          </div>
          <div className="rounded-2xl p-6 glass" style={card}>
            <div className="mb-3"><Book className="w-5 h-5" style={{ color: 'var(--kurso-primary-light)' }} /></div>
            <p className="text-sm font-semibold text-white mb-1">Ebooks</p>
            <p className="text-3xl font-bold" style={{ color: 'var(--kurso-primary)' }}>{rates?.ebookRatePercent ?? 4}%</p>
            <p className="text-sm mt-2" style={body}>in months you collect {inr(rates?.ebookMonthlyFloor ?? 500)} or more from ebooks. Below that, nothing.</p>
          </div>
          <div className="rounded-2xl p-6 glass" style={card}>
            <div className="mb-3"><MessageCircle className="w-5 h-5" style={{ color: 'var(--kurso-primary-light)' }} /></div>
            <p className="text-sm font-semibold text-white mb-1">WhatsApp messages</p>
            <p className="text-3xl font-bold" style={{ color: 'var(--kurso-primary)' }}>At cost</p>
            <p className="text-sm mt-2" style={body}>Meta charges for each WhatsApp message it delivers. We pass the same rate on, with no markup. This is separate from commission.</p>
          </div>
        </div>
        <div className="rounded-2xl p-5 mb-10 flex items-start gap-3" style={{ background: 'rgba(var(--kurso-primary-rgb), 0.08)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.25)' }}>
          <div className="flex gap-2 mt-0.5 flex-shrink-0"><Send className="w-4 h-4" style={{ color: 'var(--kurso-primary-lightest)' }} /><Mail className="w-4 h-4" style={{ color: 'var(--kurso-primary-lightest)' }} /></div>
          <p className="text-sm" style={body}><span className="text-white font-semibold">Telegram and email are always free.</span> Email is on by default for every course and workshop, so your students always get their confirmations and updates.</p>
        </div>

        {/* WhatsApp rate card */}
        <div className="rounded-2xl p-6 glass mb-10" style={card}>
          <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
            <div>
              <h2 className="text-lg font-bold text-white">WhatsApp message rates</h2>
              <p className="text-[14px] mt-1" style={hint}>Per delivered message, in rupees, before tax. These follow Meta&apos;s rates and can change when Meta changes them.</p>
            </div>
            {billing?.meta.pricingUrl && (
              <a href={billing.meta.pricingUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm font-medium" style={{ color: 'var(--kurso-primary-lightest)' }}>
                Meta&apos;s official price list <ExternalLink className="w-3.5 h-3.5" />
              </a>
            )}
          </div>
          <div className="flex flex-col">
            {(billing?.whatsappRates || []).map((r, i) => (
              <div key={r.category} className="flex items-center justify-between py-2.5 text-sm" style={{ borderTop: i === 0 ? 'none' : '1px solid rgba(255,255,255,0.08)' }}>
                <span className="text-white">{r.label}</span>
                <span style={body}>{inr(r.rate)} each</span>
              </div>
            ))}
          </div>
          <p className="text-[14px] mt-4" style={hint}>
            Pay for WhatsApp only on the messages Meta actually bills. Replies inside a chat the student started are often free or the cheapest. Charges under {inr(billing?.meta.minWhatsappInvoice ?? 50)} wait for the next month, unless you owe commission anyway.
          </p>
        </div>

        {/* This month */}
        <h2 className="text-xl font-bold text-white mb-4">This month so far</h2>
        <div className="rounded-2xl p-6 glass mb-10" style={card}>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-5">
            <div><p className="text-sm" style={hint}>Paid by your students</p><p className="text-2xl font-bold text-white">{inr(month?.collected ?? 0)}</p></div>
            <div><p className="text-sm" style={hint}>Commission so far</p><p className="text-2xl font-bold text-white">{inr(month?.commission ?? 0)}</p></div>
            <div><p className="text-sm" style={hint}>WhatsApp charges so far</p><p className="text-2xl font-bold text-white">{inr(month?.whatsappTotal ?? 0)}</p></div>
          </div>
          {(month?.whatsappLines.length ?? 0) > 0 ? (
            <div className="rounded-xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
              {month!.whatsappLines.map((l, i) => (
                <div key={l.category} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm" style={{ borderTop: i === 0 ? 'none' : '1px solid rgba(255,255,255,0.08)' }}>
                  <span style={body}>{l.label} <span style={hint}>· {l.count.toLocaleString('en-IN')} × {inr(l.rate)}</span></span>
                  <span className="text-white">{inr(l.amount)}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm" style={hint}>No WhatsApp messages have been counted yet this month.</p>
          )}
          <div className="flex items-center justify-between mt-5 pt-4" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
            <span className="text-sm font-semibold text-white">Estimated invoice</span>
            <span className="text-lg font-bold text-white">{inr(month?.estimatedTotal ?? 0)}</span>
          </div>
          <p className="text-[14px] mt-2 flex items-start gap-1.5" style={hint}><Info className="w-4 h-4 flex-shrink-0 mt-0.5" /> This is an estimate. Your real invoice is made after the month ends, and you have {rates?.graceDays ?? 14} days to pay it.</p>
        </div>

        {/* Invoices */}
        <h2 className="text-xl font-bold text-white mb-4">Your invoices</h2>
        {message && <p role={message.isError ? 'alert' : 'status'} className="mb-4 text-sm" style={{ color: message.isError ? '#f87171' : '#4ade80' }}>{message.text}</p>}
        {invoices.length === 0 ? (
          <div className="rounded-2xl p-8 text-center glass mb-10" style={card}><p className="text-sm" style={body}>No invoices yet. Your first one appears after the month ends.</p></div>
        ) : (
          <div className="flex flex-col gap-3 mb-10">{invoices.map(inv => renderInvoice(inv))}</div>
        )}

        {/* Own number */}
        <div className="rounded-2xl p-6 glass mb-10" style={card}>
          <p className="text-sm font-semibold text-white mb-1">Want to use your own WhatsApp number? <span className="text-[13px] font-semibold px-2 py-0.5 rounded-full ml-1" style={{ background: 'rgba(var(--kurso-primary-rgb), 0.15)', color: 'var(--kurso-primary-lightest)' }}>Coming soon</span></p>
          <p className="text-sm" style={body}>Soon you will be able to connect your own WhatsApp Business number. Meta then bills you directly for messages, so Kurso charges you only the commission, with no WhatsApp charges on your Kurso invoice.</p>
        </div>

        {/* FAQ */}
        <div className="rounded-2xl p-8 glass" style={card}>
          <h2 className="text-xl font-bold text-white mb-6">Questions</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            {FAQ.map((f, i) => (
              <div key={i}><p className="text-sm font-semibold text-white mb-1">{f.q}</p><p className="text-sm" style={body}>{f.a}</p></div>
            ))}
          </div>
          <div className="mt-6 pt-6 flex items-center justify-between flex-wrap gap-3" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
            <p className="text-sm" style={body}>Questions about billing?</p>
            <Link href="/contact" className="text-sm font-medium" style={{ color: 'var(--kurso-primary-lightest)' }}>Contact us →</Link>
          </div>
        </div>
      </div>

      <footer className="border-t px-6 py-8 mt-8" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
        <div className="max-w-4xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <Link href="/" className="flex items-center gap-2"><div className="w-6 h-6 violet-gradient rounded-md flex items-center justify-center"><Shield className="w-3 h-3 text-white" /></div><span className="text-sm font-medium text-white">Kurso</span></Link>
          <div className="flex gap-6 text-sm" style={hint}>
            <Link href="/terms" className="hover:text-white transition-colors">Terms</Link>
            <Link href="/privacy" className="hover:text-white transition-colors">Privacy</Link>
            <Link href="/contact" className="hover:text-white transition-colors">Contact</Link>
          </div>
        </div>
      </footer>
    </div>
  )
}