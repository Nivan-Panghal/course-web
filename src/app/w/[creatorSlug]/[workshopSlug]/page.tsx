// src/app/w/[creatorSlug]/[workshopSlug]/page.tsx
//
// Public workshop landing + registration page (server component).
//
// - zoom_link is intentionally NEVER selected here: it only goes to a CONFIRMED
//   registrant via WhatsApp/Telegram. (Columns are listed explicitly for that reason.)
// - Looks come from the creator's saved theme, font pair, text size and section
//   order (workshops.landing_*), with ?theme=<id> available for previewing.
// - Whether registration is open comes from getWorkshopRegistrationState(), the
//   same function both registration API routes use.
// - Every section with nothing to show renders nothing.

import { cache } from 'react'
import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { createClient } from '@supabase/supabase-js'
import type { Metadata } from 'next'
import Link from 'next/link'
import { Calendar, Clock } from 'lucide-react'
import WorkshopRegisterForm from '@/components/WorkshopRegisterForm'
import WorkshopRegisterBar from '@/components/workshop-page/WorkshopRegisterBar'
import WorkshopReviews from '@/components/workshop-page/WorkshopReviews'
import { loadPublicReviews } from '@/lib/workshop-public-reviews'
import { renderWorkshopSection, type WorkshopPageData } from '@/components/workshop-page/WorkshopSections'
import ContactDetails from '@/components/ContactDetails'
import SocialLinks from '@/components/SocialLinks'
import MetaPixel from '@/components/MetaPixel'
import { getCreatorCheckoutGateway } from '@/lib/gateway-checkout'
import { getLandingTheme } from '@/lib/landing-themes'
import { getBrandVars } from '@/lib/landing-themes/brandVars'
import { getFontPairOverride } from '@/lib/landing-themes/fontPairs'
import { getRenderableContactDetails } from '@/lib/contact-details'
import { getRenderableSocialLinks } from '@/lib/social-links'
import { POLICY_DOC_LABELS, type PolicyDocType } from '@/lib/policyDocs'
import {
  countHeldSpots,
  formatWorkshopDuration,
  getWorkshopRegistrationState,
  registrationClosedMessage,
  workshopEndsAt,
} from '@/lib/workshops'
import {
  getRegisterBarButtonText,
  getRegisterButtonText,
  getRenderableWorkshopSectionEntries,
  normalizeAgenda,
  normalizeWorkshopLandingConfig,
} from '@/lib/workshop-landing-config'
import { cleanCoHosts, cleanFaq, cleanStringList, cleanTestimonials } from '@/lib/workshop-validation'
import {
  buildEventJsonLd,
  discountPercent,
  formatWorkshopDateParts,
  getWorkshopPageVars,
  toJsonLd,
  withAlpha,
} from '@/lib/workshop-page'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Everything the page needs, listed explicitly. NOT zoom_link.
const WORKSHOP_COLUMNS = [
  'id', 'title', 'slug', 'description', 'tagline', 'date_time', 'duration_minutes', 'price', 'original_price',
  'capacity', 'registration_closes_at', 'host_name', 'instructor_title', 'host_image', 'about_creator',
  'co_instructors', 'what_you_will_learn', 'target_audience', 'requirements', 'agenda', 'faq', 'testimonials',
  'language', 'level', 'promo_video_urls', 'promo_video_heading', 'brand_name', 'brand_logo_url', 'cover_image_url',
  'contact_details', 'social_links', 'refund_policy_storage_path', 'terms_storage_path', 'privacy_storage_path',
  'landing_theme', 'landing_font_pair', 'landing_config',
].join(', ')

type RouteParams = { creatorSlug: string; workshopSlug: string }

/** One lookup per request, shared by generateMetadata and the page. */
const loadWorkshop = cache(async (creatorSlug: string, workshopSlug: string) => {
  const { data: creator } = await supabase
    .from('creators')
    .select('id, name, upi_id, upi_display_name, telegram_bot_username')
    .eq('creator_slug', creatorSlug)
    .maybeSingle()
  if (!creator) return null

  const { data: workshop } = await supabase
    .from('workshops')
    .select(WORKSHOP_COLUMNS)
    .eq('creator_id', creator.id)
    .eq('slug', workshopSlug)
    .eq('status', 'published')
    .maybeSingle()
  if (!workshop) return null
  return { creator, workshop: workshop as any }
})

