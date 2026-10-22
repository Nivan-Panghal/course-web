'use client'
// src/app/dashboard/workshops/[id]/page.tsx
//
// Workshop settings: edit everything about a workshop after it is created.
//
// - Validation lives in lib/workshop-validation.ts (shared with the create page).
// - Date and time are IST, same as the create page and the public page.
// - Publish / Unpublish saves immediately; everything else saves with the
//   sticky Save bar.
// - The slug (your page link) never changes when you edit the title, so links
//   you already shared keep working.
// - Replaced / removed policy documents are deleted from storage only AFTER the
//   save succeeds, so an unsaved change can never leave the page pointing at a
//   deleted file.

import { use, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import Sidebar from '@/components/Sidebar'
import CoInstructorsEditor from '@/components/CoInstructorsEditor'
import ContactDetailsEditor from '@/components/ContactDetailsEditor'
import SocialLinksEditor from '@/components/SocialLinksEditor'
import { supabase } from '@/lib/supabase'
import { removePublicFile, uploadPolicyDoc, uploadPublicImage } from '@/lib/storage-upload'
import { parseContactDetails } from '@/lib/contact-details'
import { parseSocialLinks } from '@/lib/social-links'
import { LANDING_LANGUAGES, LANDING_LEVELS } from '@/lib/landing-options'
import { ArrowLeft, Award, Check, Copy, ExternalLink, AlertTriangle, Sparkles, Users } from 'lucide-react'
import { FormCard, FormField, TextInput, TextArea, SelectInput, SegmentedControl } from '@/components/WorkshopFormFields'
import { StringListEditor, AgendaEditor, FaqEditor } from '@/components/WorkshopListEditors'
import AiFieldAssist from '@/components/AiFieldAssist'
import ChannelSwitches from '@/components/ChannelSwitches'
import { ImageUploadField, PolicyDocField, TestimonialsEditor } from '@/components/WorkshopMediaFields'
import { BonusesEditor, CustomSectionsEditor, FontPairPicker, SectionList, ThemePicker, ToggleSwitch } from '@/components/WorkshopDesignFields'
import { DEFAULT_LANDING_THEME_ID } from '@/lib/landing-themes'
import { MAX_ENROLL_BUTTON_CHARS, MAX_FINAL_CTA_WORDS } from '@/lib/landing-config'
import {
  WORKSHOP_DURATION_OPTIONS,
  WORKSHOP_LIMITS,
  countHeldSpots,
  formatWorkshopDateTime,
  formatWorkshopDuration,
  isoToISTParts,
  istDateTimeToISO,
  workshopStatusLabel,
} from '@/lib/workshops'
import {
  WORKSHOP_CONTENT_LIMITS,
  cleanFaq,
  cleanTestimonials,
  validateWorkshopBranding,
  validateWorkshopContent,
  validateWorkshopDesign,
  validateWorkshopFields,
  type WorkshopBrandingValues,
  type WorkshopContentValues,
  type WorkshopDesignValues,
  type WorkshopFormValues,
  type WorkshopSection,
} from '@/lib/workshop-validation'
import {
  DEFAULT_REGISTER_BUTTON_TEXT,
  MAX_AGENDA_DESCRIPTION_LENGTH,
  MAX_AGENDA_ITEMS,
  MAX_AGENDA_TITLE_LENGTH,
  MAX_DISCLAIMER_TEXT_LENGTH,
  MAX_DISCLAIMER_TITLE_LENGTH,
  MAX_TAGLINE_LENGTH,
  normalizeAgenda,
  normalizeWorkshopLandingConfig,
  workshopSectionHasContent,
  type WorkshopSectionType,
} from '@/lib/workshop-landing-config'

type WorkshopForm = WorkshopFormValues & WorkshopContentValues & WorkshopBrandingValues & WorkshopDesignValues & {
  /** Email is always on, so only WhatsApp and Telegram can be switched. */
  notifyWhatsapp: boolean
  notifyTelegram: boolean
}
type Tab = WorkshopSection
type DocKey = 'refundDoc' | 'termsDoc' | 'privacyDoc'

const TABS: { id: Tab; label: string }[] = [
  { id: 'details', label: 'Details' },
  { id: 'content', label: 'Page content' },
  { id: 'branding', label: 'Branding & contact' },
  { id: 'design', label: 'Design' },
]

const POLICY_DOCS: { key: DocKey; label: string }[] = [
  { key: 'refundDoc', label: 'Refund policy' },
  { key: 'termsDoc', label: 'Terms and conditions' },
  { key: 'privacyDoc', label: 'Privacy policy' },
]

const CUSTOM_SECTION_IMAGE = { maxBytes: 5 * 1024 * 1024 }
const TESTIMONIAL_IMAGE = { maxBytes: 5 * 1024 * 1024, allowedTypes: ['image/jpeg', 'image/png'], typeError: 'Only JPG or PNG images are allowed.' }

const EMPTY_FORM: WorkshopForm = {
  title: '', tagline: '', description: '',
  date: '', time: '', duration: '60', closesDate: '', closesTime: '',
  pricing: 'free', price: '', originalPrice: '', capacity: '',
  hostName: '', hostTitle: '', zoomLink: '', takeaways: [''],
  hostImage: '', aboutHost: '', coHosts: [], audience: [''], bring: [''], agenda: [], faq: [],
  testimonials: [], languages: [], level: '', videoUrls: [''], videoHeading: '',
  brandName: '', brandLogo: '', coverImage: '', contactDetails: [], socialLinks: [],
  refundDoc: '', termsDoc: '', privacyDoc: '',
theme: DEFAULT_LANDING_THEME_ID, fontPair: 'theme-default', landingConfig: normalizeWorkshopLandingConfig(null), notifyWhatsapp: true, notifyTelegram: true, }

const digitsOnly = (v: string) => v.replace(/\D/g, '')
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const strList = (v: unknown): string[] => {
  const list = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  return list.length ? list : [''] // always show one empty row to type in
}

/** Database row -> form state. Tolerant of null / missing columns. */
function rowToForm(row: any): WorkshopForm {
  const { date, time } = row.date_time ? isoToISTParts(row.date_time) : { date: '', time: '' }
  const closes = row.registration_closes_at ? isoToISTParts(row.registration_closes_at) : { date: '', time: '' }
  return {
    title: str(row.title), tagline: str(row.tagline), description: str(row.description),
    date, time, closesDate: closes.date, closesTime: closes.time,
    // Older workshops have no duration: show 60 min. It is saved on the next Save.
    duration: String(row.duration_minutes || 60),
    pricing: row.price > 0 ? 'paid' : 'free',
    price: row.price > 0 ? String(row.price) : '',
    originalPrice: row.original_price ? String(row.original_price) : '',
    capacity: row.capacity != null ? String(row.capacity) : '',
    hostName: str(row.host_name), hostTitle: str(row.instructor_title), zoomLink: str(row.zoom_link),
    takeaways: strList(row.what_you_will_learn),
    hostImage: str(row.host_image), aboutHost: str(row.about_creator),
    coHosts: (Array.isArray(row.co_instructors) ? row.co_instructors : []).map((h: any) => ({
      name: str(h?.name), title: str(h?.title), image: str(h?.image), bio: str(h?.bio),
    })),
    audience: strList(row.target_audience),
    bring: strList(row.requirements),
    agenda: normalizeAgenda(row.agenda),
    faq: (Array.isArray(row.faq) ? row.faq : []).map((f: any) => ({ question: str(f?.question), answer: str(f?.answer) })),
    testimonials: cleanTestimonials(row.testimonials),
    languages: (Array.isArray(row.language) ? row.language : []).filter((l: unknown): l is string => typeof l === 'string'),
    level: str(row.level),
    videoUrls: strList(row.promo_video_urls), videoHeading: str(row.promo_video_heading),
    brandName: str(row.brand_name), brandLogo: str(row.brand_logo_url), coverImage: str(row.cover_image_url),
    contactDetails: parseContactDetails(row.contact_details),
    socialLinks: parseSocialLinks(row.social_links),
    refundDoc: str(row.refund_policy_storage_path), termsDoc: str(row.terms_storage_path), privacyDoc: str(row.privacy_storage_path),
    theme: str(row.landing_theme) || DEFAULT_LANDING_THEME_ID,
    fontPair: str(row.landing_font_pair) || 'theme-default',
landingConfig: normalizeWorkshopLandingConfig(row.landing_config),
notifyWhatsapp: row.notify_whatsapp !== false,
notifyTelegram: row.notify_telegram !== false,
} }

export default function WorkshopSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()

  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [creatorId, setCreatorId] = useState('')
  const [creatorSlug, setCreatorSlug] = useState('')
  const [slug, setSlug] = useState('')
  const [status, setStatus] = useState('published')
  const [heldSpots, setHeldSpots] = useState(0)

  const [form, setForm] = useState<WorkshopForm>(EMPTY_FORM)
  const [savedForm, setSavedForm] = useState<WorkshopForm>(EMPTY_FORM)
  const [tab, setTab] = useState<Tab>('details')

  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [error, setError] = useState('')
  const [statusBusy, setStatusBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  const set = <K extends keyof WorkshopForm>(key: K, value: WorkshopForm[K]) =>
    setForm(prev => ({ ...prev, [key]: value }))

  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(savedForm), [form, savedForm])
  const published = status === 'published'
  // Only draft <-> published can be toggled here. Cancelled / completed workshops
  // are never reopened by accident from this screen.
  const canToggle = status === 'published' || status === 'draft'

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }
      setCreatorId(user.id)

      const [workshopRes, creatorRes] = await Promise.all([
        supabase.from('workshops').select('*').eq('id', id).eq('creator_id', user.id).maybeSingle(),
        supabase.from('creators').select('creator_slug').eq('id', user.id).maybeSingle(),
      ])
      if (workshopRes.error) console.error('[workshop settings] load failed', workshopRes.error)
      if (!workshopRes.data) { setNotFound(true); setLoading(false); return }

      const row = workshopRes.data
      const loaded = rowToForm(row)
      setForm(loaded)
      setSavedForm(loaded)
      setSlug(row.slug || '')
      setStatus(row.status || 'published')
      setCreatorSlug(creatorRes.data?.creator_slug || '')

      try {
        setHeldSpots(await countHeldSpots(supabase, id))
      } catch (err) {
        console.error('[workshop settings] could not count taken seats', err)
      }
      setLoading(false)
    }
    load()
  }, [id, router])

  // Warn before closing the tab with unsaved edits.
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const durationChoices = useMemo(() => {
    const minutes = new Set<number>(WORKSHOP_DURATION_OPTIONS)
    const current = parseInt(form.duration, 10)
    if (Number.isFinite(current)) minutes.add(current)
    return Array.from(minutes).sort((a, b) => a - b).map(m => ({ value: String(m), label: formatWorkshopDuration(m) }))
  }, [form.duration])

  const pagePath = `/w/${creatorSlug}/${slug}`
  const startsAtIso = istDateTimeToISO(savedForm.date, savedForm.time)

  async function copyLink() {
    const url = `${window.location.origin}${pagePath}`
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      window.prompt('Copy this link:', url)
    }
  }

  async function handleSave() {
    if (saving || !dirty) return
    setError('')

    const dateTimeChanged = form.date !== savedForm.date || form.time !== savedForm.time
    const closesChanged = form.closesDate !== savedForm.closesDate || form.closesTime !== savedForm.closesTime
    const fields = validateWorkshopFields(form, { requireFutureStart: dateTimeChanged, minSeats: heldSpots, requireFutureClose: closesChanged })
    if (!fields.ok) { setError(fields.error); setTab(fields.section); return }
    const content = validateWorkshopContent(form)
    if (!content.ok) { setError(content.error); setTab(content.section); return }
    const branding = validateWorkshopBranding(form)
    if (!branding.ok) { setError(branding.error); setTab(branding.section); return }
    const design = validateWorkshopDesign(form)
    if (!design.ok) { setError(design.error); setTab(design.section); return }

    if (dateTimeChanged && heldSpots > 0 && !window.confirm(
      `${heldSpots} ${heldSpots === 1 ? 'person has' : 'people have'} already registered. They are not told automatically when the date or time changes, so message them yourself. Save the new time?`
    )) return

    setSaving(true)
    try {
      const { data, error: updateError } = await supabase
        .from('workshops')
        .update({ ...fields.data, ...content.data, ...branding.data, ...design.data })
        .eq('id', id)
        .eq('creator_id', creatorId)
        .select('id')
        .maybeSingle()
      if (updateError) {
        console.error('[workshop settings] save failed', updateError)
        setError(updateError.message)
        return
      }
      if (!data) {
        console.error('[workshop settings] save matched no row', { id, creatorId })
        setError('Could not save. This workshop was not found, or you no longer have access to it.')
        return
      }

      // The save worked: now it is safe to delete policy files that are no longer used.
      for (const { key } of POLICY_DOCS) {
        if (savedForm[key] && savedForm[key] !== form[key]) void removePublicFile(savedForm[key])
      }
  // Channel switches are saved on their own, and only when changed, so the rest of the page
  // always saves even if the channel columns have not been set up yet.
  if (form.notifyWhatsapp !== savedForm.notifyWhatsapp || form.notifyTelegram !== savedForm.notifyTelegram) {
    const { error: channelError } = await supabase
      .from('workshops')
      .update({ notify_whatsapp: form.notifyWhatsapp, notify_telegram: form.notifyTelegram })
      .eq('id', id)
      .eq('creator_id', creatorId)
    if (channelError) {
      console.error('[workshop settings] channel save failed', channelError)
      setError('Your page was saved, but the channel switches could not be saved yet: ' + channelError.message)
      return
    }
  }
  setSavedForm(form)
  setSavedFlash(true)
  setTimeout(() => setSavedFlash(false), 2500)
} catch (err: any) {
  console.error('[workshop settings] unexpected save failure', err)
      setError(err?.message || 'Something went wrong. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  async function changeStatus(next: 'published' | 'draft') {
    if (statusBusy) return
    if (next === 'draft' && !window.confirm(
      'Unpublish this workshop? Its page will show as unavailable, new registrations stop, and reminders to people who already registered pause until you publish it again.'
    )) return
    setError('')
    setStatusBusy(true)
    try {
      const { data, error: statusError } = await supabase
        .from('workshops')
        .update({ status: next })
        .eq('id', id)
        .eq('creator_id', creatorId)
        .select('status')
        .maybeSingle()
      if (statusError) {
        console.error('[workshop settings] status change failed', statusError)
        setError(statusError.message.includes('check constraint')
          ? `The database does not accept the status "${next}" yet (${statusError.message}). Allow it in the workshops status check constraint.`
          : statusError.message)
        return
      }
      if (!data) { setError('Could not change the status. Workshop not found.'); return }
      setStatus(next)
    } finally {
      setStatusBusy(false)
    }
  }

  const cfg = form.landingConfig
  const setConfig = (next: typeof cfg) => set('landingConfig', next)

  /** Same rule the public page uses: a section with nothing to show renders nothing. */
  function sectionHasContent(type: WorkshopSectionType, customId?: string): boolean {
    if (type === 'custom') {
      const cs = cfg.customSections.find(c => c.id === customId)
      return !!cs && (cs.heading.trim().length > 0 || cs.body.trim().length > 0 || cs.images.length > 0)
    }
    return workshopSectionHasContent(type, {
      videoUrls: form.videoUrls, takeaways: form.takeaways, agenda: form.agenda, audience: form.audience, bring: form.bring,
      bonuses: cfg.bonuses, testimonialCount: cleanTestimonials(form.testimonials).length, faqCount: cleanFaq(form.faq).length,
      disclaimerText: cfg.disclaimer.text,
    })
  }

  function toggleLanguage(language: string) {
    set('languages', form.languages.includes(language)
      ? form.languages.filter(l => l !== language)
      : [...form.languages, language])
  }

  // ─── AI context ────────────────────────────────────────────────────────────
  // Collects all currently-filled text fields so the AI has full context
  // for whichever single field it's writing. Rebuilt on every render (cheap).
  const aiContext = {
    title: form.title,
    tagline: form.tagline,
    description: form.description,
    hostName: form.hostName,
    hostTitle: form.hostTitle,
    aboutHost: form.aboutHost,
    takeaways: form.takeaways.filter(Boolean),
    audience: form.audience.filter(Boolean),
    bring: form.bring.filter(Boolean),
    pricing: form.pricing,
    price: form.price,
    duration: form.duration,
    level: form.level,
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  if (loading || notFound) {
    return (
      <div className="min-h-screen bg-black">
        <Sidebar />
        <main className="md:ml-56 p-6 md:p-8 pt-20 md:pt-8 max-w-3xl">
          {notFound ? (
            <>
              <h1 className="text-xl font-bold text-white mb-2">Workshop not found</h1>
              <p className="text-sm mb-4" style={{ color: 'var(--kurso-text-muted)' }}>It may have been removed, or it belongs to another account.</p>
              <Link href="/dashboard/workshops" className="text-sm underline" style={{ color: 'var(--kurso-primary-lightest)' }}>Back to workshops</Link>
            </>
          ) : (
            <p className="text-sm" style={{ color: 'var(--kurso-text-muted)' }}>Loading…</p>
          )}
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-black">
      <Sidebar />
      <main className="md:ml-56 p-6 md:p-8 pt-20 md:pt-8 pb-28 max-w-3xl">
        <Link href="/dashboard/workshops"
          className="inline-flex items-center gap-2 text-sm mb-5 hover:opacity-80"
          style={{ color: 'var(--kurso-text-secondary)' }}>
          <ArrowLeft className="w-4 h-4" /> Back to workshops
        </Link>

        <h1 className="text-2xl font-bold text-white mb-1 break-words">{savedForm.title || 'Workshop settings'}</h1>
        <p className="text-sm mb-6" style={{ color: 'var(--kurso-text-muted)' }}>
          {startsAtIso ? `Starts ${formatWorkshopDateTime(startsAtIso)} IST` : 'Workshop settings'}
        </p>

        {/* Status + link */}
        <div className="rounded-2xl p-5 mb-6 glass" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <span className="text-[13px] font-semibold px-3 py-1 rounded-full whitespace-nowrap"
                style={published
                  ? { background: 'rgba(74,222,128,0.15)', color: 'var(--kurso-success)' }
                  : { background: 'rgba(245,158,11,0.15)', color: 'var(--kurso-text-secondary)' }}>
                {workshopStatusLabel(status)}
              </span>
              <p className="text-sm truncate" style={{ color: 'var(--kurso-text-secondary)' }}>
                {creatorSlug ? pagePath : 'Set your creator link in Settings to get a page link'}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {published && creatorSlug && (
                <>
                  <a href={pagePath} target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-[13px] font-medium"
                    style={{ background: 'rgba(255,255,255,0.08)', color: 'var(--kurso-text-secondary)' }}>
                    <ExternalLink className="w-3.5 h-3.5" /> View page
                  </a>
                  <button type="button" onClick={copyLink}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-[13px] font-medium"
                    style={{ background: 'rgba(255,255,255,0.08)', color: 'var(--kurso-text-secondary)' }}>
                    {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    {copied ? 'Copied' : 'Copy link'}
                  </button>
                </>
              )}
              {canToggle && (
                <button type="button" disabled={statusBusy}
                  onClick={() => changeStatus(published ? 'draft' : 'published')}
                  className={published
                    ? 'px-3 py-2 rounded-xl text-[13px] font-medium disabled:opacity-50'
                    : 'px-4 py-2 rounded-xl text-[13px] font-semibold text-white violet-gradient disabled:opacity-50'}
                  style={published ? { background: 'rgba(248,113,113,0.12)', color: 'var(--kurso-danger)' } : undefined}>
                  {statusBusy ? 'Please wait…' : published ? 'Unpublish' : 'Publish'}
                </button>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 mt-4 text-[13px]" style={{ color: 'var(--kurso-text-muted)' }}>
            <Users className="w-4 h-4" />
            {heldSpots} {heldSpots === 1 ? 'seat' : 'seats'} taken{form.capacity ? ` of ${form.capacity}` : ''}
            <span aria-hidden>·</span>
            <Link href="/dashboard/workshops" className="underline" style={{ color: 'var(--kurso-primary-lightest)' }}>See registrations</Link>
            <span aria-hidden>·</span>
            <Link href={`/dashboard/workshops/${id}/certificates`} className="inline-flex items-center gap-1 underline" style={{ color: 'var(--kurso-primary-lightest)' }}>
              <Award className="w-3.5 h-3.5" /> Certificates
            </Link>
          </div>
          {!published && (
            <p className="text-sm mt-3" style={{ color: 'var(--kurso-text-secondary)' }}>
              {status === 'draft'
                ? "This workshop is a draft. People can't open its page or register until you publish it."
                : `This workshop is marked ${workshopStatusLabel(status).toLowerCase()}, so its page is closed to new registrations.`}
            </p>
          )}
        </div>

        {/* AI tip: AI lives under each field now */}
        <p className="flex items-center gap-2 text-[14px] mb-6" style={{ color: 'var(--kurso-hint)' }}>
          <Sparkles className="w-4 h-4 shrink-0" style={{ color: 'var(--kurso-primary-light)' }} />
          Stuck on what to write? Tap “Write with AI” under any field. Fill in your title and description first for better results.
        </p>

        {/* Tabs */}
        <div role="tablist" className="flex flex-wrap gap-2 mb-6">
          {TABS.map(t => (
            <button key={t.id} role="tab" type="button" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
              className="px-4 py-2 rounded-xl text-sm font-medium transition-all"
              style={tab === t.id
                ? { background: 'rgba(var(--kurso-primary-rgb), 0.18)', color: 'var(--kurso-primary-lightest)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.35)' }
                : { background: 'rgba(255,255,255,0.05)', color: 'var(--kurso-text-secondary)', border: '1px solid transparent' }}>
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'details' && (
          <div className="flex flex-col gap-6">
            <FormCard title="The basics">
              <FormField label="Workshop title" htmlFor="ws-title" required counter={`${form.title.length}/${WORKSHOP_LIMITS.title}`}
                hint="Changing the title does not change your page link, so links you already shared keep working.">
                <TextInput id="ws-title" value={form.title} onChange={v => set('title', v)} maxLength={WORKSHOP_LIMITS.title} />
              </FormField>
              <FormField label="One-line promise" htmlFor="ws-tagline" tag="recommended" counter={`${form.tagline.length}/${MAX_TAGLINE_LENGTH}`}
                hint="Shown right under the title. Say what people walk away with.">
                <TextInput id="ws-tagline" value={form.tagline} onChange={v => set('tagline', v)} maxLength={MAX_TAGLINE_LENGTH}
                  placeholder="e.g. Live, hands-on, with ready-to-use templates" />
                <AiFieldAssist field="tagline" entityType="workshop" context={aiContext} currentValue={form.tagline}
                  onResult={v => set('tagline', typeof v === 'string' ? v : '')} className="mt-1.5" />
              </FormField>
              <FormField label="Description" htmlFor="ws-description" tag="optional" counter={`${form.description.length}/${WORKSHOP_LIMITS.description}`}
                hint="A few lines about the workshop. Also used for Google search results.">
                <TextArea id="ws-description" rows={4} value={form.description} onChange={v => set('description', v)}
                  maxLength={WORKSHOP_LIMITS.description} placeholder="What will you cover, and who is it for?" />
                <AiFieldAssist field="description" entityType="workshop" context={aiContext} currentValue={form.description}
                  onResult={v => set('description', typeof v === 'string' ? v : '')} className="mt-1.5" />
              </FormField>
            </FormCard>

            <FormCard title="When and how much" description="All times are in IST (India Standard Time).">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <FormField label="Date" htmlFor="ws-date" required>
                  <TextInput id="ws-date" type="date" value={form.date} onChange={v => set('date', v)} placeholder="" />
                </FormField>
                <FormField label="Start time (IST)" htmlFor="ws-time" required>
                  <TextInput id="ws-time" type="time" value={form.time} onChange={v => set('time', v)} placeholder="" />
                </FormField>
                <FormField label="Duration" htmlFor="ws-duration" required>
                  <SelectInput id="ws-duration" value={form.duration} onChange={v => set('duration', v)} options={durationChoices} />
                </FormField>
              </div>
              {heldSpots > 0 && (form.date !== savedForm.date || form.time !== savedForm.time) && (
                <div className="flex items-start gap-3 rounded-xl p-4"
                  style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.35)' }}>
                  <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" style={{ color: '#f59e0b' }} />
                  <p className="text-sm" style={{ color: 'var(--kurso-text-secondary)' }}>
                    {heldSpots} {heldSpots === 1 ? 'person has' : 'people have'} already registered. They are not told automatically when the time changes, so message them yourself.
                  </p>
                </div>
              )}

              <FormField label="Registration closes" tag="optional"
                hint="Leave empty to keep registration open until the workshop ends. After this time the page shows “Registration is closed”.">
                <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-3 items-center">
                  <TextInput aria-label="Registration closes, date" type="date" value={form.closesDate ?? ''} onChange={v => set('closesDate', v)} placeholder="" />
                  <TextInput aria-label="Registration closes, time (IST)" type="time" value={form.closesTime ?? ''} onChange={v => set('closesTime', v)} placeholder="" />
                  {(form.closesDate || form.closesTime) && (
                    <button type="button" className="text-sm underline text-left"
                      style={{ color: 'var(--kurso-text-secondary)' }}
                      onClick={() => { set('closesDate', ''); set('closesTime', '') }}>Clear</button>
                  )}
                </div>
              </FormField>

              <FormField label="Price" required>
                <SegmentedControl ariaLabel="Free or paid" value={form.pricing} onChange={v => set('pricing', v)}
                  options={[{ value: 'free', label: 'Free' }, { value: 'paid', label: 'Paid' }]} />
              </FormField>
              {form.pricing === 'paid' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <FormField label="Price per seat" htmlFor="ws-price" required>
                    <TextInput id="ws-price" inputMode="numeric" prefix="₹" value={form.price}
                      onChange={v => set('price', digitsOnly(v))} placeholder="499" />
                  </FormField>
                  <FormField label="Original price" htmlFor="ws-original-price" tag="optional"
                    hint="Shown crossed out. Must be higher than the price.">
                    <TextInput id="ws-original-price" inputMode="numeric" prefix="₹" value={form.originalPrice}
                      onChange={v => set('originalPrice', digitsOnly(v))} placeholder="999" />
                  </FormField>
                </div>
              )}

              <FormField label="Seats available" htmlFor="ws-capacity" tag="optional"
                hint={heldSpots > 0
                  ? `Leave empty for unlimited. ${heldSpots} ${heldSpots === 1 ? 'seat is' : 'seats are'} already taken, so you can't go below that.`
                  : 'Leave empty for unlimited. The page shows how many seats are left.'}>
                <TextInput id="ws-capacity" inputMode="numeric" value={form.capacity}
                  onChange={v => set('capacity', digitsOnly(v))} placeholder="e.g. 100" />
              </FormField>
            </FormCard>

            <FormCard title="Joining link" tag="recommended" description="Attendees can't join without it.">
              <FormField label="Zoom / Google Meet link" htmlFor="ws-zoom"
                hint="Only confirmed registrants receive it, by email and on the channels you switch on below. It is never shown on your public page.">
                <TextInput id="ws-zoom" type="url" value={form.zoomLink} onChange={v => set('zoomLink', v)} placeholder="https://zoom.us/j/..." />
              </FormField>
            </FormCard>

            <FormCard title="How students hear from you" description="Choose where confirmations and reminders go. Email is always on.">
              <ChannelSwitches kind="workshop" whatsapp={form.notifyWhatsapp} telegram={form.notifyTelegram}
                onChange={next => setForm(prev => ({ ...prev, notifyWhatsapp: next.whatsapp, notifyTelegram: next.telegram }))} />
            </FormCard>
          </div>
        )}

        {tab === 'content' && (
          <div className="flex flex-col gap-6">
            <FormCard title="Your host" description="People join people. Show who is teaching.">
              <FormField label="Host name" htmlFor="ws-host" required>
                <TextInput id="ws-host" value={form.hostName} onChange={v => set('hostName', v)} maxLength={WORKSHOP_LIMITS.hostName} />
              </FormField>
              <FormField label="Title or credential" htmlFor="ws-host-title" tag="recommended"
                hint="A specific credential builds trust, for example “Digital marketer, 8+ years”.">
                <TextInput id="ws-host-title" value={form.hostTitle} onChange={v => set('hostTitle', v)} maxLength={WORKSHOP_LIMITS.hostTitle}
                  placeholder="e.g. Certified SEO consultant · 8+ years" />
              </FormField>

              <FormField label="Host photo" tag="recommended" hint="A clear, square photo works best. JPG, PNG or WebP, up to 2MB.">
                <ImageUploadField id="ws-host-photo" shape="circle" value={form.hostImage}
                  fallback={(form.hostName || '?').charAt(0).toUpperCase()} uploadLabel="Upload photo"
                  onChange={v => set('hostImage', v)} onUpload={file => uploadPublicImage(file, 'images')} onError={setError} />
              </FormField>

              <FormField label="About the host" htmlFor="ws-about" tag="optional" counter={`${form.aboutHost.length}/${WORKSHOP_CONTENT_LIMITS.aboutHost}`}>
                <TextArea id="ws-about" rows={4} value={form.aboutHost} onChange={v => set('aboutHost', v)}
                  maxLength={WORKSHOP_CONTENT_LIMITS.aboutHost} placeholder="Your background and why people should learn from you." />
                <AiFieldAssist field="aboutHost" entityType="workshop" context={aiContext} currentValue={form.aboutHost}
                  onResult={v => set('aboutHost', typeof v === 'string' ? v : '')} className="mt-1.5" />
              </FormField>

              <FormField label="Co-hosts" tag="optional" hint="Add anyone teaching alongside you.">
                <CoInstructorsEditor value={form.coHosts} onChange={v => set('coHosts', v)}
                  onUpload={file => uploadPublicImage(file, 'images')} />
              </FormField>
            </FormCard>

            <FormCard title="What will people learn?" tag="recommended" description="Clear takeaways are the strongest reason to register.">
              <StringListEditor value={form.takeaways} onChange={v => set('takeaways', v)}
                max={WORKSHOP_LIMITS.takeaways} itemMaxLength={WORKSHOP_LIMITS.takeawayLength}
                ariaLabel="Takeaway" placeholders={['e.g. Pick a profitable niche in 15 minutes', 'Another takeaway']} />
              <AiFieldAssist field="takeaways" entityType="workshop" context={aiContext} currentValue={form.takeaways}
                onResult={v => Array.isArray(v) && set('takeaways', v as string[])} className="mt-1" />
            </FormCard>

            <FormCard title="Quick facts" tag="optional" description="Shown as small labels near the top of your page.">
              <FormField label="Language">
                <div className="flex flex-wrap gap-2" role="group" aria-label="Workshop language">
                  {LANDING_LANGUAGES.map(language => {
                    const on = form.languages.includes(language)
                    return (
                      <button key={language} type="button" aria-pressed={on} onClick={() => toggleLanguage(language)}
                        className="px-3 py-1.5 rounded-full text-[13px] font-medium"
                        style={on
                          ? { background: 'rgba(var(--kurso-primary-rgb), 0.18)', color: 'var(--kurso-primary-lightest)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.35)' }
                          : { background: 'rgba(255,255,255,0.05)', color: 'var(--kurso-text-secondary)', border: '1px solid transparent' }}>
                        {language}
                      </button>
                    )
                  })}
                </div>
              </FormField>
              <FormField label="Level" htmlFor="ws-level">
                <SelectInput id="ws-level" value={form.level} onChange={v => set('level', v)}
                  options={[{ value: '', label: 'Not specified' }, ...LANDING_LEVELS.map(l => ({ value: l, label: l }))]} />
              </FormField>
            </FormCard>

            <FormCard title="Who is this for?" tag="optional">
              <StringListEditor value={form.audience} onChange={v => set('audience', v)}
                max={WORKSHOP_CONTENT_LIMITS.listItems} itemMaxLength={WORKSHOP_CONTENT_LIMITS.listItemLength}
                ariaLabel="Audience" placeholders={['e.g. Freelancers who want more clients', 'Another audience']} />
              <AiFieldAssist field="audience" entityType="workshop" context={aiContext} currentValue={form.audience}
                onResult={v => Array.isArray(v) && set('audience', v as string[])} className="mt-1" />
            </FormCard>

            <FormCard title="What to bring" tag="optional" description="Anything attendees should prepare or have ready.">
              <StringListEditor value={form.bring} onChange={v => set('bring', v)}
                max={WORKSHOP_CONTENT_LIMITS.listItems} itemMaxLength={WORKSHOP_CONTENT_LIMITS.listItemLength}
                ariaLabel="Item to bring" placeholders={['e.g. A laptop with Google Sheets open', 'Another item']} />
              <AiFieldAssist field="bring" entityType="workshop" context={aiContext} currentValue={form.bring}
                onResult={v => Array.isArray(v) && set('bring', v as string[])} className="mt-1" />
            </FormCard>

            <FormCard title="Agenda" tag="optional" description="What happens during the session, step by step.">
              <AgendaEditor value={form.agenda} onChange={v => set('agenda', v)}
                max={MAX_AGENDA_ITEMS} titleMax={MAX_AGENDA_TITLE_LENGTH} descriptionMax={MAX_AGENDA_DESCRIPTION_LENGTH} />
              <AiFieldAssist field="agenda" entityType="workshop" context={aiContext} currentValue={form.agenda}
                onResult={v => set('agenda', normalizeAgenda(v).slice(0, MAX_AGENDA_ITEMS))} className="mt-1" />
            </FormCard>

            <FormCard title="Promo videos" tag="optional" description="Up to 3 YouTube or Vimeo links, for example a short intro or a clip from a past session.">
              <FormField label="Section heading" htmlFor="ws-video-heading" hint="Leave empty to use the default heading." counter={`${form.videoHeading.length}/${WORKSHOP_CONTENT_LIMITS.videoHeading}`}>
                <TextInput id="ws-video-heading" value={form.videoHeading} onChange={v => set('videoHeading', v)}
                  maxLength={WORKSHOP_CONTENT_LIMITS.videoHeading} placeholder="e.g. See what the workshop is like" />
              </FormField>
              <StringListEditor value={form.videoUrls} onChange={v => set('videoUrls', v)}
                max={WORKSHOP_CONTENT_LIMITS.promoVideos} itemMaxLength={300}
                ariaLabel="Video link" addLabel="Add video" placeholders={['https://www.youtube.com/watch?v=...', 'Another video link']} />
            </FormCard>

            <FormCard title="Bonuses" tag="optional" description="Extras that come with the workshop, like templates or recordings. Switch the Bonuses section on in the Design tab.">
              <BonusesEditor config={cfg} onChange={setConfig} />
            </FormCard>

            <FormCard title="Testimonials" tag="optional" description="Words or screenshots from people who attended your sessions before.">
              <TestimonialsEditor value={form.testimonials} onChange={v => set('testimonials', v)} onError={setError}
                onUpload={(file, kind) => uploadPublicImage(file, `testimonials/${kind === 'photo' ? 'photos' : 'screenshots'}/workshop-${id}`, TESTIMONIAL_IMAGE)} />
            </FormCard>

            <FormCard title="FAQ" tag="optional" description="Answer the questions people ask before they register.">
              <FaqEditor value={form.faq} onChange={v => set('faq', v)}
                max={WORKSHOP_CONTENT_LIMITS.faqItems} questionMax={WORKSHOP_CONTENT_LIMITS.faqQuestion} answerMax={WORKSHOP_CONTENT_LIMITS.faqAnswer} />
              <AiFieldAssist field="faq" entityType="workshop" context={aiContext} currentValue={form.faq}
                onResult={v => {
                  const faq = cleanFaq(v)
                  if (faq.length > 0) set('faq', faq)
                }} className="mt-1" />
            </FormCard>

            <FormCard title="Custom sections" tag="optional" description="Add your own text and images anywhere on the page. Reorder them in the Design tab.">
              <CustomSectionsEditor config={cfg} onChange={setConfig} onError={setError}
                onUpload={file => uploadPublicImage(file, 'custom-section-images', CUSTOM_SECTION_IMAGE)} />
            </FormCard>

            <FormCard title="Disclaimer" tag="optional" description="A legal, safety or results notice. Switch the Disclaimer section on in the Design tab.">
              <FormField label="Title" htmlFor="ws-disclaimer-title" counter={`${cfg.disclaimer.title.length}/${MAX_DISCLAIMER_TITLE_LENGTH}`}>
                <TextInput id="ws-disclaimer-title" value={cfg.disclaimer.title} maxLength={MAX_DISCLAIMER_TITLE_LENGTH}
                  onChange={v => setConfig({ ...cfg, disclaimer: { ...cfg.disclaimer, title: v } })} />
              </FormField>
              <FormField label="Text" htmlFor="ws-disclaimer-text" counter={`${cfg.disclaimer.text.length}/${MAX_DISCLAIMER_TEXT_LENGTH}`}>
                <TextArea id="ws-disclaimer-text" rows={4} value={cfg.disclaimer.text} maxLength={MAX_DISCLAIMER_TEXT_LENGTH}
                  placeholder="e.g. Results vary. This workshop is for education only."
                  onChange={v => setConfig({ ...cfg, disclaimer: { ...cfg.disclaimer, text: v } })} />
              </FormField>
            </FormCard>
          </div>
        )}

        {tab === 'branding' && (
          <div className="flex flex-col gap-6">
            <FormCard title="Brand" tag="optional" description="Make the page look like yours.">
              <FormField label="Brand name" htmlFor="ws-brand-name" counter={`${form.brandName.length}/${WORKSHOP_CONTENT_LIMITS.brandName}`}
                hint="Shown with your logo. Leave empty to use your name.">
                <TextInput id="ws-brand-name" value={form.brandName} onChange={v => set('brandName', v)}
                  maxLength={WORKSHOP_CONTENT_LIMITS.brandName} placeholder="e.g. Growth Studio" />
              </FormField>
              <FormField label="Logo" hint="A square logo on a transparent background looks best. Up to 2MB.">
                <ImageUploadField id="ws-logo" shape="square" value={form.brandLogo} uploadLabel="Upload logo"
                  onChange={v => set('brandLogo', v)} onUpload={file => uploadPublicImage(file, 'brand-logos')} onError={setError} />
              </FormField>
              <FormField label="Cover image" hint="A wide image (16:9 works best). Used on your page and when your link is shared. Up to 2MB.">
                <ImageUploadField id="ws-cover" shape="wide" value={form.coverImage} uploadLabel="Upload cover"
                  onChange={v => set('coverImage', v)} onUpload={file => uploadPublicImage(file, 'images')} onError={setError} />
              </FormField>
            </FormCard>

            <FormCard title="Contact details" tag="optional" description="Let people reach you with questions before they register.">
              <ContactDetailsEditor value={form.contactDetails} onChange={v => set('contactDetails', v)} />
            </FormCard>

            <FormCard title="Social links" tag="optional" description="Shown in your page footer.">
              <SocialLinksEditor value={form.socialLinks} onChange={v => set('socialLinks', v)} />
            </FormCard>

            <FormCard title="Policies" tag="optional"
              description="Upload a .txt or .md file for each (up to 20KB). Paid workshops should have a refund policy, and payment providers often ask for these.">
              <div className="flex flex-col gap-3">
                {POLICY_DOCS.map(doc => (
                  <PolicyDocField key={doc.key} id={`ws-${doc.key}`} label={doc.label} value={form[doc.key]}
                    onChange={v => set(doc.key, v)} onError={setError}
                    onUpload={file => uploadPolicyDoc(file, `policies/workshop-${id}`)} />
                ))}
              </div>
            </FormCard>
          </div>
        )}

        {tab === 'design' && (
          <div className="flex flex-col gap-6">
            <FormCard title="Theme" description="Colors, background and heading style for your whole page.">
              <ThemePicker value={form.theme} onChange={v => set('theme', v)} />
              {published && creatorSlug && (
                <a href={`${pagePath}?theme=${encodeURIComponent(form.theme)}`} target="_blank" rel="noopener noreferrer"
                  className="self-start text-sm font-medium underline" style={{ color: 'var(--kurso-primary-lightest)' }}>
                  Preview this theme on your live page (shows your saved page)
                </a>
              )}
            </FormCard>

            <FormCard title="Font style" description="Pick the typeface for headings. Body text stays easy to read.">
              <FontPairPicker value={form.fontPair} onChange={v => set('fontPair', v)} />
            </FormCard>

            <FormCard title="Text and photo" tag="optional">
              <FormField label="Text size" hint="Large is easier to read on phones. There is no smaller option on purpose.">
                <SegmentedControl ariaLabel="Page text size" value={cfg.textSize} onChange={v => setConfig({ ...cfg, textSize: v })}
                  options={[{ value: 'standard', label: 'Standard' }, { value: 'large', label: 'Large' }]} />
              </FormField>
              <FormField label="Host photo shape">
                <SegmentedControl ariaLabel="Host photo shape" value={cfg.instructorLayout} onChange={v => setConfig({ ...cfg, instructorLayout: v })}
                  options={[{ value: 'square', label: 'Square' }, { value: 'rectangle', label: 'Rectangle' }]} />
              </FormField>
            </FormCard>

            <FormCard title="Sections" description="Switch sections on or off and move them up or down. The top banner and the register bar always stay in place. A section with nothing in it never shows on your page.">
              <SectionList config={cfg} onChange={setConfig} hasContent={sectionHasContent} />
            </FormCard>

            <FormCard title="Register button and bar" description="The sticky bar keeps your register button in reach, especially on phones.">
              <FormField label="Register button text" htmlFor="ws-btn-text" tag="optional" counter={`${cfg.registerButtonText.length}/${MAX_ENROLL_BUTTON_CHARS}`}
                hint={`Up to 4 words. Leave empty to use “${DEFAULT_REGISTER_BUTTON_TEXT}”.`}>
                <TextInput id="ws-btn-text" value={cfg.registerButtonText} maxLength={MAX_ENROLL_BUTTON_CHARS}
                  onChange={v => setConfig({ ...cfg, registerButtonText: v })} placeholder={DEFAULT_REGISTER_BUTTON_TEXT} />
              </FormField>
              <FormField label="Bar message" htmlFor="ws-cta-text" tag="optional" hint={`One short line, up to ${MAX_FINAL_CTA_WORDS} words.`}>
                <TextInput id="ws-cta-text" value={cfg.finalCtaText} onChange={v => setConfig({ ...cfg, finalCtaText: v })} />
              </FormField>
              <FormField label="Bar button text" htmlFor="ws-bar-btn-text" tag="optional" counter={`${cfg.finalCtaButtonText.length}/${MAX_ENROLL_BUTTON_CHARS}`}
                hint="Leave empty to use the same text as the register button.">
                <TextInput id="ws-bar-btn-text" value={cfg.finalCtaButtonText} maxLength={MAX_ENROLL_BUTTON_CHARS}
                  onChange={v => setConfig({ ...cfg, finalCtaButtonText: v })} placeholder={cfg.registerButtonText || DEFAULT_REGISTER_BUTTON_TEXT} />
              </FormField>

              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-white">Show a countdown</p>
                  <p className="text-[13px]" style={{ color: 'var(--kurso-text-muted)' }}>Counts down to your start time automatically.</p>
                </div>
                <ToggleSwitch checked={cfg.showCountdown} label="Show a countdown" onChange={v => setConfig({ ...cfg, showCountdown: v })} />
              </div>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-white">Show seats left</p>
                  <p className="text-[13px]" style={{ color: 'var(--kurso-text-muted)' }}>Only appears when you set a seat limit.</p>
                </div>
                <ToggleSwitch checked={cfg.showSeatsLeft} label="Show seats left" onChange={v => setConfig({ ...cfg, showSeatsLeft: v })} />
              </div>
            </FormCard>
          </div>
        )}
      </main>

      {/* Sticky save bar */}
      <div className="fixed bottom-0 left-0 right-0 md:left-56 z-30 px-4 md:px-8 py-3 flex items-center justify-between gap-4"
        style={{ background: 'rgba(0,0,0,0.92)', borderTop: '1px solid rgba(255,255,255,0.1)', backdropFilter: 'blur(8px)' }}>
        <p role={error ? 'alert' : 'status'} className="text-sm min-w-0"
          style={{ color: error ? 'var(--kurso-danger)' : dirty ? 'var(--kurso-text-secondary)' : 'var(--kurso-text-muted)' }}>
          {error || (savedFlash ? 'Saved.' : dirty ? 'You have unsaved changes.' : 'All changes saved.')}
        </p>
        <button type="button" onClick={handleSave} disabled={!dirty || saving}
          className="shrink-0 px-6 py-2.5 rounded-xl text-sm font-semibold text-white violet-gradient hover:opacity-90 disabled:opacity-40">
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </div>
  )
}