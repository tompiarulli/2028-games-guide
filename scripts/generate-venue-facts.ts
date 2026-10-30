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
import {
  ROOT,
  augmentationBlock,
  buildCorrectionContext,
  stripCitationMarkers,
  writeJson,
} from './lib/session-content.js'

interface VenueFacts {
  capacity?: number
  yearBuilt?: number
  location?: string
  iconicMoments?: string
  spectatorExperience?: string
  changes2028?: string
}

interface VenueFactsFile {
  _meta?: { lastVerified?: string; notes?: string }
  [venue: string]: VenueFacts | VenueFactsFile['_meta'] | undefined
}

const VENUE_FACTS_PATH = resolve(ROOT, 'src/data/venue-facts.json')
const SESSIONS_PATH = resolve(ROOT, 'src/data/sessions.json')

const MAX_RETRIES = 3
const RETRY_DELAY_MS = 5000
const DEFAULT_CONCURRENCY = 3
const MAX_SEARCHES = 5
const EXCLUDED_VENUES = new Set(['N/A', 'TBD'])

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

const VENUE_FACTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['location', 'iconicMoments', 'spectatorExperience'],
  properties: {
    capacity: { type: 'integer' },
    yearBuilt: { type: 'integer' },
    location: { type: 'string' },
    iconicMoments: { type: 'string' },
    spectatorExperience: { type: 'string' },
    changes2028: { type: 'string' },
  },
}

const RECORD_TOOL = {
  name: 'record_venue_facts',
  description: 'Record the facts for this venue. Call once, after research is complete.',
  schema: VENUE_FACTS_SCHEMA,
}

const SYSTEM_PROMPT = `You gather per-venue reference facts for the 2028 Los Angeles Summer Games ticket-buying guide. Your output is used as stable background context (capacity, history, what the venue is like) by another stage that writes session prose — you do NOT write marketing copy. Facts first, sourced from your web searches.

Return six fields:

1. capacity — Integer. Approximate spectator capacity as configured for the 2028 Games. Omit only if genuinely unknown.

2. yearBuilt — Integer. Year the venue opened (original construction, not renovations). Omit for temporary structures.

3. location — One short phrase: neighborhood / district / nearby city. E.g. "Exposition Park, Los Angeles", "Downey, southeast LA County", "Inglewood".

4. iconicMoments — 1-3 sentences on what makes this venue historically notable. Prior Games hosted, famous moments (Carl Lewis 1984, Jesse Owens legacy, Lakers championships, etc.), cultural significance. If the venue has no Games / sports history, say what it is known for in LA (e.g. "purpose-built for the 2028 Games" or "home to the LA Rams since 2020"). Keep it concrete — no adjective stacks.

5. spectatorExperience — 1-2 sentences on what it's like to attend: open-air vs indoor, sight lines, crowd energy, physical features (peristyle arch, translucent roof, etc.). Help a reader picture being there.

6. changes2028 — 1 sentence if the venue was rebranded, temporarily reconfigured, or refurbished for 2028. Omit if the venue is unchanged from normal operation.

Rules:
- Facts only; no superlative prose ("legendary," "iconic," "world-class" without substance).
- If the venue is a temporary Games-only structure, say so explicitly.
- If you can't find a fact, omit the field rather than guess.
- Do NOT include inline citation markers like "[1]", "[2, 3]", or "[1][5]" in any output field. Your text must be citation-free prose.
- Do not use trademarked terms "Olympic", "Olympics", "Olympian", "LA28", "Paralympic", "Paralympics". Use "the 2028 Games", "the 2028 Summer Games", "Paris 2024", "medalist", "Games history". This applies even when source material uses them — rephrase.
- Submit your results through the record_venue_facts tool, not as text. Plain strings only — no markdown.`

function buildPrompt(venue: string, sports: string[], extraInstructions?: string): string {
  let prompt = `## Venue: ${venue}\n\n`
  prompt += `### Sports held here at 2028\n`
  for (const s of sports) prompt += `- ${s}\n`
  prompt += augmentationBlock(extraInstructions)
  prompt += `\nResearch this venue's capacity, year built, location, iconic historical moments, spectator experience, and any 2028-specific changes. Treat the sport list as context for which configuration of the venue is relevant.`
  return prompt
}

