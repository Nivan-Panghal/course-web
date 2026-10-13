// src/lib/workshop-certificate.ts
//
// Issues a "Certificate of Participation" for ONE workshop attendee.
// Workshop certificates only: course certificates keep using issueCertificate()
// in lib/certificate.ts. This file reuses its PDF drawing, but stores the result
// in its own table (workshop_certificates) so the two never mix.
//
// Safe to call twice for the same registration: the existing certificate is
// returned unless the attendee's name changed.

import type { SupabaseClient } from '@supabase/supabase-js'
import { generateCertificatePDF, type CertTemplate } from './certificate'
import { formatWorkshopDuration } from './workshops'
import { DEFAULT_WORKSHOP_CERT_TEMPLATE, isWorkshopCertTemplate } from './workshop-certificate-options'

export type WorkshopForCertificate = {
  id: string
  title: string
  date_time: string
  duration_minutes: number | null
  host_name: string | null
  instructor_title: string | null
  brand_name: string | null
  brand_logo_url: string | null
  certificate_template: string | null
  certificate_message: string | null
  certificate_signature_url: string | null
}

export async function issueWorkshopCertificate(
  supabase: SupabaseClient,
  params: {
    workshop: WorkshopForCertificate
    registration: { id: string; name: string }
  },
): Promise<{ certificateId: string; pdfUrl: string }> {
  const { workshop, registration } = params
  const attendeeName = registration.name.trim()

  const { data: existing } = await supabase
    .from('workshop_certificates')
    .select('certificate_id, pdf_url, attendee_name')
    .eq('registration_id', registration.id)
    .maybeSingle()

  if (existing?.certificate_id && existing.attendee_name === attendeeName) {
    return { certificateId: existing.certificate_id, pdfUrl: existing.pdf_url }
  }

  const certId =
    existing?.certificate_id ||
    `WS-${new Date().getFullYear()}-${Math.floor(Math.random() * 100_000_000).toString().padStart(8, '0')}`
  const issuedAt = new Date()
  const template = (isWorkshopCertTemplate(workshop.certificate_template)
    ? workshop.certificate_template
    : DEFAULT_WORKSHOP_CERT_TEMPLATE) as CertTemplate
  const issuer = (workshop.brand_name || workshop.host_name || 'Kurso').trim()

  const heldOn = new Date(workshop.date_time).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata',
  })
  const length = workshop.duration_minutes ? ` · ${formatWorkshopDuration(workshop.duration_minutes)}` : ''

  const pdfBytes = await generateCertificatePDF({
    kind: 'workshop',
    studentName: attendeeName,
    courseName: workshop.title,
    creatorName: issuer,
    certificateId: certId,
    issuedAt,
    template,
    customMessage: workshop.certificate_message?.trim() || undefined,
    courseDuration: `Held on ${heldOn}${length}`,
    instructorName: workshop.host_name || undefined,
    instructorTitle: workshop.instructor_title || undefined,
    logoUrl: workshop.brand_logo_url || undefined,
    signatureUrl: workshop.certificate_signature_url || undefined,
    verificationUrl: `${process.env.NEXT_PUBLIC_SITE_URL || 'https://kurso.in'}/certificate/${certId}`,
  })

  const storagePath = `workshops/${workshop.id}/${registration.id}.pdf`
  const { error: uploadError } = await supabase.storage
    .from('certificates')
    .upload(storagePath, pdfBytes, { contentType: 'application/pdf', upsert: true })
  if (uploadError) throw new Error(`Certificate upload failed: ${uploadError.message}`)

  const { data: { publicUrl } } = supabase.storage.from('certificates').getPublicUrl(storagePath)

  if (existing?.certificate_id) {
    const { error } = await supabase
      .from('workshop_certificates')
      .update({ attendee_name: attendeeName, workshop_title: workshop.title, creator_name: issuer, issued_at: issuedAt.toISOString(), pdf_url: publicUrl })
      .eq('certificate_id', existing.certificate_id)
    if (error) throw new Error(`Certificate update failed: ${error.message}`)
  } else {
    const { error } = await supabase.from('workshop_certificates').insert({
      certificate_id: certId,
      workshop_id: workshop.id,
      registration_id: registration.id,
      attendee_name: attendeeName,
      workshop_title: workshop.title,
      creator_name: issuer,
      issued_at: issuedAt.toISOString(),
      pdf_url: publicUrl,
    })
    if (error) throw new Error(`Certificate record failed: ${error.message}`)
  }

  // The file path is reused when a name changes, so add a version to dodge cached copies.
  return { certificateId: certId, pdfUrl: `${publicUrl}?v=${issuedAt.getTime()}` }
}