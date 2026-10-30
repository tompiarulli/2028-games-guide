import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type {
  Contender,
  ContentSource,
  RelatedNews,
  Scorecard,
  SessionSource,
} from '@/types/session'

// File-backed content store. Replaces the D1 staging tables with four JSON
// files under src/data/; each upsert mutates an in-memory cache and flushes
// atomically via temp-file rename. Reads are synchronous and cached.

const DATA_DIR = resolve(process.cwd(), 'src/data')

const SESSIONS_PATH = resolve(DATA_DIR, 'sessions.json')
const SESSION_FACTS_PATH = resolve(DATA_DIR, 'session-facts.json')
const SESSION_CONTENT_PATH = resolve(DATA_DIR, 'session-content.json')
const SESSION_SCORES_PATH = resolve(DATA_DIR, 'session-scores.json')
const SESSION_CORRECTIONS_PATH = resolve(DATA_DIR, 'session-corrections.json')
const SPORT_CORRECTIONS_PATH = resolve(DATA_DIR, 'sport-corrections.json')
const VENUE_CORRECTIONS_PATH = resolve(DATA_DIR, 'venue-corrections.json')

export interface StageMetadata {
  model: string
  promptVersion: number
  generatedAt: string
  batchId?: string
}

export interface GroundingEntry {
  facts: string[] | null
  relatedNews: RelatedNews[]
  sources: ContentSource[] | null
  model: string
  promptVersion: number
  generatedAt: string
  // Last time grounding re-checked this session and found no material change.
  // generatedAt only moves when the facts themselves change.
  checkedAt?: string
}

export interface WritingEntry {
  blurb: string
  potentialContendersIntro: string | null
  potentialContenders: Contender[]
  model: string
  promptVersion: number
  batchId: string | null
  generatedAt: string
  // writingInputHash() of the inputs this entry was generated from.
  inputHash?: string
}

export interface ScoringEntry {
  agg: number
  rSig: number
  rExp: number
  rStar: number
  rUniq: number
  rDem: number
  // null for legacy entries migrated from the pre-scorecard D1 snapshot.
  // generate-session-scores always writes a full scorecard.
  scorecard: Scorecard | null
  model: string
  promptVersion: number
  batchId: string | null
  generatedAt: string
  // scoringInputHash() of the inputs this entry was generated from.
  inputHash?: string
}

export interface GroundingUpsert {
  sessionId: string
  facts: string[] | null
  relatedNews: RelatedNews[]
  sources: ContentSource[] | undefined
}

export interface WritingUpsert {
  sessionId: string
  blurb: string
  potentialContendersIntro: string | undefined
  potentialContenders: Contender[]
  inputHash?: string
}

export interface ScoringUpsert {
  sessionId: string
  scorecard: Scorecard
  inputHash?: string
}

export interface StageStatus {
  sessionId: string
  groundingPromptVersion: number | null
  writingPromptVersion: number | null
  scoringPromptVersion: number | null
}

