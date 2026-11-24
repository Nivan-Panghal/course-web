'use client'

/**
 * Adds the signed-in student's login to requests for a Telegram/WhatsApp start-link
 * (/api/telegram/create-token and /api/whatsapp/create-token).
 *
 * Those routes only hand a link to the account it belongs to, so they need to know who is asking.
 * Doing it here, once, means every place that asks for a link (enroll popup, My Learning, course page,
 * creator test mode) is covered without each one adding the header. Only those two same-site URLs are
 * touched, and only when the request does not already carry an Authorization header. If nobody is
 * signed in, nothing is added (people with no web account can still use /claim/telegram).
 *
 * The patch is installed when this file loads AND when the component mounts, so it is in place before
 * any component can ask for a link.
 */
import { useEffect } from 'react'
import { supabase } from '@/lib/supabase'

const TARGETS = new Set(['/api/telegram/create-token', '/api/whatsapp/create-token'])

declare global {
  interface Window {
    __kursoAuthFetch?: boolean
  }
}

function install() {
  if (typeof window === 'undefined' || window.__kursoAuthFetch) return
  window.__kursoAuthFetch = true
  const original = window.fetch.bind(window)

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const url = new URL(raw, window.location.origin)
      if (url.origin === window.location.origin && TARGETS.has(url.pathname)) {
        const headers = new Headers(init?.headers ?? (typeof input === 'object' && 'headers' in input ? input.headers : undefined))
        if (!headers.has('Authorization')) {
          const { data } = await supabase.auth.getSession()
          if (data.session?.access_token) headers.set('Authorization', `Bearer ${data.session.access_token}`)
        }
        return original(input, { ...init, headers })
      }
    } catch {
      // never let the helper break a request
    }
    return original(input, init)
  }
}

install()

export default function AuthFetchInstaller() {
  useEffect(() => { install() }, [])
  return null
}