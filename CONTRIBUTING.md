# Contributing

## Getting Started

```bash
pnpm install
pnpm dev
```

The dev server runs on port 3000.

## Commands

- `pnpm dev` — Start dev server
- `pnpm build` — Production build
- `pnpm preview` — Preview production build
- `pnpm test` — Run tests with Vitest
- `pnpm generate:paris-medals` — Rescrape Olympedia for Paris 2024 medal data (rarely needed)
- `pnpm generate:sport-facts` — Regenerate per-sport reference facts in `src/data/sport-facts.json` (see [Regenerating sport facts](#regenerating-sport-facts))
- `pnpm generate:venue-facts` — Regenerate per-venue reference facts in `src/data/venue-facts.json` (see [Regenerating venue facts](#regenerating-venue-facts))
- `pnpm generate:session-facts` — Per-session Claude + web search grounding → `src/data/session-facts.json`
- `pnpm generate:session-content` — Per-session Anthropic writing → `src/data/session-content.json`
- `pnpm generate:session-scores` — Per-session Anthropic scoring → `src/data/session-scores.json`
- `pnpm refresh <sessionId>` — Refresh a single session through all three session stages

## Data

Session data lives in JSON files under `src/data/`, committed to the repo and bundled into the server function at build time:

- `sessions.json` — hand-validated source data from the official Session Table (id, sport, venue, date, etc.). No generated content.
- `paris-2024-medals.json` — Olympedia-scraped Paris 2024 results; authoritative history used as a grounding anchor.
- `sport-facts.json` — per-sport Claude web-search output (gamesContext, parisRecap), keyed by sport.
- `venue-facts.json` — per-venue Claude web-search output (capacity, yearBuilt, location, iconicMoments, spectatorExperience, changes2028), keyed by venue name.
- `session-facts.json` — per-session Claude web-search output (facts, related news, sources), keyed by session id.
- `session-content.json` — Anthropic-authored prose (blurb, contenders), keyed by session id.
- `session-scores.json` — ratings + optional full Scorecard (dimension scores with explanations), keyed by session id.
- `session-corrections.json` / `sport-corrections.json` / `venue-corrections.json` — hand-edited authoritative overrides injected into the relevant prompt at generation time. See [Corrections](#corrections) below.

Runtime reads happen in `src/data/sessions.data.server.ts`, which merges sessions + session-facts + session-content + session-scores at module load. Correction files are read at generation time only — they shape future prompt input but never appear at runtime.

### Regenerating session content and ratings

Three independent scripts, one per stage. Run them in order the first time; after that each can run on its own.

- **Grounding** runs for sessions that are missing or on an old `promptVersion`. `--stale-days=<n>` also re-checks sessions not grounded or re-checked in the last n days, and `--force` re-checks every session. A re-check sends the stored brief along and asks whether anything material changed. If nothing did, the stored facts are kept as-is (only `checkedAt` moves). `--no-previous` skips that and writes every brief from scratch.
- **Writing and scoring** store a hash of each session's inputs (grounding facts, sport and venue context, Paris medals, corrections, model, prompt version) and skip sessions whose inputs haven't changed. `--force` regenerates regardless.

```bash
# Stage 1: per-session Claude + web search grounding → session-facts.json
pnpm generate:session-facts --sport="Athletics (Track & Field)"

# Stage 2: Anthropic writing → session-content.json (requires session-facts)
pnpm generate:session-content --sport=Archery

# Stage 3: Anthropic scoring → session-scores.json (requires session-content)
pnpm generate:session-scores --sport=Archery

# Scheduled refresh: re-check briefs older than 25 days, then rewrite and
# rescore only the sessions whose facts changed
pnpm generate:session-facts --stale-days=25
pnpm generate:session-content
pnpm generate:session-scores

# Force regen (ignores version and input-hash gates)
pnpm generate:session-content --sport=Archery --force

# Use sync messages.create instead of Message Batches (faster per-request,
# forfeits the 50% batch discount — good for iterating)
pnpm generate:session-facts --sport=Archery --no-batch
pnpm generate:session-content --sport=Archery --no-batch
pnpm generate:session-scores --sport=Archery --no-batch

# Refresh a single session end-to-end with a manual correction
pnpm refresh ATH04 --skip-grounding --prompt "Tighten the blurb"
```

All three stages use Anthropic prompt caching and Messages Batches by default. Stage 1 runs Claude with the web search tool, 20 sessions of one sport per request and at most 15 searches each. A batched request whose search turn pauses can't be resumed, so those sessions stay due — rerun the command, or use `--no-batch` for the stragglers. Per-sport log lines report completion so you can watch the run.

Every generate script and `pnpm refresh` ends with a usage summary: requests, tokens, cache hits, web searches, and an estimated cost from list prices. Output that uses a trademarked term (see `containsBannedTerm` in `scripts/lib/session-content.ts`) is rejected: the session or fact entry stays due and is retried on the next run.

Sport and venue facts change rarely. Keep them out of scheduled runs, and rerun them with `--force` only when something changes, like a venue or format update.

Regenerated files are committed like any other source — there's no separate deploy step for data. Run `pnpm format` after a generation run: the store writes plain `JSON.stringify` output, which oxfmt reformats. A full `--force` run makes paid API calls for every one of ~850 sessions and costs real money — scope with `--sport=...` while developing.

### Regenerating sport facts

`src/data/sport-facts.json` contains per-sport reference facts (background, Paris 2024 recap) used as cached context by the writing and scoring prompts. It's generated by Claude with web search, grounded on `paris-2024-medals.json`:

```bash
# Regenerate one sport
pnpm generate:sport-facts --sport=Archery --force

# Dry-run to inspect events the script will pass
pnpm generate:sport-facts --sport=Archery --dry-run

# Regenerate everything with an empty parisRecap (incremental default)
pnpm generate:sport-facts
```

Without `--force`, the script only regenerates sports whose `parisRecap` field is empty — so running it repeatedly is cheap. The generator treats the Paris medal block as authoritative and the model is instructed never to substitute different medalists.

### Regenerating venue facts

`src/data/venue-facts.json` contains stable per-venue data (capacity, year built, location, iconic moments, spectator experience, 2028-specific changes) that's included as a separate cached block in writing/scoring prompts. It's generated by Claude with web search:

```bash
# Regenerate one venue
pnpm generate:venue-facts --venue="LA Memorial Coliseum" --force

# Dry-run to see what the script would do
pnpm generate:venue-facts --dry-run

# Fill in any venue still missing data (incremental default)
pnpm generate:venue-facts
```

Without `--force`, the script only regenerates venues whose `iconicMoments` field is empty. The runtime is tolerant of missing venue data — the venue-facts block is only added to the prompt when at least one venue has populated entries, so the pipeline keeps working while `venue-facts.json` is partially filled.

### Corrections

When the AI gets a fact wrong, write a correction once and have it persist across every future regeneration. Three files, each keyed to its scope:

| File                                | Keyed by   | Used when running                                                                                          |
| ----------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------- |
| `src/data/session-corrections.json` | session id | `generate:session-facts`, `generate:session-content`, `generate:session-scores`, `refresh`                 |
| `src/data/sport-corrections.json`   | sport name | `generate:sport-facts`, plus per-sport prompts in `generate:session-content` and `generate:session-scores` |
| `src/data/venue-corrections.json`   | venue name | `generate:venue-facts`                                                                                     |

Shape (all three):

```json
{
  "_meta": { "notes": "..." },
  "ATH04": [
    "Julien Alfred of Saint Lucia won Paris 2024 women's 100m gold (not Sha'Carri Richardson)."
  ]
}
```

Each value is an array — multiple corrections stack. To apply: edit the file, then rerun the relevant generate command (or `pnpm refresh <id>`). Each stage fingerprints the corrections it used, so session and sport corrections are picked up on the next run with no flags: `generate:session-facts` writes those sessions' briefs from scratch instead of re-checking them, and writing and scoring follow because their inputs changed. Corrections are injected as the "User correction / additional context (authoritative — supersedes conflicting information)" block in every relevant prompt. No `promptVersion` bump — corrections take effect on the next generation pass.

**Fix-at-source for global facts.** Some facts apply to many sessions and have an authoritative source file:

- Wrong Paris 2024 medalist → edit `src/data/paris-2024-medals.json`, then rerun `pnpm generate:session-facts --sport="<sport>" --force --no-previous` for affected sessions. The medal block is already labeled "authoritative — do not contradict" in every prompt that uses it.
- Sport gamesContext / parisRecap consistently wrong across many sessions → consider editing `src/data/sport-facts.json` directly, or use `sport-corrections.json` plus regen.
- Venue capacity / location wrong → edit `src/data/venue-facts.json` directly or use `venue-corrections.json` plus regen.

The correction files are best for narrow, session-specific corrections; the source files are best for facts that should propagate everywhere.

## Routing

This project uses [TanStack Router](https://tanstack.com/router) with file-based routing. Routes are managed as files in `src/routes/`.

To add a new route, create a file in `src/routes/` — TanStack will automatically generate the route entry. Use the `Link` component from `@tanstack/react-router` for SPA navigation:

```tsx
import { Link } from '@tanstack/react-router'
;<Link to="/venues">Venues</Link>
```

The root layout lives in `src/routes/__root.tsx`. More info in the [Layouts documentation](https://tanstack.com/router/latest/docs/framework/react/guide/routing-concepts#layouts).

## Server Functions

TanStack Start provides server functions that integrate with client components:

```tsx
import { createServerFn } from '@tanstack/react-start'

const getServerTime = createServerFn({
  method: 'GET',
}).handler(async () => {
  return new Date().toISOString()
})
```

## Data Fetching

Use the `loader` functionality built into TanStack Router to load data for a route before it renders:

```tsx
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/people')({
  loader: async () => {
    const response = await fetch('https://swapi.dev/api/people')
    return response.json()
  },
  component: PeopleComponent,
})

function PeopleComponent() {
  const data = Route.useLoaderData()
  return (
    <ul>
      {data.results.map((person) => (
        <li key={person.name}>{person.name}</li>
      ))}
    </ul>
  )
}
```

More info in the [Loader documentation](https://tanstack.com/router/latest/docs/framework/react/guide/data-loading#loader-parameters).

## Styling

This project uses [Tailwind CSS](https://tailwindcss.com/) v4.

## Learn More

- [TanStack documentation](https://tanstack.com)
- [TanStack Start](https://tanstack.com/start)
