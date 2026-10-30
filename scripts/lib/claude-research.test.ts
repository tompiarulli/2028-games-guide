import type { ContentBlock } from '@anthropic-ai/sdk/resources/messages'
import { describe, expect, it } from 'vitest'

import { buildResearchParams, extractRecord, extractSearchSources } from './claude-research.js'

function searchResult(results: { url: string; title: string; page_age?: string | null }[]) {
  return {
    type: 'web_search_tool_result',
    tool_use_id: 'srvtoolu_1',
    content: results.map((r) => ({
      type: 'web_search_result',
      encrypted_content: 'x',
      page_age: r.page_age ?? null,
      title: r.title,
      url: r.url,
    })),
  } as unknown as ContentBlock
}

function toolUse(name: string, input: unknown) {
  return { type: 'tool_use', id: 'toolu_1', name, input } as unknown as ContentBlock
}

describe('buildResearchParams', () => {
  it('pairs web search with a strict record tool', () => {
    const params = buildResearchParams({
      model: 'claude-opus-5-5',
      system: 'sys',
      prompt: 'Research Archery.',
      recordTool: { name: 'record_x', description: 'd', schema: { type: 'object' } },
      maxSearches: 4,
    })
    expect(params.tools).toEqual([
      { type: 'web_search_20260209', name: 'web_search', max_uses: 4 },
      { name: 'record_x', description: 'd', input_schema: { type: 'object' }, strict: true },
    ])
    expect(params.tool_choice).toBeUndefined()
    expect(params.messages[0].content).toContain('call the record_x tool exactly once')
  })
})

describe('extractRecord', () => {
  it('returns the input of the last matching tool call', () => {
    const content = [
      toolUse('record_x', { v: 1 }),
      { type: 'text', text: 'revising' } as ContentBlock,
      toolUse('record_x', { v: 2 }),
    ]
    expect(extractRecord(content, 'record_x')).toEqual({ v: 2 })
  })

  it('throws when the record tool was never called', () => {
    const content = [{ type: 'text', text: '{"v":1}' } as ContentBlock]
    expect(() => extractRecord(content, 'record_x')).toThrow('did not call record_x')
  })
})

describe('extractSearchSources', () => {
  it('dedupes results across searches and skips error blocks', () => {
    const content = [
      searchResult([
        { url: 'https://a.com/1', title: ' A ', page_age: 'May 1, 2026' },
        { url: 'https://b.com/2', title: '' },
      ]),
      {
        type: 'web_search_tool_result',
        tool_use_id: 'srvtoolu_2',
        content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' },
      } as unknown as ContentBlock,
      searchResult([{ url: 'https://a.com/1', title: 'A again' }]),
    ]
    expect(extractSearchSources(content)).toEqual([
      { title: 'A', url: 'https://a.com/1', lastUpdated: 'May 1, 2026' },
      { title: 'https://b.com/2', url: 'https://b.com/2', lastUpdated: undefined },
    ])
  })
})
