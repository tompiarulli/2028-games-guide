import { getAllSessions, getSessionById, getSessionContent } from '@/data/sessions.data.server'
import { SPORT_FACTS } from '@/data/sport-facts'
import { VENUE_FACTS, type VenueFacts } from '@/data/venue-facts'
import { sortSessions } from '@/lib/filter'
import { SITE_URL } from '@/lib/seo'
import type { RoundType, Session } from '@/types/session'

// Read-only views of the session catalog for agents: the MCP tools and the JSON API.
// Field names are spelled out (`score`, `round`, ISO `date`) instead of the UI's short keys,
// so a model can read results without a glossary.

const GAMES_YEAR = 2028

export interface AgentSessionSummary {
  id: string
  sport: string
  event: string
  round: RoundType
  date: string | null
  weekday: string | null
  time: string
  venue: string
  zone: string
  score: number
  url: string
}

export interface SessionSearchInput {
  sport?: string
  venue?: string
  zone?: string
  round?: RoundType
  dateFrom?: string
  dateTo?: string
  minScore?: number
  text?: string
  sort?: 'score' | 'date'
  offset?: number
  limit?: number
}

export interface SessionSearchResult {
  total: number
  offset: number
  nextOffset: number | null
  sessions: AgentSessionSummary[]
}

export const MAX_SEARCH_LIMIT = 50

export function sessionUrl(id: string): string {
  return `${SITE_URL}/?session=${encodeURIComponent(id)}`
}

// `dk` is the schedule's month-day key ("07-19"); sessions without a date use another value.
function isoDate(session: Session): string | null {
  return /^\d{2}-\d{2}$/.test(session.dk) ? `${GAMES_YEAR}-${session.dk}` : null
}

export function toAgentSummary(session: Session): AgentSessionSummary {
  const date = isoDate(session)
  return {
    id: session.id,
    sport: session.sport,
    event: session.desc,
    round: session.rt,
    date,
    weekday: date ? session.date.split(' ')[0] : null,
    time: session.time,
    venue: session.venue,
    zone: session.zone,
    score: session.agg,
    url: sessionUrl(session.id),
  }
}

// Accepts "2028-07-19" or "07-19" and returns the month-day key, or null if unparseable.
export function toDayKey(value: string): string | null {
  const match = value.trim().match(/^(?:\d{4}-)?(\d{2})-(\d{2})$/)
  return match ? `${match[1]}-${match[2]}` : null
}

function equalsIgnoreCase(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0
}

export function searchSessions(
  input: SessionSearchInput,
  sessions: readonly Session[] = getAllSessions(),
): SessionSearchResult {
  const from = input.dateFrom ? toDayKey(input.dateFrom) : null
  const to = input.dateTo ? toDayKey(input.dateTo) : null
  const text = input.text?.trim().toLowerCase()

  const matches = sessions.filter((s) => {
    if (input.sport && !equalsIgnoreCase(s.sport, input.sport)) return false
    if (input.venue && !equalsIgnoreCase(s.venue, input.venue)) return false
    if (input.zone && !equalsIgnoreCase(s.zone, input.zone)) return false
    if (input.round && s.rt !== input.round) return false
    if (from && s.dk < from) return false
    if (to && s.dk > to) return false
    if (input.minScore !== undefined && s.agg < input.minScore) return false
    if (text && !`${s.sport} ${s.desc}`.toLowerCase().includes(text)) return false
    return true
  })

  const sorted = sortSessions(
    matches,
    input.sort === 'date' ? { col: 'date', dir: 'asc' } : { col: 'agg', dir: 'desc' },
  )
  const offset = Math.max(0, input.offset ?? 0)
  const limit = Math.min(Math.max(1, input.limit ?? 20), MAX_SEARCH_LIMIT)
  const page = sorted.slice(offset, offset + limit)

  return {
    total: sorted.length,
    offset,
    nextOffset: offset + page.length < sorted.length ? offset + page.length : null,
    sessions: page.map(toAgentSummary),
  }
}

export function getAgentSessionDetail(id: string) {
  const session = getSessionById(id)
  if (!session) return null

  const content = getSessionContent(id)
  const sport = SPORT_FACTS[session.sport]
  const venue = VENUE_FACTS[session.venue]

  return {
    ...toAgentSummary(session),
    ratings: {
      significance: session.rSig,
      experience: session.rExp,
      starPower: session.rStar,
      uniqueness: session.rUniq,
      demand: session.rDem,
    },
    scorecard: content.scorecard ?? null,
    summary: content.blurb ?? null,
    contendersIntro: content.potentialContendersIntro ?? null,
    contenders: content.potentialContenders ?? [],
    relatedNews: (content.relatedNews ?? []).map((n) => ({
      title: n.title,
      summary: n.summary,
      source: n.sourceName,
      url: n.sourceUrl,
      publishedDate: n.publishedDate,
    })),
    sportContext: sport ? { gamesContext: sport.gamesContext, parisRecap: sport.parisRecap } : null,
    venueFacts: venue ?? null,
    contentGeneratedAt: content.contentMeta?.generatedAt || null,
  }
}

function dateRange(sessions: readonly Session[]) {
  const days = sessions
    .map(isoDate)
    .filter((d): d is string => d !== null)
    .sort()
  return { firstDate: days[0] ?? null, lastDate: days.at(-1) ?? null }
}

function groupBy(sessions: readonly Session[], key: (s: Session) => string) {
  const groups = new Map<string, Session[]>()
  for (const s of sessions) {
    const k = key(s)
    if (!k) continue
    const list = groups.get(k)
    if (list) list.push(s)
    else groups.set(k, [s])
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b))
}

export function listSports(sessions: readonly Session[] = getAllSessions()) {
  return groupBy(sessions, (s) => s.sport).map(([sport, list]) => ({
    sport,
    sessionCount: list.length,
    medalSessionCount: list.filter((s) => s.rt === 'Final' || s.rt === 'Bronze').length,
    topScore: Math.max(...list.map((s) => s.agg)),
    venues: [...new Set(list.map((s) => s.venue))].filter((v) => v !== 'N/A').sort(),
    ...dateRange(list),
  }))
}

export function listVenues(sessions: readonly Session[] = getAllSessions()) {
  return groupBy(sessions, (s) => (s.venue === 'N/A' ? '' : s.venue)).map(([venue, list]) => ({
    venue,
    zone: list[0].zone,
    location: VENUE_FACTS[venue]?.location ?? null,
    capacity: VENUE_FACTS[venue]?.capacity ?? null,
    sports: [...new Set(list.map((s) => s.sport))].sort(),
    sessionCount: list.length,
    ...dateRange(list),
  }))
}

export function getAgentVenue(
  name: string,
  sessions: readonly Session[] = getAllSessions(),
): {
  venue: string
  zone: string
  facts: VenueFacts | null
  sessions: AgentSessionSummary[]
} | null {
  const list = sessions.filter((s) => s.venue !== 'N/A' && equalsIgnoreCase(s.venue, name))
  if (list.length === 0) return null
  const venue = list[0].venue
  return {
    venue,
    zone: list[0].zone,
    facts: VENUE_FACTS[venue] ?? null,
    sessions: sortSessions(list, { col: 'date', dir: 'asc' }).map(toAgentSummary),
  }
}
