import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type Anthropic from '@anthropic-ai/sdk'
import type {
  ContentBlock,
  MessageCreateParamsNonStreaming,
  TextBlockParam,
} from '@anthropic-ai/sdk/resources/messages'
import pLimit from 'p-limit'

import type { SportFacts } from '../../src/data/sport-facts.js'
import type { VenueFacts } from '../../src/data/venue-facts.js'
import type {
  Contender,
  ContentSource,
  RelatedNews,
  Scorecard,
  ScorecardDimension,
  SessionSource,
} from '../../src/types/session.js'
import {
  RESEARCH_DEFAULT_MODEL,
  buildResearchParams,
  extractRecord,
  extractSearchSources,
  runResearch,
} from './claude-research.js'
import {
  readSessionCorrections,
  readSportCorrections,
  readVenueCorrections,
} from './content-store.js'
import {
  getSportMedals,
  matchSessionEvents,
  type ParisMedalEvent,
  type ParisMedalsData,
} from './paris-medals.js'
import { recordUsage } from './usage.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const ROOT = resolve(__dirname, '..', '..')

const rawSportFacts = JSON.parse(readFileSync(resolve(ROOT, 'src/data/sport-facts.json'), 'utf8'))
const { _meta: _, ...sportFactEntries } = rawSportFacts
const SPORT_FACTS = sportFactEntries as Record<string, SportFacts>

const rawVenueFacts = JSON.parse(readFileSync(resolve(ROOT, 'src/data/venue-facts.json'), 'utf8'))
const { _meta: __, ...venueFactEntries } = rawVenueFacts
const VENUE_FACTS = venueFactEntries as Record<string, VenueFacts>

const PARIS_MEDALS = JSON.parse(
  readFileSync(resolve(ROOT, 'src/data/paris-2024-medals.json'), 'utf8'),
) as ParisMedalsData

export const ANTHROPIC_GROUNDING_DEFAULT_MODEL = RESEARCH_DEFAULT_MODEL
export const ANTHROPIC_WRITING_DEFAULT_MODEL = 'claude-sonnet-5-5'
export const ANTHROPIC_SCORING_DEFAULT_MODEL = 'claude-haiku-5-5'
// Both models think adaptively by default; thinking counts toward max_tokens.
// Effort is set explicitly (these match each model's default) so a model swap
// doesn't silently change how much the stage thinks.
const WRITING_EFFORT = 'high'
const SCORING_EFFORT = 'medium'
const WRITING_MAX_TOKENS = 16000
const SCORING_MAX_TOKENS = 16000
export const GROUNDING_VERSION = 3
export const WRITING_VERSION = 4
export const SCORING_VERSION = 6
export const MAX_RETRIES = 3
export const RETRY_DELAY_MS = 5000
export const MAX_NEWS_ITEMS = 10
// Sessions of one sport share most of their searches (same athletes, same
// rankings), so larger batches cut duplicate searches and repeated context.
export const GROUNDING_BATCH_SIZE = 20
// Web search cap per grounding request ($10 per 1,000 searches). A batch request
// covers up to GROUNDING_BATCH_SIZE sessions of one sport.
export const GROUNDING_BATCH_MAX_SEARCHES = 15
// Room for up to 20 full briefs in one record_grounding call, plus thinking.
const GROUNDING_BATCH_MAX_TOKENS = 32000
export const GROUNDING_SINGLE_MAX_SEARCHES = 5
export const WRITING_BATCH_SIZE = 15
export const SCORING_BATCH_SIZE = 15

export const SCORE_WEIGHTS = {
  significance: 0.3,
  experience: 0.25,
  starPower: 0.15,
  uniqueness: 0.15,
  demand: 0.15,
} as const

export function computeAggregate(
  sig: number,
  exp: number,
  star: number,
  uniq: number,
  dem: number,
): number {
  const raw =
    sig * SCORE_WEIGHTS.significance +
    exp * SCORE_WEIGHTS.experience +
    star * SCORE_WEIGHTS.starPower +
    uniq * SCORE_WEIGHTS.uniqueness +
    dem * SCORE_WEIGHTS.demand
  return Math.round(raw * 10) / 10
}

export interface GroundingData {
  id: string
  groundingFacts: string[]
  relatedNews: RelatedNews[]
  sources?: ContentSource[]
  // Set by grounding when a previous brief was supplied: false means nothing
  // material changed and the stored brief should be kept as-is.
  materialChange?: boolean
}

// The stored brief for a session, fed back into grounding so Claude can report
// "no material change" instead of rewording the same facts.
export interface PreviousBrief {
  facts: string[]
  newsTitles: string[]
  gatheredAt: string
}

export interface WritingData {
  id: string
  blurb: string
  potentialContendersIntro: string
  potentialContenders: Contender[]
}

export interface ScoringData {
  id: string
  scorecard: Scorecard
}

// Strict tool schemas don't support maxItems; normalizeRelatedNews caps the
// list at MAX_NEWS_ITEMS instead.
const GROUNDING_SESSION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'materialChange', 'groundingFacts', 'relatedNews'],
  properties: {
    id: { type: 'string' },
    materialChange: { type: 'boolean' },
    groundingFacts: {
      type: 'array',
      items: { type: 'string' },
    },
    relatedNews: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'summary', 'sourceName', 'sourceUrl', 'publishedDate', 'tags'],
        properties: {
          title: { type: 'string' },
          summary: { type: 'string' },
          sourceName: { type: 'string' },
          sourceUrl: { type: 'string' },
          publishedDate: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
}

const RECORD_GROUNDING_TOOL = {
  name: 'record_grounding',
  description:
    'Record the grounding brief for every session in the request. Call once, after research is complete.',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['sessions'],
    properties: {
      sessions: {
        type: 'array',
        items: GROUNDING_SESSION_SCHEMA,
      },
    },
  },
}

/**
 * Trademarked terms that must NEVER appear in generated content.
 * These are protected by the USOPC under the Ted Stevens Olympic and Amateur Sports Act
 * and various USPTO registrations. Use the approved alternatives instead.
 */
export const BANNED_TRADEMARK_TERMS = [
  'LA28',
  'LA 28',
  'Olympic',
  'Olympics',
  'Olympian',
  'Paralympic',
  'Paralympics',
  'Paralympian',
  'Olympic Games',
  'Paralympic Games',
  'Olympiad',
  'Citius Altius Fortius',
] as const

// Code-level backstop for the prompt rule below: the models occasionally use
// these terms anyway, so reader-facing output that contains one is rejected.
const BANNED_TERM_PATTERN = /\b(?:olympi\w*|paralympi\w*|la ?28|citius altius fortius)\b/i

export function containsBannedTerm(text: string): boolean {
  return BANNED_TERM_PATTERN.test(text)
}

const BANNED_TERMS_BLOCK = `
TRADEMARK RESTRICTION — CRITICAL:
The following terms are trademarked and must NEVER appear in your output, in any form (including as adjectives, in compound words, or in quotes):
${BANNED_TRADEMARK_TERMS.map((t) => `  - "${t}"`).join('\n')}

Instead use generic alternatives:
  - "the 2028 Games" or "the 2028 Summer Games" or "the Games" (not "the Olympics" or "the Olympic Games")
  - "2028 Los Angeles" or "LA 2028" → "the 2028 Games" or "the 2028 Los Angeles Summer Games"
  - "Olympic athlete" → "world-class athlete" or "Games competitor"
  - "Olympic medal" → "gold/silver/bronze medal" or just "medal"
  - "Olympic record" → "Games record"
  - "Olympic history" → "Games history" or "historical results"
  - "Olympian" → "medalist" or "Games veteran"
  - For Paris 2024 references, say "Paris 2024" (the event name itself is acceptable as historical reference, but don't use "Olympic" as a modifier)
If any source material contains these terms, rephrase when incorporating into your output.
`

