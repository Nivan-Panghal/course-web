// src/lib/workshops.ts
// Shared workshop helpers — single source of truth for spot counting and
// date formatting, used by the public page and the register/create-order routes.
import type { SupabaseClient } from '@supabase/supabase-js'
import { slugify } from './utils'
// An online checkout that was started but not paid holds a spot this long,
// then the spot is released to other registrants.
export const GATEWAY_HOLD_MINUTES = 30

/**
 * Spots currently held on a workshop:
 *  - every confirmed registration
 *  - every pending registration, EXCEPT abandoned gateway checkouts
 *    (payment_mode = 'gateway' with no attempt in the last GATEWAY_HOLD_MINUTES)
 * Pass excludeRegistrationId so a registrant retrying payment isn't
 * counted against themselves.
 */
export async function countHeldSpots(
  supabase: SupabaseClient,
  workshopId: string,
  excludeRegistrationId?: string
): Promise<number> {
  const cutoff = new Date(Date.now() - GATEWAY_HOLD_MINUTES * 60 * 1000).toISOString()

  let confirmedQuery = supabase
    .from('workshop_registrations')
    .select('id', { count: 'exact', head: true })
.eq('workshop_id', workshopId)
.eq('payment_status', 'confirmed')
.is('refunded_at', null) // a fully refunded student gives their seat back

if (excludeRegistrationId) confirmedQuery = confirmedQuery.neq('id', excludeRegistrationId)
  const { count: confirmed, error: confirmedError } = await confirmedQuery
  if (confirmedError) throw confirmedError

  let pendingQuery = supabase
    .from('workshop_registrations')
    .select('id', { count: 'exact', head: true })
    .eq('workshop_id', workshopId)
    .eq('payment_status', 'pending_confirmation')
    .or(`payment_mode.neq.gateway,payment_attempted_at.gte.${cutoff}`)
  if (excludeRegistrationId) pendingQuery = pendingQuery.neq('id', excludeRegistrationId)
  const { count: pending, error: pendingError } = await pendingQuery
  if (pendingError) throw pendingError

  return (confirmed || 0) + (pending || 0)
}

// e.g. "Sat, 4 Oct, 6:30 pm" — always IST, regardless of server timezone.
export function formatWorkshopDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short',
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: 'Asia/Kolkata',
  })
}

// ─── Creating / editing a workshop (dashboard) ──────────────────────────────

/** Length choices offered when creating a workshop, in minutes. The database
 *  accepts 15–600; these are the common ones. */
export const WORKSHOP_DURATION_OPTIONS = [30, 45, 60, 90, 120, 180, 240] as const

/** Field limits shared by the create page and workshop settings. */
export const WORKSHOP_LIMITS = {
  title: 80,
  description: 1500,
  hostName: 60,
  hostTitle: 80,
  takeaways: 6,
  takeawayLength: 120,
} as const

/** 90 -> "1 hr 30 min", 120 -> "2 hours", 45 -> "45 min". */
export function formatWorkshopDuration(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m} min`
  if (m === 0) return h === 1 ? '1 hour' : `${h} hours`
  return `${h} hr ${m} min`
}

/** Today's date in IST as YYYY-MM-DD, for <input type="date" min=...>. */
export function todayInIST(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
}

/** "2026-10-12" + "18:30", both meant as IST -> ISO string. null if invalid.
 *  Never use `new Date(localString)` for this: it reads the browser's zone,
 *  while every workshop page displays IST. */
export function istDateTimeToISO(date: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null
  const d = new Date(`${date}T${time}:00+05:30`)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** URL slug for a new workshop, unique among this creator's workshops:
 *  "my-workshop", then "my-workshop-2", "-3"... A title with no latin letters
 *  or digits (e.g. all Hindi) would slugify to '', so it falls back to
 *  "workshop" instead of producing an empty URL. */
export async function pickUniqueWorkshopSlug(
  supabase: SupabaseClient,
  creatorId: string,
  title: string
): Promise<string> {
  const base = slugify(title).replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '') || 'workshop'
  const { data, error } = await supabase
    .from('workshops')
    .select('slug')
    .eq('creator_id', creatorId)
    .like('slug', `${base}%`)
  if (error) throw error
  const taken = new Set((data ?? []).map(row => row.slug as string))
  if (!taken.has(base)) return base
  for (let i = 2; i < 1000; i++) {
    if (!taken.has(`${base}-${i}`)) return `${base}-${i}`
  }
  return `${base}-${Date.now()}`
}

/** ISO timestamp -> the IST date ("2026-10-12") and time ("18:30") to put back
 *  into <input type="date"> / <input type="time">. Inverse of istDateTimeToISO. */
export function isoToISTParts(iso: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso))
  const get = (type: string) => parts.find(part => part.type === type)?.value || ''
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` }
}

/** Creator-facing label for workshops.status. The database allows exactly
 *  these four values. Only 'published' is live: the public page, registration
 *  and reminders all require it. */
export function workshopStatusLabel(status: string | null | undefined): string {
  switch (status) {
    case 'published': return 'Live'
    case 'draft': return 'Draft'
    case 'cancelled': return 'Cancelled'
    case 'completed': return 'Completed'
    default: return status || 'Draft'
  }
}

// ─── Is registration open? (single source of truth) ─────────────────────────
// Used by the public page AND by both registration API routes, so the page
// can never show a form that the server would then refuse (or the reverse).

/** Workshops saved before a duration existed are treated as this long. */
export const DEFAULT_WORKSHOP_DURATION_MINUTES = 120

export type WorkshopRegistrationState = 'open' | 'closed' | 'ended'

/** When the workshop finishes: start time + duration. */
export function workshopEndsAt(dateTime: string, durationMinutes?: number | null): Date {
  const minutes = durationMinutes && durationMinutes > 0 ? durationMinutes : DEFAULT_WORKSHOP_DURATION_MINUTES
  return new Date(new Date(dateTime).getTime() + minutes * 60000)
}

/**
 * - 'ended'  : the workshop is over.
 * - 'closed' : the creator's optional "registration closes" time has passed.
 * - 'open'   : otherwise, including after the start time while it is still running.
 * An unreadable date never blocks registration (it stays 'open').
 */
export function getWorkshopRegistrationState(
  w: { date_time: string; duration_minutes?: number | null; registration_closes_at?: string | null },
  now: Date = new Date()
): WorkshopRegistrationState {
  const ends = workshopEndsAt(w.date_time, w.duration_minutes).getTime()
  if (Number.isFinite(ends) && now.getTime() >= ends) return 'ended'
  if (w.registration_closes_at) {
    const closes = new Date(w.registration_closes_at).getTime()
    if (Number.isFinite(closes) && now.getTime() >= closes) return 'closed'
  }
  return 'open'
}

/** Message for a visitor (page) or an API response. */
export function registrationClosedMessage(state: Exclude<WorkshopRegistrationState, 'open'>): string {
  return state === 'ended' ? 'This workshop has ended.' : 'Registration for this workshop is closed.'
}