'use client'
// src/components/WorkshopFormFields.tsx
//
// Shared form building blocks for the workshop dashboard screens (the create
// page now, workshop settings next) so they look and behave identically.
//
// LEGIBILITY RULES (do not break these — dim helper text was a real complaint):
//   - helper / hint text uses var(--kurso-text-muted) or lighter, never a
//     one-off dark gray, and is never smaller than 13px
//   - labels are white; placeholders are zinc-400
//   - date/time/select controls set colorScheme: 'dark' so their native icons
//     and pickers are visible on the dark background

import type {
  FocusEvent,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react'

const FIELD_BG = 'rgba(255,255,255,0.05)'
const FIELD_BORDER = 'rgba(255,255,255,0.14)'

const fieldClass =
  'w-full px-4 py-3 rounded-xl text-sm text-white outline-none transition-all placeholder:text-zinc-400'
const fieldStyle = {
  background: FIELD_BG,
  border: `1px solid ${FIELD_BORDER}`,
  colorScheme: 'dark',
} as const

type AnyField = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
const onFocusBrand = (e: FocusEvent<AnyField>) => { e.currentTarget.style.borderColor = 'var(--kurso-primary)' }
const onBlurNeutral = (e: FocusEvent<AnyField>) => { e.currentTarget.style.borderColor = FIELD_BORDER }

// ─── Tags ───────────────────────────────────────────────────────────────────

/** "Optional" / "Recommended" pill shown next to a card title or field label. */
export function FieldTag({ kind }: { kind: 'optional' | 'recommended' }) {
  const recommended = kind === 'recommended'
  return (
    <span
      className="inline-block text-[12px] font-medium px-2 py-0.5 rounded-full whitespace-nowrap"
      style={recommended
        ? { background: 'rgba(var(--kurso-primary-rgb), 0.16)', color: 'var(--kurso-primary-lightest)' }
        : { background: 'rgba(255,255,255,0.08)', color: 'var(--kurso-text-secondary)' }}
    >
      {recommended ? 'Recommended' : 'Optional'}
    </span>
  )
}

// ─── Layout ─────────────────────────────────────────────────────────────────

export function FormCard({ title, description, tag, children }: {
  title: string
  description?: string
  tag?: 'optional' | 'recommended'
  children: ReactNode
}) {
  return (
    <section className="rounded-2xl p-6 md:p-7 glass" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
      <div className="mb-5">
        <div className="flex items-center gap-2.5 flex-wrap">
          <h2 className="text-base font-semibold text-white">{title}</h2>
          {tag && <FieldTag kind={tag} />}
        </div>
        {description && (
          <p className="text-[13px] mt-1.5 leading-relaxed" style={{ color: 'var(--kurso-hint)' }}>{description}</p>
        )}
      </div>
      <div className="flex flex-col gap-5">{children}</div>
    </section>
  )
}

export function FormField({ label, htmlFor, required, tag, hint, counter, children }: {
  label: string
  htmlFor?: string
  required?: boolean
  tag?: 'optional' | 'recommended'
  hint?: ReactNode
  counter?: string
  children: ReactNode
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-2">
        <label htmlFor={htmlFor} className="text-sm font-medium text-white">
          {label}
          {required && <span style={{ color: 'var(--kurso-primary-light)' }}> *</span>}
          {tag && <span className="ml-2 align-middle"><FieldTag kind={tag} /></span>}
        </label>
        {counter && (
          <span className="text-[13px] tabular-nums" style={{ color: 'var(--kurso-text-muted)' }}>{counter}</span>
        )}
      </div>
      {children}
      {hint && (
        <p className="text-[13px] mt-1.5 leading-relaxed" style={{ color: 'var(--kurso-hint)' }}>{hint}</p>
      )}
    </div>
  )
}

// ─── Controls ───────────────────────────────────────────────────────────────

type TextInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'prefix'> & {
  value: string
  onChange: (value: string) => void
  /** Small text shown inside the left edge, e.g. "₹". */
  prefix?: string
}

export function TextInput({ value, onChange, prefix, style, ...rest }: TextInputProps) {
  const input = (
    <input
      {...rest}
      value={value}
      onChange={e => onChange(e.target.value)}
      onFocus={onFocusBrand}
      onBlur={onBlurNeutral}
      className={fieldClass}
      style={{ ...fieldStyle, ...(prefix ? { paddingLeft: '2.25rem' } : {}), ...style }}
    />
  )
  if (!prefix) return input
  return (
    <div className="relative">
      <span
        className="absolute left-4 top-1/2 -translate-y-1/2 text-sm pointer-events-none"
        style={{ color: 'var(--kurso-text-secondary)' }}
      >
        {prefix}
      </span>
      {input}
    </div>
  )
}

type TextAreaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange' | 'value'> & {
  value: string
  onChange: (value: string) => void
}

export function TextArea({ value, onChange, style, ...rest }: TextAreaProps) {
  return (
    <textarea
      {...rest}
      value={value}
      onChange={e => onChange(e.target.value)}
      onFocus={onFocusBrand}
      onBlur={onBlurNeutral}
      className={`${fieldClass} resize-none`}
      style={{ ...fieldStyle, ...style }}
    />
  )
}

type SelectInputProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'value'> & {
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
}

export function SelectInput({ value, onChange, options, style, ...rest }: SelectInputProps) {
  return (
    <select
      {...rest}
      value={value}
      onChange={e => onChange(e.target.value)}
      onFocus={onFocusBrand}
      onBlur={onBlurNeutral}
      className={fieldClass}
      style={{ ...fieldStyle, ...style }}
    >
      {options.map(o => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  )
}

export function SegmentedControl<T extends string>({ value, onChange, options, ariaLabel }: {
  value: T
  onChange: (value: T) => void
  options: { value: T; label: string }[]
  ariaLabel: string
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="inline-flex p-1 rounded-xl gap-1"
      style={{ background: FIELD_BG, border: `1px solid ${FIELD_BORDER}` }}
    >
      {options.map(o => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.value)}
            className="px-5 py-2 rounded-lg text-sm font-medium transition-all"
            style={active
              ? { background: 'rgba(var(--kurso-primary-rgb), 0.18)', color: 'var(--kurso-primary-lightest)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.35)' }
              : { color: 'var(--kurso-text-secondary)', border: '1px solid transparent' }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}