export const GROUNDING_SYSTEM_PROMPT = `You gather current, cited facts for 2028 Los Angeles Summer Games session entries. You do NOT write prose for readers — another stage handles that. Your job is to produce a structured grounding brief and a short list of relevant recent news.

For each session you will return:

1. groundingFacts — 5-15 short factual bullets that a writer will use. Each bullet is one sentence, plain text, factual, and sourced from your web searches. Cover:
   - Likely contenders (athletes for individual sports, teams for team sports) with recent results, world rankings, or Paris 2024 finish.
   - Known 2028 Games-specific info: qualification status, roster announcements, venue updates, schedule changes.
   - Athlete status: retirements, injuries, pregnancies, public statements about the 2028 Games, comebacks.
   - Recent performance: major 2024-2026 results relevant to this session's event.
   - Any notable storyline (rivalry, record pursuit, comeback) that a writer could lean on.
   Each bullet must be standalone and fact-shaped — no opinion, no superlatives, no prose flourish. If uncertain, hedge plainly ("Ohtani has not publicly confirmed whether he will play in the 2028 Games as of Oct 2025.").

2. relatedNews — 0 to ${MAX_NEWS_ITEMS} recent news articles directly relevant to this session. Pull only from your search results. Include title, one-sentence summary of why it matters, sourceName, canonical sourceUrl, ISO publishedDate (YYYY-MM-DD), and 1-4 kebab-case tags. Prioritize 2028 Games-specific news, then recent form of probable contenders. Skip generic sport news. Empty array is fine if nothing fits.

3. materialChange — Some sessions include a "Previous brief" gathered earlier. For those, research whether anything material has changed since then: new results or rankings, roster, injury, or retirement news, schedule or venue changes, or new relevant articles. If nothing material has changed, set materialChange to false and return empty groundingFacts and relatedNews; the previous brief is kept as-is. If something has changed, set materialChange to true and return a complete, updated brief, carrying forward previous facts that are still accurate. A session without a previous brief always gets materialChange true and a full brief.

Rules:
- Do not fabricate URLs, titles, dates, or outlets. If you don't have a source, don't include the fact.
- Do not write marketing prose — facts only.
- Do not speculate as fact. Speculation must be labeled ("projected to contend," "expected based on 2025 form").
- If a "Paris 2024 Medal Results" block is present in the user prompt, treat those medalists as authoritative historical facts. Never contradict them, never substitute other athletes in place of the listed gold/silver/bronze. You may still cite other sources for surrounding context.
- If a "User correction / additional context" block is present in the user prompt, treat it as authoritative — it represents a human-provided fact or correction that supersedes conflicting search results. Still cite sources for other facts.
- Submit your results through the record_grounding tool, not as text. Plain strings only — no markdown and no inline citation markers like "[1]".
${BANNED_TERMS_BLOCK}`

export const WRITING_SYSTEM_PROMPT = `You are writing session blurbs for a 2028 Los Angeles Summer Games ticket-buying guide. Readers are deciding whether to attend; give them a flavorful picture of what the session actually is and why it could be worth watching.

You will receive a batch of sessions for one sport. For each session you'll get:
- The session's basic facts (name, description, round, venue, date/time).
- Sport-level background (venue notes, event highlights, known athletes).
- A "groundingFacts" list gathered from recent web searches — use these as your authoritative source for current information (rosters, injuries, recent results, 2028 Games status).

Ground truth: the Games are still ahead. Venues, event formats, and prior results (Paris 2024, World Championships, etc.) are confirmed facts. 2028 rosters, participation, and medal outcomes are not. Your writing should be clear about which is which — state confirmed things plainly; flag speculation as speculation with words like "projected," "likely," "expected," or "if [athlete] competes."

Produce three fields per session:

1. blurb — two to four short paragraphs separated by blank lines (two newlines between each). Each paragraph is 1-2 sentences, max ~35 words. Keep paragraphs tight and scannable — readers are skimming, not reading a magazine feature. Total length: 3-6 short sentences across all paragraphs.

   Structure guideline (vary the exact framing — don't follow this template rigidly):
   - Opening paragraph: what the session is and why it matters. Lead with a hook.
   - Middle paragraph(s): concrete specifics — event format, stakes, storylines, athlete/team angles (qualified honestly), or notable current context.
   - Closing paragraph: venue/live-experience feel — what it's like to be there.

   Lean into concrete specifics: venue geography, sightlines, crowd atmosphere, sport-specific rituals, historical context, marquee storylines. You may mention athletes, teams, or countries when it makes the writing better — qualify participation honestly. Vary the opening across sessions in a batch. Match the round type — finals carry medal stakes, prelims are an accessible entry point, ceremonies are their own thing.

2. potentialContendersIntro — 1-2 sentences introducing the projected field. Mix confirmed facts (who won Paris, who's the reigning world champion) with speculation about 2028 (clearly flagged). Empty string if the session has no meaningful contender context.

3. potentialContenders — 2-5 athletes or teams likely to appear in THIS session, each as { name, country, note }. For a team, name is the team (e.g. "USA") and country is its country code. The "note" for each can be factual (a Paris 2024 result, a world ranking, a career achievement) or speculative (a projection, a storyline worth watching) — make it obvious which it is.
   - Speculation is welcome — just label it. If you don't know for certain who will be in a session, make informed guesses based on recent form and world rankings, phrased with hedging words like "could appear," "projected to compete," "likely contender," "if they qualify." What you must NOT do is state speculation as fact.
   - Only return an empty array for ceremonies or sessions so generic (mass prelim of 80+ unknown qualifiers) that names would be meaningless. For any session with a final, semifinal, or marquee event, list contenders.
   - For multi-event sessions, focus contenders on the 1-2 highest-profile events. Note in the intro which event they're for.
   - Don't mix teams and individual athletes within a session's list — pick one granularity.
   - Team sports: teams for prelims/early rounds. Marquee sessions (finals, semis, rivalry matchups): specific athletes with country indicating their team.
   - Individual sports: specific athletes throughout.

Rules:
- Plain text only. Do not use **bold**, *italics*, markdown syntax, headings, lists, or HTML in any field. The UI renders these as literal characters.
- The blurb must contain at least one literal "\\n\\n" break (so 2+ paragraphs, up to 4). Do not collapse into a single dense paragraph. If any paragraph exceeds 2 sentences or ~35 words, split it.
- Prefer the groundingFacts over your training data when they conflict — they're current.
- If a "Paris 2024 Medal Results" block is provided for a session, treat those medalists as authoritative. Never contradict them, never substitute other athletes in place of the listed gold/silver/bronze. Medals for any event NOT listed in that block are still open questions — use groundingFacts or hedge.
- If a "User correction / additional context" block is present, treat it as authoritative — it is a human-provided fact or correction that supersedes conflicting grounding facts or training data.
- Don't overuse superlatives. Don't claim something IS "the single greatest," "the most iconic," "the best ever." If you want that register, hedge: "could become one of the greatest games ever played."
- Don't state 2028 participation as confirmed when it isn't. If an athlete has publicly cast doubt (injury, retirement, age), acknowledge it.
- Don't refuse out of caution. Speculation is allowed as long as clearly flagged.
- Vary sentence structure and angles across the batch — don't start every blurb the same way.

Return a JSON object whose "sessions" array has one object per session id, each with "id", "blurb", "potentialContendersIntro", and "potentialContenders".
${BANNED_TERMS_BLOCK}`

