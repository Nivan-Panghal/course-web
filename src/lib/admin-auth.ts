import { NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

// Solo-founder-scale admin check: your own email(s), allow-listed via env var.
// Set ADMIN_EMAILS in Vercel, e.g. ADMIN_EMAILS=name@yourdomain.in
// (comma-separate if you ever add a second admin)
export async function requireAdmin(req: NextRequest, supabase: SupabaseClient) {
  const token = (req.headers.get('authorization') || '').replace('Bearer ', '').trim()
  if (!token) return null

  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) return null

  const adminEmails = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)

  if (!data.user.email || !adminEmails.includes(data.user.email.toLowerCase())) return null
  return data.user
}