export async function generateMetadata({ params }: { params: Promise<RouteParams> }): Promise<Metadata> {
  const { creatorSlug, workshopSlug } = await params
  const loaded = await loadWorkshop(creatorSlug, workshopSlug)
  if (!loaded) return { title: 'Workshop not found' }
  const { creator, workshop } = loaded

  const brandName = workshop.brand_name || creator.name
  const title = `${workshop.title} — ${brandName}`
  const description = (workshop.tagline || workshop.description || `Join ${workshop.title} by ${workshop.host_name || creator.name}.`).slice(0, 155)
  const image = workshop.cover_image_url || workshop.host_image || workshop.brand_logo_url
  return {
    title,
    description,
    openGraph: { title, description, type: 'website', ...(image ? { images: [{ url: image }] } : {}) },
    twitter: { card: image ? 'summary_large_image' : 'summary', title, description, ...(image ? { images: [image] } : {}) },
  }
}

export default async function WorkshopPage({
  params,
  searchParams,
}: {
  params: Promise<RouteParams>
  searchParams: Promise<{ theme?: string }>
}) {
  const { creatorSlug, workshopSlug } = await params
  const { theme: previewThemeId } = await searchParams

  const loaded = await loadWorkshop(creatorSlug, workshopSlug)
  if (!loaded) notFound()
  const { creator, workshop } = loaded

  // ── Registration state, seats, payments, pixel ──────────────────────────
  const regState = getWorkshopRegistrationState(workshop)
  const open = regState === 'open'

  let spotsLeft: number | null = null
  if (workshop.capacity != null) {
    const held = await countHeldSpots(supabase, workshop.id)
    spotsLeft = Math.max(0, workshop.capacity - held)
  }

  // Only matters for paid workshops. A misconfigured/undecryptable gateway
  // must not take the whole page down — it just disables the online option.
  let gatewayEnabled = false
  if (workshop.price > 0 && open) {
    try {
      gatewayEnabled = !!(await getCreatorCheckoutGateway(creator.id))
    } catch (err) {
      console.error('[workshop page] gateway lookup failed for creator', creator.id, err)
    }
  }

  // Creator's Meta Pixel (optional). A settings problem must never take the page down.
  let metaPixelId: string | null = null
  try {
    const { data: metaSettings } = await supabase
      .from('creator_meta_settings')
      .select('pixel_id')
      .eq('creator_id', creator.id)
      .maybeSingle()
    metaPixelId = metaSettings?.pixel_id ?? null
  } catch (err) {
    console.error('[workshop page] meta pixel lookup failed for creator', creator.id, err)
  }

  // ── Look and feel ───────────────────────────────────────────────────────
  const theme = getLandingTheme(previewThemeId || workshop.landing_theme)
  const c = theme.colors
  const fontOverride = getFontPairOverride(workshop.landing_font_pair)
  const fonts = fontOverride
    ? { heading: fontOverride.heading, body: fontOverride.body, googleFontsImportUrl: fontOverride.googleFontsImportUrl }
    : theme.fonts
  const config = normalizeWorkshopLandingConfig(workshop.landing_config)
  const rootStyle = { ...getBrandVars(c), ...getWorkshopPageVars(c), background: c.bg, color: c.textPrimary, fontFamily: fonts.body }

  // ── Content ─────────────────────────────────────────────────────────────
  const brandName: string = workshop.brand_name || creator.name
  const hostName: string = workshop.host_name || creator.name
  const startsAt = formatWorkshopDateParts(workshop.date_time)
  const endIso = workshopEndsAt(workshop.date_time, workshop.duration_minutes).toISOString()
  const startsInFuture = new Date(workshop.date_time).getTime() > Date.now()
  const percentOff = discountPercent(workshop.price, workshop.original_price)

  // Attendee reviews (empty if none yet, or if reviews are not set up).
  const publicReviews = await loadPublicReviews(supabase, workshop.id)

  const data: WorkshopPageData = {
    startsAt,
    durationMinutes: workshop.duration_minutes ?? null,
    languages: Array.isArray(workshop.language) ? workshop.language.filter((l: unknown): l is string => typeof l === 'string') : [],
    level: workshop.level || null,
    videoUrls: cleanStringList(workshop.promo_video_urls, 3, 300),
    videoHeading: workshop.promo_video_heading || null,
    takeaways: cleanStringList(workshop.what_you_will_learn, 6, 120),
    agenda: normalizeAgenda(workshop.agenda),
    hostName,
    hostTitle: workshop.instructor_title || null,
    hostImage: workshop.host_image || null,
    aboutHost: workshop.about_creator || null,
    coHosts: cleanCoHosts(workshop.co_instructors),
    audience: cleanStringList(workshop.target_audience),
    bring: cleanStringList(workshop.requirements),
    testimonials: cleanTestimonials(workshop.testimonials),
    faq: cleanFaq(workshop.faq),
  }

  const contacts = getRenderableContactDetails(workshop.contact_details)
  const belowDescriptionContacts = contacts.filter(e => e.show_below_description)
  const footerContacts = contacts.filter(e => e.show_in_footer)
  const socialLinks = getRenderableSocialLinks(workshop.social_links)
  const basePath = `/w/${creatorSlug}/${workshopSlug}`
  const policyLinks = (['refund', 'terms', 'privacy'] as PolicyDocType[])
    .filter(t => (t === 'refund' ? workshop.refund_policy_storage_path : t === 'terms' ? workshop.terms_storage_path : workshop.privacy_storage_path))
    .map(t => ({ href: `${basePath}/policy/${t}`, label: POLICY_DOC_LABELS[t] }))

  // Sections between the pinned hero and register bar, in the creator's order.
  const sections = getRenderableWorkshopSectionEntries(config).filter(s => s.type !== 'hero' && s.type !== 'finalCta')
  const finalCtaOn = config.sections.some(s => s.type === 'finalCta' && s.enabled)
  const showCountdown = config.showCountdown && open && startsInFuture
  const showSeats = config.showSeatsLeft && spotsLeft != null

  // Structured data for Google (event with date, price and availability).
  const h = await headers()
  const host = h.get('x-forwarded-host') || h.get('host')
  const origin = host ? `${h.get('x-forwarded-proto') || 'https'}://${host}` : null
  const jsonLd = buildEventJsonLd({
    name: workshop.title,
    description: workshop.tagline || workshop.description || workshop.title,
    startIso: workshop.date_time,
    endIso,
    url: origin ? `${origin}${basePath}` : null,
    images: [workshop.cover_image_url, workshop.host_image].filter(Boolean),
    organizer: hostName,
    price: workshop.price,
    seatsLeft: spotsLeft,
    open,
  })

  const priceLabel = workshop.price > 0 ? `₹${workshop.price.toLocaleString('en-IN')}` : 'Free'

  return (
    <div className="min-h-screen ws-root" data-brand-scope data-size={config.textSize} style={rootStyle}>
      <style>{`
        @import url('${fonts.googleFontsImportUrl}');
        html { scroll-behavior: smooth; }
        .ws-heading { font-family: ${fonts.heading}; }
        .ws-root { --ws-base: 1rem; --ws-small: 0.9375rem; }
        .ws-root[data-size="large"] { --ws-base: 1.1875rem; --ws-small: 1.0625rem; }
        .ws-body { font-size: var(--ws-base); line-height: 1.7; }
        .ws-small { font-size: var(--ws-small); line-height: 1.6; }
        .ws-field::placeholder { color: var(--ws-muted); opacity: 1; }
        .ws-faq summary::-webkit-details-marker { display: none; }
        .ws-faq-icon::before { content: '+'; font-size: 1.5rem; line-height: 1; }
        .ws-faq[open] .ws-faq-icon::before { content: '\\2212'; }
      `}</style>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: toJsonLd(jsonLd) }} />
      {metaPixelId && <MetaPixel pixelId={metaPixelId} />}

      {/* Top bar */}
      <header className="sticky top-0 z-30 px-4 md:px-6 py-3"
        style={{ background: c.navBg, borderBottom: `1px solid ${c.navBorder}`, backdropFilter: 'blur(12px)' }}>
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5 min-w-0">
            {workshop.brand_logo_url ? (
              <img src={workshop.brand_logo_url} alt={brandName} className="h-8 max-w-[140px] object-contain" />
            ) : (
              <span className="w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold text-white shrink-0" style={{ background: c.accentGradient }}>
                {brandName.charAt(0).toUpperCase()}
              </span>
            )}
            <span className="font-semibold truncate" style={{ color: c.textPrimary }}>{brandName}</span>
          </div>
          {open && (
            <a href="#register" className="shrink-0 px-5 py-2 rounded-xl text-sm font-semibold text-white violet-gradient hover:opacity-90">
              {getRegisterButtonText(config)}
            </a>
          )}
        </div>
      </header>

      <div className="relative">
        {/* Cover image or soft glow behind the top of the page */}
        {workshop.cover_image_url ? (
          <div className="absolute inset-x-0 top-0 h-[34rem] overflow-hidden" aria-hidden>
            <img src={workshop.cover_image_url} alt="" className="w-full h-full object-cover" />
            <div className="absolute inset-0" style={{ background: `linear-gradient(180deg, ${withAlpha(c.bg, 0.62)} 0%, ${withAlpha(c.bg, 0.9)} 55%, ${c.bg} 100%)` }} />
          </div>
        ) : (
          <div className="absolute inset-x-0 top-0 h-[30rem]" aria-hidden
            style={{ background: `radial-gradient(60% 70% at 50% 0%, ${c.heroGlowRgba}, transparent)` }} />
        )}

        <div className="relative max-w-6xl mx-auto px-4 md:px-6 pt-10 md:pt-16 pb-16 grid gap-10 lg:grid-cols-[minmax(0,1fr)_390px]">
          {/* Hero */}
          <div className="min-w-0 lg:col-start-1 lg:row-start-1">
            <div className="flex flex-wrap items-center gap-2 mb-5">
              <span className="ws-small font-semibold px-3 py-1 rounded-full" style={{ background: c.accentSoft, border: `1px solid ${c.accentBorder}`, color: c.accentText }}>
                Live workshop
              </span>
              <span className="ws-small inline-flex items-center gap-1.5 px-3 py-1 rounded-full" style={{ background: c.pillBg, color: c.textSecondary }}>
                <Calendar className="w-4 h-4" /> {startsAt.date}
              </span>
              <span className="ws-small inline-flex items-center gap-1.5 px-3 py-1 rounded-full" style={{ background: c.pillBg, color: c.textSecondary }}>
                <Clock className="w-4 h-4" /> {startsAt.time} IST{workshop.duration_minutes ? ` · ${formatWorkshopDuration(workshop.duration_minutes)}` : ''}
              </span>
            </div>

            <h1 className="ws-heading text-3xl md:text-5xl font-bold leading-tight mb-4" style={{ color: c.textPrimary }}>{workshop.title}</h1>
            {workshop.tagline && <p className="text-lg md:text-xl mb-6" style={{ color: 'var(--ws-secondary)', lineHeight: 1.5 }}>{workshop.tagline}</p>}


            {!open && (
              <p className="ws-body font-semibold inline-block px-4 py-2 rounded-xl" style={{ background: c.accentSoft, border: `1px solid ${c.accentBorder}`, color: c.accentText }}>
                {registrationClosedMessage(regState)}
              </p>
            )}
          </div>

          {/* Register card (second on phones, sticky on the right on large screens) */}
          <aside id="register" className="lg:col-start-2 lg:row-start-1 lg:row-span-2 lg:self-start lg:sticky lg:top-24" style={{ scrollMarginTop: '5rem' }}>
            <div className="p-6 md:p-7 rounded-2xl" style={{ background: c.cardBg, border: `1px solid ${c.accentBorder}`, boxShadow: `0 20px 60px -20px ${c.accentGradientShadow}` }}>
              <div className="flex items-baseline flex-wrap gap-x-3 gap-y-1 mb-1">
                <span className="ws-heading text-3xl font-bold" style={{ color: c.textPrimary }}>{priceLabel}</span>
                {workshop.price > 0 && workshop.original_price > workshop.price && (
                  <span className="ws-body line-through" style={{ color: 'var(--ws-muted)' }}>₹{workshop.original_price.toLocaleString('en-IN')}</span>
                )}
                {percentOff != null && (
                  <span className="ws-small font-semibold px-2 py-0.5 rounded-full" style={{ background: c.accentSoft, color: c.accentText }}>{percentOff}% off</span>
                )}
              </div>
              {showSeats && (
                <p className="ws-small font-medium mb-4" style={{ color: spotsLeft === 0 ? 'var(--ws-danger)' : 'var(--ws-muted)' }}>
                  {spotsLeft === 0 ? 'Fully booked' : `${spotsLeft} seat${spotsLeft === 1 ? '' : 's'} left`}
                </p>
              )}
              {!showSeats && <div className="mb-4" />}

              {open ? (
                <WorkshopRegisterForm
                  workshopId={workshop.id}
                  workshopTitle={workshop.title}
                  price={workshop.price}
                  isFull={spotsLeft === 0}
                  upiId={creator.upi_id}
                  upiDisplayName={creator.upi_display_name || creator.name}
                  gatewayEnabled={gatewayEnabled}
                  telegramBotUsername={creator.telegram_bot_username || null}
                />
              ) : (
                <div className="p-4 rounded-xl ws-body text-center" style={{ background: c.pillBg, color: 'var(--ws-secondary)' }}>
                  {registrationClosedMessage(regState as 'closed' | 'ended')}
                </div>
              )}
            </div>
          </aside>

          {/* Sections */}
          <div className="min-w-0 lg:col-start-1 lg:row-start-2">
            {(workshop.description || belowDescriptionContacts.length > 0) && (
              <section className="mb-12 md:mb-14">
                {workshop.description && (
                  <>
                    <h2 className="ws-heading text-2xl md:text-3xl font-bold mb-4" style={{ color: c.textPrimary }}>About this workshop</h2>
                    <p className="ws-body whitespace-pre-line" style={{ color: 'var(--ws-secondary)' }}>{workshop.description}</p>
                  </>
                )}
                <ContactDetails entries={belowDescriptionContacts} variant="block" colors={c} headingFont={fonts.heading} className="mt-6" />
              </section>
            )}
            {sections.map((entry, i) => renderWorkshopSection(entry, c, data, config, `${entry.type}-${entry.customId || i}`))}
            {publicReviews && <WorkshopReviews c={c} reviews={publicReviews} hostName={hostName} />}
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="px-4 md:px-6 py-12" style={{ borderTop: `1px solid ${c.border}`, paddingBottom: open && finalCtaOn ? '8rem' : undefined }}>
        <div className="max-w-6xl mx-auto flex flex-col gap-8">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-8">
            <div className="flex items-center gap-2.5">
              {workshop.brand_logo_url
                ? <img src={workshop.brand_logo_url} alt={brandName} className="h-8 max-w-[140px] object-contain" />
                : <span className="font-semibold" style={{ color: c.textPrimary }}>{brandName}</span>}
            </div>
            {footerContacts.length > 0 && (
              <div className="flex flex-col gap-2.5">
                <span className="ws-small font-semibold" style={{ color: c.textPrimary }}>Contact</span>
                <ContactDetails entries={footerContacts} variant="footer" colors={c} headingFont={fonts.heading} mutedColor="var(--ws-muted)" />
              </div>
            )}
            {socialLinks.length > 0 && (
              <div className="flex flex-col gap-2.5">
                <span className="ws-small font-semibold" style={{ color: c.textPrimary }}>Follow</span>
                <SocialLinks links={socialLinks} textColor={c.textPrimary} />
              </div>
            )}
          </div>
          {policyLinks.length > 0 && (
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              {policyLinks.map(p => (
                <Link key={p.href} href={p.href} className="ws-small font-medium underline" style={{ color: 'var(--ws-secondary)' }}>{p.label}</Link>
              ))}
            </div>
          )}
          <p className="ws-small" style={{ color: 'var(--ws-muted)' }}>© {new Date().getFullYear()} {brandName}. All rights reserved.</p>
        </div>
      </footer>

      {open && finalCtaOn && (
        <WorkshopRegisterBar
          message={config.finalCtaText}
          buttonText={getRegisterBarButtonText(config)}
          countdownEndAt={showCountdown ? workshop.date_time : null}
          seatsLeft={showSeats ? spotsLeft : null}
          colors={c}
        />
      )}
    </div>
  )
}