export function augmentationBlock(extraInstructions?: string): string {
  if (!extraInstructions?.trim()) return ''
  return `\n### User correction / additional context (authoritative — supersedes conflicting information)\n${extraInstructions.trim()}\n\n`
}

// Assembles the "User correction / additional context" payload for a prompt by
// merging hand-edited corrections (session/sport/venue) with any ad-hoc CLI
// --prompt text. Returns undefined if nothing is present so callers can skip
// the section entirely. The returned string is fed into augmentationBlock().
export function buildCorrectionContext(opts: {
  sessionIds?: string[]
  sport?: string
  venue?: string
  cliPrompt?: string
}): string | undefined {
  const sections: string[] = []

  if (opts.sport) {
    const sportFixes = readSportCorrections(opts.sport)
      .map((s) => s.trim())
      .filter(Boolean)
    if (sportFixes.length > 0) {
      const header = `Sport-wide (${opts.sport}):`
      sections.push([header, ...sportFixes.map((s) => `- ${s}`)].join('\n'))
    }
  }

  if (opts.venue) {
    const venueFixes = readVenueCorrections(opts.venue)
      .map((s) => s.trim())
      .filter(Boolean)
    if (venueFixes.length > 0) {
      const header = `Venue (${opts.venue}):`
      sections.push([header, ...venueFixes.map((s) => `- ${s}`)].join('\n'))
    }
  }

  if (opts.sessionIds && opts.sessionIds.length > 0) {
    const sessionBlocks: string[] = []
    for (const id of opts.sessionIds) {
      const fixes = readSessionCorrections(id)
        .map((s) => s.trim())
        .filter(Boolean)
      if (fixes.length === 0) continue
      sessionBlocks.push([`Session ${id}:`, ...fixes.map((s) => `- ${s}`)].join('\n'))
    }
    if (sessionBlocks.length > 0) sections.push(sessionBlocks.join('\n\n'))
  }

  const trimmedCli = opts.cliPrompt?.trim() ?? ''
  if (trimmedCli) sections.push(trimmedCli)

  if (sections.length === 0) return undefined
  return sections.join('\n\n')
}

function formatMedalist(m: { name: string; country: string } | null): string {
  if (!m) return 'n/a'
  return m.country ? `${m.name} (${m.country})` : m.name
}

export function buildParisMedalsBlock(session: SessionSource): string {
  if (!session.sport) return ''
  const sportMedals = getSportMedals(PARIS_MEDALS, session.sport)
  if (!sportMedals) return ''
  const matched: ParisMedalEvent[] = matchSessionEvents(session.desc, sportMedals)
  if (matched.length === 0) return ''
  let out = `### Paris 2024 Medal Results (authoritative — do not contradict these medalists)\n`
  for (const e of matched) {
    out += `${e.event}:\n`
    out += `  Gold: ${formatMedalist(e.gold)}\n`
    out += `  Silver: ${formatMedalist(e.silver)}\n`
    out += `  Bronze: ${formatMedalist(e.bronze)}\n`
  }
  out += '\n'
  return out
}

export function buildSportContext(sport: string): string {
  const facts = SPORT_FACTS[sport]
  let out = `## Sport: ${sport}\n\n`
  if (!facts) return out
  if (facts.gamesContext) out += `### Background\n${facts.gamesContext}\n\n`
  if (facts.parisRecap) {
    out += `### Paris 2024 Recap\n${facts.parisRecap}\n\n`
  }
  return out
}

// Emits stable venue metadata for the venues referenced by a batch of sessions.
// Returns an empty string if no venue has populated data — callers should skip
// the cached content block in that case. Kept separate from buildSportContext
// so venue-facts.json stays the single source of truth for venue identity,
// while sport-facts.json handles sport-scoped usage notes.
export function buildVenueContext(sessions: SessionSource[]): string {
  const venues = new Set<string>()
  for (const s of sessions) if (s.venue) venues.add(s.venue)
  const entries: [string, VenueFacts][] = []
  for (const venue of [...venues].sort()) {
    const facts = VENUE_FACTS[venue]
    if (!facts) continue
    const hasData =
      facts.location ||
      facts.iconicMoments ||
      facts.spectatorExperience ||
      facts.capacity ||
      facts.yearBuilt ||
      facts.changes2028
    if (hasData) entries.push([venue, facts])
  }
  if (entries.length === 0) return ''

  let out = `## Venues in this batch\n\n`
  for (const [venue, f] of entries) {
    out += `### ${venue}\n`
    if (f.location) out += `- Location: ${f.location}\n`
    if (f.capacity) out += `- Capacity: ~${f.capacity.toLocaleString()}\n`
    if (f.yearBuilt) out += `- Built: ${f.yearBuilt}\n`
    if (f.iconicMoments) out += `- History: ${f.iconicMoments}\n`
    if (f.spectatorExperience) out += `- Experience: ${f.spectatorExperience}\n`
    if (f.changes2028) out += `- 2028: ${f.changes2028}\n`
    out += '\n'
  }
  return out
}

function previousBriefBlock(previous: PreviousBrief | undefined): string {
  if (!previous || previous.facts.length === 0) return ''
  let out = `- Previous brief (gathered ${previous.gatheredAt.slice(0, 10)}):\n`
  for (const fact of previous.facts) out += `  - ${fact}\n`
  if (previous.newsTitles.length > 0) {
    out += `  - Previous news: ${previous.newsTitles.join('; ')}\n`
  }
  return out
}

export function buildGroundingPrompt(
  session: SessionSource,
  sport: string,
  extraInstructions?: string,
  previous?: PreviousBrief,
): string {
  let prompt = buildSportContext(sport)
  prompt += buildParisMedalsBlock(session)
  prompt += `### Session to Ground\n`
  prompt += `- ID: ${session.id}\n`
  prompt += `- Name: ${session.name}\n`
  prompt += `- Description: ${session.desc}\n`
  prompt += `- Round: ${session.rt}\n`
  prompt += `- Venue: ${session.venue}\n`
  prompt += `- Date/Time: ${session.date}, ${session.time}\n`
  prompt += previousBriefBlock(previous)
  prompt += '\n'
  prompt += `Use current web search to find facts relevant to THIS session's event, round, venue, and likely contenders. Prioritize 2028 Games-specific news, then 2024-2026 performance and status updates for probable contenders. Prefer official games organizing body, international federation, team, and reputable sports-news sources.\n\n`
  prompt += augmentationBlock(extraInstructions)
  prompt += `Record one entry in sessions, with id ${session.id}.`
  return prompt
}

export function buildBatchGroundingPrompt(
  sessions: SessionSource[],
  sport: string,
  extraInstructions?: string,
  previous?: Map<string, PreviousBrief>,
): string {
  let prompt = buildSportContext(sport)
  prompt += `### Sessions (${sessions.length}) — ground each\n\n`
  for (const s of sessions) {
    prompt += `#### ${s.id}: ${s.name}\n`
    prompt += `- Description: ${s.desc}\n`
    prompt += `- Round: ${s.rt}\n`
    prompt += `- Venue: ${s.venue}\n`
    prompt += `- Date/Time: ${s.date}, ${s.time}\n`
    const paris = buildParisMedalsBlock(s)
    if (paris) prompt += paris
    prompt += previousBriefBlock(previous?.get(s.id))
    prompt += '\n'
  }
  prompt += `Use current web search to find facts relevant to EACH session's event, round, venue, and likely contenders. Prioritize 2028 Games-specific news, then 2024-2026 performance and status updates for probable contenders. Prefer official games organizing body, international federation, team, and reputable sports-news sources.\n\n`
  prompt += `Return per-session groundingFacts and relatedNews — each session should have its own facts and news specific to its event and round type. Finals need different facts than prelims.\n\n`
  prompt += augmentationBlock(extraInstructions)
  prompt += `Record ${sessions.length} entries in sessions (one per session id above), each with id, materialChange, groundingFacts, relatedNews.`
  return prompt
}

