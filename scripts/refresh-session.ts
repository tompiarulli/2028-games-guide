import 'dotenv/config'
import Anthropic from '@anthropic-ai/sdk'

import {
  readGroundingForSession,
  readSessionById,
  readWritingForSession,
  upsertGrounding,
  upsertScoring,
  upsertWriting,
} from './lib/content-store.js'
import {
  ANTHROPIC_GROUNDING_DEFAULT_MODEL,
  ANTHROPIC_SCORING_DEFAULT_MODEL,
  ANTHROPIC_WRITING_DEFAULT_MODEL,
  GROUNDING_VERSION,
  type GroundingData,
  SCORING_VERSION,
  WRITING_VERSION,
  type WritingData,
  buildCorrectionContext,
  buildGroundingPrompt,
  buildScoringPrompt,
  buildWritingPrompt,
  fetchGrounding,
  generateScoring,
  generateWriting,
  groundingCorrectionsHash,
  scoringInputHash,
  writingInputHash,
} from './lib/session-content.js'
import { printUsageSummary } from './lib/usage.js'

interface ParsedArgs {
  sessionId?: string
  prompt?: string
  skipGrounding: boolean
  skipWriting: boolean
  skipScoring: boolean
  dryRun: boolean
  groundingModel: string
  writingModel: string
  scoringModel: string
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    skipGrounding: false,
    skipWriting: false,
    skipScoring: false,
    dryRun: false,
    groundingModel: ANTHROPIC_GROUNDING_DEFAULT_MODEL,
    writingModel: ANTHROPIC_WRITING_DEFAULT_MODEL,
    scoringModel: ANTHROPIC_SCORING_DEFAULT_MODEL,
  }
  const args = argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--prompt') {
      parsed.prompt = args[++i]
    } else if (arg.startsWith('--prompt=')) {
      parsed.prompt = arg.slice('--prompt='.length)
    } else if (arg === '--skip-grounding') {
      parsed.skipGrounding = true
    } else if (arg === '--skip-writing') {
      parsed.skipWriting = true
    } else if (arg === '--skip-scoring') {
      parsed.skipScoring = true
    } else if (arg === '--dry-run') {
      parsed.dryRun = true
    } else if (arg === '--anthropic-grounding-model') {
      parsed.groundingModel = args[++i]
    } else if (arg.startsWith('--anthropic-grounding-model=')) {
      parsed.groundingModel = arg.slice('--anthropic-grounding-model='.length)
    } else if (arg === '--anthropic-model') {
      parsed.writingModel = args[++i]
      parsed.scoringModel = parsed.writingModel
    } else if (arg.startsWith('--anthropic-model=')) {
      parsed.writingModel = arg.slice('--anthropic-model='.length)
      parsed.scoringModel = parsed.writingModel
    } else if (arg === '--anthropic-writing-model') {
      parsed.writingModel = args[++i]
    } else if (arg.startsWith('--anthropic-writing-model=')) {
      parsed.writingModel = arg.slice('--anthropic-writing-model='.length)
    } else if (arg === '--anthropic-scoring-model') {
      parsed.scoringModel = args[++i]
    } else if (arg.startsWith('--anthropic-scoring-model=')) {
      parsed.scoringModel = arg.slice('--anthropic-scoring-model='.length)
    } else if (!arg.startsWith('-') && !parsed.sessionId) {
      parsed.sessionId = arg
    } else {
      console.error(`Unknown argument: ${arg}`)
      process.exit(1)
    }
  }
  return parsed
}

function usage(): never {
  console.error(`Usage: pnpm refresh <sessionId> [options]

Regenerates blurb, contenders, and related news for a single session
and writes the updates back into the JSON content store under src/data/.

Options:
  --prompt <text>          Extra instructions appended to both grounding and writing prompts.
  --skip-grounding         Skip web-search grounding; reuse the grounding entry already in the store.
  --skip-writing           Skip Anthropic writing; only refresh grounding.
  --skip-scoring           Skip Anthropic scoring; leave the existing scorecard in place.
  --dry-run                Print resolved session and prompts, make no API calls.
  --anthropic-grounding-model <m> Grounding model (default: ${ANTHROPIC_GROUNDING_DEFAULT_MODEL}).
  --anthropic-writing-model <m>  Writing model (default: ${ANTHROPIC_WRITING_DEFAULT_MODEL}).
  --anthropic-scoring-model <m>  Scoring model (default: ${ANTHROPIC_SCORING_DEFAULT_MODEL}).
  --anthropic-model <m>          Apply one model to both writing and scoring.

Example:
  pnpm refresh ATH04
  pnpm refresh ATH04 --prompt "Noah Lyles withdrew due to injury"
  pnpm refresh ATH04 --skip-grounding --prompt "Tighten the blurb"
`)
  process.exit(1)
}

