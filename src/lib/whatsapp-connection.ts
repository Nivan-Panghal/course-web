// src/lib/whatsapp-connection.ts
//
// Server-side helpers for a creator's own WhatsApp number (Meta Embedded Signup).
// Never import this from client code: it handles access tokens.
import type { SupabaseClient } from '@supabase/supabase-js'
import { decryptWhatsappSecret } from '@/lib/whatsapp-token-crypto'

export type ConnectionStatus = 'pending' | 'connected' | 'problem'

export type ConnectionRow = {
  creator_id: string
  waba_id: string
  phone_number_id: string
  display_phone_number: string | null
  verified_name: string | null
  status: ConnectionStatus
  last_error: string | null
  last_error_at: string | null
  problem_notified_at: string | null
  token_encrypted: string
  pin_encrypted: string | null
  templates: Record<string, string> | null
  connected_at: string
  updated_at: string
}

export const GRAPH = () => `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v25.0'}`

type GraphResult = { ok: boolean; status: number; json: any }

/** One call to Meta's Graph API. Never throws: a network failure comes back as ok:false. */
export async function graph(path: string, token: string, init: { method?: string; body?: unknown } = {}): Promise<GraphResult> {
  try {
    const res = await fetch(`${GRAPH()}${path}`, {
      method: init.method || 'GET',
      headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(15000),
    })
    const json = await res.json().catch(() => ({}))
    return { ok: res.ok, status: res.status, json }
  } catch (err: any) {
    return { ok: false, status: 0, json: { error: { message: err?.message || 'Could not reach Meta' } } }
  }
}

export const graphErrorText = (r: GraphResult) => String(r.json?.error?.error_user_msg || r.json?.error?.message || `Meta returned status ${r.status}`)

/** Swaps the one-time code from the Embedded Signup popup for the creator's business access token. */
export async function exchangeSignupCode(code: string): Promise<{ token?: string; error?: string }> {
  const appId = process.env.META_APP_ID || process.env.NEXT_PUBLIC_META_APP_ID
  const secret = process.env.META_APP_SECRET
  if (!appId || !secret) return { error: 'Meta app settings are missing on the server.' }
  try {
    const qs = new URLSearchParams({ client_id: appId, client_secret: secret, code })
    const res = await fetch(`${GRAPH()}/oauth/access_token?${qs.toString()}`, { signal: AbortSignal.timeout(15000) })
    const json = await res.json().catch(() => ({}))
    if (!res.ok || !json?.access_token) return { error: String(json?.error?.message || 'Meta did not accept the sign-up code.') }
    return { token: String(json.access_token) }
  } catch (err: any) {
    return { error: err?.message || 'Could not reach Meta.' }
  }
}

/** Meta's number status -> ours. CONNECTED is ready; PENDING is still being verified; the rest need attention. */
export function mapNumberStatus(metaStatus: unknown): { status: ConnectionStatus; error: string | null } {
  const s = String(metaStatus || '').toUpperCase()
  if (s === 'CONNECTED') return { status: 'connected', error: null }
  if (s === 'PENDING' || s === '') return { status: 'pending', error: null }
  return { status: 'problem', error: `Meta reports this number as ${s.toLowerCase().replace(/_/g, ' ')}. Open WhatsApp Manager in Meta Business Suite to fix it.` }
}

export async function fetchNumberInfo(phoneNumberId: string, token: string) {
  return graph(`/${phoneNumberId}?fields=display_phone_number,verified_name,status`, token)
}

/** Subscribes Kurso's app to this WhatsApp account, so its messages reach Kurso's webhook. Safe to repeat. */
export async function subscribeApp(wabaId: string, token: string) {
  return graph(`/${wabaId}/subscribed_apps`, token, { method: 'POST', body: {} })
}

