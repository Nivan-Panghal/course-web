'use client'
// Analytics page, Workshops side: registration-to-certificate funnel.
// (Course analytics show lesson drop-off; workshops have no lessons, so this is the equivalent.)
import { useState } from 'react'
import Link from 'next/link'
import { Award, BarChart3, CheckCircle2, Share2, UserCheck, Users } from 'lucide-react'
import { useWorkshopOverview } from '@/lib/useWorkshopOverview'
import { percent, statsFor, type WorkshopStats } from '@/lib/workshop-overview'
import { formatWorkshopDateTime } from '@/lib/workshops'
import { EmptyBox, ErrorBox, Loading, Panel, StatCard, WorkshopPicker, body, hint } from './ui'

function sum(list: WorkshopStats[]): WorkshopStats {
  return list.reduce((a, s) => ({
    ...a,
    registered: a.registered + s.registered, confirmed: a.confirmed + s.confirmed, awaiting: a.awaiting + s.awaiting,
    awaitingValue: a.awaitingValue + s.awaitingValue, attended: a.attended + s.attended, certificates: a.certificates + s.certificates,
    referrals: a.referrals + s.referrals, revenue: a.revenue + s.revenue,
  }), { ...list[0], registered: 0, confirmed: 0, awaiting: 0, awaitingValue: 0, attended: 0, certificates: 0, referrals: 0, revenue: 0 })
}

export default function WorkshopAnalyticsView() {
  const { data, loading, error, reload } = useWorkshopOverview()
  const [workshopId, setWorkshopId] = useState('')

  if (loading) return <Loading />
  if (error) return <ErrorBox message={error} onRetry={reload} />
  if (!data || data.workshops.length === 0) {
    return (
      <EmptyBox icon={BarChart3} title="No workshops yet" text="Create a workshop to see how many people register, show up and get a certificate.">
        <Link href="/dashboard/workshops/create" className="px-4 py-2.5 rounded-xl text-sm font-semibold text-white violet-gradient">Create a workshop</Link>
      </EmptyBox>
    )
  }

  const all = data.workshops.map(w => statsFor(w, data.registrations))
  const shown = workshopId ? all.filter(s => s.workshop.id === workshopId) : all
  const t = sum(shown)

  const steps = [
    { label: 'Registered', value: t.registered, hintText: 'Everyone who signed up', color: 'var(--kurso-primary)' },
    { label: 'Confirmed', value: t.confirmed, hintText: 'Free, or payment confirmed', color: '#4ade80' },
    { label: 'Attended', value: t.attended, hintText: 'Marked as attended when you issue certificates', color: '#60a5fa' },
    { label: 'Got a certificate', value: t.certificates, hintText: 'Certificate made for them', color: '#fbbf24' },
  ]

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-white mb-1">Workshop analytics</h1>
        <p className="text-sm" style={hint}>See how many people register, pay, show up and get a certificate.</p>
      </div>

      <WorkshopPicker workshops={data.workshops} value={workshopId} onChange={setWorkshopId} allLabel="All workshops" />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Registered" value={t.registered} icon={Users} color="var(--kurso-primary-light)" />
        <StatCard label="Payment rate" value={`${percent(t.confirmed, t.registered)}%`} icon={CheckCircle2} color="#4ade80" note="Registered people who confirmed" />
        <StatCard label="Show-up rate" value={`${percent(t.attended, t.confirmed)}%`} icon={UserCheck} color="#60a5fa" note="Confirmed people marked as attended" />
        <StatCard label="From student referrals" value={t.referrals} icon={Share2} color="#fbbf24" />
      </div>

      <Panel title="From sign-up to certificate" description="Each bar is compared with the number of people who registered.">
        <div className="flex flex-col gap-4">
          {steps.map(s => (
            <div key={s.label}>
              <div className="flex items-baseline justify-between gap-3 mb-1.5">
                <p className="text-sm font-medium text-white">{s.label} <span className="text-[13px] font-normal" style={hint}>· {s.hintText}</span></p>
                <p className="text-sm text-white font-semibold">{s.value} <span className="text-[13px] font-normal" style={body}>({percent(s.value, t.registered)}%)</span></p>
              </div>
              <div className="h-3 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.08)' }}>
                <div className="h-full rounded-full" style={{ width: `${percent(s.value, t.registered)}%`, background: s.color, minWidth: s.value > 0 ? 6 : 0 }} />
              </div>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="Each workshop">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[640px]">
            <thead>
              <tr className="text-left text-[13px]" style={hint}>
                <th className="pb-2 font-medium">Workshop</th><th className="pb-2 font-medium">Registered</th><th className="pb-2 font-medium">Confirmed</th>
                <th className="pb-2 font-medium">Attended</th><th className="pb-2 font-medium">Seats left</th><th className="pb-2 font-medium text-right">Certificates</th>
              </tr>
            </thead>
            <tbody>
              {all.map(s => (
                <tr key={s.workshop.id} style={{ borderTop: '1px solid rgba(255,255,255,0.07)' }}>
                  <td className="py-3 pr-3">
                    <p className="text-white truncate max-w-[260px]">{s.workshop.title}</p>
                    <p className="text-[13px]" style={hint}>{formatWorkshopDateTime(s.workshop.dateTime)}</p>
                  </td>
                  <td className="py-3 pr-3" style={body}>{s.registered}</td>
                  <td className="py-3 pr-3" style={body}>{s.confirmed}</td>
                  <td className="py-3 pr-3" style={body}>{s.attended}</td>
                  <td className="py-3 pr-3" style={body}>{s.seatsLeft ?? 'No limit'}</td>
                  <td className="py-3 text-right">
                    <Link href={`/dashboard/workshops/${s.workshop.id}/certificates`} className="inline-flex items-center gap-1.5 text-[13px] font-medium" style={{ color: 'var(--kurso-primary-lightest)' }}>
                      <Award className="w-3.5 h-3.5" /> {s.certificates} sent
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  )
}