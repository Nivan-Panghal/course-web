/**
 * /api/workshops/certificates   (WORKSHOP certificates only)
 *
 *   GET  ?workshopId=...   → certificate settings + the confirmed attendees
 *   POST { workshopId, action: 'attendance', registrationIds, attended }
 *   POST { workshopId, action: 'issue', registrationIds? }
 *
 * Auth: Supabase session of the workshop's creator (Bearer token).
 * Rules:
 *  - Only confirmed registrations can be marked as attended.
 *  - Attendance can be marked once the workshop has started.
 *  - Certificates are issued only to people marked as attended, and only
 *    when the creator has turned certificates on for this workshop.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { issueWorkshopCertificate, type WorkshopForCertificate } from '@/lib/workshop-certificate'

export const maxDuration = 60

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Small batches keep each request fast. The page repeats until nothing is left.
const ISSUE_BATCH = 15
const MAX_IDS = 500

const WORKSHOP_COLUMNS =
  'id, creator_id, title, date_time, duration_minutes, host_name, instructor_title, brand_name, brand_logo_url, certificate_enabled, certificate_template, certificate_message, certificate_signature_url'

async function authorise(req: NextRequest, workshopId: unknown) {
  const token = (req.headers.get('authorization') || '').replace('Bearer ', '').trim()
  if (!token) return { error: NextResponse.json({ error: 'Please log in again.' }, { status: 401 }) }
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token)
  if (authErr || !user) return { error: NextResponse.json({ error: 'Please log in again.' }, { status: 401 }) }

  if (typeof workshopId !== 'string' || !workshopId) {
    return { error: NextResponse.json({ error: 'Workshop is missing.' }, { status: 400 }) }
  }
  const { data: workshop, error } = await supabase
    .from('workshops')
    .select(WORKSHOP_COLUMNS)
    .eq('id', workshopId)
    .eq('creator_id', user.id)
    .maybeSingle()
  if (error) {
    console.error('[workshop-certificates] workshop lookup failed', error.message)
    const setup = /certificate_/.test(error.message)
    return {
      error: NextResponse.json(
        { error: setup ? 'setup_needed' : 'Could not load this workshop.' },
        { status: setup ? 409 : 500 }
      ),
    }
  }
  if (!workshop) return { error: NextResponse.json({ error: 'Workshop not found.' }, { status: 404 }) }
  return { user, workshop }
}

const cleanIds = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, MAX_IDS) : []

// ── GET ────────────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  try {
    const workshopId = req.nextUrl.searchParams.get('workshopId')
    const auth = await authorise(req, workshopId)
    if ('error' in auth && auth.error) return auth.error
    const workshop = auth.workshop!

    const { data: regs, error: regErr } = await supabase
      .from('workshop_registrations')
      .select('id, name, phone, attended')
      .eq('workshop_id', workshop.id)
      .eq('payment_status', 'confirmed')
      .order('created_at', { ascending: true })
    if (regErr) {
      console.error('[workshop-certificates] registrations failed', regErr.message)
      const setup = /attended/.test(regErr.message)
      return NextResponse.json(
        { error: setup ? 'setup_needed' : 'Could not load attendees.' },
        { status: setup ? 409 : 500 }
      )
    }

    const { data: certs, error: certErr } = await supabase
      .from('workshop_certificates')
      .select('registration_id, certificate_id, pdf_url')
      .eq('workshop_id', workshop.id)
    if (certErr) {
      console.error('[workshop-certificates] certificates failed', certErr.message)
      return NextResponse.json({ error: 'setup_needed' }, { status: 409 })
    }
    const byReg = new Map((certs || []).map(c => [c.registration_id, c]))

    return NextResponse.json({
      workshop: {
        id: workshop.id,
        title: workshop.title,
        startsAt: workshop.date_time,
        started: new Date(workshop.date_time).getTime() <= Date.now(),
        certificateEnabled: !!workshop.certificate_enabled,
        template: workshop.certificate_template || 'classic',
        message: workshop.certificate_message || '',
        signatureUrl: workshop.certificate_signature_url || '',
      },
      attendees: (regs || []).map(r => ({
        id: r.id,
        name: r.name,
        phoneEnd: String(r.phone || '').slice(-4),
        attended: !!r.attended,
        certificate: byReg.get(r.id)
          ? { id: byReg.get(r.id)!.certificate_id, url: byReg.get(r.id)!.pdf_url }
          : null,
      })),
    })
  } catch (err: any) {
    console.error('[workshop-certificates] GET', err?.message)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}

// ── POST ───────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const auth = await authorise(req, body?.workshopId)
    if ('error' in auth && auth.error) return auth.error
    const workshop = auth.workshop!
    const ids = cleanIds(body?.registrationIds)

    // Mark who attended
    if (body?.action === 'attendance') {
      if (new Date(workshop.date_time).getTime() > Date.now()) {
        return NextResponse.json({ error: 'You can mark attendance once the workshop has started.' }, { status: 400 })
      }
      if (ids.length === 0) return NextResponse.json({ error: 'Pick at least one person.' }, { status: 400 })
      const attended = body?.attended === true
      const { error } = await supabase
        .from('workshop_registrations')
        .update({ attended, attended_at: attended ? new Date().toISOString() : null })
        .eq('workshop_id', workshop.id)
        .eq('payment_status', 'confirmed')
        .in('id', ids)
      if (error) {
        console.error('[workshop-certificates] attendance failed', error.message)
        return NextResponse.json({ error: 'Could not save attendance. Please try again.' }, { status: 500 })
      }
      return NextResponse.json({ ok: true })
    }

    // Issue certificates
    if (body?.action === 'issue') {
      if (!workshop.certificate_enabled) {
        return NextResponse.json({ error: 'Turn on certificates for this workshop first.' }, { status: 400 })
      }

      let query = supabase
        .from('workshop_registrations')
        .select('id, name')
        .eq('workshop_id', workshop.id)
        .eq('payment_status', 'confirmed')
        .eq('attended', true)
      if (ids.length) query = query.in('id', ids)
      const { data: attendees, error: attErr } = await query
      if (attErr) {
        console.error('[workshop-certificates] attendee lookup failed', attErr.message)
        return NextResponse.json({ error: 'Could not load attendees.' }, { status: 500 })
      }

      const { data: already } = await supabase
        .from('workshop_certificates')
        .select('registration_id, attendee_name')
        .eq('workshop_id', workshop.id)
      const done = new Map((already || []).map(c => [c.registration_id, c.attendee_name]))
      // Skip people who already have a certificate with the same name.
      const todo = (attendees || []).filter(a => done.get(a.id) !== a.name.trim())

      const batch = todo.slice(0, ISSUE_BATCH)
      let issued = 0
      const failed: { id: string; name: string }[] = []
      for (const person of batch) {
        try {
          await issueWorkshopCertificate(supabase, {
            workshop: workshop as unknown as WorkshopForCertificate,
            registration: { id: person.id, name: person.name },
          })
          issued++
        } catch (e: any) {
          console.error('[workshop-certificates] issue failed', person.id, e?.message)
          failed.push({ id: person.id, name: person.name })
        }
      }
      return NextResponse.json({ issued, failed, left: Math.max(0, todo.length - batch.length) })
    }

    return NextResponse.json({ error: 'Unknown action.' }, { status: 400 })
  } catch (err: any) {
    console.error('[workshop-certificates] POST', err?.message)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}