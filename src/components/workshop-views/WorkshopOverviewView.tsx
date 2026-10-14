'use client'
// Overview page, Workshops side: what is coming up and what needs you.
import Link from 'next/link'
import { Calendar, Clock3, IndianRupee, Plus, Users } from 'lucide-react'
import { useWorkshopOverview } from '@/lib/useWorkshopOverview'
import { inr, isAwaiting, isConfirmed, statsFor } from '@/lib/workshop-overview'
import { formatWorkshopDateTime } from '@/lib/workshops'
import { Chip, EmptyBox, ErrorBox, Loading, Panel, StatCard, body, hint } from './ui'

export default function WorkshopOverviewView() {
  const { data, loading, error, reload } = useWorkshopOverview()

  if (loading) return <Loading />
  if (error) return <ErrorBox message={error} onRetry={reload} />
  if (!data || data.workshops.length === 0) {
    return (
      <EmptyBox icon={Calendar} title="No workshops yet" text="Run a live session, take registrations, and send certificates afterwards. Start with your first workshop.">
        <Link href="/dashboard/workshops/create" className="px-4 py-2.5 rounded-xl text-sm font-semibold text-white violet-gradient">Create a workshop</Link>
      </EmptyBox>
    )
  }

  const now = Date.now()
  const upcoming = data.workshops
    .filter(w => w.status !== 'cancelled' && w.status !== 'completed' && new Date(w.dateTime).getTime() > now)
    .sort((a, b) => new Date(a.dateTime).getTime() - new Date(b.dateTime).getTime())
  const next = upcoming[0]
  const nextStats = next ? statsFor(next, data.registrations) : null
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000
  const lastWeek = data.registrations.filter(r => new Date(r.createdAt).getTime() >= weekAgo).length
  const collected = data.registrations.filter(isConfirmed).reduce((s, r) => s + r.counted, 0)
  const awaiting = data.registrations.filter(isAwaiting)
  const titleOf = (id: string) => data.workshops.find(w => w.id === id)?.title ?? ''

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white mb-1">Your workshops</h1>
          <p className="text-sm" style={hint}>What is coming up and what needs your attention.</p>
        </div>
        <Link href="/dashboard/workshops/create" className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium text-white violet-gradient hover:opacity-90">
          <Plus className="w-4 h-4" /> New workshop
        </Link>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Upcoming workshops" value={upcoming.length} icon={Calendar} color="var(--kurso-primary-light)" />
        <StatCard label="Registrations this week" value={lastWeek} icon={Users} color="#60a5fa" note="In the last 7 days" />
        <StatCard label="Total collected" value={inr(collected)} icon={IndianRupee} color="#4ade80" />
        <StatCard label="Waiting for your confirmation" value={awaiting.length} icon={Clock3} color="#fbbf24" note="UPI payments to mark paid" />
      </div>

      {next && nextStats && (
        <Panel title="Next workshop" action={<Chip tone="info">{formatWorkshopDateTime(next.dateTime)} IST</Chip>}>
          <p className="text-lg font-semibold text-white">{next.title}</p>
          <p className="text-sm mt-1" style={body}>
            {nextStats.confirmed} confirmed{nextStats.awaiting ? ` · ${nextStats.awaiting} waiting for payment check` : ''}
            {nextStats.seatsLeft != null ? ` · ${nextStats.seatsLeft} seats left` : ''}
          </p>
          <div className="flex flex-wrap gap-2 mt-4">
            <Link href="/dashboard/workshops" className="px-3.5 py-2 rounded-xl text-[13px] font-medium" style={{ background: 'rgba(255,255,255,0.08)', color: 'var(--kurso-text-secondary)' }}>Registrations</Link>
            <Link href={`/dashboard/workshops/${next.id}`} className="px-3.5 py-2 rounded-xl text-[13px] font-medium" style={{ background: 'rgba(255,255,255,0.08)', color: 'var(--kurso-text-secondary)' }}>Edit page</Link>
            <Link href="/dashboard/broadcast?view=workshops" className="px-3.5 py-2 rounded-xl text-[13px] font-medium" style={{ background: 'rgba(var(--kurso-primary-rgb), 0.15)', color: 'var(--kurso-primary-lightest)' }}>Message registrants</Link>
          </div>
        </Panel>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Panel title="Coming up" description={upcoming.length ? undefined : 'No upcoming workshops.'}>
          <div className="flex flex-col gap-2">
            {upcoming.slice(0, 5).map(w => (
              <Link key={w.id} href={`/dashboard/workshops/${w.id}`} className="flex items-center justify-between gap-3 p-3 rounded-xl hover:opacity-90" style={{ background: 'rgba(255,255,255,0.05)' }}>
                <span className="min-w-0">
                  <span className="block text-sm text-white truncate">{w.title}</span>
                  <span className="block text-[13px]" style={hint}>{formatWorkshopDateTime(w.dateTime)}</span>
                </span>
                <span className="text-[13px]" style={body}>{w.price > 0 ? inr(w.price) : 'Free'}</span>
              </Link>
            ))}
          </div>
        </Panel>

        <Panel title="Latest registrations">
          {data.registrations.length === 0 ? (
            <p className="text-sm" style={hint}>No registrations yet.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {data.registrations.slice(0, 6).map(r => (
                <div key={r.id} className="flex items-center justify-between gap-3 p-3 rounded-xl" style={{ background: 'rgba(255,255,255,0.05)' }}>
                  <span className="min-w-0">
                    <span className="block text-sm text-white truncate">{r.name}</span>
                    <span className="block text-[13px] truncate" style={hint}>{titleOf(r.workshopId)}</span>
                  </span>
                  {isConfirmed(r) ? <Chip tone="good">Confirmed</Chip> : isAwaiting(r) ? <Chip tone="warn">Check payment</Chip> : <Chip>Not paid</Chip>}
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  )
}