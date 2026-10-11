'use client'
// src/components/WorkshopAiAssistant.tsx
//
// "Write with AI" for workshop settings. Three steps:
//   1. brief      - the creator describes the workshop and picks what to write
//   2. questions  - only if the AI needs more detail (one round, up to 3 questions)
//   3. review     - every suggestion is shown next to what is there now; the creator
//                   picks which to use. Applying only fills the form; nothing is
//                   saved until the creator presses Save in workshop settings.
// The server does the writing and the safety filtering (lib/workshop-ai.ts).

import { useEffect, useState } from 'react'
import { Sparkles, X } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { FormField, TextArea, TextInput, SelectInput, SegmentedControl } from '@/components/WorkshopFormFields'
import {
  AI_DEFAULT_FIELDS,
  AI_FIELD_KEYS,
  AI_FIELD_LABELS,
  AI_LANGUAGES,
  AI_LIMITS,
  AI_TONES,
  type AiAnswer,
  type AiContext,
  type AiFieldKey,
  type AiSuggestions,
} from '@/lib/workshop-ai'

/** What is in the form right now, so a suggestion never silently replaces text. */
export type AiCurrentValues = {
  tagline: string
  description: string
  takeaways: string[]
  audience: string[]
  bring: string[]
  agenda: { title: string; description: string }[]
  faq: { question: string; answer: string }[]
  aboutHost: string
}

export function isEmptyCurrent(key: AiFieldKey, c: AiCurrentValues): boolean {
  switch (key) {
    case 'tagline': return !c.tagline.trim()
    case 'description': return !c.description.trim()
    case 'aboutHost': return !c.aboutHost.trim()
    case 'takeaways': return !c.takeaways.some(t => t.trim())
    case 'audience': return !c.audience.some(t => t.trim())
    case 'bring': return !c.bring.some(t => t.trim())
    case 'agenda': return !c.agenda.some(a => a.title.trim())
    case 'faq': return !c.faq.some(f => f.question.trim())
  }
}

/** Read-only view of one suggestion. */
export function SuggestionPreview({ fieldKey, suggestions }: { fieldKey: AiFieldKey; suggestions: AiSuggestions }) {
  const text = { color: 'var(--kurso-text-secondary)' } as const
  switch (fieldKey) {
    case 'tagline': case 'description': case 'aboutHost':
      return <p className="text-sm whitespace-pre-line" style={text}>{suggestions[fieldKey]}</p>
    case 'takeaways': case 'audience': case 'bring':
      return <ul className="list-disc pl-5 text-sm space-y-1" style={text}>{(suggestions[fieldKey] || []).map((t, i) => <li key={i}>{t}</li>)}</ul>
    case 'agenda':
      return (
        <ol className="list-decimal pl-5 text-sm space-y-1.5" style={text}>
          {(suggestions.agenda || []).map((a, i) => (
            <li key={i}><span className="font-medium text-white">{a.title}</span>{a.description ? <span> — {a.description}</span> : null}</li>
          ))}
        </ol>
      )
    case 'faq':
      return (
        <div className="space-y-2.5 text-sm" style={text}>
          {(suggestions.faq || []).map((f, i) => (
            <div key={i}><p className="font-medium text-white">{f.question}</p><p>{f.answer}</p></div>
          ))}
        </div>
      )
  }
}

type Step = 'brief' | 'questions' | 'review'
const CHECK_NOTES: Partial<Record<AiFieldKey, string>> = {
  agenda: 'The AI drafted these steps from your topic. Make sure they match what you will really teach.',
  faq: 'Check that every answer is true for your workshop before you use it.',
}

