/**
 * src/app/api/admin/chat/route.ts
 * ─────────────────────────────────────────────────────────────────
 * Admin inbox list — every creator who has ever messaged (most
 * recent first, with an unread count), plus creators who haven't
 * messaged yet so admin can start a conversation themselves. Gated by
 * requireAdmin() — same hardcoded-email check used everywhere else
 * admin-only in this app.
 * ─────────────────────────────────────────────────────────────────
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { requireAdmin } from '@/lib/admin-auth'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(req: NextRequest) {
  try {
    const admin = await requireAdmin(req, supabase)
    if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const [{ data: messages, error: messagesError }, { data: creators, error: creatorsError }] = await Promise.all([
      supabase
        .from('creator_admin_messages')
        .select('id, creator_id, sender, message_text, created_at, read_at')
        .order('created_at', { ascending: false }),
      supabase.from('creators').select('id, name, username, email').order('name', { ascending: true }),
    ])

    if (messagesError) throw messagesError
    if (creatorsError) throw creatorsError

    const creatorsById = new Map((creators || []).map((c) => [c.id, c]))

    const byCreator = new Map<string, { lastMessage: string; lastAt: string; unread: number }>()
    for (const m of messages || []) {
      const existing = byCreator.get(m.creator_id)
      if (!existing) {
        byCreator.set(m.creator_id, {
          lastMessage: m.message_text,
          lastAt: m.created_at,
          unread: m.sender === 'creator' && !m.read_at ? 1 : 0,
        })
      } else if (m.sender === 'creator' && !m.read_at) {
        existing.unread += 1
      }
    }

    const conversations = Array.from(byCreator.entries())
      .map(([creatorId, info]) => {
        const c = creatorsById.get(creatorId)
        return {
          creatorId,
          creatorName: c?.name || c?.username || c?.email || 'Unknown creator',
          lastMessage: info.lastMessage,
          lastAt: info.lastAt,
          unread: info.unread,
        }
      })
      .sort((a, b) => new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime())

    const conversedIds = new Set(conversations.map((c) => c.creatorId))
    const noConversationYet = (creators || [])
      .filter((c) => !conversedIds.has(c.id))
      .map((c) => ({ creatorId: c.id, creatorName: c.name || c.username || c.email || 'Unknown creator' }))

    return NextResponse.json({ conversations, noConversationYet })
  } catch (err: any) {
    console.error('[admin/chat GET]', err)
    return NextResponse.json({ error: 'Could not load conversations' }, { status: 500 })
  }
}