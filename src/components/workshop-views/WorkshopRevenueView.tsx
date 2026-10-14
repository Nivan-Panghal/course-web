'use client'
// Revenue page, Workshops side. Money rule lives in lib/workshop-overview.ts.
import Link from 'next/link'
import { Clock3, IndianRupee, TrendingDown, TrendingUp, Users, Calendar } from 'lucide-react'
import { useWorkshopOverview } from '@/lib/useWorkshopOverview'
import { inr, isAwaiting, isConfirmed, monthlyRevenue, statsFor } from '@/lib/workshop-overview'
import { formatWorkshopDateTime } from '@/lib/workshops'
import { Chip, EmptyBox, ErrorBox, Loading, Panel, StatCard, body, cardStyle, hint } from './ui'

export default function WorkshopRevenueView() {
  const { data, loading, error, reload } = useWorkshopOverview()

  if (loading) return <Loading />
  if (error) return <ErrorBox message={error} onRetry={reload} />
  if (!data || data.workshops.length === 0) {
    return (
      <EmptyBox icon={IndianRupee} title="No workshop income yet" text="Once people register and pay for a workshop, your income shows up here.">
        <Link href="/dashboard/workshops/create" className="px-4 py-2.5 rounded-xl text-sm font-semibold text-white violet-gradient">Create a workshop</Link>
      </EmptyBox>
    )
  }

  const { workshops, registrations } = data
  const confirmed = registrations.filter(isConfirmed)
  const total = confirmed.reduce((s, r) => s + r.counted, 0)
  const months = monthlyRevenue(registrations, 6)
  const thisMonth = months[months.length - 1]?.value ?? 0
  const lastMonth = months[months.length - 2]?.value ?? 0
  const change = lastMonth > 0 ? Math.round(((thisMonth - lastMonth) / lastMonth) * 100) : null
  const awaiting = registrations.filter(isAwaiting)
  const awaitingValue = awaiting.reduce((s, r) => s + (workshops.find(w => w.id === r.workshopId)?.price ?? 0), 0)
  const maxMonth = Math.max(1, ...months.map(m => m.value))
  const perWorkshop = workshops.map(w => statsFor(w, registrations))
  const paid = confirmed.filter(r => r.counted > 0)
  const recent = paid.slice(0, 20)
  const titleOf = (id: string) => workshops.find(w => w.id === id)?.title ?? ''

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-white mb-1">Workshop revenue</h1>
        <p className="text-sm" style={hint}>
          Online payments use the amount paid. Payments you marked as paid by hand count at the workshop price.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <StatCard label="Total collected" value={inr(total)} icon={IndianRupee} color="#4ade80" />
        <StatCard label="This month" value={inr(thisMonth)} icon={change !== null && change < 0 ? TrendingDown : TrendingUp} color="var(--kurso-primary-light)"
          note={change === null ? 'No sales last month to compare' : `${change >= 0 ? '+' : ''}${change}% vs last month`} />
        <StatCard label="Waiting for your confirmation" value={inr(awaitingValue)} icon={Clock3} color="#fbbf24"
          note={`${awaiting.length} UPI payment${awaiting.length === 1 ? '' : 's'}. Mark them paid on the Workshops page.`} />
        <StatCard label="Paid registrations" value={paid.length} icon={Users} color="#60a5fa" note={`${confirmed.length - paid.length} free`} />
      </div>

      <Panel title="Last 6 months" description="By the day people registered.">
        <div className="flex items-end gap-3 h-44" role="img" aria-label="Workshop revenue for the last 6 months">
          {months.map(m => (
            <div key={m.label} className="flex-1 flex flex-col items-center justify-end h-full min-w-0">
              <span className="text-[13px] mb-1" style={body}>{m.value > 0 ? inr(m.value) : ''}</span>
              <div className="w-full rounded-t-lg" style={{ height: `${Math.max(m.value > 0 ? 6 : 2, Math.round((m.value / maxMonth) * 100))}%`, background: m.value > 0 ? 'var(--kurso-primary)' : 'rgba(255,255,255,0.12)' }} />
              <span className="text-[13px] mt-2" style={hint}>{m.label}</span>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="By workshop">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[560px]">
            <thead>
              <tr className="text-left text-[13px]" style={hint}>
                <th className="pb-2 font-medium">Workshop</th><th className="pb-2 font-medium">Confirmed</th>
                <th className="pb-2 font-medium">Waiting</th><th className="pb-2 font-medium text-right">Collected</th>
              </tr>
            </thead>
            <tbody>
              {perWorkshop.map(s => (
                <tr key={s.workshop.id} style={{ borderTop: '1px solid rgba(255,255,255,0.07)' }}>
                  <td className="py-3 pr-3">
                    <p className="text-white truncate max-w-[280px]">{s.workshop.title}</p>
                    <p className="text-[13px]" style={hint}>{formatWorkshopDateTime(s.workshop.dateTime)} · {s.workshop.price > 0 ? inr(s.workshop.price) : 'Free'}</p>
                  </td>
                  <td className="py-3 pr-3" style={body}>{s.confirmed}</td>
                  <td className="py-3 pr-3" style={body}>{s.awaiting > 0 ? `${s.awaiting} · ${inr(s.awaitingValue)}` : '0'}</td>
                  <td className="py-3 text-right font-semibold text-white">{inr(s.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Recent payments" description="Your 20 latest paid registrations.">
        {recent.length === 0 ? (
          <p className="text-sm" style={hint}>No paid registrations yet.</p>
        ) : (
          <div className="rounded-xl overflow-hidden" style={cardStyle}>
            {recent.map((r, i) => (
              <div key={r.id} className="flex items-center justify-between gap-3 flex-wrap px-4 py-3" style={{ borderTop: i === 0 ? 'none' : '1px solid rgba(255,255,255,0.07)' }}>
                <div className="min-w-0">
                  <p className="text-sm text-white truncate">{r.name}</p>
                  <p className="text-[13px] truncate" style={hint}>{titleOf(r.workshopId)} · {new Date(r.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Chip>{r.paymentMode === 'gateway' ? 'Paid online' : 'UPI, marked paid'}</Chip>
                  <span className="text-sm font-semibold text-white">{inr(r.counted)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  )
}