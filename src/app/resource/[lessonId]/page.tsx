/**
 * src/app/resource/[lessonId]/page.tsx
 * Fixed: BUG 6 — quiz completion now saved to Supabase via /api/lesson/complete
 * Fixed: shows previous score if already attempted
 */
'use client'

import { useEffect, useMemo, useState, use } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, CheckCircle, FileText, HelpCircle, Shield } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { findPaidEnrollment } from '@/lib/enrollments'
import LessonQA from '@/components/LessonQA'

type ResourceType = 'summary' | 'notes' | 'quiz' | 'qa'

interface QuizQuestion {
  question: string
  options: string[]
  answerIndex: number
}

interface LessonResource {
  id: string
  title: string
  course_id: string
  order_num: number
  summary_url?: string | null
  summary_name?: string | null
  notes_url?: string | null
  notes_name?: string | null
  quiz_questions?: QuizQuestion[] | null
}

function getExt(url?: string | null): string {
  if (!url) return ''
  return url.split('?')[0].split('.').pop()?.toLowerCase() || ''
}

function TextRenderer({ url, name }: { url: string; name?: string | null }) {
  const [content, setContent] = useState<string | null>(null)
  const [err, setErr] = useState(false)
  const ext = getExt(name || url)

  useEffect(() => {
    fetch(url)
      .then(r => { if (!r.ok) throw new Error(); return r.text() })
      .then(setContent)
      .catch(() => setErr(true))
  }, [url])

  if (err) return (
    <div className="p-6 rounded-xl border border-red-500/20 bg-red-500/5 text-red-400 text-sm">
      Could not load file.{' '}
      <a href={url} target="_blank" rel="noopener noreferrer" className="underline">Open directly</a>
    </div>
  )
  if (!content) return (
    <div className="p-8 rounded-xl border border-white/10 text-center text-zinc-500 text-sm">Loading…</div>
  )

  if (ext === 'md') {
    // Minimal markdown render — no external deps
    const html = content
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/^---$/gm, '<hr>')
      .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .split('\n\n').map(p => {
        const t = p.trim()
        if (!t) return ''
        if (/^<(h[1-6]|hr|pre)/i.test(t)) return t
        if (/^[-*] /.test(t)) return `<ul>${t.split('\n').map(l => `<li>${l.replace(/^[-*] /, '')}</li>`).join('')}</ul>`
        return `<p>${t.replace(/\n/g, '<br>')}</p>`
      }).join('\n')

    return (
      <>
        <style>{`
          .md h1{font-size:1.5rem;font-weight:800;color:#fff;margin:1em 0 .4em}
          .md h2{font-size:1.2rem;font-weight:700;color:#e4e4e7;margin:.9em 0 .3em}
          .md h3{font-size:1rem;font-weight:700;color:var(--kurso-primary-lighter);margin:.8em 0 .2em}
          .md p{margin:.5em 0;color:#d4d4d8;line-height:1.75}
          .md ul{padding-left:1.4em;margin:.5em 0}
          .md li{margin:.25em 0;color:#d4d4d8}
          .md code{background:rgba(var(--kurso-primary-rgb), .15);color:var(--kurso-primary-lightest);padding:2px 5px;border-radius:4px;font-size:.88em;font-family:monospace}
          .md hr{border:none;border-top:1px solid rgba(255,255,255,.08);margin:1.2em 0}
          .md a{color:var(--kurso-primary-lighter);text-decoration:underline}
          .md strong{color:#fff;font-weight:700}
          .md em{color:var(--kurso-primary-lightest);font-style:italic}
        `}</style>
        <div className="md p-6 rounded-xl bg-white/[0.02] border border-white/[0.07]"
          dangerouslySetInnerHTML={{ __html: html }} />
      </>
    )
  }

  return (
    <pre className="p-6 rounded-xl bg-white/[0.02] border border-white/[0.07] text-zinc-300 text-sm leading-relaxed overflow-x-auto whitespace-pre-wrap">
      {content}
    </pre>
  )
}