export default function WorkshopAiAssistant({ workshopId, context, current, onApply, onClose }: {
  workshopId: string
  context: AiContext
  current: AiCurrentValues
  onApply: (patch: AiSuggestions) => void
  onClose: () => void
}) {
  const [step, setStep] = useState<Step>('brief')
  const [about, setAbout] = useState(current.description)
  const [audience, setAudience] = useState('')
  const [outcomes, setOutcomes] = useState('')
  const [special, setSpecial] = useState('')
  const [language, setLanguage] = useState<string>('English')
  const [tone, setTone] = useState<string>('Friendly')
  const [fields, setFields] = useState<AiFieldKey[]>(AI_DEFAULT_FIELDS)

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [questions, setQuestions] = useState<string[]>([])
  const [answers, setAnswers] = useState<string[]>([])
  const [suggestions, setSuggestions] = useState<AiSuggestions>({})
  const [notes, setNotes] = useState<string[]>([])
  const [picked, setPicked] = useState<AiFieldKey[]>([])
  const [remaining, setRemaining] = useState<number | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !loading) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [loading, onClose])

  const toggleField = (key: AiFieldKey) =>
    setFields(prev => (prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]))

  async function generate(answerPairs: AiAnswer[]) {
    setError('')
    setLoading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) { setError('Your session expired. Please log in again.'); return }
      const res = await fetch('/api/workshops/ai-suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          workshopId, context, answers: answerPairs, fields,
          brief: { about, audience, outcomes, special, language, tone },
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.error || 'Something went wrong. Please try again.'); return }
      if (typeof data.remaining === 'number') setRemaining(data.remaining)

      if (data.status === 'needs_info') {
        setQuestions(data.questions || [])
        setAnswers((data.questions || []).map(() => ''))
        setStep('questions')
        return
      }
      const ready: AiSuggestions = data.fields || {}
      setSuggestions(ready)
      setNotes(data.notes || [])
      // Pre-select only what would not overwrite something the creator already wrote.
      setPicked(AI_FIELD_KEYS.filter(k => ready[k] !== undefined && isEmptyCurrent(k, current)))
      setStep('review')
    } catch (err) {
      console.error('[ai assistant] request failed', err)
      setError('Could not reach the AI assistant. Check your connection and try again.')
    } finally {
      setLoading(false)
    }
  }

  const answerPairs = (): AiAnswer[] => questions.map((q, i) => ({ question: q, answer: answers[i] || '' }))
  const suggestedKeys = AI_FIELD_KEYS.filter(k => suggestions[k] !== undefined)

  function apply() {
    const patch: AiSuggestions = {}
    for (const key of picked) (patch as any)[key] = suggestions[key]
    onApply(patch)
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto p-4 md:p-8" style={{ background: 'rgba(0,0,0,0.75)' }}
      onMouseDown={e => { if (e.target === e.currentTarget && !loading) onClose() }}>
      <div role="dialog" aria-modal="true" aria-labelledby="ai-title"
        className="max-w-2xl mx-auto rounded-2xl p-6 md:p-7 flex flex-col gap-5"
        style={{ background: '#0c0c0e', border: '1px solid rgba(255,255,255,0.14)' }}>

        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="ai-title" className="text-lg font-semibold text-white flex items-center gap-2">
              <Sparkles className="w-5 h-5" style={{ color: 'var(--kurso-primary-light)' }} /> Write with AI
            </h2>
            <p className="text-[13px] mt-1" style={{ color: 'var(--kurso-text-muted)' }}>
              The AI only drafts suggestions from what you tell it. You choose what to use, and nothing is saved until you press Save.
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={loading} aria-label="Close"
            className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center disabled:opacity-40"
            style={{ background: 'rgba(255,255,255,0.06)', color: 'var(--kurso-text-secondary)' }}>
            <X className="w-4 h-4" />
          </button>
        </div>

        {step === 'brief' && (
          <>
            <FormField label="What is your workshop about?" htmlFor="ai-about" required
              counter={`${about.length}/${AI_LIMITS.about}`}
              hint="A few sentences in your own words. The more real detail you give, the better the draft.">
              <TextArea id="ai-about" rows={4} value={about} onChange={setAbout} maxLength={AI_LIMITS.about}
                placeholder="e.g. A live 90-minute session where I show freelancers how to write cold emails that get replies, using my own templates." />
            </FormField>
            <FormField label="Who is it for?" htmlFor="ai-audience" tag="optional">
              <TextInput id="ai-audience" value={audience} onChange={setAudience} maxLength={AI_LIMITS.audience}
                placeholder="e.g. Freelance designers and writers who struggle to find clients" />
            </FormField>
            <FormField label="What will they be able to do afterwards?" htmlFor="ai-outcomes" tag="optional">
              <TextInput id="ai-outcomes" value={outcomes} onChange={setOutcomes} maxLength={AI_LIMITS.outcomes}
                placeholder="e.g. Write and send 3 ready-to-use cold emails" />
            </FormField>
            <FormField label="Anything that makes it special?" htmlFor="ai-special" tag="optional"
              hint="Your experience, tools, templates or bonuses. Only things you list here will be mentioned.">
              <TextInput id="ai-special" value={special} onChange={setSpecial} maxLength={AI_LIMITS.special}
                placeholder="e.g. I have sent over 2,000 cold emails; templates included" />
            </FormField>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <FormField label="Language" htmlFor="ai-language">
                <SelectInput id="ai-language" value={language} onChange={setLanguage}
                  options={AI_LANGUAGES.map(l => ({ value: l, label: l }))} />
              </FormField>
              <FormField label="Tone">
                <SegmentedControl ariaLabel="Tone" value={tone as (typeof AI_TONES)[number]} onChange={setTone}
                  options={AI_TONES.map(t => ({ value: t, label: t }))} />
              </FormField>
            </div>

            <FormField label="What should it write?">
              <div className="flex flex-wrap gap-2" role="group" aria-label="What to write">
                {AI_FIELD_KEYS.map(key => {
                  const on = fields.includes(key)
                  return (
                    <button key={key} type="button" aria-pressed={on} onClick={() => toggleField(key)}
                      className="px-3 py-1.5 rounded-full text-[13px] font-medium"
                      style={on
                        ? { background: 'rgba(var(--kurso-primary-rgb), 0.18)', color: 'var(--kurso-primary-lightest)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.35)' }
                        : { background: 'rgba(255,255,255,0.05)', color: 'var(--kurso-text-secondary)', border: '1px solid transparent' }}>
                      {AI_FIELD_LABELS[key]}
                    </button>
                  )
                })}
              </div>
            </FormField>

            <p className="text-[13px]" style={{ color: 'var(--kurso-text-muted)' }}>
              What you type here is sent to an AI service to write the draft. Do not include phone numbers, passwords or other private details.
            </p>
          </>
        )}

        {step === 'questions' && (
          <>
            <p className="text-sm" style={{ color: 'var(--kurso-text-secondary)' }}>
              A little more detail will make the draft much better. Answer what you can; leave the rest empty.
            </p>
            {questions.map((q, i) => (
              <FormField key={i} label={q} htmlFor={`ai-q-${i}`}>
                <TextInput id={`ai-q-${i}`} value={answers[i] || ''} maxLength={AI_LIMITS.answer}
                  onChange={v => setAnswers(prev => prev.map((a, idx) => (idx === i ? v : a)))} />
              </FormField>
            ))}
          </>
        )}

        {step === 'review' && (
          <>
            {notes.length > 0 && (
              <div className="rounded-xl p-4" style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.35)' }}>
                {notes.map((n, i) => <p key={i} className="text-sm" style={{ color: 'var(--kurso-text-secondary)' }}>{n}</p>)}
              </div>
            )}
            {suggestedKeys.map(key => {
              const on = picked.includes(key)
              const replaces = !isEmptyCurrent(key, current)
              return (
                <div key={key} className="rounded-xl p-4 flex flex-col gap-3"
                  style={{ background: 'rgba(255,255,255,0.03)', border: on ? '1px solid rgba(var(--kurso-primary-rgb), 0.45)' : '1px solid rgba(255,255,255,0.1)' }}>
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input type="checkbox" checked={on} className="w-4 h-4"
                      onChange={() => setPicked(prev => (prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]))} />
                    <span className="text-sm font-semibold text-white">{AI_FIELD_LABELS[key]}</span>
                    {replaces && (
                      <span className="text-[12px] font-medium px-2 py-0.5 rounded-full"
                        style={{ background: 'rgba(245,158,11,0.15)', color: 'var(--kurso-text-secondary)' }}>
                        {on ? 'Replaces what you have' : 'You already have text here'}
                      </span>
                    )}
                  </label>
                  <SuggestionPreview fieldKey={key} suggestions={suggestions} />
                  {CHECK_NOTES[key] && <p className="text-[13px]" style={{ color: 'var(--kurso-text-muted)' }}>{CHECK_NOTES[key]}</p>}
                </div>
              )
            })}
          </>
        )}

        {error && (
          <p role="alert" className="text-sm" style={{ color: 'var(--kurso-danger)' }}>{error}</p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <p className="text-[13px]" style={{ color: 'var(--kurso-text-muted)' }}>
            {remaining != null ? `${remaining} AI draft${remaining === 1 ? '' : 's'} left today` : `Up to ${AI_LIMITS.dailyGenerations} drafts a day`}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {step === 'brief' && (
              <button type="button" disabled={loading || about.trim().length < AI_LIMITS.aboutMin || fields.length === 0}
                onClick={() => generate([])}
                className="px-5 py-2.5 rounded-xl text-sm font-semibold text-white violet-gradient hover:opacity-90 disabled:opacity-40">
                {loading ? 'Writing…' : 'Write my page text'}
              </button>
            )}
            {step === 'questions' && (
              <>
                <button type="button" disabled={loading} onClick={() => setStep('brief')}
                  className="px-4 py-2.5 rounded-xl text-sm font-medium disabled:opacity-40"
                  style={{ background: 'rgba(255,255,255,0.08)', color: 'var(--kurso-text-secondary)' }}>Back</button>
                <button type="button" disabled={loading} onClick={() => generate(answerPairs())}
                  className="px-5 py-2.5 rounded-xl text-sm font-semibold text-white violet-gradient hover:opacity-90 disabled:opacity-40">
                  {loading ? 'Writing…' : 'Write my page text'}
                </button>
              </>
            )}
            {step === 'review' && (
              <>
                <button type="button" disabled={loading} onClick={() => setStep('brief')}
                  className="px-4 py-2.5 rounded-xl text-sm font-medium disabled:opacity-40"
                  style={{ background: 'rgba(255,255,255,0.08)', color: 'var(--kurso-text-secondary)' }}>Edit my details</button>
                <button type="button" disabled={loading} onClick={() => generate(questions.length ? answerPairs() : [])}
                  className="px-4 py-2.5 rounded-xl text-sm font-medium disabled:opacity-40"
                  style={{ background: 'rgba(255,255,255,0.08)', color: 'var(--kurso-text-secondary)' }}>
                  {loading ? 'Writing…' : 'Write again'}
                </button>
                <button type="button" disabled={picked.length === 0} onClick={apply}
                  className="px-5 py-2.5 rounded-xl text-sm font-semibold text-white violet-gradient hover:opacity-90 disabled:opacity-40">
                  Use {picked.length || ''} selected
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}