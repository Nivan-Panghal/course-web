'use client'
/**
 * src/components/CreatorAdminChatWidget.tsx
 * ─────────────────────────────────────────────────────────────────
 * Persistent floating chat between a creator and Kurso admin.
 * Mounted once in src/app/dashboard/layout.tsx so it survives
 * navigation across every /dashboard/* page without unmounting.
 *
 * - Message history lives entirely in the creator_admin_messages
 *   table and is fetched via /api/creator/messages. Only open/closed
 *   UI state is kept in localStorage — closing the widget or the
 *   browser never loses a conversation.
 * - New admin replies arrive live via Supabase Realtime
 *   (postgres_changes on creator_admin_messages), scoped to this
 *   creator's own rows by the RLS policy in the migration
 *   (auth.uid() = creator_id) — not just a client-side filter.
 * - The "is typing…" indicator is a separate, ephemeral Supabase
 *   Realtime Broadcast channel (no DB writes, nothing persisted) —
 *   it never carries message content, only a boolean signal.
 * - Anything older than 14 days is hard-deleted by a daily cron
 *   (/api/cron/creator-admin-chat-retention), so this component
 *   never needs its own "last 14 days" filter.
 * ─────────────────────────────────────────────────────────────────
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase, getSessionOrRefresh } from '@/lib/supabase'
import { MessageCircle, X, Send, Loader2 } from 'lucide-react'

interface ChatMessage {
  id: string
  sender: 'creator' | 'admin'
  message_text: string
  created_at: string
  read_at: string | null
}

const OPEN_STATE_KEY = 'kurso_admin_chat_open'
const TYPING_TIMEOUT_MS = 3000
const TYPING_BROADCAST_THROTTLE_MS = 1500
const MAX_MESSAGE_LENGTH = 2000

function dayLabel(iso: string) {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  if (sameDay(d, today)) return 'Today'
  if (sameDay(d, yesterday)) return 'Yesterday'
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: d.getFullYear() !== today.getFullYear() ? 'numeric' : undefined })
}

function timeLabel(iso: string) {
  return new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })
}

export default function CreatorAdminChatWidget({ creatorId }: { creatorId: string }) {
  const [open, setOpen] = useState(false)
  const [hydrated, setHydrated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [adminTyping, setAdminTyping] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const typingChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null)
  const lastTypingSentAt = useRef(0)
  const typingClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Restore open/closed UI state after mount (avoids SSR/localStorage mismatch).
  useEffect(() => {
    try {
      setOpen(localStorage.getItem(OPEN_STATE_KEY) === '1')
    } catch {
      // localStorage unavailable — default to closed, no crash.
    }
    setHydrated(true)
  }, [])

  useEffect(() => {
    if (!hydrated) return
    try {
      localStorage.setItem(OPEN_STATE_KEY, open ? '1' : '0')
    } catch {
      // Non-fatal — UI state just won't persist this session.
    }
  }, [open, hydrated])

  const addMessage = useCallback((m: ChatMessage) => {
    setMessages(prev => (prev.some(existing => existing.id === m.id) ? prev : [...prev, m]))
  }, [])

  // Initial load + Realtime subscription for new rows belonging to this creator.
  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setError('')
      try {
        const { session } = await getSessionOrRefresh()
        if (!session?.access_token) throw new Error('Not signed in')
        const res = await fetch('/api/creator/messages', {
          headers: { Authorization: `Bearer ${session.access_token}` },
        })
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || 'Could not load messages')
        if (cancelled) return
        setMessages(json.messages || [])
        setUnreadCount((json.messages || []).filter((m: ChatMessage) => m.sender === 'admin' && !m.read_at).length)
      } catch (e: any) {
        if (!cancelled) setError(e.message || 'Could not load messages')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()

    const channel = supabase
      .channel(`creator-admin-chat:${creatorId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'creator_admin_messages', filter: `creator_id=eq.${creatorId}` },
        (payload) => {
          const row = payload.new as ChatMessage
          addMessage(row)
          if (row.sender === 'admin') {
            setUnreadCount(c => c + 1)
          }
        }
      )
      .subscribe()

    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [creatorId, addMessage])

  // Ephemeral typing-indicator channel — separate from the message table,
  // nothing here is persisted.
  useEffect(() => {
    const channel = supabase
      .channel(`creator-admin-typing:${creatorId}`)
      .on('broadcast', { event: 'typing' }, (payload) => {
        if (payload.payload?.from !== 'admin') return
        setAdminTyping(true)
        if (typingClearTimer.current) clearTimeout(typingClearTimer.current)
        typingClearTimer.current = setTimeout(() => setAdminTyping(false), TYPING_TIMEOUT_MS)
      })
      .subscribe()
    typingChannelRef.current = channel
    return () => {
      if (typingClearTimer.current) clearTimeout(typingClearTimer.current)
      supabase.removeChannel(channel)
    }
  }, [creatorId])

  // Mark admin messages read once the creator actually opens the panel.
  useEffect(() => {
    if (!open || unreadCount === 0) return
    setUnreadCount(0)
    setMessages(prev => prev.map(m => (m.sender === 'admin' && !m.read_at ? { ...m, read_at: new Date().toISOString() } : m)))
    ;(async () => {
      const { session } = await getSessionOrRefresh()
      if (!session?.access_token) return
      await fetch('/api/creator/messages', {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${session.access_token}` },
      }).catch(() => {})
    })()
  }, [open, unreadCount])

  // Auto-scroll to the newest message whenever the panel is open and the list changes.
  useEffect(() => {
    if (!open) return
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, open])

  // Textarea auto-grow, capped so the composer never eats the message list.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`
  }, [text])

  function handleTyping() {
    const now = Date.now()
    if (now - lastTypingSentAt.current < TYPING_BROADCAST_THROTTLE_MS) return
    lastTypingSentAt.current = now
    typingChannelRef.current?.send({ type: 'broadcast', event: 'typing', payload: { from: 'creator' } })
  }

  async function handleSend() {
    const trimmed = text.trim()
    if (!trimmed || trimmed.length > MAX_MESSAGE_LENGTH || sending) return
    setSending(true)
    setError('')
    try {
      const { session } = await getSessionOrRefresh()
      if (!session?.access_token) throw new Error('Not signed in')
      const res = await fetch('/api/creator/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ messageText: trimmed }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Could not send message')
      addMessage(json.message)
      setText('')
    } catch (e: any) {
      setError(e.message || 'Could not send message')
    } finally {
      setSending(false)
    }
  }

  if (!hydrated) return null

  return (
    <>
      {!open && (
        <button
          onClick={() => setOpen(true)}
          aria-label="Open chat with Kurso support"
          className="fixed z-[60] bottom-5 right-5 sm:bottom-6 sm:right-6 w-14 h-14 rounded-full flex items-center justify-center transition-transform hover:scale-105"
          style={{ background: 'var(--kurso-primary)', boxShadow: '0 8px 24px rgba(var(--kurso-primary-rgb), 0.4)' }}
        >
          <MessageCircle className="w-6 h-6 text-white" />
          {unreadCount > 0 && (
            <span
              className="absolute -top-1 -right-1 min-w-[20px] h-5 px-1 rounded-full flex items-center justify-center text-[11px] font-bold text-white"
              style={{ background: '#ef4444', border: '2px solid #000' }}
            >
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </button>
      )}

      {open && (
        <div
          className="fixed z-[60] inset-0 sm:inset-auto sm:bottom-6 sm:right-6 flex flex-col sm:w-[380px] sm:h-[600px] sm:max-h-[80vh] sm:rounded-2xl overflow-hidden"
          style={{ background: '#0a0a0a', border: '1px solid rgba(255,255,255,0.08)', boxShadow: '0 20px 60px rgba(0,0,0,0.5)' }}
        >
          {/* Header */}
          <div
            className="flex items-center justify-between gap-3 px-4 py-3 flex-shrink-0"
            style={{ background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid rgba(255,255,255,0.08)' }}
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: 'var(--kurso-primary)' }}>
                <MessageCircle className="w-4 h-4 text-white" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-white truncate">Kurso Support</p>
                <p className="text-xs truncate" style={{ color: 'var(--kurso-text-muted)' }}>
                  {adminTyping ? 'Typing…' : 'Message the Kurso team directly'}
                </p>
              </div>
            </div>
            <button
              onClick={() => setOpen(false)}
              aria-label="Minimize chat"
              className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors"
              style={{ color: 'var(--kurso-text-muted)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.06)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-3">
            {loading ? (
              <div className="flex-1 flex items-center justify-center">
                <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--kurso-text-muted)' }} />
              </div>
            ) : messages.length === 0 ? (
              <div className="flex-1 flex items-center justify-center text-center px-6">
                <p className="text-sm" style={{ color: 'var(--kurso-text-muted)' }}>
                  👋 Have a question or need help with your Kurso account? Send us a message — we'll reply right here.
                </p>
              </div>
            ) : (
              messages.map((m, i) => {
                const prev = messages[i - 1]
                const showDayDivider = !prev || dayLabel(prev.created_at) !== dayLabel(m.created_at)
                const isCreator = m.sender === 'creator'
                return (
                  <div key={m.id} className="flex flex-col gap-3">
                    {showDayDivider && (
                      <div className="flex justify-center">
                        <span className="text-[11px] px-3 py-1 rounded-full" style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--kurso-text-muted)' }}>
                          {dayLabel(m.created_at)}
                        </span>
                      </div>
                    )}
                    <div className={`flex ${isCreator ? 'justify-end' : 'justify-start'}`}>
                      <div className="max-w-[80%] flex flex-col gap-1" style={{ alignItems: isCreator ? 'flex-end' : 'flex-start' }}>
                        <div
                          className="px-3.5 py-2.5 rounded-2xl text-sm whitespace-pre-wrap break-words"
                          style={{
                            background: isCreator ? 'var(--kurso-primary)' : 'rgba(255,255,255,0.06)',
                            color: isCreator ? '#fff' : '#e4e4e7',
                            borderBottomRightRadius: isCreator ? 4 : 16,
                            borderBottomLeftRadius: isCreator ? 16 : 4,
                          }}
                        >
                          {m.message_text}
                        </div>
                        <span className="text-[10px] px-1" style={{ color: 'var(--kurso-text-muted)' }}>{timeLabel(m.created_at)}</span>
                      </div>
                    </div>
                  </div>
                )
              })
            )}
            {adminTyping && (
              <div className="flex justify-start">
                <div className="px-3.5 py-3 rounded-2xl flex items-center gap-1" style={{ background: 'rgba(255,255,255,0.06)', borderBottomLeftRadius: 4 }}>
                  {[0, 1, 2].map(i => (
                    <span
                      key={i}
                      className="w-1.5 h-1.5 rounded-full animate-bounce"
                      style={{ background: 'var(--kurso-text-muted)', animationDelay: `${i * 0.12}s` }}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>

          {error && (
            <div className="mx-4 mb-2 px-3 py-2 rounded-xl flex-shrink-0" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}>
              <p className="text-xs" style={{ color: '#fca5a5' }}>{error}</p>
            </div>
          )}

          {/* Composer */}
          <div className="flex items-end gap-2 px-4 py-3 flex-shrink-0" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
            <textarea
              ref={textareaRef}
              value={text}
              onChange={e => { setText(e.target.value); handleTyping() }}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleSend()
                }
              }}
              rows={1}
              placeholder="Type a message…"
              maxLength={MAX_MESSAGE_LENGTH}
              className="flex-1 px-3.5 py-2.5 rounded-xl text-sm text-white outline-none resize-none"
              style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', maxHeight: 96 }}
            />
            <button
              onClick={handleSend}
              disabled={!text.trim() || sending}
              aria-label="Send message"
              className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ background: 'var(--kurso-primary)' }}
            >
              {sending ? <Loader2 className="w-4 h-4 text-white animate-spin" /> : <Send className="w-4 h-4 text-white" />}
            </button>
          </div>
        </div>
      )}
    </>
  )
}