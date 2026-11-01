# AGENTS.md

This file provides guidance to AI coding agents working with code in this repository.

## Commands

- Use `pnpm` for package management in this repo. Do not use `npm` or `yarn` unless the user explicitly asks.
- Prefer existing `package.json` scripts over ad-hoc shell commands when a matching script exists.
- `pnpm dev` — Start dev server on port 3000
- `pnpm build` — Production build
- `pnpm preview` — Preview production build
- `pnpm serve:prod` — Serve the production build the way Vercel does (static files first, Nitro fallback, brotli) on port 4173
- `pnpm lighthouse` — Run Lighthouse CI (mobile) against `pnpm serve:prod`; budgets in `lighthouserc.json`. Requires a prior `pnpm build`
- `pnpm test` — Run tests with Vitest (`vitest run`)
- `pnpm format:check` — Check formatting with oxfmt
- `pnpm lint` — Lint with oxlint
- `pnpm typecheck` — Type-check with `tsc --noEmit`

### Content pipeline commands

Six independent scripts; each reads JSON output of upstream stages and writes one file. Run in order, or any subset with `--sport=<name>` / `--force` / `--dry-run`.

- `pnpm generate:paris-medals` — Rescrape Olympedia into `src/data/paris-2024-medals.json`. One-off; run only when medal data needs refreshing.
- `pnpm generate:sport-facts` — Regenerate `src/data/sport-facts.json` per sport via Claude with web search, anchored on `paris-2024-medals.json`. Extra flag: `--force` regenerates even when `parisRecap` already populated.
- `pnpm generate:venue-facts` — Regenerate `src/data/venue-facts.json` per venue via Claude with web search (capacity, history, spectator experience, 2028 changes). Filter: `--venue=<name>`.
- `pnpm generate:session-facts` — Per-session Claude + web search grounding → `src/data/session-facts.json` (facts, related news, sources). Flags: `--stale-days=<n>` (re-check briefs older than n days), `--no-previous` (write briefs from scratch instead of re-checking the stored one), `--no-batch`, `--concurrency=<n>` (with `--no-batch`), `--anthropic-model=<m>`.
- `pnpm generate:session-content` — Per-session Anthropic writing → `src/data/session-content.json` (blurb, contenders). Requires `session-facts.json` populated. Flags: `--no-batch`, `--anthropic-model=<m>`.
- `pnpm generate:session-scores` — Per-session Anthropic scoring → `src/data/session-scores.json` (ratings + scorecard). Requires `session-content.json` populated. Flags: `--no-batch`, `--anthropic-model=<m>`.
- `pnpm check:anthropic-auth` — Free model lookup that confirms the scripts can authenticate (local key/profile, or federation in GitHub Actions).
- `pnpm refresh <sessionId>` — Refresh grounding+writing+scoring for a single session with an optional `--prompt "..."` correction. Flags: `--skip-grounding|writing|scoring`.

Paid API calls authenticate through `scripts/lib/anthropic-client.ts`: locally the SDK finds `ANTHROPIC_API_KEY` in `.env` (or an `ant auth login` profile); in GitHub Actions it uses Workload Identity Federation with no stored key. Research stages (sport, venue, and session facts) use Claude's server-side web search tool ($10 per 1,000 searches plus tokens) and return results through a strict record tool — see `scripts/lib/claude-research.ts`. Session grounding, writing, and scoring use prompt caching and Messages Batches (50% token discount) by default — see `scripts/lib/session-content.ts` for the batching helpers. A batched grounding request whose search turn pauses can't be resumed, so it fails and stays due for the next run; rerun, or use `--no-batch` for stragglers.

Cost controls (see `scripts/lib/freshness.ts` and `scripts/lib/usage.ts`):

- Grounding re-checks send each session's stored brief; when Claude reports no material change, the stored facts and `generatedAt` stay put and only `checkedAt` moves. Briefs written before a session's current session/sport corrections (tracked by `correctionsHash`) are rewritten from scratch instead.
- Writing and scoring store an input hash per session and skip sessions whose inputs are unchanged; `--force` overrides.
- Each session stores only the search results its facts and news cite (at most 12, checked against what the searches actually returned), not the whole batch's results.
- Every script prints a usage summary with an estimated cost.
- Reader-facing output containing a trademarked term is rejected in code and retried on the next run.
- Sport and venue facts are stable — don't put them in scheduled runs. A scheduled refresh is `generate:session-facts --stale-days=<n>`, then `generate:session-content`, `generate:session-scores`, and `pnpm format`.

