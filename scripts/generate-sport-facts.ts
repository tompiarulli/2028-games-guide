import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import Anthropic from '@anthropic-ai/sdk'
import pLimit from 'p-limit'

import type { SessionSource } from '../src/types/session.js'
import {
  RESEARCH_DEFAULT_MODEL,
  buildResearchParams,
  extractRecord,
  runResearch,
} from './lib/claude-research.js'
import { getSportMedals, type ParisMedalsData } from './lib/paris-medals.js'
import {
  ROOT,
  augmentationBlock,
  buildCorrectionContext,
  containsBannedTerm,
  stripCitationMarkers,
  writeJson,
} from './lib/session-content.js'
import { printUsageSummary } from './lib/usage.js'

interface SportFacts {
  gamesContext: string
  parisRecap: string
}

interface SportFactsFile {
  _meta?: { lastVerified?: string; notes?: string }
  [sport: string]: SportFacts | SportFactsFile['_meta'] | undefined
}

const SPORT_FACTS_PATH = resolve(ROOT, 'src/data/sport-facts.json')
const SESSIONS_PATH = resolve(ROOT, 'src/data/sessions.json')
const MEDALS_PATH = resolve(ROOT, 'src/data/paris-2024-medals.json')

const MAX_RETRIES = 3
const RETRY_DELAY_MS = 5000
const DEFAULT_CONCURRENCY = 3
const MAX_SEARCHES = 5

function getArgValue(name: string): string | undefined {
  const prefix = `${name}=`
  const arg = process.argv.find((a) => a.startsWith(prefix))
  return arg ? arg.slice(prefix.length) : undefined
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) && n >= 1 ? n : fallback
}

const SPORT_FACTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['gamesContext', 'parisRecap'],
  properties: {
    gamesContext: { type: 'string' },
    parisRecap: { type: 'string' },
  },
}

const RECORD_TOOL = {
  name: 'record_sport_facts',
  description:
    'Record the gamesContext and parisRecap for this sport. Call once, after research is complete.',
  schema: SPORT_FACTS_SCHEMA,
}

const SYSTEM_PROMPT = `You gather per-sport reference facts for a 2028 Los Angeles Summer Games ticket-buying guide. Your output is used as background context by another stage that writes session-level prose — you do NOT write marketing copy. Keep everything factual, specific, and sourced from your web searches.

IMPORTANT SCOPE — venue metadata lives in a separate venue-facts.json file. Do NOT duplicate venue capacity, year built, location, or general history here. Anything you write should be sport-scoped.

Return two fields:

1. gamesContext — 2-4 short sentences on the sport's status at the 2028 Games: debut / returning / absent-since-year, format (tournament / qualifying → finals / time trials / etc.), how many medal events, notable storylines, and any format or event changes from Paris 2024. Do NOT describe venues here — venue metadata is handled separately.

2. parisRecap — 2-4 sentences summarizing Paris 2024 for this sport. Reference the authoritative medal block in the user prompt — do not invent different medalists. Mention defining storylines: who won what, any records, rivalries, upsets.

Rules:
- Do not state 2028 participation as confirmed. Names mentioned should be historical (Paris medalists) or clearly flagged as projected contenders.
- Do not name athletes who aren't in the Paris medal block unless you have a current source.
- If the user provides a Paris medal block, those gold/silver/bronze assignments are authoritative. Never substitute different athletes.
- Submit your results through the record_sport_facts tool, not as text. Plain strings only — no markdown.
- Do NOT include inline citation markers like "[1]", "[2, 3]", or "[1][5]" in any output field. Your text must be citation-free prose.
- Do not use trademarked terms "Olympic", "Olympics", "Olympian", "LA28", "Paralympic", "Paralympics" in any form. Use "the 2028 Games", "the 2028 Summer Games", "Paris 2024" (event name is acceptable as historical reference), "medalist", etc. This applies even when source material uses them — rephrase.`

function formatMedalist(m: { name: string; country: string } | null): string {
  if (!m) return 'n/a'
  return m.country ? `${m.name} (${m.country})` : m.name
}

function buildParisBlock(sport: string, medals: ParisMedalsData): string {
  const events = getSportMedals(medals, sport)
  if (!events || events.length === 0) {
    return `### Paris 2024 Medal Results\n(This sport was not contested at Paris 2024, or medal data is unavailable. Omit parisRecap references or clearly flag absence.)\n`
  }
  let out = `### Paris 2024 Medal Results (authoritative — do not contradict)\n`
  for (const e of events) {
    out += `${e.event}:\n`
    out += `  Gold: ${formatMedalist(e.gold)}\n`
    out += `  Silver: ${formatMedalist(e.silver)}\n`
    out += `  Bronze: ${formatMedalist(e.bronze)}\n`
  }
  return out
}

function buildPrompt(
  sport: string,
  events: string[],
  medals: ParisMedalsData,
  extraInstructions?: string,
): string {
  let prompt = `## Sport: ${sport}\n\n`
  prompt += `### Events (sampled from 2028 session schedule)\n`
  for (const e of events) prompt += `- ${e}\n`
  prompt += `\n${buildParisBlock(sport, medals)}\n`
  prompt += augmentationBlock(extraInstructions)
  prompt += `Use current web search (sport governing body, team/federation sources, reputable outlets) to produce gamesContext and parisRecap. Treat the Paris medal block as authoritative for historical results.`
  return prompt
}

