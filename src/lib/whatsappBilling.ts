// src/lib/whatsappBilling.ts
//
// How WhatsApp messages are priced on a creator's monthly invoice.
//
//  - Every delivered, billable message sent from Kurso's WhatsApp number is logged in
//    whatsapp_usage (by the WhatsApp bot, phase 2), with the type Meta charged it as.
//  - Each type has a rate in whatsapp_rates (rupees, before tax). These are Meta's rates
//    passed through at cost. A markup can be added with the billing_settings row
//    'whatsapp_markup_percent' (0 by default).
//  - Telegram and email are free and never counted.
//
// Server side only.

import type { SupabaseClient } from '@supabase/supabase-js'

export const META_PRICING_URL = 'https://developers.facebook.com/docs/whatsapp/pricing'

export type WhatsappCategory = 'marketing' | 'utility' | 'authentication' | 'service'

export const WHATSAPP_CATEGORY_LABEL: Record<WhatsappCategory, string> = {
  utility: 'Reminders and updates',
  marketing: 'Promotional messages',
  authentication: 'Verification codes',
  service: 'Chat replies',
}

export type InvoiceLineItem =
  | { type: 'sales'; label: string; amount: number; detail?: string }
  | { type: 'commission'; label: string; amount: number; detail?: string }
  | { type: 'refund_credit'; label: string; amount: number; detail?: string }
  | { type: 'whatsapp'; category: WhatsappCategory; label: string; count: number; rate: number; amount: number }

export type WhatsappSettings = {
  rates: Record<WhatsappCategory, number>
  markupPercent: number
  minInvoiceInr: number
}

const DEFAULT_SETTINGS: WhatsappSettings = {
  rates: { marketing: 0.8631, utility: 0.115, authentication: 0.115, service: 0.115 },
  markupPercent: 0,
  minInvoiceInr: 50,
}

const round2 = (n: number) => Math.round(n * 100) / 100

export async function loadWhatsappSettings(supabase: SupabaseClient): Promise<WhatsappSettings> {
  const settings: WhatsappSettings = { ...DEFAULT_SETTINGS, rates: { ...DEFAULT_SETTINGS.rates } }
  const { data: rateRows } = await supabase.from('whatsapp_rates').select('category, rate_inr')
  for (const r of rateRows || []) {
    if (r.category in settings.rates && Number.isFinite(Number(r.rate_inr))) settings.rates[r.category as WhatsappCategory] = Number(r.rate_inr)
  }
  const { data: s } = await supabase.from('billing_settings').select('key, value')
  for (const row of s || []) {
    const n = Number(row.value)
    if (!Number.isFinite(n) || n < 0) continue
    if (row.key === 'whatsapp_markup_percent') settings.markupPercent = n
    if (row.key === 'whatsapp_min_invoice_inr') settings.minInvoiceInr = n
  }
  return settings
}

/** Turns message counts into invoice lines. Pure: easy to test. */
export function priceWhatsappUsage(
  counts: { category: string; messages: number }[],
  settings: WhatsappSettings,
): { lines: Extract<InvoiceLineItem, { type: 'whatsapp' }>[]; total: number } {
  const lines: Extract<InvoiceLineItem, { type: 'whatsapp' }>[] = []
  for (const c of counts) {
    if (!(c.category in settings.rates) || c.messages <= 0) continue
    const category = c.category as WhatsappCategory
    const rate = settings.rates[category] * (1 + settings.markupPercent / 100)
    lines.push({
      type: 'whatsapp',
      category,
      label: WHATSAPP_CATEGORY_LABEL[category],
      count: c.messages,
      rate: Math.round(rate * 10000) / 10000,
      amount: round2(c.messages * rate),
    })
  }
  return { lines, total: round2(lines.reduce((s, l) => s + l.amount, 0)) }
}

/** Counts of billable, not-yet-invoiced messages for a creator, up to `cutoff`. Changes nothing. */
export async function previewWhatsappUsage(supabase: SupabaseClient, creatorId: string, cutoff: Date) {
  const { data, error } = await supabase.rpc('preview_whatsapp_usage', { input_creator_id: creatorId, input_cutoff: cutoff.toISOString() })
  if (error) throw error
  return ((data || []) as { category: string; messages: number | string }[]).map(r => ({ category: r.category, messages: Number(r.messages) }))
}