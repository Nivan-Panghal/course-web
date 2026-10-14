// src/lib/workshop-coupons.ts
// Rules shared by the coupon API and the dashboard form (workshops only).
export const COUPON_CODE_PATTERN = /^[A-Z0-9_-]{3,20}$/
export const MIN_PERCENT = 1
export const MAX_PERCENT = 99 // 100% off would be a free spot, which has its own option

export const normalizeCouponCode = (v: unknown) => String(v ?? '').trim().toUpperCase()

/** "Ends at the end of that day" in Indian time, as an ISO timestamp. */
export const endOfDayIst = (dateOnly: string) => new Date(`${dateOnly}T23:59:59+05:30`).toISOString()