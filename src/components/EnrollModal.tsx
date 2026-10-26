"use client"
import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { X, Mail, User, Phone, Eye, EyeOff, Shield, Lock, ArrowRight, Search, ChevronDown, Play, MessageCircle, Ticket, CheckCircle2, LayoutGrid } from 'lucide-react'
import { slugify } from '@/lib/utils'
import { useBrandVars } from '@/components/BrandVarsContext'
import { useWhatsAppNumber } from '@/lib/use-whatsapp-number'

// `length` = expected number of digits for that country's mobile number,
// EXCLUDING the country code. Used to validate/cap the phone input instead
// of assuming every country is 10 digits like India.
const COUNTRIES = [
  { name: 'India', code: '+91', flag: '🇮🇳', length: 10 },
  { name: 'United States', code: '+1', flag: '🇺🇸', length: 10 },
  { name: 'United Kingdom', code: '+44', flag: '🇬🇧', length: 10 },
  { name: 'United Arab Emirates', code: '+971', flag: '🇦🇪', length: 9 },
  { name: 'Australia', code: '+61', flag: '🇦🇺', length: 9 },
  { name: 'Canada', code: '+1', flag: '🇨🇦', length: 10 },
  { name: 'Singapore', code: '+65', flag: '🇸🇬', length: 8 },
  { name: 'Germany', code: '+49', flag: '🇩🇪', length: 11 },
  { name: 'France', code: '+33', flag: '🇫🇷', length: 9 },
  { name: 'Saudi Arabia', code: '+966', flag: '🇸🇦', length: 9 },
  { name: 'Pakistan', code: '+92', flag: '🇵🇰', length: 10 },
  { name: 'Bangladesh', code: '+880', flag: '🇧🇩', length: 10 },
  { name: 'Nepal', code: '+977', flag: '🇳🇵', length: 10 },
  { name: 'Sri Lanka', code: '+94', flag: '🇱🇰', length: 9 },
]

function CountrySelector({ selected, onSelect }: { selected: any; onSelect: (c: any) => void }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({})
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)


  const reposition = useCallback(() => {
    if (!triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    const viewportHeight = window.innerHeight
    const dropdownHeight = 280 // max-h we'll enforce on the portal div
    const spaceBelow = viewportHeight - rect.bottom
    const spaceAbove = rect.top

    // Prefer opening downward; flip upward only when there isn't enough
    // space below AND there's more space above.
    const openUpward = spaceBelow < dropdownHeight && spaceAbove > spaceBelow

    setDropdownStyle({
      position: 'fixed',
      left: rect.left,
      width: Math.max(rect.width, 256), // at least 256px wide
      zIndex: 9999,
      ...(openUpward
        ? { bottom: viewportHeight - rect.top + 4 }
        : { top: rect.bottom + 4 }),
    })
  }, [])

  useEffect(() => {
    if (!open) return
    reposition()
    // Focus the search input once the portal has mounted
    const t = setTimeout(() => searchRef.current?.focus(), 30)

    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      clearTimeout(t)
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [open, reposition])

  // Close on outside click — must check both trigger and portal dropdown
  useEffect(() => {
    if (!open) return
    function handleMouseDown(e: MouseEvent) {
      const target = e.target as Node
      if (
        triggerRef.current?.contains(target) ||
        dropdownRef.current?.contains(target)
      ) return
      setOpen(false)
      setSearch('')
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [open])

  // Close on Escape key
  useEffect(() => {
    if (!open) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { setOpen(false); setSearch('') }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open])

  const filtered = COUNTRIES.filter(
    c =>
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.code.includes(search)
  )

  const dropdown = open ? (
    <div
      ref={dropdownRef}
      style={{
        ...dropdownStyle,
        background: '#121212',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: 12,
        boxShadow: '0 16px 48px rgba(0,0,0,0.6)',
        backdropFilter: 'blur(20px)',
        display: 'flex',
        flexDirection: 'column',
        maxHeight: 280,
        overflow: 'hidden',
      }}
    >
      {/* Search bar — sticky inside the portal */}
      <div
        style={{
          padding: '8px 8px 6px',
          borderBottom: '1px solid rgba(255,255,255,0.05)',
          background: '#121212',
          flexShrink: 0,
        }}
      >
        <div style={{ position: 'relative' }}>
          <Search
            style={{
              position: 'absolute', left: 10,
              top: '50%', transform: 'translateY(-50%)',
              width: 14, height: 14, color: '#71717a',
              pointerEvents: 'none',
            }}
          />
          <input
            ref={searchRef}
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search country..."
            style={{
              width: '100%',
              paddingLeft: 30, paddingRight: 10,
              paddingTop: 6, paddingBottom: 6,
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid transparent',
              borderRadius: 8,
              fontSize: 12, color: '#fff',
              outline: 'none',
              boxSizing: 'border-box',
            }}
            onFocus={e => (e.target.style.borderColor = 'rgba(var(--kurso-primary-rgb), 0.5)')}
            onBlur={e => (e.target.style.borderColor = 'transparent')}
          />
        </div>
      </div>

      {/* Country list — scrollable */}
      <div style={{ overflowY: 'auto', padding: 4, flex: 1 }}>
        {filtered.length === 0 ? (
          <p style={{ textAlign: 'center', padding: '12px 0', fontSize: 12, color: '#52525b' }}>
            No results
          </p>
        ) : (
          filtered.map(c => (
            <button
              key={c.name + c.code}
              type="button"
              onClick={() => { onSelect(c); setOpen(false); setSearch('') }}
              style={{
                width: '100%', display: 'flex', alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 10px', borderRadius: 8,
                background: 'transparent', border: 'none',
                cursor: 'pointer', textAlign: 'left',
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.06)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 18 }}>{c.flag}</span>
                <span style={{ fontSize: 12, color: '#d4d4d8', fontWeight: 500 }}>{c.name}</span>
              </div>
              <span style={{ fontSize: 11, color: '#71717a', fontWeight: 700 }}>{c.code}</span>
            </button>
          ))
        )}
      </div>
    </div>
  ) : null

  return (
    <>
      {/* Trigger button — sits inline in the form */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(v => !v)}
        style={{
          height: '100%',
          padding: '0 12px',
          display: 'flex', alignItems: 'center', gap: 6,
          borderRadius: '12px 0 0 12px',
          borderRight: '1px solid rgba(255,255,255,0.1)',
          background: 'rgba(255,255,255,0.05)',
          border: 'none',
          cursor: 'pointer',
          flexShrink: 0,
          transition: 'background 0.15s',
        }}
        onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.09)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.05)')}
      >
        <span style={{ fontSize: 16 }}>{selected.flag}</span>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#a1a1aa' }}>{selected.code}</span>
        <ChevronDown
          style={{
            width: 12, height: 12, color: '#71717a',
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 0.2s',
            flexShrink: 0,
          }}
        />
      </button>

      {/* Portal — renders at document.body, escapes all overflow clipping */}
      {typeof document !== 'undefined' && dropdown
        ? createPortal(dropdown, document.body)
        : null}
    </>
  )
}
import { supabase } from '@/lib/supabase'
import { findPaidEnrollment, findPaidEnrollmentByPhone } from '@/lib/enrollments'
import { normalizePhone } from '@/lib/phone'



