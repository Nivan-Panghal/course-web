/**
 * Runs once before any test. Refuses to start unless everything points at the
 * TEST Supabase project. This is the only thing standing between a typo in
 * .env.test and a test run that deletes live data.
 */
import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'
import { need } from '../helpers/env'

export default async function globalSetup() {
  const testRef = need('TEST_SUPABASE_PROJECT_REF')
  const liveRef = need('LIVE_SUPABASE_PROJECT_REF')
  const url = need('NEXT_PUBLIC_SUPABASE_URL')

  if (testRef === liveRef) {
    throw new Error('SAFETY: TEST_SUPABASE_PROJECT_REF and LIVE_SUPABASE_PROJECT_REF are identical.')
  }
  const host = new URL(url).hostname
  if (host !== `${testRef}.supabase.co`) {
    throw new Error(`SAFETY: NEXT_PUBLIC_SUPABASE_URL (${host}) is not the test project (${testRef}). Aborting.`)
  }
  if (host.includes(liveRef)) {
    throw new Error('SAFETY: URL contains the LIVE project ref. Aborting.')
  }
  if (!need('NEXT_PUBLIC_SITE_URL').startsWith('http://localhost')) {
    throw new Error('SAFETY: NEXT_PUBLIC_SITE_URL must be localhost during tests.')
  }
  if (need('R2_BUCKET_NAME') === 'kurso-media') {
    throw new Error('SAFETY: R2_BUCKET_NAME is the live bucket. Use a test bucket.')
  }

  // Warn (names only) about live settings that would leak in from .env.local.
  const localPath = path.resolve(__dirname, '../../.env.local')
  if (fs.existsSync(localPath)) {
    const live = Object.keys(dotenv.parse(fs.readFileSync(localPath)))
    const missing = live.filter((k) => !(k in process.env) || process.env[k] === undefined)
    if (missing.length) {
      console.warn(
        `\n[tests] WARNING: these .env.local variables are NOT in .env.test, so the app will use LIVE values:\n  ${missing.join(', ')}\n` +
          '  Add each to .env.test (empty is fine) to block them.\n'
      )
    }
  }
  console.log(`\n[tests] Safety check passed. Using test project: ${testRef}\n`)
}