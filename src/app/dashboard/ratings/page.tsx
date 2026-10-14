'use client'
import { useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import AudienceSwitch, { useAudienceMode } from '@/components/AudienceSwitch'
import WorkshopReviewsView from '@/components/workshop-views/WorkshopReviewsView'
import { supabase } from '@/lib/supabase'
import { Star, Flag, MessageCircle, AlertTriangle } from 'lucide-react'

type Rating = {
  id: string
  course_id: string
  course_name: string
  enrollment_id: string
  student_name: string
  rating: number
  review_text: string | null
  creator_reply: string | null
  creator_reply_at: string | null
  flagged_for_review: boolean
  created_at: string
}

export default function RatingsPage() {
  const [audience, setAudience] = useAudienceMode()
  const [ratings, setRatings] = useState<Rating[]>([])
  const [loading, setLoading] = useState(true)
  const [token, setToken] = useState('')
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({})
  const [savingId, setSavingId] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => { init() }, [])

  async function init() {
    const { data: { session } } = await supabase.auth.getSession()
    if (session?.access_token) {
      setToken(session.access_token)
      await fetchRatings(session.access_token)
    }
    setLoading(false)
  }

  async function fetchRatings(authToken: string) {
    setError('')
    try {
      const res = await fetch('/api/creator/ratings', {
        headers: { Authorization: `Bearer ${authToken}` },
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Could not load ratings.')
        return
      }
      setRatings(data.ratings || [])
    } catch {
      setError('Could not load ratings.')
    }
  }

  async function submitReply(rating: Rating) {
    const replyText = (replyDrafts[rating.id] || '').trim()
    if (!replyText) return
    setSavingId(rating.id)
    try {
      const res = await fetch(`/api/creator/ratings/${rating.id}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ replyText }),
      })
      if (res.ok) {
        setRatings(prev => prev.map(r =>
          r.id === rating.id ? { ...r, creator_reply: replyText, creator_reply_at: new Date().toISOString() } : r
        ))
        setReplyDrafts(prev => { const n = { ...prev }; delete n[rating.id]; return n })
      }
    } finally {
      setSavingId(null)
    }
  }

  async function flagRating(rating: Rating) {
    if (rating.flagged_for_review) return
    if (!confirm('Flag this rating for Kurso to manually review? It will be hidden from your public average right away.')) return
    setSavingId(rating.id)
    try {
      const res = await fetch(`/api/creator/ratings/${rating.id}/flag`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) {
        setRatings(prev => prev.map(r => r.id === rating.id ? { ...r, flagged_for_review: true } : r))
      }
    } finally {
      setSavingId(null)
    }
  }

  return (
    <div className="min-h-screen flex" style={{ background: '#050505' }}>
      <Sidebar />
  <div className="flex-1 p-6 sm:p-10 max-w-3xl mx-auto w-full">
    <AudienceSwitch value={audience} onChange={setAudience} />
    {audience === 'workshops' ? (
      <WorkshopReviewsView />
    ) : (
      <>
    <div className="mb-8">
      <h1 className="text-2xl font-bold text-white mb-1">Ratings & Reviews</h1>```
          <p className="text-sm text-zinc-400">
            Students can rate a course once their certificate is issued. You can reply publicly or flag a rating for
            manual review — there's no delete option here; flagging hides a rating from your public average right
            away, and removal only happens if Kurso manually confirms it's fake or abusive.
          </p>
        </div>

        {loading ? (
          <div className="flex justify-center py-16">
            <div className="w-6 h-6 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : error ? (
          <p className="text-sm text-red-400">{error}</p>
        ) : ratings.length === 0 ? (
          <p className="text-sm text-zinc-500">No ratings yet.</p>
        ) : (
          <div className="flex flex-col gap-4">
            {ratings.map(r => (
              <div key={r.id} className="p-5 rounded-2xl"
                style={{
                  background: 'rgba(255,255,255,0.025)',
                  border: r.flagged_for_review ? '1px solid rgba(248,113,113,0.3)' : '1px solid rgba(255,255,255,0.08)',
                }}>
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div>
                    <p className="text-sm font-semibold text-white">{r.student_name}</p>
                    <p className="text-xs text-zinc-500">{r.course_name} · {new Date(r.created_at).toLocaleDateString()}</p>
                  </div>
                  <div className="flex items-center gap-0.5" style={{ color: 'var(--kurso-accent)' }}>
                    {[1, 2, 3, 4, 5].map(star => (
                      <Star key={star} className="w-3.5 h-3.5" fill={star <= r.rating ? 'currentColor' : 'none'} />
                    ))}
                  </div>
                </div>

                {r.flagged_for_review && (
                  <div className="flex items-center gap-1.5 text-xs mb-2" style={{ color: '#f87171' }}>
                    <AlertTriangle className="w-3.5 h-3.5" /> Flagged — pending Kurso's manual review, hidden from your public average.
                  </div>
                )}

                {r.review_text && (
                  <p className="text-sm text-zinc-300 mb-3">{r.review_text}</p>
                )}

                {r.creator_reply ? (
                  <div className="mt-2 p-3 rounded-xl" style={{ background: 'rgba(var(--kurso-primary-rgb), 0.06)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.2)' }}>
                    <p className="text-xs font-semibold mb-1" style={{ color: 'var(--kurso-primary-lighter)' }}>Your reply</p>
                    <p className="text-sm text-zinc-300">{r.creator_reply}</p>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2 mt-2">
                    <textarea
                      value={replyDrafts[r.id] || ''}
                      onChange={e => setReplyDrafts(prev => ({ ...prev, [r.id]: e.target.value }))}
                      placeholder="Reply publicly to this rating..."
                      rows={2}
                      className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white outline-none resize-none placeholder:text-zinc-600"
                    />
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => submitReply(r)}
                        disabled={!replyDrafts[r.id]?.trim() || savingId === r.id}
                        className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg disabled:opacity-40"
                        style={{ background: 'var(--kurso-primary)', color: '#fff' }}>
                        <MessageCircle className="w-3.5 h-3.5" /> Reply publicly
                      </button>
                      {!r.flagged_for_review && (
                        <button
                          onClick={() => flagRating(r)}
                          disabled={savingId === r.id}
                          className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg disabled:opacity-40"
                          style={{ background: 'none', border: '1px solid rgba(248,113,113,0.3)', color: '#f87171' }}>
                          <Flag className="w-3.5 h-3.5" /> Flag for review
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {r.creator_reply && !r.flagged_for_review && (
                  <button
                    onClick={() => flagRating(r)}
                    disabled={savingId === r.id}
                    className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg mt-3 disabled:opacity-40"
                    style={{ background: 'none', border: '1px solid rgba(248,113,113,0.3)', color: '#f87171' }}>
                    <Flag className="w-3.5 h-3.5" /> Flag for review
                  </button>
                )}
              </div>
            ))}
          </div>
)}
      </>
    )}
  </div>
</div>

) }