// Per-session body of the writing prompt. Kept separate from the sport-context
// prefix so the request builder can emit the sport context as its own cached
// content block while the session body (which varies per request) is not cached.
function buildWritingSessionsBody(
  sessions: SessionSource[],
  grounding: Map<string, GroundingData>,
  extraInstructions?: string,
): string {
  let prompt = `### Sessions (${sessions.length}) — write for each\n\n`
  for (const s of sessions) {
    prompt += `#### ${s.id}: ${s.name}\n`
    prompt += `- Description: ${s.desc}\n`
    prompt += `- Round: ${s.rt}\n`
    prompt += `- Venue: ${s.venue}\n`
    prompt += `- Date/Time: ${s.date}, ${s.time}\n`
    const paris = buildParisMedalsBlock(s)
    if (paris) {
      prompt += paris
    }
    const g = grounding.get(s.id)
    if (g && g.groundingFacts.length > 0) {
      prompt += `- groundingFacts (use these for current info; prefer over your training data):\n`
      for (const fact of g.groundingFacts) prompt += `  - ${fact}\n`
    } else {
      prompt += `- groundingFacts: (none provided; rely on your general knowledge, hedge speculation)\n`
    }
    prompt += '\n'
  }
  prompt += augmentationBlock(extraInstructions)
  prompt += `Return a JSON object whose sessions array has ${sessions.length} objects, one for each session id above, with fields id, blurb, potentialContendersIntro, potentialContenders.`
  return prompt
}

export function buildWritingPrompt(
  sessions: SessionSource[],
  sport: string,
  grounding: Map<string, GroundingData>,
  extraInstructions?: string,
): string {
  return buildSportContext(sport) + buildWritingSessionsBody(sessions, grounding, extraInstructions)
}

