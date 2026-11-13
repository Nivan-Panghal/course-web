/**
 * src/app/api/creator/messages/route.ts
 * ─────────────────────────────────────────────────────────────────
 * Creator-side endpoints for the persistent Creator ↔ Admin chat
 * widget (src/components/CreatorAdminChatWidget.tsx).
 *
 * GET   → this creator's full message history with the admin.
 *         Rows older than 14 days are hard-deleted by the daily cron
 *         (/api/cron/creator-admin-chat-retention), so nothing here
 *         needs its own age filter.
 * POST  → creator sends a message. Body: { messageText }
 * PATCH → marks every unread admin → creator message as read. Called
 *         whenever the creator actually opens the widget.
 *
 * Same auth pattern as /api/lesson-messages: Bearer token →
 * supabase.auth.getUser(token) → creator.id, all reads/writes done
 * with the service-role client so RLS never blocks a legitimate call.
 * ─────────────────────────────────────────────────────────────────
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const MAX_MESSAGE_LENGTH = 2000

async function getCreator(req: NextRequest) {
  const token = (req.headers.get('authorization') || '').replace('Bearer ', '').trim()
  if (!token) return null
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) return null
  return data.user
}

export async function GET(req: NextRequest) {
  try {
    const creator = await getCreator(req)
    if (!creator) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data, error } = await supabase
      .from('creator_admin_messages')
      .select('id, sender, message_text, created_at, read_at')
      .eq('creator_id', creator.id)
      .order('created_at', { ascending: true })

    if (error) {
      console.error('[creator/messages GET]', error)
      return NextResponse.json({ error: 'Could not load messages' }, { status: 500 })
    }

    return NextResponse.json({ messages: data || [] })
  } catch (err: any) {
    console.error('[creator/messages GET]', err)
    return NextResponse.json({ error: 'Unexpected error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const creator = await getCreator(req)
    if (!creator) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await req.json().catch(() => null)
    const messageText = (body?.messageText || '').toString().trim()

    if (!messageText) {
      return NextResponse.json({ error: 'messageText required' }, { status: 400 })
    }
    if (messageText.length > MAX_MESSAGE_LENGTH) {
      return NextResponse.json({ error: `Message must be ${MAX_MESSAGE_LENGTH} characters or fewer` }, { status: 400 })
    }

    const { data, error } = await supabase
      .from('creator_admin_messages')
      .insert({ creator_id: creator.id, sender: 'creator', message_text: messageText })
      .select('id, sender, message_text, created_at, read_at')
      .single()

    if (error) {
      console.error('[creator/messages POST]', error)
      return NextResponse.json({ error: 'Could not send message' }, { status: 500 })
    }

    return NextResponse.json({ message: data })
  } catch (err: any) {
    console.error('[creator/messages POST]', err)
    return NextResponse.json({ error: 'Unexpected error' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const creator = await getCreator(req)
    if (!creator) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { error } = await supabase
      .from('creator_admin_messages')
      .update({ read_at: new Date().toISOString() })
      .eq('creator_id', creator.id)
      .eq('sender', 'admin')
      .is('read_at', null)

    if (error) {
      console.error('[creator/messages PATCH]', error)
      return NextResponse.json({ error: 'Could not mark messages read' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err: any) {
    console.error('[creator/messages PATCH]', err)
    return NextResponse.json({ error: 'Unexpected error' }, { status: 500 })
  }
}