import { Link } from '@tanstack/react-router'
import { Bot } from 'lucide-react'
import { lazy, Suspense, useState } from 'react'

import { ThemeToggle } from './ThemeToggle'

// Loaded on first use: the dialog only matters to people who open it, and the nav is on
// every page.
const loadAgentSetupDialog = () => import('./AgentSetupDialog')
const AgentSetupDialog = lazy(() =>
  loadAgentSetupDialog().then((m) => ({ default: m.AgentSetupDialog })),
)

const headerButtonClass =
  'border-border bg-surface text-ink2 hover:border-gold hover:bg-surface2 hover:text-gold absolute top-4 z-5 flex size-9 cursor-pointer items-center justify-center rounded-lg border transition-all duration-150 max-md:top-3'

// lucide-react 1.0 dropped brand icons. This is the outline GitHub mark from the last
// release that shipped it (ISC license), drawn like lucide's other icons.
function GithubIcon({ size = 24 }: { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
      <path d="M9 18c-4.51 2-5-2-7-2" />
    </svg>
  )
}

export function Nav() {
  const [agentDialogOpen, setAgentDialogOpen] = useState(false)
  const [agentDialogLoaded, setAgentDialogLoaded] = useState(false)

  function openAgentDialog() {
    setAgentDialogLoaded(true)
    setAgentDialogOpen(true)
  }

  return (
    <div className="relative overflow-hidden px-6 pt-12 pb-6 text-center max-md:px-4 max-md:pt-14">
      <button
        type="button"
        onClick={openAgentDialog}
        onPointerEnter={() => void loadAgentSetupDialog()}
        onFocus={() => void loadAgentSetupDialog()}
        className={`${headerButtonClass} right-[108px] max-md:right-[100px]`}
        title="Ask Claude or ChatGPT about sessions"
        aria-label="Ask Claude or ChatGPT about sessions"
        aria-haspopup="dialog"
      >
        <Bot size={18} aria-hidden="true" />
      </button>
      {agentDialogLoaded ? (
        <Suspense fallback={null}>
          <AgentSetupDialog open={agentDialogOpen} onOpenChange={setAgentDialogOpen} />
        </Suspense>
      ) : null}
      <a
        href="https://github.com/tompiarulli/2028-games-guide"
        target="_blank"
        rel="noopener noreferrer"
        className={`${headerButtonClass} right-16 max-md:right-14`}
        title="View on GitHub"
        aria-label="View on GitHub"
      >
        <GithubIcon size={18} />
      </a>
      <ThemeToggle />
      <h1 className="font-display relative mb-1.5 text-[2.2rem] leading-[1.1] font-normal -tracking-[0.03em] max-md:text-[1.6rem]">
        <em className="text-gold italic">2028 Games</em> Session Guide
      </h1>
      <p className="text-ink3 relative mx-auto mt-2 max-w-[600px] text-[0.72rem] leading-normal font-normal max-md:px-2">
        This is an{' '}
        <strong>
          <u>unofficial</u>
        </strong>
        , open-source project not affiliated with any official organizing body. Session data is
        scraped from public materials and may be inaccurate or outdated. AI ratings are subjective
        and should not be used as a sole basis for decisions. Always verify against official
        sources.
      </p>
      {/* Here rather than in the footer: the home page scrolls infinitely, so the footer is
          effectively unreachable there. */}
      <nav
        aria-label="Legal"
        className="text-ink3 relative mt-2 flex items-center justify-center gap-2 text-[0.72rem]"
      >
        <Link
          to="/terms"
          className="hover:text-gold underline-offset-2 transition-colors hover:underline"
        >
          Terms
        </Link>
        <span aria-hidden="true">·</span>
        <Link
          to="/privacy"
          className="hover:text-gold underline-offset-2 transition-colors hover:underline"
        >
          Privacy
        </Link>
      </nav>
    </div>
  )
}