interface CourseData {
  id: string
  name: string
  price: number
  creatorSlug: string
  creatorName: string
  creatorId: string
  telegramBotUsername?: string
  is_free_course?: boolean
  /** Creator's storefront handle — only set when they have other published
   *  courses. Note `creatorSlug` above is actually the COURSE slug. */
  moreCoursesSlug?: string
}

interface Props {
  onClose: () => void
  course: CourseData
  resumeOrderId?: string | null
}

// step 'demo-web' = student clicked "Watch on Website", modal closed
// but we re-open and show them the Telegram option + pay option
type Step = 'auth' | 'phone' | 'demo' | 'demo-web' | 'payment' | 'success'
type AuthMode = 'signup' | 'login'

type CouponResult = {
  valid: boolean
  reason: string
  coupon_id: string | null
  coupon_code: string | null
  discount_type: string | null
  discount_value: number | null
  original_amount: number
  discount_amount: number
  final_amount: number
}



// ── Telegram button ──────────────────────────────────────────────
function TelegramButton({ token, username, label }: { token: string; username: string; label?: string }) {
  const clean = username.replace('@', '')
  return (
    <a
      href={`https://t.me/${clean}?start=${token}`}
      target="_blank"
      rel="noopener noreferrer"
      className="w-full flex items-center justify-center gap-2 py-4 rounded-xl font-semibold text-white transition-all hover:opacity-90 text-base"
      style={{ background: '#229ED9' }}
    >
      <MessageCircle className="w-5 h-5" />
      {label ?? 'Continue on Telegram'}
    </a>
  )
}

// ── Token spinner placeholder ────────────────────────────────────
function TokenLoading({ color, label }: { color: string; label: string }) {
  return (
    <div className="w-full py-4 rounded-xl text-sm text-center animate-pulse"
      style={{ background: color, color: '#fff', opacity: 0.5 }}>
      {label}
    </div>
  )
}

// ── WhatsApp button ──────────────────────────────────────────────
function WhatsAppButton({ token, label, number }: { token: string; label?: string; number: string }) {
  const href = `https://wa.me/${number}?text=${encodeURIComponent('/start ' + token)}`
  return (
    <a

      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="w-full flex items-center justify-center gap-2 py-4 rounded-xl font-semibold text-white transition-all hover:opacity-90 text-base"
      style={{ background: '#25D366' }}
    >
      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
        <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
      </svg>
      {label ?? 'Continue on WhatsApp'}
    </a>
  )
}