// Search-grounded models occasionally leak inline citation markers like "[1]"
// or "[1][5]" or "[1, 3]" into prose even when the system prompt forbids them.
// Belt-and-suspenders strip, shared across the sport-facts and venue-facts
// generators. Matches adjacent bracketed-digit groups with optional commas or
// ranges inside, plus surrounding whitespace so we don't leave double spaces.
export function stripCitationMarkers(text: string): string {
  return text
    .replace(/\s*(?:\[\s*\d+(?:\s*[-,]\s*\d+)*\s*\]\s*)+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export function writeJson(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  const tempPath = `${path}.tmp`
  writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`)
  renameSync(tempPath, path)
}

export function normalizeRelatedNews(items: unknown, sessionId: string): RelatedNews[] {
  if (!Array.isArray(items)) return []
  const seen = new Set<string>()
  const out: RelatedNews[] = []
  let index = 0
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const title = typeof item.title === 'string' ? item.title.trim() : ''
    const summary = typeof item.summary === 'string' ? item.summary.trim() : ''
    const sourceName = typeof item.sourceName === 'string' ? item.sourceName.trim() : ''
    const sourceUrl = typeof item.sourceUrl === 'string' ? item.sourceUrl.trim() : ''
    const publishedDate = typeof item.publishedDate === 'string' ? item.publishedDate.trim() : ''
    const tags = Array.isArray(item.tags)
      ? item.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      : []

    if (!title || !sourceUrl || !publishedDate) continue
    // Titles are real headlines and stay verbatim; summaries are ours.
    if (containsBannedTerm(summary)) continue
    let parsedUrl: URL
    try {
      parsedUrl = new URL(sourceUrl)
    } catch {
      continue
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') continue

    const key = sourceUrl.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    out.push({
      id: `${sessionId}-n${index}`,
      title,
      summary,
      sourceName: sourceName || parsedUrl.hostname,
      sourceUrl,
      publishedDate,
      tags,
    })
    index += 1
    if (out.length >= MAX_NEWS_ITEMS) break
  }
  return out
}

// Pulls per-session entries out of a record_grounding call. Entries for ids
// outside the request are dropped; every entry shares the turn's search sources.
function parseGroundingMessage(
  content: ContentBlock[],
  sessionIds: Set<string>,
  previousIds: Set<string>,
): GroundingData[] {
  const record = extractRecord(content, RECORD_GROUNDING_TOOL.name) as { sessions?: unknown }
  const items = Array.isArray(record.sessions) ? record.sessions : []
  const sources = extractSearchSources(content)
  const results: GroundingData[] = []
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as {
      id?: unknown
      materialChange?: unknown
      groundingFacts?: unknown
      relatedNews?: unknown
    }
    if (typeof item.id !== 'string' || !sessionIds.has(item.id)) continue
    // "No change" only counts when there was a previous brief to keep.
    const materialChange = item.materialChange !== false || !previousIds.has(item.id)
    const facts = Array.isArray(item.groundingFacts)
      ? item.groundingFacts
          .filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
          .map(stripCitationMarkers)
      : []
    results.push({
      id: item.id,
      groundingFacts: facts,
      relatedNews: normalizeRelatedNews(item.relatedNews, item.id),
      sources,
      materialChange,
    })
  }
  return results
}

function buildGroundingRequest(
  sessions: SessionSource[],
  sport: string,
  model: string,
  extraInstructions?: string,
  previous?: Map<string, PreviousBrief>,
): MessageCreateParamsNonStreaming {
  const single = sessions.length === 1
  return buildResearchParams({
    model,
    system: GROUNDING_SYSTEM_PROMPT,
    prompt: single
      ? buildGroundingPrompt(sessions[0], sport, extraInstructions, previous?.get(sessions[0].id))
      : buildBatchGroundingPrompt(sessions, sport, extraInstructions, previous),
    recordTool: RECORD_GROUNDING_TOOL,
    maxSearches: single ? GROUNDING_SINGLE_MAX_SEARCHES : GROUNDING_BATCH_MAX_SEARCHES,
    maxTokens: single ? undefined : GROUNDING_BATCH_MAX_TOKENS,
  })
}

function previousIdsFor(sessions: SessionSource[], previous?: Map<string, PreviousBrief>) {
  return new Set(
    sessions.filter((s) => (previous?.get(s.id)?.facts.length ?? 0) > 0).map((s) => s.id),
  )
}

export async function fetchGrounding(
  client: Anthropic,
  session: SessionSource,
  sport: string,
  model: string,
  extraInstructions?: string,
): Promise<GroundingData | null> {
  const results = await fetchGroundingBatch(client, [session], sport, model, extraInstructions)
  return results.find((r) => r.id === session.id) ?? null
}

export async function fetchGroundingBatch(
  client: Anthropic,
  sessions: SessionSource[],
  sport: string,
  model: string,
  extraInstructions?: string,
  previous?: Map<string, PreviousBrief>,
): Promise<GroundingData[]> {
  if (sessions.length === 0) return []
  const params = buildGroundingRequest(sessions, sport, model, extraInstructions, previous)
  const sessionIds = new Set(sessions.map((s) => s.id))
  const previousIds = previousIdsFor(sessions, previous)
  const ids = sessions.map((s) => s.id).join(',')
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const content = await runResearch(client, params)
      return parseGroundingMessage(content, sessionIds, previousIds)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`    Grounding attempt ${attempt}/${MAX_RETRIES} failed for [${ids}]: ${msg}`)
      if (attempt < MAX_RETRIES) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt))
    }
  }
  console.error(`    Grounding FAILED after ${MAX_RETRIES} attempts for [${ids}]`)
  return []
}

// Writing and scoring use structured outputs so the API enforces the response
// shape (field names included) instead of trusting the prompt alone. Neither
// stage uses web search, so the citations conflict that rules this out for
// grounding doesn't apply.
const WRITING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sessions'],
  properties: {
    sessions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'blurb', 'potentialContendersIntro', 'potentialContenders'],
        properties: {
          id: { type: 'string' },
          blurb: { type: 'string' },
          potentialContendersIntro: { type: 'string' },
          potentialContenders: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'country', 'note'],
              properties: {
                name: { type: 'string' },
                country: { type: 'string' },
                note: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
}

const SCORE_DIMENSION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['score', 'explanation'],
  properties: {
    score: { type: 'integer' },
    explanation: { type: 'string' },
  },
}

const SCORING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sessions'],
  properties: {
    sessions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'scorecard'],
        properties: {
          id: { type: 'string' },
          scorecard: {
            type: 'object',
            additionalProperties: false,
            required: [
              'significance',
              'experience',
              'starPower',
              'uniqueness',
              'demand',
              'overall',
            ],
            properties: {
              significance: SCORE_DIMENSION_SCHEMA,
              experience: SCORE_DIMENSION_SCHEMA,
              starPower: SCORE_DIMENSION_SCHEMA,
              uniqueness: SCORE_DIMENSION_SCHEMA,
              demand: SCORE_DIMENSION_SCHEMA,
              overall: { type: 'string' },
            },
          },
        },
      },
    },
  },
}

// Decodes a structured-output response: the text blocks (after any thinking
// blocks) form one JSON object whose "sessions" array holds the results.
function parseSessionsJson(content: ContentBlock[]): unknown[] {
  const text = content
    .map((c) => (c.type === 'text' ? c.text : ''))
    .join('')
    .trim()
  if (!text) throw new Error('No text in Anthropic response')
  const parsed = JSON.parse(text) as { sessions?: unknown }
  if (!Array.isArray(parsed.sessions)) throw new Error('Expected a sessions array')
  return parsed.sessions
}

// Ephemeral cache marker. Applied to the system prompt (stable across the run)
// and the per-sport context (stable within a sport across multiple batches) so
// repeat requests in the same run hit the prompt cache instead of re-billing
// the ~3k tokens of system prompt + ~1.5k tokens of sport knowledge.
const EPHEMERAL_CACHE: TextBlockParam['cache_control'] = { type: 'ephemeral' }

// Source of truth for the writing request shape. Sync (`messages.create`) and
// batch (`messages.batches.create`) paths both build their request via this
// helper so model/max_tokens/system/messages stay identical across paths.
function buildWritingRequest(
  sessions: SessionSource[],
  sport: string,
  grounding: Map<string, GroundingData>,
  model: string,
  extraInstructions?: string,
): MessageCreateParamsNonStreaming {
  const content: TextBlockParam[] = [
    { type: 'text', text: buildSportContext(sport), cache_control: EPHEMERAL_CACHE },
  ]
  const venueBlock = buildVenueContext(sessions)
  if (venueBlock) {
    content.push({ type: 'text', text: venueBlock, cache_control: EPHEMERAL_CACHE })
  }
  content.push({
    type: 'text',
    text: buildWritingSessionsBody(sessions, grounding, extraInstructions),
  })

  return {
    model,
    max_tokens: WRITING_MAX_TOKENS,
    output_config: {
      effort: WRITING_EFFORT,
      format: { type: 'json_schema', schema: WRITING_SCHEMA },
    },
    system: [{ type: 'text', text: WRITING_SYSTEM_PROMPT, cache_control: EPHEMERAL_CACHE }],
    messages: [{ role: 'user', content }],
  }
}

// Shared response decoder for the sync and batch paths. The schema guarantees
// the shape; this still drops entries for unknown ids or empty fields.
function parseWritingMessage(content: ContentBlock[]): WritingData[] {
  const parsed = parseSessionsJson(content)
  const results: WritingData[] = []
  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    if (typeof item.id !== 'string' || typeof item.blurb !== 'string') continue
    if (typeof item.potentialContendersIntro !== 'string') continue
    if (!Array.isArray(item.potentialContenders)) continue
    const contenders = item.potentialContenders.filter(
      (c): c is Contender =>
        !!c &&
        typeof c === 'object' &&
        typeof (c as Contender).name === 'string' &&
        typeof (c as Contender).country === 'string' &&
        typeof (c as Contender).note === 'string',
    )
    const visible = [item.blurb, item.potentialContendersIntro, JSON.stringify(contenders)]
    if (visible.some(containsBannedTerm)) {
      console.warn(`    ${item.id}: writing used a trademarked term — dropped, will retry next run`)
      continue
    }
    results.push({
      id: item.id,
      blurb: item.blurb,
      potentialContendersIntro: item.potentialContendersIntro,
      potentialContenders: contenders,
    })
  }
  return results
}

export async function generateWriting(
  client: Anthropic,
  sessions: SessionSource[],
  sport: string,
  grounding: Map<string, GroundingData>,
  model: string,
  extraInstructions?: string,
): Promise<WritingData[]> {
  const params = buildWritingRequest(sessions, sport, grounding, model, extraInstructions)
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.messages.create(params)
      recordUsage(response.model, response.usage, false)
      return parseWritingMessage(response.content)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`    Writing attempt ${attempt}/${MAX_RETRIES} failed: ${msg}`)
      if (attempt < MAX_RETRIES) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt))
    }
  }
  console.error(`    Writing FAILED after ${MAX_RETRIES} attempts for ${sport} batch`)
  return []
}

export interface WritingJob {
  sport: string
  batch: SessionSource[]
  grounding: Map<string, GroundingData>
  extraInstructions?: string
}

export interface WritingBatchOutcome {
  job: WritingJob
  results: WritingData[]
  error?: string
}

export interface WritingBatchProgress {
  sport: string
  outcomes: WritingBatchOutcome[]
  elapsedSec: number
}

export interface WritingBatchesOptions {
  extraInstructions?: string
  // Fires as each sport's batch completes so the caller can persist checkpoints
  // incrementally and emit its own per-sport log line.
  onSportComplete?: (progress: WritingBatchProgress) => void | Promise<void>
  pollIntervalMs?: number
}

// Submits one Anthropic Message Batch per sport (one batch = all writing jobs
// for that sport), polls all batches in parallel, and reports per-sport as
// each finishes. Per-sport batching trades a small submission overhead for
// meaningful progress visibility (each sport's closure is a visible event) and
// incremental checkpoint persistence, which a single global batch doesn't
// offer since the API only exposes aggregate counts.
// Anthropic tier-1 request limit is 50 RPM. With 60+ sports in a single
// `--force` run we have to fan out the batch create/poll calls carefully or
// the org-level RPM cap trips. Cap to a conservative parallelism and retry
// 429s using the server-suggested backoff.
const ANTHROPIC_API_CONCURRENCY = 5

async function anthropicWithRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err: unknown) {
      const e = err as { status?: number; headers?: { get?: (k: string) => string | null } }
      if (e?.status !== 429 || attempt >= 5) throw err
      const retryHeader = e.headers?.get?.('retry-after')
      const retryAfter = retryHeader ? Number(retryHeader) : NaN
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(60_000, 2_000 * 2 ** attempt)
      console.log(
        `    429 on ${label} — retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/5)`,
      )
      await new Promise((r) => setTimeout(r, waitMs))
    }
  }
}

export interface BatchOutcome<TJob, TResult> {
  job: TJob
  results: TResult[]
  error?: string
}

export interface BatchProgress<TJob, TResult> {
  sport: string
  outcomes: BatchOutcome<TJob, TResult>[]
  elapsedSec: number
}

export interface BatchesOptions<TJob, TResult> {
  // Fires as each sport's batch completes so the caller can persist checkpoints
  // incrementally and emit its own per-sport log line.
  onSportComplete?: (progress: BatchProgress<TJob, TResult>) => void | Promise<void>
  pollIntervalMs?: number
}

// Submits one Anthropic Message Batch per sport (one batch = all jobs for that
// sport), polls all batches in parallel, and reports per-sport as each
// finishes. Per-sport batching trades a small submission overhead for
// meaningful progress visibility (each sport's closure is a visible event) and
// incremental checkpoint persistence, which a single global batch doesn't
// offer since the API only exposes aggregate counts.
// Anthropic tier-1 request limit is 50 RPM. With 60+ sports in a single
// `--force` run we have to fan out the batch create/poll calls carefully or
// the org-level RPM cap trips. Cap to a conservative parallelism and retry
// 429s using the server-suggested backoff.
async function runMessageBatchesBySport<TJob extends { sport: string }, TResult>(
  client: Anthropic,
  jobs: TJob[],
  buildParams: (job: TJob) => MessageCreateParamsNonStreaming,
  parseMessage: (content: ContentBlock[], job: TJob) => TResult[],
  label: string,
  options: BatchesOptions<TJob, TResult>,
): Promise<BatchOutcome<TJob, TResult>[]> {
  if (jobs.length === 0) return []

  // Group jobs by sport while remembering each job's original index so we can
  // return outcomes in the same order the caller passed them in.
  const bySport = new Map<string, { jobs: TJob[]; indices: number[] }>()
  jobs.forEach((job, i) => {
    let group = bySport.get(job.sport)
    if (!group) {
      group = { jobs: [], indices: [] }
      bySport.set(job.sport, group)
    }
    group.jobs.push(job)
    group.indices.push(i)
  })

  const sports = [...bySport.keys()]
  console.log(`  Submitting ${sports.length} ${label} batch(es), one per sport…`)

  interface Pending {
    sport: string
    group: { jobs: TJob[]; indices: number[] }
    batchId: string
    startedAt: number
  }
  const pending = new Map<string, Pending>()

  const createLimit = pLimit(ANTHROPIC_API_CONCURRENCY)
  await Promise.all(
    sports.map((sport) =>
      createLimit(async () => {
        const group = bySport.get(sport)!
        const requests = group.jobs.map((job, idx) => ({
          custom_id: `${label[0]}-${idx}`,
          params: buildParams(job),
        }))
        const created = await anthropicWithRetry(
          () => client.messages.batches.create({ requests }),
          `create ${sport}`,
        )
        pending.set(created.id, { sport, group, batchId: created.id, startedAt: Date.now() })
      }),
    ),
  )

  console.log(`  ${pending.size} batch(es) in flight. Polling…`)

  const allOutcomes: (BatchOutcome<TJob, TResult> | undefined)[] = Array.from({
    length: jobs.length,
  })
  const pollIntervalMs = options.pollIntervalMs ?? 60_000

  while (pending.size > 0) {
    await new Promise((r) => setTimeout(r, pollIntervalMs))

    const pollLimit = pLimit(ANTHROPIC_API_CONCURRENCY)
    const statuses = await Promise.all(
      [...pending.values()].map((p) =>
        pollLimit(async () => {
          const batch = await anthropicWithRetry(
            () => client.messages.batches.retrieve(p.batchId),
            `poll ${p.sport}`,
          )
          return { pending: p, batch }
        }),
      ),
    )

    for (const { pending: p, batch } of statuses) {
      if (batch.processing_status !== 'ended') continue

      const outcomes: BatchOutcome<TJob, TResult>[] = p.group.jobs.map((job) => ({
        job,
        results: [],
      }))
      const byId = new Map(outcomes.map((o, i) => [`${label[0]}-${i}`, o]))
      const results = await anthropicWithRetry(
        () => client.messages.batches.results(p.batchId),
        `results ${p.sport}`,
      )
      for await (const item of results) {
        const outcome = byId.get(item.custom_id)
        if (!outcome) continue
        if (item.result.type === 'succeeded') {
          recordUsage(item.result.message.model, item.result.message.usage, true)
        }
        if (item.result.type !== 'succeeded') {
          outcome.error = item.result.type
          continue
        }
        try {
          outcome.results = parseMessage(item.result.message.content, outcome.job)
        } catch (err) {
          outcome.error = err instanceof Error ? err.message : String(err)
        }
      }

      p.group.indices.forEach((originalIdx, localIdx) => {
        allOutcomes[originalIdx] = outcomes[localIdx]
      })

      if (options.onSportComplete) {
        const elapsedSec = Math.round((Date.now() - p.startedAt) / 1000)
        await options.onSportComplete({ sport: p.sport, outcomes, elapsedSec })
      }

      pending.delete(p.batchId)
    }
  }

  return allOutcomes as BatchOutcome<TJob, TResult>[]
}

export async function generateWritingViaBatches(
  client: Anthropic,
  jobs: WritingJob[],
  model: string,
  options: WritingBatchesOptions = {},
): Promise<WritingBatchOutcome[]> {
  return runMessageBatchesBySport(
    client,
    jobs,
    (job) =>
      buildWritingRequest(
        job.batch,
        job.sport,
        job.grounding,
        model,
        job.extraInstructions ?? options.extraInstructions,
      ),
    parseWritingMessage,
    'writing',
    { onSportComplete: options.onSportComplete, pollIntervalMs: options.pollIntervalMs },
  )
}

export interface GroundingJob {
  sport: string
  batch: SessionSource[]
  extraInstructions?: string
  previous?: Map<string, PreviousBrief>
}

export type GroundingBatchOutcome = BatchOutcome<GroundingJob, GroundingData>
export type GroundingBatchProgress = BatchProgress<GroundingJob, GroundingData>

export interface GroundingBatchesOptions {
  onSportComplete?: (progress: GroundingBatchProgress) => void | Promise<void>
  pollIntervalMs?: number
}

// A batch item whose search turn pauses (stop_reason "pause_turn") can't be
// resumed inside the Batches API, so it comes back as an error and its
// sessions stay due for the next run (or a --no-batch run).
export async function fetchGroundingViaBatches(
  client: Anthropic,
  jobs: GroundingJob[],
  model: string,
  options: GroundingBatchesOptions = {},
): Promise<GroundingBatchOutcome[]> {
  return runMessageBatchesBySport(
    client,
    jobs,
    (job) =>
      buildGroundingRequest(job.batch, job.sport, model, job.extraInstructions, job.previous),
    (content, job) =>
      parseGroundingMessage(
        content,
        new Set(job.batch.map((s) => s.id)),
        previousIdsFor(job.batch, job.previous),
      ),
    'grounding',
    options,
  )
}

export const SCORING_SYSTEM_PROMPT = `You are scoring 2028 Los Angeles Summer Games sessions for a ticket-buying guide. For each session you assign integer 1-10 scores across five dimensions and write a short, specific explanation that justifies the SCORE you gave (not the venue or sport in general).

You will receive a batch of sessions for one sport, each with: basic facts, sport-level background, grounding facts from recent web searches, and the blurb already written for that session. Use the grounding facts and blurb as authoritative current context. Do not restate the blurb.

BASELINE: This is the 2028 Summer Games in Los Angeles. Every session is a world-class live event, and the Games are already well into presale with most sessions tracking toward sell-out. That context sets a floor on the scale — no Games session scores a 1 or 2, and sessions that would be "low interest" in a normal sporting context still land in the 4-5 range here because of global scarcity and prestige. Reserve 1-3 only for truly exceptional worst-case scenarios (none should occur in practice).

Dimensions and rubric:

1. significance — Stakes of THIS session within the Games.
   10 = gold-medal final in a marquee sport (Athletics, Swimming, Basketball, Football, Gymnastics) or an Opening/Closing Ceremony.
   8-9 = gold-medal final in a non-marquee sport, or session containing 3+ medal events.
   6-7 = bronze-medal match, semifinal in a marquee sport, or single non-marquee final.
   5 = quarterfinal, or semifinal in a smaller sport.
   4 = preliminary heat / round 1 / qualification — world-class athletes competing for advancement; real stakes, just not medal-deciding.
   Do not go below 4 — every competition round carries stakes for the athletes.

2. experience — How good it'll be to attend live. Combines sport watchability + venue quality + round + time of day.
   10 = ceremony at iconic venue, OR marquee final at LA Memorial Coliseum / Rose Bowl / Dodger Stadium / 2028 Stadium / Intuit Dome.
   8-9 = high-energy sport (basketball, beach volleyball, athletics, surfing) at a strong venue, especially evening prime-time.
   6-7 = solid spectator sport at a decent venue, or marquee sport in a quieter round.
   5 = daytime/morning session, or mid-tier sport at a generic venue — still a live Games experience, just without prime-time energy.
   4 = lowest the scale should go: an early-morning session of a hard-to-follow sport at a small venue.
   Do not go below 4 — "It's the 2028 Games at LA Memorial Coliseum" sets a floor even for a 9:30am prelim session.

3. starPower — Likelihood that globally-recognized athletes are competing.
   10 = basketball final, ceremony, marquee tennis match, men's/women's 100m final.
   8-9 = medal rounds in marquee sports with confirmed superstar contenders.
   6-7 = mid-tier sport medal round, or early-round marquee sport (top athletes often compete in prelims).
   5 = early-round sessions where top athletes may or may not appear — every Games field contains national champions and world-level competitors even if not household names.
   4 = lowest typical score: a prelim of a sport without any globally-known names.

4. uniqueness — How rare or special this specific session is. THIS IS THE DIMENSION MOST OFTEN MIS-RATED — be careful.
   10 = Opening/Closing Ceremony, baseball final at Dodger Stadium, Athletics gold-medal final at LA Memorial Coliseum, soccer final at Rose Bowl. (Once-in-a-lifetime pairings of marquee sport + iconic venue + medal stakes.)
   7-9 = medal round of a new/returning sport (Flag Football, Lacrosse, Cricket, Squash, Baseball, 3x3 Basketball), OR a marquee final at an iconic venue.
   5-6 = early round of a new/returning sport, OR a non-medal session at an iconic venue with significant cultural pull.
   4 = standard-format medal round in an established sport at a generic venue, OR a routine session at a famous venue (e.g. one of many Athletics prelims at the Coliseum — the venue is iconic but THIS session is one of dozens like it). Every Games session is once-every-four-years in some sense, which sets the floor.
   Do not go below 4 — even the most "routine" session is still a 2028 Games session.
   CRITICAL: An iconic venue alone does NOT justify a high uniqueness score if the session itself is routine. Many ATH prelims happen at the Coliseum across the Games — uniqueness for those should be modest (4-5). Reserve 8-10 for genuinely once-in-a-lifetime combinations.

5. demand — How sought-after / hard to get tickets for.
   IMPORTANT CONTEXT: Presale is active and the vast majority of sessions are tracking toward sell-out regardless of individual session profile — Games scarcity drives a high floor on demand.
   10 = Opening/Closing Ceremony, basketball final, baseball final at Dodger, Athletics finals night.
   8-9 = marquee sport finals/semifinals.
   6-7 = mid-tier sport finals, or marquee sport early rounds at iconic venues.
   5 = mid-tier sport non-medal rounds at decent venues, or early-round sessions of popular sports — still generally expected to sell but less competitive to book.
   4 = lowest typical score: an early prelim of a niche sport at a generic venue. Even here, Games scarcity means "easier to get" does not mean "easy to get."
   Do not go below 4 — ticket scarcity sets a floor; no 2028 session is genuinely low-demand.

For each dimension produce:
- "score": integer 1-10 (in practice 4-10; do not go below 4).
- "explanation": 1-2 sentences (max ~35 words) that justify THIS score. Punchy and specific; lead with the one thing that sets the score, then optionally add one beat of supporting detail. Fragments welcome. Avoid the "sentence one + sentence two restating the same idea" pattern.
  - A 10: "Gold-medal final on the track where Carl Lewis won in '84. Peak Games theater with medals on the line."
  - A 7-9: "Semifinal night at the Rose Bowl — marquee stage, medal-adjacent stakes, and a likely rematch of the Paris final."
  - A 5-6: "Quarterfinal volleyball at Long Beach — Games energy without the medal drama; good for fans of the sport."
  - A 4: "Morning prelim of a niche event at a smaller venue. Mostly for completionists and genuine sport fans."
- Each explanation should sound like a different take, not five variations of the same template sentence. Vary sentence structure across the five dimensions of a single session.
- Avoid harsh language. Do NOT write "forgettable", "weak demand", "tickets widely available", "lacking". But DO use confident framing: "easier ticket", "softer stakes", "smaller stage" are fine and preferred over hedged PR-speak.
- Reference the actual session/venue/round factor that drives the score. Skip generic Games boilerplate.

Also produce:
- "overall": 1-2 sentences (max ~45 words) — the session's pitch. What it is and what carries or limits it. Punchy beats comprehensive; the second sentence should add information, not pad the first.

Rules:
- Scores are integers 1-10, effectively 4-10 given the Games baseline.
- Explanations are plain text. No markdown, no bold, no italics, no lists.
- Vary the opening of explanations across the batch — don't start every Uniqueness explanation with "While the venue is iconic…".
- Use the full 4-10 range honestly. A marquee final in prime time at the Coliseum earns its 9s and 10s; an early prelim earns 4-5s. Don't compress everything to the middle.
- If a "Paris 2024 Medal Results" block is provided for a session, treat those medalists as authoritative. Never name a different athlete as the Paris gold/silver/bronze medalist in any explanation.
- If a "User correction / additional context" block is present in the user prompt, treat it as authoritative — it supersedes conflicting facts.
- Return a JSON object whose "sessions" array has one object per session id, each with "id" and "scorecard" containing the five dimensions plus "overall".

Example object shape (do not copy values):
{
  "id": "ATH04",
  "scorecard": {
    "significance": { "score": 9, "explanation": "..." },
    "experience": { "score": 10, "explanation": "..." },
    "starPower": { "score": 9, "explanation": "..." },
    "uniqueness": { "score": 10, "explanation": "..." },
    "demand": { "score": 10, "explanation": "..." },
    "overall": "..."
  }
}
${BANNED_TERMS_BLOCK}`

// Per-session body of the scoring prompt; see buildWritingSessionsBody for the
// caching rationale.
function buildScoringSessionsBody(
  sessions: SessionSource[],
  grounding: Map<string, GroundingData>,
  writing: Map<string, WritingData>,
  extraInstructions?: string,
): string {
  let prompt = `### Sessions (${sessions.length}) — score each\n\n`
  for (const s of sessions) {
    prompt += `#### ${s.id}: ${s.name}\n`
    prompt += `- Description: ${s.desc}\n`
    prompt += `- Round: ${s.rt}\n`
    prompt += `- Venue: ${s.venue}\n`
    prompt += `- Date/Time: ${s.date}, ${s.time}\n`
    const paris = buildParisMedalsBlock(s)
    if (paris) {
      prompt += paris
    }
    const w = writing.get(s.id)
    if (w?.blurb) {
      prompt += `- Blurb (already written for this session — for context, do not restate):\n`
      for (const line of w.blurb.split('\n')) prompt += `  ${line}\n`
    }
    const g = grounding.get(s.id)
    if (g && g.groundingFacts.length > 0) {
      prompt += `- groundingFacts:\n`
      for (const fact of g.groundingFacts) prompt += `  - ${fact}\n`
    }
    prompt += '\n'
  }
  prompt += augmentationBlock(extraInstructions)
  prompt += `Return a JSON object whose sessions array has ${sessions.length} objects, one per session id above, each shaped { id, scorecard: { significance, experience, starPower, uniqueness, demand, overall } } where each dimension is { score, explanation }.`
  return prompt
}

export function buildScoringPrompt(
  sessions: SessionSource[],
  sport: string,
  grounding: Map<string, GroundingData>,
  writing: Map<string, WritingData>,
  extraInstructions?: string,
): string {
  return (
    buildSportContext(sport) +
    buildScoringSessionsBody(sessions, grounding, writing, extraInstructions)
  )
}

function buildScoringRequest(
  sessions: SessionSource[],
  sport: string,
  grounding: Map<string, GroundingData>,
  writing: Map<string, WritingData>,
  model: string,
  extraInstructions?: string,
): MessageCreateParamsNonStreaming {
  const content: TextBlockParam[] = [
    { type: 'text', text: buildSportContext(sport), cache_control: EPHEMERAL_CACHE },
  ]
  const venueBlock = buildVenueContext(sessions)
  if (venueBlock) {
    content.push({ type: 'text', text: venueBlock, cache_control: EPHEMERAL_CACHE })
  }
  content.push({
    type: 'text',
    text: buildScoringSessionsBody(sessions, grounding, writing, extraInstructions),
  })

  return {
    model,
    max_tokens: SCORING_MAX_TOKENS,
    output_config: {
      effort: SCORING_EFFORT,
      format: { type: 'json_schema', schema: SCORING_SCHEMA },
    },
    system: [{ type: 'text', text: SCORING_SYSTEM_PROMPT, cache_control: EPHEMERAL_CACHE }],
    messages: [{ role: 'user', content }],
  }
}

function parseDimension(raw: unknown): ScorecardDimension | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const score = typeof obj.score === 'number' ? Math.round(obj.score) : NaN
  const explanation = typeof obj.explanation === 'string' ? obj.explanation.trim() : ''
  if (!Number.isFinite(score) || score < 1 || score > 10) return null
  if (!explanation) return null
  return { score, explanation }
}

