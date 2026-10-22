// src/lib/workshop-channels.ts
//
// Which channels a creator switched on for a workshop. Email is always on and is not listed.
//
// Reads the notify_whatsapp / notify_telegram columns (billing-phase3.sql). If the columns do
// not exist yet, or anything goes wrong, both count as ON, which is how workshops behaved
// before the switches existed. A failed lookup can never silence a student message.
import type { SupabaseClient } from '@supabase/supabase-js'

export type WorkshopChannels = { whatsapp: boolean; telegram: boolean }

export const DEFAULT_WORKSHOP_CHANNELS: WorkshopChannels = { whatsapp: true, telegram: true }

export async function getWorkshopChannels(supabase: SupabaseClient, workshopId: string): Promise<WorkshopChannels> {
  try {
    const { data, error } = await supabase
      .from('workshops')
      .select('notify_whatsapp, notify_telegram')
      .eq('id', workshopId)
      .maybeSingle()
    if (error || !data) return { ...DEFAULT_WORKSHOP_CHANNELS }
    return { whatsapp: data.notify_whatsapp !== false, telegram: data.notify_telegram !== false }
  } catch {
    return { ...DEFAULT_WORKSHOP_CHANNELS }
  }
}