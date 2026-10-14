// src/components/WorkshopRegisterForm.tsx
'use client'
import { useEffect, useState } from 'react'
import { loadCashfreeSdk, loadRazorpaySdk, pollOrderStatus } from '@/lib/checkout-client'
import { trackMetaLead } from '@/components/MetaPixel'

interface Props {
  workshopId: string
  workshopTitle: string
  price: number
  isFull: boolean
  upiId: string | null
  upiDisplayName: string
  gatewayEnabled: boolean
  telegramBotUsername: string | null
}

type Step = 'form' | 'pay' | 'checking' | 'success' | 'pending'
type PayMethod = 'gateway' | 'upi_manual'

// Colors come from CSS variables the public workshop page sets from the creator's
// theme (--ws-*), so this form reads correctly on dark AND light themes. The
// fallbacks are the original dark-page values, used if the form is ever rendered
// without that wrapper. Helper text is never dimmer than --ws-muted.
const inputStyle = {
  background: 'var(--ws-field-bg, rgba(255,255,255,0.05))',
  border: '1px solid var(--ws-field-border, rgba(255,255,255,0.1))',
  color: 'var(--ws-text, #ffffff)',
}
const NOTICE_STYLE = { background: 'var(--ws-field-bg, rgba(255,255,255,0.05))', color: 'var(--ws-secondary, #d4d4d8)' }
const SECONDARY_BTN_STYLE = { background: 'var(--ws-field-bg, rgba(255,255,255,0.06))', color: 'var(--ws-text, #e4e4e7)', border: '1px solid var(--ws-field-border, rgba(255,255,255,0.1))' }
const SUCCESS_STYLE = { background: 'var(--ws-success-bg, rgba(74,222,128,0.1))', color: 'var(--ws-success, #4ade80)', border: '1px solid var(--ws-success-border, rgba(74,222,128,0.2))' }
const TEXT = { color: 'var(--ws-text, #ffffff)' }
const SECONDARY = { color: 'var(--ws-secondary, #d4d4d8)' }
const MUTED = { color: 'var(--ws-muted, #a1a1aa)' }
const DANGER = { color: 'var(--ws-danger, #ef4444)' }

