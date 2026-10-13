'use client'
// src/app/dashboard/courses/create/page.tsx
//
// Create course — asks only for what is needed to start:
//   name, description, brand name, price (or free), delivery method,
//   language, refund window and launch date.
// Everything else (instructor bio, what students will learn, FAQ, level,
// requirements, co-instructors, original price, duration ...) is added later
// from the course's Settings tab. The insert below still sends safe empty
// values for those columns, so new courses behave exactly as before.
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import Sidebar from '@/components/Sidebar'
import { supabase } from '@/lib/supabase'
import { ArrowRight, ArrowLeft, Globe, MessageCircle, Send, Plus, X, Code2, Wallet, HelpCircle, KeyRound } from 'lucide-react'
import DeliveryMethodPicker from '@/components/DeliveryMethodPicker'
import SectionDivider from '@/components/SectionDivider'
import AiFieldAssist from '@/components/AiFieldAssist'
import { getEffectivePlanId } from '@/lib/kurso-checkout'
import { planCoversDeliveryMethod, type SubscriptionPlanId } from '@/app/api/razorpay/subscription-plans'

const LANGUAGES = [
  'English', 'Hindi', 'Tamil', 'Telugu', 'Marathi',
  'Bengali', 'Gujarati', 'Kannada', 'Malayalam', 'Punjabi',
  'Urdu', 'Arabic', 'Spanish', 'French', 'German',
]

function slugify(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim()
}

function Field({ label, children, hint }: { label: React.ReactNode; children: React.ReactNode; hint?: string }) {
  return (
    <div>
      <label className="text-sm font-medium text-white mb-2 block">{label}</label>
      {children}
      {hint && <p className="text-[13px] mt-1.5 leading-relaxed" style={{ color: 'var(--kurso-hint)' }}>{hint}</p>}
    </div>
  )
}

function Input({ value, onChange, placeholder, type = 'text' }: {
  value: string; onChange: (v: string) => void; placeholder: string; type?: string
}) {
  return (
    <input
      type={type} value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full px-4 py-3 rounded-xl text-sm text-white outline-none transition-all"
      style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)' }}
      onFocus={e => e.target.style.borderColor = 'var(--kurso-primary)'}
      onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,0.12)'}
    />
  )
}

