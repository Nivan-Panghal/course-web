'use client'
/**
 * AiFieldAssist — per-field inline AI writing helper.
 *
 * Put it right under any text field. The AI writes straight into the field.
 * Nothing is saved until the creator saves the page.
 *
 * Usage:
 *   <AiFieldAssist
 *     field="description"
 *     entityType="workshop"          // "workshop" | "course"
 *     context={{ title, tagline }}   // other filled fields on the page
 *     currentValue={description}     // what is in the field right now
 *     onResult={v => setDescription(v)}
 *   />
 *
 * What the creator sees:
 *   idle        → "Write with AI" (or "Rewrite with AI" if the field has text)
 *   generating  → "Writing…" — the field stays visible
 *   done        → "Try again", "Change something", "Undo"
 *
 * "Change something" lets the creator correct the AI in plain words
 * ("make it shorter"). The AI is sent the text that is in the field, so it
 * edits that text instead of starting over.
 */

import { useRef, useState } from 'react'
import { Sparkles, RefreshCw, Undo2, X } from 'lucide-react'
import { supabase } from '@/lib/supabase'

export type AiFieldAssistProps = {
  /** The field name — must match FIELD_INSTRUCTIONS in /api/creator/ai-assist */
  field: string
  /** Page context so the AI writes relevant text */
  entityType: 'workshop' | 'course'
  /** Other filled fields on this page (context for the AI) */
  context: Record<string, unknown>
  /** What is in the field right now (string, list of strings, or list of objects) */
  currentValue: unknown
  /** Called with the new text / list when the AI answers */
  onResult: (value: unknown) => void
  /** Optional label for the first button */
  label?: string
  /** Extra classes on the wrapper */
  className?: string
}

type State = 'idle' | 'generating' | 'done' | 'error'

const QUICK_FIXES = ['Make it shorter', 'Use simpler words', 'More friendly', 'More professional']

function isEmptyValue(v: unknown): boolean {
  if (typeof v === 'string') return !v.trim()
  if (Array.isArray(v)) {
    return !v.some(item => {
      if (typeof item === 'string') return item.trim().length > 0
      if (item && typeof item === 'object') {
        return Object.values(item as Record<string, unknown>).some(x => typeof x === 'string' && x.trim().length > 0)
      }
      return false
    })
  }
  return !v
}

const soft = {
  background: 'rgba(var(--kurso-primary-rgb), 0.12)',
  color: 'var(--kurso-primary-lightest)',
  border: '1px solid rgba(var(--kurso-primary-rgb), 0.3)',
} as const

const plain = {
  background: 'rgba(255,255,255,0.07)',
  color: 'var(--kurso-text-secondary)',
  border: '1px solid rgba(255,255,255,0.14)',
} as const

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
  // What the field held before the last AI answer, so "Undo" can put it back.
  const before = useRef<unknown>(null)
  const [canUndo, setCanUndo] = useState(false)

  const isAtCap = remaining !== null && remaining <= 0
  const hasText = !isEmptyValue(currentValue)

  async function runGenerate(repromptText?: string) {
    setState('generating')
    setErrorMsg('')
    const snapshot = currentValue
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        setErrorMsg('Your session ended. Please refresh the page and try again.')
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
          current: snapshot,
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

      before.current = snapshot
      setCanUndo(!isEmptyValue(snapshot))
      onResult(data.result)
      setState('done')
      setReprompt('')
      setShowReprompt(false)
    } catch {
      setErrorMsg('Could not reach the AI. Check your internet and try again.')
      setState('error')
    }
  }

  function undo() {
    onResult(before.current)
    setCanUndo(false)
  }

  const usesLeft = remaining !== null && (
    <span className="text-[13px]" style={{ color: 'var(--kurso-hint)' }}>
      {remaining} AI {remaining === 1 ? 'use' : 'uses'} left this month
    </span>
  )

  // ── Idle / error ──────────────────────────────────────────────────────────
  if (state === 'idle' || state === 'error') {
    return (
      <div className={`flex flex-col gap-1.5 ${className}`}>
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            disabled={isAtCap}
            onClick={() => runGenerate()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-semibold transition-all hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
            style={soft}
            title={isAtCap ? 'You have used all AI help for this month' : 'Let AI write this for you'}
          >
            <Sparkles className="w-3.5 h-3.5" />
            {label ?? (hasText ? 'Rewrite with AI' : 'Write with AI')}
          </button>
          {usesLeft}
        </div>

        {state === 'error' && errorMsg && (
          <p role="alert" className="text-[13px]" style={{ color: 'var(--kurso-danger)' }}>{errorMsg}</p>
        )}
      </div>
    )
  }

  // ── Generating ────────────────────────────────────────────────────────────
  if (state === 'generating') {
    return (
      <div className={`flex items-center gap-2 ${className}`} aria-live="polite">
        <span className="w-2 h-2 rounded-full animate-pulse" style={{ background: 'var(--kurso-primary-light)' }} />
        <span className="text-[13px] font-medium" style={{ color: 'var(--kurso-primary-lightest)' }}>
          Writing…
        </span>
      </div>
    )
  }

  // ── Done ──────────────────────────────────────────────────────────────────
  return (
    <div className={`flex flex-col gap-2.5 ${className}`}>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={isAtCap}
          onClick={() => runGenerate()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-semibold transition-all hover:opacity-90 disabled:opacity-40"
          style={soft}
          title="Get a different version"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Try again
        </button>

        <button
          type="button"
          onClick={() => setShowReprompt(v => !v)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium transition-all hover:opacity-90"
          style={plain}
          title="Tell the AI what to change"
        >
          {showReprompt ? <X className="w-3.5 h-3.5" /> : <Sparkles className="w-3.5 h-3.5" />}
          {showReprompt ? 'Close' : 'Change something'}
        </button>

        {canUndo && (
          <button
            type="button"
            onClick={undo}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium transition-all hover:opacity-90"
            style={plain}
            title="Go back to what you had before"
          >
            <Undo2 className="w-3.5 h-3.5" />
            Undo
          </button>
        )}

        {usesLeft}
      </div>

      {showReprompt && (
        <div className="flex flex-col gap-2">
          <p className="text-[13px]" style={{ color: 'var(--kurso-hint)' }}>
            Tell the AI what to change. It will edit the text above.
          </p>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Quick changes">
            {QUICK_FIXES.map(q => (
              <button
                key={q}
                type="button"
                disabled={isAtCap}
                onClick={() => runGenerate(q)}
                className="px-3 py-1 rounded-full text-[13px] font-medium transition-all hover:opacity-90 disabled:opacity-40"
                style={plain}
              >
                {q}
              </button>
            ))}
          </div>
          <div className="flex gap-2 items-start">
            <textarea
              rows={2}
              value={reprompt}
              onChange={e => setReprompt(e.target.value)}
              placeholder={'Or type your own, e.g. "Mention that it is in Hindi"'}
              aria-label="What should the AI change?"
              className="flex-1 px-3 py-2 rounded-xl text-[14px] outline-none resize-none"
              style={{
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.14)',
                color: 'var(--kurso-text-secondary)',
              }}
              onFocus={e => (e.currentTarget.style.borderColor = 'var(--kurso-primary)')}
              onBlur={e => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.14)')}
            />
            <button
              type="button"
              disabled={!reprompt.trim() || isAtCap}
              onClick={() => runGenerate(reprompt.trim())}
              className="shrink-0 px-4 py-2 rounded-xl text-[13px] font-semibold text-white violet-gradient hover:opacity-90 disabled:opacity-40"
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  )
}