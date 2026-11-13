'use client'
/**
 * src/app/dashboard/admin/chat/page.tsx
 * ─────────────────────────────────────────────────────────────────
 * Admin's inbox for the Creator ↔ Admin chat widget. Lists every
 * creator conversation (most recent first, unread badge), lets admin
 * open one and reply, or start a brand-new conversation with a
 * creator who hasn't messaged first. Gated server-side by
 * requireAdmin() on every API call — this page just shows "Not
 * authorized" if those calls come back 401.
 *
 * Polls rather than using Supabase Realtime directly: the creator
 * side subscribes via a simple RLS policy (auth.uid() = creator_id),
 * but there's no equivalent safe policy for "authenticated user whose
 * email is in ADMIN_EMAILS" without duplicating that env var into
 * Postgres as a second source of truth — so this pane refreshes on an
 * interval instead. 8s for the conversation list, 3s for an open one.
 * ─────────────────────────────────────────────────────────────────
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase, getSessionOrRefresh } from '@/lib/supabase'
import { ArrowLeft, Loader2, MessageCircle, Search, Send, User } from 'lucide-react'

interface Conversation {
  creatorId: string
  creatorName: string
  lastMessage: string
  lastAt: string
  unread: number
}

interface NewConversationTarget {
  creatorId: string
  creatorName: string
}

interface ChatMessage {
  id: string
  sender: 'creator' | 'admin'
  message_text: string
  created_at: string
  read_at: string | null
}

const LIST_POLL_MS = 8000
const MESSAGE_POLL_MS = 3000
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
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

function timeLabel(iso: string) {
  return new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })
}

export default function AdminChatPage() {
  const [authorized, setAuthorized] = useState(true)
  const [loadingAuth, setLoadingAuth] = useState(true)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [noConversationYet, setNoConversationYet] = useState<NewConversationTarget[]>([])
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<{ creatorId: string; creatorName: string } | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [creatorTyping, setCreatorTyping] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)
  const typingChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null)
  const lastTypingSentAt = useRef(0)
  const typingClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const authHeader = useCallback(async () => {
    const { session } = await getSessionOrRefresh()
    if (!session?.access_token) return null
    return { Authorization: `Bearer ${session.access_token}` }
  }, [])

  const loadConversations = useCallback(async () => {
    const headers = await authHeader()
    if (!headers) { setAuthorized(false); return }
    const res = await fetch('/api/admin/chat', { headers })
    if (res.status === 401) { setAuthorized(false); return }
    const json = await res.json()
    if (res.ok) {
      setConversations(json.conversations || [])
      setNoConversationYet(json.noConversationYet || [])
    }
  }, [authHeader])

  useEffect(() => {
    loadConversations().finally(() => setLoadingAuth(false))
    const interval = setInterval(loadConversations, LIST_POLL_MS)
    return () => clearInterval(interval)
  }, [loadConversations])

  const loadMessages = useCallback(async (creatorId: string) => {
    const headers = await authHeader()
    if (!headers) { setAuthorized(false); return }
    const res = await fetch(`/api/admin/chat/${creatorId}`, { headers })
    if (res.status === 401) { setAuthorized(false); return }
    const json = await res.json()
    if (res.ok) setMessages(json.messages || [])
  }, [authHeader])

  useEffect(() => {
    if (!selected) return
    setLoadingMessages(true)
    setError('')
    loadMessages(selected.creatorId).finally(() => setLoadingMessages(false))
    const interval = setInterval(() => loadMessages(selected.creatorId), MESSAGE_POLL_MS)

    const channel = supabase
      .channel(`creator-admin-typing:${selected.creatorId}`)
      .on('broadcast', { event: 'typing' }, (payload) => {
        if (payload.payload?.from !== 'creator') return
        setCreatorTyping(true)
        if (typingClearTimer.current) clearTimeout(typingClearTimer.current)
        typingClearTimer.current = setTimeout(() => setCreatorTyping(false), TYPING_TIMEOUT_MS)
      })
      .subscribe()
    typingChannelRef.current = channel

    return () => {
      clearInterval(interval)
      if (typingClearTimer.current) clearTimeout(typingClearTimer.current)
      supabase.removeChannel(channel)
      setCreatorTyping(false)
    }
  }, [selected, loadMessages])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }, [text])

  function handleTyping() {
    const now = Date.now()
    if (now - lastTypingSentAt.current < TYPING_BROADCAST_THROTTLE_MS) return
    lastTypingSentAt.current = now
    typingChannelRef.current?.send({ type: 'broadcast', event: 'typing', payload: { from: 'admin' } })
  }

  async function handleSend() {
    const trimmed = text.trim()
    if (!trimmed || !selected || trimmed.length > MAX_MESSAGE_LENGTH || sending) return
    setSending(true)
    setError('')
    try {
      const headers = await authHeader()
      if (!headers) throw new Error('Not signed in')
      const res = await fetch(`/api/admin/chat/${selected.creatorId}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageText: trimmed }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Could not send message')
      setMessages(prev => [...prev, json.message])
      setText('')
      setConversations(prev => {
        const exists = prev.some(c => c.creatorId === selected.creatorId)
        const updated = { creatorId: selected.creatorId, creatorName: selected.creatorName, lastMessage: trimmed, lastAt: json.message.created_at, unread: 0 }
        if (!exists) return [updated, ...prev]
        return prev.map(c => (c.creatorId === selected.creatorId ? { ...c, lastMessage: trimmed, lastAt: json.message.created_at } : c))
      })
      setNoConversationYet(prev => prev.filter(c => c.creatorId !== selected.creatorId))
    } catch (e: any) {
      setError(e.message || 'Could not send message')
    } finally {
      setSending(false)
    }
  }

  const filteredConversations = conversations.filter(c => c.creatorName.toLowerCase().includes(search.toLowerCase()))
  const filteredNewTargets = noConversationYet.filter(c => c.creatorName.toLowerCase().includes(search.toLowerCase()))

  if (loadingAuth) {
    return (
      <div style={{ minHeight: '100vh', background: '#050505', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Loader2 className="w-6 h-6 animate-spin" style={{ color: 'var(--kurso-primary)' }} />
      </div>
    )
  }

  if (!authorized) {
    return (
      <div style={{ minHeight: '100vh', background: '#050505', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: '#a1a1aa' }}>Not authorized.</p>
      </div>
    )
  }

  return (
    <div className="flex" style={{ height: '100vh', background: '#050505' }}>
      {/* Conversation list */}
      <div
        className={`flex-col w-full md:w-[320px] md:flex-shrink-0 ${selected ? 'hidden md:flex' : 'flex'}`}
        style={{ borderRight: '1px solid rgba(255,255,255,0.08)' }}
      >
        <div className="px-4 py-4 flex-shrink-0" style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          <h1 className="text-lg font-bold text-white mb-3">Creator chat</h1>
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--kurso-text-muted)' }} />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search creators…"
              className="w-full pl-9 pr-3 py-2 rounded-xl text-sm text-white outline-none"
              style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {filteredConversations.length === 0 && filteredNewTargets.length === 0 && (
            <p className="text-sm text-center px-6 py-8" style={{ color: 'var(--kurso-text-muted)' }}>No creators found.</p>
          )}

          {filteredConversations.map(c => (
            <button
              key={c.creatorId}
              onClick={() => setSelected({ creatorId: c.creatorId, creatorName: c.creatorName })}
              className="w-full flex items-start gap-3 px-4 py-3 text-left transition-colors"
              style={{ background: selected?.creatorId === c.creatorId ? 'rgba(var(--kurso-primary-rgb), 0.1)' : 'transparent' }}
              onMouseEnter={e => { if (selected?.creatorId !== c.creatorId) e.currentTarget.style.background = 'rgba(255,255,255,0.03)' }}
              onMouseLeave={e => { if (selected?.creatorId !== c.creatorId) e.currentTarget.style.background = 'transparent' }}
            >
              <div className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(255,255,255,0.08)' }}>
                <User className="w-4 h-4" style={{ color: 'var(--kurso-text-muted)' }} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium text-white truncate">{c.creatorName}</p>
                  <span className="text-[10px] flex-shrink-0" style={{ color: 'var(--kurso-text-muted)' }}>{timeLabel(c.lastAt)}</span>
                </div>
                <p className="text-xs truncate" style={{ color: 'var(--kurso-text-muted)' }}>{c.lastMessage}</p>
              </div>
              {c.unread > 0 && (
                <span
                  className="min-w-[18px] h-[18px] px-1 rounded-full flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0"
                  style={{ background: 'var(--kurso-primary)' }}
                >
                  {c.unread > 9 ? '9+' : c.unread}
                </span>
              )}
            </button>
          ))}

          {filteredNewTargets.length > 0 && (
            <div className="pt-2">
              <p className="text-[11px] font-semibold uppercase tracking-wide px-4 py-2" style={{ color: 'var(--kurso-text-muted)' }}>
                Start a conversation
              </p>
              {filteredNewTargets.map(t => (
                <button
                  key={t.creatorId}
                  onClick={() => { setSelected(t); setMessages([]) }}
                  className="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors"
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.03)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <div className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(255,255,255,0.08)' }}>
                    <User className="w-4 h-4" style={{ color: 'var(--kurso-text-muted)' }} />
                  </div>
                  <p className="text-sm font-medium text-white truncate">{t.creatorName}</p>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Conversation detail */}
      <div className={`flex-col flex-1 ${selected ? 'flex' : 'hidden md:flex'}`}>
        {!selected ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-sm" style={{ color: 'var(--kurso-text-muted)' }}>Select a conversation to view messages.</p>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 px-4 py-3 flex-shrink-0" style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
              <button onClick={() => setSelected(null)} className="md:hidden w-8 h-8 rounded-lg flex items-center justify-center" style={{ color: 'var(--kurso-text-muted)' }}>
                <ArrowLeft className="w-4 h-4" />
              </button>
              <div className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: 'var(--kurso-primary)' }}>
                <MessageCircle className="w-4 h-4 text-white" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-white truncate">{selected.creatorName}</p>
                <p className="text-xs" style={{ color: 'var(--kurso-text-muted)' }}>{creatorTyping ? 'Typing…' : ''}</p>
              </div>
            </div>

            <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-3">
              {loadingMessages ? (
                <div className="flex-1 flex items-center justify-center">
                  <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--kurso-text-muted)' }} />
                </div>
              ) : messages.length === 0 ? (
                <div className="flex-1 flex items-center justify-center text-center px-6">
                  <p className="text-sm" style={{ color: 'var(--kurso-text-muted)' }}>No messages yet — say hello.</p>
                </div>
              ) : (
                messages.map((m, i) => {
                  const prev = messages[i - 1]
                  const showDayDivider = !prev || dayLabel(prev.created_at) !== dayLabel(m.created_at)
                  const isAdmin = m.sender === 'admin'
                  return (
                    <div key={m.id} className="flex flex-col gap-3">
                      {showDayDivider && (
                        <div className="flex justify-center">
                          <span className="text-[11px] px-3 py-1 rounded-full" style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--kurso-text-muted)' }}>
                            {dayLabel(m.created_at)}
                          </span>
                        </div>
                      )}
                      <div className={`flex ${isAdmin ? 'justify-end' : 'justify-start'}`}>
                        <div className="max-w-[70%] flex flex-col gap-1" style={{ alignItems: isAdmin ? 'flex-end' : 'flex-start' }}>
                          <div
                            className="px-3.5 py-2.5 rounded-2xl text-sm whitespace-pre-wrap break-words"
                            style={{
                              background: isAdmin ? 'var(--kurso-primary)' : 'rgba(255,255,255,0.06)',
                              color: isAdmin ? '#fff' : '#e4e4e7',
                              borderBottomRightRadius: isAdmin ? 4 : 16,
                              borderBottomLeftRadius: isAdmin ? 16 : 4,
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
            </div>

            {error && (
              <div className="mx-4 mb-2 px-3 py-2 rounded-xl flex-shrink-0" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}>
                <p className="text-xs" style={{ color: '#fca5a5' }}>{error}</p>
              </div>
            )}

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
                placeholder="Type a reply…"
                maxLength={MAX_MESSAGE_LENGTH}
                className="flex-1 px-3.5 py-2.5 rounded-xl text-sm text-white outline-none resize-none"
                style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', maxHeight: 120 }}
              />
              <button
                onClick={handleSend}
                disabled={!text.trim() || sending}
                aria-label="Send message"
                className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ background: 'var(--kurso-primary)' }}
              >
                {sending ? <Loader2 className="w-4 h-4 text-white animate-spin" /> : <Send className="w-4 h-4 text-white" />}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}