async function fetchSportFacts(
  client: Anthropic,
  sport: string,
  events: string[],
  medals: ParisMedalsData,
  model: string,
  extraInstructions?: string,
): Promise<SportFacts | null> {
  const params = buildResearchParams({
    model,
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(sport, events, medals, extraInstructions),
    recordTool: RECORD_TOOL,
    maxSearches: MAX_SEARCHES,
  })
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const content = await runResearch(client, params)
      const parsed = extractRecord(content, RECORD_TOOL.name) as Partial<SportFacts>
      if (typeof parsed.gamesContext !== 'string' || typeof parsed.parisRecap !== 'string') {
        throw new Error('Response missing required fields')
      }
      if (containsBannedTerm(parsed.gamesContext) || containsBannedTerm(parsed.parisRecap)) {
        throw new Error('Response used a trademarked term')
      }
      return {
        gamesContext: stripCitationMarkers(parsed.gamesContext),
        parisRecap: stripCitationMarkers(parsed.parisRecap),
      }
    } catch (err) {
      const cause = err instanceof Error && err.cause ? ` [cause: ${err.cause}]` : ''
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`    ${sport} attempt ${attempt}/${MAX_RETRIES} failed: ${msg}${cause}`)
      if (attempt < MAX_RETRIES) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt))
    }
  }
  console.error(`    ${sport} FAILED after ${MAX_RETRIES} attempts`)
  return null
}

async function main() {
  const model = getArgValue('--anthropic-model') ?? RESEARCH_DEFAULT_MODEL
  const forceAll = process.argv.includes('--force')
  const dryRun = process.argv.includes('--dry-run')
  const sportFilter = getArgValue('--sport')
  const concurrency = parsePositiveInt(getArgValue('--concurrency'), DEFAULT_CONCURRENCY)

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!dryRun && !apiKey) {
    console.error('Error: ANTHROPIC_API_KEY is required (or use --dry-run)')
    process.exit(1)
  }

  const sessions = JSON.parse(readFileSync(SESSIONS_PATH, 'utf8')) as SessionSource[]
  const medals = JSON.parse(readFileSync(MEDALS_PATH, 'utf8')) as ParisMedalsData
  const existing = JSON.parse(readFileSync(SPORT_FACTS_PATH, 'utf8')) as SportFactsFile

  const bySport = new Map<string, { events: Set<string> }>()
  for (const s of sessions) {
    if (!s.sport) continue
    let entry = bySport.get(s.sport)
    if (!entry) {
      entry = { events: new Set() }
      bySport.set(s.sport, entry)
    }
    if (s.desc) {
      for (const phrase of s.desc
        .split(/[,;]/)
        .map((p) => p.trim())
        .filter(Boolean)) {
        entry.events.add(phrase)
      }
    }
  }

  const allSports = [...bySport.keys()].sort()
  const sports = sportFilter ? allSports.filter((s) => s === sportFilter) : allSports
  if (sports.length === 0) {
    console.error(`No sports match filter: ${sportFilter}`)
    process.exit(1)
  }

  // Skip sports that already have non-empty parisRecap unless --force
  const targets = forceAll
    ? sports
    : sports.filter((sport) => {
        const current = existing[sport] as SportFacts | undefined
        return !current || !current.parisRecap
      })

  console.log(`Sport facts: anthropic ${model} + web search  concurrency=${concurrency}`)
  console.log(`${targets.length}/${sports.length} sport(s) need regeneration`)
  if (dryRun) {
    for (const sport of targets) {
      const entry = bySport.get(sport)!
      console.log(`  [dry-run] ${sport}: events=${entry.events.size}`)
    }
    return
  }
  if (targets.length === 0) return

  const client = new Anthropic({ apiKey })
  const limit = pLimit(concurrency)
  let done = 0
  const updated: Record<string, SportFacts> = {}

  await Promise.all(
    targets.map((sport) =>
      limit(async () => {
        const entry = bySport.get(sport)!
        const events = [...entry.events].sort()
        const extraInstructions = buildCorrectionContext({ sport })
        const facts = await fetchSportFacts(client, sport, events, medals, model, extraInstructions)
        done += 1
        if (!facts) {
          console.log(`  [${done}/${targets.length}] ${sport} ✗ failed`)
          return
        }
        updated[sport] = facts
        console.log(`  [${done}/${targets.length}] ${sport} ✓`)
      }),
    ),
  )

  // Merge into existing file (preserve sports we didn't touch)
  const merged: SportFactsFile = { ...existing }
  merged._meta = {
    lastVerified: new Date().toISOString().slice(0, 10),
    notes:
      'Per-sport facts generated by scripts/generate-sport-facts.ts using Claude with web search, grounded on Paris 2024 medal results.',
  }
  for (const [sport, facts] of Object.entries(updated)) {
    merged[sport] = facts
  }

  printUsageSummary()
  writeJson(SPORT_FACTS_PATH, merged)
  console.log(`Wrote ${Object.keys(updated).length} sport(s) to src/data/sport-facts.json`)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
