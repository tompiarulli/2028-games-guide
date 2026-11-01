import { createFileRoute } from '@tanstack/react-router'

// The whole schedule as one JSON document, for agents and scripts that fetch URLs rather
// than speak MCP. Summaries only; per-session detail is behind the `get_session` MCP tool.
export const Route = createFileRoute('/api/sessions.json')({
  server: {
    handlers: {
      GET: async () => {
        const [{ toAgentSummary }, { getAllSessions }, { sortSessions }, { SITE_URL }] =
          await Promise.all([
            import('@/data/agent.data.server'),
            import('@/data/sessions.data.server'),
            import('@/lib/filter'),
            import('@/lib/seo'),
          ])

        const sessions = sortSessions([...getAllSessions()], { col: 'date', dir: 'asc' }).map(
          toAgentSummary,
        )

        const body = {
          source: SITE_URL,
          description:
            'The full session schedule for the 2028 Summer Games in Los Angeles, from an unofficial guide. score is a 0-10 AI-generated rating of how worth attending each session is. Times are local Pacific time.',
          mcp: `${SITE_URL}/mcp`,
          count: sessions.length,
          sessions,
        }

        return Response.json(body, {
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400',
          },
        })
      },
    },
  },
})
