import type { SessionSource } from '../../src/types/session.js'
import {
  type GroundingEntry,
  type WritingEntry,
  readGroundingForSession,
  readScoringForSession,
  readWritingForSession,
} from './content-store.js'
import {
  GROUNDING_VERSION,
  type GroundingData,
  SCORING_VERSION,
  WRITING_VERSION,
  type WritingData,
  scoringInputHash,
  writingInputHash,
} from './session-content.js'

export function groundingFromEntry(
  id: string,
  e: GroundingEntry | null,
): GroundingData | undefined {
  if (!e?.facts) return undefined
  return {
    id,
    groundingFacts: e.facts,
    relatedNews: e.relatedNews,
    sources: e.sources ?? undefined,
  }
}

export function writingFromEntry(id: string, e: WritingEntry | null): WritingData | undefined {
  if (!e) return undefined
  return {
    id,
    blurb: e.blurb,
    potentialContendersIntro: e.potentialContendersIntro ?? '',
    potentialContenders: e.potentialContenders,
  }
}

export interface StagePlan {
  // Sessions to regenerate.
  targets: SessionSource[]
  // Sessions whose upstream stage isn't at its current version yet.
  blocked: SessionSource[]
  // Current input hash for every session considered; store it with the output.
  hashes: Map<string, string>
  // Current entries without a stored hash; record it without regenerating.
  backfill: Map<string, string>
  // Current entries whose inputs haven't changed.
  unchanged: number
}

interface StoredOutput {
  promptVersion: number
  generatedAt: string
  inputHash?: string
}

// Decides one session: regenerate when forced, missing, on an old prompt
// version, or when its input hash differs from the stored one. Entries written
// before hashes existed count as current if they're newer than their inputs.
function decide(
  plan: StagePlan,
  session: SessionSource,
  stored: StoredOutput | null,
  version: number,
  hash: string,
  inputsUpdatedAt: string,
  force: boolean,
) {
  plan.hashes.set(session.id, hash)
  if (force || !stored || stored.promptVersion < version) {
    plan.targets.push(session)
  } else if (stored.inputHash) {
    if (stored.inputHash === hash) plan.unchanged += 1
    else plan.targets.push(session)
  } else if (stored.generatedAt >= inputsUpdatedAt) {
    plan.backfill.set(session.id, hash)
    plan.unchanged += 1
  } else {
    plan.targets.push(session)
  }
}

function emptyPlan(): StagePlan {
  return { targets: [], blocked: [], hashes: new Map(), backfill: new Map(), unchanged: 0 }
}

export function planWriting(sessions: SessionSource[], model: string, force: boolean): StagePlan {
  const plan = emptyPlan()
  for (const s of sessions) {
    const g = readGroundingForSession(s.id)
    const w = readWritingForSession(s.id)
    if (!g || g.promptVersion < GROUNDING_VERSION) {
      if (force || !w || w.promptVersion < WRITING_VERSION) plan.blocked.push(s)
      continue
    }
    const hash = writingInputHash(s, groundingFromEntry(s.id, g), model)
    decide(plan, s, w, WRITING_VERSION, hash, g.generatedAt, force)
  }
  return plan
}

export function planScoring(sessions: SessionSource[], model: string, force: boolean): StagePlan {
  const plan = emptyPlan()
  for (const s of sessions) {
    const g = readGroundingForSession(s.id)
    const w = readWritingForSession(s.id)
    const sc = readScoringForSession(s.id)
    if (!w || w.promptVersion < WRITING_VERSION) {
      if (force || !sc || sc.promptVersion < SCORING_VERSION) plan.blocked.push(s)
      continue
    }
    const hash = scoringInputHash(s, groundingFromEntry(s.id, g), writingFromEntry(s.id, w), model)
    const inputsUpdatedAt = [w.generatedAt, g?.generatedAt ?? ''].sort().at(-1)!
    decide(plan, s, sc, SCORING_VERSION, hash, inputsUpdatedAt, force)
  }
  return plan
}
