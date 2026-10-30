import 'dotenv/config'
import Anthropic from '@anthropic-ai/sdk'
import pLimit from 'p-limit'

import {
  chunk as chunkList,
  readAllSessions,
  readGroundingForSession,
  readStageStatus,
  upsertWriting,
  type StageStatus,
} from './lib/content-store.js'
import {
  ANTHROPIC_WRITING_DEFAULT_MODEL,
  GROUNDING_VERSION,
  type GroundingData,
  WRITING_BATCH_SIZE,
  WRITING_VERSION,
  type WritingJob,
  buildCorrectionContext,
  generateWriting,
  generateWritingViaBatches,
} from './lib/session-content.js'

// Sync (--no-batch) mode only: output TPM is the binding constraint on low
// tiers, and adaptive thinking adds output on top of the ~2.5k-token answer.
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

function needsWriting(status: StageStatus | undefined, forceAll: boolean): boolean {
  if (forceAll) return true
  if (!status) return true
  return (status.writingPromptVersion ?? -1) < WRITING_VERSION
}

async function main() {
  const writingModel = getArgValue('--anthropic-model') ?? ANTHROPIC_WRITING_DEFAULT_MODEL
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
  console.log(`Writing: anthropic ${writingModel}  ${mode}`)

  const sessions = readAllSessions()
  const sessionMap = new Map(sessions.map((s) => [s.id, s]))
  const stageStatus = readStageStatus()
  console.log(`Loaded ${sessions.length} sessions from src/data/sessions.json`)

  const targets = sessions.filter((s) => {
    if (sportFilter && s.sport !== sportFilter) return false
    const st = stageStatus.get(s.id)
    if (!needsWriting(st, forceAll)) return false
    // Require grounding at current version — writing depends on session-facts.
    return (st?.groundingPromptVersion ?? -1) >= GROUNDING_VERSION
  })
  const blocked = sessions.filter((s) => {
    if (sportFilter && s.sport !== sportFilter) return false
    const st = stageStatus.get(s.id)
    return needsWriting(st, forceAll) && (st?.groundingPromptVersion ?? -1) < GROUNDING_VERSION
  })
  console.log(`${targets.length} session(s) ready for writing`)
  if (blocked.length > 0) {
    console.log(`${blocked.length} session(s) blocked — run pnpm generate:session-facts first`)
  }

  if (dryRun) {
    for (const s of targets) console.log(`  [dry-run] ${s.id} (${s.sport})`)
    return
  }
  if (targets.length === 0) return

  const anthropicClient = new Anthropic({ apiKey: anthropicKey! })

  const groundingByid = new Map<string, GroundingData>()
  for (const s of targets) {
    const g = readGroundingForSession(s.id)
    if (g?.facts) {
      groundingByid.set(s.id, {
        id: s.id,
        groundingFacts: g.facts,
        relatedNews: g.relatedNews,
        sources: g.sources ?? undefined,
      })
    }
  }

  const bySport = groupBySport(targets)
  const sports = [...bySport.keys()].sort()
  const jobs: WritingJob[] = []
  for (const sport of sports) {
    const list = bySport.get(sport)!
    for (const batch of chunkList(list, WRITING_BATCH_SIZE)) {
      const grounding = new Map<string, GroundingData>()
      for (const s of batch) {
        const g = groundingByid.get(s.id)
        if (g) grounding.set(s.id, g)
      }
      const extraInstructions = buildCorrectionContext({
        sessionIds: batch.map((s) => s.id),
        sport,
      })
      jobs.push({ sport, batch, grounding, extraInstructions })
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
          const results = await generateWriting(
            anthropicClient,
            job.batch,
            job.sport,
            job.grounding,
            writingModel,
            job.extraInstructions,
          )
          const toUpsert = results
            .filter((r) => sessionMap.has(r.id))
            .map((r) => ({
              sessionId: r.id,
              blurb: r.blurb,
              potentialContendersIntro: r.potentialContendersIntro || undefined,
              potentialContenders: r.potentialContenders,
            }))
          await upsertWriting(toUpsert, {
            model: writingModel,
            promptVersion: WRITING_VERSION,
            generatedAt: new Date().toISOString(),
          })
          done += 1
          const missing = job.batch.filter((s) => !toUpsert.find((w) => w.sessionId === s.id))
          const tail = missing.length > 0 ? ` ✗ missing ${missing.map((s) => s.id).join(',')}` : ''
          console.log(
            `  [${done}/${jobs.length}] ${job.sport} (${job.batch.length}) ✓ wrote ${toUpsert.length}${tail}`,
          )
        }),
      ),
    )
  } else {
    await generateWritingViaBatches(anthropicClient, jobs, writingModel, {
      onSportComplete: async ({ sport, outcomes, elapsedSec }) => {
        let wrote = 0
        let failed = 0
        const missing: string[] = []
        const toUpsert: Parameters<typeof upsertWriting>[0] = []
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
              blurb: r.blurb,
              potentialContendersIntro: r.potentialContendersIntro || undefined,
              potentialContenders: r.potentialContenders,
            })
            got.add(r.id)
            wrote += 1
          }
          for (const s of job.batch) if (!got.has(s.id)) missing.push(s.id)
          if (toUpsert.length > 0) {
            await upsertWriting(toUpsert.splice(0, toUpsert.length), {
              model: writingModel,
              promptVersion: WRITING_VERSION,
              generatedAt: new Date().toISOString(),
            })
          }
        }
        const tail = missing.length > 0 ? ` ✗ missing ${missing.join(',')}` : ''
        const fail = failed > 0 ? ` (${failed} batch error(s))` : ''
        console.log(`    ✓ ${sport} done in ${elapsedSec}s — wrote ${wrote}${fail}${tail}`)
      },
    })
  }

  const finalStatus = readStageStatus()
  const written = [...finalStatus.values()].filter(
    (s) => (s.writingPromptVersion ?? -1) >= WRITING_VERSION,
  ).length
  console.log(`\nDone: ${written} written (v${WRITING_VERSION})`)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
