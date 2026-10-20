# Kurso

Kurso is a course-delivery platform built for creators who want to sell and
deliver courses without students ever installing a separate app. Content is
delivered through WhatsApp and Telegram — the apps students already have open
— alongside a normal web dashboard and storefront.

This repository is the web application: the public storefront, the creator
dashboard, the admin panel, and every API route. Two companion repositories
handle the messaging side: `Whatsapp-bot` and `telegram-bot`. All three work
together — see `ARCHITECTURE.md` for how.

## What the product actually does

**For creators:**
- Create courses (video lessons, PDFs, ebooks, quizzes, assignments) and set
  a price, or give it away free.
- Run live sessions (Zoom links) with automatic reminder messages before they
  start.
- Run one-off paid or free workshops with their own registration page,
  online or manual-UPI payment, and automatic WhatsApp/Telegram reminders.
- Accept payment through their own Cashfree, Razorpay, or Stripe account
  (bring-your-own-gateway — the platform never touches student payments
  directly for course/workshop sales).
- Offer coupons, referral links, and ebook sales alongside courses.
- Deliver lessons automatically over WhatsApp and/or Telegram once a student
  enrolls — no student-side app install, no student-side account required
  beyond a phone number.
- See analytics, manage students (including CSV import/export), moderate
  Q&A and ratings, issue certificates, and run broadcast announcements to
  every enrolled student at once.
- Optionally track ad performance via Meta Pixel + Conversions API on their
  workshop pages.

**For students:**
- Enroll on the web, then receive lessons as WhatsApp or Telegram messages —
  no app to download.
- Take quizzes, submit assignments, and ask questions, all through the same
  channel they enrolled with.
- Get a shareable certificate on completion.

**Business model:**
Creators are on a flat monthly subscription (varies by which delivery
channels they use — web+Telegram, web+WhatsApp, or all three), billed
through the platform's own Cashfree account, OR an opt-in
"Pay As You Earn" revenue-share plan instead of a flat fee, where the
platform takes a small percentage only on what a creator actually sells
through their course, ebook, and workshop revenue. See `src/lib/revenueShare.ts`
for the exact mechanism.

## The admin panel

There is no separate admin app — it lives inside this same dashboard, gated
by an email allow-list (`ADMIN_EMAILS`, see `.env.example`). An operator
whose logged-in email matches that list sees an extra `/dashboard/admin/*`
section:

- **Creators** (`/dashboard/admin/creators`) — lists every creator, and lets
  the operator "log in as" any one of them (a genuine, time-limited
  impersonation session, not a data copy) for support and debugging. See
  `src/lib/impersonation-guard.ts` and `/api/admin/impersonate/[creatorId]`.
- **Chat** (`/dashboard/admin/chat`) — a support inbox for the in-dashboard
  chat widget every creator sees. Every creator conversation, unread-first.
- **Revenue share** (`/dashboard/admin/revenue-share`) — manages PAYE
  agreements per creator and reviews the monthly auto-generated invoices
  (course, workshop, and ebook revenue are billed on this same mechanism;
  see `ARCHITECTURE.md`).
- **Subscription extensions / refunds** (`/dashboard/admin/subscription-extensions`,
  `/dashboard/admin/subscription-refunds`) — approves or denies creator
  requests for a subscription extension or refund.
- **TDS tracker** (`/dashboard/admin/tds`) — tracks tax-deduction-at-source
  bookkeeping relevant to Indian creator payouts.
- **Messages** (`/dashboard/admin/messages`) — broader operator messaging
  tools alongside the per-creator chat inbox.

Everything else under `/dashboard/*` (courses, ebooks, workshops, students,
coupons, analytics, ratings, refunds, moderation, broadcast, assignments,
lessons, revenue, settings) is the ordinary creator-facing dashboard — every
creator gets these, not just the operator.

## Repository layout
src/app/ Next.js App Router — pages and API routes
src/app/api/ Every backend route (payments, webhooks, cron jobs, bots' internal API)
src/app/dashboard/ Creator dashboard (and /dashboard/admin/* for the operator panel)
src/app/w/ Public workshop registration pages
src/app/course/ Public course landing pages
src/app/creator/ A creator's public storefront (all their courses/ebooks/workshops)
src/components/ Shared React components
src/lib/ Business logic — payments, phone normalization, signing, revenue share, etc.

## Setup

See `SETUP.md` for how to provision every third-party account this project
depends on (Supabase, Cloudflare R2, Meta/WhatsApp, Telegram, payment
gateways, email, AI) and `.env.example` for the full list of environment
variables, each explained.

Once every account exists and `.env.local` is filled in:

```bash
npm install
npm run dev
```

The two bot repositories (`Whatsapp-bot`, `telegram-bot`) need to be running
and reachable at the URLs this project's env vars point to
(`WHATSAPP_BOT_URL`, `TELEGRAM_BOT_URL`) for lesson delivery, reminders, and
workshop notifications to work. They're independent Node/Express services —
see each repo's own README.

