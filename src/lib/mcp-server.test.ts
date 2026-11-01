import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { handleMcpRequest } from '@/lib/mcp-server'

const ENDPOINT = 'http://localhost/mcp'

// A real MCP client whose requests go straight to the route's handler instead of the network.
async function connect() {
  const client = new Client({ name: 'test', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    fetch: (input, init) => handleMcpRequest(new Request(input, init)),
  })
  await client.connect(transport)
  return client
}

function parse(result: Awaited<ReturnType<Client['callTool']>>) {
  const [first] = result.content as { type: string; text: string }[]
  return JSON.parse(first.text)
}

describe('MCP endpoint', () => {
  let client: Client

  beforeEach(async () => {
    client = await connect()
  })

  afterEach(async () => {
    await client.close()
  })

  it('advertises read-only tools and instructions', async () => {
    const { tools } = await client.listTools()

    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_session',
      'get_venue',
      'list_sports',
      'list_venues',
      'search_sessions',
    ])
    expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true)
    expect(client.getInstructions()).toContain('0 to 10')
  })

  it('searches sessions by sport and round, best first', async () => {
    const result = parse(
      await client.callTool({
        name: 'search_sessions',
        arguments: { sport: 'swimming', round: 'Final', limit: 5 },
      }),
    )

    expect(result.total).toBeGreaterThan(0)
    expect(result.sessions.length).toBeLessThanOrEqual(5)
    for (const s of result.sessions) {
      expect(s.sport).toBe('Swimming')
      expect(s.round).toBe('Final')
      expect(s.date).toMatch(/^2028-07-\d{2}$/)
      expect(s.url).toBe(`https://28games.tompiarulli.com/?session=${s.id}`)
    }
    const scores = result.sessions.map((s: { score: number }) => s.score)
    expect(scores).toEqual([...scores].sort((a, b) => b - a))
  })

  it('filters by date range and sorts by date', async () => {
    const result = parse(
      await client.callTool({
        name: 'search_sessions',
        arguments: { date_from: '2028-07-20', date_to: '07-21', sort: 'date', limit: 50 },
      }),
    )

    const dates = result.sessions.map((s: { date: string }) => s.date)
    expect(dates.length).toBeGreaterThan(0)
    expect(dates.every((d: string) => d >= '2028-07-20' && d <= '2028-07-21')).toBe(true)
    expect(dates).toEqual([...dates].sort())
  })

  it('returns the full guide for one session', async () => {
    const [first] = parse(await client.callTool({ name: 'search_sessions', arguments: { limit: 1 } })).sessions

    const detail = parse(await client.callTool({ name: 'get_session', arguments: { id: first.id.toLowerCase() } }))

    expect(detail.id).toBe(first.id)
    expect(detail.summary).toEqual(expect.any(String))
    expect(detail.ratings).toEqual(
      expect.objectContaining({ significance: expect.any(Number), demand: expect.any(Number) }),
    )
  })

  it('reports unknown ids as tool errors', async () => {
    const result = await client.callTool({ name: 'get_session', arguments: { id: 'NOPE99' } })

    expect(result.isError).toBe(true)
  })

  it('lists sports and venues, and looks up a venue schedule', async () => {
    const sports = parse(await client.callTool({ name: 'list_sports', arguments: {} }))
    const venues = parse(await client.callTool({ name: 'list_venues', arguments: {} }))

    expect(sports.length).toBeGreaterThan(30)
    expect(venues.some((v: { venue: string }) => v.venue === 'N/A')).toBe(false)

    const venue = parse(await client.callTool({ name: 'get_venue', arguments: { name: venues[0].venue } }))
    expect(venue.sessions.length).toBe(venues[0].sessionCount)
  })
})

describe('MCP endpoint HTTP', () => {
  it('answers CORS preflight', async () => {
    const response = await handleMcpRequest(new Request(ENDPOINT, { method: 'OPTIONS' }))

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
  })
})
