import 'dotenv/config'
import Anthropic from '@anthropic-ai/sdk'
import pLimit from 'p-limit'

import {
  chunk as chunkList,
  readAllSessions,
  readStageStatus,
  upsertGrounding,
  type StageStatus,
} from './lib/content-store.js'
import {
  ANTHROPIC_GROUNDING_DEFAULT_MODEL,
  GROUNDING_BATCH_SIZE,
  GROUNDING_VERSION,
  type GroundingData,
  type GroundingJob,
  buildCorrectionContext,
  fetchGroundingBatch,
  fetchGroundingViaBatches,
} from './lib/session-content.js'

// Sync (--no-batch) web-search turns run ~1-3 minutes each; 3 in flight keeps
// tier-1 input TPM comfortable once search results land in context.
const DEFAULT_CONCURRENCY = 3

function getArgValue(name: string): string | undefined {
  const prefix = `${name}=`
  const arg = process.argv.find((a) => a.startsWith(prefix))
  return arg ? arg.slice(prefix.length) : undefined
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const n = Number.parseInt(value, 10)
  if (!Number.isFinite(n) || n < 1) return fallback
  return n
}

function groupBySport<T extends { sport: string }>(items: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const s of items) {
    const list = groups.get(s.sport)
    if (list) list.push(s)
    else groups.set(s.sport, [s])
  }
  return groups
}

function needsGrounding(status: StageStatus | undefined, forceAll: boolean): boolean {
  if (forceAll) return true
  if (!status) return true
  return (status.groundingPromptVersion ?? -1) < GROUNDING_VERSION
}

async function main() {
  const model = getArgValue('--anthropic-model') ?? ANTHROPIC_GROUNDING_DEFAULT_MODEL
  const forceAll = process.argv.includes('--force')
  const dryRun = process.argv.includes('--dry-run')
  const noBatch = process.argv.includes('--no-batch')
  const sportFilter = getArgValue('--sport')
  const concurrency = parsePositiveInt(getArgValue('--concurrency'), DEFAULT_CONCURRENCY)

  const anthropicKey = process.env.ANTHROPIC_API_KEY
  if (!dryRun && !anthropicKey) {
    console.error('Error: ANTHROPIC_API_KEY is required (or use --dry-run)')
    process.exit(1)
  }

  const mode = noBatch ? `sync concurrency=${concurrency}` : 'batches-api'
  console.log(`Grounding: anthropic ${model} + web search  ${mode}`)

  const sessions = readAllSessions()
  const stageStatus = readStageStatus()
  console.log(`Loaded ${sessions.length} sessions from src/data/sessions.json`)

  const targets = sessions.filter((s) => {
    if (sportFilter && s.sport !== sportFilter) return false
    return needsGrounding(stageStatus.get(s.id), forceAll)
  })
  console.log(`${targets.length} session(s) need grounding`)

  if (dryRun) {
    for (const s of targets) console.log(`  [dry-run] ${s.id} (${s.sport})`)
    return
  }
  if (targets.length === 0) return

  const bySport = groupBySport(targets)
  const sports = [...bySport.keys()].sort()
  const jobs: GroundingJob[] = []
  for (const sport of sports) {
    const list = bySport.get(sport)!
    for (const batch of chunkList(list, GROUNDING_BATCH_SIZE)) {
      const extraInstructions = buildCorrectionContext({
        sessionIds: batch.map((s) => s.id),
        sport,
      })
      jobs.push({ sport, batch, extraInstructions })
    }
  }
  console.log(`${jobs.length} batch(es) across ${sports.length} sport(s)`)

  const client = new Anthropic({ apiKey: anthropicKey! })

  const save = (results: GroundingData[]) =>
    upsertGrounding(
      results.map((g) => ({
        sessionId: g.id,
        facts: g.groundingFacts,
        relatedNews: g.relatedNews,
        sources: g.sources,
      })),
      { model, promptVersion: GROUNDING_VERSION, generatedAt: new Date().toISOString() },
    )

  if (noBatch) {
    const limit = pLimit(concurrency)
    let done = 0
    await Promise.all(
      jobs.map((job) =>
        limit(async () => {
          const results = await fetchGroundingBatch(
            client,
            job.batch,
            job.sport,
            model,
            job.extraInstructions,
          )
          await save(results)
          done += 1
          const got = new Set(results.map((r) => r.id))
          const missing = job.batch.filter((s) => !got.has(s.id))
          const tail = missing.length > 0 ? ` ✗ missing ${missing.map((s) => s.id).join(',')}` : ''
          console.log(
            `  [${done}/${jobs.length}] ${job.sport} (${job.batch.length}) ✓ ${results.length} grounded${tail}`,
          )
        }),
      ),
    )
  } else {
    await fetchGroundingViaBatches(client, jobs, model, {
      onSportComplete: async ({ sport, outcomes, elapsedSec }) => {
        let grounded = 0
        const missing: string[] = []
        const errors = new Set<string>()
        for (const { job, results, error } of outcomes) {
          if (error) errors.add(error)
          await save(results)
          grounded += results.length
          const got = new Set(results.map((r) => r.id))
          for (const s of job.batch) if (!got.has(s.id)) missing.push(s.id)
        }
        const tail = missing.length > 0 ? ` ✗ missing ${missing.join(',')}` : ''
        const fail = errors.size > 0 ? ` (${[...errors].join('; ')})` : ''
        console.log(`    ✓ ${sport} done in ${elapsedSec}s — grounded ${grounded}${fail}${tail}`)
      },
    })
  }

  const finalStatus = readStageStatus()
  const grounded = [...finalStatus.values()].filter(
    (s) => (s.groundingPromptVersion ?? -1) >= GROUNDING_VERSION,
  ).length
  const remaining = sessions.length - grounded
  console.log(`\nDone: ${grounded} grounded (v${GROUNDING_VERSION})`)
  if (remaining > 0 && !sportFilter) {
    console.log(
      `${remaining} session(s) still due — rerun to retry them (add --no-batch if they keep failing)`,
    )
  }
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
