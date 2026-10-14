'use client'
// src/components/AudienceSwitch.tsx
//
// The "Courses | Workshops" switch shown at the top of the shared dashboard pages
// (Overview, Students, Revenue, Analytics, Broadcast).
//   - Courses is always the default.
//   - The choice is kept in the page address (?view=workshops), so a refresh or
//     a shared link opens the same view. Choosing Courses removes it again.

import { useCallback, useEffect, useState } from 'react'
import { BookOpen, Calendar } from 'lucide-react'

export type Audience = 'courses' | 'workshops'

export function useAudienceMode(): [Audience, (next: Audience) => void] {
  const [mode, setModeState] = useState<Audience>('courses')

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('view') === 'workshops') setModeState('workshops')
  }, [])

  const setMode = useCallback((next: Audience) => {
    setModeState(next)
    const url = new URL(window.location.href)
    if (next === 'workshops') url.searchParams.set('view', 'workshops')
    else url.searchParams.delete('view')
    window.history.replaceState(null, '', url.toString())
  }, [])

  return [mode, setMode]
}

const OPTIONS: { id: Audience; label: string; icon: typeof BookOpen }[] = [
  { id: 'courses', label: 'Courses', icon: BookOpen },
  { id: 'workshops', label: 'Workshops', icon: Calendar },
]

export default function AudienceSwitch({ value, onChange }: { value: Audience; onChange: (next: Audience) => void }) {
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      onChange(value === 'courses' ? 'workshops' : 'courses')
    }
  }

  return (
    <div className="mb-7">
      <div
        role="tablist"
        aria-label="Show courses or workshops"
        onKeyDown={onKeyDown}
        className="inline-flex p-1 rounded-2xl"
        style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)' }}
      >
        {OPTIONS.map(({ id, label, icon: Icon }) => {
          const on = value === id
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={on}
              tabIndex={on ? 0 : -1}
              onClick={() => onChange(id)}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60 hover:opacity-95"
              style={on
                ? { background: 'var(--kurso-primary)', color: '#fff', boxShadow: '0 4px 18px rgba(var(--kurso-primary-rgb), 0.35)' }
                : { background: 'transparent', color: 'var(--kurso-text-secondary)' }}
              onMouseEnter={e => { if (!on) e.currentTarget.style.background = 'rgba(255,255,255,0.08)' }}
              onMouseLeave={e => { if (!on) e.currentTarget.style.background = 'transparent' }}
            >
              <Icon className="w-4 h-4" />
              {label}
            </button>
          )
        })}
      </div>
      <p className="text-[13px] mt-2" style={{ color: 'var(--kurso-hint)' }}>
        {value === 'courses' ? 'Showing your courses. Switch to Workshops to see your live sessions.' : 'Showing your workshops. Switch to Courses to go back.'}
      </p>
    </div>
  )
}