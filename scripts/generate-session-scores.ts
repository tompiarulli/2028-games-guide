import 'dotenv/config'
import Anthropic from '@anthropic-ai/sdk'
import pLimit from 'p-limit'

import {
  backfillInputHashes,
  chunk as chunkList,
  readAllSessions,
  readGroundingForSession,
  readStageStatus,
  readWritingForSession,
  upsertScoring,
} from './lib/content-store.js'
import { planScoring } from './lib/freshness.js'
import {
  ANTHROPIC_SCORING_DEFAULT_MODEL,
  type GroundingData,
  SCORING_BATCH_SIZE,
  SCORING_VERSION,
  type ScoringJob,
  type WritingData,
  buildCorrectionContext,
  generateScoring,
  generateScoringViaBatches,
} from './lib/session-content.js'
import { printUsageSummary } from './lib/usage.js'

const DEFAULT_CONCURRENCY = 2

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

async function main() {
  const scoringModel = getArgValue('--anthropic-model') ?? ANTHROPIC_SCORING_DEFAULT_MODEL
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
  console.log(`Scoring: anthropic ${scoringModel}  ${mode}`)

  const sessions = readAllSessions()
  const sessionMap = new Map(sessions.map((s) => [s.id, s]))
  console.log(`Loaded ${sessions.length} sessions from src/data/sessions.json`)

  const scoped = sportFilter ? sessions.filter((s) => s.sport === sportFilter) : sessions
  const plan = planScoring(scoped, scoringModel, forceAll)
  const targets = plan.targets
  console.log(
    `${targets.length} session(s) to score, ${plan.unchanged} unchanged since their last run`,
  )
  if (plan.blocked.length > 0) {
    console.log(
      `${plan.blocked.length} session(s) blocked — run pnpm generate:session-content first`,
    )
  }
  if (!dryRun) await backfillInputHashes('scoring', plan.backfill)

  if (dryRun) {
    for (const s of targets) console.log(`  [dry-run] ${s.id} (${s.sport})`)
    return
  }
  if (targets.length === 0) return

  const anthropicClient = new Anthropic({ apiKey: anthropicKey! })

  const bySport = groupBySport(targets)
  const sports = [...bySport.keys()].sort()
  const jobs: ScoringJob[] = []
  for (const sport of sports) {
    const list = bySport.get(sport)!
    for (const batch of chunkList(list, SCORING_BATCH_SIZE)) {
      const grounding = new Map<string, GroundingData>()
      const writing = new Map<string, WritingData>()
      for (const s of batch) {
        const g = readGroundingForSession(s.id)
        if (g?.facts) {
          grounding.set(s.id, {
            id: s.id,
            groundingFacts: g.facts,
            relatedNews: g.relatedNews,
            sources: g.sources ?? undefined,
          })
        }
        const w = readWritingForSession(s.id)
        if (w) {
          writing.set(s.id, {
            id: s.id,
            blurb: w.blurb,
            potentialContendersIntro: w.potentialContendersIntro ?? '',
            potentialContenders: w.potentialContenders,
          })
        }
      }
      const extraInstructions = buildCorrectionContext({
        sessionIds: batch.map((s) => s.id),
        sport,
      })
      jobs.push({ sport, batch, grounding, writing, extraInstructions })
    }
  }
  console.log(`${jobs.length} batch(es) across ${sports.length} sport(s)`)

  if (jobs.length === 0) return

  if (noBatch) {
    const limit = pLimit(concurrency)
    let done = 0
    await Promise.all(
      jobs.map((job) =>
        limit(async () => {
          const results = await generateScoring(
            anthropicClient,
            job.batch,
            job.sport,
            job.grounding,
            job.writing,
            scoringModel,
            job.extraInstructions,
          )
          const toUpsert = results
            .filter((r) => sessionMap.has(r.id))
            .map((r) => ({
              sessionId: r.id,
              scorecard: r.scorecard,
              inputHash: plan.hashes.get(r.id),
            }))
          await upsertScoring(toUpsert, {
            model: scoringModel,
            promptVersion: SCORING_VERSION,
            generatedAt: new Date().toISOString(),
          })
          done += 1
          const missing = job.batch.filter((s) => !toUpsert.find((r) => r.sessionId === s.id))
          const tail = missing.length > 0 ? ` ✗ missing ${missing.map((s) => s.id).join(',')}` : ''
          console.log(
            `  [${done}/${jobs.length}] ${job.sport} (${job.batch.length}) ✓ scored ${toUpsert.length}${tail}`,
          )
        }),
      ),
    )
  } else {
    await generateScoringViaBatches(anthropicClient, jobs, scoringModel, {
      onSportComplete: async ({ sport, outcomes, elapsedSec }) => {
        let scored = 0
        let failed = 0
        const missing: string[] = []
        const toUpsert: Parameters<typeof upsertScoring>[0] = []
        for (const { job, results, error } of outcomes) {
          if (error) {
            failed += 1
            for (const s of job.batch) missing.push(s.id)
            continue
          }
          const got = new Set<string>()
          for (const r of results) {
            if (!sessionMap.has(r.id)) continue
            toUpsert.push({
              sessionId: r.id,
              scorecard: r.scorecard,
              inputHash: plan.hashes.get(r.id),
            })
            got.add(r.id)
            scored += 1
          }
          for (const s of job.batch) if (!got.has(s.id)) missing.push(s.id)
          if (toUpsert.length > 0) {
            await upsertScoring(toUpsert.splice(0, toUpsert.length), {
              model: scoringModel,
              promptVersion: SCORING_VERSION,
              generatedAt: new Date().toISOString(),
            })
          }
        }
        const tail = missing.length > 0 ? ` ✗ missing ${missing.join(',')}` : ''
        const fail = failed > 0 ? ` (${failed} batch error(s))` : ''
        console.log(`    ✓ ${sport} done in ${elapsedSec}s — scored ${scored}${fail}${tail}`)
      },
    })
  }

  const finalStatus = readStageStatus()
  const scored = [...finalStatus.values()].filter(
    (s) => (s.scoringPromptVersion ?? -1) >= SCORING_VERSION,
  ).length
  printUsageSummary()
  console.log(`\nDone: ${scored} scored (v${SCORING_VERSION})`)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
