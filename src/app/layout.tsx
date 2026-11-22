import type { Metadata } from 'next'
import './globals.css'
import AuthHashCleanup from '@/components/AuthHashCleanup'
import AuthFetchInstaller from '@/components/AuthFetchInstaller'

// metadataBase turns every relative image/URL used in page-level metadata
// (course pages, creator profiles, etc.) into a correct absolute URL —
// without it, Open Graph previews can silently break on some platforms.
const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || 'https://kurso.in').replace(/\/$/, '')

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: 'Kurso — Sell Courses Through WhatsApp & Telegram, Piracy-Protected',
    template: '%s | Kurso',
  },
  description: 'Deliver courses through WhatsApp and Telegram — no app to download. Watermarked video, anti-piracy protection, and your own branded landing page.',
  alternates: {
    canonical: '/',
  },
  openGraph: {
    type: 'website',
    siteName: 'Kurso',
    title: 'Kurso — Sell Courses Through WhatsApp & Telegram, Piracy-Protected',
    description: 'Deliver courses through WhatsApp and Telegram — no app to download. Watermarked video, anti-piracy protection, and your own branded landing page.',
    url: siteUrl,
    images: [{ url: '/icon.jpg', width: 1024, height: 468, alt: 'Kurso' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Kurso — Sell Courses Through WhatsApp & Telegram, Piracy-Protected',
    description: 'Deliver courses through WhatsApp and Telegram — no app to download. Watermarked video, anti-piracy protection, and your own branded landing page.',
    images: ['/icon.jpg'],
  },
  robots: {
    index: true,
    follow: true,
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
            <body className="bg-black text-white antialiased">
        <AuthHashCleanup />
        <AuthFetchInstaller />
        {children}
      </body>
    </html>
  )
}