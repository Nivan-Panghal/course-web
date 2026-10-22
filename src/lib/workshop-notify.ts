// src/lib/workshop-notify.ts
// One place that tells a registrant "you're in" — used by the free-registration
// route, the creator "Mark Paid" route, and the payment webhook.
// Sends WhatsApp always, and Telegram too if the registrant linked their chat.
import { createClient } from '@supabase/supabase-js'
import { formatWorkshopDateTime } from '@/lib/workshops'
import { getOrCreateReferralLink } from '@/lib/referrals'
import { escapeHtml, sendLoggedEmail } from '@/lib/email'
import { getWorkshopChannels } from '@/lib/workshop-channels'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function postToBot(
  baseUrl: string | undefined,
  path: string,
  payload: Record<string, unknown>,
  label: string
): Promise<boolean> {
  const secret = process.env.INTERNAL_BOT_SECRET
  if (!baseUrl || !secret) {
    console.warn(`[workshop-notify] ${label}: bot URL/secret not configured, skipping`)
    return false
  }
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      console.error(`[workshop-notify] ${label}: bot rejected send:`, res.status, await res.text().catch(() => ''))
      return false
    }
    return true
  } catch (err) {
    console.error(`[workshop-notify] ${label}: failed to reach bot:`, err)
    return false
  }
}

/**
 * The confirmation email: sent to every confirmed registration that has an email address,
 * whatever the payment type (free, UPI or online) and whichever channels the creator switched
 * on. Email is always on. Never throws.
 */
async function sendConfirmationEmail(p: {
  registrationId: string
  creatorId: string | null
  to: string | null
  title: string
  dateTimeLabel: string
  zoomLink: string | null
}): Promise<boolean> {
  try {
    if (!p.to) return false
    const link = p.zoomLink && /^https?:\/\//i.test(p.zoomLink) ? p.zoomLink : null
    const result = await sendLoggedEmail({
      supabase: supabaseAdmin,
      emailType: 'workshop_confirmation_details',
      to: p.to,
      subject: `You're registered: ${p.title}`,
      creatorId: p.creatorId,
      metadata: { workshop_registration_id: p.registrationId },
      html: `
        <div style="font-family:Inter,Arial,sans-serif;line-height:1.5;color:#111;max-width:520px">
          <h2 style="margin:0 0 12px">You're in!</h2>
          <p style="margin:0 0 12px">Your spot for <strong>${escapeHtml(p.title)}</strong> is confirmed.</p>
          <p style="margin:0 0 12px"><strong>When:</strong> ${escapeHtml(p.dateTimeLabel)} (IST)</p>
          ${link
            ? `<p style="margin:0 0 16px"><a href="${escapeHtml(link)}" style="display:inline-block;background:#f79514;color:#fff;padding:10px 16px;border-radius:10px;text-decoration:none">Join the session</a></p>`
            : '<p style="margin:0 0 16px">The joining link will be sent to you before the session starts.</p>'}
          <p style="margin:0;color:#6b7280;font-size:13px">We will also email you a reminder before it starts.</p>
        </div>`,
    })
    return !!result.sent
  } catch (err) {
    console.error('[workshop-notify] confirmation email failed for', p.registrationId, err)
    return false
  }
}

export async function notifyWorkshopConfirmed(
  registrationId: string
): Promise<{ whatsapp: boolean; telegram: boolean; email: boolean }> {
  const { data: reg, error } = await supabaseAdmin
    .from('workshop_registrations')
    .select('id, workshop_id, phone, email, telegram_chat_id, workshops!inner(title, date_time, zoom_link, creator_id)')
    .eq('id', registrationId)
    .maybeSingle()

  const rawWorkshop = (reg as any)?.workshops
  const workshop = Array.isArray(rawWorkshop) ? rawWorkshop[0] : rawWorkshop
  if (error || !reg || !workshop) {
    console.error('[workshop-notify] registration lookup failed for', registrationId, error)
    return { whatsapp: false, telegram: false, email: false }
  }

  const dateTimeLabel = formatWorkshopDateTime(workshop.date_time)

  // Mint the student's referral link now that they're confirmed. Best-effort:
  // a failure here must never stop the confirmation message going out.
  let referralLink: string | null = null
  try {
    referralLink = (await getOrCreateReferralLink(supabaseAdmin, registrationId))?.link ?? null
  } catch (err) {
    console.error('[workshop-notify] referral link failed for', registrationId, err)
  }

  // The creator chooses WhatsApp and Telegram per workshop. Email is always on.
  const channels = await getWorkshopChannels(supabaseAdmin, (reg as any).workshop_id)

  const [whatsapp, telegram, email] = await Promise.all([
    channels.whatsapp
      ? postToBot(
          process.env.WHATSAPP_BOT_URL,
          '/internal/send-workshop-confirmation',
          {
            phone: reg.phone,
            workshopTitle: workshop.title,
            dateTimeLabel,
            zoomLink: workshop.zoom_link || 'Link will follow shortly',
            referralLink,
            creatorId: workshop.creator_id,
            workshopId: (reg as any).workshop_id,
          },
          'whatsapp'
        )
      : Promise.resolve(false),
    reg.telegram_chat_id && channels.telegram
      ? postToBot(
          process.env.TELEGRAM_BOT_URL,
          '/internal/send-workshop-message',
          {
            chatId: reg.telegram_chat_id,
            kind: 'confirmation',
            workshopTitle: workshop.title,
            dateTimeLabel,
            zoomLink: workshop.zoom_link || null,
            referralLink,
          },
          'telegram'
        )
      : Promise.resolve(false),
    sendConfirmationEmail({
      registrationId,
      creatorId: workshop.creator_id ?? null,
      to: (reg as any).email ?? null,
      title: workshop.title,
      dateTimeLabel,
      zoomLink: workshop.zoom_link || null,
    }),
  ])

  return { whatsapp, telegram, email }
}