'use client'
// src/app/dashboard/workshops/[id]/certificates/page.tsx
//
// Certificates for ONE workshop (workshops only; course certificates are set up
// inside each course). Flow:
//   1. Turn certificates on and pick a look.
//   2. After the workshop starts, tick the people who should get a certificate.
//   3. Tap "Issue and send". It goes out on Telegram and by email by itself.
// Settings save with the Save button. Choosing people and tapping "Issue and send"
// makes each certificate and sends it on Telegram and by email.

import { use, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import Sidebar from '@/components/Sidebar'
import { supabase } from '@/lib/supabase'
import { uploadPublicImage } from '@/lib/storage-upload'
import { ArrowLeft, Award, Check, Copy, ExternalLink } from 'lucide-react'
import { FormCard, FormField, TextArea } from '@/components/WorkshopFormFields'
import { ImageUploadField } from '@/components/WorkshopMediaFields'
import { ToggleSwitch } from '@/components/WorkshopDesignFields'
import {
  MAX_WORKSHOP_CERT_MESSAGE,
  WORKSHOP_CERT_TEMPLATES,
  isWorkshopCertTemplate,
} from '@/lib/workshop-certificate-options'

type Attendee = {
  id: string
  name: string
  phoneEnd: string
  attended: boolean
  hasTelegram: boolean
  hasEmail: boolean
  certificate: { id: string; url: string; sentOnTelegram: boolean; sentByEmail: boolean } | null
}

type Outcome = 'sent' | 'already_sent' | 'no_contact' | 'delivery_failed' | 'failed'
type SendResult = { id: string; name: string; outcome: Outcome }

const SEND_GROUP = 10 // people per request, kept in step with the server

type Settings = { enabled: boolean; template: string; message: string; signatureUrl: string }

const text2 = { color: 'var(--kurso-text-secondary)' } as const
const hint = { color: 'var(--kurso-hint)' } as const

export default function WorkshopCertificatesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()

  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [setupNeeded, setSetupNeeded] = useState(false)
  const [creatorId, setCreatorId] = useState('')
  const [title, setTitle] = useState('')
  const [started, setStarted] = useState(false)

  const [settings, setSettings] = useState<Settings>({ enabled: false, template: 'classic', message: '', signatureUrl: '' })
  const [saved, setSaved] = useState<Settings>({ enabled: false, template: 'classic', message: '', signatureUrl: '' })
  const [attendees, setAttendees] = useState<Attendee[]>([])

  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [issuing, setIssuing] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [copiedId, setCopiedId] = useState('')

  const dirty = useMemo(() => JSON.stringify(settings) !== JSON.stringify(saved), [settings, saved])
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setSettings(prev => ({ ...prev, [key]: value }))

  const issuedCount = attendees.filter(a => a.certificate).length
  const toggle = (id: string) => setSelected(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]))

  const authHeader = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : null
  }, [])

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { router.push('/login'); return }
    setCreatorId(user.id)
    const headers = await authHeader()
    if (!headers) { router.push('/login'); return }

    const res = await fetch(`/api/workshops/certificates?workshopId=${encodeURIComponent(id)}`, { headers })
    const data = await res.json().catch(() => ({}))
    if (res.status === 409) { setSetupNeeded(true); setLoading(false); return }
    if (res.status === 404) { setNotFound(true); setLoading(false); return }
    if (!res.ok) { setError(data.error || 'Could not load this page. Please refresh.'); setLoading(false); return }

    const w = data.workshop
    const loaded: Settings = {
      enabled: !!w.certificateEnabled,
      template: isWorkshopCertTemplate(w.template) ? w.template : 'classic',
      message: w.message || '',
      signatureUrl: w.signatureUrl || '',
    }
    setTitle(w.title)
    setStarted(!!w.started)
    setSettings(loaded)
    setSaved(loaded)
    setAttendees(data.attendees || [])
    setLoading(false)
  }, [authHeader, id, router])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  async function saveSettings() {
    if (saving || !dirty) return
    setError('')
    if (settings.message.length > MAX_WORKSHOP_CERT_MESSAGE) {
      setError(`Keep the message under ${MAX_WORKSHOP_CERT_MESSAGE} characters.`)
      return
    }
    setSaving(true)
    try {
      const { data, error: updateError } = await supabase
        .from('workshops')
        .update({
          certificate_enabled: settings.enabled,
          certificate_template: settings.template,
          certificate_message: settings.message.trim() || null,
          certificate_signature_url: settings.signatureUrl || null,
        })
        .eq('id', id)
        .eq('creator_id', creatorId)
        .select('id')
        .maybeSingle()
      if (updateError) { console.error('[workshop certificates] save failed', updateError); setError(updateError.message); return }
      if (!data) { setError('Could not save. This workshop was not found, or you no longer have access to it.'); return }
      setSaved(settings)
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 2500)
    } finally {
      setSaving(false)
    }
  }

  async function sendCertificates(ids: string[], resend = false) {
    if (issuing || ids.length === 0) return
    setError('')
    setNotice('')
    setIssuing(true)
    try {
      const headers = await authHeader()
      if (!headers) { setError('Please log in again.'); return }
      const all: SendResult[] = []
      for (let i = 0; i < ids.length; i += SEND_GROUP) {
        const res = await fetch('/api/workshops/certificates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({ workshopId: id, registrationIds: ids.slice(i, i + SEND_GROUP), resend }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) { setError(data.error || 'Could not send certificates. Please try again.'); break }
        all.push(...(data.results || []))
      }
      await load()
      setSelected([])

      const names = (o: Outcome) => all.filter(r => r.outcome === o).map(r => r.name).join(', ')
      const sent = all.filter(r => r.outcome === 'sent').length
      const skipped = all.filter(r => r.outcome === 'already_sent').length
      const parts: string[] = []
      if (sent) parts.push(`${sent} certificate${sent === 1 ? '' : 's'} sent.`)
      if (skipped) parts.push(`${skipped} already received theirs.`)
      if (parts.length) setNotice(parts.join(' '))

      const problems: string[] = []
      if (names('no_contact')) problems.push(`${names('no_contact')} ${all.filter(r => r.outcome === 'no_contact').length === 1 ? 'has' : 'have'} no Telegram or email, so nothing was sent. Copy their link and share it yourself.`)
      if (names('delivery_failed')) problems.push(`We could not deliver to ${names('delivery_failed')}. Tap “Send again” in a moment.`)
      if (names('failed')) problems.push(`Could not make a certificate for ${names('failed')}. Please try again.`)
      if (problems.length) setError(problems.join(' '))
    } finally {
      setIssuing(false)
    }
  }

  async function copyLink(certId: string) {
    const url = `${window.location.origin}/certificate/${certId}`
    try {
      await navigator.clipboard.writeText(url)
      setCopiedId(certId)
      setTimeout(() => setCopiedId(''), 2000)
    } catch {
      window.prompt('Copy this link:', url)
    }
  }

  const shell = (children: React.ReactNode) => (
    <div className="min-h-screen bg-black">
      <Sidebar />
      <main className="md:ml-56 p-6 md:p-8 pt-20 md:pt-8 pb-28 max-w-3xl">{children}</main>
    </div>
  )

  if (loading) return shell(<p className="text-sm" style={hint}>Loading…</p>)
  if (notFound) {
    return shell(
      <>
        <h1 className="text-xl font-bold text-white mb-2">Workshop not found</h1>
        <p className="text-sm mb-4" style={hint}>It may have been removed, or it belongs to another account.</p>
        <Link href="/dashboard/workshops" className="text-sm underline" style={{ color: 'var(--kurso-primary-lightest)' }}>Back to workshops</Link>
      </>
    )
  }
  if (setupNeeded) {
    return shell(
      <>
        <h1 className="text-xl font-bold text-white mb-2">One quick setup step</h1>
        <p className="text-sm leading-relaxed" style={text2}>
          Workshop certificates need a small database update before they can be used. Run the workshop certificates SQL in Supabase, then refresh this page.
        </p>
      </>
    )
  }

  return (
    <div className="min-h-screen bg-black">
      <Sidebar />
      <main className="md:ml-56 p-6 md:p-8 pt-20 md:pt-8 pb-28 max-w-3xl">
        <Link href={`/dashboard/workshops/${id}`}
          className="inline-flex items-center gap-2 text-sm mb-5 hover:opacity-80" style={text2}>
          <ArrowLeft className="w-4 h-4" /> Back to workshop settings
        </Link>

        <h1 className="text-2xl font-bold text-white mb-1 flex items-center gap-2.5 break-words">
          <Award className="w-6 h-6 shrink-0" style={{ color: 'var(--kurso-primary-light)' }} /> Certificates
        </h1>
        <p className="text-sm mb-1" style={text2}>{title}</p>
        <p className="text-[14px] mb-6" style={hint}>
          These certificates are for this workshop only. Course certificates are set up inside each course.
        </p>

        <div className="flex flex-col gap-6">
          <FormCard title="Give certificates for this workshop" description="Attendees get a “Certificate of Participation” with their name on it.">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-white">Certificates are {settings.enabled ? 'on' : 'off'}</p>
                <p className="text-[14px]" style={hint}>
                  You choose who gets one, and it is sent to them automatically.
                </p>
              </div>
              <ToggleSwitch checked={settings.enabled} label="Give certificates for this workshop" onChange={v => set('enabled', v)} />
            </div>
          </FormCard>

          {settings.enabled && (
            <FormCard title="How it looks">
              <FormField label="Style">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" role="radiogroup" aria-label="Certificate style">
                  {WORKSHOP_CERT_TEMPLATES.map(t => {
                    const on = settings.template === t.id
                    return (
                      <button key={t.id} type="button" role="radio" aria-checked={on} onClick={() => set('template', t.id)}
                        className="text-left px-4 py-3 rounded-xl transition-all"
                        style={on
                          ? { background: 'rgba(var(--kurso-primary-rgb), 0.15)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.45)' }
                          : { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)' }}>
                        <p className="text-sm font-semibold text-white">{t.label}</p>
                        <p className="text-[13px] mt-0.5" style={hint}>{t.note}</p>
                      </button>
                    )
                  })}
                </div>
              </FormField>

              <FormField label="Short message" htmlFor="cert-message" tag="optional"
                counter={`${settings.message.length}/${MAX_WORKSHOP_CERT_MESSAGE}`}
                hint="Printed on the certificate, for example “Thank you for learning with us.” Leave it empty to skip.">
                <TextArea id="cert-message" rows={2} value={settings.message} onChange={v => set('message', v)}
                  maxLength={MAX_WORKSHOP_CERT_MESSAGE} placeholder="Thank you for learning with us." />
              </FormField>

              <FormField label="Your signature" tag="optional"
                hint="A PNG with a clear background looks best. Up to 2MB.">
                <ImageUploadField id="cert-signature" shape="wide" value={settings.signatureUrl} uploadLabel="Upload signature"
                  onChange={v => set('signatureUrl', v)} onUpload={file => uploadPublicImage(file, 'certificate-signatures')} onError={setError} />
              </FormField>

              <p className="text-[14px]" style={hint}>
                Your brand logo from the workshop’s Branding tab is added automatically. If you change the look later, new certificates use it. Ones already issued stay as they are.
              </p>
            </FormCard>
          )}

          {settings.enabled && (
            <FormCard title="Send certificates" description={started
              ? 'Choose the people who should get a certificate. It is sent to them automatically.'
              : 'You can send certificates once the workshop has started.'}>
              {attendees.length === 0 ? (
                <p className="text-sm" style={hint}>
                  No confirmed registrations yet. Paid registrations show up here after payment is confirmed.
                </p>
              ) : (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-[14px]" style={text2}>
                      {selected.length} selected · {issuedCount} of {attendees.length} already have a certificate
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" onClick={() => setSelected(attendees.filter(a => !a.certificate).map(a => a.id))}
                        className="px-3 py-2 rounded-xl text-[13px] font-medium"
                        style={{ background: 'rgba(255,255,255,0.08)', color: 'var(--kurso-text-secondary)' }}>
                        Select everyone without a certificate
                      </button>
                      {selected.length > 0 && (
                        <button type="button" onClick={() => setSelected([])}
                          className="px-3 py-2 rounded-xl text-[13px] font-medium"
                          style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--kurso-text-secondary)' }}>
                          Clear
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-col gap-2">
                    {attendees.map(a => {
                      const c = a.certificate
                      const via = [a.hasTelegram && 'Telegram', a.hasEmail && 'email'].filter(Boolean).join(' and ')
                      return (
                        <div key={a.id} className="flex items-center justify-between gap-3 flex-wrap p-3 rounded-xl"
                          style={{ background: 'rgba(255,255,255,0.04)' }}>
                          <label className="flex items-center gap-3 min-w-0 cursor-pointer">
                            <input type="checkbox" className="w-4 h-4 shrink-0" checked={selected.includes(a.id)}
                              disabled={!started || issuing} onChange={() => toggle(a.id)} aria-label={`Select ${a.name}`} />
                            <span className="min-w-0">
                              <span className="block text-sm text-white truncate">{a.name}</span>
                              <span className="block text-[13px]" style={hint}>
                                Phone ending {a.phoneEnd} ·{' '}
                                {c
                                  ? (c.sentOnTelegram || c.sentByEmail
                                    ? `Sent ${[c.sentOnTelegram && 'on Telegram', c.sentByEmail && 'by email'].filter(Boolean).join(' and ')}`
                                    : 'Certificate made, not sent yet')
                                  : via ? `Will get it on ${via}` : 'No Telegram or email on file'}
                              </span>
                            </span>
                          </label>

                          {c && (
                            <div className="flex items-center gap-2 flex-wrap">
                              <a href={c.url} target="_blank" rel="noopener noreferrer"
                                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[13px] font-medium"
                                style={{ background: 'rgba(255,255,255,0.08)', color: 'var(--kurso-text-secondary)' }}>
                                <ExternalLink className="w-3.5 h-3.5" /> View
                              </a>
                              <button type="button" onClick={() => copyLink(c.id)}
                                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[13px] font-medium"
                                style={{ background: 'rgba(255,255,255,0.08)', color: 'var(--kurso-text-secondary)' }}>
                                {copiedId === c.id ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                                {copiedId === c.id ? 'Copied' : 'Copy link'}
                              </button>
                              {(a.hasTelegram || a.hasEmail) && (
                                <button type="button" disabled={issuing || dirty} onClick={() => sendCertificates([a.id], true)}
                                  className="px-2.5 py-1.5 rounded-lg text-[13px] font-medium disabled:opacity-40"
                                  style={{ background: 'rgba(var(--kurso-primary-rgb), 0.15)', color: 'var(--kurso-primary-lightest)' }}>
                                  Send again
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    <button type="button" onClick={() => sendCertificates(selected)}
                      disabled={issuing || selected.length === 0 || dirty || !started}
                      className="px-5 py-2.5 rounded-xl text-sm font-semibold text-white violet-gradient hover:opacity-90 disabled:opacity-40">
                      {issuing ? 'Sending certificates…' : selected.length ? `Issue and send to ${selected.length} ${selected.length === 1 ? 'person' : 'people'}` : 'Issue and send'}
                    </button>
                    {dirty && <p className="text-[14px]" style={hint}>Save your changes first, then send.</p>}
                  </div>
                  {notice && <p role="status" className="text-sm" style={{ color: 'var(--kurso-success)' }}>{notice}</p>}
                  <p className="text-[14px]" style={hint}>
                    Certificates go out on Telegram and by email. People who have not joined your Telegram bot get the email only. Anyone you issue a certificate to is counted as having attended.
                  </p>
                </>
              )}
            </FormCard>
          )}
        </div>
      </main>

      {/* Sticky save bar */}
      <div className="fixed bottom-0 left-0 right-0 md:left-56 z-30 px-4 md:px-8 py-3 flex items-center justify-between gap-4"
        style={{ background: 'rgba(0,0,0,0.92)', borderTop: '1px solid rgba(255,255,255,0.1)', backdropFilter: 'blur(8px)' }}>
        <p role={error ? 'alert' : 'status'} className="text-sm min-w-0"
          style={{ color: error ? 'var(--kurso-danger)' : dirty ? 'var(--kurso-text-secondary)' : 'var(--kurso-hint)' }}>
          {error || (savedFlash ? 'Saved.' : dirty ? 'You have unsaved changes.' : 'All changes saved.')}
        </p>
        <button type="button" onClick={saveSettings} disabled={!dirty || saving}
          className="shrink-0 px-6 py-2.5 rounded-xl text-sm font-semibold text-white violet-gradient hover:opacity-90 disabled:opacity-40">
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </div>
  )
}