/**
 * Certificate generation library.
 * Generates PDF certificates using pdf-lib (A4 landscape).
 * Five distinct templates: classic | modern | gold | minimal | royal
 *
 * Usage:
 *   import { issueCertificate } from './certificate'
 *   const { certificateId, pdfUrl } = await issueCertificate(supabase, params)
 */

import { PDFDocument, rgb, StandardFonts, type PDFPage, type PDFFont, type RGB } from 'pdf-lib'
import type { SupabaseClient } from '@supabase/supabase-js'
import QRCode from 'qrcode'
import { getCertLayoutPalette, type CertPalette } from './certPalettes'

// ─── Types ────────────────────────────────────────────────────────────────────

export type CertTemplate = 'classic' | 'modern' | 'gold' | 'minimal' | 'royal'

export const CERT_TEMPLATES: { id: CertTemplate; label: string; preview: string }[] = [
  { id: 'classic', label: 'Classic', preview: 'White · Navy border · Gold accents · Times-Roman' },
  { id: 'modern', label: 'Modern', preview: 'Dark background · Violet accents · Helvetica' },
  { id: 'gold', label: 'Gold', preview: 'Ivory · Ornate gold borders · Warm palette' },
  { id: 'minimal', label: 'Minimal', preview: 'Pure white · Single violet bar · Ultra clean' },
  { id: 'royal', label: 'Royal', preview: 'Deep navy · Gold typography · Premium feel' },
]

interface DrawData { /** 'workshop' changes the wording to "Certificate of Participation ... attended". Default: course. */
  kind?: 'course' | 'workshop';
  studentName: string
  courseName: string
  creatorName: string
  certificateId: string
  issuedAt: Date
  customMessage?: string
  courseDuration?: string
  instructorName?: string
  instructorTitle?: string
  skills?: string[]
  verificationUrl?: string
}

type CertAssets = { logoImage?: any; signatureImage?: any; qrImage?: any }

// Wording that changes between course and workshop certificates.
function certHeading(d: DrawData): string {
  return d.kind === 'workshop' ? 'CERTIFICATE OF PARTICIPATION' : 'CERTIFICATE OF COMPLETION'
}
function certDoneLine(d: DrawData, opts: { noun?: boolean; upper?: boolean } = {}): string {
  const verb = d.kind === 'workshop' ? 'has successfully attended' : 'has successfully completed'
  const noun = opts.noun ? (d.kind === 'workshop' ? ' the workshop' : ' the course') : ''
  const line = `${verb}${noun}`
  return opts.upper ? line.toUpperCase() : line
}

// ─── Page dimensions (A4 landscape, in points) ───────────────────────────────
const W = 841.89
const H = 595.28

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** X offset to horizontally centre text on the page */
function cx(text: string, font: PDFFont, size: number): number {
  return (W - font.widthOfTextAtSize(text, size)) / 2
}

/** Hex colour → pdf-lib RGB (0–1 range) */
function hx(hex: string): RGB {
  return rgb(
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  )
}

/** Format date as "12 June 2025" */
function fmt(d: Date): string {
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
}

/** Trim text so it never overflows maxWidth (in points) */
function fit(text: string, font: PDFFont, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text
  let t = text
  while (t.length > 4 && font.widthOfTextAtSize(t + '…', size) > maxWidth) {
    t = t.slice(0, -1)
  }
  return t + '…'
}

/** Fetch + embed a PNG/JPEG image from a URL. Returns null if missing or unsupported. */
async function embedImageFromUrl(doc: PDFDocument, url?: string | null) {
  if (!url) return null
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return await doc.embedPng(bytes)
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return await doc.embedJpg(bytes)
    return null
  } catch {
    return null
  }
}

/** Generate + embed a QR code pointing at the verification URL. */
async function embedQrCode(doc: PDFDocument, text?: string) {
  if (!text) return null
  try {
    const buffer = await QRCode.toBuffer(text, {
      type: 'png',
      width: 240,
      margin: 1,
      color: { dark: '#1a1a2e', light: '#ffffff' },
    })
    return await doc.embedPng(buffer)
  } catch {
    return null
  }
}

/** Draw a centered row of skill "pill" badges */
function drawSkillPills(
  page: PDFPage,
  skills: string[],
  font: PDFFont,
  centerY: number,
  pillColor: RGB,
  textColor: RGB,
) {
  const items = skills.slice(0, 5)
  if (items.length === 0) return

  const padX = 10
  const gap = 8
  const fontSize = 9
  const pillH = 20

  const widths = items.map(
    skill => font.widthOfTextAtSize(skill, fontSize) + padX * 2,
  )

  const total =
    widths.reduce((sum, width) => sum + width, 0) +
    gap * (items.length - 1)

  let x = (W - total) / 2

  items.forEach((skill, index) => {
    const width = widths[index]

    page.drawRectangle({
      x,
      y: centerY - pillH / 2,
      width,
      height: pillH,
      borderColor: pillColor,
      borderWidth: 1,
      color: pillColor,
      opacity: 0.12,
    })

    page.drawText(skill, {
      x: x + padX,
      y: centerY - fontSize / 2 + 1,
      size: fontSize,
      font,
      color: textColor,
    })

    x += width + gap
  })
}

function resolveFooterDividerY(
  contentBottom: number,
  defaultY = 128,
): number {
  const gap = 28
  const minY = 112
  const maxY = 190

  const desiredY = contentBottom - gap

  return Math.max(
    minY,
    Math.min(maxY, Math.max(defaultY, desiredY)),
  )
}

