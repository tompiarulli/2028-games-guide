import type { Usage } from '@anthropic-ai/sdk/resources/messages'

// Per-run token, search, and cost accounting. Every API response the pipeline
// reads (sync or batch) is recorded here, and each script prints a summary at
// the end so cost changes can be measured rather than estimated.

interface Rates {
  input: number // $ per million input tokens
  output: number // $ per million output tokens
}

// First-party list prices. Haiku 5.5 charges more once a prompt passes 100K
// tokens. Cache writes bill at 1.25x input (5-minute TTL), cache reads at 0.1x,
// and the Batches API halves token prices. Web search is $10 per 1,000.
const RATES: Record<string, Rates | ((promptTokens: number) => Rates)> = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': (promptTokens) =>
    promptTokens > 100_000 ? { input: 0.5, output: 2.5 } : { input: 0.1, output: 0.5 },
}
const WEB_SEARCH_PRICE = 10 / 1000
const BATCH_DISCOUNT = 0.5

export interface UsageTotals {
  requests: number
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  webSearches: number
  // null when any recorded model has no entry in RATES
  cost: number | null
}

function emptyTotals(): UsageTotals {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    webSearches: 0,
    cost: 0,
  }
}

export function estimateCost(model: string, usage: Usage, batch: boolean): number | null {
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const entry = RATES[model]
  if (!entry) return null
  const rates =
    typeof entry === 'function' ? entry(usage.input_tokens + cacheWrite + cacheRead) : entry
  const tokenCost =
    (usage.input_tokens * rates.input +
      cacheWrite * rates.input * 1.25 +
      cacheRead * rates.input * 0.1 +
      usage.output_tokens * rates.output) /
    1_000_000
  const searches = usage.server_tool_use?.web_search_requests ?? 0
  return tokenCost * (batch ? BATCH_DISCOUNT : 1) + searches * WEB_SEARCH_PRICE
}

const totalsByModel = new Map<string, UsageTotals>()

export function recordUsage(model: string, usage: Usage, batch: boolean) {
  let t = totalsByModel.get(model)
  if (!t) {
    t = emptyTotals()
    totalsByModel.set(model, t)
  }
  t.requests += 1
  t.inputTokens += usage.input_tokens
  t.outputTokens += usage.output_tokens
  t.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0
  t.cacheReadTokens += usage.cache_read_input_tokens ?? 0
  t.webSearches += usage.server_tool_use?.web_search_requests ?? 0
  const cost = estimateCost(model, usage, batch)
  t.cost = t.cost === null || cost === null ? null : t.cost + cost
}

function fmt(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n.toLocaleString()
}

export function printUsageSummary() {
  if (totalsByModel.size === 0) return
  console.log('\nUsage (estimated from list prices):')
  let total: number | null = 0
  for (const [model, t] of totalsByModel) {
    const cost = t.cost === null ? 'n/a' : `$${t.cost.toFixed(2)}`
    console.log(
      `  ${model}: ${t.requests} req  in ${fmt(t.inputTokens)}  out ${fmt(t.outputTokens)}  cache w/r ${fmt(t.cacheWriteTokens)}/${fmt(t.cacheReadTokens)}  searches ${t.webSearches}  ≈ ${cost}`,
    )
    total = total === null || t.cost === null ? null : total + t.cost
  }
  if (total !== null) console.log(`  total ≈ $${total.toFixed(2)}`)
}