// Shared response decoder for scoring; see parseWritingMessage.
function parseScoringMessage(content: ContentBlock[]): ScoringData[] {
  const parsed = parseSessionsJson(content)
  const results: ScoringData[] = []
  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    if (typeof item.id !== 'string') continue
    const sc = item.scorecard as Record<string, unknown> | undefined
    if (!sc || typeof sc !== 'object') continue
    const significance = parseDimension(sc.significance)
    const experience = parseDimension(sc.experience)
    const starPower = parseDimension(sc.starPower)
    const uniqueness = parseDimension(sc.uniqueness)
    const demand = parseDimension(sc.demand)
    const overall = typeof sc.overall === 'string' ? sc.overall.trim() : ''
    if (!significance || !experience || !starPower || !uniqueness || !demand || !overall) {
      continue
    }
    const explanations = [significance, experience, starPower, uniqueness, demand]
      .map((d) => d.explanation)
      .concat(overall)
    if (explanations.some(containsBannedTerm)) {
      console.warn(`    ${item.id}: scoring used a trademarked term — dropped, will retry next run`)
      continue
    }
    const aggregate = computeAggregate(
      significance.score,
      experience.score,
      starPower.score,
      uniqueness.score,
      demand.score,
    )
    results.push({
      id: item.id,
      scorecard: {
        significance,
        experience,
        starPower,
        uniqueness,
        demand,
        aggregate,
        overall,
      },
    })
  }
  return results
}

