'use client'
// src/app/dashboard/workshops/create/page.tsx
//
// Create-workshop page. Asks only for what a workshop page needs to look good
// and work (title, when, price, host); everything else is clearly marked
// Optional and lives in workshop settings.
//
// Rules this page follows:
//   - the date and time are ALWAYS read as IST (same zone the public page shows)
//   - a start time in the past is rejected
//   - the zoom link is validated and never shown publicly
//   - helper text uses the --kurso-text-* tokens (see WorkshopFormFields.tsx)

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import Sidebar from '@/components/Sidebar'
import { supabase } from '@/lib/supabase'
import { slugify } from '@/lib/utils'
import { ArrowLeft, Check, Copy, ExternalLink, ChevronDown, AlertTriangle } from 'lucide-react'
import { FormCard, FormField, TextInput, TextArea, SelectInput, SegmentedControl } from '@/components/WorkshopFormFields'
import { StringListEditor } from '@/components/WorkshopListEditors'
import AiFieldAssist from '@/components/AiFieldAssist'
import {
  WORKSHOP_DURATION_OPTIONS,
  WORKSHOP_LIMITS,
  formatWorkshopDuration,
  pickUniqueWorkshopSlug,
  todayInIST,
} from '@/lib/workshops'
import { validateWorkshopFields } from '@/lib/workshop-validation'
import { MAX_TAGLINE_LENGTH } from '@/lib/workshop-landing-config'

const DURATION_CHOICES = WORKSHOP_DURATION_OPTIONS.map(m => ({ value: String(m), label: formatWorkshopDuration(m) }))

const digitsOnly = (v: string) => v.replace(/\D/g, '')

