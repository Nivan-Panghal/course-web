'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import Sidebar from '@/components/Sidebar'
import { supabase } from '@/lib/supabase'
import { ArrowRight, ArrowLeft, Globe, MessageCircle, Send, Plus, X, Code2, Wallet, HelpCircle, KeyRound } from 'lucide-react'
import CoInstructorsEditor, { type CoInstructor } from '@/components/CoInstructorsEditor'
import DeliveryMethodPicker from '@/components/DeliveryMethodPicker'
import SectionDivider from '@/components/SectionDivider'
import AiFieldAssist from '@/components/AiFieldAssist'
import { getEffectivePlanId } from '@/lib/kurso-checkout'
import { PLAN_ORDER, planCoversDeliveryMethod, type SubscriptionPlanId } from '@/app/api/razorpay/subscription-plans'

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

async function uploadToSupabase(file: File, folder: string): Promise<string> {
  try {
    const ext = file.name.split('.').pop()
    const safeName = `${folder}/${Math.random().toString(36).substring(2)}-${Date.now()}.${ext}`

    // Upload directly using Supabase client (handles CORS properly)
    const { data, error: uploadError } = await supabase.storage
      .from('lessons')
      .upload(safeName, file, {
        cacheControl: '3600',
        upsert: false
      })

    if (uploadError) {
      // Provide specific error messages for common issues
      let errorMsg = uploadError.message

      if (errorMsg?.includes('row-level security') || errorMsg?.includes('RLS')) {
        errorMsg = 'Storage policy error: Please contact admin to enable file uploads. See STORAGE_RLS_FIX.md for fix.'
      } else if (errorMsg?.includes('unauthorized') || errorMsg?.includes('auth')) {
        errorMsg = 'Authentication error: Please log out and log back in.'
      } else if (errorMsg?.includes('not found')) {
        errorMsg = 'Storage bucket not found. Please check configuration.'
      }

      console.error('Supabase upload error:', uploadError)
      throw new Error(`Upload failed: ${errorMsg}`)
    }

    if (!data) {
      throw new Error('No data returned from upload')
    }

    // Generate public URL
    const { data: publicUrlData } = supabase.storage
      .from('lessons')
      .getPublicUrl(safeName)

    return publicUrlData.publicUrl
  } catch (err: any) {
    console.error('Upload error:', err)
    throw new Error(err.message || 'Upload failed')
  }
}

// Reusable input component defined outside
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
      style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
      onFocus={e => e.target.style.borderColor = 'var(--kurso-primary)'}
      onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,0.1)'}
    />
  )
}

