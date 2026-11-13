/**
 * Supabase clients that behave like real users (anon / signed-in), as opposed to
 * admin-db.ts which bypasses RLS. Security tests MUST use these, never db().
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { need } from './env'

const opts = { auth: { autoRefreshToken: false, persistSession: false } }

/** A visitor who is not logged in (uses only the public anon key, like a browser would). */
export function anonClient(): SupabaseClient {
  return createClient(need('NEXT_PUBLIC_SUPABASE_URL'), need('NEXT_PUBLIC_SUPABASE_ANON_KEY'), opts)
}

/** A logged-in creator or student, signed in with email + password. */
export async function signedInClient(email: string, password: string): Promise<SupabaseClient> {
  const c = anonClient()
  const { error } = await c.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`Test sign-in failed for ${email}: ${error.message}`)
  return c
}

/** Rows a user could actually see. A permission error counts as "saw nothing". */
export function visibleRows(res: { data: any; error: any }): any[] {
  return res.error ? [] : res.data ?? []
}

/** A creator's login token, sent as "Authorization: Bearer ..." to API routes. */
export async function accessToken(email: string, password: string): Promise<string> {
  const c = await signedInClient(email, password)
  const { data } = await c.auth.getSession()
  if (!data.session) throw new Error('No session after sign-in')
  return data.session.access_token
}