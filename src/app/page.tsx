'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  GraduationCap, MessageCircle, Send, ListChecks, LayoutDashboard,
  Award, Lock, Wallet, Video, CheckCircle, ArrowRight, Play, Sparkles,
  ChevronDown, Terminal, RefreshCw, ShieldCheck, Smartphone, Settings2,
  Globe, Wand2
} from 'lucide-react'
import Navbar from '@/components/Navbar'
import { supabase, getSessionOrRefresh } from '@/lib/supabase'
import { resolveAccountType } from '@/lib/account'

// TODO: paste your screen-recording link here (YouTube embed URL or hosted .mp4)
// e.g. 'https://www.youtube.com/embed/XXXXXXXXXXX'
// Leave empty to show the "coming soon" placeholder.
const DEMO_VIDEO_URL: string = 'https://pub-e026ccf9cda1475dad7790cac878419c.r2.dev/demo/homepage-walkthrough.mp4'

// ─── DATA ───
const features = [
  {
    icon: MessageCircle,
    title: 'WhatsApp Lesson Delivery',
    desc: 'Students enroll via a link and get each lesson sent straight to WhatsApp — the app they already check all day. Mark a lesson done and the next one unlocks.',
    tag: 'WhatsApp',
  },
  {
    icon: Send,
    title: 'Telegram Lesson Delivery',
    desc: 'The same simple flow on Telegram — enroll, receive lessons, mark done, move forward. Use whichever platform fits your audience.',
    tag: 'Telegram',
  },
  {
    icon: ListChecks,
    title: 'Quizzes, Notes & Assignments',
    desc: 'Every lesson can carry a quiz, downloadable notes, and an assignment — all unlocked the moment a student marks the lesson complete, on both platforms.',
    tag: 'Learning',
  },
  {
    icon: LayoutDashboard,
    title: 'Clean Creator Dashboard',
    desc: "Upload your course, set your price, and see exactly who's enrolled and how far they've gotten — no clutter, no learning curve.",
    tag: 'Dashboard',
  },
  {
    icon: Award,
    title: 'Auto Certificates',
    desc: 'The moment a student finishes your course, we generate and send their certificate automatically. Zero manual work for you.',
    tag: 'Certificates',
  },
  {
    icon: Video,
    title: 'Live Classes, Shared Automatically',
    desc: "Drop in your Zoom or Google Meet link for a live session and we'll send it straight to every enrolled student on WhatsApp and Telegram.",
    tag: 'Live Classes',
  },
  {
    icon: Wallet,
    title: 'Payments, Straight To You',
    desc: "Connect your own Razorpay, Stripe, or Cashfree account with your API keys. Payments go directly to you — we simply verify each transaction and unlock access automatically.",
    tag: 'Payments',
  },
  {
    icon: Lock,
    title: 'Watermarked Videos',
    desc: "Every video lesson carries the student's email as a watermark — a simple, honest layer of protection.",
    tag: 'Protection',
  },
]

const steps = [
  { num: '01', title: 'Upload your course', desc: 'Drag in your videos, notes, and assignments. No technical setup required.' },
    { num: '02', title: 'Set your price', desc: 'Set what students pay. Kurso takes a small share only of what you earn, with nothing to pay upfront. Connect your bank account or UPI ID for direct payouts.' },
  { num: '03', title: 'Share your link', desc: 'Students enroll and pay on your course page. They are auto-enrolled the moment payment succeeds.' },
  { num: '04', title: 'Bot delivers lessons', desc: 'Each lesson lands in WhatsApp or Telegram. Mark it done to unlock the quiz, notes, and assignment — then the next lesson.' },
  { num: '05', title: 'Go live anytime', desc: 'Drop in a Zoom or Google Meet link for a live class — we share it with every enrolled student automatically.' },
]

const embedSteps = [
  { icon: Terminal, title: 'Drop in the checkout code block', desc: 'Swap your current enrollment button for our lightweight code snippet — a few lines, no rebuild needed.' },
  { icon: LayoutDashboard, title: 'Upload lessons & course details', desc: 'Add your videos, notes, assignments and pricing on your Kurso dashboard, same as always.' },
  { icon: MessageCircle, title: 'Go live on WhatsApp, Telegram, or both', desc: 'Pick however you want lessons delivered — your landing page stays exactly as you built it.' },
]


const embedShowcaseImages = [
    { src: '/showcase/createCourse.png', alt: 'Create a course' },
  { src: '/showcase/createLesson.png', alt: 'How to create a lesson' },
  { src: '/showcase/addLesson.png', alt: 'Course details and lesson upload screen' },
  { src: '/showcase/embedCode.png', alt: 'Checkout popup on a creator-branded landing page' },
]

