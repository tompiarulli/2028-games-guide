import type { Usage } from '@anthropic-ai/sdk/resources/messages'
import { describe, expect, it } from 'vitest'

import type { SessionSource } from '../../src/types/session.js'
import {
  containsBannedTerm,
  type GroundingData,
  groundingCorrectionsHash,
  writingInputHash,
} from './session-content.js'
import { estimateCost } from './usage.js'

function usage(partial: Partial<Usage>): Usage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    ...partial,
  } as Usage
}

describe('containsBannedTerm', () => {
  it.each(['the Olympics', 'an Olympian', 'Paralympic archery', 'LA28 release', 'LA 28'])('flags %s', (text) =>
    expect(containsBannedTerm(text)).toBe(true),
  )

  it.each(['the 2028 Games', 'Para Games ceremony', 'Los Angeles 2028', 'Paris 2024'])('allows %s', (text) =>
    expect(containsBannedTerm(text)).toBe(false),
  )
})

describe('estimateCost', () => {
  it('prices tokens, cache, and searches at list rates', () => {
    const u = usage({
      input_tokens: 1_000_000,
      output_tokens: 100_000,
      cache_read_input_tokens: 1_000_000,
      server_tool_use: { web_search_requests: 10 } as Usage['server_tool_use'],
    })
    // 4 (input) + 0.4 (cache read) + 2 (output) + 0.10 (searches)
    expect(estimateCost('claude-opus-5-5', u, false)).toBeCloseTo(6.5)
  })

  it('halves token cost in batches but not search fees', () => {
    const u = usage({
      input_tokens: 1_000_000,
      server_tool_use: { web_search_requests: 100 } as Usage['server_tool_use'],
    })
    expect(estimateCost('claude-sonnet-5-5', u, true)).toBeCloseTo(1 + 1)
  })

  it('uses the long-prompt Haiku rate above 100K prompt tokens', () => {
    expect(estimateCost('claude-haiku-5-5', usage({ input_tokens: 100_000 }), false)).toBeCloseTo(0.01)
    expect(estimateCost('claude-haiku-5-5', usage({ input_tokens: 200_000 }), false)).toBeCloseTo(0.1)
  })

  it('returns null for models without a rate', () => {
    expect(estimateCost('some-other-model', usage({ input_tokens: 1 }), false)).toBeNull()
  })
})

describe('groundingCorrectionsHash', () => {
  it('is undefined for a session with no session or sport corrections', () => {
    const s = { id: 'ARC01', sport: 'Archery' } as SessionSource
    expect(groundingCorrectionsHash(s)).toBeUndefined()
  })

  it('reflects sport-wide corrections', () => {
    const s = { id: 'BDM01', sport: 'Badminton' } as SessionSource
    expect(groundingCorrectionsHash(s)).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('writingInputHash', () => {
  const session = {
    id: 'ARC01',
    sport: 'Archery',
    name: 'ARC01 Archery',
    desc: "Women's Individual Ranking Round",
    rt: 'Prelim',
    venue: 'Carson Field',
    date: 'Sat Jul 15',
    time: '9:00 AM–12:00 PM',
  } as SessionSource
  const grounding: GroundingData = {
    id: 'ARC01',
    groundingFacts: ['Lim Si-hyeon won Paris 2024 gold.'],
    relatedNews: [],
  }

  it('is stable for identical inputs', () => {
    expect(writingInputHash(session, grounding, 'm')).toBe(writingInputHash(session, grounding, 'm'))
  })

  it('changes when facts or the model change', () => {
    const base = writingInputHash(session, grounding, 'm')
    const moreFacts = { ...grounding, groundingFacts: [...grounding.groundingFacts, 'New fact.'] }
    expect(writingInputHash(session, moreFacts, 'm')).not.toBe(base)
    expect(writingInputHash(session, grounding, 'other')).not.toBe(base)
  })

  it('ignores news, which writing never sees', () => {
    const withNews = {
      ...grounding,
      relatedNews: [
        {
          id: 'n',
          title: 't',
          summary: 's',
          sourceName: 'x',
          sourceUrl: 'https://x.com',
          publishedDate: '2026-01-01',
          tags: [],
        },
      ],
    }
    expect(writingInputHash(session, withNews, 'm')).toBe(writingInputHash(session, grounding, 'm'))
  })
})
