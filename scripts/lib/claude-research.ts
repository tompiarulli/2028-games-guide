import type Anthropic from '@anthropic-ai/sdk'
import type {
  ContentBlock,
  MessageCreateParamsNonStreaming,
  MessageParam,
  Tool,
} from '@anthropic-ai/sdk/resources/messages'

import type { ContentSource } from '../../src/types/session.js'
import { recordUsage } from './usage.js'

// Research stages (sport facts, venue facts, session grounding) run Claude with
// the server-side web search tool. Web search citations are always on, and
// citations can't be combined with `output_config.format`, so instead of JSON
// output mode each request carries a strict "record" tool that Claude calls
// once with its final answer. The tool input is the structured result.
export const RESEARCH_DEFAULT_MODEL = 'claude-opus-5-5'
export const RESEARCH_EFFORT = 'medium'

// A long search turn can come back with stop_reason "pause_turn"; the sync path
// resends it to let the server resume. The Batches API can't continue a paused
// turn, so a batch item that pauses is reported as failed and picked up on the
// next run.
const MAX_CONTINUATIONS = 5

export interface RecordTool {
  name: string
  description: string
  schema: Record<string, unknown>
}

export interface ResearchRequest {
  model: string
  system: string
  prompt: string
  recordTool: RecordTool
  maxSearches: number
  maxTokens?: number
}

export function buildResearchParams(req: ResearchRequest): MessageCreateParamsNonStreaming {
  return {
    model: req.model,
    max_tokens: req.maxTokens ?? 16000,
    output_config: { effort: RESEARCH_EFFORT },
    system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
    tools: [
      { type: 'web_search_20260209', name: 'web_search', max_uses: req.maxSearches },
      {
        name: req.recordTool.name,
        description: req.recordTool.description,
        input_schema: req.recordTool.schema as Tool.InputSchema,
        strict: true,
      },
    ],
    messages: [
      {
        role: 'user',
        content: `${req.prompt}\n\nWhen your research is done, call the ${req.recordTool.name} tool exactly once with your final answer. Do not write the answer as plain text.`,
      },
    ],
  }
}

// Returns the input Claude passed to the record tool. Throws if it never called
// it (e.g. the turn paused, hit max_tokens, or was refused).
export function extractRecord(content: ContentBlock[], toolName: string): unknown {
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i]
    if (block.type === 'tool_use' && block.name === toolName) return block.input
  }
  throw new Error(`Claude did not call ${toolName}`)
}

// Every page the web search tool returned during the turn, deduplicated by URL.
// Dynamic filtering runs searches from code execution, but their result blocks
// still appear in the response content.
export function extractSearchSources(content: ContentBlock[]): ContentSource[] {
  const seen = new Set<string>()
  const sources: ContentSource[] = []
  for (const block of content) {
    if (block.type !== 'web_search_tool_result' || !Array.isArray(block.content)) continue
    for (const result of block.content) {
      if (!result.url || seen.has(result.url)) continue
      seen.add(result.url)
      sources.push({
        title: result.title?.trim() || result.url,
        url: result.url,
        lastUpdated: result.page_age ?? undefined,
      })
    }
  }
  return sources
}

// Runs one research request on the Messages API, resuming paused turns. Returns
// the content blocks from every continuation so sources from earlier segments
// aren't lost.
export async function runResearch(
  client: Anthropic,
  params: MessageCreateParamsNonStreaming,
): Promise<ContentBlock[]> {
  const messages: MessageParam[] = [...params.messages]
  const content: ContentBlock[] = []
  for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
    const response = await client.messages.stream({ ...params, messages }).finalMessage()
    recordUsage(response.model, response.usage, false)
    content.push(...response.content)
    if (response.stop_reason === 'refusal') {
      throw new Error(`Refused (${response.stop_details?.category ?? 'no category'})`)
    }
    if (response.stop_reason !== 'pause_turn') return content
    messages.push({ role: 'assistant', content: response.content })
  }
  throw new Error(`Turn still paused after ${MAX_CONTINUATIONS} continuations`)
}
