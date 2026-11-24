# Third-party account setup

Every account below needs to exist, and every credential it produces goes
into the matching `.env.example` variable in the relevant repo. None of
these accounts transfer automatically with the code — each is a separate
account with its own owner, and stands up in the time noted.

## 1. Supabase (~10 minutes)
Create a project at supabase.com. All three repos connect to this one
project. From Project Settings → API, copy the URL, anon key, and
service-role key. The complete database (tables, row-level-security
policies, triggers and functions) is handed over with the sale — restore it
into your own project before running any repo. Keep a second, empty project
for the automated tests (see `tests/README.md`); never point tests at
production.

## 2. Cloudflare R2 (~10 minutes)
Create an R2 bucket in the Cloudflare dashboard, then an API token scoped
to that bucket (R2 → Manage API Tokens). This is where every course video,
PDF, and ebook file is actually stored.

## 3. Vercel — hosting `course-web` (~10 minutes)
Import the repo, set every variable from `course-web/.env.example`, deploy.
Seven daily cron jobs are already defined in `vercel.json` (subscription and
invoice sweeps, lesson and workshop reminders, module unlocks, inactivity
nudges, recording notices, chat retention) and start running automatically
once deployed. Set `CRON_SECRET` first: every job refuses calls without it.
Vercel limits how many cron jobs a plan allows, so check that your plan
covers seven.

Also create a free Upstash Redis database (upstash.com/redis) and copy its
REST URL and token into `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`.
Video streaming still works without it, but the abuse rate limiter and the
enrollment cache stay off.

## 4. Hosting the two bots (~15 minutes)
Any host that runs a persistent Node.js process works — Render and
Railway are both known to work, and either is a reasonable default if
you don't already have a preference. Two separate services, one per bot
repo. Set each repo's `.env.example` variables in that service's
environment. Both need to be reachable at a public URL — that URL is
what goes into `course-web`'s `WHATSAPP_BOT_URL` / `TELEGRAM_BOT_URL`.

**Whichever host you choose, use a plan that keeps the process running
continuously — not a free or trial tier that spins the service down
when idle.** See the note in `ARCHITECTURE.md` for why this specifically
breaks the reminder feature, not just performance.

## 5. Meta Business Manager + WhatsApp Cloud API (~1–2 hours, can take longer for verification)
This is the most involved setup step. In order:
1. Create a Meta Business Manager account (business.facebook.com) if one
   doesn't already exist.
2. Create an App at developers.facebook.com, add the "WhatsApp" product.
3. This provisions a test phone number automatically for development. For
   production, add and verify a real phone number under WhatsApp → API
   Setup, and complete Meta's business verification — this step is the one
   most likely to take real time (identity/business document review).
4. From API Setup, copy the Phone Number ID and generate a permanent
   System User access token (temporary tokens expire in 24 hours and are
   not usable for a live deployment). Also copy the App Secret (App
   settings, Basic) into `META_APP_SECRET`: the bot checks Meta's signature
   on every webhook and refuses all messages without it.
5. Set up the webhook: point it at `<your-whatsapp-bot-url>/webhook/whatsapp`.
   Pick `META_WEBHOOK_VERIFY_TOKEN` yourself — any random string works here,
   Meta has no character restriction, but a 32–64 character random value is
   good practice:

```bash
   openssl rand -hex 32
```

   Set that same value in both the bot's environment and Meta's webhook
   config field, then subscribe to the `messages` field.
   
6. Create and submit each message template this platform sends (see the
   template name variables in `Whatsapp-bot/.env.example`) for Meta's
   approval before they'll actually send in production.

**Important:** a WhatsApp Business phone number and its surrounding Meta
Business account are not something that transfers cleanly between two
unrelated businesses — Meta's transfer process requires business
verification on both sides and is not something most buyers of a codebase
will want to pursue. Expect a new owner to complete steps 1–6 themselves
under their own Meta Business account rather than inheriting an existing
one.

## 6. Telegram bot (~5 minutes)
Message @BotFather on Telegram, run `/newbot`, choose a name and username.
BotFather returns the bot token immediately.

Pick `TELEGRAM_WEBHOOK_SECRET` yourself — a random 32–64 character string,
letters, numbers, underscores, and hyphens only (Telegram rejects anything
else). Generate one with:

```bash
openssl rand -hex 32
```

Set it in the bot's environment, THEN register the webhook with that same
value included — this step matters, not just the env var:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=<your-telegram-bot-url>/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

**If `secret_token` is left out of this call, Telegram never sends the
verification header, and the bot will silently reject every single
incoming message with a 401** — it'll look completely broken with no
obvious cause. Setting the env var without this `setWebhook` call is not
enough.

## 7. Payment gateways
- **Platform's own Cashfree account** (for billing creators): sign up at
  cashfree.com as a registered business, complete KYC, get API
  credentials from the dashboard. This is separate from anything a
  creator sets up — it belongs to whoever operates the platform.
- **Creators bring their own** Cashfree, Razorpay, and/or Stripe account —
  no setup needed on the platform operator's side beyond having the
  connection flow working; each creator supplies their own credentials
  through their dashboard.

## 8. Resend (email) (~5 minutes)
Sign up at resend.com, verify a sending domain, generate an API key.

## 9. Gemini API key (~5 minutes)
Create a key at Google AI Studio (aistudio.google.com). It powers the AI
Doubt Assistant and the creator AI writing helper, and is the only AI key
you need. Two optional keys add resilience: `DEEPSEEK_API_KEY` is a
fallback when Gemini fails (Doubt Assistant and creator helper), and
`ANTHROPIC_API_KEY` enables a second stage of Q&A comment moderation (that
stage is skipped when unset).

## Hardcoded values to find and change

A few things are hardcoded to specific values that a new owner will want to
change:

- **`KURSO_URL`** in both bot repos — see `ARCHITECTURE.md`. Functionally
  required in both.
- **Support/contact email addresses** — `support@...` and `info@...`
  addresses are hardcoded directly into several pages and API routes
  (terms, privacy, refund policy, contact page, feedback route, contact
  route). Search the codebase for the current domain's email addresses and
  replace every occurrence.
- **`src/lib/brand.ts`** — a single exported constant, `LOGO_SRC`, is the
  one place the site logo image path is set. Change it there, not
  anywhere it's used.
- **`src/lib/certificate.ts`** — the brand name shown on generated
  certificates is a hardcoded string in this file.
- **Brand name as literal text** — the current product name appears as
  plain text (not a variable) in close to 200 places across the UI
  (certificates, loading screens, the watermark overlay, dashboard copy,
  and more). There's no single find-and-replace-safe way to rebrand
  without checking each occurrence's context, since a straight text
  replace would also hit unrelated strings. Budget real time for this if
  rebranding is planned.