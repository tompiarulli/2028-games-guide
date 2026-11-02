import { Engine, Frequency, PlaywrightCheck } from 'checkly/constructs'

import { SITE, email, group } from './site'

// The same Playwright smoke tests CI runs, tagged @smoke, against the live site: the
// session list loads with its CSP, a filter narrows it, `?session=` links open (or say
// not found), unknown URLs 404, and nothing logs an error or trips the CSP.
new PlaywrightCheck('smoke', {
  name: 'Session guide smoke tests',
  playwrightConfigPath: '../playwright.config.ts',
  pwProjects: ['chromium'],
  pwTags: ['@smoke'],
  installCommand: 'pnpm install --frozen-lockfile',
  engine: Engine.node('24'),
  frequency: Frequency.EVERY_30M,
  locations: ['us-east-1'],
  group,
  alertChannels: [email],
  environmentVariables: [{ key: 'ENVIRONMENT_URL', value: SITE }],
})
