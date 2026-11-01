import { createFileRoute } from '@tanstack/react-router'

// Remote MCP server (Streamable HTTP) so agents can query the session guide as tools.
async function handleMcp(request: Request): Promise<Response> {
  const { handleMcpRequest } = await import('@/lib/mcp-server')
  return handleMcpRequest(request)
}

export const Route = createFileRoute('/mcp')({
  server: {
    handlers: {
      POST: ({ request }) => handleMcp(request),
      GET: ({ request }) => handleMcp(request),
      DELETE: ({ request }) => handleMcp(request),
      OPTIONS: ({ request }) => handleMcp(request),
    },
  },
})
