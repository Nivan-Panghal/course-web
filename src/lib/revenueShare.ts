import { createClient } from '@supabase/supabase-js'

/**
 * src/lib/revenueShare.ts
 * ─────────────────────────────────────────────────────────────────
 * Single source of truth for the "Pay As You Earn" pricing numbers and
 * the per-transaction commission split. Change the rate/threshold here
 * only — the pricing page copy, the webhook, and the invoice cron all
 * read from these constants so they can never drift out of sync.
 * ─────────────────────────────────────────────────────────────────
 */
export const REVENUE_SHARE_BASE_RATE_PERCENT = 5
export const REVENUE_SHARE_OVERFLOW_RATE_PERCENT = 6.5
export const REVENUE_SHARE_STUDENT_THRESHOLD = 300
export const REVENUE_SHARE_INVOICE_GRACE_DAYS = 14

// Ebook commission is unconditional — it applies to every creator's ebook
// sales regardless of course plan (flat, PAYE, or none at all), since
// ebook selling is never gated behind a plan. Lower than the course rate
// because fulfillment is just a signed download link, not ongoing bot
// delivery or video streaming.
export const EBOOK_REVENUE_SHARE_RATE_PERCENT = 4
export const EBOOK_MONTHLY_REVENUE_FLOOR = 500

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export type RevenueShareSplit = {
  platformFee: number
  creatorEarning: number
  ratePercent: number | null
}

/**
 * Computes how much of a single sale goes to Kurso as commission.
Everyone is Pay As You Earn. A creator with an active agreement pays the
rates on it; a creator without one pays the standard rates below. This is
the only place that decides the split; the webhook just calls it and
stores the result.
 *
 * productType controls which paid-customer count decides the tier. Course
 * and workshop counts are tracked SEPARATELY on purpose — a creator who
 * has crossed the threshold on courses doesn't get bumped to the overflow
 * rate on workshops just because of that, and vice versa. Both counts are
 * still measured against the same agreement's rate/threshold numbers.
 */
export async function computeRevenueShareSplit(
  creatorId: string,
  grossAmount: number,
  productType: 'course' | 'workshop' = 'course'
): Promise<RevenueShareSplit> {
  const { data: agreement } = await supabase
    .from('revenue_share_agreements')
    .select('base_rate_percent, overflow_rate_percent, overflow_threshold_students')
    .eq('creator_id', creatorId)
    .eq('status', 'active')
    .maybeSingle()

  const terms = agreement ?? {
    base_rate_percent: REVENUE_SHARE_BASE_RATE_PERCENT,
    overflow_rate_percent: REVENUE_SHARE_OVERFLOW_RATE_PERCENT,
    overflow_threshold_students: REVENUE_SHARE_STUDENT_THRESHOLD,
  }

  const { count } = productType === 'workshop'
    ? await supabase
      .from('workshop_registrations')
      .select('id, workshops!inner(creator_id)', { count: 'exact', head: true })
      .eq('payment_status', 'confirmed')
      .eq('workshops.creator_id', creatorId)
    : await supabase
      .from('enrollments')
      .select('id', { count: 'exact', head: true })
      .eq('creator_id', creatorId)
      .eq('payment_status', 'paid')
      .eq('is_test', false)

  const overThreshold = (count || 0) > (terms.overflow_threshold_students ?? REVENUE_SHARE_STUDENT_THRESHOLD)
  const ratePercent = overThreshold ? Number(terms.overflow_rate_percent ?? REVENUE_SHARE_OVERFLOW_RATE_PERCENT) : Number(terms.base_rate_percent ?? REVENUE_SHARE_BASE_RATE_PERCENT)

  const platformFee = Math.round((grossAmount * ratePercent) / 100)
  const creatorEarning = grossAmount - platformFee

  return { platformFee, creatorEarning, ratePercent }
}

/** YYYY-MM-01 for the first day of the month containing `date` (defaults to now). */
export function monthStart(date: Date = new Date()): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString().slice(0, 10)
}

/** Last calendar day of the month containing `date`. */
export function monthEnd(date: Date = new Date()): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).toISOString().slice(0, 10)
}

export function previousMonthRange(date: Date = new Date()): { start: string; end: string } {
  const prevMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1))
  return { start: monthStart(prevMonth), end: monthEnd(prevMonth) }
}