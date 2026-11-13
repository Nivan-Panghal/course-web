/** Service-role client for the TEST database. Used to seed and inspect data, bypassing RLS. */
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { need } from './env'

let client: SupabaseClient | null = null

export function db(): SupabaseClient {
  if (!client) {
    client = createClient(need('NEXT_PUBLIC_SUPABASE_URL'), need('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  }
  return client
}