/** Free / Paid choice. Free forces the price to 0. */
function PriceChoice({ isFree, onChange }: { isFree: boolean; onChange: (free: boolean) => void }) {
  const option = (free: boolean, label: string, sub: string) => {
    const on = isFree === free
    return (
      <button
        type="button"
        aria-pressed={on}
        onClick={() => onChange(free)}
        className="flex-1 text-left px-4 py-3 rounded-xl transition-all"
        style={on
          ? { background: 'rgba(var(--kurso-primary-rgb), 0.15)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.45)' }
          : { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)' }}
      >
        <p className="text-sm font-semibold text-white">{label}</p>
        <p className="text-[13px] mt-0.5" style={{ color: 'var(--kurso-hint)' }}>{sub}</p>
      </button>
    )
  }
  return (
    <div className="flex flex-col sm:flex-row gap-3" role="group" aria-label="Free or paid">
      {option(false, 'Paid course', 'Students pay before they join.')}
      {option(true, 'Free course', 'Anyone can join without paying.')}
    </div>
  )
}

export default function CreateCoursePage() {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Form state
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [brandName, setBrandName] = useState('')
  const [price, setPrice] = useState('')
  const [isFreeCourse, setIsFreeCourse] = useState(false)
  const [delivery, setDelivery] = useState<SubscriptionPlanId>('telegram')
  const [effectivePlanId, setEffectivePlanId] = useState<SubscriptionPlanId | null>(null)
  const [loadingPlan, setLoadingPlan] = useState(true)
  const [selectedLanguages, setSelectedLanguages] = useState<string[]>(['English'])
  const [langDropdown, setLangDropdown] = useState(false)
  const [refundWindowDays, setRefundWindowDays] = useState('7')
  const [startDate, setStartDate] = useState('')
  const [usesExternalLandingPage, setUsesExternalLandingPage] = useState(false)
  const slug = slugify(name)

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }
      const { data: creatorRow } = await supabase
        .from('creators')
        .select('trial_ends_at, default_uses_external_landing_page')
        .eq('id', user.id)
        .maybeSingle()
      const plan = await getEffectivePlanId(user.id, creatorRow?.trial_ends_at)
      setEffectivePlanId(plan)
      // Start on a method the creator already has, so nothing shows as locked.
      setDelivery(plan || 'telegram')
      // Remember whether this creator usually uses their own landing page.
      setUsesExternalLandingPage(!!creatorRow?.default_uses_external_landing_page)
      setLoadingPlan(false)
    }
    load()
  }, [router])

  function toggleLanguage(lang: string) {
    setSelectedLanguages(prev =>
      prev.includes(lang) ? prev.filter(l => l !== lang) : [...prev, lang]
    )
  }

  function toggleExternalLandingPage() {
    setUsesExternalLandingPage(prev => {
      const next = !prev
      // Remember this choice for the next course.
      supabase.auth.getUser().then(({ data: { user } }) => {
        if (!user) return
        supabase
          .from('creators')
          .update({ default_uses_external_landing_page: next })
          .eq('id', user.id)
          .then(() => { })
      })
      return next
    })
  }

  function changePricing(free: boolean) {
    setIsFreeCourse(free)
    setPrice(free ? '0' : '')
  }

  async function handleCreate() {
    if (!name.trim()) {
      setError('Please enter a course name.')
      return
    }
    if (!usesExternalLandingPage && !description.trim()) {
      setError('Please add a short description of your course.')
      return
    }
    if (!usesExternalLandingPage && !brandName.trim()) {
      setError('Please enter your brand or business name.')
      return
    }
    if (!isFreeCourse && !price) {
      setError('Please enter a price, or choose “Free course”.')
      return
    }
    if (selectedLanguages.length === 0) {
      setError('Please pick at least one language.')
      return
    }
    if (!delivery) {
      setError('Please choose how students will get their lessons.')
      return
    }
    // Re-check the plan right before saving, in case it changed while this page was open.
    if (!planCoversDeliveryMethod(effectivePlanId, delivery)) {
      setError('Your plan does not include this delivery method yet. Please pick it again to unlock it.')
      return
    }

    setLoading(true)
    setError('')

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { router.push('/login'); return }

    // Check slug uniqueness
    const { data: existing } = await supabase
      .from('courses')
      .select('id')
      .eq('slug', slug)
      .single()

    const finalSlug = existing ? `${slug}-${Date.now()}` : slug

    const { data: course, error: createError } = await supabase
      .from('courses')
      .insert({
        creator_id: user.id,
        name: name.trim(),
        slug: finalSlug,
        description: description.trim() || (usesExternalLandingPage ? 'Delivered via the creator\'s own landing page.' : ''),
        // A free course always saves with price 0, whatever is in the price box.
        price: isFreeCourse ? 0 : parseInt(price),
        original_price: isFreeCourse ? 0 : parseInt(price),
        host_name: user.user_metadata?.full_name || '',
        delivery,
        total_lessons: 0,
        language: selectedLanguages,
        start_date: startDate,
        is_free_course: isFreeCourse,
        uses_external_landing_page: usesExternalLandingPage,
        brand_name: brandName.trim() || null,
        refund_window_days: refundWindowDays === '' ? 0 : parseInt(refundWindowDays),
        // Added later from the course's Settings tab. Empty values keep every column valid.
        about_creator: '',
        host_image: '',
        duration: '',
        what_you_will_learn: [],
        faq: [],
        level: null,
        instructor_title: null,
        requirements: [],
        target_audience: [],
        co_instructors: [],
      })
      .select()
      .single()

    if (createError) {
      setError(createError.message)
      setLoading(false)
      return
    }

    router.push(
      usesExternalLandingPage
        ? `/dashboard/courses/${course.id}?tab=settings`
        : `/dashboard/courses/${course.id}`
    )
  }

  const deliveryLabel = delivery === 'both'
    ? 'WhatsApp + Telegram'
    : delivery === 'whatsapp'
      ? 'WhatsApp'
      : 'Telegram'

  return (
    <div className="min-h-screen bg-black">
      <Sidebar />
      <main className="md:ml-56 p-6 md:p-8 pt-20 md:pt-8 max-w-3xl">

        {/* Header */}
        <div className="flex items-center gap-4 mb-8">
          <button onClick={() => router.back()} aria-label="Go back"
            className="w-9 h-9 rounded-xl flex items-center justify-center transition-all"
            style={{ background: 'rgba(255,255,255,0.07)', color: 'var(--kurso-text-secondary)' }}>
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div>
            <h1 className="text-2xl font-bold text-white">Create Course</h1>
            <p className="text-sm" style={{ color: 'var(--kurso-hint)' }}>
              Just the basics to get started. You can add more details after.
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-6 md:gap-8">

          {/* Landing page mode */}
          <div className="rounded-2xl p-5 glass" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-white">I already have my own landing page</p>
                <p className="text-[13px] mt-1 leading-relaxed" style={{ color: 'var(--kurso-hint)' }}>
                  Turn this on if you sell from your own page (Instagram, Framer, WordPress…) and only need Kurso for checkout, lessons and payments.
                </p>
              </div>
              <button type="button" onClick={toggleExternalLandingPage}
                aria-pressed={usesExternalLandingPage}
                aria-label="I already have my own landing page"
                className="relative w-12 h-6 rounded-full transition-all flex-shrink-0"
                style={{ background: usesExternalLandingPage ? 'var(--kurso-primary)' : 'rgba(255,255,255,0.16)' }}>
                <div className="absolute top-1 w-4 h-4 rounded-full bg-white transition-all"
                  style={{ left: usesExternalLandingPage ? '28px' : '4px' }} />
              </button>
            </div>
          </div>

          {/* Basic info */}
          <div className="rounded-2xl p-6 md:p-8 glass" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
            <h2 className="font-semibold text-white mb-5">About your course</h2>
            <div className="flex flex-col gap-5">

              <Field label="Course name *">
                <Input value={name} onChange={setName} placeholder="e.g. SEO Masterclass 2026" />
                {name && (
                  <p className="text-[13px] mt-1.5" style={{ color: 'var(--kurso-hint)' }}>
                    Your course link: <span style={{ color: 'var(--kurso-primary-light)' }}>/c/{slug}</span>
                  </p>
                )}
              </Field>

              {!usesExternalLandingPage && (
                <>
                  <Field label="Description *" hint="Say what students will learn and who it is for.">
                    <textarea
                      value={description}
                      onChange={e => setDescription(e.target.value)}
                      placeholder="Learn everything about SEO from scratch…"
                      rows={4}
                      className="w-full px-4 py-3 rounded-xl text-sm text-white outline-none transition-all resize-none"
                      style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)' }}
                      onFocus={e => e.target.style.borderColor = 'var(--kurso-primary)'}
                      onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,0.12)'}
                    />
                    <AiFieldAssist
                      field="description" entityType="course"
                      context={{ name, description }}
                      currentValue={description}
                      onResult={v => typeof v === 'string' && setDescription(v)}
                      className="mt-2"
                    />
                  </Field>

                  <Field label="Brand / business name *" hint="Shown at the top of your course page.">
                    <Input value={brandName} onChange={setBrandName} placeholder="Your brand name" />
                  </Field>
                </>
              )}
            </div>
          </div>

          {/* Price */}
          <div className="rounded-2xl p-6 md:p-8 glass" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
            <h2 className="font-semibold text-white mb-5">Price</h2>
            <div className="flex flex-col gap-4">
              <PriceChoice isFree={isFreeCourse} onChange={changePricing} />
              {!isFreeCourse && (
                <Field
                  label="Price (₹) *"
                  hint={usesExternalLandingPage
                    ? 'Used for your checkout link and code. Set it even though your own page shows the price.'
                    : 'You can add a crossed-out original price later in Settings.'}
                >
                  <Input value={price} onChange={setPrice} placeholder="4999" type="number" />
                </Field>
              )}
            </div>
          </div>

          {/* Own landing page guidance */}
          {usesExternalLandingPage && (
            <div className="rounded-2xl p-6 md:p-8 glass" style={{ border: '1px solid rgba(var(--kurso-primary-rgb), 0.25)' }}>
              <div className="flex items-center gap-2 mb-5">
                <Globe className="w-4 h-4" style={{ color: 'var(--kurso-primary-light)' }} />
                <h2 className="font-semibold text-white">Using your own page</h2>
              </div>

              <div className="flex flex-col gap-4">
                <div className="flex gap-3">
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                    style={{ background: 'rgba(var(--kurso-primary-rgb), 0.12)' }}>
                    <Code2 className="w-4 h-4" style={{ color: 'var(--kurso-primary-light)' }} />
                  </div>
                  <p className="text-sm leading-relaxed" style={{ color: 'var(--kurso-text-secondary)' }}>
                    After you create the course, we give you a buy-button code block. Paste it in place of your current buy button. Keep the{' '}
                    <code className="text-xs px-1 py-0.5 rounded" style={{ background: 'rgba(255,255,255,0.1)', color: '#e4e4e7' }}>data-kurso-course</code>{' '}
                    attribute as it is. You also get a plain checkout link if your page builder does not allow code.
                  </p>
                </div>

                <div className="flex gap-3">
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                    style={{ background: 'rgba(var(--kurso-primary-rgb), 0.12)' }}>
                    <MessageCircle className="w-4 h-4" style={{ color: 'var(--kurso-primary-light)' }} />
                  </div>
                  <p className="text-sm leading-relaxed" style={{ color: 'var(--kurso-text-secondary)' }}>
                    Tell students on your page that lessons come on{' '}
                    <span className="text-white font-medium">{deliveryLabel}</span>{' '}
                    <Send className="w-3 h-3 inline" style={{ color: 'var(--kurso-primary-light)' }} />
                    . They will not see Kurso’s course page, so your page has to say it.
                  </p>
                </div>

                <div className="flex gap-3">
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                    style={{ background: 'rgba(var(--kurso-primary-rgb), 0.12)' }}>
                    <Wallet className="w-4 h-4" style={{ color: 'var(--kurso-primary-light)' }} />
                  </div>
                  <p className="text-sm leading-relaxed" style={{ color: 'var(--kurso-text-secondary)' }}>
                    Next, upload your lessons and connect your Razorpay, Stripe or Cashfree keys so payments go straight to you.
                  </p>
                </div>

                <div className="flex flex-col sm:flex-row gap-3 mt-2">
                  <Link
                    href="/contact"
                    className="flex-1 flex items-center justify-center gap-2 text-sm font-medium px-4 py-3 rounded-xl transition-all"
                    style={{ background: 'rgba(255,255,255,0.07)', color: '#e4e4e7', border: '1px solid rgba(255,255,255,0.14)' }}>
                    <HelpCircle className="w-4 h-4" />
                    Need help? Contact us
                  </Link>
                  <Link
                    href="/dashboard/settings#payment-gateway"
                    className="flex-1 flex items-center justify-center gap-2 text-sm font-medium px-4 py-3 rounded-xl transition-all"
                    style={{ background: 'rgba(255,255,255,0.07)', color: '#e4e4e7', border: '1px solid rgba(255,255,255,0.14)' }}>
                    <KeyRound className="w-4 h-4" />
                    Add payment keys
                  </Link>
                </div>
                <p className="text-[13px]" style={{ color: 'var(--kurso-hint)' }}>
                  Both can wait. Create the course first and do them later from the course’s Settings tab.
                </p>
              </div>
            </div>
          )}

          {/* Delivery */}
          <div className="rounded-2xl p-6 md:p-8 glass" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
            <h2 className="font-semibold text-white mb-5">How will students get lessons?</h2>
            {loadingPlan ? (
              <p className="text-sm" style={{ color: 'var(--kurso-hint)' }}>Loading your plan…</p>
            ) : (
              <>
                <DeliveryMethodPicker
                  value={delivery}
                  onChange={setDelivery}
                  currentPlanId={effectivePlanId}
                  onUpgraded={(newPlanId: SubscriptionPlanId) => setEffectivePlanId(newPlanId)}
                />
                <p className="text-[13px] mt-3" style={{ color: 'var(--kurso-hint)' }}>
                  Students will get lessons on <strong style={{ color: 'var(--kurso-text-secondary)' }}>{deliveryLabel}</strong>. You can change this anytime in the course’s Settings tab.
                </p>
              </>
            )}
          </div>

          {/* Language, refund window, launch date */}
          {!usesExternalLandingPage && (
            <div className="rounded-2xl p-6 md:p-8 glass" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
              <h2 className="font-semibold text-white mb-5">Language and dates</h2>
              <div className="flex flex-col gap-5">

                <Field label="Course language(s)">
                  <div className="flex flex-wrap gap-2 mb-1">
                    {selectedLanguages.map(lang => (
                      <span key={lang}
                        className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg"
                        style={{ background: 'rgba(var(--kurso-primary-rgb), 0.15)', color: 'var(--kurso-primary-lightest)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.35)' }}>
                        {lang}
                        <button type="button" onClick={() => toggleLanguage(lang)} aria-label={`Remove ${lang}`}>
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                    <button
                      type="button"
                      onClick={() => setLangDropdown(!langDropdown)}
                      className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg transition-all"
                      style={{ background: 'rgba(255,255,255,0.07)', color: 'var(--kurso-text-secondary)', border: '1px solid rgba(255,255,255,0.14)' }}>
                      <Plus className="w-3 h-3" />
                      Add language
                    </button>
                  </div>

                  {langDropdown && (
                    <div className="rounded-xl overflow-hidden mt-2"
                      style={{ border: '1px solid rgba(255,255,255,0.14)', background: '#111' }}>
                      <div className="max-h-48 overflow-y-auto">
                        {LANGUAGES.filter(l => !selectedLanguages.includes(l)).map(lang => (
                          <button key={lang}
                            type="button"
                            onClick={() => { toggleLanguage(lang); setLangDropdown(false) }}
                            className="w-full text-left px-4 py-2.5 text-sm transition-all"
                            style={{ color: 'var(--kurso-text-secondary)' }}
                            onMouseEnter={e => {
                              e.currentTarget.style.background = 'rgba(var(--kurso-primary-rgb), 0.12)'
                              e.currentTarget.style.color = '#fff'
                            }}
                            onMouseLeave={e => {
                              e.currentTarget.style.background = 'transparent'
                              e.currentTarget.style.color = 'var(--kurso-text-secondary)'
                            }}>
                            {lang}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </Field>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Field
                    label="Refund window (days)"
                    hint={`Students can ask for a refund within ${refundWindowDays || 0} day${refundWindowDays === '1' ? '' : 's'} of joining. Use 0 for no refunds.`}
                  >
                    <Input value={refundWindowDays} onChange={setRefundWindowDays} placeholder="7" type="number" />
                  </Field>
                  <Field label="Course launch date" hint="When students can join. Not sure yet? Leave it empty and set it later.">
                    <Input value={startDate} onChange={setStartDate} placeholder="15th May 2026" />
                  </Field>
                </div>

                <p className="text-[13px] leading-relaxed" style={{ color: 'var(--kurso-hint)' }}>
                  Refund policy, terms and privacy files can be uploaded from the course’s Settings tab after you create it.
                </p>
              </div>
            </div>
          )}

          {!usesExternalLandingPage && (
            <SectionDivider label="After you create the course" />
          )}
          {!usesExternalLandingPage && (
            <p className="text-sm leading-relaxed -mt-3" style={{ color: 'var(--kurso-text-secondary)' }}>
              Add your photo and bio, what students will learn, FAQ, level, requirements and more from the course’s Settings tab. AI can help you write them there too.
            </p>
          )}

          {error && (
            <div role="alert" className="p-4 rounded-xl text-sm"
              style={{ background: 'rgba(239,68,68,0.1)', color: 'var(--kurso-danger)', border: '1px solid rgba(239,68,68,0.3)' }}>
              {error}
            </div>
          )}

          {/* Submit */}
          <div className="flex gap-3">
            <button onClick={() => router.back()}
              className="px-6 py-3 rounded-xl text-sm font-medium transition-all"
              style={{ background: 'rgba(255,255,255,0.07)', color: 'var(--kurso-text-secondary)' }}>
              Cancel
            </button>
            <button onClick={handleCreate} disabled={loading}
              className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-medium text-white violet-gradient hover:opacity-90 glow transition-all disabled:opacity-50">
              {loading ? 'Creating…' : 'Create course and add lessons'}
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </main>
    </div>
  )
}