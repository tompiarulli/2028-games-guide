import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import tailwindcss from '@tailwindcss/vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import type { NitroModule } from 'nitro/types'
import { nitro } from 'nitro/vite'
import { configDefaults, defineConfig } from 'vitest/config'

import { securityHeaders } from './src/lib/security-headers.ts'

const oneDayCache = { headers: { 'cache-control': 'public, max-age=86400' } }

// The `/assets/**` cache header below is applied before Vercel's filesystem check, so an
// asset path with no file behind it (e.g. an old hash requested mid-deploy) falls through
// to the SSR 404 page *with* the immutable header, and browsers cache that 404 for a year.
// This inserts a route right after the filesystem check that answers those misses with an
// uncacheable 404 instead. Nitro's `vercel.config.routes` option can't do it: it prepends
// routes, ahead of the filesystem check. Modules install after the preset's hooks, so this
// `compiled` hook runs once the preset has written `config.json`.
const vercelMissingAssets404: NitroModule = {
  name: 'vercel-missing-assets-404',
  setup(nitro) {
    if (!nitro.options.preset.startsWith('vercel')) return
    nitro.hooks.hook('compiled', async () => {
      const configPath = join(nitro.options.output.dir, 'config.json')
      const config = JSON.parse(await readFile(configPath, 'utf8'))
      const filesystem = config.routes.findIndex(
        (route: { handle?: string }) => route.handle === 'filesystem',
      )
      if (filesystem === -1) throw new Error(`No filesystem handle in ${configPath}`)
      config.routes.splice(filesystem + 1, 0, {
        src: '/assets/(.*)',
        status: 404,
        headers: { 'cache-control': 'no-store' },
      })
      await writeFile(configPath, JSON.stringify(config, null, 2))
    })
  },
}

export default defineConfig(({ command }) => {
  const isDev = command === 'serve'
  const isTest = process.env.VITEST === 'true'

  return {
    plugins: [
      ...(isDev && !isTest ? [devtools()] : []),
      tailwindcss(),
      ...(!isTest
        ? [
            tanstackStart({
              prerender: {
                enabled: true,
                crawlLinks: true,
                // `/` is server-rendered per URL instead: a static file would be served for every
                // query string, so deep links like `/?session=ATH15` would hydrate against HTML
                // rendered without the session. The CDN caches each URL via `s-maxage`.
                filter: ({ path }) => path !== '/',
              },
              sitemap: { host: 'https://28games.tompiarulli.com' },
            }),
            nitro({
              routeRules: {
                // Security headers for every page, prerendered or server-rendered: Vercel applies
                // header rules before its filesystem check, so they reach static files too. They
                // set no `cache-control`, so the cache rules below are untouched. Route rules are
                // fixed at build time; Vercel sets VERCEL_ENV for preview builds, which allow the
                // Vercel Toolbar.
                '/**': {
                  headers: securityHeaders({ vercelToolbar: process.env.VERCEL_ENV === 'preview' }),
                },
                // Hashed assets (JS, CSS) — safe to cache indefinitely
                '/assets/**': {
                  headers: { 'cache-control': 'public, max-age=31536000, immutable' },
                },
                // Favicons (versioned via ?v= query param), app icons, and manifest
                '/favicon.ico': oneDayCache,
                '/favicon.svg': oneDayCache,
                '/logo192.png': oneDayCache,
                '/logo512.png': oneDayCache,
                '/manifest.json': oneDayCache,
                '/robots.txt': oneDayCache,
                '/llms.txt': oneDayCache,
              },
              modules: [vercelMissingAssets404],
            }),
          ]
        : []),
      viteReact(),
    ],
    resolve: {
      tsconfigPaths: true,
    },
    build: {
      target: 'esnext',
    },
    test: {
      environment: 'jsdom',
      setupFiles: './src/test/setup.ts',
      // Other checkouts of this repo live inside it; their tests would otherwise run too.
      exclude: [...configDefaults.exclude, '.claude/**', '.worktrees/**'],
    },
  }
})
