'use client'
// Loads the creator's workshops + registrations for the workshop side of the
// shared dashboard pages. One request, shared shape (see lib/workshop-overview.ts).
import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import type { WorkshopOverview } from '@/lib/workshop-overview'

export function useWorkshopOverview() {
  const [data, setData] = useState<WorkshopOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) { setError('Please log in again.'); return }
      const res = await fetch('/api/workshops/overview', { headers: { Authorization: `Bearer ${session.access_token}` } })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) { setError(body.error || 'Could not load your workshops. Please try again.'); return }
      setData(body as WorkshopOverview)
    } catch {
      setError('Could not reach the server. Check your internet and try again.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  return { data, loading, error, reload: load }
}