import { readFileSync } from 'node:fs'

import type Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it, vi } from 'vitest'

import type { SessionSource } from '../../src/types/session.js'
import { TruncatedResponseError, assertNotTruncated, runResearch } from './claude-research.js'
import { fetchGroundingBatch } from './session-content.js'

const usage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}

function message(stopReason: string, content: unknown[] = []) {
  return { model: 'claude-opus-5-5', stop_reason: stopReason, usage, content }
}

// A client whose stream() answers with whatever `respond` returns for the request.
function fakeClient(respond: (params: { messages: { content: unknown }[] }) => unknown) {
  const stream = vi.fn((params) => ({ finalMessage: async () => respond(params) }))
  return { client: { messages: { stream } } as unknown as Anthropic, stream }
}

describe('assertNotTruncated', () => {
  it('throws only for max_tokens', () => {
    expect(() => assertNotTruncated('max_tokens')).toThrow(TruncatedResponseError)
    expect(() => assertNotTruncated('end_turn')).not.toThrow()
    expect(() => assertNotTruncated('tool_use')).not.toThrow()
  })
})

describe('runResearch', () => {
  it('rejects a response that ran out of tokens instead of returning its partial content', async () => {
    const { client } = fakeClient(() => message('max_tokens', [{ type: 'text', text: 'partial' }]))
    const params = { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'q' }] }
    await expect(runResearch(client, params as never)).rejects.toThrow(TruncatedResponseError)
  })
})

describe('fetchGroundingBatch', () => {
  const sessions = (JSON.parse(readFileSync('src/data/sessions.json', 'utf8')) as SessionSource[]).filter(
    (s) => s.sport === 'Football (Soccer)',
  )
  const batch = sessions.slice(0, 8)

  it('splits a request that runs out of tokens until each part fits', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // Requests covering more than two sessions run out of tokens.
    const { client, stream } = fakeClient((params) => {
      const prompt = String(params.messages[0].content)
      const ids = batch.map((s) => s.id).filter((id) => prompt.includes(`${id}`))
      if (ids.length > 2) return message('max_tokens')
      const record = {
        sessions: ids.map((id) => ({
          id,
          materialChange: true,
          groundingFacts: [`Fact about ${id}`],
          relatedNews: [],
          sourceUrls: [],
        })),
      }
      return message('tool_use', [{ type: 'tool_use', id: 'toolu_1', name: 'record_grounding', input: record }])
    })

    const results = await fetchGroundingBatch(client, batch, 'Football (Soccer)', 'm')

    expect(results.map((r) => r.id).sort()).toEqual(batch.map((s) => s.id).sort())
    expect(results.every((r) => r.groundingFacts.length === 1)).toBe(true)
    // 8 → 4 + 4 → four requests of 2, with no retries of a request that already ran out.
    expect(stream).toHaveBeenCalledTimes(1 + 2 + 4)
  })
})