`.github/workflows/data-refresh.yml` runs that refresh monthly (and on demand via workflow_dispatch) and opens a `chore(data)` PR with the results and a usage summary. Setup is in CONTRIBUTING.md under "Scheduled data refresh".

#### Persistent corrections

Hand-edited correction files override AI output across regenerations. Three files mirror the three correction scopes:

- `src/data/session-corrections.json` — keyed by session id; injected into `generate:session-facts`, `generate:session-content`, `generate:session-scores`, and `refresh`.
- `src/data/sport-corrections.json` — keyed by sport name; injected into `generate:sport-facts`, plus per-sport prompts in writing/scoring.
- `src/data/venue-corrections.json` — keyed by venue name; injected into `generate:venue-facts`.

Shape: `{ "<key>": ["correction text", ...] }`. Each value is an array so corrections stack. Edit the file, then re-run the relevant generate command (or `pnpm refresh <id>`) — corrections are feed-forward, no version bump.

For globally-wrong Paris 2024 medal data, fix `src/data/paris-2024-medals.json` directly and rerun `generate:session-facts` for affected sessions. The medal block is already authoritative in every prompt that references it.

### Pre-PR checks

Before opening a pull request, run the CI-equivalent checks locally and fix any failures first: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, and `pnpm test`. For UI or rendering changes, also run `pnpm build && pnpm lighthouse`: CI fails the PR if a page drops below its Lighthouse budget. Run them in parallel when possible. This avoids pushing commits that fail CI.

### Deploying

Production deploys happen automatically when Release Please cuts a release. `.github/workflows/release.yml` runs on every push to `main`; when it creates a release (release PR merged), a follow-up `deploy` job in the same workflow builds with the Vercel CLI (`vercel build` with `NITRO_PRESET=vercel`) and ships a prebuilt production deployment to Vercel. Git-triggered Vercel deploys of `main` are disabled in `vercel.json` so only the release job promotes to production. **Manual deploys are forbidden.** Do not run `vercel deploy` (or `vercel --prod`), do not re-add a `deploy` script to `package.json`, and do not add a manual-trigger workflow. Shipping code means: merge feature PRs to `main` → let Release Please open its release PR → user merges that → CI deploys.

### Vercel operations

Always ask the user before using any Vercel MCP tools or running `vercel` CLI commands that touch remote resources (`pull`, `env`, `deploy`, `domains`, etc.). Local-only builds (`pnpm build`, `NITRO_PRESET=vercel pnpm build`) are fine without asking.

## Architecture

This is a **TanStack Start** (React 19) full-stack app with SSR, file-based routing, and Tailwind CSS v4.

### Data

Session data lives in JSON files under `src/data/`, committed to the repo and bundled into the server function at build time:

- `sessions.json` — hand-validated source data (id, sport, venue, date, etc.); no generated content
- `paris-2024-medals.json` — Olympedia-scraped medal results; authoritative history, used as grounding anchor
- `sport-facts.json` — per-sport Claude web-search output (gamesContext, parisRecap), keyed by sport
- `venue-facts.json` — per-venue Claude web-search output (capacity, yearBuilt, location, iconicMoments, spectatorExperience, changes2028), keyed by venue name
- `session-facts.json` — per-session Claude web-search output (facts, related news, sources), keyed by session id
- `session-content.json` — Anthropic prose (blurb, contenders), keyed by session id
- `session-scores.json` — ratings + optional Scorecard (dimension scores with explanations), keyed by session id
- `session-corrections.json` / `sport-corrections.json` / `venue-corrections.json` — hand-edited authoritative overrides injected into prompts at generation time (see Persistent corrections above)

Runtime reads happen in `src/data/sessions.data.server.ts`, which merges sessions + session-facts + session-content + session-scores on module load. Writer scripts use `scripts/lib/content-store.ts` to upsert the generated files; each stage can be regenerated independently (e.g. refresh news without rewriting descriptions). Regenerated files are committed to the repo — there's no separate deploy step for data.

### Routing

Routes live in `src/routes/` and are auto-generated into `src/routeTree.gen.ts` by the TanStack Router plugin. Do not edit `routeTree.gen.ts` manually.

- `__root.tsx` — Root layout wrapping all pages (HTML document, Header, Footer, devtools)
- Filename maps to path: `venues.tsx` → `/venues`, `index.tsx` → `/`
- Routes use `createFileRoute()` / `createRootRoute()`
- Router config in `src/router.tsx`: preloads on intent, scroll restoration enabled

### Agent access

The session guide is also served to AI agents. All three read the same catalog through `src/data/agent.data.server.ts`, which uses readable field names (`score`, `round`, ISO `date`):