/** Append a cache-busting query param so browsers/CDNs don't serve a stale cached PDF */
function bust(url: string): string {
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}v=${Date.now()}`
}

// ─── Template 1: CLASSIC ─────────────────────────────────────────────────────
// White bg · navy double border · Times-Roman · navy/gold palette
function drawClassic(page: PDFPage, d: DrawData, tb: PDFFont, tr: PDFFont, ti: PDFFont, palette: CertPalette, assets: CertAssets = {}) {
  const navy = hx(palette.textPrimary)
  const gold = hx(palette.accent)
  const dkGld = hx(palette.accentDark)

  // Background
  page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: hx(palette.background) })

  // Outer navy border
  page.drawRectangle({ x: 14, y: 14, width: W - 28, height: H - 28, borderColor: navy, borderWidth: 3 })
  // Inner gold border
  page.drawRectangle({ x: 24, y: 24, width: W - 48, height: H - 48, borderColor: gold, borderWidth: 1.5 })
  // Innermost hair line
  page.drawRectangle({ x: 32, y: 32, width: W - 64, height: H - 64, borderColor: dkGld, borderWidth: 0.5 })

  // Corner gold squares
  for (const [bx, by] of [[28, 28], [W - 40, 28], [28, H - 40], [W - 40, H - 40]] as [number, number][]) {
    page.drawRectangle({ x: bx, y: by, width: 12, height: 12, color: gold })
  }

  // Logo (top-left, optional)
  if (assets.logoImage) {
    const dims = assets.logoImage.scaleToFit(90, 55)
    page.drawImage(assets.logoImage, { x: 44, y: H - 44 - dims.height, width: dims.width, height: dims.height })
  }

  // Top separator line
  page.drawRectangle({ x: 40, y: H - 96, width: W - 80, height: 2, color: gold })

  // CERTIFICATE OF COMPLETION
  const hdr = certHeading(d)
  page.drawText(hdr, { x: cx(hdr, tb, 27), y: H - 84, size: 27, font: tb, color: navy })

  // "This is to certify that"
  const sub = 'This is to certify that'
  page.drawText(sub, { x: cx(sub, ti, 16), y: H - 156, size: 16, font: ti, color: hx(palette.textMuted) })

  // Student name
  const name = fit(d.studentName, tb, 38, W - 120)
  page.drawText(name, { x: cx(name, tb, 38), y: H - 212, size: 38, font: tb, color: navy })

  // Underline
  const nw = tb.widthOfTextAtSize(name, 38)
  page.drawLine({ start: { x: (W - nw) / 2 - 12, y: H - 224 }, end: { x: (W + nw) / 2 + 12, y: H - 224 }, color: gold, thickness: 1.5 })

  // "has successfully completed"
  const comp = certDoneLine(d)
  page.drawText(comp, { x: cx(comp, ti, 16), y: H - 268, size: 16, font: ti, color: hx(palette.textMuted) })

  // Course name
  const course = fit(d.courseName, tb, 22, W - 120)
  page.drawText(course, { x: cx(course, tb, 22), y: H - 306, size: 22, font: tb, color: navy })

  let contentY = H - 336

  if (d.customMessage) {
    const msg = fit(d.customMessage, ti, 13, W - 120)

    page.drawText(msg, {
      x: cx(msg, ti, 13),
      y: contentY,
      size: 13,
      font: ti,
      color: hx(palette.textSecondary),
    })

    contentY -= 22
  }

  if (d.courseDuration) {
    const durationInfo = d.courseDuration

    page.drawText(durationInfo, {
      x: cx(durationInfo, ti, 11),
      y: contentY,
      size: 11,
      font: ti,
      color: hx(palette.textMuted),
    })

    contentY -= 24
  }

  if (d.skills && d.skills.length > 0) {
    drawSkillPills(
      page,
      d.skills,
      ti,
      contentY,
      hx(palette.accent),
      hx(palette.textPrimary),
    )

    contentY -= 28
  }

  const creator = `Presented by ${d.creatorName}`

  page.drawText(creator, {
    x: cx(creator, tr, 13),
    y: contentY,
    size: 13,
    font: tr,
    color: hx(palette.textMuted),
  })

  const contentBottom = contentY - 6
  const footerDividerY = resolveFooterDividerY(contentBottom)

  // Content-aware footer
  page.drawRectangle({
    x: 40,
    y: footerDividerY,
    width: W - 80,
    height: 1.5,
    color: gold,
  })

  // Date
  page.drawText('Date of Completion', {
    x: 60,
    y: footerDividerY - 18,
    size: 10,
    font: tb,
    color: navy,
  })

  page.drawText(fmt(d.issuedAt), {
    x: 60,
    y: footerDividerY - 38,
    size: 13,
    font: tr,
    color: hx(palette.textPrimary),
  })

  // Certificate ID
  page.drawText('Certificate ID', {
    x: W - 210,
    y: footerDividerY - 18,
    size: 10,
    font: tb,
    color: navy,
  })

  page.drawText(d.certificateId, {
    x: W - 210,
    y: footerDividerY - 38,
    size: 13,
    font: tr,
    color: hx(palette.textPrimary),
  })

  // Signature
  const centerX = W / 2

  if (assets.signatureImage) {
    const dims = assets.signatureImage.scaleToFit(140, 44)

    page.drawImage(assets.signatureImage, {
      x: centerX - dims.width / 2,
      y: footerDividerY - 32,
      width: dims.width,
      height: dims.height,
    })
  }

  page.drawRectangle({
    x: centerX - 80,
    y: footerDividerY,
    width: 160,
    height: 0.8,
    color: hx(palette.divider),
  })

  const sigName = d.instructorName || d.creatorName

  page.drawText(sigName, {
    x: cx(sigName, tb, 11),
    y: footerDividerY - 50,
    size: 11,
    font: tb,
    color: navy,
  })

  if (d.instructorTitle) {
    page.drawText(d.instructorTitle, {
      x: cx(d.instructorTitle, ti, 9),
      y: footerDividerY - 63,
      size: 9,
      font: ti,
      color: hx(palette.textSecondary),
    })
  }

  // QR code (bottom-right)
  if (assets.qrImage) {
    const qrSize = 48
    page.drawRectangle({
      x: W - 72 - qrSize,
      y: footerDividerY - 66,
      width: qrSize + 6,
      height: qrSize + 6,
      color: hx(palette.surface),
    })

    page.drawImage(assets.qrImage, {
      x: W - 69 - qrSize,
      y: footerDividerY - 63,
      width: qrSize,
      height: qrSize,
    })

    page.drawText('SCAN TO VERIFY', {
      x: W - 72 - qrSize,
      y: footerDividerY - 12,
      size: 7,
      font: tb,
      color: hx(palette.textSecondary),
    })
  }

  // Kurso centre branding
  const brand = 'Verified by Kurso'
  page.drawText(brand, { x: cx(brand, ti, 11), y: 44, size: 11, font: ti, color: gold })
}

// ─── Template 2: MODERN ──────────────────────────────────────────────────────
// Near-black bg · violet accent bars · Helvetica · clean layout
function drawModern(
  page: PDFPage,
  d: DrawData,
  bold: PDFFont,
  regular: PDFFont,
  palette: CertPalette,
  assets: CertAssets = {},
) {
  const bg = hx(palette.background)
  const violet = hx(palette.accent)
  const lilac = hx(palette.accentLight)
  const muted = hx(palette.textMuted)
  const frame = hx(palette.divider)
  const white = hx(palette.textLight)

  // Background
  page.drawRectangle({
    x: 0,
    y: 0,
    width: W,
    height: H,
    color: bg,
  })

  // Accent frame
  page.drawRectangle({
    x: 0,
    y: 0,
    width: 8,
    height: H,
    color: violet,
  })

  page.drawRectangle({
    x: W - 8,
    y: 0,
    width: 8,
    height: H,
    color: violet,
  })

  page.drawRectangle({
    x: 8,
    y: H - 6,
    width: W - 16,
    height: 6,
    color: violet,
  })

  page.drawRectangle({
    x: 8,
    y: 0,
    width: W - 16,
    height: 6,
    color: violet,
  })

  page.drawRectangle({
    x: 28,
    y: 28,
    width: W - 56,
    height: H - 56,
    borderColor: frame,
    borderWidth: 1,
  })

  // Logo
  if (assets.logoImage) {
    const dims = assets.logoImage.scaleToFit(90, 60)

    page.drawImage(assets.logoImage, {
      x: 50,
      y: H - 50 - dims.height,
      width: dims.width,
      height: dims.height,
    })
  }

  // Certificate heading
  const hdr = certHeading(d)

  page.drawText(hdr, {
    x: cx(hdr, bold, 22),
    y: H - 70,
    size: 22,
    font: bold,
    color: lilac,
  })

  page.drawRectangle({
    x: 160,
    y: H - 86,
    width: W - 320,
    height: 1,
    color: frame,
  })

  // Subtitle
  const sub = 'THIS CERTIFIES THAT'

  page.drawText(sub, {
    x: cx(sub, regular, 11),
    y: H - 132,
    size: 11,
    font: regular,
    color: muted,
  })

  // Student name
  const name = fit(d.studentName, bold, 38, W - 120)

  page.drawText(name, {
    x: cx(name, bold, 38),
    y: H - 182,
    size: 38,
    font: bold,
    color: white,
  })

  page.drawRectangle({
    x: (W - 140) / 2,
    y: H - 196,
    width: 140,
    height: 3,
    color: violet,
  })

  // Completion text
  const comp = certDoneLine(d, { noun: true, upper: true })

  page.drawText(comp, {
    x: cx(comp, regular, 11),
    y: H - 232,
    size: 11,
    font: regular,
    color: muted,
  })

  // Course name
  const course = fit(d.courseName, bold, 22, W - 120)

  page.drawText(course, {
    x: cx(course, bold, 22),
    y: H - 268,
    size: 22,
    font: bold,
    color: lilac,
  })

  // Dynamic content area
  let contentY = H - 300

  if (d.customMessage) {
    const msg = fit(d.customMessage, regular, 11, W - 140)

    page.drawText(msg, {
      x: cx(msg, regular, 11),
      y: contentY,
      size: 11,
      font: regular,
      color: muted,
    })

    contentY -= 26
  }

  if (d.courseDuration) {
    page.drawText(d.courseDuration, {
      x: cx(d.courseDuration, regular, 10),
      y: contentY,
      size: 10,
      font: regular,
      color: muted,
    })

    contentY -= 26
  }

  if (d.skills && d.skills.length > 0) {
    drawSkillPills(
      page,
      d.skills,
      regular,
      contentY,
      violet,
      lilac,
    )

    contentY -= 24
  }

  const contentBottom = contentY - 6
  const footerDividerY = resolveFooterDividerY(contentBottom, 108)
  const footerY = footerDividerY - 38

  // Footer divider
  page.drawRectangle({
    x: 50,
    y: footerDividerY,
    width: W - 100,
    height: 1,
    color: frame,
  })

  // Date
  page.drawText('DATE OF COMPLETION', {
    x: 60,
    y: footerY + 18,
    size: 8,
    font: bold,
    color: muted,
  })

  page.drawText(fmt(d.issuedAt), {
    x: 60,
    y: footerY - 2,
    size: 13,
    font: bold,
    color: white,
  })

  // Signature
  const centerX = W / 2

  if (assets.signatureImage) {
    const dims = assets.signatureImage.scaleToFit(140, 44)

    page.drawImage(assets.signatureImage, {
      x: centerX - dims.width / 2,
      y: footerY + 18,
      width: dims.width,
      height: dims.height,
    })
  }

  page.drawRectangle({
    x: centerX - 80,
    y: footerY + 14,
    width: 160,
    height: 0.8,
    color: frame,
  })

  const sigName = d.instructorName || d.creatorName

  page.drawText(sigName, {
    x: cx(sigName, bold, 12),
    y: footerY - 2,
    size: 12,
    font: bold,
    color: white,
  })

  if (d.instructorTitle) {
    page.drawText(d.instructorTitle, {
      x: cx(d.instructorTitle, regular, 9),
      y: footerY - 16,
      size: 9,
      font: regular,
      color: muted,
    })
  }

  // QR code
  if (assets.qrImage) {
    const qrSize = 52

    page.drawRectangle({
      x: W - 60 - qrSize - 4,
      y: footerY - 4,
      width: qrSize + 8,
      height: qrSize + 8,
      color: white,
    })

    page.drawImage(assets.qrImage, {
      x: W - 60 - qrSize,
      y: footerY,
      width: qrSize,
      height: qrSize,
    })

    page.drawText('SCAN TO VERIFY', {
      x: W - 60 - qrSize - 4,
      y: footerY + qrSize + 12,
      size: 7,
      font: bold,
      color: muted,
    })
  }

  // Certificate ID
  page.drawText('CERTIFICATE ID', {
    x: W - 230,
    y: footerY + 18,
    size: 8,
    font: bold,
    color: muted,
  })

  page.drawText(d.certificateId, {
    x: W - 230,
    y: footerY - 2,
    size: 11,
    font: bold,
    color: white,
  })

  // Branding
  const brand = 'kurso.in'

  page.drawText(brand, {
    x: cx(brand, regular, 10),
    y: 24,
    size: 10,
    font: regular,
    color: violet,
  })
}

// ─── Template 3: GOLD ────────────────────────────────────────────────────────
// Ivory bg · ornate gold double border · Times-Roman · warm palette
function drawGold(
  page: PDFPage,
  d: DrawData,
  tb: PDFFont,
  tr: PDFFont,
  ti: PDFFont,
  palette: CertPalette,
  assets: CertAssets = {},
) {
  const cream = hx(palette.background)
  const gold = hx(palette.accent)
  const dkGld = hx(palette.accentDark)
  const brown = hx(palette.textPrimary)

  // Cream background
  page.drawRectangle({
    x: 0,
    y: 0,
    width: W,
    height: H,
    color: cream,
  })

  // Thick gold outer border
  page.drawRectangle({
    x: 12,
    y: 12,
    width: W - 24,
    height: H - 24,
    borderColor: gold,
    borderWidth: 4,
  })

  // Medium inner border
  page.drawRectangle({
    x: 22,
    y: 22,
    width: W - 44,
    height: H - 44,
    borderColor: dkGld,
    borderWidth: 1.5,
  })

  // Hair line innermost
  page.drawRectangle({
    x: 30,
    y: 30,
    width: W - 60,
    height: H - 60,
    borderColor: gold,
    borderWidth: 0.5,
  })

  // Corner accent diamonds
  for (const [bx, by] of [
    [28, H - 46],
    [W - 44, H - 46],
    [28, 34],
    [W - 44, 34],
  ] as [number, number][]) {
    page.drawRectangle({
      x: bx,
      y: by,
      width: 16,
      height: 2,
      color: gold,
    })

    page.drawRectangle({
      x: bx + 7,
      y: by - 7,
      width: 2,
      height: 16,
      color: gold,
    })
  }

  // Logo
  if (assets.logoImage) {
    const dims = assets.logoImage.scaleToFit(90, 55)

    page.drawImage(assets.logoImage, {
      x: 44,
      y: H - 44 - dims.height,
      width: dims.width,
      height: dims.height,
    })
  }

  // Top separator
  page.drawRectangle({
    x: 40,
    y: H - 94,
    width: W - 80,
    height: 2.5,
    color: gold,
  })

  page.drawRectangle({
    x: 40,
    y: H - 100,
    width: W - 80,
    height: 0.8,
    color: dkGld,
  })

  // Certificate heading
  const hdr = certHeading(d)

  page.drawText(hdr, {
    x: cx(hdr, tb, 26),
    y: H - 82,
    size: 26,
    font: tb,
    color: dkGld,
  })

  // Subtitle
  const sub = '~ This is to certify that ~'

  page.drawText(sub, {
    x: cx(sub, ti, 15),
    y: H - 154,
    size: 15,
    font: ti,
    color: gold,
  })

  // Student name
  const name = fit(d.studentName, tb, 38, W - 120)

  page.drawText(name, {
    x: cx(name, tb, 38),
    y: H - 210,
    size: 38,
    font: tb,
    color: brown,
  })

  // Double underline
  const nw = tb.widthOfTextAtSize(name, 38)

  page.drawLine({
    start: {
      x: (W - nw) / 2 - 20,
      y: H - 222,
    },
    end: {
      x: (W + nw) / 2 + 20,
      y: H - 222,
    },
    color: gold,
    thickness: 1.2,
  })

  page.drawLine({
    start: {
      x: (W - nw) / 2 - 6,
      y: H - 226,
    },
    end: {
      x: (W + nw) / 2 + 6,
      y: H - 226,
    },
    color: dkGld,
    thickness: 0.5,
  })

  // Completion text
  const comp = certDoneLine(d, { noun: true })

  page.drawText(comp, {
    x: cx(comp, ti, 15),
    y: H - 268,
    size: 15,
    font: ti,
    color: hx(palette.textMuted),
  })

  // Course name
  const course = fit(d.courseName, tb, 22, W - 120)

  page.drawText(course, {
    x: cx(course, tb, 22),
    y: H - 306,
    size: 22,
    font: tb,
    color: dkGld,
  })

  // Dynamic content area
  let contentY = H - 336

  if (d.customMessage) {
    const msg = fit(d.customMessage, ti, 13, W - 120)

    page.drawText(msg, {
      x: cx(msg, ti, 13),
      y: contentY,
      size: 13,
      font: ti,
      color: hx(palette.textSecondary),
    })

    contentY -= 22
  }

  if (d.courseDuration) {
    const durationInfo = d.courseDuration

    page.drawText(durationInfo, {
      x: cx(durationInfo, ti, 11),
      y: contentY,
      size: 11,
      font: ti,
      color: hx(palette.textMuted),
    })

    contentY -= 24
  }

  if (d.skills && d.skills.length > 0) {
    drawSkillPills(
      page,
      d.skills,
      ti,
      contentY,
      hx(palette.accent),
      hx(palette.accentDark),
    )

    contentY -= 28
  }

  const creator = `Awarded by ${d.creatorName}`

  page.drawText(creator, {
    x: cx(creator, tr, 13),
    y: contentY,
    size: 13,
    font: tr,
    color: brown,
  })

  const contentBottom = contentY - 6
  const footerDividerY = resolveFooterDividerY(contentBottom)

  // Content-aware footer dividers
  page.drawRectangle({
    x: 40,
    y: footerDividerY,
    width: W - 80,
    height: 1.5,
    color: gold,
  })

  page.drawRectangle({
    x: 40,
    y: footerDividerY - 4,
    width: W - 80,
    height: 0.5,
    color: dkGld,
  })

  // Date
  page.drawText('Date of Award', {
    x: 60,
    y: footerDividerY - 18,
    size: 10,
    font: tb,
    color: dkGld,
  })

  page.drawText(fmt(d.issuedAt), {
    x: 60,
    y: footerDividerY - 38,
    size: 13,
    font: tr,
    color: brown,
  })

  // Certificate number
  page.drawText('Certificate Number', {
    x: W - 220,
    y: footerDividerY - 18,
    size: 10,
    font: tb,
    color: dkGld,
  })

  page.drawText(d.certificateId, {
    x: W - 220,
    y: footerDividerY - 38,
    size: 13,
    font: tr,
    color: brown,
  })

  // Signature
  const centerX = W / 2

  if (assets.signatureImage) {
    const dims = assets.signatureImage.scaleToFit(140, 44)

    page.drawImage(assets.signatureImage, {
      x: centerX - dims.width / 2,
      y: footerDividerY - 32,
      width: dims.width,
      height: dims.height,
    })
  }

  page.drawRectangle({
    x: centerX - 80,
    y: footerDividerY,
    width: 160,
    height: 0.8,
    color: dkGld,
  })

  const sigName = d.instructorName || d.creatorName

  page.drawText(sigName, {
    x: cx(sigName, tb, 11),
    y: footerDividerY - 50,
    size: 11,
    font: tb,
    color: brown,
  })

  if (d.instructorTitle) {
    page.drawText(d.instructorTitle, {
      x: cx(d.instructorTitle, ti, 9),
      y: footerDividerY - 63,
      size: 9,
      font: ti,
      color: hx(palette.textSecondary),
    })
  }

  // QR code
  if (assets.qrImage) {
    const qrSize = 48

    page.drawRectangle({
      x: W - 72 - qrSize,
      y: footerDividerY - 66,
      width: qrSize + 6,
      height: qrSize + 6,
      color: cream,
    })

    page.drawImage(assets.qrImage, {
      x: W - 69 - qrSize,
      y: footerDividerY - 63,
      width: qrSize,
      height: qrSize,
    })

    page.drawText('SCAN TO VERIFY', {
      x: W - 72 - qrSize,
      y: footerDividerY - 12,
      size: 7,
      font: tb,
      color: dkGld,
    })
  }

  // Centre branding
  const brand = '— Kurso —'

  page.drawText(brand, {
    x: cx(brand, ti, 12),
    y: 44,
    size: 12,
    font: ti,
    color: gold,
  })
}


// ─── Template 4: MINIMAL ─────────────────────────────────────────────────────
// Pure white · left-aligned layout · single violet top bar · Helvetica
function drawMinimal(
  page: PDFPage,
  d: DrawData,
  bold: PDFFont,
  regular: PDFFont,
  ti: PDFFont,
  palette: CertPalette,
  assets: CertAssets = {},
) {
  const violet = hx(palette.accent)
  const mid = hx(palette.textMuted)
  const faint = hx(palette.divider)

  // White background
  page.drawRectangle({
    x: 0,
    y: 0,
    width: W,
    height: H,
    color: hx(palette.background),
  })

  // Top violet strip
  page.drawRectangle({
    x: 0,
    y: H - 8,
    width: W,
    height: 8,
    color: violet,
  })

  // Left edge accent
  page.drawRectangle({
    x: 0,
    y: 0,
    width: 4,
    height: H - 8,
    color: violet,
  })

  // Logo
  if (assets.logoImage) {
    const dims = assets.logoImage.scaleToFit(90, 55)

    page.drawImage(assets.logoImage, {
      x: W - 44 - dims.width,
      y: H - 44 - dims.height,
      width: dims.width,
      height: dims.height,
    })
  }

  // Certificate label
  page.drawText(certHeading(d), {
    x: 60,
    y: H - 58,
    size: 12,
    font: bold,
    color: violet,
  })

  // Student name
  const name = fit(d.studentName, bold, 44, W - 120)

  page.drawText(name, {
    x: 60,
    y: H - 148,
    size: 44,
    font: bold,
    color: hx(palette.textPrimary),
  })

  // Accent rule under name
  page.drawRectangle({
    x: 60,
    y: H - 163,
    width: 240,
    height: 2,
    color: violet,
  })

  // Completion text
  page.drawText(certDoneLine(d), {
    x: 60,
    y: H - 202,
    size: 14,
    font: regular,
    color: mid,
  })

  // Course name
  const course = fit(d.courseName, bold, 22, W - 120)

  page.drawText(course, {
    x: 60,
    y: H - 240,
    size: 22,
    font: bold,
    color: hx(palette.textPrimary),
  })

  // Dynamic content area
  let bodyY = H - 272

  if (d.customMessage) {
    const msg = fit(d.customMessage, regular, 12, W - 120)

    page.drawText(msg, {
      x: 60,
      y: bodyY,
      size: 12,
      font: regular,
      color: mid,
    })

    bodyY -= 24
  }

  page.drawText(`by ${d.creatorName}`, {
    x: 60,
    y: bodyY,
    size: 13,
    font: regular,
    color: mid,
  })

  bodyY -= 22

  if (d.courseDuration) {
    page.drawText(d.courseDuration, {
      x: 60,
      y: bodyY,
      size: 11,
      font: regular,
      color: mid,
    })

    bodyY -= 26
  }

  if (d.skills && d.skills.length > 0) {
    drawSkillPills(
      page,
      d.skills,
      regular,
      bodyY,
      hx(palette.accent),
      hx(palette.textMuted),
    )

    bodyY -= 28
  }

  const contentBottom = bodyY - 6
  const footerDividerY = resolveFooterDividerY(contentBottom)

  // Footer divider
  page.drawRectangle({
    x: 60,
    y: footerDividerY,
    width: W - 120,
    height: 0.8,
    color: faint,
  })

  // Date
  page.drawText('Date', {
    x: 60,
    y: footerDividerY - 18,
    size: 9,
    font: bold,
    color: mid,
  })

  page.drawText(fmt(d.issuedAt), {
    x: 60,
    y: footerDividerY - 38,
    size: 13,
    font: regular,
    color: hx(palette.textPrimary),
  })

  // Certificate ID
  page.drawText('Certificate ID', {
    x: W - 220,
    y: footerDividerY - 18,
    size: 9,
    font: bold,
    color: mid,
  })

  page.drawText(d.certificateId, {
    x: W - 220,
    y: footerDividerY - 38,
    size: 13,
    font: regular,
    color: hx(palette.textPrimary),
  })

  // Signature
  const centerX = W / 2

  if (assets.signatureImage) {
    const dims = assets.signatureImage.scaleToFit(140, 44)

    page.drawImage(assets.signatureImage, {
      x: centerX - dims.width / 2,
      y: footerDividerY - 32,
      width: dims.width,
      height: dims.height,
    })
  }

  page.drawRectangle({
    x: centerX - 80,
    y: footerDividerY,
    width: 160,
    height: 0.8,
    color: faint,
  })

  const sigName = d.instructorName || d.creatorName

  page.drawText(sigName, {
    x: cx(sigName, bold, 11),
    y: footerDividerY - 50,
    size: 11,
    font: bold,
    color: hx(palette.textPrimary),
  })

  if (d.instructorTitle) {
    page.drawText(d.instructorTitle, {
      x: cx(d.instructorTitle, regular, 9),
      y: footerDividerY - 63,
      size: 9,
      font: regular,
      color: mid,
    })
  }

  // QR code
  if (assets.qrImage) {
    const qrSize = 48

    page.drawRectangle({
      x: W - 72 - qrSize,
      y: footerDividerY - 66,
      width: qrSize + 6,
      height: qrSize + 6,
      color: hx(palette.surface),
    })

    page.drawImage(assets.qrImage, {
      x: W - 69 - qrSize,
      y: footerDividerY - 63,
      width: qrSize,
      height: qrSize,
    })

    page.drawText('SCAN TO VERIFY', {
      x: W - 72 - qrSize,
      y: footerDividerY - 12,
      size: 7,
      font: bold,
      color: mid,
    })
  }

  // Centre branding
  const brand = 'Kurso'

  page.drawText(brand, {
    x: cx(brand, bold, 12),
    y: 44,
    size: 12,
    font: bold,
    color: violet,
  })
}

// ─── Template 5: ROYAL ───────────────────────────────────────────────────────
// Deep navy bg · gold borders · Times-Roman · premium feel
function drawRoyal(
  page: PDFPage,
  d: DrawData,
  tb: PDFFont,
  tr: PDFFont,
  ti: PDFFont,
  palette: CertPalette,
  assets: CertAssets = {},
) {
  const navy = hx(palette.background)
  const gold = hx(palette.accent)
  const ltGold = hx(palette.accentLight)
  const dkGld = hx(palette.accentDark)
  const muted = hx(palette.textMuted)

  // Navy background
  page.drawRectangle({
    x: 0,
    y: 0,
    width: W,
    height: H,
    color: navy,
  })

  // Outer gold border
  page.drawRectangle({
    x: 14,
    y: 14,
    width: W - 28,
    height: H - 28,
    borderColor: gold,
    borderWidth: 2.5,
  })

  // Inner hairline
  page.drawRectangle({
    x: 22,
    y: 22,
    width: W - 44,
    height: H - 44,
    borderColor: dkGld,
    borderWidth: 0.5,
  })

  // Corner cross ornaments
  for (const [bx, by] of [
    [28, H - 46],
    [W - 48, H - 46],
    [28, 32],
    [W - 48, 32],
  ] as [number, number][]) {
    page.drawRectangle({
      x: bx,
      y: by + 5,
      width: 20,
      height: 2,
      color: gold,
    })

    page.drawRectangle({
      x: bx + 9,
      y: by,
      width: 2,
      height: 12,
      color: gold,
    })
  }

  // Logo
  if (assets.logoImage) {
    const dims = assets.logoImage.scaleToFit(90, 55)

    page.drawImage(assets.logoImage, {
      x: 44,
      y: H - 44 - dims.height,
      width: dims.width,
      height: dims.height,
    })
  }

  // Small KURSO label
  const ak = 'KURSO'

  page.drawText(ak, {
    x: cx(ak, tb, 11),
    y: H - 52,
    size: 11,
    font: tb,
    color: gold,
  })

  // Top gold divider
  page.drawRectangle({
    x: 36,
    y: H - 96,
    width: W - 72,
    height: 1.5,
    color: gold,
  })

  // Certificate heading
  const hdr = certHeading(d)

  page.drawText(hdr, {
    x: cx(hdr, tb, 25),
    y: H - 84,
    size: 25,
    font: tb,
    color: ltGold,
  })

  // Subtitle
  const sub = 'This is to proudly certify that'

  page.drawText(sub, {
    x: cx(sub, ti, 15),
    y: H - 154,
    size: 15,
    font: ti,
    color: muted,
  })

  // Student name
  const name = fit(d.studentName, tb, 38, W - 120)

  page.drawText(name, {
    x: cx(name, tb, 38),
    y: H - 210,
    size: 38,
    font: tb,
    color: ltGold,
  })

  // Double underline
  const nw = tb.widthOfTextAtSize(name, 38)

  page.drawLine({
    start: {
      x: (W - nw) / 2 - 14,
      y: H - 223,
    },
    end: {
      x: (W + nw) / 2 + 14,
      y: H - 223,
    },
    color: gold,
    thickness: 1.5,
  })

  page.drawLine({
    start: {
      x: (W - nw) / 2 - 4,
      y: H - 228,
    },
    end: {
      x: (W + nw) / 2 + 4,
      y: H - 228,
    },
    color: dkGld,
    thickness: 0.5,
  })

  // Completion text
  const comp = certDoneLine(d)

  page.drawText(comp, {
    x: cx(comp, ti, 15),
    y: H - 268,
    size: 15,
    font: ti,
    color: muted,
  })

  // Course name
  const course = fit(d.courseName, tb, 22, W - 120)

  page.drawText(course, {
    x: cx(course, tb, 22),
    y: H - 306,
    size: 22,
    font: tb,
    color: gold,
  })

  // Dynamic content area
  let contentY = H - 336

  if (d.customMessage) {
    const msg = fit(d.customMessage, ti, 13, W - 120)

    page.drawText(msg, {
      x: cx(msg, ti, 13),
      y: contentY,
      size: 13,
      font: ti,
      color: muted,
    })

    contentY -= 22
  }

  if (d.courseDuration) {
    page.drawText(d.courseDuration, {
      x: cx(d.courseDuration, ti, 11),
      y: contentY,
      size: 11,
      font: ti,
      color: muted,
    })

    contentY -= 24
  }

  if (d.skills && d.skills.length > 0) {
    drawSkillPills(
      page,
      d.skills,
      ti,
      contentY,
      hx(palette.accent),
      hx(palette.accentDark),
    )

    contentY -= 28
  }

  const creator = `Presented by ${d.creatorName}`

  page.drawText(creator, {
    x: cx(creator, tr, 13),
    y: contentY,
    size: 13,
    font: tr,
    color: hx(palette.textLight),
  })

  const contentBottom = contentY - 6
  const footerDividerY = resolveFooterDividerY(contentBottom)

  // Content-aware footer divider
  page.drawRectangle({
    x: 36,
    y: footerDividerY,
    width: W - 72,
    height: 1.5,
    color: gold,
  })

  // Date
  page.drawText('Date of Completion', {
    x: 60,
    y: footerDividerY - 18,
    size: 10,
    font: tb,
    color: gold,
  })

  page.drawText(fmt(d.issuedAt), {
    x: 60,
    y: footerDividerY - 38,
    size: 13,
    font: tr,
    color: hx(palette.textLight),
  })

  // Certificate ID
  page.drawText('Certificate ID', {
    x: W - 208,
    y: footerDividerY - 18,
    size: 10,
    font: tb,
    color: gold,
  })

  page.drawText(d.certificateId, {
    x: W - 208,
    y: footerDividerY - 38,
    size: 13,
    font: tr,
    color: hx(palette.textLight),
  })

  // Signature
  const centerX = W / 2

  if (assets.signatureImage) {
    const dims = assets.signatureImage.scaleToFit(140, 44)

    page.drawImage(assets.signatureImage, {
      x: centerX - dims.width / 2,
      y: footerDividerY - 32,
      width: dims.width,
      height: dims.height,
    })
  }

  page.drawRectangle({
    x: centerX - 80,
    y: footerDividerY,
    width: 160,
    height: 0.8,
    color: dkGld,
  })

  const sigName = d.instructorName || d.creatorName

  page.drawText(sigName, {
    x: cx(sigName, tb, 11),
    y: footerDividerY - 50,
    size: 11,
    font: tb,
    color: ltGold,
  })

  if (d.instructorTitle) {
    page.drawText(d.instructorTitle, {
      x: cx(d.instructorTitle, ti, 9),
      y: footerDividerY - 63,
      size: 9,
      font: ti,
      color: muted,
    })
  }

  // QR code
  if (assets.qrImage) {
    const qrSize = 48

    page.drawRectangle({
      x: W - 72 - qrSize,
      y: footerDividerY - 66,
      width: qrSize + 6,
      height: qrSize + 6,
      color: hx(palette.surface),
    })

    page.drawImage(assets.qrImage, {
      x: W - 69 - qrSize,
      y: footerDividerY - 63,
      width: qrSize,
      height: qrSize,
    })

    page.drawText('SCAN TO VERIFY', {
      x: W - 72 - qrSize,
      y: footerDividerY - 12,
      size: 7,
      font: tb,
      color: muted,
    })
  }

  // Centre branding
  const brand = '~ Verified by Kurso ~'

  page.drawText(brand, {
    x: cx(brand, ti, 11),
    y: 44,
    size: 11,
    font: ti,
    color: gold,
  })
}

// ─── Main: generate PDF bytes ─────────────────────────────────────────────────

export async function generateCertificatePDF(data: { kind?: 'course' | 'workshop'
  studentName: string
  courseName: string
  creatorName: string
  certificateId: string
  issuedAt: Date
  template: CertTemplate
  paletteId?: string | null
  customMessage?: string
  courseDuration?: string
  instructorName?: string
  instructorTitle?: string
  skills?: string[]
  verificationUrl?: string
  logoUrl?: string
  signatureUrl?: string
}): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([W, H])

  // Embed all fonts upfront
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const regular = await doc.embedFont(StandardFonts.Helvetica)
  const timesBold = await doc.embedFont(StandardFonts.TimesRomanBold)
  const timesRegular = await doc.embedFont(StandardFonts.TimesRoman)
  const timesItalic = await doc.embedFont(StandardFonts.TimesRomanItalic)

  const logoImage = await embedImageFromUrl(doc, data.logoUrl)
  const signatureImage = await embedImageFromUrl(doc, data.signatureUrl)
  const qrImage = await embedQrCode(doc, data.verificationUrl)
  const assets = { logoImage, signatureImage, qrImage }
  const palette = getCertLayoutPalette(data.template, data.paletteId)

  switch (data.template) {
    case 'modern': drawModern(page, data, bold, regular, palette, assets); break
    case 'gold': drawGold(page, data, timesBold, timesRegular, timesItalic, palette, assets); break
    case 'minimal': drawMinimal(page, data, bold, regular, timesItalic, palette, assets); break
    case 'royal': drawRoyal(page, data, timesBold, timesRegular, timesItalic, palette, assets); break
    default: drawClassic(page, data, timesBold, timesRegular, timesItalic, palette, assets); break
  }

  return doc.save()
}

// ─── Main: issue (generate + store + record) ──────────────────────────────────

export async function issueCertificate(
  supabase: SupabaseClient,
  params: {
    enrollmentId: string
    courseId: string
    studentId: string | null
    studentName: string
    courseName: string
    creatorName: string
    template: CertTemplate
    paletteId?: string | null
    customMessage?: string
    courseDuration?: string

    instructorName?: string
    instructorTitle?: string
    skills?: string[]
    logoUrl?: string
    signatureUrl?: string
  },
): Promise<{ certificateId: string; pdfUrl: string }> {

  // ── Idempotent: return if already issued with same name ────────────────────
  const { data: existing } = await supabase
    .from('certificates')
    .select('certificate_id, pdf_url, student_name')
    .eq('enrollment_id', params.enrollmentId)
    .maybeSingle()

  // Only return existing if student name matches - otherwise regenerate
  if (existing?.certificate_id && existing.student_name === params.studentName) {
    return { certificateId: existing.certificate_id, pdfUrl: existing.pdf_url }
  }

  // ── Generate unique certificate ID (reuse existing if name changed) ─────────
  const certId = existing?.certificate_id || `AK-${new Date().getFullYear()}-${Math.floor(Math.random() * 100_000_000).toString().padStart(8, '0')}`
  const issuedAt = new Date()

  // ── Build PDF ─────────────────────────────────────────────────────────────
  const pdfBytes = await generateCertificatePDF({
    studentName: params.studentName,
    courseName: params.courseName,
    creatorName: params.creatorName,
    certificateId: certId,
    issuedAt,
    template: params.template,
    paletteId: params.paletteId,
    customMessage: params.customMessage,
    courseDuration: params.courseDuration,
    instructorName: params.instructorName,
    instructorTitle: params.instructorTitle,
    skills: params.skills,
    logoUrl: params.logoUrl,
    signatureUrl: params.signatureUrl,
    verificationUrl: `${process.env.NEXT_PUBLIC_SITE_URL || 'https://kurso.in'}/certificate/${certId}`,
  })

  // ── Upload to Supabase Storage ────────────────────────────────────────────
  const storagePath = `${params.courseId}/${params.studentId ?? params.enrollmentId}.pdf`

  const { error: uploadError } = await supabase.storage
    .from('certificates')
    .upload(storagePath, pdfBytes, { contentType: 'application/pdf', upsert: true })

  if (uploadError) throw new Error(`Certificate upload failed: ${uploadError.message}`)

  const { data: { publicUrl } } = supabase.storage
    .from('certificates')
    .getPublicUrl(storagePath)

  // ── Insert or update certificates table ────────────────────────────────────
  if (existing?.certificate_id) {
    const { error: updateError } = await supabase.from('certificates').update({
      student_name: params.studentName,
      issued_at: issuedAt.toISOString(),
      pdf_url: publicUrl,
    }).eq('certificate_id', existing.certificate_id)
    if (updateError) throw new Error(`Certificate update failed: ${updateError.message}`)
  } else {
    const { error: insertError } = await supabase.from('certificates').insert({
      enrollment_id: params.enrollmentId,
      course_id: params.courseId,
      student_id: params.studentId,
      certificate_id: certId,
      student_name: params.studentName,
      course_name: params.courseName,
      creator_name: params.creatorName,
      issued_at: issuedAt.toISOString(),
      pdf_url: publicUrl,
    })
    if (insertError) throw new Error(`Certificate record failed: ${insertError.message}`)
  }

  // ── Update enrollment row ─────────────────────────────────────────────────
  await supabase.from('enrollments').update({
    certificate_id: certId,
    certificate_issued_at: issuedAt.toISOString(),
    certificate_url: publicUrl,
  }).eq('id', params.enrollmentId)

  return { certificateId: certId, pdfUrl: bust(publicUrl) }
}
