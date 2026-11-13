/** Back-date or forward-date rows instead of waiting for real time to pass. */
const DAY = 86_400_000
export const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString()
export const daysFromNow = (n: number) => new Date(Date.now() + n * DAY).toISOString()
export const dateOnly = (iso: string) => iso.slice(0, 10)