function FreeCourseToggle({ isFreeCourse, onToggle }: { isFreeCourse: boolean; onToggle: () => void }) {
  return (
    <div className="flex items-center justify-between gap-4 p-4 rounded-xl"
      style={{ background: isFreeCourse ? 'rgba(74,222,128,0.06)' : 'rgba(255,255,255,0.03)', border: isFreeCourse ? '1px solid rgba(74,222,128,0.25)' : '1px solid rgba(255,255,255,0.08)' }}>
      <div>
        <p className="text-sm font-semibold text-white">Make this entire course free</p>
        <p className="text-xs mt-0.5" style={{ color: '#71717a' }}>
          All lessons will be accessible without payment. Price is forced to ₹0.
        </p>
      </div>
      <button
        type="button"
        onClick={onToggle}
        className="relative flex-shrink-0 w-11 h-6 rounded-full transition-colors duration-200"
        style={{ background: isFreeCourse ? '#4ade80' : 'rgba(255,255,255,0.12)' }}
        aria-pressed={isFreeCourse}
      >
        <span
          className="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform duration-200"
          style={{ transform: isFreeCourse ? 'translateX(20px)' : 'translateX(0)' }}
        />
      </button>
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
  const [price, setPrice] = useState('')
  const [originalPrice, setOriginalPrice] = useState('')
  const [refundWindowDays, setRefundWindowDays] = useState('7')
  const [hostName, setHostName] = useState('')
  const [aboutCreator, setAboutCreator] = useState('')
  const [delivery, setDelivery] = useState<SubscriptionPlanId>('telegram')
  const [effectivePlanId, setEffectivePlanId] = useState<SubscriptionPlanId | null>(null)
  const [loadingPlan, setLoadingPlan] = useState(true)
  const [startDate, setStartDate] = useState('')
  const [duration, setDuration] = useState('')
  const [whatYouWillLearn, setWhatYouWillLearn] = useState([''])
  const [faqs, setFaqs] = useState([{ question: '', answer: '' }])
  const [hostImage, setHostImage] = useState('')
  const [instructorTitle, setInstructorTitle] = useState('')
  const [uploadingImage, setUploadingImage] = useState(false)
  const [selectedLanguages, setSelectedLanguages] = useState<string[]>(['English'])
  const [langDropdown, setLangDropdown] = useState(false)
  const [isFreeCourse, setIsFreeCourse] = useState(false)
  const [usesExternalLandingPage, setUsesExternalLandingPage] = useState(false)
  // Step 3 — new fields
  const [level, setLevel] = useState('')

  const [brandName, setBrandName] = useState('')
  const [requirements, setRequirements] = useState([''])
  const [targetAudience, setTargetAudience] = useState([''])
  const [coInstructors, setCoInstructors] = useState<CoInstructor[]>([])
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
      // Default to whatever the creator already has covered (no locked
      // padlock shown by default); fall back to the cheapest tier if
      // they have nothing unlocked yet.
      setDelivery(plan || 'telegram')
      // Remember whether this creator generally uses their own landing
      // page, so they don't have to re-toggle it on every new course.
      setUsesExternalLandingPage(!!creatorRow?.default_uses_external_landing_page)
      setLoadingPlan(false)
    }
    load()
  }, [router])

  function toggleLanguage(lang: string) {
    setSelectedLanguages(prev =>
      prev.includes(lang)
        ? prev.filter(l => l !== lang)
        : [...prev, lang]
    )
  }

  function addWhatYouWillLearn() {
    setWhatYouWillLearn(prev => [...prev, ''])
  }

  function removeWhatYouWillLearn(index: number) {
    setWhatYouWillLearn(prev => prev.filter((_, i) => i !== index))
  }

  function updateWhatYouWillLearn(index: number, value: string) {
    const next = [...whatYouWillLearn]
    next[index] = value
    setWhatYouWillLearn(next)
  }

  function addFaq() {
    setFaqs(prev => [...prev, { question: '', answer: '' }])
  }

  function removeFaq(index: number) {
    setFaqs(prev => prev.filter((_, i) => i !== index))
  }

  function updateFaq(index: number, field: 'question' | 'answer', value: string) {
    const next = [...faqs]
    next[index][field] = value
    setFaqs(next)
  }

  function toggleExternalLandingPage() {
    setUsesExternalLandingPage(prev => {
      const next = !prev
      // Fire-and-forget: remember this as the creator's default for next
      // time, so they don't have to re-toggle it on every new course.
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

  async function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    if (file.size > 2 * 1024 * 1024) {
      setError('Image must be 2MB or smaller.')
      return
    }

    setUploadingImage(true)
    setError('')
    try {
      const publicUrl = await uploadToSupabase(file, 'images')
      setHostImage(publicUrl)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setUploadingImage(false)
    }
  }

  async function handleCreate() {
    if (!name) {
      setError('Course name is required.')
      return
    }
    if (!usesExternalLandingPage && !description) {
      setError('Course description is required.')
      return
    }
    if (!usesExternalLandingPage && !brandName.trim()) {
      setError('Brand / Business name is required.')
      return
    }
    // When is_free_course is ON, price must be 0; otherwise require a price
    if (!isFreeCourse && !price) {
      setError('Please enter a price, or enable "Make this entire course free".')
      return
    }
    if (selectedLanguages.length === 0) {
      setError('Select at least one language.')
      return
    }
    if (!delivery) {
      setError('Please select a delivery method.')
      return
    }
    // Defense-in-depth: re-confirm the picked delivery method is actually
    // covered by the creator's plan before writing it, in case plan state
    // changed since the picker loaded (e.g. a subscription lapsed mid-form).
    // Exact-match check, not price comparison — telegram and whatsapp are
    // separate channels, not tiers of each other.
    if (!planCoversDeliveryMethod(effectivePlanId, delivery)) {
      setError('Your current plan does not cover this delivery method. Please select it again to unlock it.')
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
        name,
        slug: finalSlug,
        description: description || (usesExternalLandingPage ? 'Delivered via the creator\'s own landing page.' : ''),
        // Server-side enforcement: if is_free_course is true, price is forced to 0
        // regardless of what the client may have in the price field.
        price: isFreeCourse ? 0 : parseInt(price),
        original_price: isFreeCourse ? 0 : (originalPrice ? parseInt(originalPrice) : parseInt(price)),
        host_name: hostName || user.user_metadata?.full_name || '',
        about_creator: aboutCreator,
        host_image: hostImage,
        delivery,
        total_lessons: 0,
        language: selectedLanguages,
        start_date: startDate,
        duration: duration,
        what_you_will_learn: whatYouWillLearn.filter(item => item.trim() !== ''),
        faq: faqs.filter(f => f.question.trim() !== '' && f.answer.trim() !== ''),
        is_free_course: isFreeCourse,
        uses_external_landing_page: usesExternalLandingPage,
        // Step 3 fields
        level: level || null,
        brand_name: brandName.trim() || null,
        instructor_title: instructorTitle.trim() || null,
        requirements: requirements.filter(r => r.trim()),
        target_audience: targetAudience.filter(t => t.trim()),
        co_instructors: coInstructors
          .filter(ci => ci.name.trim())
          .map(ci => ({ name: ci.name.trim(), title: ci.title.trim(), image: ci.image, bio: ci.bio.trim() })),
        refund_window_days: refundWindowDays === '' ? 0 : parseInt(refundWindowDays),
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

  return (
    <div className="min-h-screen bg-black">
      <Sidebar />
      <main className="md:ml-56 p-6 md:p-8 pt-20 md:pt-8 max-w-3xl">

        {/* Header */}
        <div className="flex items-center gap-4 mb-8">
          <button onClick={() => router.back()}
            className="w-9 h-9 rounded-xl flex items-center justify-center transition-all"
            style={{ background: 'rgba(255,255,255,0.05)', color: '#a1a1aa' }}>
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div>
            <h1 className="text-2xl font-bold text-white">Create Course</h1>
            <p className="text-sm" style={{ color: '#a1a1aa' }}>Fill in the details to set up your course</p>
          </div>
        </div>

        <div className="flex flex-col gap-6 md:gap-8">

          {/* Landing page mode */}
          <div className="rounded-2xl p-5 glass"
            style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-white">I already have my own landing page</p>
                <p className="text-xs mt-0.5" style={{ color: '#a1a1aa' }}>
                  Turn this on if you'll send students to your own page (Instagram, Framer, WordPress, etc.) and only want Kurso for checkout, lesson delivery, and payments. This hides the fields below that only matter for Kurso's own course page — you can still fill them in later if you change your mind.
                </p>
              </div>
              <button type="button" onClick={toggleExternalLandingPage}
                className="relative w-12 h-6 rounded-full transition-all flex-shrink-0"
                style={{ background: usesExternalLandingPage ? 'var(--kurso-primary)' : 'rgba(255,255,255,0.1)' }}>
                <div className="absolute top-1 w-4 h-4 rounded-full bg-white transition-all"
                  style={{ left: usesExternalLandingPage ? '28px' : '4px' }} />
              </button>
            </div>
          </div>

          {/* Basic Info */}
          <div className="rounded-2xl p-6 md:p-8 glass"
            style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
            <h2 className="font-semibold text-white mb-5">Basic Information</h2>
            <div className="flex flex-col gap-5">

              <Field label="Course Name *">
                <Input value={name} onChange={setName} placeholder="e.g. SEO Masterclass 2026" />
                {name && (
                  <p className="text-xs mt-1.5" style={{ color: '#52525b' }}>
                    Course URL: <span style={{ color: 'var(--kurso-primary-light)' }}>/c/{slug}</span>
                  </p>
                )}
              </Field>

              {usesExternalLandingPage && (
                <>
                  <FreeCourseToggle
                    isFreeCourse={isFreeCourse}
                    onToggle={() => {
                      const next = !isFreeCourse
                      setIsFreeCourse(next)
                      if (next) {
                        setPrice('0')
                        setOriginalPrice('')
                      } else {
                        setPrice('')
                      }
                    }}
                  />
                  {!isFreeCourse && (
                    <Field label="Price (₹) *" hint="Used for your checkout link and code block — set this even though it's not shown on a Kurso page.">
                      <Input value={price} onChange={setPrice} placeholder="4999" type="number" />
                    </Field>
                  )}
                </>
              )}

              {!usesExternalLandingPage && (
                <>
                  <SectionDivider label="Course Details" />
                  <Field label="Description *" hint="Tell students what they will learn">
                    <textarea
                      value={description}
                      onChange={e => setDescription(e.target.value)}
                      placeholder="Learn everything about SEO from scratch..."
                      rows={4}
                      className="w-full px-4 py-3 rounded-xl text-sm text-white outline-none transition-all resize-none"
                      style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
                      onFocus={e => e.target.style.borderColor = 'var(--kurso-primary)'}
                      onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,0.1)'}
                    />
                    <AiFieldAssist
                      field="description" entityType="course"
                      context={{ name, description, hostName, aboutCreator, what_you_will_learn: whatYouWillLearn.filter(Boolean) }}
                      currentValue={description}
                      onResult={v => typeof v === 'string' && setDescription(v)}
                      className="mt-2"
                    />
                  </Field>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <Field label="Difficulty Level">
                      <select
                        value={level}
                        onChange={e => setLevel(e.target.value)}
                        className="w-full px-4 py-3 rounded-xl text-sm text-white outline-none appearance-none cursor-pointer"
                        style={{
                          background: '#050505',
                          color: level ? '#fff' : '#52525b',
                          border: '1px solid rgba(255,255,255,0.1)',
                        }}
                      >
                        <option value="" style={{ background: '#050505', color: '#52525b' }}>
                          Select level…
                        </option>
                        {['Beginner', 'Intermediate', 'Advanced', 'All Levels'].map(l => (
                          <option
                            key={l}
                            value={l}
                            style={{ background: '#050505', color: '#fff' }}
                          >
                            {l}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>

                  <Field label="Brand / Business Name *" hint="Shown in your landing page navigation bar.">
                    <Input value={brandName} onChange={setBrandName} placeholder="Your brand name" />
                  </Field>

                  <SectionDivider label="Pricing" />
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <Field label="Price (₹) *">
                      <div className="relative">
                        <Input
                          value={price}
                          onChange={v => {
                            if (isFreeCourse) return // blocked when free toggle is on
                            setPrice(v)
                          }}
                          placeholder={isFreeCourse ? '0 (course is free)' : '4999'}
                          type="number"
                        />
                        {isFreeCourse && (
                          <p className="text-xs mt-1.5" style={{ color: '#f97316' }}>
                            This course is set to free. Turn off "Make this course free" below to set a price.
                          </p>
                        )}
                      </div>
                    </Field>
                    <Field label="Original Price (₹)" hint="For showing discount">
                      <Input
                        value={isFreeCourse ? '' : originalPrice}
                        onChange={v => {
                          if (isFreeCourse) return
                          setOriginalPrice(v)
                        }}
                        placeholder={isFreeCourse ? '—' : '9999'}
                        type="number"
                      />
                    </Field>
                  </div>

                  {/* Make this entire course free toggle */}
                  <FreeCourseToggle
                    isFreeCourse={isFreeCourse}
                    onToggle={() => {
                      const next = !isFreeCourse
                      setIsFreeCourse(next)
                      if (next) {
                        setPrice('0')
                        setOriginalPrice('')
                      } else {
                        setPrice('')
                      }
                    }}
                  />

                  <Field label="Refund Window (days)" hint={`Students can request a refund within ${refundWindowDays || 0} day${refundWindowDays === '1' ? '' : 's'} of enrolling. Set to 0 for no refunds.`}>
                    <Input value={refundWindowDays} onChange={setRefundWindowDays} placeholder="7" type="number" />
                  </Field>

                  <Field label="Refund Policy, Terms & Privacy" hint="Upload these as files once your course is created — go to the course's Settings tab after saving.">
                    <p className="text-xs text-zinc-500">You'll be able to upload a Refund Policy, Terms & Conditions, and Privacy Policy file from the Settings tab of this course once it's created.</p>
                  </Field>

                  <SectionDivider label="Course Schedule" />
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <Field label="Course Launch Date" hint="When students can join the course. Don't know yet? You can set this later from the course's Settings tab.">
                      <Input value={startDate} onChange={setStartDate} placeholder="15th May 2026" />
                    </Field>
                    <Field label="Course Duration" hint="e.g. 4 Weeks / 20 Hours">
                      <Input value={duration} onChange={setDuration} placeholder="4 Weeks" />
                    </Field>
                  </div>

                  <SectionDivider label="What You Will Learn" />
                  <Field label="What You Will Learn" hint="Add key takeaways for students">
                    <div className="flex flex-col gap-2">
                      {whatYouWillLearn.map((item, i) => (
                        <div key={i} className="flex gap-2">
                          <Input value={item} onChange={v => updateWhatYouWillLearn(i, v)} placeholder={`Point ${i + 1}`} />
                          {whatYouWillLearn.length > 1 && (
                            <button onClick={() => removeWhatYouWillLearn(i)}
                              className="px-3 rounded-xl bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-all">
                              <X className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      ))}
                      <button onClick={addWhatYouWillLearn}
                        className="flex items-center gap-2 text-sm px-4 py-2 rounded-xl w-fit mt-1 transition-all"
                        style={{ background: 'rgba(255,255,255,0.05)', color: '#a1a1aa', border: '1px solid rgba(255,255,255,0.1)' }}>
                        <Plus className="w-3.5 h-3.5" />
                        Add Point
                      </button>
                      <AiFieldAssist
                        field="what_you_will_learn" entityType="course"
                        context={{ name, description, hostName, what_you_will_learn: whatYouWillLearn.filter(Boolean) }}
                        currentValue={whatYouWillLearn.filter(Boolean)}
                        onResult={v => Array.isArray(v) && setWhatYouWillLearn(v as string[])}
                        className="mt-1"
                      />
                    </div>
                  </Field>

                  <SectionDivider label="Instructor Bio" />

                  <Field label="Instructor Name" hint="Shown on course page">
                    <Input value={hostName} onChange={setHostName} placeholder="Your name" />
                  </Field>

                  <Field
                    label={
                      <>
                        Instructor Title{' '}
                        <span style={{ color: 'var(--kurso-primary)', fontWeight: 600 }}>(Optional)</span>
                      </>
                    }
                    hint="e.g. Certified SEO Expert · 8+ Years"
                  >
                    <Input value={instructorTitle} onChange={setInstructorTitle} placeholder="e.g. Certified Digital Marketer, 8+ Years Experience" />
                  </Field>

                  <Field label="Photo & Bio" hint="Shown on course page as instructor bio">
                    <div className="flex items-center gap-4 mb-4">
                      <div className="w-16 h-16 rounded-xl overflow-hidden bg-white/5 border border-white/10 flex items-center justify-center flex-shrink-0">
                        {hostImage ? (
                          <img src={hostImage} alt="Instructor" className="w-full h-full object-cover" />
                        ) : (
                          <span className="text-2xl font-bold text-zinc-700">
                            {hostName ? hostName.charAt(0).toUpperCase() : '?'}
                          </span>
                        )}
                      </div>
                      <div className="flex-1">
                        <input
                          type="file"
                          id="create-host-image"
                          className="hidden"
                          accept="image/*"
                          onChange={handleImageUpload}
                          disabled={uploadingImage}
                        />
                        <label
                          htmlFor="create-host-image"
                          className="inline-flex items-center px-4 py-2 rounded-lg text-xs font-medium bg-white/5 border border-white/10 text-white cursor-pointer hover:bg-white/10 transition-all"
                        >
                          {uploadingImage ? 'Uploading...' : hostImage ? 'Change Photo' : 'Upload Photo'}
                        </label>
                        {hostImage && (
                          <button
                            type="button"
                            onClick={() => setHostImage('')}
                            className="ml-2 text-xs text-zinc-500 hover:text-red-500"
                          >
                            Remove
                          </button>
                        )}
                        <p className="text-[10px] text-zinc-500 mt-1.5">Square JPG/PNG/WebP recommended, max 2MB.</p>
                      </div>
                    </div>
                    <textarea
                      value={aboutCreator}
                      onChange={e => setAboutCreator(e.target.value)}
                      placeholder="SEO expert with 8 years of experience..."
                      rows={3}
                      className="w-full px-4 py-3 rounded-xl text-sm text-white outline-none transition-all resize-none"
                      style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
                      onFocus={e => e.target.style.borderColor = 'var(--kurso-primary)'}
                      onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,0.1)'}
                    />
                    <AiFieldAssist
                      field="about_creator" entityType="course"
                      context={{ name, description, hostName, instructorTitle, about_creator: aboutCreator }}
                      currentValue={aboutCreator}
                      onResult={v => typeof v === 'string' && setAboutCreator(v)}
                      className="mt-2"
                    />
                  </Field>

                  <Field label="Additional Instructors" hint="Optional — for co-taught courses. Shown alongside you on the course page.">
                    <CoInstructorsEditor
                      value={coInstructors}
                      onChange={setCoInstructors}
                      onUpload={file => uploadToSupabase(file, 'images')}
                    />
                  </Field>

                  <SectionDivider label="Requirements" />
                  <Field label="Requirements / Prerequisites" hint="What students need before starting (leave blank if none)">
                    <div className="flex flex-col gap-2">
                      {requirements.map((item, i) => (
                        <div key={i} className="flex gap-2">
                          <Input value={item} onChange={v => { const n = [...requirements]; n[i] = v; setRequirements(n) }} placeholder={`e.g. Basic computer skills`} />
                          {requirements.length > 1 && (
                            <button onClick={() => setRequirements(requirements.filter((_, idx) => idx !== i))}
                              className="px-3 rounded-xl bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-all"><X className="w-4 h-4" /></button>
                          )}
                        </div>
                      ))}
                      <button onClick={() => setRequirements([...requirements, ''])}
                        className="flex items-center gap-2 text-sm px-4 py-2 rounded-xl w-fit transition-all"
                        style={{ background: 'rgba(255,255,255,0.05)', color: '#a1a1aa', border: '1px solid rgba(255,255,255,0.1)' }}>
                        <Plus className="w-3.5 h-3.5" />Add Requirement
                      </button>
                    </div>
                  </Field>

                  <SectionDivider label="Who Is This Course For?" />
                  <Field label="Who Is This Course For?" hint="Describe your ideal student (shown on landing page)">
                    <div className="flex flex-col gap-2">
                      {targetAudience.map((item, i) => (
                        <div key={i} className="flex gap-2">
                          <Input value={item} onChange={v => { const n = [...targetAudience]; n[i] = v; setTargetAudience(n) }} placeholder={`e.g. Beginners who want to start with digital marketing`} />
                          {targetAudience.length > 1 && (
                            <button onClick={() => setTargetAudience(targetAudience.filter((_, idx) => idx !== i))}
                              className="px-3 rounded-xl bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-all"><X className="w-4 h-4" /></button>
                          )}
                        </div>
                      ))}
                      <button onClick={() => setTargetAudience([...targetAudience, ''])}
                        className="flex items-center gap-2 text-sm px-4 py-2 rounded-xl w-fit transition-all"
                        style={{ background: 'rgba(255,255,255,0.05)', color: '#a1a1aa', border: '1px solid rgba(255,255,255,0.1)' }}>
                        <Plus className="w-3.5 h-3.5" />Add Audience
                      </button>
                    </div>
                  </Field>

                  <SectionDivider label="Frequently Asked Questions" />
                  <Field label="Frequently Asked Questions" hint="Address common student doubts">
                    <div className="flex flex-col gap-4">
                      {faqs.map((faq, i) => (
                        <div key={i} className="p-4 rounded-xl relative flex flex-col gap-2"
                          style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
                          <button onClick={() => removeFaq(i)}
                            className="absolute top-4 right-4 text-zinc-600 hover:text-red-500 transition-colors">
                            <X className="w-4 h-4" />
                          </button>
                          <input
                            value={faq.question}
                            onChange={e => updateFaq(i, 'question', e.target.value)}
                            placeholder="Question"
                            className="w-full bg-transparent text-sm text-white font-medium outline-none pr-8"
                          />
                          <textarea
                            value={faq.answer}
                            onChange={e => updateFaq(i, 'answer', e.target.value)}
                            placeholder="Answer"
                            rows={2}
                            className="w-full bg-transparent text-sm text-zinc-400 outline-none resize-none"
                          />
                        </div>
                      ))}
                      <button onClick={addFaq}
                        className="flex items-center gap-2 text-sm px-4 py-2 rounded-xl w-fit transition-all"
                        style={{ background: 'rgba(255,255,255,0.05)', color: '#a1a1aa', border: '1px solid rgba(255,255,255,0.1)' }}>
                        <Plus className="w-3.5 h-3.5" />
                        Add FAQ
                      </button>
                    </div>
                  </Field>
                </>
              )}
            </div>
          </div>

          {/* Bring-your-own-landing-page guidance — shown instead of the fields above */}
          {usesExternalLandingPage && (
            <div className="rounded-2xl p-6 md:p-8 glass" style={{ border: '1px solid rgba(var(--kurso-primary-rgb), 0.2)' }}>
              <div className="flex items-center gap-2 mb-5">
                <Globe className="w-4 h-4" style={{ color: 'var(--kurso-primary-light)' }} />
                <h2 className="font-semibold text-white">Setting Up On Your Own Page</h2>
              </div>

              <div className="flex flex-col gap-4">
                <div className="flex gap-3">
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                    style={{ background: 'rgba(var(--kurso-primary-rgb), 0.1)' }}>
                    <Code2 className="w-4 h-4" style={{ color: 'var(--kurso-primary-light)' }} />
                  </div>
                  <p className="text-sm leading-relaxed" style={{ color: '#a1a1aa' }}>
                    Once you create this course, we'll generate your enrollment code block on the
                    course's page — paste it in place of your current buy button. Style it however
                    you like; only the <code className="text-xs px-1 py-0.5 rounded" style={{ background: 'rgba(255,255,255,0.08)', color: '#e4e4e7' }}>data-kurso-course</code> attribute
                    needs to stay untouched. There's also a plain checkout link if your page builder
                    doesn't allow custom code.
                  </p>
                </div>

                <div className="flex gap-3">
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                    style={{ background: 'rgba(var(--kurso-primary-rgb), 0.1)' }}>
                    <MessageCircle className="w-4 h-4" style={{ color: 'var(--kurso-primary-light)' }} />
                  </div>
                  <p className="text-sm leading-relaxed" style={{ color: '#a1a1aa' }}>
                    Important: your own page's copy should mention that lessons are delivered on{' '}
                    <span className="text-white font-medium">
                      {delivery === 'both'
                        ? 'WhatsApp + Telegram'
                        : delivery === 'whatsapp'
                          ? 'WhatsApp'
                          : 'Telegram'}
                    </span>{' '}
                    <Send
                      className="w-3 h-3 inline"
                      style={{ color: 'var(--kurso-primary-light)' }}
                    />{' '}
                    — students coming from your page won't see Kurso's course page explaining this,
                    so your copy should set that expectation.
                  </p>
                </div>

                <div className="flex gap-3">
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                    style={{ background: 'rgba(var(--kurso-primary-rgb), 0.1)' }}>
                    <Wallet className="w-4 h-4" style={{ color: 'var(--kurso-primary-light)' }} />
                  </div>
                  <p className="text-sm leading-relaxed" style={{ color: '#a1a1aa' }}>
                    After setup, upload your lessons on the next screen, and connect your Razorpay,
                    Stripe, or Cashfree account with your API keys so payments can be verified and
                    settled directly to you.
                  </p>
                </div>

                <div className="flex flex-col sm:flex-row gap-3 mt-2">
                  <Link
                    href="/contact"
                    className="flex-1 flex items-center justify-center gap-2 text-sm font-medium px-4 py-3 rounded-xl transition-all"
                    style={{ background: 'rgba(255,255,255,0.05)', color: '#e4e4e7', border: '1px solid rgba(255,255,255,0.1)' }}>
                    <HelpCircle className="w-4 h-4" />
                    Need Help? Contact Us
                  </Link>
                  <Link
                    href="/dashboard/settings#payment-gateway"
                    className="flex-1 flex items-center justify-center gap-2 text-sm font-medium px-4 py-3 rounded-xl transition-all"
                    style={{ background: 'rgba(255,255,255,0.05)', color: '#e4e4e7', border: '1px solid rgba(255,255,255,0.1)' }}>
                    <KeyRound className="w-4 h-4" />
                    Add Payment API Keys
                  </Link>
                </div>
                <p className="text-xs" style={{ color: '#52525b' }}>
                  Both of these can wait — finish creating the course first, then handle them from
                  the course's Settings tab whenever you're ready.
                </p>
              </div>
            </div>
          )}

          {/* Delivery */}
          <div className="rounded-2xl p-6 md:p-8 glass"
            style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
            <h2 className="font-semibold text-white mb-5">Delivery Method</h2>
            {loadingPlan ? (
              <p className="text-sm" style={{ color: '#52525b' }}>Loading your plan…</p>
            ) : (
              <>
                <DeliveryMethodPicker
                  value={delivery}
                  onChange={setDelivery}
                  currentPlanId={effectivePlanId}
                  onUpgraded={(newPlanId: SubscriptionPlanId) => setEffectivePlanId(newPlanId)}
                />
                <p className="text-xs mt-3" style={{ color: 'rgba(247, 149, 20, 0.65)' }}>
                  Once this course is live, students who enroll will receive lessons through{' '}
                  <strong>
                    {delivery === 'both'
                      ? 'WhatsApp + Telegram'
                      : delivery === 'whatsapp'
                        ? 'WhatsApp'
                        : 'Telegram'}
                  </strong>
                  . You can change this anytime from the course's Settings tab.
                </p>
              </>
            )}
          </div>

          {/* Languages */}
          {!usesExternalLandingPage && (
            <div className="rounded-2xl p-6 md:p-8 glass"
              style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
              <h2 className="font-semibold text-white mb-5">Course Language(s)</h2>

              {/* Selected tags */}
              <div className="flex flex-wrap gap-2 mb-3">
                {selectedLanguages.map(lang => (
                  <span key={lang}
                    className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg"
                    style={{ background: 'rgba(var(--kurso-primary-rgb), 0.15)', color: 'var(--kurso-primary-light)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.3)' }}>
                    {lang}
                    <button onClick={() => toggleLanguage(lang)}>
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
                <button
                  onClick={() => setLangDropdown(!langDropdown)}
                  className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg transition-all"
                  style={{ background: 'rgba(255,255,255,0.05)', color: '#a1a1aa', border: '1px solid rgba(255,255,255,0.1)' }}>
                  <Plus className="w-3 h-3" />
                  Add Language
                </button>
              </div>

              {/* Dropdown */}
              {langDropdown && (
                <div className="rounded-xl overflow-hidden"
                  style={{ border: '1px solid rgba(255,255,255,0.1)', background: '#111' }}>
                  <div className="max-h-48 overflow-y-auto">
                    {LANGUAGES.filter(l => !selectedLanguages.includes(l)).map(lang => (
                      <button key={lang}
                        onClick={() => { toggleLanguage(lang); setLangDropdown(false) }}
                        className="w-full text-left px-4 py-2.5 text-sm transition-all"
                        style={{ color: '#a1a1aa' }}
                        onMouseEnter={e => {
                          e.currentTarget.style.background = 'rgba(var(--kurso-primary-rgb), 0.1)'
                          e.currentTarget.style.color = '#fff'
                        }}
                        onMouseLeave={e => {
                          e.currentTarget.style.background = 'transparent'
                          e.currentTarget.style.color = '#a1a1aa'
                        }}>
                        {lang}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="p-4 rounded-xl text-sm"
              style={{ background: 'rgba(239,68,68,0.08)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.2)' }}>
              {error}
            </div>
          )}

          {/* Submit */}
          <div className="flex gap-3">
            <button onClick={() => router.back()}
              className="px-6 py-3 rounded-xl text-sm font-medium transition-all"
              style={{ background: 'rgba(255,255,255,0.05)', color: '#a1a1aa' }}>
              Cancel
            </button>
            <button onClick={handleCreate} disabled={loading}
              className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-medium text-white violet-gradient hover:opacity-90 glow transition-all disabled:opacity-50">
              {loading ? 'Creating...' : 'Create Course & Add Lessons'}
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </main>
    </div>
  )
}