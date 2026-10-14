// src/lib/workshop-public-reviews.ts
// Reviews shown on the public workshop page. Server side only.
// Never throws: if reviews are not set up yet, the page simply shows none.
import type { SupabaseClient } from '@supabase/supabase-js'

export type PublicReviews = {
  average: number
  count: number
  items: { name: string; rating: number; comment: string; reply: string; date: string }[]
}

/** "Priya Sharma" becomes "Priya S." so full names are never shown. */
function shortName(full: string | null): string {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return 'Attendee'
  if (parts.length === 1) return parts[0]
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`
}

export async function loadPublicReviews(supabase: SupabaseClient, workshopId: string): Promise<PublicReviews | null> {
  try {
    const { data, error } = await supabase
      .from('workshop_reviews')
      .select('registration_id, rating, comment, creator_reply, created_at')
      .eq('workshop_id', workshopId)
      .order('created_at', { ascending: false })
    if (error || !data || data.length === 0) return null

    const average = data.reduce((s, r) => s + r.rating, 0) / data.length
    const withText = data.filter(r => (r.comment || '').trim()).slice(0, 6)
    const { data: regs } = withText.length
      ? await supabase.from('workshop_registrations').select('id, name').in('id', withText.map(r => r.registration_id))
      : { data: [] as { id: string; name: string }[] }
    const nameOf = new Map((regs || []).map(r => [r.id, r.name]))

    return {
      average: Math.round(average * 10) / 10,
      count: data.length,
      items: withText.map(r => ({
        name: shortName(nameOf.get(r.registration_id) ?? null),
        rating: r.rating,
        comment: String(r.comment).trim(),
        reply: (r.creator_reply || '').trim(),
        date: r.created_at,
      })),
    }
  } catch (err) {
    console.error('[workshop public reviews]', err)
    return null
  }
}