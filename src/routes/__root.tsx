import type { QueryClient } from '@tanstack/react-query'
import {
  HeadContent,
  Link,
  ScriptOnce,
  Scripts,
  createRootRouteWithContext,
  rootRouteId,
  useRouterState,
  type ErrorComponentProps,
} from '@tanstack/react-router'
import { Analytics } from '@vercel/analytics/react'
import { SpeedInsights } from '@vercel/speed-insights/react'

import { Nav } from '../components/Nav'
import { OG_IMAGE, SITE_DESCRIPTION, SITE_NAME, SITE_URL } from '../lib/seo'
import { DEFAULT_FILTERS } from '../lib/session-search'

// Inlined into the document rather than linked: the stylesheet was the only render-blocking
// request, and on a slow connection that extra round trip delayed first paint. It's about
// 8 KB compressed, and the site is essentially one page, so separate caching buys little.
import appCss from '../styles.css?inline'

// Inlined (not an external file) so the stored theme applies before first paint without
// adding a render-blocking request. ScriptOnce removes the tag after it runs so it can't
// cause a hydration mismatch.
const themeInitScript = `(function(){try{var t=window.localStorage.getItem('28games_session_guide_theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}})()`

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      // Defaults; page routes override title, description and og:title/description/url and
      // add the canonical link (see `pageHead`).
      { title: SITE_NAME },
      { name: 'description', content: SITE_DESCRIPTION },
      { property: 'og:site_name', content: SITE_NAME },
      { property: 'og:type', content: 'website' },
      { property: 'og:locale', content: 'en_US' },
      { property: 'og:title', content: SITE_NAME },
      { property: 'og:description', content: SITE_DESCRIPTION },
      { property: 'og:image', content: `${SITE_URL}${OG_IMAGE.path}` },
      { property: 'og:image:width', content: String(OG_IMAGE.width) },
      { property: 'og:image:height', content: String(OG_IMAGE.height) },
      { property: 'og:image:alt', content: `${SITE_NAME}, an unofficial session browser` },
      // X falls back to the og: tags for title, description and image.
      { name: 'twitter:card', content: 'summary_large_image' },
    ],
    styles: [{ children: appCss }],
    links: [
      { rel: 'icon', href: '/favicon.svg?v=6', type: 'image/svg+xml', sizes: 'any' },
      { rel: 'icon', href: '/favicon.ico?v=6', type: 'image/x-icon', sizes: '32x32 16x16' },
      { rel: 'apple-touch-icon', href: '/logo192.png' },
      // Browsers fetch manifests without cookies by default; sending them lets the manifest
      // load on login-protected Vercel previews instead of redirecting to Vercel SSO.
      { rel: 'manifest', href: '/manifest.json', crossOrigin: 'use-credentials' },
    ],
  }),
  shellComponent: RootDocument,
  errorComponent: RootError,
  notFoundComponent: NotFound,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ScriptOnce>{themeInitScript}</ScriptOnce>
        <HeadContent />
      </head>
      <body>
        <Nav />
        {children}
        <footer className="text-ink3 py-6 text-center text-xs">
          Made with love and electricity in Los Angeles. ☀️
        </footer>
        <Scripts />
        {import.meta.env.VITE_VERCEL_INSIGHTS === 'true' && (
          <>
            <Analytics />
            <SpeedInsightsWithRoute />
          </>
        )}
      </body>
    </html>
  )
}

// Speed Insights only detects routes on its first-party framework integrations, so without
// this every page shows up as "Unknown". Reports the matched route pattern rather than the
// URL, so filter and `?session=` query strings don't fragment the data. Not-found pages
// match only the root route and stay unlabelled.
function SpeedInsightsWithRoute() {
  const route = useRouterState({
    select: (state) => {
      const match = state.matches.at(-1)
      return match && match.routeId !== rootRouteId ? match.fullPath : null
    },
  })

  return <SpeedInsights route={route} />
}

function ErrorMessage({ heading, body }: { heading: string; body: string }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-24 text-center">
      <h2 className="font-display mb-3 text-[2rem] leading-[1.1] font-normal -tracking-[0.03em]">
        {heading}
      </h2>
      <p className="text-ink3 mb-6 max-w-[420px] text-sm">{body}</p>
      <Link
        to="/"
        search={{ ...DEFAULT_FILTERS, sortCol: 'agg', sortDir: 'desc' }}
        className="border-border bg-surface2 text-ink2 hover:border-gold hover:text-gold inline-flex items-center gap-1.5 rounded-lg border px-4 py-2 text-sm transition-colors"
      >
        Back to home
      </Link>
    </div>
  )
}

function RootError({ error }: ErrorComponentProps) {
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.error(error)
  } else {
    // eslint-disable-next-line no-console
    console.error('Root error:', error instanceof Error ? error.message : 'Unknown error')
  }
  return (
    <ErrorMessage
      heading="Something went wrong"
      body="An unexpected error occurred. Please try refreshing the page."
    />
  )
}

function NotFound() {
  return (
    <ErrorMessage
      heading="Page not found"
      body="The page you're looking for doesn't exist or has been moved."
    />
  )
}