export default function WorkshopRegisterForm({
  workshopId, workshopTitle, price, isFull, upiId, upiDisplayName, gatewayEnabled, telegramBotUsername,
}: Props) {
  const [step, setStep] = useState<Step>('form')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [utr, setUtr] = useState('')
  const [method, setMethod] = useState<PayMethod>(gatewayEnabled ? 'gateway' : 'upi_manual')
  const [registrationId, setRegistrationId] = useState('')
  const [telegramToken, setTelegramToken] = useState('')
  const [refCode, setRefCode] = useState('')
  const [txnId, setTxnId] = useState('')
  const [referralLink, setReferralLink] = useState('')
  const [linkCopied, setLinkCopied] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // Coupon (online payment only)
  const [couponInput, setCouponInput] = useState('')
  const [couponOpen, setCouponOpen] = useState(false)
  const [couponChecking, setCouponChecking] = useState(false)
  const [couponError, setCouponError] = useState('')
  const [coupon, setCoupon] = useState<{ code: string; percent: number; discountAmount: number; finalAmount: number } | null>(null)

  const isFree = price <= 0
  const hasUpi = !!upiId
  const noPaymentAvailable = !isFree && !gatewayEnabled && !hasUpi

  async function applyCoupon() {
    const code = couponInput.trim()
    if (!code) { setCouponError('Enter your coupon code.'); return }
    setCouponChecking(true)
    setCouponError('')
    try {
      const res = await fetch('/api/workshops/coupon/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workshopId, code }),
      })
      const data = await res.json()
      if (!res.ok || !data.valid) { setCouponError(data.reason || 'This coupon does not work.'); return }
      setCoupon({ code: data.code, percent: data.percent, discountAmount: data.discountAmount, finalAmount: data.finalAmount })
    } catch {
      setCouponError('Could not check the coupon. Please try again.')
    } finally {
      setCouponChecking(false)
    }
  }

  function removeCoupon() {
    setCoupon(null)
    setCouponInput('')
    setCouponError('')
    setCouponOpen(false)
  }

  // Handles the redirect-back from Cashfree / Stripe hosted checkout.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const tg = params.get('tg')
    if (tg) setTelegramToken(tg)
    const ref = params.get('ref')
    if (ref) setRefCode(ref)
    if (params.get('status') === 'cancelled') {
      setError('Payment was cancelled. You can try again below.')
      return
    }
    const orderId = params.get('order_id')
    if (!orderId) return
    setTxnId(orderId)
    setStep('checking')
    pollOrderStatus(orderId).then((result) => {
      if (result === 'success') {
        setStep('success')
      } else {
        setStep('form')
        setError('We could not confirm your payment yet. If money was deducted, your spot is confirmed automatically within a few minutes and you will get a WhatsApp message.')
      }
    })
  }, [])

  async function registerDirect(paymentMode: 'free' | 'upi_manual', fullPhone: string) {
    const res = await fetch('/api/workshops/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workshopId, name, email: email || null, phone: fullPhone, paymentMode, ref: refCode || null }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Registration failed')

    setRegistrationId(data.registrationId)
    if (data.telegramToken) setTelegramToken(data.telegramToken)
    if (data.metaLeadEventId) trackMetaLead(data.metaLeadEventId, workshopTitle)
    setStep(data.paymentStatus === 'confirmed' ? 'success' : 'pay')
  }

  async function startGatewayPayment(fullPhone: string) {
    const res = await fetch('/api/workshops/checkout/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workshopId, name, email, phone: fullPhone, ref: refCode || null, couponCode: coupon?.code || null }),
    })
    const data = await res.json()
    if (!res.ok || data.error) throw new Error(data.error || 'Could not start the payment')

    if (data.telegramToken) setTelegramToken(data.telegramToken)
    if (data.registrationId) setRegistrationId(data.registrationId)
    if (data.metaLeadEventId) trackMetaLead(data.metaLeadEventId, workshopTitle)
    if (data.alreadyRegistered) { setStep('success'); return }

    const { clientTxnId, order } = data
    setTxnId(clientTxnId)

    if (order.provider === 'cashfree') {
      const cashfree = await loadCashfreeSdk(order.mode)
      // Redirects away; confirmation happens in the redirect-back effect above.
      await cashfree.checkout({ paymentSessionId: order.paymentSessionId, redirectTarget: '_self' })
      return
    }

    if (order.provider === 'razorpay') {
      await loadRazorpaySdk()
      const rzp = new (window as any).Razorpay({
        key: order.keyId,
        amount: order.amountPaise,
        currency: order.currency,
        order_id: order.orderId,
        name: workshopTitle,
        prefill: { name, email, contact: fullPhone },
        handler: async () => {
          setStep('checking')
          const status = await pollOrderStatus(clientTxnId)
          setStep(status === 'success' ? 'success' : 'pending')
        },
        modal: { ondismiss: () => setLoading(false) },
      })
      rzp.open()
      return
    }

    if (order.provider === 'stripe') {
      window.location.href = order.checkoutUrl
      return
    }

    throw new Error('Unsupported payment method.')
  }

  // Once the registrant is confirmed, fetch their personal referral link.
  useEffect(() => {
    if (step !== 'success' || referralLink) return
    const qs = registrationId
      ? `registrationId=${encodeURIComponent(registrationId)}`
      : txnId ? `orderId=${encodeURIComponent(txnId)}` : ''
    if (!qs) return
    let cancelled = false
    fetch(`/api/workshops/referral-link?${qs}`)
      .then(res => res.json())
      .then(data => { if (!cancelled && data?.link) setReferralLink(data.link) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [step, registrationId, txnId, referralLink])

  async function copyReferralLink() {
    try {
      await navigator.clipboard.writeText(referralLink)
      setLinkCopied(true)
      setTimeout(() => setLinkCopied(false), 2000)
    } catch {
      // Clipboard blocked — the link is still visible on screen to copy by hand.
    }
  }

  // FormEvent is deprecated in @types/react 19.2+
  async function handleSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault()
    setError('')
    const cleanedPhone = phone.trim().replace(/\D/g, '')
    if (cleanedPhone.length !== 10) {
      setError('Please enter a valid 10-digit WhatsApp number')
      return
    }
    const mode: 'free' | 'upi_manual' | 'gateway' = isFree ? 'free' : method
    if (mode === 'gateway' && !email.trim()) {
      setError('Email is required for online payment')
      return
    }
    setLoading(true)
    try {
      const fullPhone = '91' + cleanedPhone
      if (mode === 'gateway') await startGatewayPayment(fullPhone)
      else await registerDirect(mode, fullPhone)
    } catch (err: any) {
      setError(err.message || 'Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  async function handleUtrSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!utr.trim()) { setError('Please enter your UPI transaction reference (UTR)'); return }
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/api/workshops/register', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ registrationId, utrReference: utr.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not save your reference')
      setStep('pending')
    } catch (err: any) {
      setError(err.message || 'Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const telegramCta = telegramBotUsername && telegramToken ? (
    <a
      href={`https://t.me/${telegramBotUsername.replace('@', '')}?start=ws_${telegramToken}`}
      target="_blank" rel="noopener noreferrer"
      className="block w-full text-center mt-3 py-3 rounded-xl text-sm font-semibold"
      style={SECONDARY_BTN_STYLE}
    >
      Get updates on Telegram too
    </a>
  ) : null

  if (isFull && step === 'form') {
    return (
      <div className="p-4 rounded-xl text-sm text-center" style={NOTICE_STYLE}>
        This workshop is fully booked.
      </div>
    )
  }

  if (noPaymentAvailable && step === 'form') {
    return (
      <div className="p-4 rounded-xl text-sm text-center" style={NOTICE_STYLE}>
        The creator hasn't set up payments for this workshop yet. Please contact them directly.
      </div>
    )
  }

  if (step === 'checking') {
    return (
      <div className="p-4 rounded-xl text-sm text-center" style={NOTICE_STYLE}>
        Confirming your payment…
      </div>
    )
  }

  if (step === 'success') {
    return (
      <div>
        <div className="p-4 rounded-xl text-sm text-center" style={SUCCESS_STYLE}>
          You're registered! We've sent the Zoom link to your WhatsApp.
        </div>
        {telegramCta}
        {referralLink && (
          <div className="mt-4 p-4 rounded-xl" style={{ background: 'var(--ws-field-bg, rgba(255,255,255,0.04))', border: '1px solid var(--ws-field-border, rgba(255,255,255,0.08))' }}>
            <p className="text-sm font-semibold mb-1" style={TEXT}>Know someone who'd love this?</p>
            <p className="text-[13px] mb-3" style={MUTED}>Share your personal link — friends who join through it are credited to you.</p>
            <p className="text-[13px] break-all mb-3 px-3 py-2 rounded-lg" style={NOTICE_STYLE}>{referralLink}</p>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={copyReferralLink}
                className="py-2.5 rounded-xl text-[13px] font-semibold"
                style={SECONDARY_BTN_STYLE}>
                {linkCopied ? 'Copied ✓' : 'Copy link'}
              </button>
              <a href={`https://wa.me/?text=${encodeURIComponent(`Join me at ${workshopTitle}: ${referralLink}`)}`}
                target="_blank" rel="noopener noreferrer"
                className="py-2.5 rounded-xl text-[13px] font-semibold text-center text-white violet-gradient hover:opacity-90">
                Share on WhatsApp
              </a>
            </div>
          </div>
        )}
      </div>
    )
  }

  if (step === 'pending') {
    return (
      <div>
        <div className="p-4 rounded-xl text-sm text-center" style={NOTICE_STYLE}>
          Got it — we'll confirm your spot on WhatsApp once your payment is verified.
        </div>
        {telegramCta}
      </div>
    )
  }

  if (step === 'pay') {
    const upiLink = upiId
      ? `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(upiDisplayName)}&am=${price}&cu=INR`
      : ''
    return (
      <form onSubmit={handleUtrSubmit} className="space-y-4">
        <div className="p-4 rounded-xl text-sm" style={{ background: 'rgba(var(--kurso-primary-rgb), 0.08)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.15)' }}>
          <p className="font-semibold mb-1" style={TEXT}>Pay ₹{price.toLocaleString()} via UPI</p>
          {upiId ? (
            <>
              <p className="text-[13px] mb-3" style={MUTED}>
                UPI ID: <span style={TEXT}>{upiId}</span> ({upiDisplayName})
              </p>
              <a href={upiLink} className="block w-full text-center py-3 rounded-xl text-sm font-semibold text-white violet-gradient hover:opacity-90">
                Pay with UPI app
              </a>
            </>
          ) : (
            <p className="text-[13px]" style={DANGER}>
              This creator hasn't set up UPI payments yet. Please contact them directly.
            </p>
          )}
        </div>
        <div>
          <label className="block text-[13px] mb-1.5" style={SECONDARY}>
            After paying, enter your UPI transaction reference (UTR)
          </label>
          <input
            value={utr} onChange={e => setUtr(e.target.value)}
            placeholder="12-digit UTR / reference number"
            className="ws-field w-full px-4 py-3 rounded-xl text-sm outline-none"
            style={inputStyle}
          />
        </div>
        {error && <p className="text-[13px]" role="alert" style={DANGER}>{error}</p>}
        <button type="submit" disabled={loading}
          className="w-full py-3.5 rounded-xl font-semibold text-white violet-gradient hover:opacity-90 disabled:opacity-50">
          {loading ? 'Saving…' : 'Submit reference'}
        </button>
      </form>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <input
        value={name} onChange={e => setName(e.target.value)} required
        placeholder="Full name"
        className="ws-field w-full px-4 py-3 rounded-xl text-sm outline-none" style={inputStyle}
      />
      <input
        value={email} onChange={e => setEmail(e.target.value)} type="email"
        placeholder={!isFree && method === 'gateway' ? 'Email (required for online payment)' : 'Email (optional)'}
        className="ws-field w-full px-4 py-3 rounded-xl text-sm outline-none" style={inputStyle}
      />
      <div className="flex rounded-xl overflow-hidden" style={{ border: '1px solid var(--ws-field-border, rgba(255,255,255,0.1))' }}>
        <span className="flex items-center px-3 text-sm font-semibold" style={NOTICE_STYLE}>+91</span>
        <input
          value={phone} onChange={e => setPhone(e.target.value)} required
          placeholder="WhatsApp number" inputMode="numeric" maxLength={10}
          className="ws-field flex-1 px-4 py-3 text-sm outline-none"
          style={{ background: 'var(--ws-field-bg, rgba(255,255,255,0.05))', ...TEXT }}
        />
      </div>

      <p className="text-[13px] -mt-2" style={MUTED}>
        We'll message this number on WhatsApp about your registration{!isFree ? ', including payment reminders' : ''}.
      </p>

      {!isFree && gatewayEnabled && hasUpi && (
        <div className="grid grid-cols-2 gap-2">
          {([
            ['gateway', 'Pay online', 'UPI, cards, netbanking'],
            ['upi_manual', 'Pay via UPI', 'Enter UTR after paying'],
          ] as const).map(([value, label, hint]) => (
            <button
              key={value} type="button" onClick={() => setMethod(value)}
              className="p-3 rounded-xl text-left"
              style={{
                background: method === value ? 'rgba(var(--kurso-primary-rgb), 0.12)' : 'var(--ws-field-bg, rgba(255,255,255,0.04))',
                border: method === value ? '1px solid rgba(var(--kurso-primary-rgb), 0.4)' : '1px solid var(--ws-field-border, rgba(255,255,255,0.08))',
              }}
            >
              <p className="text-sm font-semibold" style={TEXT}>{label}</p>
              <p className="text-[13px]" style={MUTED}>{hint}</p>
            </button>
          ))}
        </div>
      )}

  {!isFree && gatewayEnabled && method === 'gateway' && (
    <div>
      {coupon ? (
        <div className="flex items-center justify-between gap-3 p-3 rounded-xl" style={{ background: 'rgba(var(--kurso-primary-rgb), 0.1)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.3)' }}>
          <div>
            <p className="text-sm font-semibold" style={TEXT}>{coupon.code} applied · {coupon.percent}% off</p>
            <p className="text-[13px]" style={MUTED}>You save ₹{coupon.discountAmount.toLocaleString('en-IN')}. You pay ₹{coupon.finalAmount.toLocaleString('en-IN')}.</p>
          </div>
          <button type="button" onClick={removeCoupon} className="text-[13px] underline shrink-0" style={SECONDARY}>Remove</button>
        </div>
      ) : couponOpen ? (
        <div>
          <div className="flex gap-2">
            <input
              value={couponInput} onChange={e => setCouponInput(e.target.value.toUpperCase())}
              placeholder="Coupon code" aria-label="Coupon code" maxLength={20}
              className="ws-field flex-1 min-w-0 px-4 py-3 rounded-xl text-sm outline-none" style={inputStyle}
            />
            <button type="button" onClick={applyCoupon} disabled={couponChecking}
              className="px-4 rounded-xl text-sm font-semibold text-white violet-gradient hover:opacity-90 disabled:opacity-50">
              {couponChecking ? 'Checking…' : 'Apply'}
            </button>
          </div>
          {couponError && <p className="text-[13px] mt-1.5" role="alert" style={DANGER}>{couponError}</p>}
        </div>
      ) : (
        <button type="button" onClick={() => setCouponOpen(true)} className="text-[13px] underline" style={SECONDARY}>Have a coupon code?</button>
      )}
    </div>
  )}
  {!isFree && gatewayEnabled && hasUpi && method === 'upi_manual' && (
    <p className="text-[13px]" style={MUTED}>Coupons work with online payment only.</p>
  )}

  {error && <p className="text-[13px]" role="alert" style={DANGER}>{error}</p>}
  <button type="submit" disabled={loading}
    className="w-full py-3.5 rounded-xl font-semibold text-white violet-gradient hover:opacity-90 disabled:opacity-50">
    {loading
      ? 'Please wait…'
          : isFree
            ? 'Register for free'
        : `Continue to pay ₹${(method === 'gateway' && coupon ? coupon.finalAmount : price).toLocaleString()}`}
      </button>
    </form>
  )
}