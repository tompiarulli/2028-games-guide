import { describe, expect, it } from 'vitest'

import { searchSessions, toDayKey } from '@/data/agent.data.server'
import type { Session } from '@/types/session'

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'ATH01',
    sport: 'Athletics',
    name: 'ATH01 Athletics',
    desc: "Men's 100m Final",
    venue: 'Coliseum',
    zone: 'Exposition Park',
    date: 'Thu Jul 20',
    dk: '07-20',
    time: '6:00 PM–9:00 PM',
    rt: 'Final',
    soccer: false,
    rSig: 9,
    rExp: 9,
    rStar: 9,
    rUniq: 8,
    rDem: 9,
    agg: 8.8,
    ...overrides,
  }
}

const sessions = [
  makeSession(),
  makeSession({ id: 'ATH02', desc: "Women's 400m Heats", rt: 'Prelim', dk: '07-18', agg: 5 }),
  makeSession({ id: 'SWM01', sport: 'Swimming', desc: 'Heats', dk: '07-15', agg: 6 }),
]

describe('toDayKey', () => {
  it('accepts ISO dates and month-day keys', () => {
    expect(toDayKey('2028-07-19')).toBe('07-19')
    expect(toDayKey('07-19')).toBe('07-19')
    expect(toDayKey('July 19')).toBeNull()
  })
})

describe('searchSessions', () => {
  it('matches sport case-insensitively and keywords in the event', () => {
    expect(searchSessions({ sport: 'athletics' }, sessions).total).toBe(2)
    expect(searchSessions({ text: '100M' }, sessions).sessions.map((s) => s.id)).toEqual(['ATH01'])
  })

  it('applies score and date bounds', () => {
    expect(searchSessions({ minScore: 6 }, sessions).sessions.map((s) => s.id)).toEqual(['ATH01', 'SWM01'])
    expect(
      searchSessions({ dateFrom: '2028-07-16', dateTo: '2028-07-19' }, sessions).sessions.map((s) => s.id),
    ).toEqual(['ATH02'])
  })

  it('pages results and caps the limit', () => {
    const first = searchSessions({ sort: 'date', limit: 2 }, sessions)
    expect(first.sessions.map((s) => s.id)).toEqual(['SWM01', 'ATH02'])
    expect(first.nextOffset).toBe(2)

    const last = searchSessions({ sort: 'date', limit: 2, offset: 2 }, sessions)
    expect(last.nextOffset).toBeNull()

    expect(searchSessions({ limit: 1000 }, sessions).sessions).toHaveLength(3)
  })

  it('returns readable summaries', () => {
    const [summary] = searchSessions({}, sessions).sessions
    expect(summary).toEqual({
      id: 'ATH01',
      sport: 'Athletics',
      event: "Men's 100m Final",
      round: 'Final',
      date: '2028-07-20',
      weekday: 'Thu',
      time: '6:00 PM–9:00 PM',
      venue: 'Coliseum',
      zone: 'Exposition Park',
      score: 8.8,
      url: 'https://28games.tompiarulli.com/?session=ATH01',
    })
  })
})
