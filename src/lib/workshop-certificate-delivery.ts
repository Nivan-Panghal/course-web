// src/lib/workshop-certificate-delivery.ts
//
// Sends an issued workshop certificate to the attendee:
//   1. Telegram (if they linked their chat), as a PDF file
//   2. Email (if they gave one), with the PDF attached
// WhatsApp is not used for certificates yet.
// Workshop certificates only. Never throws: it reports what worked.

import type { SupabaseClient } from '@supabase/supabase-js'
import { escapeHtml, sendLoggedEmail } from './email'
import { getWorkshopChannels } from './workshop-channels'

export type DeliveryResult = { telegram: boolean; email: boolean }

const SITE = () => (process.env.NEXT_PUBLIC_SITE_URL || 'https://kurso.in').replace(/\/$/, '')

async function sendOnTelegram(chatId: string | number, pdf: Uint8Array, fileName: string, caption: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) {
    console.warn('[workshop-certificate-delivery] TELEGRAM_BOT_TOKEN missing, skipping Telegram')
    return false
  }
  try {
    const form = new FormData()
    form.append('chat_id', String(chatId))
    form.append('caption', caption.slice(0, 1000))
    form.append('document', new Blob([pdf as BlobPart], { type: 'application/pdf' }), fileName)
    const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: form })
    if (!res.ok) {
      console.error('[workshop-certificate-delivery] Telegram rejected the file:', res.status, await res.text().catch(() => ''))
      return false
    }
    return true
  } catch (err) {
    console.error('[workshop-certificate-delivery] Telegram failed:', err)
    return false
  }
}

export async function deliverWorkshopCertificate(
  supabase: SupabaseClient,
  params: {
    creatorId: string
    workshopId?: string
    workshopTitle: string
    registration: { id: string; name: string; email: string | null; telegram_chat_id: string | number | null }
    certificate: { certificateId: string; pdfUrl: string; pdfBytes?: Uint8Array }
  },
): Promise<DeliveryResult> {
  const { creatorId, workshopId, workshopTitle, registration, certificate } = params
  const result: DeliveryResult = { telegram: false, email: false }

  // The creator can switch Telegram off for this workshop. Email is always on.
  // If the lookup fails, Telegram counts as ON (see workshop-channels.ts).
  const channels = workshopId ? await getWorkshopChannels(supabase, workshopId) : { whatsapp: true, telegram: true }
  const useTelegram = !!registration.telegram_chat_id && channels.telegram
  if (!useTelegram && !registration.email) return result

  // Fresh PDFs come with their bytes. For a re-send, download the saved file.
  let bytes = certificate.pdfBytes
  if (!bytes) {
    try {
      const res = await fetch(certificate.pdfUrl)
      if (res.ok) bytes = new Uint8Array(await res.arrayBuffer())
    } catch (err) {
      console.error('[workshop-certificate-delivery] could not read saved PDF:', err)
    }
  }
  if (!bytes) return result

  const verifyUrl = `${SITE()}/certificate/${certificate.certificateId}`
  const safeName = registration.name.replace(/[^\p{L}\p{N} _-]/gu, '').trim().replace(/\s+/g, '-') || 'Attendee'
  const fileName = `Certificate-${safeName}.pdf`

  const [telegram, email] = await Promise.all([
    useTelegram
      ? sendOnTelegram(
          registration.telegram_chat_id!,
          bytes,
          fileName,
          `🎓 Congratulations ${registration.name}! Here is your certificate for “${workshopTitle}”.\n\nAnyone can check it is real here:\n${verifyUrl}`,
        )
      : Promise.resolve(false),
    registration.email
      ? sendLoggedEmail({
          supabase,
          creatorId,
          emailType: 'workshop_certificate',
          to: registration.email,
          subject: `Your certificate for ${workshopTitle}`,
          html: `
            <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1f2937;line-height:1.6">
              <h2 style="margin:0 0 12px">Congratulations, ${escapeHtml(registration.name)}!</h2>
              <p>Thank you for joining <strong>${escapeHtml(workshopTitle)}</strong>. Your certificate is attached to this email as a PDF.</p>
              <p>You can also open it online, and anyone can use this link to check that it is real:<br>
                <a href="${verifyUrl}">${verifyUrl}</a></p>
            </div>`,
          attachments: [{ filename: fileName, content: Buffer.from(bytes).toString('base64') }],
          metadata: { workshop_registration_id: registration.id, certificate_id: certificate.certificateId },
        }).then(r => !!r.sent)
      : Promise.resolve(false),
  ])

  result.telegram = telegram
  result.email = email

  const now = new Date().toISOString()
  if (telegram || email) {
    await supabase
      .from('workshop_certificates')
      .update({
        ...(telegram ? { telegram_sent_at: now } : {}),
        ...(email ? { email_sent_at: now } : {}),
      })
      .eq('certificate_id', certificate.certificateId)
  }
  return result
}