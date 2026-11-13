import { defineConfig } from '@playwright/test'
import './tests/helpers/env' // loads .env.test into process.env

const PORT = 3100
const BASE_URL = `http://localhost:${PORT}`

export default defineConfig({
  testDir: './tests',
  globalSetup: './tests/setup/global-setup.ts',
  // One shared test database, so tests run one at a time.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // Each folder is a "project", so you can run one kind of test at a time.
  projects: [
    { name: 'smoke', testDir: './tests/smoke' },
    { name: 'unit', testDir: './tests/unit' },
    { name: 'api', testDir: './tests/api' },
    { name: 'integration', testDir: './tests/integration' },
    { name: 'e2e', testDir: './tests/e2e', use: { browserName: 'chromium' } },
  ],
  // Starts the app on its own port, forced onto the TEST database.
  // reuseExistingServer is false on purpose: a dev server you started earlier
  // may be pointing at your LIVE database.
  webServer: {
    command: `npx next dev -p ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 180_000,
    env: process.env as Record<string, string>,
  },
})