async function main() {
  const args = parseArgs(process.argv)
  if (!args.sessionId) usage()

  const anthropicKey = process.env.ANTHROPIC_API_KEY
  const needsApi = !args.skipGrounding || !args.skipWriting || !args.skipScoring
  if (!args.dryRun && needsApi && !anthropicKey) {
    console.error('Error: ANTHROPIC_API_KEY is required')
    process.exit(1)
  }

  const session = readSessionById(args.sessionId)
  if (!session) {
    console.error(`Error: session "${args.sessionId}" not found in src/data/sessions.json`)
    process.exit(1)
  }

  const existingGrounding = readGroundingForSession(session.id)
  const existingWriting = readWritingForSession(session.id)

  // Merge stored corrections (session + sport) with any --prompt CLI arg into a
  // single string fed into every stage as authoritative context.
  const extraInstructions = buildCorrectionContext({
    sessionIds: [session.id],
    sport: session.sport,
    cliPrompt: args.prompt,
  })

  console.log(`Session:       ${session.id} — ${session.name}`)
  console.log(`Sport/Venue:   ${session.sport} @ ${session.venue}`)
  console.log(`Date/Time:     ${session.date}, ${session.time}`)
  if (extraInstructions) {
    console.log(
      `\n--- Corrections + augmentation ---\n${extraInstructions}\n----------------------------------`,
    )
  }
  if (existingWriting?.blurb) {
    console.log(`\n--- Existing blurb ---\n${existingWriting.blurb}\n----------------------`)
  }

  if (args.dryRun) {
    console.log('\n[dry-run] Grounding prompt:')
    console.log(buildGroundingPrompt(session, session.sport, extraInstructions))
    console.log('\n[dry-run] Writing prompt:')
    console.log(buildWritingPrompt([session], session.sport, new Map(), extraInstructions))
    console.log('\n[dry-run] Scoring prompt:')
    console.log(
      buildScoringPrompt([session], session.sport, new Map(), new Map(), extraInstructions),
    )
    return
  }

  const anthropicClient = needsApi ? new Anthropic({ apiKey: anthropicKey! }) : null

  // Stage 1: Grounding
  let grounding: GroundingData | null = null
  if (!args.skipGrounding && anthropicClient) {
    console.log(`\n=== Stage 1: Grounding (${args.groundingModel} + web search) ===`)
    grounding = await fetchGrounding(
      anthropicClient,
      session,
      session.sport,
      args.groundingModel,
      extraInstructions,
    )
    if (!grounding) {
      console.error('Grounding failed; aborting.')
      process.exit(1)
    }
    console.log(
      `  ✓ facts:${grounding.groundingFacts.length} news:${grounding.relatedNews.length} sources:${grounding.sources?.length ?? 0}`,
    )
    await upsertGrounding(
      [
        {
          sessionId: session.id,
          facts: grounding.groundingFacts,
          relatedNews: grounding.relatedNews,
          sources: grounding.sources,
          correctionsHash: groundingCorrectionsHash(session),
        },
      ],
      {
        model: args.groundingModel,
        promptVersion: GROUNDING_VERSION,
        generatedAt: new Date().toISOString(),
      },
    )
  } else {
    console.log('\n=== Stage 1: Grounding (skipped) ===')
    if (existingGrounding && existingGrounding.facts) {
      grounding = {
        id: session.id,
        groundingFacts: existingGrounding.facts,
        relatedNews: existingGrounding.relatedNews,
        sources: existingGrounding.sources ?? undefined,
      }
    }
  }

  // Stage 2: Writing
  let writing: WritingData | null = null
  if (!args.skipWriting && anthropicClient) {
    console.log(`\n=== Stage 2: Writing (${args.writingModel}) ===`)
    const groundingMap = new Map<string, GroundingData>()
    if (grounding) groundingMap.set(session.id, grounding)
    const results = await generateWriting(
      anthropicClient,
      [session],
      session.sport,
      groundingMap,
      args.writingModel,
      extraInstructions,
    )
    writing = results.find((r) => r.id === session.id) ?? null
    if (!writing) {
      console.error('Writing failed; aborting.')
      process.exit(1)
    }
    console.log(
      `  ✓ blurb:${writing.blurb.length}ch contenders:${writing.potentialContenders.length}`,
    )
    await upsertWriting(
      [
        {
          sessionId: session.id,
          blurb: writing.blurb,
          potentialContendersIntro: writing.potentialContendersIntro || undefined,
          potentialContenders: writing.potentialContenders,
          inputHash: writingInputHash(session, grounding ?? undefined, args.writingModel),
        },
      ],
      {
        model: args.writingModel,
        promptVersion: WRITING_VERSION,
        generatedAt: new Date().toISOString(),
      },
    )
  } else {
    console.log('\n=== Stage 2: Writing (skipped) ===')
    if (existingWriting) {
      writing = {
        id: session.id,
        blurb: existingWriting.blurb,
        potentialContendersIntro: existingWriting.potentialContendersIntro ?? '',
        potentialContenders: existingWriting.potentialContenders,
      }
    }
  }

  // Stage 3: Scoring
  if (!args.skipScoring && anthropicClient) {
    console.log(`\n=== Stage 3: Scoring (${args.scoringModel}) ===`)
    const groundingMap = new Map<string, GroundingData>()
    if (grounding) groundingMap.set(session.id, grounding)
    const writingMap = new Map<string, WritingData>()
    if (!writing) {
      console.error('No blurb available for scoring (run without --skip-writing or seed content).')
      process.exit(1)
    }
    writingMap.set(session.id, writing)
    const results = await generateScoring(
      anthropicClient,
      [session],
      session.sport,
      groundingMap,
      writingMap,
      args.scoringModel,
      extraInstructions,
    )
    const scoring = results.find((r) => r.id === session.id) ?? null
    if (!scoring) {
      console.error('Scoring failed; aborting.')
      process.exit(1)
    }
    const sc = scoring.scorecard
    console.log(
      `  ✓ Sig${sc.significance.score} Exp${sc.experience.score} Star${sc.starPower.score} Uniq${sc.uniqueness.score} Dem${sc.demand.score} = ${sc.aggregate}`,
    )
    const inputHash = scoringInputHash(session, grounding ?? undefined, writing, args.scoringModel)
    await upsertScoring([{ sessionId: session.id, scorecard: scoring.scorecard, inputHash }], {
      model: args.scoringModel,
      promptVersion: SCORING_VERSION,
      generatedAt: new Date().toISOString(),
    })
  } else {
    console.log('\n=== Stage 3: Scoring (skipped) ===')
  }

  printUsageSummary()

  if (writing) {
    console.log(`\n--- Current blurb ---\n${writing.blurb}\n---------------------`)
  }
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
