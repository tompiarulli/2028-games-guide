import { defineConfig, devices } from '@playwright/test'

const PORT = 4173

// Smoke tests against the production build, served as Vercel serves it
// (scripts/serve-prod.mjs). Build it first with `pnpm build`. With ENVIRONMENT_URL set
// (Checkly runs the @smoke tests against production or a preview this way), they run
// against that site instead.
const target = process.env.ENVIRONMENT_URL

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: target ?? `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: target
    ? undefined
    : {
        command: 'node scripts/serve-prod.mjs',
        url: `http://localhost:${PORT}/`,
        env: { PORT: String(PORT) },
        reuseExistingServer: !process.env.CI,
      },
})
