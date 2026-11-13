/**
 * POST /api/creator/ratings/[id]/flag
 * Flags a rating for manual review — hides it from the public average
 * immediately, but keeps it stored and visible to the creator. There is
 * deliberately no unflag or delete endpoint: removal only happens if
 * creator manually confirms it's fake/abusive (no automated moderation
 * queue in this v1).
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function getCreatorId(req: NextRequest) {
  const token = (req.headers.get('authorization') || '').replace('Bearer ', '').trim()
  if (!token) return null
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) return null
  return data.user.id
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const creatorId = await getCreatorId(req)
    if (!creatorId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { id } = await params

    const { data: rating } = await supabase
      .from('course_ratings')
      .select('id, course_id')
      .eq('id', id)
      .maybeSingle()
    if (!rating) return NextResponse.json({ error: 'Rating not found' }, { status: 404 })

    const { data: course } = await supabase
      .from('courses')
      .select('id')
      .eq('id', rating.course_id)
      .eq('creator_id', creatorId)
      .maybeSingle()
    if (!course) return NextResponse.json({ error: 'Not authorized' }, { status: 403 })

    const { error } = await supabase
      .from('course_ratings')
      .update({ flagged_for_review: true })
      .eq('id', id)
    if (error) throw error

    return NextResponse.json({ success: true })
  } catch (err: any) {
    console.error('[creator/ratings/flag] error:', err.message)
    return NextResponse.json({ error: 'Failed to flag rating' }, { status: 500 })
  }
}