export default function CreateWorkshopPage() {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [creatorSlug, setCreatorSlug] = useState('')
  const [upiId, setUpiId] = useState('')
  const [siteHost, setSiteHost] = useState('kurso.in')

  // The basics
  const [title, setTitle] = useState('')
  const [tagline, setTagline] = useState('')
  const [description, setDescription] = useState('')

  // When & price
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [duration, setDuration] = useState('60')
  const [pricing, setPricing] = useState<'free' | 'paid'>('free')
  const [price, setPrice] = useState('')

  // Host
  const [hostName, setHostName] = useState('')
  const [hostTitle, setHostTitle] = useState('')

  // Takeaways, joining link, more options
  const [takeaways, setTakeaways] = useState(['', '', ''])
  const [zoomLink, setZoomLink] = useState('')
  const [showMore, setShowMore] = useState(false)
  const [capacity, setCapacity] = useState('')
  const [originalPrice, setOriginalPrice] = useState('')

  // Submit state
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [createdSlug, setCreatedSlug] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setSiteHost(window.location.host)
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }
      const { data: creator, error: creatorError } = await supabase
        .from('creators')
        .select('name, creator_slug, upi_id')
        .eq('id', user.id)
        .maybeSingle()
      if (creatorError) console.error('[create workshop] creator lookup failed', creatorError)
      setCreatorSlug(creator?.creator_slug || '')
      setUpiId(creator?.upi_id || '')
      setHostName(creator?.name || (user.user_metadata?.full_name as string | undefined) || '')
      setLoading(false)
    }
    load()
  }, [router])

  const slugPreview = slugify(title).replace(/^-+|-+$/g, '') || 'workshop'
  const publicPath = (slug: string) => `/w/${creatorSlug}/${slug}`

  function resetForm() {
    setTitle(''); setTagline(''); setDescription('')
    setDate(''); setTime(''); setDuration('60'); setPricing('free'); setPrice('')
    setHostTitle(''); setTakeaways(['', '', '']); setZoomLink('')
    setCapacity(''); setOriginalPrice(''); setShowMore(false)
    setError(''); setCopied(false); setCreatedSlug(null)
  }

  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      window.prompt('Copy this link:', url)
    }
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (creating) return
    setError('')
    const fail = (message: string) => { setError(message) }

    if (!creatorSlug) return fail('Your public creator link is not set up yet. Set it in Settings first, then come back.')

    // Same rules as workshop settings (lib/workshop-validation.ts).
    const result = validateWorkshopFields(
      { title, tagline, description, date, time, duration, pricing, price, originalPrice, capacity, hostName, hostTitle, zoomLink, takeaways },
      { requireFutureStart: true }
    )
    if (!result.ok) return fail(result.error)

    setCreating(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      const slug = await pickUniqueWorkshopSlug(supabase, user.id, result.data.title)
      const { data, error: insertError } = await supabase
        .from('workshops')
        .insert({ creator_id: user.id, slug, status: 'published', ...result.data })
        .select('slug')
        .single()

      if (insertError) {
        console.error('[create workshop] insert failed', insertError)
        setError(insertError.message)
        return
      }
      setCreatedSlug(data.slug)
    } catch (err: any) {
      console.error('[create workshop] unexpected failure', err)
      setError(err?.message || 'Something went wrong. Please try again.')
    } finally {
      setCreating(false)
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen bg-black">
        <Sidebar />
        <main className="md:ml-56 p-6 md:p-8 pt-20 md:pt-8">
          <p className="text-sm" style={{ color: 'var(--kurso-text-muted)' }}>Loading…</p>
        </main>
      </div>
    )
  }

  if (createdSlug) {
    const url = `${window.location.origin}${publicPath(createdSlug)}`
    return (
      <div className="min-h-screen bg-black">
        <Sidebar />
        <main className="md:ml-56 p-6 md:p-8 pt-20 md:pt-8 max-w-3xl">
          <div className="rounded-2xl p-6 md:p-8 glass" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
            <div className="w-11 h-11 rounded-full flex items-center justify-center mb-4"
              style={{ background: 'rgba(74,222,128,0.15)', color: 'var(--kurso-success)' }}>
              <Check className="w-6 h-6" />
            </div>
            <h1 className="text-2xl font-bold text-white mb-1">Your workshop is live</h1>
            <p className="text-sm mb-6" style={{ color: 'var(--kurso-text-muted)' }}>
              Share this link to start getting registrations.
            </p>

            <div className="flex items-center gap-2 mb-6">
              <input readOnly value={url} onFocus={e => e.currentTarget.select()}
                className="flex-1 min-w-0 px-4 py-3 rounded-xl text-sm text-white outline-none"
                style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.14)' }} />
              <button type="button" onClick={() => copyLink(url)}
                className="shrink-0 flex items-center gap-2 px-4 py-3 rounded-xl text-sm font-medium"
                style={{ background: 'rgba(var(--kurso-primary-rgb), 0.18)', color: 'var(--kurso-primary-lightest)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.35)' }}>
                {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>

            <div className="flex flex-wrap gap-3">
              <a href={publicPath(createdSlug)} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium text-white violet-gradient hover:opacity-90">
                <ExternalLink className="w-4 h-4" /> View page
              </a>
              <Link href="/dashboard/workshops"
                className="px-5 py-2.5 rounded-xl text-sm font-medium"
                style={{ background: 'rgba(255,255,255,0.08)', color: 'var(--kurso-text-secondary)' }}>
                Back to workshops
              </Link>
              <button type="button" onClick={resetForm}
                className="px-5 py-2.5 rounded-xl text-sm font-medium"
                style={{ background: 'rgba(255,255,255,0.08)', color: 'var(--kurso-text-secondary)' }}>
                Create another
              </button>
            </div>
          </div>
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-black">
      <Sidebar />
      <main className="md:ml-56 p-6 md:p-8 pt-20 md:pt-8 max-w-3xl">
        <Link href="/dashboard/workshops"
          className="inline-flex items-center gap-2 text-sm mb-5 hover:opacity-80"
          style={{ color: 'var(--kurso-text-secondary)' }}>
          <ArrowLeft className="w-4 h-4" /> Back to workshops
        </Link>

        <div className="mb-8">
          <h1 className="text-2xl font-bold text-white mb-1">Create a workshop</h1>
          <p className="text-sm" style={{ color: 'var(--kurso-text-muted)' }}>
            Start with the essentials, it takes about two minutes. Fields marked * are required; anything marked Optional can wait.
          </p>
        </div>

        {!creatorSlug && (
          <div className="flex items-start gap-3 rounded-xl p-4 mb-6"
            style={{ background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.35)' }}>
            <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" style={{ color: 'var(--kurso-danger)' }} />
            <p className="text-sm" style={{ color: 'var(--kurso-text-secondary)' }}>
              Your public creator link isn't set up yet, so a workshop page would have no web address.{' '}
              <Link href="/dashboard/settings" className="underline" style={{ color: 'var(--kurso-primary-lightest)' }}>
                Set it in Settings
              </Link>{' '}
              first.
            </p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-6">

          <FormCard title="The basics" description="What people see first. A clear promise gets more registrations.">
            <FormField label="Workshop title" htmlFor="ws-title" required counter={`${title.length}/${WORKSHOP_LIMITS.title}`}
              hint={creatorSlug ? <>Your page link: <span style={{ color: 'var(--kurso-primary-lightest)' }}>{siteHost}/w/{creatorSlug}/{slugPreview}</span></> : undefined}>
              <TextInput id="ws-title" value={title} onChange={setTitle} maxLength={WORKSHOP_LIMITS.title}
                placeholder="e.g. Build your first sales funnel in 90 minutes" />
            </FormField>

            <FormField label="One-line promise" htmlFor="ws-tagline" tag="recommended" counter={`${tagline.length}/${MAX_TAGLINE_LENGTH}`}
              hint="Shown right under the title. Say what people walk away with.">
              <TextInput id="ws-tagline" value={tagline} onChange={setTagline} maxLength={MAX_TAGLINE_LENGTH}
                placeholder="e.g. Live, hands-on, with ready-to-use templates" />
              <AiFieldAssist field="tagline" entityType="workshop"
                context={{ title, tagline, description, hostName, hostTitle, pricing, price }}
                currentValue={tagline} onResult={v => typeof v === 'string' && setTagline(v)} className="mt-1.5" />
            </FormField>

            <FormField label="Description" htmlFor="ws-description" tag="optional" counter={`${description.length}/${WORKSHOP_LIMITS.description}`}
              hint="A few lines about the workshop. Also used for Google search results.">
              <TextArea id="ws-description" rows={4} value={description} onChange={setDescription} maxLength={WORKSHOP_LIMITS.description}
                placeholder="What will you cover, and who is it for?" />
              <AiFieldAssist field="description" entityType="workshop"
                context={{ title, tagline, description, hostName, hostTitle, pricing, price }}
                currentValue={description} onResult={v => typeof v === 'string' && setDescription(v)} className="mt-1.5" />
            </FormField>
          </FormCard>

          <FormCard title="When and how much" description="All times are in IST (India Standard Time).">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <FormField label="Date" htmlFor="ws-date" required>
                <TextInput id="ws-date" type="date" value={date} onChange={setDate} min={todayInIST()} placeholder="" />
              </FormField>
              <FormField label="Start time (IST)" htmlFor="ws-time" required>
                <TextInput id="ws-time" type="time" value={time} onChange={setTime} placeholder="" />
              </FormField>
              <FormField label="Duration" htmlFor="ws-duration" required>
                <SelectInput id="ws-duration" value={duration} onChange={setDuration} options={DURATION_CHOICES} />
              </FormField>
            </div>

            <FormField label="Price" required>
              <SegmentedControl ariaLabel="Free or paid" value={pricing} onChange={setPricing}
                options={[{ value: 'free', label: 'Free' }, { value: 'paid', label: 'Paid' }]} />
            </FormField>

            {pricing === 'paid' && (
              <>
                <FormField label="Price per seat" htmlFor="ws-price" required>
                  <TextInput id="ws-price" inputMode="numeric" prefix="₹" value={price}
                    onChange={v => setPrice(digitsOnly(v))} placeholder="499" />
                </FormField>
                {!upiId && (
                  <div className="flex items-start gap-3 rounded-xl p-4"
                    style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.35)' }}>
                    <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" style={{ color: '#f59e0b' }} />
                    <p className="text-sm" style={{ color: 'var(--kurso-text-secondary)' }}>
                      You haven't saved a UPI ID yet. If you also haven't connected a payment gateway, people won't be able to pay.
                      You can add your UPI ID under "UPI payout details" on the{' '}
                      <Link href="/dashboard/workshops" className="underline" style={{ color: 'var(--kurso-primary-lightest)' }}>
                        Workshops page
                      </Link>.
                    </p>
                  </div>
                )}
              </>
            )}
          </FormCard>

          <FormCard title="Your host" description="People join people. Show who is teaching.">
            <FormField label="Host name" htmlFor="ws-host" required>
              <TextInput id="ws-host" value={hostName} onChange={setHostName} maxLength={WORKSHOP_LIMITS.hostName}
                placeholder="Your name" />
            </FormField>
            <FormField label="Title or credential" htmlFor="ws-host-title" tag="recommended"
              hint="A specific credential builds trust, for example “Digital marketer, 8+ years”.">
              <TextInput id="ws-host-title" value={hostTitle} onChange={setHostTitle} maxLength={WORKSHOP_LIMITS.hostTitle}
                placeholder="e.g. Certified SEO consultant · 8+ years" />
            </FormField>
          </FormCard>

          <FormCard title="What will people learn?" tag="recommended"
            description="Add up to 3 to 6 clear takeaways. You can skip this and add it later.">
            <StringListEditor value={takeaways} onChange={setTakeaways}
              max={WORKSHOP_LIMITS.takeaways} itemMaxLength={WORKSHOP_LIMITS.takeawayLength}
              ariaLabel="Takeaway" placeholders={['e.g. Pick a profitable niche in 15 minutes', 'Another takeaway']} />
            <AiFieldAssist field="takeaways" entityType="workshop"
              context={{ title, tagline, description, hostName, hostTitle, pricing, price }}
              currentValue={takeaways} onResult={v => Array.isArray(v) && setTakeaways(v as string[])} className="mt-1" />
          </FormCard>

          <FormCard title="Joining link" tag="recommended"
            description="Add it now or later, but attendees can't join without it.">
            <FormField label="Zoom / Google Meet link" htmlFor="ws-zoom"
              hint="Only confirmed registrants receive it, by WhatsApp or Telegram. It is never shown on your public page.">
              <TextInput id="ws-zoom" type="url" value={zoomLink} onChange={setZoomLink} placeholder="https://zoom.us/j/..." />
            </FormField>
          </FormCard>

          <section className="rounded-2xl glass" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
            <button type="button" onClick={() => setShowMore(v => !v)} aria-expanded={showMore}
              className="w-full flex items-center justify-between gap-3 p-6 md:p-7 text-left">
              <div>
                <div className="flex items-center gap-2.5 flex-wrap">
                  <span className="text-base font-semibold text-white">More options</span>
                  <span className="inline-block text-[12px] font-medium px-2 py-0.5 rounded-full"
                    style={{ background: 'rgba(255,255,255,0.08)', color: 'var(--kurso-text-secondary)' }}>Optional</span>
                </div>
                <p className="text-sm mt-1" style={{ color: 'var(--kurso-text-muted)' }}>Limit seats{pricing === 'paid' ? ' or show a crossed-out original price' : ''}.</p>
              </div>
              <ChevronDown className="w-5 h-5 shrink-0 transition-transform" style={{ color: 'var(--kurso-text-secondary)', transform: showMore ? 'rotate(180deg)' : 'none' }} />
            </button>
            {showMore && (
              <div className="px-6 md:px-7 pb-6 md:pb-7 flex flex-col gap-5">
                <FormField label="Seats available" htmlFor="ws-capacity" tag="optional"
                  hint="Leave empty for unlimited. The page shows how many seats are left.">
                  <TextInput id="ws-capacity" inputMode="numeric" value={capacity}
                    onChange={v => setCapacity(digitsOnly(v))} placeholder="e.g. 100" />
                </FormField>
                {pricing === 'paid' && (
                  <FormField label="Original price" htmlFor="ws-original-price" tag="optional"
                    hint="Shown crossed out next to your price, so it must be higher than the price.">
                    <TextInput id="ws-original-price" inputMode="numeric" prefix="₹" value={originalPrice}
                      onChange={v => setOriginalPrice(digitsOnly(v))} placeholder="999" />
                  </FormField>
                )}
              </div>
            )}
          </section>

          <div className="rounded-2xl p-5" style={{ background: 'rgba(255,255,255,0.03)', border: '1px dashed rgba(255,255,255,0.18)' }}>
            <p className="text-sm font-medium text-white mb-1">Everything else is optional</p>
            <p className="text-sm leading-relaxed" style={{ color: 'var(--kurso-text-muted)' }}>
              Host photo and bio, co-hosts, agenda and FAQ can all be added in workshop settings whenever you are ready.
            </p>
          </div>

          <div>
            {error && (
              <div role="alert" className="flex items-start gap-3 rounded-xl p-4 mb-4"
                style={{ background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.35)' }}>
                <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" style={{ color: 'var(--kurso-danger)' }} />
                <p className="text-sm" style={{ color: 'var(--kurso-text-secondary)' }}>{error}</p>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-4">
              <button type="submit" disabled={creating || !creatorSlug}
                className="px-7 py-3 rounded-xl text-sm font-semibold text-white violet-gradient hover:opacity-90 glow disabled:opacity-50">
                {creating ? 'Publishing…' : 'Publish workshop'}
              </button>
              <p className="text-sm" style={{ color: 'var(--kurso-text-muted)' }}>Your page goes live as soon as you publish.</p>
            </div>
          </div>
        </form>
      </main>
    </div>
  )
}