'use client'
// Small building blocks shared by the workshop views on the dashboard pages.
// Workshop-specific. Colours: hint = var(--kurso-hint), body = var(--kurso-text-secondary).
import { useEffect, useRef, useState } from 'react'
import { AlertCircle, ChevronDown, RefreshCw } from 'lucide-react'
import type { WorkshopRow } from '@/lib/workshop-overview'
import { formatWorkshopDateTime } from '@/lib/workshops'

export const hint = { color: 'var(--kurso-hint)' } as const
export const body = { color: 'var(--kurso-text-secondary)' } as const
export const cardStyle = { border: '1px solid rgba(255,255,255,0.08)' } as const

export function Loading() {
  return (
    <div className="flex items-center justify-center py-24" aria-live="polite">
      <div className="w-8 h-8 violet-gradient rounded-lg animate-pulse-glow" />
    </div>
  )
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="rounded-2xl p-5 flex items-start gap-3"
      style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)' }}>
      <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: 'var(--kurso-danger)' }} />
      <div className="min-w-0">
        <p className="text-sm font-semibold text-white">Something went wrong</p>
        <p className="text-[14px] mt-1" style={body}>{message}</p>
        <button type="button" onClick={onRetry}
          className="mt-3 inline-flex items-center gap-2 px-3 py-2 rounded-xl text-[13px] font-medium"
          style={{ background: 'rgba(255,255,255,0.08)', color: 'var(--kurso-text-secondary)' }}>
          <RefreshCw className="w-3.5 h-3.5" /> Try again
        </button>
      </div>
    </div>
  )
}

export function EmptyBox({ icon: Icon, title, text, children }: { icon: typeof AlertCircle; title: string; text: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-2xl p-10 md:p-14 text-center glass" style={cardStyle}>
      <div className="w-12 h-12 rounded-2xl flex items-center justify-center mx-auto mb-3"
        style={{ background: 'rgba(var(--kurso-primary-rgb), 0.1)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.2)' }}>
        <Icon className="w-6 h-6" style={{ color: 'var(--kurso-primary-light)' }} />
      </div>
      <p className="text-sm font-semibold text-white mb-1">{title}</p>
      <p className="text-[14px] max-w-md mx-auto" style={hint}>{text}</p>
      {children && <div className="mt-4 flex justify-center">{children}</div>}
    </div>
  )
}

export function StatCard({ label, value, note, icon: Icon, color }: { label: string; value: string | number; note?: string; icon: typeof AlertCircle; color: string }) {
  return (
    <div className="rounded-2xl p-5 glass" style={cardStyle}>
      <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-4" style={{ background: `${color}22` }}>
        <Icon className="w-5 h-5" style={{ color }} />
      </div>
      <p className="text-2xl font-bold text-white leading-tight">{value}</p>
      <p className="text-sm mt-1" style={body}>{label}</p>
      {note && <p className="text-[13px] mt-1" style={hint}>{note}</p>}
    </div>
  )
}

export function Panel({ title, description, action, children }: { title: string; description?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl p-5 md:p-6 glass" style={cardStyle}>
      <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-white">{title}</h2>
          {description && <p className="text-[13px] mt-1" style={hint}>{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

export function Chip({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'good' | 'warn' | 'neutral' | 'info' }) {
  const tones = {
    good: { background: 'rgba(74,222,128,0.12)', color: 'var(--kurso-success)' },
    warn: { background: 'rgba(245,158,11,0.14)', color: '#fbbf24' },
    info: { background: 'rgba(var(--kurso-primary-rgb), 0.15)', color: 'var(--kurso-primary-lightest)' },
    neutral: { background: 'rgba(255,255,255,0.08)', color: 'var(--kurso-text-secondary)' },
  } as const
  return <span className="text-[13px] font-medium px-2.5 py-0.5 rounded-full whitespace-nowrap" style={tones[tone]}>{children}</span>
}

/** Kurso dropdown (no native <select>). value '' means "all workshops" when allLabel is given. */
export function WorkshopPicker({ workshops, value, onChange, allLabel, label = 'Workshop' }: {
  workshops: WorkshopRow[]
  value: string
  onChange: (id: string) => void
  allLabel?: string
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc) }
  }, [])

  const current = workshops.find(w => w.id === value)
  const shown = current?.title ?? allLabel ?? 'Choose a workshop'
  const item = (id: string, text: string, sub?: string) => (
    <button key={id || 'all'} type="button" role="option" aria-selected={value === id}
      onClick={() => { onChange(id); setOpen(false) }}
      className="w-full px-4 py-3 text-left transition-colors"
      style={{ background: value === id ? 'rgba(var(--kurso-primary-rgb), 0.14)' : 'transparent' }}
      onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.07)' }}
      onMouseLeave={e => { e.currentTarget.style.background = value === id ? 'rgba(var(--kurso-primary-rgb), 0.14)' : 'transparent' }}>
      <span className="block text-sm text-white truncate">{text}</span>
      {sub && <span className="block text-[13px]" style={hint}>{sub}</span>}
    </button>
  )

  return (
    <div ref={ref} className="relative w-full sm:w-80">
      <button type="button" aria-haspopup="listbox" aria-expanded={open} aria-label={label}
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-3 px-4 py-2.5 rounded-xl text-sm text-left text-white transition-all cursor-pointer"
        style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.14)' }}>
        <span className="truncate">{shown}</span>
        <ChevronDown className="w-4 h-4 flex-shrink-0" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
      </button>
      {open && (
        <div role="listbox" className="absolute z-20 mt-1.5 w-full rounded-xl overflow-hidden max-h-72 overflow-y-auto"
          style={{ background: '#161616', border: '1px solid rgba(255,255,255,0.14)', boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}>
          {allLabel !== undefined && item('', allLabel)}
          {workshops.map(w => item(w.id, w.title, formatWorkshopDateTime(w.dateTime)))}
        </div>
      )}
    </div>
  )
}