export default function LessonResourcePage({
  params,
}: {
  params: Promise<{ lessonId: string }>
}) {
  const { lessonId } = use(params)
  const searchParams = useSearchParams()
  const type = (searchParams.get('type') || 'summary') as ResourceType

  const [lesson, setLesson] = useState<LessonResource | null>(null)
  const [loading, setLoading] = useState(true)
  const [answers, setAnswers] = useState<Record<number, number>>({})
  const [submitted, setSubmitted] = useState(false)
  const [saving, setSaving] = useState(false)
  const [previousResult, setPreviousResult] = useState<{ score: number; total: number } | null>(null)
  const [enrollmentId, setEnrollmentId] = useState<string | null>(null)
  const [linkInvalid, setLinkInvalid] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)

  const identity = searchParams.get('identity') || ''
  const exp = searchParams.get('exp') || ''
  const sig = searchParams.get('sig') || ''
  const cameFromSignedLink = Boolean(identity && exp && sig)

  useEffect(() => {
    async function load() {
      let l: LessonResource | null = null
      try {
        const { data: { session } } = await supabase.auth.getSession()
        const res = await fetch(`/api/resource/lesson?lessonId=${lessonId}`, {
          headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
        })
        if (res.ok) {
          const json = await res.json()
          l = json.lesson || null
        }
      } catch (e) {
        console.error('[resource load]', e)
      }
      setLesson(l)

      if (l && (type === 'quiz' || type === 'qa')) {
        if (cameFromSignedLink) {
          // WhatsApp path — verify the signed link server-side (this page
          // can't hold the signing secret) and resolve the enrollment by
          // phone instead of requiring a logged-in session.
          try {
            const params = new URLSearchParams({ lessonId, type, identity, exp, sig })
            const res = await fetch(`/api/resource/resolve?${params.toString()}`)
            const json = await res.json()
            if (!res.ok || !json.valid) {
              setLinkInvalid(true)
            } else {
              setEnrollmentId(json.enrollmentId || null)
              if (json.previousResult) setPreviousResult(json.previousResult)
            }
          } catch (e) {
            console.error('[quiz resolve]', e)
            setLinkInvalid(true)
          }
        } else {
          // Direct website visit — existing logged-in-session path
          const { data: { user } } = await supabase.auth.getUser()
          if (user) {
            const enrollment = await findPaidEnrollment({ courseId: l.course_id, user })
            if (enrollment) {
              setEnrollmentId(enrollment.id)
              const prev = (enrollment.quiz_results || []).find((r: any) => r.lessonId === lessonId)
              if (prev) setPreviousResult({ score: prev.score, total: prev.total })
            }
          }
        }
      }

      setLoading(false)
    }
    load()
  }, [lessonId, type, cameFromSignedLink, identity, exp, sig])

  const questions = useMemo(
    () => (Array.isArray(lesson?.quiz_questions) ? lesson!.quiz_questions! : []),
    [lesson]
  )

  const score = questions.reduce((s, q, i) => s + (answers[i] === q.answerIndex ? 1 : 0), 0)

  async function handleSubmit() {
    if (Object.keys(answers).length < questions.length || linkInvalid) return
    setSaving(true)
    setSubmitted(true)

    try {
      const res = await fetch('/api/lesson/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enrollmentId,
          identity: cameFromSignedLink ? identity : undefined,
          source: cameFromSignedLink ? 'whatsapp' : 'web',
          lessonId,
          lessonNum: lesson?.order_num,
          courseId: lesson?.course_id,
          quizScore: score,
          quizTotal: questions.length,
        }),
      })
      if (res.ok) {
        setPreviousResult({ score, total: questions.length })
      } else {
        setSaveFailed(true)
      }
    } catch (e) {
      console.error('[quiz submit]', e)
      setSaveFailed(true)
    }
    setSaving(false)
  }

  const resourceUrl = type === 'summary' ? lesson?.summary_url : lesson?.notes_url
  const resourceName = type === 'summary' ? lesson?.summary_name : lesson?.notes_name
  const ext = getExt(resourceName || resourceUrl)

  if (loading) return (
    <div className="min-h-screen bg-black flex items-center justify-center">
      <div className="w-8 h-8 rounded-lg animate-pulse" style={{ background: 'linear-gradient(135deg,var(--kurso-primary),var(--kurso-secondary))' }} />
    </div>
  )

  if (!lesson) return (
    <div className="min-h-screen bg-black flex items-center justify-center text-zinc-400">Resource not found.</div>
  )

  return (
    <div className="min-h-screen bg-black text-white">
      <header className="sticky top-0 z-20 border-b border-white/10 bg-black/90 backdrop-blur px-4 py-3">
        <div className="mx-auto max-w-4xl flex items-center justify-between gap-3">
          <button onClick={() => window.close()} className="inline-flex items-center gap-2 text-sm text-zinc-400 hover:text-white">
            <ArrowLeft className="w-4 h-4" /> Back
          </button>
          <div className="inline-flex items-center gap-2 text-xs text-zinc-500">
            <Shield className="w-3.5 h-3.5" /> Protected resource
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-8">
        <div className="mb-6">
          <p className="text-xs uppercase tracking-widest text-violet-400 font-bold">
            {type === 'quiz' ? 'Quiz' : type === 'qa' ? 'Q&A' : type === 'summary' ? 'Summary' : 'Notes'}
          </p>
          <h1 className="text-2xl font-bold mt-1">{lesson.title}</h1>
          {resourceName && type !== 'quiz' && type !== 'qa' && (
            <p className="text-sm text-zinc-500 mt-1 flex items-center gap-1.5">
              <FileText className="w-3.5 h-3.5" />{resourceName}
            </p>
          )}
        </div>

        {/* ── QUIZ ── */}
        {type === 'quiz' && (
          linkInvalid ? (
            <div className="p-8 rounded-xl border border-red-500/20 bg-red-500/5 text-center text-red-400">
              This link has expired or is invalid. Go back to WhatsApp and tap the lesson again to get a fresh link.
            </div>
          ) : questions.length === 0 ? (
            <div className="p-8 rounded-xl border border-white/10 bg-white/[0.03] text-center text-zinc-400">
              No quiz available for this lesson yet.
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {/* Previous result banner */}
              {previousResult && !submitted && (
                <div className="p-4 rounded-xl bg-violet-500/10 border border-violet-500/20 flex items-center gap-3">
                  <CheckCircle className="w-4 h-4 text-violet-400 flex-shrink-0" />
                  <p className="text-sm text-zinc-300">
                    Previous attempt: <strong className="text-white">{previousResult.score}/{previousResult.total}</strong> — you can retake it below.
                  </p>
                </div>
              )}

              {questions.map((q, idx) => (
                <div key={idx} className="rounded-xl border border-white/10 bg-white/[0.03] p-5">
                  <div className="flex items-start gap-3 mb-4">
                    <HelpCircle className="w-5 h-5 text-violet-400 mt-0.5 flex-shrink-0" />
                    <h2 className="font-semibold">{idx + 1}. {q.question}</h2>
                  </div>
                  <div className="flex flex-col gap-2">
                    {q.options.map((opt, oi) => {
                      const sel = answers[idx] === oi
                      const correct = submitted && q.answerIndex === oi
                      const wrong = submitted && sel && !correct
                      return (
                        <button key={oi}
                          onClick={() => !submitted && setAnswers(p => ({ ...p, [idx]: oi }))}
                          className="text-left rounded-lg px-4 py-3 text-sm border transition"
                          style={{
                            background: correct ? 'rgba(74,222,128,0.1)' : wrong ? 'rgba(239,68,68,0.1)' : sel ? 'rgba(var(--kurso-primary-rgb), 0.16)' : 'rgba(255,255,255,0.03)',
                            borderColor: correct ? 'rgba(74,222,128,0.35)' : wrong ? 'rgba(239,68,68,0.35)' : sel ? 'rgba(var(--kurso-primary-rgb), 0.45)' : 'rgba(255,255,255,0.08)',
                            cursor: submitted ? 'default' : 'pointer',
                          }}>
                          {opt}
                          {correct && <span className="ml-2 text-green-400 font-bold">✓</span>}
                          {wrong && <span className="ml-2 text-red-400 font-bold">✗</span>}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}

              {!submitted ? (
                <button onClick={handleSubmit}
                  disabled={Object.keys(answers).length < questions.length || saving}
                  className="w-full rounded-xl py-3 font-semibold text-white disabled:opacity-40 transition-all"
                  style={{ background: 'linear-gradient(135deg,var(--kurso-primary),var(--kurso-secondary))' }}>
                  {saving ? 'Saving…' : 'Submit Quiz'}
                </button>
              ) : (
                <div className="p-5 rounded-xl text-center"
                  style={{ background: score === questions.length ? 'rgba(74,222,128,0.08)' : 'rgba(var(--kurso-primary-rgb), 0.08)', border: `1px solid ${score === questions.length ? 'rgba(74,222,128,0.2)' : 'rgba(var(--kurso-primary-rgb), 0.2)'}` }}>
                  <p className="text-2xl font-bold text-white mb-1">{score}/{questions.length}</p>
                  <p className="text-sm text-zinc-400">
                    {score === questions.length ? '🎉 Perfect score!' : score >= questions.length / 2 ? '👍 Good job!' : '📖 Review the lesson and try again.'}
                  </p>
                  {saveFailed ? (
                    <p className="text-xs text-amber-400 mt-2">Your score didn't save — check your connection and retake the quiz.</p>
                  ) : (
                    <p className="text-xs text-zinc-500 mt-2">Score saved to your progress.</p>
                  )}
                </div>
              )}
            </div>
          )
        )}

        {/* ── Q&A ── */}
        {type === 'qa' && (
          linkInvalid ? (
            <div className="p-8 rounded-xl border border-red-500/20 bg-red-500/5 text-center text-red-400">
              This link has expired or is invalid. Go back to WhatsApp/Telegram and tap the lesson again to get a fresh link.
            </div>
          ) : (
            <LessonQA lessonId={lessonId} enrollmentId={enrollmentId} />
          )
        )}

        {/* ── NOTES / SUMMARY ── */}
        {type !== 'quiz' && type !== 'qa' && (
          resourceUrl ? (
            (ext === 'md' || ext === 'txt')
              ? <TextRenderer url={resourceUrl} name={resourceName} />
              : ext === 'pdf'
              ? (
                <div className="rounded-xl overflow-hidden border border-white/10">
                  <div className="flex items-center gap-2 px-4 py-3 border-b border-white/10 text-sm text-zinc-300">
                    <FileText className="w-4 h-4 text-violet-400" />
                    {resourceName || type}
                  </div>
                  <iframe src={resourceUrl} title={resourceName || type} className="w-full h-[75vh] bg-zinc-950" />
                </div>
              )
              : (
                <div className="p-10 rounded-xl border border-white/10 text-center">
                  <FileText className="w-10 h-10 text-violet-400 mx-auto mb-3" />
                  <p className="text-white font-semibold mb-4">{resourceName || 'Resource file'}</p>
                  <a href={resourceUrl} download
                    className="inline-flex items-center gap-2 px-6 py-3 rounded-xl text-white text-sm font-semibold"
                    style={{ background: 'linear-gradient(135deg,var(--kurso-primary),var(--kurso-secondary))' }}>
                    Download File
                  </a>
                </div>
              )
          ) : (
            <div className="p-8 rounded-xl border border-white/10 bg-white/[0.03] text-center text-zinc-400">
              No {type} available for this lesson yet.
            </div>
          )
        )}
      </main>
    </div>
  )
}