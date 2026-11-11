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

  // Responds with a record covering `answered(ids)` of the sessions in each request.
  function recordingClient(
    sessions: SessionSource[],
    answer: (ids: string[]) => { id: string; materialChange: boolean; facts: string[] }[],
  ) {
    return fakeClient((params) => {
      const prompt = String(params.messages[0].content)
      const ids = sessions.map((s) => s.id).filter((id) => prompt.includes(id))
      const record = {
        sessions: answer(ids).map((a) => ({
          id: a.id,
          materialChange: a.materialChange,
          groundingFacts: a.facts,
          relatedNews: [],
          sourceUrls: [],
        })),
      }
      return message('tool_use', [{ type: 'tool_use', id: 'toolu_1', name: 'record_grounding', input: record }])
    })
  }

  it('asks again about sessions a response left out', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // Requests covering more than two sessions only answer for the first two.
    const { client, stream } = recordingClient(batch, (ids) =>
      ids.slice(0, 2).map((id) => ({ id, materialChange: true, facts: [`Fact about ${id}`] })),
    )

    const results = await fetchGroundingBatch(client, batch, 'Football (Soccer)', 'm')

    expect(results.map((r) => r.id).sort()).toEqual(batch.map((s) => s.id).sort())
    // 8 → 6 left out, asked in halves of 3 → each leaves 1 out, asked once more.
    expect(stream).toHaveBeenCalledTimes(1 + 2 + 2)
  })

  it('stops re-asking after the retry limit', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { client, stream } = recordingClient(batch, () => [])

    const results = await fetchGroundingBatch(client, batch, 'Football (Soccer)', 'm')

    expect(results).toEqual([])
    // 8 → halves of 4 → halves of 2, then give up.
    expect(stream).toHaveBeenCalledTimes(1 + 2 + 4)
  })

  it('never returns a changed brief with no facts', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const pair = batch.slice(0, 2)
    // "No change" for a session with no stored brief counts as changed, so it's empty too.
    const { client } = recordingClient(pair, (ids) =>
      ids.map((id) => ({ id, materialChange: id === pair[0].id, facts: [] })),
    )

    const results = await fetchGroundingBatch(client, pair, 'Football (Soccer)', 'm', undefined, undefined, 0)

    expect(results).toEqual([])
  })

  it('keeps "no change" for a session that has a stored brief', async () => {
    const [session] = batch
    const previous = new Map([[session.id, { facts: ['Old fact'], newsTitles: [], gatheredAt: '2026-10-30' }]])
    const { client } = recordingClient([session], (ids) => ids.map((id) => ({ id, materialChange: false, facts: [] })))

    const results = await fetchGroundingBatch(client, [session], 'Football (Soccer)', 'm', undefined, previous)

    expect(results).toHaveLength(1)
    expect(results[0].materialChange).toBe(false)
  })
})
