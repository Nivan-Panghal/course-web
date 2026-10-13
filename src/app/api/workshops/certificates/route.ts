/**
 * /api/workshops/certificates   (WORKSHOP certificates only)
 *
 *   GET  ?workshopId=...   → certificate settings + confirmed registrations
 *   POST { workshopId, registrationIds, resend? }
 *        → makes a certificate for each chosen person and sends it
 *          on Telegram and by email.
 *
 * Auth: Supabase session of the workshop's creator (Bearer token).
 * Rules:
 *  - Certificates must be turned on for the workshop.
 *  - The workshop must have started.
 *  - Only confirmed registrations can get a certificate.
 *  - People the creator issues a certificate to count as attended.
 *  - At most 10 people per request (the page sends several requests).
 *  - Someone who already received theirs is skipped, unless resend is true.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { issueWorkshopCertificate, type WorkshopForCertificate } from '@/lib/workshop-certificate'
import { deliverWorkshopCertificate } from '@/lib/workshop-certificate-delivery'

export const maxDuration = 60

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Small batches keep each request fast. The page sends one request per group.
const MAX_PER_REQUEST = 10

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
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : []

// ── GET ────────────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  try {
    const workshopId = req.nextUrl.searchParams.get('workshopId')
    const auth = await authorise(req, workshopId)
    if ('error' in auth && auth.error) return auth.error
    const workshop = auth.workshop!

    const { data: regs, error: regErr } = await supabase
      .from('workshop_registrations')
      .select('id, name, phone, email, telegram_chat_id, attended')
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
      .select('registration_id, certificate_id, pdf_url, telegram_sent_at, email_sent_at')
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
        hasTelegram: !!r.telegram_chat_id,
        hasEmail: !!r.email,
        certificate: byReg.get(r.id)
          ? {
              id: byReg.get(r.id)!.certificate_id,
              url: byReg.get(r.id)!.pdf_url,
              sentOnTelegram: !!byReg.get(r.id)!.telegram_sent_at,
              sentByEmail: !!byReg.get(r.id)!.email_sent_at,
            }
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

    if (!workshop.certificate_enabled) {
      return NextResponse.json({ error: 'Turn on certificates for this workshop first.' }, { status: 400 })
    }
    if (new Date(workshop.date_time).getTime() > Date.now()) {
      return NextResponse.json({ error: 'You can issue certificates once the workshop has started.' }, { status: 400 })
    }
    const ids = cleanIds(body?.registrationIds)
    if (ids.length === 0) return NextResponse.json({ error: 'Pick at least one person.' }, { status: 400 })
    if (ids.length > MAX_PER_REQUEST) {
      return NextResponse.json({ error: `Send at most ${MAX_PER_REQUEST} people at a time.` }, { status: 400 })
    }
    const resend = body?.resend === true

    const { data: people, error: peopleErr } = await supabase
      .from('workshop_registrations')
      .select('id, name, email, telegram_chat_id')
      .eq('workshop_id', workshop.id)
      .eq('payment_status', 'confirmed')
      .in('id', ids)
    if (peopleErr) {
      console.error('[workshop-certificates] lookup failed', peopleErr.message)
      return NextResponse.json({ error: 'Could not load these people.' }, { status: 500 })
    }

    const { data: existing } = await supabase
      .from('workshop_certificates')
      .select('registration_id, attendee_name, telegram_sent_at, email_sent_at')
      .eq('workshop_id', workshop.id)
      .in('registration_id', ids)
    const had = new Map((existing || []).map(c => [c.registration_id, c]))

    type Outcome = 'sent' | 'already_sent' | 'no_contact' | 'delivery_failed' | 'failed'
    const results: { id: string; name: string; outcome: Outcome; telegram: boolean; email: boolean }[] = []

    for (const person of people || []) {
      const row = { id: person.id, name: person.name, telegram: false, email: false }
      try {
        const prior = had.get(person.id)
        const alreadyDelivered = !!prior && (prior.telegram_sent_at || prior.email_sent_at) && prior.attendee_name === person.name.trim()
        if (alreadyDelivered && !resend) {
          results.push({ ...row, outcome: 'already_sent' })
          continue
        }

        // Issuing a certificate means this person attended.
        await supabase
          .from('workshop_registrations')
          .update({ attended: true, attended_at: new Date().toISOString() })
          .eq('id', person.id)

        const certificate = await issueWorkshopCertificate(supabase, {
          workshop: workshop as unknown as WorkshopForCertificate,
          registration: { id: person.id, name: person.name },
        })

        if (!person.telegram_chat_id && !person.email) {
          results.push({ ...row, outcome: 'no_contact' })
          continue
        }

        const sent = await deliverWorkshopCertificate(supabase, {
          creatorId: workshop.creator_id,
          workshopTitle: workshop.title,
          registration: person,
          certificate,
        })
        results.push({ ...row, ...sent, outcome: sent.telegram || sent.email ? 'sent' : 'delivery_failed' })
      } catch (e: any) {
        console.error('[workshop-certificates] issue failed', person.id, e?.message)
        results.push({ ...row, outcome: 'failed' })
      }
    }

    return NextResponse.json({ results })
  } catch (err: any) {
    console.error('[workshop-certificates] POST', err?.message)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}