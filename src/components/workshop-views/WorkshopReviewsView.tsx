'use client'
// Ratings & Reviews page, Workshops side.
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { MessageSquare, Send, Star, Users } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { formatWorkshopDateTime } from '@/lib/workshops'
import { percent, type WorkshopRow } from '@/lib/workshop-overview'
import { EmptyBox, ErrorBox, Loading, Panel, StatCard, WorkshopPicker, body, cardStyle, hint } from './ui'

type Review = { id: string; workshopId: string; name: string; rating: number; comment: string; reply: string; createdAt: string }
type WorkshopInfo = { id: string; title: string; dateTime: string; started: boolean; confirmed: number; askable: number }
type Data = { workshops: WorkshopInfo[]; reviews: Review[] }

function Stars({ value, size = 16 }: { value: number; size?: number }) {
  return (
    <span className="inline-flex gap-0.5" role="img" aria-label={`${value} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map(n => (
        <Star key={n} style={{ width: size, height: size, color: n <= value ? '#fbbf24' : 'rgba(255,255,255,0.25)', fill: n <= value ? '#fbbf24' : 'transparent' }} />
      ))}
    </span>
  )
}

export default function WorkshopReviewsView() {
  const [data, setData] = useState<Data | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [setupNeeded, setSetupNeeded] = useState(false)
  const [filter, setFilter] = useState('')
  const [askId, setAskId] = useState('')
  const [asking, setAsking] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [askNote, setAskNote] = useState('')
  const [askProblem, setAskProblem] = useState('')
  const [replyDraft, setReplyDraft] = useState<Record<string, string>>({})
  const [replyOpen, setReplyOpen] = useState<string>('')
  const [replying, setReplying] = useState('')
  const [replyError, setReplyError] = useState<Record<string, string>>({})

  const authHeaders = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : null
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const headers = await authHeaders()
      if (!headers) { setError('Please log in again.'); return }
      const res = await fetch('/api/workshops/reviews', { headers })
      const body = await res.json().catch(() => ({}))
      if (res.status === 409) { setSetupNeeded(true); return }
      if (!res.ok) { setError(body.error || 'Could not load reviews.'); return }
      setData(body)
    } catch {
      setError('Could not reach the server. Check your internet and try again.')
    } finally {
      setLoading(false)
    }
  }, [authHeaders])

  useEffect(() => { load() }, [load])

  // Ask-for-reviews starts on the workshop with the most people still to ask.
  useEffect(() => {
    if (!data || askId || data.workshops.length === 0) return
    const best = [...data.workshops].sort((a, b) => b.askable - a.askable)[0]
    setAskId(best.id)
  }, [data, askId])

  const shown = useMemo(() => (data?.reviews || []).filter(r => !filter || r.workshopId === filter), [data, filter])
  const titleOf = (id: string) => data?.workshops.find(w => w.id === id)?.title ?? ''
  const pickerRows: WorkshopRow[] = (data?.workshops || []).map(w => ({ id: w.id, title: w.title, slug: '', status: '', dateTime: w.dateTime, price: 0, capacity: null, durationMinutes: null }))

  async function ask() {
    setAsking(true); setAskProblem(''); setAskNote('')
    try {
      const headers = await authHeaders()
      if (!headers) { setAskProblem('Please log in again.'); return }
      const res = await fetch('/api/workshops/reviews', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ action: 'request', workshopId: askId }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) { setAskProblem(body.error || 'Could not send. Please try again.'); return }
      setAskNote(`Asked ${body.total - body.failed} of ${body.total} people (${body.telegram} on Telegram, ${body.email} by email).${body.failed ? ` ${body.failed} could not be reached.` : ''}`)
      await load()
    } finally {
      setAsking(false); setConfirming(false)
    }
  }

  async function saveReply(review: Review) {
    setReplying(review.id)
    setReplyError(prev => ({ ...prev, [review.id]: '' }))
    try {
      const headers = await authHeaders()
      if (!headers) { setReplyError(prev => ({ ...prev, [review.id]: 'Please log in again.' })); return }
      const reply = (replyDraft[review.id] ?? review.reply).trim()
      const res = await fetch('/api/workshops/reviews', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ action: 'reply', reviewId: review.id, reply }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) { setReplyError(prev => ({ ...prev, [review.id]: body.error || 'Could not save your reply.' })); return }
      setData(d => d ? { ...d, reviews: d.reviews.map(r => (r.id === review.id ? { ...r, reply } : r)) } : d)
      setReplyOpen('')
    } finally {
      setReplying('')
    }
  }

  if (loading) return <Loading />
  if (setupNeeded) {
    return <EmptyBox icon={Star} title="One quick setup step" text="Workshop reviews need a small database update. Run the workshop reviews SQL in Supabase, then refresh this page." />
  }
  if (error) return <ErrorBox message={error} onRetry={load} />
  if (!data || data.workshops.length === 0) {
    return (
      <EmptyBox icon={Star} title="No workshops yet" text="After a workshop, you can ask your attendees to rate it here.">
        <Link href="/dashboard/workshops/create" className="px-4 py-2.5 rounded-xl text-sm font-semibold text-white violet-gradient">Create a workshop</Link>
      </EmptyBox>
    )
  }

  const all = data.reviews
  const average = all.length ? all.reduce((s, r) => s + r.rating, 0) / all.length : 0
  const askWorkshop = data.workshops.find(w => w.id === askId)
  const askable = askWorkshop?.askable ?? 0

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-white mb-1">Workshop reviews</h1>
        <p className="text-sm" style={hint}>Ask your attendees how it went, read what they say, and reply to them.</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Average rating" value={all.length ? average.toFixed(1) : '–'} icon={Star} color="#fbbf24" note={all.length ? 'Out of 5' : 'No reviews yet'} />
        <StatCard label="Reviews" value={all.length} icon={MessageSquare} color="var(--kurso-primary-light)" />
        <StatCard label="5-star reviews" value={`${percent(all.filter(r => r.rating === 5).length, all.length)}%`} icon={Star} color="#4ade80" />
        <StatCard label="Can still be asked" value={data.workshops.reduce((s, w) => s + w.askable, 0)} icon={Users} color="#60a5fa" note="Across all workshops" />
      </div>

      <Panel title="Ask for reviews" description="Sends a short “How was it?” message with a private rating link, on Telegram and by email. People who already reviewed, or were asked in the last 3 days, are skipped.">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 flex-wrap">
          <WorkshopPicker workshops={pickerRows} value={askId} onChange={id => { setAskId(id); setConfirming(false); setAskNote(''); setAskProblem('') }} label="Workshop to ask about" />
          {!confirming ? (
            <button type="button" disabled={asking || askable === 0 || !askWorkshop?.started} onClick={() => setConfirming(true)}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white violet-gradient hover:opacity-90 disabled:opacity-40">
              <Send className="w-4 h-4" /> Ask {askable} {askable === 1 ? 'person' : 'people'}
            </button>
          ) : (
            <>
              <p className="text-sm" style={body}>Send to {askable} {askable === 1 ? 'person' : 'people'} now?</p>
              <button type="button" disabled={asking} onClick={ask} className="px-5 py-2.5 rounded-xl text-sm font-semibold text-white violet-gradient disabled:opacity-50">{asking ? 'Sending…' : 'Yes, send'}</button>
              <button type="button" disabled={asking} onClick={() => setConfirming(false)} className="px-4 py-2.5 rounded-xl text-sm font-medium" style={{ background: 'rgba(255,255,255,0.08)', color: 'var(--kurso-text-secondary)' }}>Cancel</button>
            </>
          )}
        </div>
        {askWorkshop && !askWorkshop.started && <p className="text-[14px] mt-3" style={hint}>You can ask once this workshop has started.</p>}
        {askWorkshop?.started && askable === 0 && !askNote && <p className="text-[14px] mt-3" style={hint}>No one to ask right now for this workshop.</p>}
        {askProblem && <p role="alert" className="text-sm mt-3" style={{ color: 'var(--kurso-danger)' }}>{askProblem}</p>}
        {askNote && <p role="status" className="text-sm mt-3" style={{ color: 'var(--kurso-success)' }}>{askNote}</p>}
      </Panel>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-base font-semibold text-white">What attendees said</h2>
        <WorkshopPicker workshops={pickerRows} value={filter} onChange={setFilter} allLabel="All workshops" label="Filter reviews by workshop" />
      </div>

      {shown.length === 0 ? (
        <EmptyBox icon={MessageSquare} title="No reviews yet" text="Use “Ask for reviews” above. Reviews show up here as people send them." />
      ) : (
        <div className="flex flex-col gap-3">
          {shown.map(r => (
            <div key={r.id} className="rounded-2xl p-5 glass" style={cardStyle}>
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-white">{r.name}</p>
                  <p className="text-[13px]" style={hint}>
                    {!filter && `${titleOf(r.workshopId)} · `}{new Date(r.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                  </p>
                </div>
                <Stars value={r.rating} />
              </div>
              {r.comment && <p className="text-sm mt-3 whitespace-pre-wrap break-words" style={{ color: 'var(--kurso-text-secondary)' }}>{r.comment}</p>}

              {r.reply && replyOpen !== r.id && (
                <div className="mt-3 rounded-xl p-3" style={{ background: 'rgba(var(--kurso-primary-rgb), 0.1)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.25)' }}>
                  <p className="text-[13px] mb-1" style={hint}>Your reply</p>
                  <p className="text-sm text-white whitespace-pre-wrap break-words">{r.reply}</p>
                </div>
              )}

              {replyOpen === r.id ? (
                <div className="mt-3 flex flex-col gap-2">
                  <textarea rows={3} maxLength={500} value={replyDraft[r.id] ?? r.reply} aria-label={`Reply to ${r.name}`}
                    onChange={e => setReplyDraft(prev => ({ ...prev, [r.id]: e.target.value }))}
                    placeholder="Thank them or answer their feedback…"
                    className="w-full px-4 py-3 rounded-xl text-sm text-white outline-none resize-none placeholder:text-zinc-400"
                    style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.14)' }} />
                  <p className="text-[13px]" style={hint}>The student sees your reply when they open their review link again.</p>
                  {replyError[r.id] && <p role="alert" className="text-sm" style={{ color: 'var(--kurso-danger)' }}>{replyError[r.id]}</p>}
                  <div className="flex gap-2">
                    <button type="button" disabled={replying === r.id} onClick={() => saveReply(r)} className="px-4 py-2 rounded-xl text-[13px] font-semibold text-white violet-gradient disabled:opacity-50">{replying === r.id ? 'Saving…' : 'Save reply'}</button>
                    <button type="button" onClick={() => setReplyOpen('')} className="px-4 py-2 rounded-xl text-[13px] font-medium" style={{ background: 'rgba(255,255,255,0.08)', color: 'var(--kurso-text-secondary)' }}>Cancel</button>
                  </div>
                </div>
              ) : (
                <button type="button" onClick={() => setReplyOpen(r.id)} className="mt-3 px-3.5 py-2 rounded-xl text-[13px] font-medium"
                  style={{ background: 'rgba(255,255,255,0.08)', color: 'var(--kurso-text-secondary)' }}>
                  {r.reply ? 'Edit reply' : 'Reply'}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}