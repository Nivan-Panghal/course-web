// src/lib/workshop-overview.ts
//
// Shared types and number-crunching for the WORKSHOP side of the shared dashboard
// pages (Students, Revenue, Analytics, Broadcast, Overview). Pure functions only,
// so it is safe in both the browser and the server.
//
// Money rule (one place, so every page agrees):
//   a CONFIRMED registration counts as
//     - the amount paid online, when there is one;
//     - ₹0 for free workshops;
//     - the workshop's listed price when the creator marked it paid by hand (UPI).

export type WorkshopRow = {
  id: string
  title: string
  slug: string
  status: string
  dateTime: string
  price: number
  capacity: number | null
  durationMinutes: number | null
}

export type RegistrationRow = {
  id: string
  workshopId: string
  name: string
  phone: string
  email: string | null
  paymentMode: string
  paymentStatus: string
  /** Rupees counted for this registration (0 unless confirmed). */
  counted: number
  attended: boolean
  hasTelegram: boolean
  viaReferral: boolean
  certificateMade: boolean
  certificateSent: boolean
  /** Fully refunded: no longer counts as a confirmed attendee. */
  refunded: boolean
  /** Rupees already refunded (online refunds, or the full amount when refunded by hand). */
  refundedAmount: number
  refundStatus: 'pending' | 'completed' | 'denied' | null
  createdAt: string
}

export type WorkshopOverview = { workshops: WorkshopRow[]; registrations: RegistrationRow[] }

export const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`

export const isConfirmed = (r: RegistrationRow) => r.paymentStatus === 'confirmed' && !r.refunded
/** Paid by UPI (or similar) and waiting for the creator to tap "Mark Paid". Online checkouts in progress are not included. */
export const isAwaiting = (r: RegistrationRow) => r.paymentStatus === 'pending_confirmation' && r.paymentMode !== 'gateway'

export type WorkshopStats = {
  workshop: WorkshopRow
  registered: number
  confirmed: number
  awaiting: number
  awaitingValue: number
  attended: number
  certificates: number
  referrals: number
  revenue: number
  seatsLeft: number | null
}

export function statsFor(workshop: WorkshopRow, regs: RegistrationRow[]): WorkshopStats {
  const mine = regs.filter(r => r.workshopId === workshop.id)
  const confirmed = mine.filter(isConfirmed)
  const awaiting = mine.filter(isAwaiting)
  return {
    workshop,
    registered: mine.length,
    confirmed: confirmed.length,
    awaiting: awaiting.length,
    awaitingValue: awaiting.length * workshop.price,
    attended: confirmed.filter(r => r.attended).length,
    certificates: confirmed.filter(r => r.certificateSent || r.certificateMade).length,
    referrals: mine.filter(r => r.viaReferral).length,
    revenue: confirmed.reduce((sum, r) => sum + r.counted, 0),
    seatsLeft: workshop.capacity != null ? Math.max(0, workshop.capacity - confirmed.length - awaiting.length) : null,
  }
}

export const percent = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0)

/** Revenue for the last `count` calendar months (oldest first), by registration date. */
export function monthlyRevenue(regs: RegistrationRow[], count = 6): { label: string; value: number }[] {
  const now = new Date()
  const months = Array.from({ length: count }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (count - 1 - i), 1)
    return { key: `${d.getFullYear()}-${d.getMonth()}`, label: d.toLocaleDateString('en-IN', { month: 'short' }), value: 0 }
  })
  for (const r of regs) {
    if (!isConfirmed(r)) continue
    const d = new Date(r.createdAt)
    const m = months.find(x => x.key === `${d.getFullYear()}-${d.getMonth()}`)
    if (m) m.value += r.counted
  }
  return months.map(({ label, value }) => ({ label, value }))
}

/** Safe CSV cell: quotes, and a leading apostrophe so spreadsheets never run a "formula". */
export function csvCell(v: unknown): string {
  let s = v == null ? '' : String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return `"${s.replace(/"/g, '""')}"`
}