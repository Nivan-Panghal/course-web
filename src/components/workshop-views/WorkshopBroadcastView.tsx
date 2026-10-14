'use client'
// Broadcast page, Workshops side: message the people registered for a workshop
// on Telegram and by email.
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Mail, Megaphone, Send, Users } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useWorkshopOverview } from '@/lib/useWorkshopOverview'
import { isConfirmed } from '@/lib/workshop-overview'
import { EmptyBox, ErrorBox, Loading, Panel, StatCard, WorkshopPicker, body, hint } from './ui'

const MAX_MESSAGE = 500

const TEMPLATES = [
  { label: 'Starting soon', text: 'Our workshop starts in 1 hour. Please be ready a few minutes early. The joining link is in your confirmation message.' },
  { label: 'Joining reminder', text: 'A quick reminder: our workshop is tomorrow. Keep your joining link handy and bring a pen and paper if you like taking notes.' },
  { label: 'Recording ready', text: 'Thank you for joining! The recording is ready. If you missed any part, you can watch it again.' },
  { label: 'Thank you', text: 'Thank you for being part of the workshop. It was great having you. Your certificate will reach you shortly.' },
]

export default function WorkshopBroadcastView() {
  const { data, loading, error, reload } = useWorkshopOverview()
  const [workshopId, setWorkshopId] = useState('')
  const [message, setMessage] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [sending, setSending] = useState(false)
  const [problem, setProblem] = useState('')
  const [result, setResult] = useState<{ total: number; telegram: number; email: number; failed: number; unreachable: number } | null>(null)

  // Start on the next workshop (or the latest one), so the creator rarely has to choose.
  useEffect(() => {
    if (!data || workshopId || data.workshops.length === 0) return
    const now = Date.now()
    const upcoming = data.workshops.filter(w => new Date(w.dateTime).getTime() > now && w.status !== 'cancelled')
      .sort((a, b) => new Date(a.dateTime).getTime() - new Date(b.dateTime).getTime())
    setWorkshopId((upcoming[0] ?? data.workshops[0]).id)
  }, [data, workshopId])

  const people = useMemo(
    () => (data?.registrations || []).filter(r => r.workshopId === workshopId && isConfirmed(r)),
    [data, workshopId],
  )
  const viaTelegram = people.filter(p => p.hasTelegram).length
  const viaEmail = people.filter(p => p.email).length
  const reachable = people.filter(p => p.hasTelegram || p.email).length
  const workshop = data?.workshops.find(w => w.id === workshopId)

  function change(next: string) { setWorkshopId(next); setConfirming(false); setResult(null); setProblem('') }

  async function send() {
    setSending(true)
    setProblem('')
    setResult(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) { setProblem('Please log in again.'); return }
      const res = await fetch('/api/workshops/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ workshopId, message }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) { setProblem(body.error || 'Could not send. Please try again.'); return }
      setResult(body)
      setMessage('')
    } catch {
      setProblem('Could not reach the server. Check your internet and try again.')
    } finally {
      setSending(false)
      setConfirming(false)
    }
  }

  if (loading) return <Loading />
  if (error) return <ErrorBox message={error} onRetry={reload} />
  if (!data || data.workshops.length === 0) {
    return (
      <EmptyBox icon={Megaphone} title="No workshops yet" text="Create a workshop first. Then you can message everyone who registered.">
        <Link href="/dashboard/workshops/create" className="px-4 py-2.5 rounded-xl text-sm font-semibold text-white violet-gradient">Create a workshop</Link>
      </EmptyBox>
    )
  }

  const canSend = !!message.trim() && reachable > 0 && !sending

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-white mb-1">Message workshop registrants</h1>
        <p className="text-sm" style={hint}>Send one message to everyone confirmed for a workshop. It goes out on Telegram and by email.</p>
      </div>

      <WorkshopPicker workshops={data.workshops} value={workshopId} onChange={change} label="Workshop to message" />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Confirmed" value={people.length} icon={Users} color="var(--kurso-primary-light)" />
        <StatCard label="On Telegram" value={viaTelegram} icon={Send} color="#60a5fa" />
        <StatCard label="Have an email" value={viaEmail} icon={Mail} color="#4ade80" />
        <StatCard label="Can be reached" value={reachable} icon={Megaphone} color="#fbbf24" note={people.length - reachable > 0 ? `${people.length - reachable} have neither` : 'Everyone'} />
      </div>

      <Panel title="Your message" description="Pick a starter or write your own. Add your joining link or other details yourself.">
        <div className="flex flex-wrap gap-2 mb-3" role="group" aria-label="Message starters">
          {TEMPLATES.map(t => (
            <button key={t.label} type="button" onClick={() => { setMessage(t.text); setConfirming(false) }}
              className="px-3.5 py-1.5 rounded-full text-[13px] font-medium transition-all hover:opacity-90"
              style={{ background: 'rgba(var(--kurso-primary-rgb), 0.12)', color: 'var(--kurso-primary-lightest)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.3)' }}>
              {t.label}
            </button>
          ))}
        </div>
        <textarea value={message} rows={5} maxLength={MAX_MESSAGE} aria-label="Message"
          onChange={e => { setMessage(e.target.value); setConfirming(false) }}
          placeholder="Write what you want your registrants to know…"
          className="w-full px-4 py-3 rounded-xl text-sm text-white outline-none resize-none placeholder:text-zinc-400"
          style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.14)' }}
          onFocus={e => (e.target.style.borderColor = 'var(--kurso-primary)')}
          onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.14)')} />
        <p className="text-[13px] mt-1.5 text-right tabular-nums" style={hint}>{message.length}/{MAX_MESSAGE}</p>

        {message.trim() && workshop && (
          <div className="mt-3 rounded-xl p-4" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}>
            <p className="text-[13px] mb-1.5" style={hint}>This is how it will look</p>
            <p className="text-sm text-white whitespace-pre-wrap break-words">📣 {workshop.title}{'\n\n'}{message.trim()}</p>
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          {!confirming ? (
            <button type="button" disabled={!canSend} onClick={() => setConfirming(true)}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white violet-gradient hover:opacity-90 disabled:opacity-40">
              <Send className="w-4 h-4" /> Send to {reachable} {reachable === 1 ? 'person' : 'people'}
            </button>
          ) : (
            <>
              <p className="text-sm" style={body}>Send this to {reachable} {reachable === 1 ? 'person' : 'people'} now? This cannot be undone.</p>
              <button type="button" disabled={sending} onClick={send}
                className="px-5 py-2.5 rounded-xl text-sm font-semibold text-white violet-gradient hover:opacity-90 disabled:opacity-50">
                {sending ? 'Sending…' : 'Yes, send'}
              </button>
              <button type="button" disabled={sending} onClick={() => setConfirming(false)}
                className="px-4 py-2.5 rounded-xl text-sm font-medium" style={{ background: 'rgba(255,255,255,0.08)', color: 'var(--kurso-text-secondary)' }}>
                Cancel
              </button>
            </>
          )}
          {reachable === 0 && <p className="text-[14px]" style={hint}>No confirmed person has Telegram or an email yet.</p>}
        </div>

        {problem && <p role="alert" className="text-sm mt-3" style={{ color: 'var(--kurso-danger)' }}>{problem}</p>}
        {result && (
          <p role="status" className="text-sm mt-3" style={{ color: 'var(--kurso-success)' }}>
            Sent to {result.total - result.failed} of {result.total} people ({result.telegram} on Telegram, {result.email} by email).
            {result.failed > 0 && <span style={{ color: 'var(--kurso-danger)' }}> {result.failed} could not be reached.</span>}
          </p>
        )}
      </Panel>
    </div>
  )
}