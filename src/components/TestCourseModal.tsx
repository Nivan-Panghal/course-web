'use client'
/**
 * src/components/TestCourseModal.tsx
 * ─────────────────────────────────────────────────────────────────
 * Lets a creator try real WhatsApp/Telegram delivery on their OWN
 * course before paying — no auth/OTP step (they're already logged in
 * as the creator), no payment step, just a name/phone form that
 * reuses whatever test-student identity they've already set up on any
 * other course (one identity, shared across all their courses).
 *
 * Bot tokens are generated through the exact same endpoints a real
 * paid enrollment uses (/api/telegram/create-token,
 * /api/whatsapp/create-token) so what the creator sees here is a true
 * preview of what a real student on their current delivery-method
 * setting would experience — never a separate simplified simulation.
 * ─────────────────────────────────────────────────────────────────
 */
import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, Send, MessageCircle, FlaskConical } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useWhatsAppNumber } from '@/lib/use-whatsapp-number'

export default function TestCourseModal({
  courseId,
  creatorId,
  telegramBotUsername,
  courseUrl,
  onClose,
}: {
  courseId: string
  creatorId: string
  telegramBotUsername?: string | null
  courseUrl: string
  onClose: () => void
}) {
  const waNumber = useWhatsAppNumber(courseId) // the creator's own number if they connected one
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [telegramUsername, setTelegramUsername] = useState('')
  const [loadingExisting, setLoadingExisting] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ telegramToken?: string; whatsappToken?: string; courseDelivery: string } | null>(null)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    async function loadExisting() {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) { setLoadingExisting(false); return }
      const res = await fetch('/api/creator/test-enroll', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (res.ok) {
        const d = await res.json()
        if (d.testStudent) {
          setName(d.testStudent.name || '')
          setPhone(d.testStudent.phone || '')
          setTelegramUsername(d.testStudent.telegram_username || '')
        }
      }
      setLoadingExisting(false)
    }
    loadExisting()
  }, [])

  useEffect(() => {
    setMounted(true)
  }, [])

  const telegramUsernameForLink = (telegramBotUsername || process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME || '').replace('@', '')

  async function handleSubmit() {
    if (!phone && !telegramUsername) {
      setError('Enter at least a phone number or Telegram username.')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) throw new Error('Please log in again.')

      const res = await fetch('/api/creator/test-enroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ courseId, name, phone, telegramUsername }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not start test mode.')

      const courseDelivery = data.courseDelivery || 'both'

      // Test mode deliberately offers every connected channel, even if this
      // course currently delivers through only one of them.
      

      const wantsTelegram = Boolean(telegramUsernameForLink)
      const wantsWhatsApp = Boolean(waNumber)

      const out: { telegramToken?: string; whatsappToken?: string; courseDelivery: string } = { courseDelivery }

      if (wantsTelegram) {
        const r = await fetch('/api/telegram/create-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            studentId: data.studentId,
            studentPhone: phone,
            studentName: name,
            creatorId,
            courseId,
            paymentId: `TEST:${creatorId}:${courseId}`,
          }),
        }).then(r => r.json())
        if (r.token) {
          out.telegramToken = r.token
          await fetch('/api/telegram/save-enrollment-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enrollmentId: data.enrollmentId, token: r.token, expiresAt: r.expiresAt }),
          }).catch(() => { })
        }
      }

      if (wantsWhatsApp) {
        const r = await fetch('/api/whatsapp/create-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            studentId: data.studentId,
            studentPhone: phone,
            studentName: name,
            creatorId,
            courseId,
            paymentId: `TEST:${creatorId}:${courseId}`,
          }),
        }).then(r => r.json())
        if (r.token) {
          out.whatsappToken = r.token
          await fetch('/api/whatsapp/save-enrollment-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enrollmentId: data.enrollmentId, token: r.token, expiresAt: r.expiresAt }),
          }).catch(() => { })
        }
      }

      setResult(out)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  if (!mounted) return null

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-3 sm:p-4"
      style={{ background: 'rgba(0,0,0,0.72)', backdropFilter: 'blur(6px)' }}
    >
      <div
        className="w-full max-w-md max-h-[calc(100dvh-1.5rem)] overflow-y-auto overscroll-contain rounded-2xl p-5 sm:p-6"
        style={{ background: '#0a0a0a', border: '1px solid rgba(255,255,255,0.1)' }}
      >
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <FlaskConical className="w-5 h-5" style={{ color: 'var(--kurso-accent)' }} />
            <h2 className="font-semibold text-white">Test This Course</h2>
          </div>
          <button onClick={onClose}><X className="w-5 h-5" style={{ color: '#71717a' }} /></button>
        </div>
        <p className="text-xs mb-5" style={{ color: '#a1a1aa' }}>
          You'll receive real WhatsApp/Telegram messages on this number, exactly like a real student would — but this is your own test identity, not a paying student. It's reused across every course you test, so update the details below anytime.
        </p>

        {!result ? (
          <>
            {loadingExisting ? (
              <p className="text-xs" style={{ color: '#52525b' }}>Loading…</p>
            ) : (
              <div className="flex flex-col gap-3">
                <input placeholder="Your name" value={name} onChange={e => setName(e.target.value)}
                  className="w-full px-3 py-2.5 rounded-xl text-sm text-white" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }} />
                <input placeholder="Phone number (for WhatsApp)" value={phone} onChange={e => setPhone(e.target.value)}
                  className="w-full px-3 py-2.5 rounded-xl text-sm text-white" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }} />
                <input placeholder="Telegram username (optional)" value={telegramUsername} onChange={e => setTelegramUsername(e.target.value)}
                  className="w-full px-3 py-2.5 rounded-xl text-sm text-white" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }} />
                {error && <p className="text-xs" style={{ color: '#f87171' }}>{error}</p>}
                <button onClick={handleSubmit} disabled={submitting}
                  className="w-full py-3 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
                  style={{ background: 'linear-gradient(135deg, var(--kurso-primary), var(--kurso-primary-light))' }}>
                  {submitting ? 'Starting test…' : 'Save & Start Testing'}
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-col gap-4">
            <p
              className="text-xs px-3 py-2.5 rounded-lg leading-5"
              style={{
                background: 'rgba(var(--kurso-primary-rgb), 0.10)',
                color: 'var(--kurso-primary-lightest)',
                border: '1px solid rgba(var(--kurso-primary-rgb), 0.25)',
              }}
            >
              🧪 Test mode is ready. Open each available delivery method below to test the almost same experience your students receive.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {result.whatsappToken ? (
                <a
                  href={`https://wa.me/${waNumber}?text=${encodeURIComponent(`/start ${result.whatsappToken}`)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="min-h-11 flex items-center justify-center gap-2 px-3 py-3 rounded-xl text-sm font-semibold text-white text-center"
                  style={{ background: '#25D366' }}
                >
                  <MessageCircle className="w-4 h-4 flex-shrink-0" />
                  WhatsApp
                </a>
              ) : (
                <div
                  className="min-h-11 flex items-center justify-center gap-2 px-3 py-3 rounded-xl text-sm font-semibold text-center"
                  style={{
                    background: 'rgba(255,255,255,0.05)',
                    color: '#71717a',
                    border: '1px solid rgba(255,255,255,0.08)',
                  }}
                >
                  <MessageCircle className="w-4 h-4 flex-shrink-0" />
                  WhatsApp unavailable
                </div>
              )}

              {result.telegramToken && telegramUsernameForLink ? (
                <a
                  href={`https://t.me/${telegramUsernameForLink.replace('@', '')}?start=${result.telegramToken}`}
                  target="_blank"
                  rel="noreferrer"
                  className="min-h-11 flex items-center justify-center gap-2 px-3 py-3 rounded-xl text-sm font-semibold text-white text-center"
                  style={{ background: '#229ED9' }}
                >
                  <Send className="w-4 h-4 flex-shrink-0" />
                  Telegram
                </a>
              ) : (
                <div
                  className="min-h-11 flex items-center justify-center gap-2 px-3 py-3 rounded-xl text-sm font-semibold text-center"
                  style={{
                    background: 'rgba(255,255,255,0.05)',
                    color: '#71717a',
                    border: '1px solid rgba(255,255,255,0.08)',
                  }}
                >
                  <Send className="w-4 h-4 flex-shrink-0" />
                  Telegram unavailable
                </div>
              )}

              <a
                href={courseUrl}
                className="min-h-11 flex items-center justify-center gap-2 px-3 py-3 rounded-xl text-sm font-semibold text-black text-center transition-opacity hover:opacity-90"
                style={{ background: 'var(--kurso-primary)' }}
              >
                <FlaskConical className="w-4 h-4 flex-shrink-0" />
                Test on Web
              </a>
            </div>

            {!result.telegramToken && !result.whatsappToken && (
              <p className="text-xs text-center leading-5" style={{ color: '#a1a1aa' }}>
                Messaging is not connected for this course yet. Web test access is ready.
              </p>
            )}

            <button
              onClick={onClose}
              className="w-full py-2.5 rounded-xl text-sm font-medium"
              style={{
                background: 'rgba(255,255,255,0.05)',
                color: '#a1a1aa',
                border: '1px solid rgba(255,255,255,0.1)',
              }}
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}