const engagementPoints = [
  { icon: Smartphone, text: 'No app to install — lessons arrive where students already are' },
  { icon: MessageCircle, text: 'Bot sends the lesson straight into the WhatsApp or Telegram chat' },
  { icon: ShieldCheck, text: 'Tapping it opens a secure, watermarked web player' },
  { icon: Lock, text: 'Links expire after a short window, so a shared link goes dead fast' },
]


const engagementShowcaseImages = [
  { src: '/showcase/telegramChat.png', alt: 'Telegram chat in our bot' },
  { src: '/showcase/whatsappChat.png', alt: 'Whatsapp chat in our kurso bot' },
  { src: '/showcase/videoLesson.png', alt: 'Video lesson preview and AI chatbot' },
  { src: '/showcase/webLesson.png', alt: 'Lesson delivered via web player' },
]

// Nothing for the creator to register or configure on the messaging side —
// Kurso runs one bot infrastructure behind the scenes so creators never touch
// a WhatsApp Business account, a Meta developer console, or an API key for
// messaging. This is a real operational choice (a single, carefully managed
// setup on our end), presented here as the plain benefit it is for a creator.
const noSetupPoints = [
  { icon: Settings2, title: 'No WhatsApp Business account', desc: "You don't register anything with Meta — we already have the infrastructure running." },
  { icon: Lock, title: 'No API keys to manage', desc: 'Nothing to generate, rotate, or keep secret on the messaging side. That part is entirely on us.' },
  { icon: MessageCircle, title: 'Pick a platform, that\u2019s it', desc: 'WhatsApp, Telegram, or both — choose it in your course settings and delivery is live immediately.' },
  { icon: RefreshCw, title: 'No ongoing upkeep', desc: 'No renewing tokens, no reconnecting an account. It keeps working while you focus on your course.' },
]

// The landing-page builder, positioned as genuinely low-decision — a direct
// answer to how much configuration other course tools ask a creator to do
// before they can publish anything.
const builderSteps = [
  { num: '01', title: 'Pick your sections', desc: 'Turn on what you want — curriculum, testimonials, FAQs, pricing, and more. Leave off what you don\u2019t need.' },
  { num: '02', title: 'Add your content', desc: 'Course description, what students will learn, testimonials, FAQs — fill in what you already have.' },
  { num: '03', title: 'Preview as you go', desc: 'Your page updates live while you add details — no separate preview step, no guessing how it\u2019ll look.' },
]

const faqs = [
  {
    q: 'Do my students need to download an app?',
    a: 'No. Lessons are delivered straight into WhatsApp or Telegram — apps your students already have open. Tapping a lesson link opens it on a secure web page for that lesson only; nothing extra to install or log into.',
  },
  {
    q: 'Do I need to set up a WhatsApp Business account myself?',
    a: "No. Kurso runs the WhatsApp and Telegram bot infrastructure entirely on our side — you don't need a WhatsApp Business account, a Meta developer account, or any messaging API keys. Just pick a platform in your course settings and delivery is live.",
  },
  {
    q: 'How do payments work — do you hold my money?',
    a: "You connect your own Razorpay, Stripe, or Cashfree account using your API keys. Payments go directly to your account — we simply verify each transaction on our end and unlock the course automatically once it clears.",
  },
  {
    q: 'Do I need to pay anything to get started?',
    a: "No. There is no monthly plan and no setup fee. You can build your course, upload lessons, and test the full experience for free. Kurso only takes a share of what students pay you once you start earning.",
  },
  {
    q: 'How does "Pay As You Earn" actually work?',
    a: "Everyone is on Pay As You Earn. Each month we add up what your students actually paid you for courses and workshops and invoice 5% of it (6.5% beyond 300 paid students, counted separately for courses and for workshops). Ebooks are 4% in months you collect ₹500 or more. You pay by a single one-time payment, not an auto-debit, and if you made nothing there is no commission. If a month was slow, you can ask to waive the commission from your dashboard. WhatsApp message charges are separate and explained below.",
  },
  {
    q: 'I already have a landing page for my course — do I need to switch?',
    a: 'No. Keep your existing page and just swap in our lightweight enrollment code block for checkout. Upload your lessons and details on the Kurso dashboard, and delivery goes live on WhatsApp, Telegram, or both.',
  },
  {
    q: 'Do I need to buy a domain?',
    a: "Only if you want one. Hosting your course page natively on Kurso means there's nothing to buy or configure — it's live on a Kurso link immediately. If you already have your own website and domain, keep it and just swap your checkout button for our lightweight code block.",
  },
  {
    q: 'How is my course content protected from piracy?',
    a: "Every video and PDF is watermarked, and lesson links expire after a short window. Even if a link is shared once, it won't stay usable — so it can't quietly turn into a pirated copy.",
  },
  {
    q: 'How are WhatsApp messages charged?',
    a: "Meta charges a small fee for each WhatsApp message it delivers. We pass that exact cost on to you on your monthly invoice, at Meta's rate and with no markup, separate from commission. Telegram and email are free. Your billing page shows every message type, its rate, and what you have used so far.",
  },
  {
    q: 'What if my student does not have Telegram installed?',
    a: "They would need to install it to receive lessons there, same as any Telegram-based delivery. That is why most creators also turn on WhatsApp, since almost every student already has it. Email always works too, so students never miss a confirmation or update.",
  },
]