/** Reads the status of every template in the creator's account, for the names we already track. */
export async function fetchTemplateStatuses(wabaId: string, token: string): Promise<Record<string, string> | null> {
  const r = await graph(`/${wabaId}/message_templates?fields=name,status,language&limit=200`, token)
  if (!r.ok || !Array.isArray(r.json?.data)) return null
  const out: Record<string, string> = {}
  for (const t of r.json.data) {
    if (!t?.name) continue
    // If a name exists in several languages, APPROVED wins.
    if (out[t.name] !== 'APPROVED') out[t.name] = String(t.status || 'PENDING').toUpperCase()
  }
  return out
}

/** Asks the WhatsApp bot to copy Kurso's approved templates into the creator's account. Fire and forget. */
export async function requestTemplateSetup(creatorId: string): Promise<boolean> {
  const base = process.env.WHATSAPP_BOT_URL
  const secret = process.env.INTERNAL_BOT_SECRET
  if (!base || !secret) return false
  try {
    const res = await fetch(`${base}/internal/setup-own-number`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ creatorId }),
      signal: AbortSignal.timeout(10000),
    })
    return res.ok
  } catch {
    return false
  }
}

/** What the creator's browser may see. Never the token or PIN. */
export function publicView(row: ConnectionRow | null) {
  if (!row) return { connected: false as const }
  return {
    connected: true as const,
    status: row.status,
    displayPhoneNumber: row.display_phone_number,
    verifiedName: row.verified_name,
    lastError: row.status === 'problem' ? row.last_error : null,
    templates: row.templates || {},
    connectedAt: row.connected_at,
  }
}

/**
 * Brings a saved connection up to date with Meta: number status, template statuses, and (on a
 * recheck) the webhook subscription. A problem the bot recorded stays a problem until the creator
 * taps "Check again", so a bad state is never hidden by a lucky refresh.
 */
export async function refreshConnection(supabase: SupabaseClient, row: ConnectionRow, opts: { recheck?: boolean } = {}): Promise<ConnectionRow> {
  let token: string
  try {
    token = decryptWhatsappSecret(row.token_encrypted)
  } catch {
    return row // key problem on our side: leave the row as it is
  }

  const patch: Partial<ConnectionRow> & { updated_at?: string } = {}
  const info = await fetchNumberInfo(row.phone_number_id, token)
  if (info.ok) {
    if (info.json?.display_phone_number) patch.display_phone_number = String(info.json.display_phone_number)
    if (info.json?.verified_name) patch.verified_name = String(info.json.verified_name)
    const mapped = mapNumberStatus(info.json?.status)
    if (row.status !== 'problem' || opts.recheck) {
      patch.status = mapped.status
      patch.last_error = mapped.error
      patch.last_error_at = mapped.error ? new Date().toISOString() : null
      if (mapped.status !== 'problem') patch.problem_notified_at = null
    }
  } else if (info.status === 401 || info.status === 403 || info.json?.error?.code === 190) {
    patch.status = 'problem'
    patch.last_error = 'Meta no longer accepts this connection (it may have been removed or the access was revoked). Please disconnect and connect again.'
    patch.last_error_at = new Date().toISOString()
  }

  if (opts.recheck) {
    const sub = await subscribeApp(row.waba_id, token)
    if (!sub.ok && (patch.status ?? row.status) !== 'problem') {
      patch.status = 'problem'
      patch.last_error = `Kurso could not subscribe to your WhatsApp account: ${graphErrorText(sub)}`
      patch.last_error_at = new Date().toISOString()
    }
  }

  const statuses = await fetchTemplateStatuses(row.waba_id, token)
  if (statuses && row.templates && Object.keys(row.templates).length > 0) {
    const next: Record<string, string> = {}
    for (const name of Object.keys(row.templates)) next[name] = statuses[name] || row.templates[name]
    if (JSON.stringify(next) !== JSON.stringify(row.templates)) patch.templates = next
  }

  if (Object.keys(patch).length === 0) return row
  const { data } = await supabase
    .from('whatsapp_connections')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('creator_id', row.creator_id)
    .select('*')
    .maybeSingle()
  return (data as ConnectionRow | null) || { ...row, ...patch }
}
