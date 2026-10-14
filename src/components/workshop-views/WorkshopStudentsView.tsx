'use client'
// Students page, Workshops side: everyone who registered for a workshop.
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Award, CheckCircle2, Clock3, Download, Search, Send, Users } from 'lucide-react'
import { useWorkshopOverview } from '@/lib/useWorkshopOverview'
import { csvCell, inr, isAwaiting, isConfirmed, type RegistrationRow } from '@/lib/workshop-overview'
import { formatWorkshopDateTime } from '@/lib/workshops'
import { Chip, EmptyBox, ErrorBox, Loading, StatCard, WorkshopPicker, body, cardStyle, hint } from './ui'

type StatusFilter = 'all' | 'confirmed' | 'awaiting'
const FILTERS: { id: StatusFilter; label: string }[] = [
  { id: 'all', label: 'Everyone' },
  { id: 'confirmed', label: 'Confirmed' },
  { id: 'awaiting', label: 'Waiting for payment check' },
]

export default function WorkshopStudentsView() {
  const { data, loading, error, reload } = useWorkshopOverview()
  const [workshopId, setWorkshopId] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [search, setSearch] = useState('')

  const byId = useMemo(() => new Map((data?.workshops || []).map(w => [w.id, w])), [data])

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (data?.registrations || []).filter(r => {
      if (workshopId && r.workshopId !== workshopId) return false
      if (status === 'confirmed' && !isConfirmed(r)) return false
      if (status === 'awaiting' && !isAwaiting(r)) return false
      if (!q) return true
      return r.name.toLowerCase().includes(q) || r.phone.includes(q) || (r.email || '').toLowerCase().includes(q)
    })
  }, [data, workshopId, status, search])

  if (loading) return <Loading />
  if (error) return <ErrorBox message={error} onRetry={reload} />
  if (!data || data.workshops.length === 0) {
    return (
      <EmptyBox icon={Users} title="No workshops yet" text="Create a workshop and the people who register will show up here.">
        <Link href="/dashboard/workshops/create" className="px-4 py-2.5 rounded-xl text-sm font-semibold text-white violet-gradient">Create a workshop</Link>
      </EmptyBox>
    )
  }

  const scope = data.registrations.filter(r => !workshopId || r.workshopId === workshopId)
  const confirmed = scope.filter(isConfirmed)

  function exportCsv() {
    const header = ['Name', 'Phone', 'Email', 'Workshop', 'Workshop date', 'Payment', 'Amount counted (INR)', 'Attended', 'Certificate sent', 'On Telegram', 'Registered on']
    const lines = rows.map((r: RegistrationRow) => {
      const w = byId.get(r.workshopId)
      return [
        r.name, r.phone, r.email || '', w?.title || '', w ? formatWorkshopDateTime(w.dateTime) : '',
        isConfirmed(r) ? 'Confirmed' : isAwaiting(r) ? 'Waiting for payment check' : r.paymentStatus,
        r.counted, r.attended ? 'Yes' : 'No', r.certificateSent ? 'Yes' : 'No', r.hasTelegram ? 'Yes' : 'No',
        new Date(r.createdAt).toLocaleDateString('en-IN'),
      ].map(csvCell).join(',')
    })
    const blob = new Blob([[header.map(csvCell).join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `workshop-students-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-white mb-1">Workshop students</h1>
        <p className="text-sm" style={hint}>Everyone who registered for your workshops, with payment, Telegram and certificate status.</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Registered" value={scope.length} icon={Users} color="var(--kurso-primary-light)" />
        <StatCard label="Confirmed" value={confirmed.length} icon={CheckCircle2} color="#4ade80" />
        <StatCard label="Waiting for payment check" value={scope.filter(isAwaiting).length} icon={Clock3} color="#fbbf24" note="Mark them paid on the Workshops page" />
        <StatCard label="Certificates sent" value={confirmed.filter(r => r.certificateSent).length} icon={Award} color="#60a5fa" />
      </div>

      <div className="flex flex-col lg:flex-row lg:items-center gap-3 flex-wrap">
        <WorkshopPicker workshops={data.workshops} value={workshopId} onChange={setWorkshopId} allLabel="All workshops" />
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={hint} />
          <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by name, phone or email"
            aria-label="Search students"
            className="w-full pl-10 pr-4 py-2.5 rounded-xl text-sm text-white outline-none placeholder:text-zinc-400"
            style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.14)' }}
            onFocus={e => (e.target.style.borderColor = 'var(--kurso-primary)')}
            onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.14)')} />
        </div>
        <button type="button" onClick={exportCsv} disabled={rows.length === 0}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40"
          style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.14)', color: 'var(--kurso-text-secondary)' }}>
          <Download className="w-4 h-4" /> Export ({rows.length})
        </button>
        {workshopId && (
          <Link href={`/dashboard/workshops/${workshopId}/certificates`}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold"
            style={{ background: 'rgba(var(--kurso-primary-rgb), 0.15)', color: 'var(--kurso-primary-lightest)' }}>
            <Award className="w-4 h-4" /> Send certificates
          </Link>
        )}
      </div>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by payment">
        {FILTERS.map(f => (
          <button key={f.id} type="button" aria-pressed={status === f.id} onClick={() => setStatus(f.id)}
            className="px-3.5 py-1.5 rounded-full text-[13px] font-medium transition-all"
            style={status === f.id
              ? { background: 'rgba(var(--kurso-primary-rgb), 0.2)', color: 'var(--kurso-primary-lightest)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.45)' }
              : { background: 'rgba(255,255,255,0.05)', color: 'var(--kurso-text-secondary)', border: '1px solid rgba(255,255,255,0.12)' }}>
            {f.label}
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <EmptyBox icon={Search} title="No one matches" text="Try another workshop, filter or search." />
      ) : (
        <div className="rounded-2xl overflow-hidden glass" style={cardStyle}>
          {rows.map((r, i) => {
            const w = byId.get(r.workshopId)
            return (
              <div key={r.id} className="flex items-center justify-between gap-3 flex-wrap px-5 py-4"
                style={{ borderTop: i === 0 ? 'none' : '1px solid rgba(255,255,255,0.07)' }}>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-white truncate">{r.name}</p>
                  <p className="text-[13px] truncate" style={hint}>{r.phone}{r.email ? ` · ${r.email}` : ''}</p>
                  {!workshopId && w && <p className="text-[13px] truncate" style={body}>{w.title} · {formatWorkshopDateTime(w.dateTime)}</p>}
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  {isConfirmed(r) ? <Chip tone="good">Confirmed{r.counted > 0 ? ` · ${inr(r.counted)}` : ''}</Chip>
                    : isAwaiting(r) ? <Chip tone="warn">Waiting for payment check</Chip>
                      : <Chip>Payment not finished</Chip>}
                  {r.hasTelegram ? <Chip tone="info"><Send className="w-3 h-3 inline -mt-0.5" /> Telegram</Chip> : r.email ? <Chip>Email only</Chip> : <Chip tone="warn">No contact</Chip>}
                  {r.certificateSent ? <Chip tone="good">Certificate sent</Chip> : r.certificateMade ? <Chip>Certificate made</Chip> : null}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}