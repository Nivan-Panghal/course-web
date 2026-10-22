"use client"
import { useState } from 'react'
import Link from 'next/link'
import { GraduationCap, Mail, ArrowLeft, Send, CheckCircle, Sparkles } from 'lucide-react'

export default function ContactPage() {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')

 
  async function handleSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, subject, message }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Something went wrong. Please try again.')
      } else {
        setSent(true)
      }
    } catch {
      setError('Network error. Please check your connection and try again.')
    }
    setLoading(false)
  }

  return (
    <div className="min-h-screen bg-black grid-bg">

      {/* Nav */}
      <div className="border-b px-6 py-4 flex items-center justify-between"
        style={{borderColor:'rgba(255,255,255,0.06)', background:'rgba(0,0,0,0.8)', backdropFilter:'blur(20px)'}}>
        <Link href="/" className="flex items-center gap-2">
          <div className="w-7 h-7 violet-gradient rounded-lg flex items-center justify-center">
            <GraduationCap className="w-3.5 h-3.5 text-white" />
          </div>
          <span className="font-semibold text-white">Kurso</span>
        </Link>
        <Link href="/" className="flex items-center gap-2 text-sm transition-colors"
          style={{color:'#a1a1aa'}}>
          <ArrowLeft className="w-4 h-4" />
          Back to Home
        </Link>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-16">

        {/* Header */}
        <div className="text-center mb-16">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full mb-4 text-xs font-medium"
            style={{background:'rgba(var(--kurso-primary-rgb), 0.1)', color:'var(--kurso-primary-light)', border:'1px solid rgba(var(--kurso-primary-rgb), 0.2)'}}>
            We're here to help
          </div>
          <h1 className="text-4xl md:text-5xl font-bold text-white mb-4">Contact Us</h1>
          <p className="text-lg max-w-xl mx-auto" style={{color:'#a1a1aa'}}>
            Question, account hiccup, or want to talk through a custom plan? Drop us a line —
            a real person reads every message, usually within 24 hours.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">

          {/* Contact info */}
          <div className="flex flex-col gap-4">

            <div className="rounded-2xl p-6 glass"
              style={{border:'1px solid rgba(255,255,255,0.06)'}}>
              <div className="w-10 h-10 violet-gradient rounded-xl flex items-center justify-center mb-4">
                <Mail className="w-5 h-5 text-white" />
              </div>
              <h3 className="font-semibold text-white mb-1">Email Us</h3>
              <p className="text-sm mb-3" style={{color:'#a1a1aa'}}>
                For general enquiries and support
              </p>
              <a href="mailto:info@kurso.in"
                className="text-sm font-medium transition-colors"
                style={{color:'var(--kurso-primary-light)'}}>
                info@kurso.in
              </a>
            </div>

            

            

                        {/* Reassurance */}
            <div className="rounded-2xl p-5"
              style={{background:'rgba(var(--kurso-primary-rgb), 0.08)', border:'1px solid rgba(var(--kurso-primary-rgb), 0.2)'}}>
              <p className="text-sm font-semibold text-white mb-2">We're quick to help</p>
              <p className="text-sm leading-relaxed" style={{color:'#a1a1aa'}}>
                Whatever it is — a bug, a billing question, or you just want a hand setting up and designing your first course — email us and we'll sort it out with you. Don't overthink what to write, just tell us the issue in your own words and we'll take it from there.
              </p>
            </div>
          </div>

          {/* Contact form */}
          <div className="lg:col-span-2 flex flex-col gap-4">
            <div className="rounded-2xl p-8 glass"
              style={{border:'1px solid rgba(255,255,255,0.06)'}}>

              {!sent ? (
                <>
                  <h2 className="text-xl font-bold text-white mb-6">Send us a message</h2>
                  <form onSubmit={handleSubmit} className="flex flex-col gap-4">

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="text-sm font-medium text-white mb-2 block">Name</label>
                        <input
                          type="text" value={name} onChange={e => setName(e.target.value)}
                          placeholder="Your name" required
                          className="w-full px-4 py-3 rounded-xl text-sm text-white outline-none transition-all"
                          style={{background:'rgba(255,255,255,0.05)', border:'1px solid rgba(255,255,255,0.1)'}}
                          onFocus={e => e.target.style.borderColor = 'var(--kurso-primary)'}
                          onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,0.1)'}
                        />
                      </div>
                      <div>
                        <label className="text-sm font-medium text-white mb-2 block">Email</label>
                        <input
                          type="email" value={email} onChange={e => setEmail(e.target.value)}
                          placeholder="your@email.com" required
                          className="w-full px-4 py-3 rounded-xl text-sm text-white outline-none transition-all"
                          style={{background:'rgba(255,255,255,0.05)', border:'1px solid rgba(255,255,255,0.1)'}}
                          onFocus={e => e.target.style.borderColor = 'var(--kurso-primary)'}
                          onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,0.1)'}
                        />
                      </div>
                    </div>

                    <div>
                      <label className="text-sm font-medium text-white mb-2 block">Subject</label>
                      <select
                        value={subject} onChange={e => setSubject(e.target.value)} required
                        className="w-full px-4 py-3 rounded-xl text-sm outline-none transition-all"
                        style={{
                          background:'rgba(255,255,255,0.05)',
                          border:'1px solid rgba(255,255,255,0.1)',
                          color: subject ? '#fff' : '#52525b',
                        }}
                        onFocus={e => e.target.style.borderColor = 'var(--kurso-primary)'}
                        onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,0.1)'}
                      >
                        <option value="" style={{background:'#111'}}>Select a subject</option>
                        <option value="billing" style={{background:'#111'}}>Billing / Subscription</option>
                        <option value="technical" style={{background:'#111'}}>Technical Support</option>
                        <option value="upgrade" style={{background:'#111'}}>Billing question</option>
                        <option value="refund" style={{background:'#111'}}>Refund Request</option>
                        <option value="other" style={{background:'#111'}}>Other</option>
                      </select>
                    </div>

                    <div>
                      <label className="text-sm font-medium text-white mb-2 block">Message</label>
                      <textarea
                        value={message} onChange={e => setMessage(e.target.value)}
                        placeholder="Describe your issue or question in detail..."
                        required rows={6}
                        className="w-full px-4 py-3 rounded-xl text-sm text-white outline-none transition-all resize-none"
                        style={{background:'rgba(255,255,255,0.05)', border:'1px solid rgba(255,255,255,0.1)'}}
                        onFocus={e => e.target.style.borderColor = 'var(--kurso-primary)'}
                        onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,0.1)'}
                      />
                    </div>

                    {error && (
                      <div className="px-4 py-3 rounded-xl text-sm"
                        style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#f87171' }}>
                        {error}
                      </div>
                    )}

                    <button
                      type="submit" disabled={loading}
                      className="flex items-center justify-center gap-2 py-3 rounded-xl font-medium text-white violet-gradient hover:opacity-90 transition-all glow disabled:opacity-50"
                    >
                      {loading ? (
                        <>Sending...</>
                      ) : (
                        <><Send className="w-4 h-4" />Send Message</>
                      )}
                    </button>
                  </form>
                </>
              ) : (
                <div className="text-center py-12">
                  <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4"
                    style={{background:'rgba(74,222,128,0.1)', border:'1px solid rgba(74,222,128,0.2)'}}>
                    <CheckCircle className="w-8 h-8" style={{color:'#4ade80'}} />
                  </div>
                  <h3 className="text-xl font-bold text-white mb-2">Got it, thank you!</h3>
                  <p className="mb-6" style={{color:'#a1a1aa'}}>
                    We'll get back to you within 24 hours. Talk soon.
                  </p>
                  <button
                    onClick={() => { setSent(false); setName(''); setEmail(''); setSubject(''); setMessage('') }}
                    className="text-sm transition-colors"
                    style={{color:'var(--kurso-primary-light)'}}>
                    Send another message
                  </button>
                </div>
              )}
            </div>

            {/* Feature idea nudge — fills the space below the form, same width as the form */}
            <div className="rounded-2xl p-5 flex items-start gap-3"
              style={{background:'rgba(255,255,255,0.03)', border:'1px solid rgba(255,255,255,0.06)'}}>
              <Sparkles className="w-4 h-4 flex-shrink-0 mt-0.5" style={{color:'var(--kurso-primary-light)'}} />
              <p className="text-sm" style={{color:'#a1a1aa'}}>
                Got a feature idea instead of a support question? Tell us on our{' '}
                <Link href="/feedback" className="font-medium" style={{color:'var(--kurso-primary-light)'}}>Feedback page</Link>
                {' '}— we read every one.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t px-6 py-8 mt-8"
        style={{borderColor:'rgba(255,255,255,0.06)'}}>
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <Link href="/" className="flex items-center gap-2">
            <div className="w-6 h-6 violet-gradient rounded-md flex items-center justify-center">
              <GraduationCap className="w-3 h-3 text-white" />
            </div>
            <span className="text-sm font-medium text-white">Kurso</span>
          </Link>
          <div className="flex gap-6 text-xs" style={{color:'#828285'}}>
            <Link href="/feedback" className="hover:text-white transition-colors">Feedback</Link>
            <Link href="/terms" className="hover:text-white transition-colors">Terms</Link>
            <Link href="/privacy" className="hover:text-white transition-colors">Privacy</Link>
          </div>
        </div>
      </footer>
    </div>
  )
}