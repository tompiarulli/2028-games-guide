import sessionContentData from '@/data/session-content.json'
import sessionFactsData from '@/data/session-facts.json'
import sessionScoresData from '@/data/session-scores.json'
import sessionsData from '@/data/sessions.json'
import { getSessionInsights, type SessionInsights } from '@/lib/ai-scorecard'
import { filterSessions, sortSessions } from '@/lib/filter'
import type {
  Contender,
  ContentMeta,
  ContentSource,
  Filters,
  RelatedNews,
  Scorecard,
  Session,
  SessionContent,
  SessionSource,
  SortState,
} from '@/types/session'

export interface SessionsPage {
  items: Session[]
  nextOffset: number | null
  total: number
  sports: string[]
  zones: string[]
}

export interface SessionDetailPayload {
  session: Session
  insights: SessionInsights
  contentMeta?: ContentMeta
}

interface GroundingEntry {
  facts: string[] | null
  relatedNews: RelatedNews[]
  sources: ContentSource[] | null
  model: string
  promptVersion: number
  generatedAt: string
}

interface WritingEntry {
  blurb: string
  potentialContendersIntro: string | null
  potentialContenders: Contender[]
  model: string
  promptVersion: number
  batchId: string | null
  generatedAt: string
}

interface ScoringEntry {
  agg: number
  rSig: number
  rExp: number
  rStar: number
  rUniq: number
  rDem: number
  scorecard: Scorecard | null
  model: string
  promptVersion: number
  batchId: string | null
  generatedAt: string
}

const sessionSources = sessionsData as SessionSource[]
const sessionFacts = sessionFactsData as Record<string, GroundingEntry>
const sessionContent = sessionContentData as Record<string, WritingEntry>
const sessionScores = sessionScoresData as Record<string, ScoringEntry>

function toSession(source: SessionSource): Session {
  const score = sessionScores[source.id]
  return {
    ...source,
    agg: score?.agg ?? 0,
    rSig: score?.rSig ?? 0,
    rExp: score?.rExp ?? 0,
    rStar: score?.rStar ?? 0,
    rUniq: score?.rUniq ?? 0,
    rDem: score?.rDem ?? 0,
  }
}

// Merge happens once at module load. Session list is small (~1000) so the
// cost is trivial and we avoid redoing the join on every request.
const sessions: Session[] = sessionSources.map(toSession)
const sessionsById = new Map(sessions.map((s) => [s.id, s]))

const sports = [...new Set(sessions.map((s) => s.sport).filter(Boolean))].sort()
const zones = [...new Set(sessions.map((s) => s.zone).filter(Boolean))].sort()

export async function getSessionsPageData({
  filters,
  sort,
  offset,
  limit,
}: {
  filters: Filters
  sort: SortState
  offset: number
  limit: number
}): Promise<SessionsPage> {
  const filtered = filterSessions(sessions, filters)
  const sorted = sortSessions(filtered, sort)
  const items = sorted.slice(offset, offset + limit)
  const nextOffset = offset + items.length < sorted.length ? offset + items.length : null

  return {
    items,
    nextOffset,
    total: sorted.length,
    sports,
    zones,
  }
}

export async function getSessionDetailData(
  sessionId: string,
): Promise<SessionDetailPayload | null> {
  const session = sessionsById.get(sessionId)
  if (!session) return null

  const content = getSessionContent(sessionId)

  return {
    session,
    insights: getSessionInsights({ ...session, ...content }),
    contentMeta: content.contentMeta,
  }
}

export function getSessionContent(sessionId: string): SessionContent {
  const w = sessionContent[sessionId]
  const g = sessionFacts[sessionId]
  const s = sessionScores[sessionId]

  return {
    blurb: w?.blurb,
    potentialContendersIntro: w?.potentialContendersIntro ?? undefined,
    potentialContenders: w?.potentialContenders,
    relatedNews: g?.relatedNews,
    scorecard: s?.scorecard ?? undefined,
    contentMeta: buildContentMeta(g, w, s),
  }
}

export function getAllSessions(): readonly Session[] {
  return sessions
}

export function getSessionById(sessionId: string): Session | undefined {
  return sessionsById.get(sessionId)
}

function buildContentMeta(
  g: GroundingEntry | undefined,
  w: WritingEntry | undefined,
  s: ScoringEntry | undefined,
): ContentMeta | undefined {
  if (!g && !w && !s) return undefined
  return {
    provider: 'hybrid',
    groundingModel: g?.model,
    writingModel: w?.model,
    scoringModel: s?.model,
    sources: g?.sources ?? undefined,
    generatedAt: s?.generatedAt || w?.generatedAt || g?.generatedAt || '',
  }
}

export async function getSessionsByIds(ids: string[]): Promise<Session[]> {
  if (ids.length === 0) return []
  const out: Session[] = []
  for (const id of ids) {
    const s = sessionsById.get(id)
    if (s) out.push(s)
  }
  return out.sort((a, b) => a.dk.localeCompare(b.dk) || a.name.localeCompare(b.name))
}
