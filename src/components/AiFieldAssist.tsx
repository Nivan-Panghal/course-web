'use client'
/**
 * AiFieldAssist — per-field inline AI writing button.
 *
 * Drop this next to any textarea/input that needs AI help.
 * The generated text goes straight into the field via `onResult`.
 * Nothing is saved until the creator clicks Save on their form.
 *
 * Usage:
 *   <AiFieldAssist
 *     field="description"
 *     entityType="workshop"          // "workshop" | "course"
 *     context={{ title, tagline }}   // other filled fields on the page
 *     currentValue={description}     // the current textarea value
 *     onResult={v => setDescription(v)}
 *   />
 *
 * Inline states the creator sees clearly:
 *   idle        → small "✦ AI" button
 *   generating  → "Generating…" spinner, field stays readable/editable
 *   done        → "Regenerate" + reprompt input; previous text stays until
 *                 new result arrives, then swaps atomically
 *   error       → inline error, button restored
 */

import { useState } from 'react'
import { Sparkles, RefreshCw, X } from 'lucide-react'
import { supabase } from '@/lib/supabase'

export type AiFieldAssistProps = {
  /** The DB/API field name — must match FIELD_INSTRUCTIONS in the route */
  field: string
  /** Describes the page context so the model can produce relevant text */
  entityType: 'workshop' | 'course'
  /** All currently-filled text fields on this page (context for the model) */
  context: Record<string, unknown>
  /** The current value of the target field (used to detect empty / non-empty) */
  currentValue: string | string[]
  /** Called with the new text / array when AI returns — replaces field atomically */
  onResult: (value: unknown) => void
  /** Optional label shown on the idle button; defaults to "✦ AI" */
  label?: string
  /** Extra classes on the wrapper */
  className?: string
}

type State = 'idle' | 'generating' | 'done' | 'error'

export default function AiFieldAssist({
  field,
  entityType,
  context,
  currentValue,
  onResult,
  label,
  className = '',
}: AiFieldAssistProps) {
  const [state, setState] = useState<State>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [remaining, setRemaining] = useState<number | null>(null)
  const [reprompt, setReprompt] = useState('')
  const [showReprompt, setShowReprompt] = useState(false)

  const isAtCap = remaining !== null && remaining <= 0

  async function runGenerate(repromptText?: string) {
    setState('generating')
    setErrorMsg('')
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        setErrorMsg('Your session expired. Please refresh and try again.')
        setState('error')
        return
      }

      const res = await fetch('/api/creator/ai-assist', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          field,
          entityType,
          context,
          ...(repromptText ? { reprompt: repromptText } : {}),
        }),
      })

      const data = await res.json().catch(() => ({}))

      if (!res.ok) {
        setErrorMsg(data.error || 'Something went wrong. Please try again.')
        setState('error')
        return
      }

      if (typeof data.remaining === 'number') setRemaining(data.remaining)

      onResult(data.result)
      setState('done')
      setReprompt('')
      setShowReprompt(false)
    } catch {
      setErrorMsg('Could not reach the AI assistant. Check your connection and try again.')
      setState('error')
    }
  }

  // ── Idle ──────────────────────────────────────────────────────────────────
  if (state === 'idle' || state === 'error') {
    return (
      <div className={`flex flex-col gap-1 ${className}`}>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={isAtCap}
            onClick={() => runGenerate()}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12px] font-semibold transition-all hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
              background: 'rgba(var(--kurso-primary-rgb), 0.12)',
              color: 'var(--kurso-primary-lightest)',
              border: '1px solid rgba(var(--kurso-primary-rgb), 0.28)',
            }}
            title={isAtCap ? 'Monthly AI limit reached' : `Write "${field}" with AI`}
          >
            <Sparkles className="w-3 h-3" />
            {label ?? '✦ AI'}
          </button>

          {remaining !== null && (
            <span className="text-[11px]" style={{ color: 'var(--kurso-text-muted)' }}>
              {remaining} left this month
            </span>
          )}
        </div>

        {state === 'error' && errorMsg && (
          <p className="text-[12px]" style={{ color: 'var(--kurso-danger)' }}>{errorMsg}</p>
        )}
      </div>
    )
  }

  // ── Generating ────────────────────────────────────────────────────────────
  if (state === 'generating') {
    return (
      <div className={`flex items-center gap-2 ${className}`} aria-live="polite" aria-label="AI is generating">
        {/* Pulsing dot */}
        <span
          className="w-2 h-2 rounded-full animate-pulse"
          style={{ background: 'var(--kurso-primary-light)' }}
        />
        <span className="text-[12px] font-medium" style={{ color: 'var(--kurso-primary-light)' }}>
          Generating…
        </span>
      </div>
    )
  }

  // ── Done ──────────────────────────────────────────────────────────────────
  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <div className="flex flex-wrap items-center gap-2">
        {/* Regenerate */}
        <button
          type="button"
          disabled={isAtCap}
          onClick={() => runGenerate()}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12px] font-semibold transition-all hover:opacity-90 disabled:opacity-40"
          style={{
            background: 'rgba(var(--kurso-primary-rgb), 0.10)',
            color: 'var(--kurso-primary-lightest)',
            border: '1px solid rgba(var(--kurso-primary-rgb), 0.22)',
          }}
          title="Generate a different version"
        >
          <RefreshCw className="w-3 h-3" />
          Regenerate
        </button>

        {/* Reprompt toggle */}
        <button
          type="button"
          onClick={() => setShowReprompt(v => !v)}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12px] font-medium transition-all hover:opacity-80"
          style={{
            background: 'rgba(255,255,255,0.05)',
            color: 'var(--kurso-text-secondary)',
            border: '1px solid rgba(255,255,255,0.1)',
          }}
          title="Tell the AI what to fix"
        >
          Correct AI
          {showReprompt && <X className="w-3 h-3 ml-0.5" />}
        </button>

        {remaining !== null && (
          <span className="text-[11px]" style={{ color: 'var(--kurso-text-muted)' }}>
            {remaining} left this month
          </span>
        )}
      </div>

      {/* Reprompt input — only shown when toggled */}
      {showReprompt && (
        <div className="flex gap-2 items-start">
          <textarea
            rows={2}
            value={reprompt}
            onChange={e => setReprompt(e.target.value)}
            placeholder="Tell the AI what to change, e.g. "Make it shorter and less formal""
            className="flex-1 px-3 py-2 rounded-xl text-[13px] text-white outline-none resize-none"
            style={{
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.12)',
              color: 'var(--kurso-text-secondary)',
            }}
            onFocus={e => (e.currentTarget.style.borderColor = 'var(--kurso-primary)')}
            onBlur={e => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)')}
          />
          <button
            type="button"
            disabled={!reprompt.trim() || isAtCap}
            onClick={() => runGenerate(reprompt.trim())}
            className="shrink-0 px-3 py-2 rounded-xl text-[12px] font-semibold text-white violet-gradient hover:opacity-90 disabled:opacity-40"
          >
            Apply
          </button>
        </div>
      )}
    </div>
  )
}
