import 'dotenv/config'
import { createAnthropicClient } from './lib/anthropic-client.js'
import { RESEARCH_DEFAULT_MODEL } from './lib/claude-research.js'

// Confirms the pipeline can authenticate to the Claude API without spending
// anything: a model lookup is free. In GitHub Actions this exercises the full
// Workload Identity Federation exchange, so the data-refresh workflow runs it
// first and fails fast with a clear error instead of partway through a run.

const mode = process.env.ACTIONS_ID_TOKEN_REQUEST_URL
  ? 'workload identity federation'
  : 'local credentials'

try {
  const model = await createAnthropicClient().models.retrieve(RESEARCH_DEFAULT_MODEL)
  console.log(`Claude API access OK via ${mode} (${model.display_name})`)
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  console.error(`Claude API access FAILED via ${mode}: ${msg}`)
  if (process.env.ACTIONS_ID_TOKEN_REQUEST_URL) {
    console.error(
      'Check the repository variables and the federation rule; the deny reason is on the History tab of the Claude Console Workload identity page.',
    )
  }
  process.exit(1)
}
