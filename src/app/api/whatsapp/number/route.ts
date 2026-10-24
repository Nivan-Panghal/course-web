/**
 * GET /api/whatsapp/number?courseIds=id1,id2,...        (public)
 *
 * Which WhatsApp number a student should message for each course: the creator's own number when
 * they connected one and it is working, otherwise nothing (the page then uses Kurso's number).
 * Returns only numbers that are already public in every wa.me link, never anything else.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const MAX_IDS = 50
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(req: NextRequest) {
  try {
    const ids = [...new Set((req.nextUrl.searchParams.get('courseIds') || '').split(',').map(s => s.trim()).filter(s => UUID.test(s)))].slice(0, MAX_IDS)
    if (ids.length === 0) return NextResponse.json({ numbers: {} })

    const { data: courses } = await supabase.from('courses').select('id, creator_id').in('id', ids)
    const creatorIds = [...new Set((courses || []).map(c => c.creator_id).filter(Boolean))]
    if (creatorIds.length === 0) return NextResponse.json({ numbers: {} })

    // Only a number that is connected and healthy is offered. Anything else falls back to Kurso's number.
    const { data: conns } = await supabase
      .from('whatsapp_connections')
      .select('creator_id, display_phone_number')
      .in('creator_id', creatorIds)
      .eq('status', 'connected')
    const byCreator = new Map((conns || []).map(c => [c.creator_id, String(c.display_phone_number || '').replace(/\D/g, '')]))

    const numbers: Record<string, string> = {}
    for (const c of courses || []) {
      const n = byCreator.get(c.creator_id)
      if (n) numbers[c.id] = n
    }
    return NextResponse.json({ numbers }, { headers: { 'Cache-Control': 'public, max-age=30, s-maxage=30' } })
  } catch (err: any) {
    console.error('[whatsapp-number] GET', err?.message)
    return NextResponse.json({ numbers: {} })
  }
}
