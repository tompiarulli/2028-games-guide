export interface Contender {
  name: string
  country: string
  note: string
}

export interface ContentSource {
  title: string
  url: string
  date?: string
  lastUpdated?: string
  snippet?: string
  source?: string
}

export type ContentProvider = 'anthropic' | 'hybrid'

export interface ContentMeta {
  provider: ContentProvider
  writingModel?: string
  scoringModel?: string
  groundingModel?: string
  model?: string
  generatedAt: string
  sources?: ContentSource[]
  promptAugmentation?: string
}

export interface ScorecardDimension {
  score: number
  explanation: string
}

export interface Scorecard {
  significance: ScorecardDimension
  experience: ScorecardDimension
  starPower: ScorecardDimension
  uniqueness: ScorecardDimension
  demand: ScorecardDimension
  aggregate: number
  overall: string
}

export interface SessionContent {
  blurb?: string
  potentialContendersIntro?: string
  potentialContenders?: Contender[]
  relatedNews?: RelatedNews[]
  scorecard?: Scorecard
  contentMeta?: ContentMeta
}

export interface RelatedNews {
  id: string
  title: string
  summary: string
  sourceName: string
  sourceUrl: string
  publishedDate: string
  tags: string[]
  roundTypes?: RoundType[]
  eventKeywords?: string[]
}

// Pure session data — hand-validated from external sources. Lives in
// sessions.json with no generated content mixed in.
export interface SessionSource {
  id: string
  sport: string
  name: string
  desc: string
  venue: string
  zone: string
  date: string
  dk: string
  time: string
  rt: RoundType
  soccer: boolean
}

// Runtime shape used by routes/components: source + derived ratings merged
// from session-scores.json so table/sort/filter UI works unchanged.
export interface Session extends SessionSource {
  rSig: number
  rExp: number
  rStar: number
  rUniq: number
  rDem: number
  agg: number
}

export interface SessionWithContent extends Session, SessionContent {}

export type RoundType = 'Final' | 'Semi' | 'QF' | 'Prelim' | 'Bronze' | 'Ceremony' | 'N/A'

export type SortColumn = 'name' | 'date' | 'venue' | 'agg'
export type SortDirection = 'asc' | 'desc'

export interface SortState {
  col: SortColumn
  dir: SortDirection
}

export interface Filters {
  sport: string
  round: string
  zone: string
  score: string
}
