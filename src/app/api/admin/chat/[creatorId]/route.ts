/**
 * src/app/api/admin/chat/[creatorId]/route.ts
 * ─────────────────────────────────────────────────────────────────
 * GET  → full message history with one creator, and marks every
 *        unread creator → admin message as read 
 * POST → admin sends a message to this creator — works even if no
 *        conversation exists yet.
 * Gated by requireAdmin().
 * ─────────────────────────────────────────────────────────────────
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { requireAdmin } from '@/lib/admin-auth'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const MAX_MESSAGE_LENGTH = 2000

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ creatorId: string }> }
) {
  try {
    const admin = await requireAdmin(req, supabase)
    if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { creatorId } = await props.params

    const { data: messages, error } = await supabase
      .from('creator_admin_messages')
      .select('id, sender, message_text, created_at, read_at')
      .eq('creator_id', creatorId)
      .order('created_at', { ascending: true })

    if (error) throw error

    const { error: readError } = await supabase
      .from('creator_admin_messages')
      .update({ read_at: new Date().toISOString() })
      .eq('creator_id', creatorId)
      .eq('sender', 'creator')
      .is('read_at', null)
    if (readError) console.error('[admin/chat/:creatorId GET] mark-read failed', readError)

    return NextResponse.json({ messages: messages || [] })
  } catch (err: any) {
    console.error('[admin/chat/:creatorId GET]', err)
    return NextResponse.json({ error: 'Could not load conversation' }, { status: 500 })
  }
}

export async function POST(
  req: NextRequest,
  props: { params: Promise<{ creatorId: string }> }
) {
  try {
    const admin = await requireAdmin(req, supabase)
    if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { creatorId } = await props.params
    const body = await req.json().catch(() => null)
    const messageText = (body?.messageText || '').toString().trim()

    if (!messageText) return NextResponse.json({ error: 'messageText required' }, { status: 400 })
    if (messageText.length > MAX_MESSAGE_LENGTH) {
      return NextResponse.json({ error: `Message must be ${MAX_MESSAGE_LENGTH} characters or fewer` }, { status: 400 })
    }

    // Confirm the creator actually exists before letting admin start a
    // brand-new thread with a bogus id.
    const { data: creatorRow } = await supabase.from('creators').select('id').eq('id', creatorId).maybeSingle()
    if (!creatorRow) return NextResponse.json({ error: 'Creator not found' }, { status: 404 })

    const { data, error } = await supabase
      .from('creator_admin_messages')
      .insert({ creator_id: creatorId, sender: 'admin', message_text: messageText })
      .select('id, sender, message_text, created_at, read_at')
      .single()

    if (error) throw error

    return NextResponse.json({ message: data })
  } catch (err: any) {
    console.error('[admin/chat/:creatorId POST]', err)
    return NextResponse.json({ error: 'Could not send message' }, { status: 500 })
  }
}