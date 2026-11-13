# Kurso tests

Everything here runs against the **kurso-test** Supabase project, never live.

## First-time setup
1. `copy .env.test.example .env.test` and fill it in.
2. `npx playwright install chromium`

## Commands
| Command | What it runs |
|---|---|
| `npm run test:smoke` | Phase 0 check that the machinery works |
| `npm run test:unit` | Pure logic (locks, commission math, phone format) |
| `npm run test:api` | API routes, webhooks, cron |
| `npm run test:integration` | Multi-step flows with the database |
| `npm run test:e2e` | Real browser journeys |
| `npm run test:report` | Opens the last HTML report |

## Folders
- `setup/` is the safety guard, which refuses to run unless the DB is the test project.
- `helpers/` holds seed data (factories), webhook signing, cron calls and time helpers.
- `smoke/`, `unit/`, `api/`, `integration/`, `e2e/` are the test types.

## Rules
- Every test that seeds data calls `cleanup()` in `afterAll`.
- Never wait for real time. Back-date rows with `daysAgo()`.
- Never commit `.env.test`.