export default function EnrollModal({ onClose, course, resumeOrderId }: Props) {
  const [step, setStep] = useState<Step>('auth')
  const [authMode, setAuthMode] = useState<AuthMode>('signup')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [checkoutOrder, setCheckoutOrder] = useState<any>(null)
  const [checkingStatus, setCheckingStatus] = useState(false)
    const [checkingAuth, setCheckingAuth] = useState(true)
  // Theme colors of the landing page this popup was opened from (null elsewhere).
  const brandVars = useBrandVars()

  // Auth fields
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [selectedCountry, setSelectedCountry] = useState(COUNTRIES[0])
  const [password, setPassword] = useState('')
  const [showPass, setShowPass] = useState(false)

  // Student data
  const [studentData, setStudentData] = useState<any>(null)

  // Coupon data
  const [couponCode, setCouponCode] = useState('')
  const [couponResult, setCouponResult] = useState<CouponResult | null>(null)
  const [couponLoading, setCouponLoading] = useState(false)
  const [couponMessage, setCouponMessage] = useState('')

  // Tokens — generated async, non-blocking
  const [telegramToken, setTelegramToken] = useState('')
  const [demoTelegramToken, setDemoTelegramToken] = useState('')
  const [whatsappToken, setWhatsappToken] = useState('')
  const [demoWhatsappToken, setDemoWhatsappToken] = useState('')
  const [generatingDemo, setGeneratingDemo] = useState(false)
  const [generatingPaid, setGeneratingPaid] = useState(false)

  const hasTelegram = Boolean(course.telegramBotUsername)
  const waNumber = useWhatsAppNumber(course.id) // the creator's own number if they connected one
  const hasWhatsApp = Boolean(waNumber)
  // A course is "nothing free" when it has no free lessons AND is not free-course —
  // meaning there's no preview to offer before payment.
  const isNothingFree = !course.is_free_course && course.price > 0
  const isCompletelyFree = course.price === 0 || course.is_free_course === true

  const creatorSlug = slugify(course.creatorName)
  const courseSlug = slugify(course.creatorSlug)
  const learnUrl = `/course/${creatorSlug}/${courseSlug}/${course.id}`
  const aboutUrl = `/about-course/${creatorSlug}/${courseSlug}/${course.id}`
  const activeCoupon = couponResult?.valid ? couponResult : null
  const discountAmount = activeCoupon?.discount_amount || 0
  const payableAmount = activeCoupon?.final_amount ?? course.price

  // ── Token helpers ────────────────────────────────────────────────
  async function generateDemoTokens(data: any) {
    if (!data) return
    setGeneratingDemo(true)
    try {
      const requests: Promise<void>[] = []

      if (hasTelegram) {
        requests.push(
          fetch('/api/telegram/create-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              studentId: data.id,
              studentPhone: data.phone,
              studentEmail: data.email,
              studentName: data.name,
              creatorId: course.creatorId,
              courseId: course.id,
              paymentId: null,
            }),
          })
            .then(r => r.json())
            .then(({ token }) => { if (token) setDemoTelegramToken(token) })
            .catch(e => console.error('Demo Telegram token error:', e))
        )
      }

      if (hasWhatsApp) {
        requests.push(
          fetch('/api/whatsapp/create-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              studentId: data.id,
              studentPhone: data.phone,
              studentEmail: data.email,
              studentName: data.name,
              creatorId: course.creatorId,
              courseId: course.id,
              paymentId: null,
            }),
          })
            .then(r => r.json())
            .then(({ token }) => { if (token) setDemoWhatsappToken(token) })
            .catch(e => console.error('Demo WhatsApp token error:', e))
        )
      }

      await Promise.all(requests)
    } catch (e) {
      console.error('Demo token error:', e)
    }
    setGeneratingDemo(false)
  }

  async function generatePaidTokens(data: any, paymentId: string, enrollmentId?: string) {
    if (!data) return
    setGeneratingPaid(true)
    try {
      const requests: Promise<void>[] = []

      if (hasTelegram) {
        requests.push(
          fetch('/api/telegram/create-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              studentId: data.id,
              studentPhone: data.phone,
              studentEmail: data.email,
              studentName: data.name,
              creatorId: course.creatorId,
              courseId: course.id,
              paymentId,
            }),
          })
            .then(r => r.json())
            .then(({ token, expiresAt }) => {
              if (token) {
                setTelegramToken(token)
                if (enrollmentId) {
                  fetch('/api/telegram/save-enrollment-token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enrollmentId, token, expiresAt }),
                  }).catch(e => console.error('save-enrollment-token error:', e))
                }
              }
            })
            .catch(e => console.error('Paid Telegram token error:', e))
        )
      }

      if (hasWhatsApp) {
        requests.push(
          fetch('/api/whatsapp/create-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              studentId: data.id,
              studentPhone: data.phone,
              studentEmail: data.email,
              studentName: data.name,
              creatorId: course.creatorId,
              courseId: course.id,
              paymentId,
            }),
          })
            .then(r => r.json())
            .then(({ token, expiresAt }) => {
              if (token) {
                setWhatsappToken(token)
                if (enrollmentId) {
                  fetch('/api/whatsapp/save-enrollment-token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enrollmentId, token, expiresAt }),
                  }).catch(e => console.error('save-wa-enrollment-token error:', e))
                }
              }
            })
            .catch(e => console.error('Paid WhatsApp token error:', e))
        )
      }

      await Promise.all(requests)
    } catch (e) {
      console.error('Paid token error:', e)
    }
    setGeneratingPaid(false)
  }

  // ── Check session on mount ───────────────────────────────────────
  useEffect(() => {
    async function checkSession() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { setCheckingAuth(false); return }

      // Hard guard: if this user is the course owner, close the modal immediately.
      // This is the belt-and-suspenders check — the enroll button should already
      // be hidden for owners, but this handles any edge case where the modal
      // was opened before the owner check resolved.
      if (user.id === course.creatorId) {
        onClose()
        return
      }

      const enrollment = await findPaidEnrollment({ courseId: course.id, user, select: 'id' })
      if (enrollment) { window.location.href = learnUrl; return }

      const userData = {
        id: user.id,
        email: user.email || '',
        name: user.user_metadata?.full_name || user.user_metadata?.name || '',
        phone: user.user_metadata?.phone || '',
      }
      setStudentData(userData)
      setName(userData.name)
      setEmail(userData.email)

      if (!userData.phone) {
        setStep('phone')
      } else if (isNothingFree || isCompletelyFree) {
        setStep('payment')
      } else {
        setStep('demo')
        generateDemoTokens(userData)
      }
      setCheckingAuth(false)
    }
    checkSession()
  }, [course.id])

  // Handles the redirect-back case — the student lands back on this page
  // after paying on Cashfree's or Stripe's hosted checkout. We confirm via
  // our own order status, never by trusting the return URL itself.
  // Cashfree's redirect only appends ?order_id= (no status flag), so we
  // poll whenever an order_id shows up, not only when status=success too.
  useEffect(() => {
    if (!studentData) return
    const params = new URLSearchParams(window.location.search)
    const orderId = params.get('order_id')
    if (!orderId) return
    setStep('payment')
    setCheckingStatus(true)
    pollOrderStatus(orderId).then(async (result) => {
      setCheckingStatus(false)
      if (result === 'success') await handlePaymentConfirmed(orderId)
      else setError('We could not confirm this payment yet. If money was deducted, it will reflect within a few minutes — refresh this page, or contact support if it does not.')
    })
  }, [studentData])

  // ── Auth handlers ────────────────────────────────────────────────
  async function handleGoogleLogin() {
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}${aboutUrl}?enroll=true`,
        queryParams: { prompt: 'select_account' },
      },
    })
  }

  // FormEvent is deprecated in @types/react 19.2+ — it was only ever an
  // alias for SyntheticEvent<T>. Use SyntheticEvent<HTMLFormElement> for
  // form onSubmit handlers instead, everywhere in this codebase.
  async function handleEmailAuth(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      if (authMode === 'signup') {
        const cleanedPhone = phone.trim().replace(/\D/g, '')
        if (cleanedPhone.length !== selectedCountry.length) {
          setError(`Please enter a valid ${selectedCountry.length}-digit mobile number`)
          setLoading(false)
          return
        }
        const phoneToStore = normalizePhone(selectedCountry.code.replace('+', '') + cleanedPhone) || cleanedPhone
        const existing = await findPaidEnrollmentByPhone(course.id, phoneToStore)
        if (existing) { setError('This mobile number is already enrolled in this course.'); setLoading(false); return }

        const { data, error } = await supabase.auth.signUp({
          email, password,
          options: { data: { full_name: name, role: 'student', phone: phoneToStore } },
        })

        // If the email is already registered (e.g. a creator signing up on
        // another creator's course page), catch it gracefully and switch to
        // login mode instead of showing a cryptic error.
        if (error) {
          if (
            error.message.toLowerCase().includes('already registered') ||
            error.message.toLowerCase().includes('user already exists') ||
            error.message.toLowerCase().includes('already been registered')
          ) {
            setAuthMode('login')
            setError('This email is already registered. Please sign in below to enroll.')
            setLoading(false)
            return
          }
          throw error
        }
        const { error: signInError } = await supabase.auth.signInWithPassword({ email, password })
        if (signInError) throw signInError
        const sd = { id: data.user?.id, email, name, phone: phoneToStore }
        setStudentData(sd)
        if (isNothingFree || isCompletelyFree) {
          setStep('payment')
        } else {
          setStep('demo')
          generateDemoTokens(sd)
        }
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error
        const user = data.user
        const userData = {
          id: user.id,
          email: user.email || '',
          name: user.user_metadata?.full_name || name || '',
          phone: user.user_metadata?.phone || phone,
        }
        setStudentData(userData)
        const enrollment = await findPaidEnrollment({ courseId: course.id, user, phone: userData.phone, select: 'id' })
        if (enrollment) { window.location.href = learnUrl; return }
        if (!userData.phone) { setLoading(false); setStep('phone'); return }
        if (isNothingFree || isCompletelyFree) {
          setStep('payment')
        } else {
          setStep('demo')
          generateDemoTokens(userData)
        }
      }
    } catch (err: any) {
      setError(err.message)
    }
    setLoading(false)
  }

  async function handlePhoneSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault()
    const cleanedPhone = phone.trim().replace(/\D/g, '')
    if (cleanedPhone.length !== selectedCountry.length) { setError(`Please enter a valid ${selectedCountry.length}-digit mobile number`); return }
    const phoneToStore = normalizePhone(selectedCountry.code.replace('+', '') + cleanedPhone) || cleanedPhone
    setLoading(true)
    setError('')
    try {
      const existing = await findPaidEnrollmentByPhone(course.id, phoneToStore)
      if (existing) { setError('This mobile number is already enrolled in this course.'); setLoading(false); return }
      await supabase.auth.updateUser({ data: { phone: phoneToStore } })
      const sd = { ...studentData, phone: phoneToStore }
      setStudentData(sd)
      if (isNothingFree || isCompletelyFree) {
        setStep('payment')
      } else {
        setStep('demo')
        generateDemoTokens(sd)
      }
    } catch (err: any) {
      setError(err.message)
    }
    setLoading(false)
  }

  async function handleApplyCoupon() {
    const code = couponCode.trim()
    setCouponMessage('')
    setCouponResult(null)

    if (!code) {
      setCouponMessage('Enter a coupon code')
      return
    }

    setCouponLoading(true)
    try {
      const { data, error } = await supabase.rpc('validate_coupon_for_course', {
        input_course_id: course.id,
        input_coupon_code: code,
      })

      if (error) throw error

      const result = data?.[0] as CouponResult | undefined
      if (!result?.valid) {
        setCouponMessage(result?.reason || 'Invalid coupon code')
        return
      }

      if (result.final_amount <= 0) {
        setCouponResult(result)
        setCouponCode(result.coupon_code || code.toUpperCase())
        setCouponMessage(result.reason || 'Coupon applied! This course is now free.')
        return
      }

      setCouponResult(result)
      setCouponCode(result.coupon_code || code.toUpperCase())
      setCouponMessage(result.reason || 'Coupon applied')
    } catch (err: any) {
      setCouponMessage(err.message || 'Could not apply coupon')
    } finally {
      setCouponLoading(false)
    }
  }

  function clearCoupon() {
    setCouponCode('')
    setCouponResult(null)
    setCouponMessage('')
  }

  async function handleFreeEnrollment() {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/free-enroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          courseId: course.id,
          studentId: studentData?.id || null,
          studentEmail: studentData?.email || null,
          studentName: studentData?.name || null,
          studentPhone: studentData?.phone || null,
          couponCode: activeCoupon?.coupon_code || null,
        }),
      })

      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.error || 'Enrollment failed')
      }

      if (data.enrollmentId) {
        await generatePaidTokens(studentData, 'FREE', data.enrollmentId)
      } else {
        await generatePaidTokens(studentData, 'FREE')
      }

      setStep('success')
    } catch (err: any) {
      setError(err.message || 'Something went wrong during free enrollment.')
    } finally {
      setLoading(false)
    }
  }

  // ── Payment SDK helpers ──────────────────────────────────────────
  async function loadCashfreeSdk(): Promise<any> {
    if ((window as any).__cashfreeInstance) return (window as any).__cashfreeInstance
    await new Promise<void>((resolve, reject) => {
      if (document.getElementById('cashfree-sdk-script')) return resolve()
      const script = document.createElement('script')
      script.id = 'cashfree-sdk-script'
      script.src = 'https://sdk.cashfree.com/js/v3/cashfree.js'
      script.onload = () => resolve()
      script.onerror = () => reject(new Error('Could not load the payment SDK. Check your connection and try again.'))
      document.body.appendChild(script)
    })
    const instance = (window as any).Cashfree({ mode: 'production' })
      ; (window as any).__cashfreeInstance = instance
    return instance
  }

  async function loadRazorpaySdk(): Promise<void> {
    if ((window as any).Razorpay) return
    await new Promise<void>((resolve, reject) => {
      if (document.getElementById('razorpay-sdk-script')) return resolve()
      const script = document.createElement('script')
      script.id = 'razorpay-sdk-script'
      script.src = 'https://checkout.razorpay.com/v1/checkout.js'
      script.onload = () => resolve()
      script.onerror = () => reject(new Error('Could not load the payment SDK. Check your connection and try again.'))
      document.body.appendChild(script)
    })
  }

  async function pollOrderStatus(clientTxnId: string, attemptsLeft = 8): Promise<string | null> {
    if (attemptsLeft <= 0) return null
    const res = await fetch(`/api/order-status?clientTxnId=${clientTxnId}`)
    const data = await res.json().catch(() => null)
    if (data?.status === 'success') return data.status
    await new Promise((r) => setTimeout(r, 2000))
    return pollOrderStatus(clientTxnId, attemptsLeft - 1)
  }

  // Called once our own DB confirms the payment succeeded — never called
  // directly off a gateway's client-side "success" callback, since that
  // only means the modal closed, not that the webhook has landed yet.
  async function handlePaymentConfirmed(clientTxnId: string) {
    const confirmedEnrollment = await findPaidEnrollment({
      courseId: course.id,
      user: (await supabase.auth.getUser()).data.user,
      phone: studentData?.phone,
      select: 'id',
    })
    const enrollmentId = confirmedEnrollment?.id || null
    if (!enrollmentId) {
      setError('Payment received but enrollment not found yet. Please refresh in a moment or contact support.')
      return
    }
    setStep('success')
    generatePaidTokens(studentData, clientTxnId, enrollmentId)
  }

  // ── Payment ──────────────────────────────────────────────────────
  async function handlePayment() {
    setLoading(true)
    setError('')
    try {
      const orderRes = await fetch('/api/checkout/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          courseId: course.id,
          couponCode: activeCoupon?.coupon_code || '',
          studentName: studentData?.name,
          studentEmail: studentData?.email,
          studentPhone: studentData?.phone,
          studentAuthId: studentData?.id,
          returnUrl: window.location.href,
        }),
      })
      const data = await orderRes.json()
      if (data.error) throw new Error(data.error)
      if (data.pricing) {
        setCouponResult({
          valid: true,
          reason: activeCoupon ? 'Coupon applied' : '',
          coupon_id: data.pricing.couponId,
          coupon_code: data.pricing.couponCode,
          discount_type: activeCoupon?.discount_type || null,
          discount_value: activeCoupon?.discount_value || null,
          original_amount: data.pricing.originalAmount,
          discount_amount: data.pricing.discountAmount,
          final_amount: data.pricing.finalAmount,
        })
      }
      setCheckoutOrder(data)

      const { clientTxnId, order } = data

      if (order.provider === 'cashfree') {
        const cashfree = await loadCashfreeSdk()
        // Redirect mode — the browser navigates to Cashfree's hosted page
        // and back to our return_url (?order_id= guaranteed server-side).
        // Nothing after this line runs; the parent course page detects the
        // returning order_id and reopens this modal with resumeOrderId set.
        await cashfree.checkout({ paymentSessionId: order.paymentSessionId, redirectTarget: '_self' })
        return
      }

      if (order.provider === 'razorpay') {
        await loadRazorpaySdk()
        const rzp = new (window as any).Razorpay({
          key: order.keyId,
          amount: order.amountPaise,
          currency: order.currency,
          order_id: order.orderId,
          name: course.name,
          prefill: { name: studentData?.name, email: studentData?.email, contact: studentData?.phone },
          handler: async () => {
            setCheckingStatus(true)
            const status = await pollOrderStatus(clientTxnId)
            setCheckingStatus(false)
            if (status === 'success') await handlePaymentConfirmed(clientTxnId)
            else setError('Payment received but not yet confirmed — refresh this page in a moment.')
          },
          modal: { ondismiss: () => setLoading(false) },
        })
        rzp.open()
        return
      }

      if (order.provider === 'stripe') {
        window.location.href = order.checkoutUrl
        return
      }

      throw new Error('Unsupported payment method.')
    } catch (err: any) {
      setError(err.message)
      setLoading(false)
    }
  }

  // ── Loading ──────────────────────────────────────────────────────
  if (checkingAuth) {
    const loadingModal = (
      <div className="fixed inset-0 z-50 flex items-center justify-center" data-brand-scope
        style={{ ...brandVars, background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(12px)' }}>
        <div className="w-10 h-10 violet-gradient rounded-xl animate-pulse-glow" />
      </div>
    )
    return typeof document !== 'undefined' ? createPortal(loadingModal, document.body) : null
  }

  const modalContent = (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" data-brand-scope
      style={{ ...brandVars, background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(12px)' }}>
      <div className="w-full max-w-md rounded-2xl overflow-hidden"
        style={{ background: '#0a0a0a', border: '1px solid rgba(var(--kurso-primary-rgb), 0.3)' }}>

        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b"
          style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
          <div className="min-w-0">
            <h2 className="font-semibold text-white">
              {step === 'auth' && 'Enroll in Course'}
              {step === 'phone' && 'Add Your Number'}
              {step === 'demo' && 'You\'re In — Choose How to Start'}
              {step === 'demo-web' && 'Continue on Telegram'}
              {step === 'payment' && 'Complete Payment'}
              {step === 'success' && 'You\'re Enrolled! 🎉'}
            </h2>
            <p className="text-xs mt-0.5" style={{ color: '#52525b' }}>{course.name}</p>
          </div>
                    <div className="flex items-center gap-2 flex-shrink-0 ml-3">
            {/* Only on the first step and while nothing is submitting — leaving
                mid-payment or mid-signup would drop the student's progress. */}
            {step === 'auth' && !loading && course.moreCoursesSlug && (
              <Link
                href={`/creator/${course.moreCoursesSlug}?from=${course.id}`}
                aria-label="More courses"
                className="h-8 px-2.5 min-[380px]:px-3 flex items-center gap-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-opacity hover:opacity-80"
                style={{ background: 'rgba(255,255,255,0.05)', color: '#a1a1aa' }}>
                <LayoutGrid className="w-3.5 h-3.5" />
                <span className="hidden min-[380px]:inline">More Courses</span>
              </Link>
            )}
            <button onClick={onClose}
              className="w-8 h-8 flex items-center justify-center rounded-lg"
              style={{ background: 'rgba(255,255,255,0.05)', color: '#a1a1aa' }}>
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* ── AUTH ── */}
        {step === 'auth' && (
          <div className="p-6">
            <div className="flex rounded-xl p-1 mb-5" style={{ background: 'rgba(255,255,255,0.05)' }}>
              {(['signup', 'login'] as AuthMode[]).map(m => (
                <button key={m} onClick={() => { setAuthMode(m); setError('') }}
                  className="flex-1 py-2 rounded-lg text-sm font-medium transition-all"
                  style={{
                    background: authMode === m ? 'rgba(var(--kurso-primary-rgb), 0.3)' : 'transparent',
                    color: authMode === m ? '#fff' : '#a1a1aa',
                  }}>
                  {m === 'signup' ? 'New Student' : 'Already have account'}
                </button>
              ))}
            </div>

            <button onClick={handleGoogleLogin}
              className="w-full flex items-center justify-center gap-3 py-3 rounded-xl text-white text-sm mb-5 transition-all hover:opacity-90"
              style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)' }}>
              <svg className="w-5 h-5" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" />
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
              </svg>
              Continue with Google
            </button>

            <div className="flex items-center gap-4 mb-5">
              <div className="flex-1 h-px" style={{ background: 'rgba(255,255,255,0.08)' }} />
              <span className="text-xs" style={{ color: '#52525b' }}>or with email</span>
              <div className="flex-1 h-px" style={{ background: 'rgba(255,255,255,0.08)' }} />
            </div>

            <form onSubmit={handleEmailAuth} className="flex flex-col gap-3">
              {authMode === 'signup' && (
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: '#52525b' }} />
                  <input type="text" value={name} onChange={e => setName(e.target.value)}
                    placeholder="Full name" required
                    className="w-full pl-10 pr-4 py-3 rounded-xl text-sm text-white outline-none"
                    style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
                    onFocus={e => e.target.style.borderColor = 'var(--kurso-primary)'}
                    onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,0.1)'} />
                </div>
              )}

              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: '#52525b' }} />
                <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="Email address" required
                  className="w-full pl-10 pr-4 py-3 rounded-xl text-sm text-white outline-none"
                  style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
                  onFocus={e => e.target.style.borderColor = 'var(--kurso-primary)'}
                  onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,0.1)'} />
              </div>

              {authMode === 'signup' && (
                <div className="flex gap-2">
                  <CountrySelector selected={selectedCountry} onSelect={c => { setSelectedCountry(c); setPhone('') }} />
                  <div className="relative flex-1">
                    <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: '#52525b' }} />
                    <input type="tel" value={phone}
                      onChange={e => { const v = e.target.value.replace(/\D/g, ''); if (v.length <= selectedCountry.length) setPhone(v) }}
                      placeholder={`Mobile number (${selectedCountry.length} digits)`} required maxLength={selectedCountry.length}
                      className="w-full pl-10 pr-4 py-3 rounded-r-xl text-sm text-white outline-none"
                      style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderLeft: 'none' }}
                      onFocus={e => e.target.style.borderColor = 'var(--kurso-primary)'}
                      onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,0.1)'} />
                  </div>
                </div>
              )}

              <div className="relative">
                <input type={showPass ? 'text' : 'password'} value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder={authMode === 'signup' ? 'Create password (min 8 chars)' : 'Your password'}
                  required minLength={authMode === 'signup' ? 8 : undefined}
                  className="w-full px-4 pr-10 py-3 rounded-xl text-sm text-white outline-none"
                  style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
                  onFocus={e => e.target.style.borderColor = 'var(--kurso-primary)'}
                  onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,0.1)'} />
                <button type="button" onClick={() => setShowPass(!showPass)}
                  className="absolute right-3 top-1/2 -translate-y-1/2" style={{ color: '#52525b' }}>
                  {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>

              {error && (
                <div className="p-3 rounded-xl text-sm"
                  style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.2)' }}>
                  {error}
                </div>
              )}

              <button type="submit" disabled={loading}
                className="w-full py-3 rounded-xl font-medium text-white violet-gradient hover:opacity-90 glow disabled:opacity-50 mt-1">
                {loading ? 'Please wait...' : authMode === 'signup' ? 'Sign Up & Continue →' : 'Sign In & Continue →'}
              </button>
            </form>

            <div className="flex items-center gap-2 mt-4 p-3 rounded-xl"
              style={{ background: 'rgba(74,222,128,0.05)', border: '1px solid rgba(74,222,128,0.1)' }}>
              <Lock className="w-3.5 h-3.5 flex-shrink-0" style={{ color: '#4ade80' }} />
              <p className="text-xs" style={{ color: '#52525b' }}>
                Your number is needed to deliver lessons on Telegram after payment.
              </p>
            </div>
          </div>
        )}

        {/* ── PHONE ── */}
        {step === 'phone' && (
          <div className="p-6">
            <div className="text-center mb-6">
              <div className="w-12 h-12 rounded-2xl flex items-center justify-center mx-auto mb-3"
                style={{ background: 'rgba(37,211,102,0.1)', border: '1px solid rgba(37,211,102,0.2)' }}>
                <Phone className="w-6 h-6" style={{ color: '#25d366' }} />
              </div>
              <h3 className="font-semibold text-white mb-1">One more thing</h3>
              <p className="text-sm" style={{ color: '#a1a1aa' }}>
                We need your number to deliver lessons on Telegram after payment.
              </p>
            </div>
            <form onSubmit={handlePhoneSubmit} className="flex flex-col gap-4">
              <div className="flex gap-2">
                <CountrySelector selected={selectedCountry} onSelect={c => { setSelectedCountry(c); setPhone('') }} />
                <div className="relative flex-1">
                  <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: '#52525b' }} />
                  <input type="tel" value={phone}
                    onChange={e => { const v = e.target.value.replace(/\D/g, ''); if (v.length <= selectedCountry.length) setPhone(v) }}
                    placeholder={`${selectedCountry.length} digit number`} required maxLength={selectedCountry.length}
                    className="w-full pl-10 pr-4 py-3 rounded-r-xl text-sm text-white outline-none"
                    style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderLeft: 'none' }}
                    onFocus={e => e.target.style.borderColor = 'var(--kurso-primary)'}
                    onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,0.1)'} />
                </div>
              </div>
              {error && <p className="text-sm" style={{ color: '#ef4444' }}>{error}</p>}
              <button type="submit" disabled={loading}
                className="w-full py-3 rounded-xl font-medium text-white violet-gradient hover:opacity-90 glow disabled:opacity-50">
                {loading ? 'Saving...' : 'Continue →'}
              </button>
            </form>
          </div>
        )}

        {/* ── DEMO ── */}
        {step === 'demo' && (
          <div className="p-6">
            <div className="text-center mb-5">
              <div className="w-12 h-12 rounded-2xl flex items-center justify-center mx-auto mb-3"
                style={{ background: 'rgba(var(--kurso-primary-rgb), 0.1)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.2)' }}>
                <Play className="w-6 h-6 text-violet-400" />
              </div>
              <h3 className="text-lg font-bold text-white mb-1">
                Welcome{studentData?.name ? `, ${studentData.name.split(' ')[0]}` : ''}!
              </h3>
              <p className="text-sm" style={{ color: '#a1a1aa' }}>
                Free preview unlocked. Start right now — on Telegram or on the website.
              </p>
            </div>

            <div className="flex flex-col gap-3">
              {/* Telegram */}
              {hasTelegram && (
                demoTelegramToken
                  ? <TelegramButton token={demoTelegramToken} username={course.telegramBotUsername!} label="Start Free Lessons on Telegram" />
                  : <TokenLoading color="rgba(34,158,217,0.5)" label="Preparing Telegram link…" />
              )}

              {/* WhatsApp */}
              {hasWhatsApp && (
                demoWhatsappToken
                  ? <WhatsAppButton token={demoWhatsappToken} number={waNumber} label="Start Free Lessons on WhatsApp" />
                  : <TokenLoading color="rgba(37,211,102,0.5)" label="Preparing WhatsApp link…" />
              )}

              {/* Watch on website — sets demo-web step so Telegram button stays accessible */}
              <button
                onClick={() => {
                  // Open the course in a new tab so the modal stays open
                  window.open(learnUrl, '_blank')
                  setStep('demo-web')
                }}
                className="w-full flex items-center justify-center gap-2 py-3.5 rounded-xl font-medium text-white transition-all hover:opacity-90"
                style={{ background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.1)' }}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
                Watch Demo on Website
              </button>

              {/* Pay CTA */}
              <button onClick={() => setStep('payment')}
                className="w-full py-4 rounded-xl font-semibold text-white violet-gradient hover:opacity-90 glow transition-all text-base">
                Enroll Now — ₹{course.price.toLocaleString()}
              </button>
              <p className="text-center text-xs" style={{ color: '#98989b', fontSize: '1.1rem' }}>
                Already enrolled?{' '}
                <a href="/my-courses" style={{ color: 'var(--kurso-primary-light)', fontSize: '1.1rem' }}>View my courses →</a>
              </p>
            </div>
          </div>
        )}

        {/* ── DEMO-WEB: student opened website, now show Telegram option + pay ── */}
        {step === 'demo-web' && (
          <div className="p-6">
            <div className="text-center mb-5">
              <p className="text-sm font-semibold text-white mb-1">Enjoying the preview?</p>
              <p className="text-sm" style={{ color: '#a1a1aa' }}>
                Get lessons delivered straight to your Telegram — no browser needed.
              </p>
            </div>

            <div className="flex flex-col gap-3">
              {/* Telegram — token already generated during demo step */}
              {hasTelegram && (
                demoTelegramToken
                  ? <TelegramButton token={demoTelegramToken} username={course.telegramBotUsername!} label="Continue on Telegram" />
                  : <TokenLoading color="rgba(34,158,217,0.5)" label="Preparing Telegram link…" />
              )}

              {/* Back to website */}
              <button
                onClick={() => window.open(learnUrl, '_blank')}
                className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-medium transition-all hover:opacity-80"
                style={{ background: 'rgba(255,255,255,0.05)', color: '#a1a1aa', border: '1px solid rgba(255,255,255,0.08)' }}
              >
                Continue watching on website
              </button>

              {/* Pay */}
              <button onClick={() => setStep('payment')}
                className="w-full py-4 rounded-xl font-semibold text-white violet-gradient hover:opacity-90 glow transition-all text-base">
                Enroll & Unlock All — ₹{course.price.toLocaleString()}
              </button>
              <p className="text-center text-xs" style={{ color: '#8b8b8d', fontSize: '1.1rem' }}>
                Already enrolled?{' '}
                <a href="/my-courses" style={{ color: 'var(--kurso-primary-light)', fontSize: '1.1rem' }}>View my courses →</a>
              </p>
            </div>
          </div>
        )}

        {/* ── PAYMENT ── */}
        {step === 'payment' && (
          <div className="p-6">
            <div className="rounded-xl p-4 mb-5"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
              <p className="text-xs mb-3 font-semibold uppercase tracking-wider" style={{ color: '#52525b' }}>
                Order Summary
              </p>
              <div className="flex justify-between items-center mb-2">
                <span className="text-sm text-white">{course.name}</span>
                <span className="text-sm font-bold text-white">₹{course.price.toLocaleString()}</span>
              </div>
              <div className="mt-4 pt-4" style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Ticket className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: activeCoupon ? '#4ade80' : '#52525b' }} />
                    <input
                      type="text"
                      value={couponCode}
                      onChange={e => {
                        setCouponCode(e.target.value.toUpperCase())
                        setCouponResult(null)
                        setCouponMessage('')
                      }}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          handleApplyCoupon()
                        }
                      }}
                      placeholder="Coupon code"
                      disabled={Boolean(activeCoupon)}
                      className="w-full pl-10 pr-4 py-3 rounded-xl text-sm text-white outline-none uppercase disabled:opacity-80"
                      style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
                    />
                  </div>
                  {activeCoupon ? (
                    <button
                      type="button"
                      onClick={clearCoupon}
                      className="px-4 py-3 rounded-xl text-sm font-semibold transition-all"
                      style={{ background: 'rgba(255,255,255,0.06)', color: '#a1a1aa', border: '1px solid rgba(255,255,255,0.1)' }}
                    >
                      Remove
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={handleApplyCoupon}
                      disabled={couponLoading || !couponCode.trim()}
                      className="px-4 py-3 rounded-xl text-sm font-semibold transition-all disabled:opacity-50"
                      style={{ background: 'rgba(var(--kurso-primary-rgb), 0.18)', color: 'var(--kurso-primary-lightest)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.3)' }}
                    >
                      {couponLoading ? 'Checking' : 'Apply'}
                    </button>
                  )}
                </div>
                {couponMessage && (
                  <div className="flex items-center gap-2 mt-2">
                    {activeCoupon && <CheckCircle2 className="w-3.5 h-3.5" style={{ color: '#4ade80' }} />}
                    <p className="text-xs" style={{ color: activeCoupon ? '#4ade80' : '#ef4444' }}>
                      {couponMessage}
                    </p>
                  </div>
                )}
              </div>
              {discountAmount > 0 && (
                <div className="flex justify-between items-center mt-3">
                  <span className="text-sm" style={{ color: '#4ade80' }}>
                    Discount{activeCoupon?.coupon_code ? ` (${activeCoupon.coupon_code})` : ''}
                  </span>
                  <span className="text-sm font-semibold" style={{ color: '#4ade80' }}>
                    -₹{discountAmount.toLocaleString()}
                  </span>
                </div>
              )}
              <div className="flex justify-between items-center pt-3 mt-2"
                style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                <span className="text-sm font-semibold text-white">Total</span>
                <span className="text-lg font-bold text-white">₹{payableAmount.toLocaleString()}</span>
              </div>
              <div className="flex items-center gap-2 mt-3">
                <div className="w-5 h-5 violet-gradient rounded flex items-center justify-center flex-shrink-0">
                  <Shield className="w-3 h-3 text-white" />
                </div>
                <p className="text-xs" style={{ color: '#52525b' }}>
                  Enrolling as <strong className="text-white">{studentData?.email}</strong>
                </p>
              </div>
            </div>

            <div className="rounded-xl p-4 mb-5"
              style={{ background: 'rgba(var(--kurso-primary-rgb), 0.08)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.15)' }}>
              <p className="text-xs font-semibold mb-2" style={{ color: 'var(--kurso-primary-light)' }}>After payment you'll get:</p>
              {[
                hasTelegram ? 'Lessons delivered to your Telegram instantly' : null,
                'Full web learning portal access',
                'Certificate on completion',
                'Lifetime access — no expiry',
              ].filter(Boolean).map((item, i) => (
                <div key={i} className="flex items-center gap-2 mb-1.5">
                  <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: 'var(--kurso-primary-light)' }} />
                  <p className="text-xs" style={{ color: '#a1a1aa' }}>{item}</p>
                </div>
              ))}
            </div>

            {error && (
              <div className="p-3 rounded-xl text-sm mb-4"
                style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.2)' }}>
                {error}
              </div>
            )}

            {checkingStatus ? (
              <div className="w-full py-4 rounded-xl text-sm text-center" style={{ background: 'rgba(255,255,255,0.05)', color: '#a1a1aa' }}>
                Confirming your payment...
              </div>
            ) : payableAmount > 0 ? (
              <button onClick={handlePayment} disabled={loading}
                className="w-full py-4 rounded-xl font-semibold text-white violet-gradient hover:opacity-90 glow-strong disabled:opacity-50 text-lg">
                {loading ? 'Opening payment…' : `Pay ₹${payableAmount.toLocaleString()} Securely`}
              </button>
            ) : (
              <button onClick={handleFreeEnrollment} disabled={loading}
                className="w-full py-4 rounded-xl font-semibold text-white violet-gradient hover:opacity-90 glow-strong disabled:opacity-50 text-lg">
                {loading ? 'Enrolling...' : 'Enroll for Free'}
              </button>
            )}
            {payableAmount > 0 ? (
              <p className="text-center text-xs mt-3" style={{ color: '#3f3f46' }}>Secured payment · 256-bit SSL</p>
            ) : (
              <p className="text-center text-xs mt-3" style={{ color: '#3f3f46' }}>Free enrollment · Instantly access your course</p>
            )}
            {!checkingStatus && (
              <button onClick={() => setStep(isCompletelyFree ? 'auth' : (isNothingFree ? 'auth' : 'demo'))}
                className="w-full text-center text-xs mt-2" style={{ color: '#52525b' }}>
                ← Back
              </button>
            )}
          </div>
        )}

        {/* ── SUCCESS ── */}
        {step === 'success' && (
          <div className="p-8 text-center">
            <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4"
              style={{ background: 'rgba(74,222,128,0.1)', border: '1px solid rgba(74,222,128,0.2)' }}>
              <Shield className="w-8 h-8" style={{ color: '#4ade80' }} />
            </div>
            <h3 className="text-xl font-bold text-white mb-2">Payment Successful! 🎉</h3>
            <p className="text-sm mb-6" style={{ color: '#a1a1aa' }}>
              You are enrolled in <strong className="text-white">{course.name}</strong>.
              Choose how you want to start:
            </p>

            <div className="flex flex-col gap-3">
              {/* Telegram — primary CTA when available */}
              {hasTelegram && (
                telegramToken
                  ? <TelegramButton token={telegramToken} username={course.telegramBotUsername!} label="Start on Telegram" />
                  : generatingPaid
                    ? <TokenLoading color="rgba(34,158,217,0.6)" label="Generating your Telegram link…" />
                    : null
              )}

              {/* WhatsApp */}
              {hasWhatsApp && (
                whatsappToken
                  ? <WhatsAppButton token={whatsappToken} number={waNumber} label="Start on WhatsApp" />
                  : generatingPaid
                    ? <TokenLoading color="rgba(37,211,102,0.6)" label="Generating your WhatsApp link…" />
                    : null
              )}

              {/* Web portal — always available */}
              <a href={learnUrl}
                className="w-full flex items-center justify-center gap-2 py-3.5 rounded-xl font-medium text-white transition-all hover:opacity-90"
                style={{
                  background: hasTelegram ? 'rgba(255,255,255,0.07)' : 'linear-gradient(135deg,var(--kurso-primary),var(--kurso-secondary))',
                  border: hasTelegram ? '1px solid rgba(255,255,255,0.1)' : 'none',
                }}>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
                {hasTelegram ? 'Open Web Portal' : 'Start Learning Now'}
              </a>

              <button onClick={onClose}
                className="w-full py-2.5 rounded-xl text-sm transition-all"
                style={{ background: 'rgba(255,255,255,0.04)', color: '#a1a1aa' }}>
                Close
              </button>
            </div>

            <p className="text-xs mt-4" style={{ color: '#3f3f46' }}>
              Progress syncs between Telegram and web automatically.
            </p>
          </div>
        )}
      </div>
    </div>
  )

  return typeof document !== 'undefined' ? createPortal(modalContent, document.body) : null
}