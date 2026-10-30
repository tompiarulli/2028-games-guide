import Anthropic from '@anthropic-ai/sdk'
import { oidcFederationProvider } from '@anthropic-ai/sdk/lib/credentials/oidc-federation'

// The audience the Anthropic federation rule expects on GitHub's identity token.
const GITHUB_OIDC_AUDIENCE = 'https://api.anthropic.com'

// Builds the API client for every pipeline script.
//
// Locally the SDK resolves credentials itself: ANTHROPIC_API_KEY (from .env),
// an `ant auth login` profile, or federation environment variables.
//
// In GitHub Actions (.github/workflows/data-refresh.yml) the client uses
// Workload Identity Federation with no stored key. GitHub identity tokens
// expire after about 5 minutes and each can be exchanged only once, while a
// refresh runs far longer, so instead of a token file every exchange fetches a
// fresh token from the job's OIDC endpoint. The client caches the resulting
// Anthropic token and re-exchanges shortly before it expires.
export function createAnthropicClient(): Anthropic {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  const federationRuleId = process.env.ANTHROPIC_FEDERATION_RULE_ID
  const organizationId = process.env.ANTHROPIC_ORGANIZATION_ID
  if (!requestUrl || !requestToken || !federationRuleId || !organizationId) {
    return new Anthropic()
  }
  return new Anthropic({
    credentials: oidcFederationProvider({
      identityTokenProvider: () => fetchGitHubIdentityToken(requestUrl, requestToken),
      federationRuleId,
      organizationId,
      serviceAccountId: process.env.ANTHROPIC_SERVICE_ACCOUNT_ID || undefined,
      workspaceId: process.env.ANTHROPIC_WORKSPACE_ID || undefined,
      baseURL: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
      fetch,
    }),
  })
}

async function fetchGitHubIdentityToken(requestUrl: string, requestToken: string) {
  const url = new URL(requestUrl)
  url.searchParams.set('audience', GITHUB_OIDC_AUDIENCE)
  const response = await fetch(url, { headers: { Authorization: `Bearer ${requestToken}` } })
  if (!response.ok) {
    throw new Error(`GitHub OIDC token request failed: HTTP ${response.status}`)
  }
  const body = (await response.json()) as { value?: string }
  if (!body.value) throw new Error('GitHub OIDC token response had no token')
  return body.value
}
