# Kurso tests

Everything here runs against the **kurso-test** Supabase project, never live.
A safety guard in `setup/global-setup.ts` refuses to start unless the database is the test project.

## First-time setup
1. `copy .env.test.example .env.test` and fill it in (keep `ADMIN_EMAILS` as the test-only address).
2. `npx playwright install chromium`
3. In the kurso-test Supabase dashboard: Authentication, Providers, Email, turn **Confirm email OFF**
   (the browser tests sign students up and would hit "email rate limit exceeded" otherwise).
4. Every SQL fix (policies, grants, triggers) must be applied on **both** kurso-test and live.

## Commands
| Command | What it runs |
|---|---|
| `npm run test:smoke` | Checks the test machinery works |
| `npm run test:unit` | Pure logic: module locks, commission math, phone format, release schedule |
| `npm run test:api` | API routes, webhooks, cron, and database security rules |
| `npm run test:integration` | Multi-step money flows against the database |
| `npm run test:e2e` | Real browser journeys (add `--headed` to watch) |
| `npm run test:all` | Everything, one test at a time |
| `npm run test:report` | Opens the last HTML report |

Run one file: `npx playwright test tests/api/ebooks/ebook-refund.spec.ts --project=api`

## What is covered, by folder
| Folder | Covers |
|---|---|
| `api/payments/` | Checkout order creation, Cashfree and Razorpay webhooks (signature, repeat events, wrong amounts), gateway key saving |
| `api/billing/` | Revenue-share invoices, paying an invoice, the overdue sweep (courses, ebooks, webinars), the admin waiver decision |
| `api/publishing/` | A lapsed creator cannot publish a course, ebook or webinar (the database refuses) |
| `api/student/` | Free enrolment, lesson list and signed content access, video streaming, lesson completion |
| `api/ebooks/` | Ebook ordering, download limits, refund requests and creator decisions (claim-first, failed refunds go back to pending) |
| `api/workshops/` | Webinar registration, checkout, refunds |
| `api/security/` | Who can read or write what in the database: enrollments, billing, lessons, ebooks, registrations, refunded-access links, the Telegram/WhatsApp token routes |
| `integration/` | Commission split across the money flows |
| `e2e/` | Browser: sign up and sign in, student journey, My Learning, creator dashboard, creating and publishing courses and webinars, the enroll popup, public webinar page |

## The business rules and where they are tested
- A lapsed creator cannot republish: `api/publishing/`, `e2e/creator-courses`, `e2e/creator-webinar`, `api/billing/admin-waiver` (WAV-004).
- A payment arriving after a pause still grants access: `api/payments/webhook-*`.
- A refund removes access immediately: `api/security/refunded-access-links`, `api/ebooks/ebook-refund`, `api/workshops/workshop-refund`.
- A refunded student still counts as a student, and refunded courses disappear from My Learning: `e2e/student-journey`.
- Students sign up through the enroll popup, never `/login` (creator-only): `e2e/auth`, `e2e/course-enroll`.

## Deliberately NOT tested
- **Real gateway refunds.** Needs real Razorpay/Cashfree keys. Tests use fake keys and prove the gateway refusing leaves everything safe.
- **Stripe** and **real email sending** (RESEND key is left empty).
- **The Telegram and WhatsApp bots.** They live in their own repos. Only this app's token routes are tested.
- **Webhook timestamp freshness.** Not added on purpose: repeat events are already ignored ("Already processed"), and gateways re-send for hours or days, so a time limit could reject a real late payment.

## Known and accepted
- **Certificates are publicly readable** (the database allows anyone to read them). Decided as fine: they show a name, course and creator only. Revisit if the table ever holds an email or phone number.
- **Contact and feedback forms accept public inserts** (spam risk only, no data exposed).
- **Logged-in non-owners can still read `ebooks.pdf_storage_path`.** Needs a dashboard change to fix fully; the anonymous exposure is closed.
- **A creator can delete their own `creators` row** through the API.
- **Telegram/WhatsApp `create-token`:** a logged-in student only gets their own link, and an account that has a web login cannot be asked for without signing in. People with no web login (imported students on `/claim/telegram`) can still ask, so anyone who knows an imported student's phone or email could claim their link until a one-time-code check is added. The creator and "paid" status always come from our records (`api/security/create-token-trust`), and the save routes only accept tokens we issued (`save-token-binding`).

## Rules for writing tests
- Every test that seeds data calls `cleanup()` (and `cleanupProducts()` / `cleanupCheckout()` where used) in `afterAll`.
- Never wait for real time. Back-date rows with `daysAgo()`.
- Security tests use the clients in `helpers/clients.ts` (anon or signed in), never `db()`, which bypasses RLS.
- Test emails look like `kurso.test+...@example.com` so cleanup can find them.
- Never commit `.env.test`.