const PAYE_BASE_RATE = 5
const PAYE_OVERFLOW_RATE = 6.5
const PAYE_STUDENT_THRESHOLD = 300

const stats = [
  { num: 'Free', label: 'To build & test' },
  { num: '2', label: 'Delivery channels' },
  { num: '₹0', label: 'Upfront, ever' },
  { num: '5%', label: 'Or pay only when you earn' },
]

// ─── COMPONENTS ───
function StatCard({ num, label }: { num: string; label: string }) {
  return (
    <div className="glass rounded-2xl p-6 text-center glow">
      <div className="text-4xl font-bold gradient-text mb-1">{num}</div>
      <div className="text-text-2 text-sm">{label}</div>
    </div>
  )
}

function FeatureCard({ icon: Icon, title, desc, tag }: typeof features[0]) {
  return (
    <div className="glass rounded-2xl p-6 hover:border-violet-500/40 transition-all duration-300 group hover:glow cursor-default border border-border">
      <div className="flex items-start justify-between mb-4">
        <div className="w-10 h-10 violet-gradient rounded-xl flex items-center justify-center group-hover:animate-pulse-glow">
          <Icon className="w-5 h-5 text-white" />
        </div>
        <span className="text-xs font-medium text-violet-400 bg-violet-500/10 border border-violet-500/20 px-2 py-1 rounded-full">
          {tag}
        </span>
      </div>
      <h3 className="font-semibold text-white mb-2 text-lg">{title}</h3>
      <p className="text-text-2 text-sm leading-relaxed">{desc}</p>
    </div>
  )
}

function StepCard({ num, title, desc }: typeof steps[0]) {
  return (
    <div className="flex gap-6 group">
      <div className="flex-shrink-0">
        <div className="w-12 h-12 violet-gradient rounded-xl flex items-center justify-center font-bold text-white group-hover:animate-pulse-glow transition-all">
          {num}
        </div>
      </div>
      <div className="pt-2">
        <h3 className="font-semibold text-white mb-2">{title}</h3>
        <p className="text-text-2 text-sm leading-relaxed">{desc}</p>
      </div>
    </div>
  )
}

function ImageGrid({ images, cols = 4 }: { images: { src: string; alt: string }[]; cols?: 2 | 4 }) {
  return (
    <div className={`grid grid-cols-2 ${cols === 4 ? 'md:grid-cols-4' : 'md:grid-cols-2 max-w-2xl mx-auto'} gap-4`}>
      {images.map((img, i) => (
        <div
          key={i}
          className="glass rounded-xl border border-border overflow-hidden aspect-[4/3] flex items-center justify-center"
        >
          {img.src ? (
            <img src={img.src} alt={img.alt} className="w-full h-full object-cover" />
          ) : (
            <span className="text-text-3 text-xs px-3 text-center">{img.alt}</span>
          )}
        </div>
      ))}
    </div>
  )
}

