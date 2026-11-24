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
  enrolls — no student-side app install. Students sign up inside the enroll
  popup (email and password, or Google) and link their chat with one tap;
  students imported by the creator need no account at all and link through a
  claim page.
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
Every creator is on "Pay As You Earn": no upfront fee, every channel
(web, WhatsApp, Telegram) unlocked from day one, and the platform earns a
commission only on what the creator actually sells.

- Course and workshop sales: 5% commission, 6.5% once a creator passes 300
  paid students (counted separately for courses and workshops).
- Ebook sales: 4%, charged only in months when ebook sales reach ₹500.
- WhatsApp message charges are passed through at Meta's rate.
- One invoice per creator per month, due within a 14-day grace period.
  Unpaid invoices pause new enrollments and registrations only; existing
  students are never affected.

The rates are constants in `src/lib/revenueShare.ts` and can be overridden
per creator with an agreement row. Creators pay the platform through the
platform's own Cashfree account (see `ARCHITECTURE.md`). 

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
- **Revenue share** (`/dashboard/admin/revenue-share`) — manages per-creator
  agreements, reviews the monthly auto-generated invoices (course and
  workshop revenue share one invoice; ebooks are invoiced separately), and
  approves or rejects creators' waiver requests. Approving a waiver clears
  the invoice and re-opens whatever the overdue sweep paused.
- **Subscription extensions / refunds** (`/dashboard/admin/subscription-extensions`,
  `/dashboard/admin/subscription-refunds`) — for creators on the older flat
  plans; approves or denies their extension or refund requests.
- **TDS tracker** (`/dashboard/admin/tds`) — tracks tax-deduction-at-source
  bookkeeping relevant to Indian creator payouts.
- **Messages** (`/dashboard/admin/messages`) — broader operator messaging
  tools alongside the per-creator chat inbox.

Everything else under `/dashboard/*` (courses, ebooks, workshops, students,
coupons, analytics, ratings, refunds, moderation, broadcast, assignments,
lessons, revenue, settings) is the ordinary creator-facing dashboard — every
creator gets these, not just the operator.

## Repository layout

```
src/app/                  Next.js App Router — pages and API routes
src/app/api/              Every backend route (payments, webhooks, cron jobs, the bots' API)
src/app/dashboard/        Creator dashboard (and /dashboard/admin/* for the operator panel)
src/app/course/, c/       Public course landing pages
src/app/enroll/           Standalone checkout page (the enroll popup)
src/app/my-courses/       A signed-in student's courses; wa/ is the signed-link version
src/app/claim/            Telegram claim page for imported students (no login)
src/app/w/                Public workshop registration pages
src/app/creator/          A creator's public storefront (courses, ebooks, workshops)
src/app/ebook/, certificate/, resource/   Ebook pages, certificate verification, lesson resources
src/app/login/            Creator sign-in (students sign in through the enroll popup)
src/components/           Shared React components
src/lib/                  Business logic — payments, phone normalization, signing, revenue share
middleware.ts             Content-Security-Policy for public course pages
tests/                    Automated test suite (see tests/README.md)
```

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

## Automated tests

A Playwright suite covers the money flows, access rules and security
policies, and the main creator and student journeys in a real browser. It
runs against a separate Supabase test project, never production. See
`tests/README.md` for the commands and for what each folder covers.

The key business rules are each tested: a creator with an unpaid invoice
cannot publish, a payment that arrives after a pause still grants access, and
a refund removes access immediately.

## Handover

The complete production database (tables, row-level-security policies,
triggers and functions) is provided to the new owner as part of the
handover.

