import 'dotenv/config'
import Anthropic from '@anthropic-ai/sdk'
import pLimit from 'p-limit'

import {
  type GroundingEntry,
  chunk as chunkList,
  markGroundingChecked,
  readAllSessions,
  readGroundingForSession,
  readStageStatus,
  upsertGrounding,
} from './lib/content-store.js'
import {
  ANTHROPIC_GROUNDING_DEFAULT_MODEL,
  GROUNDING_BATCH_SIZE,
  GROUNDING_VERSION,
  type GroundingData,
  type GroundingJob,
  type PreviousBrief,
  buildCorrectionContext,
  fetchGroundingBatch,
  groundingCorrectionsHash,
  fetchGroundingViaBatches,
} from './lib/session-content.js'
import { printUsageSummary } from './lib/usage.js'

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

// Due when forced, missing, on an old prompt version, written before the
// session's current corrections, or (with --stale-days) not grounded or
// re-checked within that many days.
function needsGrounding(
  entry: GroundingEntry | null,
  correctionsHash: string | undefined,
  forceAll: boolean,
  staleBefore: string | null,
): boolean {
  if (forceAll || !entry) return true
  if (entry.promptVersion < GROUNDING_VERSION) return true
  if (entry.correctionsHash !== correctionsHash) return true
  if (!staleBefore) return false
  return (entry.checkedAt ?? entry.generatedAt) < staleBefore
}

function previousBrief(entry: GroundingEntry | null): PreviousBrief | undefined {
  if (!entry?.facts || entry.facts.length === 0) return undefined
  return {
    facts: entry.facts,
    newsTitles: entry.relatedNews.map((n) => n.title),
    gatheredAt: entry.generatedAt,
  }
}

async function main() {
  const model = getArgValue('--anthropic-model') ?? ANTHROPIC_GROUNDING_DEFAULT_MODEL
  const forceAll = process.argv.includes('--force')
  const dryRun = process.argv.includes('--dry-run')
  const noBatch = process.argv.includes('--no-batch')
  const sportFilter = getArgValue('--sport')
  const concurrency = parsePositiveInt(getArgValue('--concurrency'), DEFAULT_CONCURRENCY)
  // Without previous briefs, every target gets a full brief from scratch.
  const usePrevious = !process.argv.includes('--no-previous')
  const staleDaysArg = getArgValue('--stale-days')
  const staleDays = staleDaysArg ? parsePositiveInt(staleDaysArg, 0) : 0
  const staleBefore = staleDays ? new Date(Date.now() - staleDays * 86_400_000).toISOString() : null

  const anthropicKey = process.env.ANTHROPIC_API_KEY
  if (!dryRun && !anthropicKey) {
    console.error('Error: ANTHROPIC_API_KEY is required (or use --dry-run)')
    process.exit(1)
  }

  const mode = noBatch ? `sync concurrency=${concurrency}` : 'batches-api'
  console.log(`Grounding: anthropic ${model} + web search  ${mode}`)

  const sessions = readAllSessions()
  console.log(`Loaded ${sessions.length} sessions from src/data/sessions.json`)

  const correctionsHashes = new Map(sessions.map((s) => [s.id, groundingCorrectionsHash(s)]))
  const targets = sessions.filter((s) => {
    if (sportFilter && s.sport !== sportFilter) return false
    const entry = readGroundingForSession(s.id)
    return needsGrounding(entry, correctionsHashes.get(s.id), forceAll, staleBefore)
  })
  // Briefs written before the current corrections are rewritten from scratch.
  const previous = new Map<string, PreviousBrief>()
  let correctionChanges = 0
  for (const s of targets) {
    const entry = readGroundingForSession(s.id)
    if (entry && entry.correctionsHash !== correctionsHashes.get(s.id)) {
      correctionChanges += 1
      continue
    }
    const brief = usePrevious ? previousBrief(entry) : undefined
    if (brief) previous.set(s.id, brief)
  }
  console.log(
    `${targets.length} session(s) need grounding (${previous.size} re-checked against their previous brief, ${correctionChanges} rewritten for changed corrections)`,
  )

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
      jobs.push({ sport, batch, extraInstructions, previous })
    }
  }
  console.log(`${jobs.length} batch(es) across ${sports.length} sport(s)`)

  const client = new Anthropic({ apiKey: anthropicKey! })

  let changedTotal = 0
  let unchangedTotal = 0
  // Briefs with no material change keep their stored facts (and generatedAt),
  // so writing and scoring see identical inputs and skip those sessions.
  const save = async (results: GroundingData[]) => {
    const meta = {
      model,
      promptVersion: GROUNDING_VERSION,
      generatedAt: new Date().toISOString(),
    }
    const changed = results.filter((g) => g.materialChange !== false)
    const unchanged = results.filter((g) => g.materialChange === false).map((g) => g.id)
    changedTotal += changed.length
    unchangedTotal += unchanged.length
    await upsertGrounding(
      changed.map((g) => ({
        sessionId: g.id,
        facts: g.groundingFacts,
        relatedNews: g.relatedNews,
        sources: g.sources,
        correctionsHash: correctionsHashes.get(g.id),
      })),
      meta,
    )
    await markGroundingChecked(unchanged, meta)
  }

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
            job.previous,
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

  printUsageSummary()
  console.log(`\nUpdated ${changedTotal} brief(s); ${unchangedTotal} had no material change`)

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