- `/mcp` — remote MCP server (`src/routes/mcp.ts` → `src/lib/mcp-server.ts`). Streamable HTTP, stateless (a fresh server and transport per request, JSON responses), read-only, no auth, open CORS. Tools: `search_sessions`, `get_session`, `list_sports`, `list_venues`, `get_venue`.
- `/api/sessions.json` — every session summary in one document.
- `/llms.txt` — static file in `public/` pointing agents at the two above.

### Path Aliases

`@/*` resolves to `./src/*` (configured in tsconfig.json).

### Styling

- Tailwind CSS v4 with `@tailwindcss/vite` plugin
- Custom CSS variables and theme system in `src/styles.css`
- Dark mode via `data-theme` attribute + `prefers-color-scheme` fallback
- Fonts: system UI stack (body), Georgia (display headings); no web fonts are loaded
- Use existing CSS variables (`--lagoon`, `--sea-ink`, `--sand`, etc.) for theme colors

### Vite Plugins (order matters)

`devtools` → `tailwindcss` → `tanstackStart` → `nitro` → `viteReact`

The `@/*` path alias comes from `tsconfig.json` through Vite's built-in `resolve.tsconfigPaths`, not a plugin.

Nitro builds the server. It auto-detects Vercel when `VERCEL`/`NITRO_PRESET=vercel` is set and emits `.vercel/output`; otherwise it emits a Node server in `.output`. Static-asset cache headers live in the `nitro({ routeRules })` config in `vite.config.ts`.

`/` is deliberately excluded from prerendering (it's SSR'd per URL and CDN-cached) because a static file would be served for every query string and break hydration on `/?session=…` deep links. Vercel Web Analytics and Speed Insights mount only when `VITE_VERCEL_INSIGHTS=true` at build time, which the release deploy job sets.

### Git

- Never include Co-Authored-By or other attribution lines in commits or pull requests
- Use Conventional Commits: `type(scope): description` (lowercase, imperative mood)
  - Types: `feat`, `fix`, `refactor`, `chore`, `docs`, `style`, `test`, `perf`, `ci`, `build`
  - Scope is optional but encouraged (e.g., `feat(routes): add dashboard page`)
  - Breaking changes: add `!` after type/scope (e.g., `feat!: remove legacy auth`)
- Keep commits atomic — one logical change per commit
- Write concise subject lines (under 72 chars), use body for "why" when needed
- PR titles follow the same conventional commit format (this becomes the squash commit message)
- PR descriptions should include a summary and test plan
- Squash merge all PRs — the PR title is the final commit message, so get it right
- Keep `main` history linear: prefer rebasing topic branches onto `main` instead of merge commits
- Releases are managed by Release Please — it reads conventional commits to auto-generate changelogs and version bumps
  - `feat` → minor version bump
  - `fix` → patch version bump
  - `feat!` / `fix!` / breaking change footer → major version bump

### Worktrees

- Store repo worktrees under `.worktrees/` at the repository root when creating additional checkouts for this project

### Agent skills

Project skills come from skills.sh and are tracked in `skills-lock.json`. The files live in `.agents/skills/`, and `.claude/skills/` holds symlinks to them. Update them with `pnpm dlx skills update --project -y`, then review the diff before committing.

- `web-design-guidelines` is locally modified. Upstream tells the agent to fetch its rules from `raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md` on every run. We vendor that file as `references/guidelines.md` instead, so the rules only change through a reviewed commit. Updating the skill overwrites `SKILL.md` with the fetching version. After an update, point `SKILL.md` back at `references/guidelines.md`. To refresh the rules themselves, download the upstream `command.md`, review it, and replace `references/guidelines.md`. Then update the commit SHA in the `SKILL.md` comment.
- TanStack skills ship inside the installed `@tanstack/*` packages (`node_modules/@tanstack/<pkg>/skills/`) and update with those packages. `.agents/skills/tanstack-*` are symlinks into `node_modules`, and `.claude/skills/tanstack-*` link to those, so they resolve only after `pnpm install`. They are not tracked in `skills-lock.json`, so `skills update` leaves them alone. When you bump a TanStack package, review its `skills/` diff, and add or remove symlinks if the package's skill list changed. We don't use `@tanstack/intent install` or `skills experimental_sync`. Sync only finds `skills/<name>/SKILL.md` and would miss TanStack's nested sub-skills.

### Key Conventions

- Strict TypeScript: no unused locals/parameters
- Components in `src/components/`, routes in `src/routes/`
- Server functions available via `createServerFn()` from `@tanstack/react-start`
- Navigation uses `<Link>` from `@tanstack/react-router`