function FAQItem({ q, a, isOpen, onToggle }: { q: string; a: string; isOpen: boolean; onToggle: () => void }) {
  return (
    <div className="glass rounded-2xl border border-border overflow-hidden">
      <button onClick={onToggle} className="w-full flex items-center justify-between gap-4 p-6 text-left">
        <span className="font-semibold text-white">{q}</span>
        <ChevronDown
          className={`w-5 h-5 text-violet-400 flex-shrink-0 transition-transform duration-300 ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>
      {isOpen && (
        <div className="px-6 pb-6">
          <p className="text-text-2 text-sm leading-relaxed">{a}</p>
        </div>
      )}
    </div>
  )
}

// ─── PAGE ───
export default function HomePage() {
  const router = useRouter()
  const [user, setUser] = useState<any>(null)
  const [openFaq, setOpenFaq] = useState<number | null>(null)

  useEffect(() => {
    async function checkUser(sessionUser: any | null) {
      setUser(sessionUser ?? null)
      if (sessionUser) {
        const accountType = await resolveAccountType(sessionUser)
        if (accountType === 'student') {
          router.replace('/my-courses')
        }
      }
    }

        getSessionOrRefresh().then(({ session }) => {
      checkUser(session?.user ?? null)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => {
      checkUser(session?.user ?? null)
    })
    return () => subscription.unsubscribe()
  }, [router])

  return (
    <div className="min-h-screen bg-black grid-bg">
      <Navbar />

      {/* ── HERO ── */}
      <section className="pt-32 pb-24 px-6 relative overflow-hidden">
        {/* Glow orbs */}
        <div className="absolute top-20 left-1/2 -translate-x-1/2 w-[600px] h-[600px] bg-violet-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute top-40 left-1/4 w-[300px] h-[300px] bg-violet-500/5 rounded-full blur-3xl pointer-events-none" />

        <div className="max-w-5xl mx-auto text-center relative z-10">
          <div className="inline-flex items-center gap-2 glass border border-violet-500/20 rounded-full px-4 py-2 mb-8">
            <div className="w-2 h-2 bg-violet-400 rounded-full animate-pulse" />
            <span className="text-sm text-text-2">Free to build & test · No card required</span>
          </div>

          <h1 className="text-4xl md:text-5xl font-bold leading-tight mb-6">
            Your Course, Delivered on{' '}
            <span className="gradient-text">WhatsApp</span>
            {' '}&{' '}
            <span className="gradient-text">Telegram </span>
            With Piracy Protection
          </h1>

          <p className="text-text-2 text-xl max-w-2xl mx-auto mb-10 leading-relaxed font-light">
            Kurso sends each lesson link straight into your students' WhatsApp or Telegram chat — quizzes, notes,
            assignments and certificates included. No app to download, no dashboard to learn. Just
            the chats they already check.
          </p>

          <div className="flex flex-col sm:flex-row gap-4 justify-center mb-16">
            <Link
              href={user ? '/dashboard' : '/login?role=creator'}
              className="violet-gradient px-8 py-4 rounded-xl text-white font-semibold text-lg hover:opacity-90 transition-all glow-strong flex items-center justify-center gap-2 group"
            >
              {user ? 'Go to Dashboard' : 'Start Free'}
              <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
            </Link>
            <a
              href="#demo"
              className="glass border border-border px-8 py-4 rounded-xl text-white font-semibold text-lg hover:border-violet-500/40 transition-all flex items-center justify-center gap-2"
            >
              <Play className="w-5 h-5 text-violet-400" />
              Watch Demo
            </a>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 max-w-3xl mx-auto">
            {stats.map((s, i) => <StatCard key={i} {...s} />)}
          </div>
        </div>
      </section>

      {/* ── DEMO VIDEO ── */}
      <section id="demo" className="py-16 px-6">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-10">
            <h2 className="text-3xl md:text-4xl font-bold mb-3">
              See <span className="gradient-text">Kurso</span> in action
            </h2>
            <p className="text-text-2 font-light">A quick look at how a lesson goes from your dashboard to a student's chat.</p>
          </div>

                    <div className="glass rounded-2xl border border-border overflow-hidden glow">
            {DEMO_VIDEO_URL ? (
              DEMO_VIDEO_URL.endsWith('.mp4') ? (
                                <video
                  src={DEMO_VIDEO_URL}
                  poster="/demo-poster.png"
                  controls
                  playsInline
                  preload="metadata"
                  className="w-full aspect-video bg-black"
                />
              ) : (
                <div className="relative w-full" style={{ paddingTop: '56.25%' }}>
                  <iframe
                    src={DEMO_VIDEO_URL}
                    className="absolute inset-0 w-full h-full"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                  />
                </div>
              )
            ) : (
              <div className="aspect-video flex flex-col items-center justify-center gap-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
                <div className="w-16 h-16 violet-gradient rounded-2xl flex items-center justify-center animate-pulse-glow">
                  <Play className="w-8 h-8 text-white" />
                </div>
                <div className="text-center">
                  <p className="text-white font-semibold mb-1">Demo video coming soon</p>
                  <p className="text-text-2 text-sm">We're recording a walkthrough — check back shortly.</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ── FEATURES ── */}
      <section id="features" className="py-24 px-6">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <div className="inline-flex items-center gap-2 glass border border-violet-500/20 rounded-full px-4 py-2 mb-4">
              <Sparkles className="w-3 h-3 text-violet-400" />
              <span className="text-sm text-text-2">What you actually get</span>
            </div>
            <h2 className="text-4xl md:text-5xl font-bold mb-4">
              Built around{' '}
              <span className="gradient-text">excellent user experience.</span>
            </h2>
            <p className="text-text-2 text-lg max-w-xl mx-auto font-light">
              No padded feature list — just what's live today, built for how your students already use their phones.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {features.map((f, i) => <FeatureCard key={i} {...f} />)}
          </div>
        </div>
      </section>

      {/* ── HOW IT WORKS / GETTING STARTED ── */}
      <section id="how-it-works" className="py-24 px-6 border-y border-border">
        <div className="max-w-6xl mx-auto">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">
            <div>
              <div className="inline-flex items-center gap-2 glass border border-violet-500/20 rounded-full px-4 py-2 mb-6">
                <span className="text-sm text-text-2">Getting started is simple</span>
              </div>
              <h2 className="text-4xl md:text-5xl font-bold mb-4">
                Five steps. <span className="gradient-text">That's it.</span>
              </h2>
              <p className="text-text-2 mb-10 font-light leading-relaxed">
                No technical knowledge required — if you can drag and drop a file, you can run Kurso.
              </p>
              <div className="flex flex-col gap-8">
                {steps.map((s, i) => <StepCard key={i} {...s} />)}
              </div>
            </div>

            {/* Visual */}
            <div className="relative">
              <div className="glass rounded-2xl p-8 glow animate-float" style={{ border: '1px solid rgba(var(--kurso-primary-rgb), 0.2)' }}>
                {/* Header */}
                <div className="flex items-center justify-between mb-8">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 violet-gradient rounded-lg flex items-center justify-center">
                      <GraduationCap className="w-4 h-4 text-white" />
                    </div>
                    <span className="text-white font-semibold text-base">Kurso Dashboard</span>
                  </div>
                  <div className="flex gap-2">
                    <div className="w-3 h-3 rounded-full bg-red-500/80" />
                    <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                    <div className="w-3 h-3 rounded-full bg-green-500/80" />
                  </div>
                </div>

                {/* Stats row */}
                <div className="grid grid-cols-3 gap-4 mb-6">
                  {[
                    { label: 'Students', val: '86' },
                    { label: 'Completion', val: '61%' },
                    { label: 'Certificates', val: '12' },
                  ].map((s, i) => (
                    <div key={i} className="rounded-xl p-4 text-center" style={{ background: 'rgba(255,255,255,0.05)' }}>
                      <div className="text-3xl font-bold gradient-text mb-1">{s.val}</div>
                      <div className="text-sm" style={{ color: '#a1a1aa' }}>{s.label}</div>
                    </div>
                  ))}
                </div>

                {/* Live class card */}
                <div className="rounded-xl p-4 mb-4" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}>
                  <div className="text-xs font-semibold mb-3 tracking-widest uppercase" style={{ color: '#52525b' }}>
                    🎥 Upcoming Live Class
                  </div>
                  <div className="flex items-center justify-between py-1">
                    <span className="text-sm" style={{ color: '#e4e4e7' }}>Doubt Clearing Session</span>
                    <span className="text-sm font-medium" style={{ color: 'var(--kurso-primary-light)' }}>Today, 7:00 PM</span>
                  </div>
                  <div className="text-xs mt-2" style={{ color: '#52525b' }}>
                    Link shared with 86 students on WhatsApp & Telegram
                  </div>
                </div>

                {/* Activity */}
                <div className="rounded-xl p-4" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}>
                  <div className="text-xs font-semibold mb-3 tracking-widest uppercase" style={{ color: '#52525b' }}>
                    Recent Activity
                  </div>
                  {[
                    'Riya completed Lesson 4',
                    'Arjun enrolled in SEO Basics',
                    'Certificate sent to Priya',
                  ].map((a, i) => (
                    <div key={i} className="flex items-center gap-3 py-2" style={{ borderBottom: i < 2 ? '1px solid rgba(255,255,255,0.05)' : 'none' }}>
                      <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: 'var(--kurso-primary-light)' }} />
                      <span className="text-sm" style={{ color: '#e4e4e7' }}>{a}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Floating badge */}
              <div className="absolute -bottom-5 -right-5 rounded-xl px-5 py-3 glow" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.3)', backdropFilter: 'blur(12px)' }}>
                <div className="text-xs mb-1" style={{ color: '#a1a1aa' }}>This month</div>
                <div className="text-xl font-bold gradient-text">7 certificates issued</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── NOTHING TO REGISTER ── */}
      <section className="py-24 px-6 border-b border-border">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-12">
            <div className="inline-flex items-center gap-2 glass border border-violet-500/20 rounded-full px-4 py-2 mb-4">
              <Settings2 className="w-3 h-3 text-violet-400" />
              <span className="text-sm text-text-2">The messaging side is entirely on us</span>
            </div>
            <h2 className="text-4xl md:text-5xl font-bold mb-4">
              Nothing to register. <span className="gradient-text">Nothing to configure.</span>
            </h2>
            <p className="text-text-2 text-lg max-w-2xl mx-auto font-light leading-relaxed">
              You don't need a WhatsApp Business account, a Meta developer console, or any messaging
              API keys. Kurso already runs that infrastructure — you just pick a platform in your
              course settings, and delivery is live.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            {noSetupPoints.map((p, i) => (
              <div key={i} className="glass rounded-2xl p-5 border border-border text-center">
                <div className="w-10 h-10 violet-gradient rounded-xl flex items-center justify-center mx-auto mb-3">
                  <p.icon className="w-5 h-5 text-white" />
                </div>
                <h3 className="font-semibold text-white mb-1.5 text-sm">{p.title}</h3>
                <p className="text-text-2 text-xs leading-relaxed">{p.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── BRING YOUR OWN LANDING PAGE ── */}
      <section id="embed" className="py-24 px-6 border-b border-border">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-14">
            <div className="inline-flex items-center gap-2 glass border border-violet-500/20 rounded-full px-4 py-2 mb-4">
              <Terminal className="w-3 h-3 text-violet-400" />
              <span className="text-sm text-text-2">Already have a landing page?</span>
            </div>
            <h2 className="text-4xl md:text-5xl font-bold mb-4">
              Keep your page. <span className="gradient-text">Just plug in checkout.</span>
            </h2>
            <p className="text-text-2 text-lg max-w-2xl mx-auto font-light leading-relaxed">
              Don't rebuild what already works. Swap in our enrollment code block, upload your lessons
              and course details, and your course goes live — delivered on WhatsApp, Telegram, or both,
              whichever your students actually use. Already have your own domain? Keep it exactly as
              it is — nothing about your website changes except the checkout button.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-14">
            {embedSteps.map((s, i) => (
              <div key={i} className="glass rounded-2xl p-6 border border-border">
                <div className="w-10 h-10 violet-gradient rounded-xl flex items-center justify-center mb-4">
                  <s.icon className="w-5 h-5 text-white" />
                </div>
                <h3 className="font-semibold text-white mb-2">{s.title}</h3>
                <p className="text-text-2 text-sm leading-relaxed">{s.desc}</p>
              </div>
            ))}
          </div>

          <ImageGrid images={embedShowcaseImages} cols={4} />
        </div>
      </section>

      {/* ── BUILD NATIVELY ON KURSO ── */}
      <section className="py-24 px-6 border-b border-border">
        <div className="max-w-5xl mx-auto">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">
            <div>
              <div className="inline-flex items-center gap-2 glass border border-violet-500/20 rounded-full px-4 py-2 mb-6">
                <Wand2 className="w-3 h-3 text-violet-400" />
                <span className="text-sm text-text-2">No landing page yet?</span>
              </div>
              <h2 className="text-4xl md:text-5xl font-bold mb-4">
                Fewer decisions.<br /><span className="gradient-text">Just add your content.</span>
              </h2>
              <p className="text-text-2 mb-8 font-light leading-relaxed">
                Building a course page on Kurso doesn't mean learning a design tool or working through
                a long settings menu first. Pick your sections, fill in what you already have, and
                watch your page take shape as you go.
              </p>
              <div className="flex flex-col gap-8 mb-10">
                {builderSteps.map((s, i) => <StepCard key={i} {...s} />)}
              </div>
              <div className="flex items-start gap-3 glass rounded-xl p-4 border border-border">
                <Globe className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: 'var(--kurso-primary-light)' }} />
                <p className="text-text-2 text-sm leading-relaxed">
                  No domain to buy or configure — your page is live on a Kurso link the moment you're
                  ready, with your own domain always an option later if you want one.
                </p>
              </div>
            </div>

            {/* Visual: a lightweight "live preview" mock */}
            <div className="relative">
              <div className="glass rounded-2xl p-6 glow animate-float" style={{ border: '1px solid rgba(var(--kurso-primary-rgb), 0.2)' }}>
                <div className="flex items-center gap-2 mb-5">
                  <div className="w-3 h-3 rounded-full bg-red-500/80" />
                  <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                  <div className="w-3 h-3 rounded-full bg-green-500/80" />
                  <span className="text-xs ml-2" style={{ color: '#52525b' }}>Live preview</span>
                </div>
                <div className="rounded-xl overflow-hidden" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}>
                  <div className="h-24 flex items-center justify-center violet-gradient">
                    <span className="text-white font-semibold text-sm">Your Course Name</span>
                  </div>
                  <div className="p-4 flex flex-col gap-2.5">
                    {['Course description', 'What students will learn', 'Testimonials', 'FAQs'].map((row, i) => (
                      <div key={i} className="flex items-center gap-2.5 rounded-lg px-3 py-2" style={{ background: 'rgba(255,255,255,0.04)' }}>
                        <CheckCircle className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--kurso-primary-light)' }} />
                        <span className="text-xs" style={{ color: '#e4e4e7' }}>{row}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div className="absolute -bottom-5 -left-5 rounded-xl px-5 py-3 glow" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.3)', backdropFilter: 'blur(12px)' }}>
                <div className="text-xs mb-1" style={{ color: '#a1a1aa' }}>Updates as you type</div>
                <div className="text-sm font-bold gradient-text">No separate preview step</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── NO APPS TO DOWNLOAD ── */}
      <section className="py-24 px-6 border-b border-border">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-12">
            <div className="inline-flex items-center gap-2 glass border border-violet-500/20 rounded-full px-4 py-2 mb-4">
              <Smartphone className="w-3 h-3 text-violet-400" />
              <span className="text-sm text-text-2">Zero app-download friction</span>
            </div>
            <h2 className="text-4xl md:text-5xl font-bold mb-4">
              No apps to download. <span className="gradient-text">Just the chats they already open.</span>
            </h2>
            <p className="text-text-2 text-lg max-w-2xl mx-auto font-light leading-relaxed">
              WhatsApp and Telegram are already open on your students' phones all day — that's where they
              stay engaged, so that's where we meet them. The moment a lesson is ready, our bot sends the
              link straight into the chat. They tap it, it opens on a secure Kurso web player — video,
              notes, quiz, everything — then they head right back to the conversation they were already in.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-12">
            {engagementPoints.map((p, i) => (
              <div key={i} className="glass rounded-2xl p-5 border border-border text-center">
                <div className="w-10 h-10 violet-gradient rounded-xl flex items-center justify-center mx-auto mb-3">
                  <p.icon className="w-5 h-5 text-white" />
                </div>
                <p className="text-text-2 text-sm leading-relaxed">{p.text}</p>
              </div>
            ))}
          </div>

                    <ImageGrid images={engagementShowcaseImages} cols={4} />
        </div>
      </section>

      {/* ── PRICING ── */}
      <section id="pricing" className="py-24 px-6">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-10">
            <h2 className="text-4xl md:text-5xl font-bold mb-4">
              Simple <span className="gradient-text">pricing</span>
            </h2>
            <p className="text-text-2 font-light max-w-xl mx-auto">
              No monthly plan and nothing to pay upfront. Build and test for free, and pay only a small share of what you earn.
            </p>
          </div>

          <div className="rounded-2xl p-8 md:p-10 relative overflow-hidden"
            style={{ border: '1px solid rgba(247,149,20,0.35)', background: 'rgba(247,149,20,0.04)' }}>
            <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(circle at top left, rgba(247,149,20,0.12), transparent 60%)' }} />
            <div className="relative z-10">
              <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6 mb-8">
                <div>
                  <span className="inline-block text-xs font-bold px-3 py-1 rounded-full mb-3"
                    style={{ background: 'var(--kurso-primary)', color: '#fff' }}>
                    PAY AS YOU EARN
                  </span>
                  <h3 className="text-2xl md:text-3xl font-bold text-white mb-2">One plan for everyone</h3>
                  <p className="text-text-2 max-w-lg">
                    We only get paid when you do. A small cut of what students pay you, and nothing in a month with no sales.
                  </p>
                </div>
                <div className="text-center flex-shrink-0">
                  <div className="text-5xl font-bold" style={{ color: 'var(--kurso-primary)' }}>{PAYE_BASE_RATE}%</div>
                  <div className="text-text-2 text-sm mt-1">on courses and workshops</div>
                </div>
              </div>

              <div className="glass rounded-xl overflow-hidden mb-6">
                <div className="grid grid-cols-2 text-sm font-semibold text-text-2 px-4 py-2" style={{ borderBottom: '1px solid var(--border)' }}>
                  <span>What you sell</span>
                  <span className="text-right">What we take</span>
                </div>
                <div className="grid grid-cols-2 text-sm px-4 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
                  <span className="text-white">Courses and workshops, up to {PAYE_STUDENT_THRESHOLD} paid students</span>
                  <span className="text-right font-semibold" style={{ color: 'var(--kurso-primary)' }}>{PAYE_BASE_RATE}%</span>
                </div>
                <div className="grid grid-cols-2 text-sm px-4 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
                  <span className="text-white">Beyond {PAYE_STUDENT_THRESHOLD} paid students</span>
                  <span className="text-right font-semibold" style={{ color: 'var(--kurso-primary)' }}>{PAYE_OVERFLOW_RATE}%</span>
                </div>
                <div className="grid grid-cols-2 text-sm px-4 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
                  <span className="text-white">Ebooks, in months you collect ₹500 or more</span>
                  <span className="text-right font-semibold" style={{ color: 'var(--kurso-primary)' }}>4%</span>
                </div>
                <div className="grid grid-cols-2 text-sm px-4 py-3">
                  <span className="text-white">Telegram and email delivery</span>
                  <span className="text-right font-semibold" style={{ color: 'var(--kurso-primary)' }}>Free</span>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
                {[
                  { title: '₹0 upfront', desc: 'No monthly plan and no setup fee. Build and test everything for free.' },
                  { title: 'Only when you earn', desc: 'We invoice once a month, on what students actually paid you after coupons and refunds.' },
                  { title: 'A slow month happens', desc: 'Ask to waive the commission from your dashboard. Your course stays live either way.' },
                ].map((item, i) => (
                  <div key={i} className="glass rounded-xl p-4">
                    <div className="flex items-center gap-2 mb-1.5">
                      <CheckCircle className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--kurso-primary)' }} />
                      <span className="text-white font-medium text-sm">{item.title}</span>
                    </div>
                    <p className="text-text-2 text-sm leading-relaxed">{item.desc}</p>
                  </div>
                ))}
              </div>

              <div className="rounded-xl p-4 mb-8" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)' }}>
                <p className="text-sm text-text-2 leading-relaxed">
                  <span className="text-white font-semibold">WhatsApp messages are charged separately.</span>{' '}
                  Meta bills for each WhatsApp message it delivers, and we pass that cost on at Meta&apos;s rate. It is not part of the percentages above.{' '}
                  <a href="https://developers.facebook.com/docs/whatsapp/pricing" target="_blank" rel="noopener noreferrer" className="underline" style={{ color: 'var(--kurso-primary)' }}>
                    See Meta&apos;s pricing
                  </a>
                </p>
              </div>

              <div className="flex flex-col sm:flex-row items-center gap-4">
                <Link
                  href="/login"
                  className="w-full sm:w-auto px-8 py-3.5 rounded-xl text-white font-semibold text-center hover:opacity-90 transition-all glow flex items-center justify-center gap-2"
                  style={{ background: 'var(--kurso-primary)' }}
                >
                  Get Started Free
                  <ArrowRight className="w-4 h-4" />
                </Link>
                <span className="text-text-2 text-sm">No card needed. Full details, rates and your usage are on your billing page.</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── CTA ── */}
      <section className="py-24 px-6">
        <div className="max-w-3xl mx-auto text-center">
          <div className="glass rounded-3xl border border-violet-500/20 p-12 glow-strong relative overflow-hidden">
            <div className="absolute inset-0 bg-violet-500/5 rounded-3xl" />
            <div className="relative z-10">
              <h2 className="text-4xl md:text-5xl font-bold mb-4">
                Ready to bring your course<br />
                <span className="gradient-text">to WhatsApp & Telegram?</span>
              </h2>
              <p className="text-text-2 mb-8 font-light text-lg">
                Setup takes less than a day. Build and test your entire course for free — pay only
                when you're ready to go live.
              </p>
              <Link
                href={user ? '/dashboard' : '/login?role=creator'}
                className="violet-gradient px-10 py-4 rounded-xl text-white font-semibold text-lg hover:opacity-90 transition-all glow-strong inline-flex items-center gap-2 group"
              >
                {user ? 'Go to Dashboard' : 'Start Free'}
                <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ── FAQ ── */}
      <section id="faq" className="py-24 px-6 border-t border-border">
        <div className="max-w-3xl mx-auto">
          <div className="text-center mb-14">
            <h2 className="text-4xl md:text-5xl font-bold mb-4">
              Questions <span className="gradient-text">creators ask</span>
            </h2>
            <p className="text-text-2 font-light">Still deciding? Here's what usually comes up.</p>
          </div>
          <div className="flex flex-col gap-4">
            {faqs.map((f, i) => (
              <FAQItem
                key={i}
                q={f.q}
                a={f.a}
                isOpen={openFaq === i}
                onToggle={() => setOpenFaq(openFaq === i ? null : i)}
              />
            ))}
          </div>
        </div>
      </section>

      {/* ── FOOTER ── */}
      <footer className="border-t border-border py-12 px-6">
        <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 violet-gradient rounded-lg flex items-center justify-center">
              <GraduationCap className="w-3.5 h-3.5 text-white" />
            </div>
            <span className="font-semibold text-white">Kurso</span>
          </div>
          <p className="text-text-3 text-sm">© 2026 Kurso. Built for Indian creators.</p>
          <div className="flex gap-6">
            <Link href="/feedback" className="text-text-3 text-sm hover:text-text-2 transition-colors">Feedback</Link>
            <Link href="/privacy" className="text-text-3 text-sm hover:text-text-2 transition-colors">Privacy</Link>
            <Link href="/terms" className="text-text-3 text-sm hover:text-text-2 transition-colors">Terms</Link>
            <Link href="/refund-policy" className="text-text-3 text-sm hover:text-text-2 transition-colors">Refund Policy</Link>
            <Link href="/contact" className="text-text-3 text-sm hover:text-text-2 transition-colors">Contact</Link>
          </div>
        </div>
      </footer>
    </div>
  )
}