function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function writeJsonAtomic(path: string, data: unknown) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`)
  renameSync(tmp, path)
}

function sortedKeys<T>(map: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {}
  for (const key of Object.keys(map).sort()) out[key] = map[key]
  return out
}

let sessionsCache: SessionSource[] | null = null
let groundingCache: Record<string, GroundingEntry> | null = null
let writingCache: Record<string, WritingEntry> | null = null
let scoringCache: Record<string, ScoringEntry> | null = null
let sessionCorrectionsCache: Record<string, string[]> | null = null
let sportCorrectionsCache: Record<string, string[]> | null = null
let venueCorrectionsCache: Record<string, string[]> | null = null

type CorrectionsFile = Record<string, string[] | { notes?: string } | undefined>

function loadCorrections(path: string): Record<string, string[]> {
  const raw = readJsonFile<CorrectionsFile>(path, {})
  const out: Record<string, string[]> = {}
  for (const [key, val] of Object.entries(raw)) {
    if (key === '_meta') continue
    if (Array.isArray(val)) out[key] = val.filter((v): v is string => typeof v === 'string')
  }
  return out
}

function loadSessions(): SessionSource[] {
  if (sessionsCache) return sessionsCache
  sessionsCache = readJsonFile<SessionSource[]>(SESSIONS_PATH, [])
  return sessionsCache
}

function loadGrounding(): Record<string, GroundingEntry> {
  if (groundingCache) return groundingCache
  groundingCache = readJsonFile<Record<string, GroundingEntry>>(SESSION_FACTS_PATH, {})
  return groundingCache
}

function loadWriting(): Record<string, WritingEntry> {
  if (writingCache) return writingCache
  writingCache = readJsonFile<Record<string, WritingEntry>>(SESSION_CONTENT_PATH, {})
  return writingCache
}

function loadScoring(): Record<string, ScoringEntry> {
  if (scoringCache) return scoringCache
  scoringCache = readJsonFile<Record<string, ScoringEntry>>(SESSION_SCORES_PATH, {})
  return scoringCache
}

export function readAllSessions(): SessionSource[] {
  return loadSessions().slice()
}

export function readSessionById(id: string): SessionSource | null {
  return loadSessions().find((s) => s.id === id) ?? null
}

export function readStageStatus(): Map<string, StageStatus> {
  const sessions = loadSessions()
  const grounding = loadGrounding()
  const writing = loadWriting()
  const scoring = loadScoring()

  const out = new Map<string, StageStatus>()
  for (const s of sessions) {
    out.set(s.id, {
      sessionId: s.id,
      groundingPromptVersion: grounding[s.id]?.promptVersion ?? null,
      writingPromptVersion: writing[s.id]?.promptVersion ?? null,
      scoringPromptVersion: scoring[s.id]?.promptVersion ?? null,
    })
  }
  return out
}

export function readGroundingForSession(sessionId: string): GroundingEntry | null {
  return loadGrounding()[sessionId] ?? null
}

export function readWritingForSession(sessionId: string): WritingEntry | null {
  return loadWriting()[sessionId] ?? null
}

export function readScoringForSession(sessionId: string): ScoringEntry | null {
  return loadScoring()[sessionId] ?? null
}

export function readSessionCorrections(sessionId: string): string[] {
  if (!sessionCorrectionsCache) sessionCorrectionsCache = loadCorrections(SESSION_CORRECTIONS_PATH)
  return sessionCorrectionsCache[sessionId] ?? []
}

export function readSportCorrections(sport: string): string[] {
  if (!sportCorrectionsCache) sportCorrectionsCache = loadCorrections(SPORT_CORRECTIONS_PATH)
  return sportCorrectionsCache[sport] ?? []
}

export function readVenueCorrections(venue: string): string[] {
  if (!venueCorrectionsCache) venueCorrectionsCache = loadCorrections(VENUE_CORRECTIONS_PATH)
  return venueCorrectionsCache[venue] ?? []
}

// Serialize writes: each upsert reads-modify-writes the whole JSON file.
// Concurrent calls would otherwise clobber each other's mutations because
// they each snapshot the cache before the previous flush completes.
let writeChain: Promise<void> = Promise.resolve()
function enqueueWrite(fn: () => void): Promise<void> {
  const next = writeChain.then(() => {
    fn()
  })
  // Swallow rejection for the chain so a single failure doesn't poison
  // subsequent writes — but surface it to the caller of this upsert.
  writeChain = next.catch(() => undefined)
  return next
}

export function upsertGrounding(rows: GroundingUpsert[], meta: StageMetadata): Promise<void> {
  if (rows.length === 0) return Promise.resolve()
  return enqueueWrite(() => {
    const cache = loadGrounding()
    for (const r of rows) {
      cache[r.sessionId] = {
        facts: r.facts,
        relatedNews: r.relatedNews,
        sources: r.sources ?? null,
        model: meta.model,
        promptVersion: meta.promptVersion,
        generatedAt: meta.generatedAt,
      }
    }
    groundingCache = sortedKeys(cache)
    writeJsonAtomic(SESSION_FACTS_PATH, groundingCache)
  })
}

// Grounding re-checked these sessions and found nothing material: keep the
// stored facts, news, sources, and generatedAt; record the check.
export function markGroundingChecked(sessionIds: string[], meta: StageMetadata): Promise<void> {
  if (sessionIds.length === 0) return Promise.resolve()
  return enqueueWrite(() => {
    const cache = loadGrounding()
    for (const id of sessionIds) {
      const entry = cache[id]
      if (!entry) continue
      cache[id] = {
        ...entry,
        model: meta.model,
        promptVersion: meta.promptVersion,
        checkedAt: meta.generatedAt,
      }
    }
    writeJsonAtomic(SESSION_FACTS_PATH, cache)
  })
}

// Records input hashes for entries that are already current, without
// regenerating them (first run after hashes were introduced).
export function backfillInputHashes(
  stage: 'writing' | 'scoring',
  hashes: Map<string, string>,
): Promise<void> {
  if (hashes.size === 0) return Promise.resolve()
  return enqueueWrite(() => {
    const cache: Record<string, { inputHash?: string }> =
      stage === 'writing' ? loadWriting() : loadScoring()
    for (const [id, hash] of hashes) {
      if (cache[id]) cache[id].inputHash = hash
    }
    writeJsonAtomic(stage === 'writing' ? SESSION_CONTENT_PATH : SESSION_SCORES_PATH, cache)
  })
}

export function upsertWriting(rows: WritingUpsert[], meta: StageMetadata): Promise<void> {
  if (rows.length === 0) return Promise.resolve()
  return enqueueWrite(() => {
    const cache = loadWriting()
    for (const r of rows) {
      cache[r.sessionId] = {
        blurb: r.blurb,
        potentialContendersIntro: r.potentialContendersIntro ?? null,
        potentialContenders: r.potentialContenders,
        model: meta.model,
        promptVersion: meta.promptVersion,
        batchId: meta.batchId ?? null,
        generatedAt: meta.generatedAt,
        inputHash: r.inputHash,
      }
    }
    writingCache = sortedKeys(cache)
    writeJsonAtomic(SESSION_CONTENT_PATH, writingCache)
  })
}

export function upsertScoring(rows: ScoringUpsert[], meta: StageMetadata): Promise<void> {
  if (rows.length === 0) return Promise.resolve()
  return enqueueWrite(() => {
    const cache = loadScoring()
    for (const r of rows) {
      const sc = r.scorecard
      cache[r.sessionId] = {
        agg: sc.aggregate,
        rSig: sc.significance.score,
        rExp: sc.experience.score,
        rStar: sc.starPower.score,
        rUniq: sc.uniqueness.score,
        rDem: sc.demand.score,
        scorecard: sc,
        model: meta.model,
        promptVersion: meta.promptVersion,
        batchId: meta.batchId ?? null,
        generatedAt: meta.generatedAt,
        inputHash: r.inputHash,
      }
    }
    scoringCache = sortedKeys(cache)
    writeJsonAtomic(SESSION_SCORES_PATH, scoringCache)
  })
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}
