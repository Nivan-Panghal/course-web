'use client'
// Public page a workshop attendee opens from their "How was it?" message.
// No login: the private link (token) identifies the registration.
import { use, useEffect, useState } from 'react'
import { CheckCircle2, Star } from 'lucide-react'

type Info = {
  workshopTitle: string
  hostName: string
  firstName: string
  canReview: boolean
  reason: string | null
  review: { rating: number; comment: string; reply: string } | null
}

const LABELS = ['', 'Not good', 'Could be better', 'Good', 'Very good', 'Excellent']
const MAX_COMMENT = 1000

export default function WorkshopReviewPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params)
  const [info, setInfo] = useState<Info | null>(null)
  const [loadError, setLoadError] = useState('')
  const [rating, setRating] = useState(0)
  const [hover, setHover] = useState(0)
  const [comment, setComment] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/workshops/review?token=${encodeURIComponent(token)}`)
        const data = await res.json().catch(() => ({}))
        if (cancelled) return
        if (!res.ok) { setLoadError(data.error || 'This review link is not valid.'); return }
        setInfo(data)
        if (data.review) { setRating(data.review.rating); setComment(data.review.comment) }
      } catch {
        if (!cancelled) setLoadError('Could not load this page. Check your internet and try again.')
      }
    })()
    return () => { cancelled = true }
  }, [token])

  async function submit() {
    if (!rating) { setError('Please tap the stars to rate the workshop.'); return }
    setSaving(true)
    setError('')
    try {
      const res = await fetch('/api/workshops/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, rating, comment }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.error || 'Could not save your review. Please try again.'); return }
      setDone(true)
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

  if (loadError) return shell(<p role="alert" className="text-sm text-center" style={{ color: 'var(--kurso-text-secondary)' }}>{loadError}</p>)
  if (!info) return shell(<p className="text-sm text-center" style={{ color: 'var(--kurso-hint)' }}>Loading…</p>)

  if (done) {
    return shell(
      <div className="text-center">
        <CheckCircle2 className="w-12 h-12 mx-auto mb-3" style={{ color: 'var(--kurso-success)' }} />
        <h1 className="text-xl font-bold text-white mb-2">Thank you{info.firstName ? `, ${info.firstName}` : ''}!</h1>
        <p className="text-sm" style={{ color: 'var(--kurso-text-secondary)' }}>
          Your review helps {info.hostName || 'the host'} improve future workshops. You can open this link again to change it.
        </p>
      </div>
    )
  }

  if (!info.canReview) {
    return shell(
      <div className="text-center">
        <h1 className="text-lg font-bold text-white mb-2">{info.workshopTitle}</h1>
        <p className="text-sm" style={{ color: 'var(--kurso-text-secondary)' }}>{info.reason}</p>
      </div>
    )
  }

  const shown = hover || rating
  return shell(
    <>
      <p className="text-[13px] mb-1" style={{ color: 'var(--kurso-hint)' }}>{info.hostName}</p>
      <h1 className="text-xl font-bold text-white mb-1">How was “{info.workshopTitle}”?</h1>
      <p className="text-sm mb-5" style={{ color: 'var(--kurso-text-secondary)' }}>
        {info.review ? 'You already reviewed this. You can change it below.' : `Hi${info.firstName ? ` ${info.firstName}` : ''}, it takes about 20 seconds.`}
      </p>

      <div className="flex items-center justify-center gap-1.5 mb-1" role="radiogroup" aria-label="Rating">
        {[1, 2, 3, 4, 5].map(n => (
          <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={`${n} star${n === 1 ? '' : 's'}`}
            onClick={() => setRating(n)} onMouseEnter={() => setHover(n)} onMouseLeave={() => setHover(0)}
            className="p-1 transition-transform hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60 rounded-lg">
            <Star className="w-10 h-10" style={{ color: n <= shown ? '#fbbf24' : 'rgba(255,255,255,0.25)', fill: n <= shown ? '#fbbf24' : 'transparent' }} />
          </button>
        ))}
      </div>
      <p className="text-sm text-center h-5 mb-4" style={{ color: 'var(--kurso-primary-lightest)' }}>{LABELS[shown]}</p>

      <label htmlFor="review-comment" className="text-sm font-medium text-white block mb-1.5">
        Anything you want to add? <span className="font-normal" style={{ color: 'var(--kurso-hint)' }}>(optional)</span>
      </label>
      <textarea id="review-comment" rows={4} value={comment} maxLength={MAX_COMMENT} onChange={e => setComment(e.target.value)}
        placeholder="What did you like, or what could be better?"
        className="w-full px-4 py-3 rounded-xl text-sm text-white outline-none resize-none placeholder:text-zinc-400"
        style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.14)' }}
        onFocus={e => (e.target.style.borderColor = 'var(--kurso-primary)')}
        onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.14)')} />

      {info.review?.reply && (
        <div className="mt-4 rounded-xl p-3" style={{ background: 'rgba(var(--kurso-primary-rgb), 0.1)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.25)' }}>
          <p className="text-[13px] mb-1" style={{ color: 'var(--kurso-hint)' }}>Reply from {info.hostName || 'the host'}</p>
          <p className="text-sm text-white whitespace-pre-wrap">{info.review.reply}</p>
        </div>
      )}

      {error && <p role="alert" className="text-sm mt-3" style={{ color: 'var(--kurso-danger)' }}>{error}</p>}

      <button type="button" onClick={submit} disabled={saving}
        className="w-full mt-5 py-3 rounded-xl text-sm font-semibold text-white violet-gradient hover:opacity-90 disabled:opacity-50">
        {saving ? 'Saving…' : info.review ? 'Update my review' : 'Submit review'}
      </button>
    </>,
  )
}