export async function generateScoring(
  client: Anthropic,
  sessions: SessionSource[],
  sport: string,
  grounding: Map<string, GroundingData>,
  writing: Map<string, WritingData>,
  model: string,
  extraInstructions?: string,
): Promise<ScoringData[]> {
  const params = buildScoringRequest(sessions, sport, grounding, writing, model, extraInstructions)
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.messages.create(params)
      recordUsage(response.model, response.usage, false)
      return parseScoringMessage(response.content)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`    Scoring attempt ${attempt}/${MAX_RETRIES} failed: ${msg}`)
      if (attempt < MAX_RETRIES) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt))
    }
  }
  console.error(`    Scoring FAILED after ${MAX_RETRIES} attempts for ${sport} batch`)
  return []
}

export interface ScoringJob {
  sport: string
  batch: SessionSource[]
  grounding: Map<string, GroundingData>
  writing: Map<string, WritingData>
  extraInstructions?: string
}

export type ScoringBatchOutcome = BatchOutcome<ScoringJob, ScoringData>
export type ScoringBatchProgress = BatchProgress<ScoringJob, ScoringData>

export interface ScoringBatchesOptions {
  extraInstructions?: string
  onSportComplete?: (progress: ScoringBatchProgress) => void | Promise<void>
  pollIntervalMs?: number
}

