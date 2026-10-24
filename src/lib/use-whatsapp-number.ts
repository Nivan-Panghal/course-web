'use client'
// src/lib/use-whatsapp-number.ts
//
// Which WhatsApp number a student should message for a course.
//   - the creator's own number, when they connected one and it is working
//   - otherwise Kurso's number (NEXT_PUBLIC_WHATSAPP_NUMBER), exactly as before
//
// The Kurso number is returned straight away, so nothing flickers or disappears while the lookup
// runs. If a student taps in that first moment they simply message Kurso's number, which still works.
import { useEffect, useState } from 'react'

const PLATFORM_NUMBER = (process.env.NEXT_PUBLIC_WHATSAPP_NUMBER || '').replace(/\D/g, '')

const known = new Map<string, string>() // courseId -> creator's own number ('' = none)
const inFlight = new Map<string, Promise<void>>()

/** Looks up several courses in one request and remembers the answers. Never throws. */
export async function loadWhatsAppNumbers(courseIds: string[]): Promise<Record<string, string>> {
  const missing = [...new Set(courseIds.filter(id => id && !known.has(id)))]
  if (missing.length > 0) {
    const key = missing.slice().sort().join(',')
    let job = inFlight.get(key)
    if (!job) {
      job = (async () => {
        try {
          const res = await fetch(`/api/whatsapp/number?courseIds=${encodeURIComponent(missing.join(','))}`)
          const json = res.ok ? await res.json() : { numbers: {} }
          for (const id of missing) known.set(id, String(json?.numbers?.[id] || ''))
        } catch {
          // Leave them unknown: the next render tries again, and until then Kurso's number is used.
        } finally {
          inFlight.delete(key)
        }
      })()
      inFlight.set(key, job)
    }
    await job
  }
  const out: Record<string, string> = {}
  for (const id of courseIds) out[id] = known.get(id) || ''
  return out
}

/** The number to put in a wa.me link for this course. */
export function useWhatsAppNumber(courseId?: string | null): string {
  const [own, setOwn] = useState<string>(courseId ? known.get(courseId) || '' : '')
  useEffect(() => {
    if (!courseId) return
    let cancelled = false
    loadWhatsAppNumbers([courseId]).then(r => { if (!cancelled) setOwn(r[courseId] || '') })
    return () => { cancelled = true }
  }, [courseId])
  return own || PLATFORM_NUMBER
}

/** Same, for a list of courses (used where a hook cannot run once per course). */
export function useWhatsAppNumbers(courseIds: string[]): Record<string, string> {
  const key = courseIds.join(',')
  const [own, setOwn] = useState<Record<string, string>>({})
  useEffect(() => {
    if (courseIds.length === 0) return
    let cancelled = false
    loadWhatsAppNumbers(courseIds).then(r => { if (!cancelled) setOwn(r) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  const out: Record<string, string> = {}
  for (const id of courseIds) out[id] = own[id] || PLATFORM_NUMBER
  return out
}
