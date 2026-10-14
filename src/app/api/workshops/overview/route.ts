/**
 * GET /api/workshops/overview
 * The creator's workshops and every registration, in the shape the shared
 * dashboard pages need (Students, Revenue, Analytics, Broadcast, Overview).
 * Auth: Bearer token of the creator. Read only.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import type { RegistrationRow, WorkshopOverview, WorkshopRow } from '@/lib/workshop-overview'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const PAGE = 1000
const MAX_ROWS = 10000

export async function GET(req: NextRequest) {
  try {
    const token = (req.headers.get('authorization') || '').replace('Bearer ', '').trim()
    if (!token) return NextResponse.json({ error: 'Please log in again.' }, { status: 401 })
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token)
    if (authErr || !user) return NextResponse.json({ error: 'Please log in again.' }, { status: 401 })

    const { data: ws, error: wsErr } = await supabase
      .from('workshops')
      .select('id, title, slug, status, date_time, price, capacity, duration_minutes')
      .eq('creator_id', user.id)
      .order('date_time', { ascending: false })
    if (wsErr) {
      console.error('[workshop-overview] workshops failed', wsErr.message)
      return NextResponse.json({ error: 'Could not load your workshops.' }, { status: 500 })
    }

    const workshops: WorkshopRow[] = (ws || []).map(w => ({
      id: w.id,
      title: w.title,
      slug: w.slug,
      status: w.status,
      dateTime: w.date_time,
      price: Number(w.price) || 0,
      capacity: w.capacity ?? null,
      durationMinutes: w.duration_minutes ?? null,
    }))
    if (workshops.length === 0) return NextResponse.json({ workshops, registrations: [] } satisfies WorkshopOverview)

    const ids = workshops.map(w => w.id)
    const priceOf = new Map(workshops.map(w => [w.id, w.price]))

    // Registrations, in pages (the database returns at most 1000 rows per request).
    // "attended" only exists after the certificates SQL has been run, so fall back without it.
    let withAttended = true
    const rows: any[] = []
    for (let from = 0; from < MAX_ROWS; from += PAGE) {
      const columns = `id, workshop_id, name, phone, email, payment_mode, payment_status, amount_paid, telegram_chat_id, referred_by_code_id, created_at${withAttended ? ', attended' : ''}`
      const { data, error } = await supabase
        .from('workshop_registrations')
        .select(columns)
        .in('workshop_id', ids)
        .order('created_at', { ascending: false })
        .range(from, from + PAGE - 1)
      if (error) {
        if (withAttended && /attended/.test(error.message)) { withAttended = false; from -= PAGE; continue }
        console.error('[workshop-overview] registrations failed', error.message)
        return NextResponse.json({ error: 'Could not load registrations.' }, { status: 500 })
      }
      rows.push(...(data || []))
      if (!data || data.length < PAGE) break
    }

    // Certificates are optional: if that table is not there yet, treat it as none.
    const certs = new Map<string, { made: boolean; sent: boolean }>()
    const { data: certRows, error: certErr } = await supabase
      .from('workshop_certificates')
      .select('registration_id, telegram_sent_at, email_sent_at')
      .in('workshop_id', ids)
    if (!certErr) {
      for (const c of certRows || []) certs.set(c.registration_id, { made: true, sent: !!(c.telegram_sent_at || c.email_sent_at) })
    }

    const registrations: RegistrationRow[] = rows.map(r => {
      const confirmed = r.payment_status === 'confirmed'
      const online = Number(r.amount_paid) || 0
      const counted = !confirmed ? 0 : online > 0 ? online : r.payment_mode === 'free' ? 0 : (priceOf.get(r.workshop_id) ?? 0)
      const cert = certs.get(r.id)
      return {
        id: r.id,
        workshopId: r.workshop_id,
        name: r.name,
        phone: r.phone || '',
        email: r.email || null,
        paymentMode: r.payment_mode || '',
        paymentStatus: r.payment_status || '',
        counted,
        attended: !!r.attended,
        hasTelegram: !!r.telegram_chat_id,
        viaReferral: !!r.referred_by_code_id,
        certificateMade: !!cert?.made,
        certificateSent: !!cert?.sent,
        createdAt: r.created_at,
      }
    })

    return NextResponse.json({ workshops, registrations } satisfies WorkshopOverview)
  } catch (err: any) {
    console.error('[workshop-overview] GET', err?.message)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}