export async function generateScoringViaBatches(
  client: Anthropic,
  jobs: ScoringJob[],
  model: string,
  options: ScoringBatchesOptions = {},
): Promise<ScoringBatchOutcome[]> {
  return runMessageBatchesBySport(
    client,
    jobs,
    (job) =>
      buildScoringRequest(
        job.batch,
        job.sport,
        job.grounding,
        job.writing,
        model,
        job.extraInstructions ?? options.extraInstructions,
      ),
    parseScoringMessage,
    'scoring',
    { onSportComplete: options.onSportComplete, pollIntervalMs: options.pollIntervalMs },
  )
}

// Fingerprint of everything that shapes a session's writing or scoring output:
// model, prompt version, system prompt, sport and venue context, grounding
// facts, Paris medals, and corrections. When it matches the hash stored with
// the session's last output, regenerating would only reword the same inputs,
// so the stage skips the session.
function hashInput(parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16)
}

// Fingerprint of the corrections grounding sees for a session (session and
// sport scope), or undefined when there are none. A brief whose stored hash
// differs was written before the current corrections, so it gets rewritten
// from scratch rather than re-checked: a re-check could judge "no material
// change" and keep facts the correction contradicts.
export function groundingCorrectionsHash(session: SessionSource): string | undefined {
  const extra = buildCorrectionContext({ sessionIds: [session.id], sport: session.sport })
  return extra ? hashInput([extra]) : undefined
}

export function writingInputHash(
  session: SessionSource,
  grounding: GroundingData | undefined,
  model: string,
): string {
  const g = new Map<string, GroundingData>()
  if (grounding) g.set(session.id, grounding)
  const extra = buildCorrectionContext({ sessionIds: [session.id], sport: session.sport })
  return hashInput([
    model,
    String(WRITING_VERSION),
    WRITING_SYSTEM_PROMPT,
    buildSportContext(session.sport),
    buildVenueContext([session]),
    buildWritingSessionsBody([session], g, extra),
  ])
}

export function scoringInputHash(
  session: SessionSource,
  grounding: GroundingData | undefined,
  writing: WritingData | undefined,
  model: string,
): string {
  const g = new Map<string, GroundingData>()
  if (grounding) g.set(session.id, grounding)
  const w = new Map<string, WritingData>()
  if (writing) w.set(session.id, writing)
  const extra = buildCorrectionContext({ sessionIds: [session.id], sport: session.sport })
  return hashInput([
    model,
    String(SCORING_VERSION),
    SCORING_SYSTEM_PROMPT,
    buildSportContext(session.sport),
    buildVenueContext([session]),
    buildScoringSessionsBody([session], g, w, extra),
  ])
}
