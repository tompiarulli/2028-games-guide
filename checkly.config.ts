import { defineConfig } from 'checkly'
import { Frequency } from 'checkly/constructs'

// Production monitoring as code: `pnpm checkly test` dry-runs it against ENVIRONMENT_URL,
// and the release workflow deploys it after each release.
export default defineConfig({
  projectName: '2028 Games Session Guide',
  logicalId: '28games',
  repoUrl: 'https://github.com/tompiarulli/2028-games-guide',
  checks: {
    activated: true,
    frequency: Frequency.EVERY_10M,
    locations: ['us-east-1', 'eu-west-1'],
    tags: ['28games'],
    checkMatch: '__checks__/**/*.check.ts',
    ignoreDirectoriesMatch: [
      'node_modules/**',
      '.output/**',
      '.vercel/**',
      '.claude/**',
      '.worktrees/**',
    ],
  },
  cli: {
    runLocation: 'us-east-1',
    retries: 1,
  },
})
