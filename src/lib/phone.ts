/**
 * src/lib/phone.ts
 * ─────────────────────────────────────────────────────────────────
 * Single source of truth for phone number normalization.
 *
 * Different parts of the system were storing/matching phone numbers in
 * different formats — some with a leading "+", some without, some with
 * spaces/dashes from a checkout form. Since `enrollments.phone` is used
 * both as a lookup key (Telegram/WhatsApp identity matching) AND has a
 * unique constraint (enrollments_one_paid_phone_per_course), format
 * drift caused duplicate enrollment rows for the same real person and
 * intermittent "enrollment not found" / unique-constraint failures.
 *
 * Mirrors Whatsapp-bot/phone.js EXACTLY. That bot receives numbers from
 * Meta WITH the country code and strips a leading
 * Indian "91" before matching against `enrollments`/`students`. For that
 * match to ever succeed, this function must produce the identical bare
 * 10-digit form for Indian numbers. Non-Indian numbers are left with
 * their country code intact, since the bot doesn't strip those either —
 * Meta will send (and this must store) whatever the student's real
 * number is, digits only.
 *
 * Always normalize phone numbers through this function before reading
 * OR writing the `phone` column anywhere (enrollments, students,
 * whatsapp_tokens) — including client-side, before the value is ever
 * sent to an API route. Don't add a second copy of this logic.
 * ─────────────────────────────────────────────────────────────────
 */

export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null
  let digits = String(raw).replace(/\D/g, '')
  if (!digits) return null

  // Strip a leading Indian country code so this always lands on the same
  // bare 10-digit form the rest of the system (and the WhatsApp bot) uses.
  if (digits.length === 12 && digits.startsWith('91')) {
    digits = digits.slice(2)
  } else if (digits.length === 13 && digits.startsWith('091')) {
    // defensive: some clients prefix a leading 0 before the country code
    digits = digits.slice(3)
  } else if (digits.length === 11 && digits.startsWith('0')) {
    
    digits = digits.slice(1)
  }

  return digits || null
}