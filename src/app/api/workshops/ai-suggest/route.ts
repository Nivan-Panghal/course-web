// src/app/api/workshops/ai-suggest/route.ts
//
// "Write with AI" for workshop pages. Creator-authenticated.
//   POST { workshopId, brief, context, answers?, fields } →
//     { status: 'needs_info', questions }  (first request only, when the brief is too thin)
//     { status: 'ready', fields, notes, remaining }
//
// The model only SUGGESTS: nothing here writes to the workshop. The creator
// reviews each suggestion in workshop settings and saves it themselves.
// Usage is count-only (workshop_ai_usage): no prompt or answer text is stored.
// All the rules live in lib/workshop-ai.ts so they can be tested without a network.

import { NextRequest, NextResponse } from 'next/server'
import { getAuthenticatedCreator, supabaseAdmin } from '@/app/api/razorpay/subscription-auth'
import { isImpersonationActive, IMPERSONATION_BLOCK_MESSAGE } from '@/lib/impersonation-guard'
import { generateJsonText } from '@/lib/ai-providers'
import { parseAiRequest, runWorkshopAiSuggest } from '@/lib/workshop-ai'

// Gemini (15s) then DeepSeek (15s) in the worst case.
export const maxDuration = 45

export async function POST(req: NextRequest) {
  try {
    const { creator, error } = await getAuthenticatedCreator(req)
    if (error || !creator) {
      console.warn('[workshops/ai-suggest] unauthenticated request')
      return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 })
    }
    if (await isImpersonationActive(creator.id)) {
      return NextResponse.json({ error: IMPERSONATION_BLOCK_MESSAGE }, { status: 403 })
    }

    let body: unknown
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
    }
    const parsed = parseAiRequest(body)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    const request = parsed.value

    // The workshop must belong to this creator.
    const { data: workshop } = await supabaseAdmin
      .from('workshops')
      .select('id')
      .eq('id', request.workshopId)
      .eq('creator_id', creator.id)
      .maybeSingle()
    if (!workshop) {
      console.warn('[workshops/ai-suggest] workshop not found for creator', { creatorId: creator.id, workshopId: request.workshopId })
      return NextResponse.json({ error: 'Workshop not found.' }, { status: 404 })
    }

    const outcome = await runWorkshopAiSuggest(request, {
      countRecent: async () => {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
        const { count, error: countError } = await supabaseAdmin
          .from('workshop_ai_usage')
          .select('id', { count: 'exact', head: true })
          .eq('creator_id', creator.id)
          .gte('created_at', since)
        // Fail closed: if we cannot count, we cannot enforce the daily limit.
        if (countError) throw new Error(`usage count failed (is the workshop_ai_usage table created?): ${countError.message}`)
        return count || 0
      },
      recordUsage: async () => {
        const { error: insertError } = await supabaseAdmin
          .from('workshop_ai_usage')
          .insert({ creator_id: creator.id, workshop_id: request.workshopId })
        if (insertError) console.error('[workshops/ai-suggest] could not record usage', insertError.message)
      },
      generate: (system, user) => generateJsonText(system, user),
    })

    if (outcome.status !== 200) {
      console.warn('[workshops/ai-suggest] not served:', outcome.status, outcome.body.error)
    }
    return NextResponse.json(outcome.body, { status: outcome.status })
  } catch (err: any) {
    console.error('[workshops/ai-suggest POST]', err?.message)
    return NextResponse.json({ error: 'Something went wrong with the AI assistant. Please try again.' }, { status: 500 })
  }
}