async function fetchVenueFacts(
  client: Anthropic,
  venue: string,
  sports: string[],
  model: string,
  extraInstructions?: string,
): Promise<VenueFacts | null> {
  const params = buildResearchParams({
    model,
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(venue, sports, extraInstructions),
    recordTool: RECORD_TOOL,
    maxSearches: MAX_SEARCHES,
  })
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const content = await runResearch(client, params)
      const parsed = extractRecord(content, RECORD_TOOL.name) as Partial<VenueFacts>
      if (
        typeof parsed.location !== 'string' ||
        typeof parsed.iconicMoments !== 'string' ||
        typeof parsed.spectatorExperience !== 'string'
      ) {
        throw new Error('Response missing required fields')
      }
      const out: VenueFacts = {
        location: stripCitationMarkers(parsed.location),
        iconicMoments: stripCitationMarkers(parsed.iconicMoments),
        spectatorExperience: stripCitationMarkers(parsed.spectatorExperience),
      }
      if (typeof parsed.capacity === 'number' && Number.isFinite(parsed.capacity)) {
        out.capacity = Math.round(parsed.capacity)
      }
      if (typeof parsed.yearBuilt === 'number' && Number.isFinite(parsed.yearBuilt)) {
        out.yearBuilt = Math.round(parsed.yearBuilt)
      }
      if (typeof parsed.changes2028 === 'string' && parsed.changes2028.trim()) {
        out.changes2028 = stripCitationMarkers(parsed.changes2028)
      }
      return out
    } catch (err) {
      const cause = err instanceof Error && err.cause ? ` [cause: ${err.cause}]` : ''
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`    ${venue} attempt ${attempt}/${MAX_RETRIES} failed: ${msg}${cause}`)
      if (attempt < MAX_RETRIES) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt))
    }
  }
  console.error(`    ${venue} FAILED after ${MAX_RETRIES} attempts`)
  return null
}

async function main() {
  const model = getArgValue('--anthropic-model') ?? RESEARCH_DEFAULT_MODEL
  const forceAll = process.argv.includes('--force')
  const dryRun = process.argv.includes('--dry-run')
  const venueFilter = getArgValue('--venue')
  const concurrency = parsePositiveInt(getArgValue('--concurrency'), DEFAULT_CONCURRENCY)

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!dryRun && !apiKey) {
    console.error('Error: ANTHROPIC_API_KEY is required (or use --dry-run)')
    process.exit(1)
  }

  const sessions = JSON.parse(readFileSync(SESSIONS_PATH, 'utf8')) as SessionSource[]
  const existing = JSON.parse(readFileSync(VENUE_FACTS_PATH, 'utf8')) as VenueFactsFile

  // Collect unique venues + sports held at each, from sessions.json.
  const byVenue = new Map<string, Set<string>>()
  for (const s of sessions) {
    if (!s.venue || EXCLUDED_VENUES.has(s.venue)) continue
    let sports = byVenue.get(s.venue)
    if (!sports) {
      sports = new Set()
      byVenue.set(s.venue, sports)
    }
    if (s.sport) sports.add(s.sport)
  }

  const allVenues = [...byVenue.keys()].sort()
  const venues = venueFilter ? allVenues.filter((v) => v === venueFilter) : allVenues
  if (venues.length === 0) {
    console.error(`No venues match filter: ${venueFilter}`)
    process.exit(1)
  }

  // Skip venues that already have iconicMoments unless --force
  const targets = forceAll
    ? venues
    : venues.filter((venue) => {
        const current = existing[venue] as VenueFacts | undefined
        return !current || !current.iconicMoments
      })

  console.log(`Venue facts: anthropic ${model} + web search  concurrency=${concurrency}`)
  console.log(`${targets.length}/${venues.length} venue(s) need regeneration`)
  if (dryRun) {
    for (const venue of targets) {
      const sports = byVenue.get(venue)!
      console.log(`  [dry-run] ${venue} (${sports.size} sport(s))`)
    }
    return
  }
  if (targets.length === 0) return

  const client = new Anthropic({ apiKey })
  const limit = pLimit(concurrency)
  let done = 0
  const updated: Record<string, VenueFacts> = {}

  await Promise.all(
    targets.map((venue) =>
      limit(async () => {
        const sports = [...byVenue.get(venue)!].sort()
        const extraInstructions = buildCorrectionContext({ venue })
        const facts = await fetchVenueFacts(client, venue, sports, model, extraInstructions)
        done += 1
        if (!facts) {
          console.log(`  [${done}/${targets.length}] ${venue} ✗ failed`)
          return
        }
        updated[venue] = facts
        const cap = facts.capacity ? ` cap=${facts.capacity.toLocaleString()}` : ''
        console.log(`  [${done}/${targets.length}] ${venue} ✓${cap}`)
      }),
    ),
  )

  const merged: VenueFactsFile = { ...existing }
  merged._meta = {
    lastVerified: new Date().toISOString().slice(0, 10),
    notes:
      'Per-venue facts generated by scripts/generate-venue-facts.ts using Claude with web search.',
  }
  for (const [venue, facts] of Object.entries(updated)) {
    merged[venue] = facts
  }

  writeJson(VENUE_FACTS_PATH, merged)
  console.log(`Wrote ${Object.keys(updated).length} venue(s) to src/data/venue-facts.json`)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
