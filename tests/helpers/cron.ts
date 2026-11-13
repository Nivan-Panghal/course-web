/** Calls a cron route the way Vercel does: with the CRON_SECRET bearer token. */
import type { APIRequestContext } from '@playwright/test'
import { need } from './env'

export function runCron(request: APIRequestContext, route: string) {
  return request.get(route, { headers: { authorization: `Bearer ${need('CRON_SECRET')}` } })
}