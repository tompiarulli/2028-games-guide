import { Dialog } from '@base-ui/react/dialog'
import { Tabs } from '@base-ui/react/tabs'
import { Check, Copy, X } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'

import { cn } from '@/lib/cn'
import { SITE_URL } from '@/lib/seo'

export const MCP_URL = `${SITE_URL}/mcp`
const CONNECTOR_NAME = '2028 Games Guide'

const EXAMPLE_QUESTIONS = [
  'What are the best sessions on July 22?',
  'I’m in LA July 20–22 and love swimming and gymnastics. Which sessions should I get tickets for?',
  'What’s it like to watch at the swimming venue?',
]

interface AgentSetupDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
    } catch {
      // Clipboard access can be blocked; the URL stays selectable in the field.
    }
  }

  return (
    <div className="border-border bg-surface2 mt-1.5 flex items-center gap-2 rounded-md border py-1 pr-1 pl-3">
      <code className="text-ink min-w-0 flex-1 text-[0.82rem] break-all select-all">{value}</code>
      <button
        type="button"
        onClick={copy}
        className="bg-ink text-surface hover:bg-ink2 inline-flex shrink-0 items-center gap-1.5 rounded px-2.5 py-1 text-[0.76rem] font-semibold transition-colors"
      >
        {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
        {copied ? 'Copied' : 'Copy'}
      </button>
      <span role="status" className="sr-only">
        {copied ? 'Link copied' : ''}
      </span>
    </div>
  )
}

function Steps({ children }: { children: ReactNode }) {
  return (
    <ol className="text-ink2 mt-3 list-decimal space-y-2 pl-5 text-[0.85rem] leading-snug marker:font-semibold">
      {children}
    </ol>
  )
}

function Note({ children }: { children: ReactNode }) {
  return <p className="text-ink3 mt-3 text-[0.8rem] leading-snug">{children}</p>
}

const tabClass = cn(
  'text-ink3 hover:text-ink flex-1 rounded-md px-3 py-1.5 text-[0.84rem] font-semibold transition-colors',
  'aria-selected:bg-surface aria-selected:text-ink aria-selected:shadow-sm',
)

export function AgentSetupDialog({ open, onOpenChange }: AgentSetupDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[60] bg-black/50 transition-opacity duration-150 data-[closed]:opacity-0 data-[open]:opacity-100" />
        <Dialog.Popup
          className={cn(
            'fixed top-1/2 left-1/2 z-[70] w-[min(92vw,520px)] -translate-x-1/2 -translate-y-1/2',
            'max-h-[88dvh] overflow-y-auto overscroll-contain',
            'border-border bg-surface rounded-xl border p-5 text-left shadow-2xl max-md:p-4',
            'transition-[transform,opacity,scale] duration-150',
            'data-[closed]:scale-95 data-[closed]:opacity-0',
          )}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <Dialog.Title className="text-ink text-[1.2rem] font-semibold">
                Ask Claude or ChatGPT
              </Dialog.Title>
              <Dialog.Description className="text-ink3 mt-1 text-[0.85rem] leading-snug">
                Connect this guide to your AI assistant and ask about sessions in your own words. It
                looks through every session, reads the ratings and writeups, and links you back
                here. Setup takes about two minutes.
              </Dialog.Description>
            </div>
            <Dialog.Close
              render={<button type="button" />}
              aria-label="Close"
              className="text-ink3 hover:bg-surface2 hover:text-ink flex size-8 shrink-0 items-center justify-center rounded-md transition-colors"
            >
              <X size={16} />
            </Dialog.Close>
          </div>

          <div className="mt-4">
            <p className="text-ink2 text-[0.76rem] font-semibold tracking-[0.04em] uppercase">
              Try asking
            </p>
            <ul className="mt-1.5 space-y-1">
              {EXAMPLE_QUESTIONS.map((q) => (
                <li key={q} className="text-ink2 text-[0.84rem] leading-snug italic">
                  “{q}”
                </li>
              ))}
            </ul>
          </div>

          <div className="mt-4">
            <p className="text-ink2 text-[0.76rem] font-semibold tracking-[0.04em] uppercase">
              Connector link
            </p>
            <CopyField value={MCP_URL} />
          </div>

          <Tabs.Root defaultValue="claude" className="mt-5">
            <Tabs.List
              aria-label="AI assistant"
              className="bg-surface2 border-border flex gap-1 rounded-lg border p-1"
            >
              <Tabs.Tab value="claude" className={tabClass}>
                Claude
              </Tabs.Tab>
              <Tabs.Tab value="chatgpt" className={tabClass}>
                ChatGPT
              </Tabs.Tab>
            </Tabs.List>

            <Tabs.Panel value="claude" className="pt-1 outline-none">
              <Note>
                Works on Claude’s free plan. Set it up once at claude.ai in a web browser or in the
                Claude desktop app. After that, it also works in the Claude app on your phone.
              </Note>
              <Steps>
                <li>Open claude.ai or the Claude desktop app, and sign in.</li>
                <li>
                  Go to <strong>Customize</strong>, then <strong>Connectors</strong>. (In older
                  versions, look under <strong>Settings</strong>.)
                </li>
                <li>
                  Click <strong>+ Add</strong>, then <strong>Add custom connector</strong>.
                </li>
                <li>
                  For the name, type <strong>{CONNECTOR_NAME}</strong>.
                </li>
                <li>
                  For the URL, paste the connector link above, then click <strong>Continue</strong>.
                </li>
                <li>
                  Choose <strong>No sign in</strong>, then click <strong>Add</strong>.
                </li>
              </Steps>
              <Note>
                To use it, start a new chat, click <strong>+</strong> at the bottom left, choose{' '}
                <strong>Connectors</strong>, and check that {CONNECTOR_NAME} is on. The free plan
                allows one custom connector.
              </Note>
            </Tabs.Panel>

            <Tabs.Panel value="chatgpt" className="pt-1 outline-none">
              <Note>
                Set it up at chatgpt.com in a web browser; the phone app can’t add it. This is a
                newer ChatGPT feature that isn’t on every plan yet, so if you don’t see these
                options, your plan doesn’t include it. On a Business or Enterprise account, ask your
                workspace admin to add it.
              </Note>
              <Steps>
                <li>Go to chatgpt.com and sign in.</li>
                <li>
                  Open <strong>Plugins</strong>.
                </li>
                <li>
                  Click <strong>+</strong>, then <strong>Add custom MCP server</strong>.
                </li>
                <li>
                  For the name, type <strong>{CONNECTOR_NAME}</strong>.
                </li>
                <li>
                  Under <strong>Connection</strong>, paste the connector link above.
                </li>
                <li>
                  For authentication, choose <strong>No authentication</strong>.
                </li>
                <li>
                  Check <strong>I understand and want to continue</strong>, then click{' '}
                  <strong>Create as a plugin</strong>. ChatGPT warns about every connection you add
                  yourself. This guide can only look up session information: it can’t see your chats
                  or account, or change anything.
                </li>
                <li>Install the new plugin when ChatGPT shows it.</li>
              </Steps>
              <Note>
                To use it, type <strong>@</strong> in a new chat, pick {CONNECTOR_NAME}, and ask
                your question. Pick it again with <strong>@</strong> when a later question needs
                more session information.
              </Note>
            </Tabs.Panel>
          </Tabs.Root>

          <p className="border-border text-ink3 mt-5 border-t pt-3 text-[0.76rem] leading-snug">
            Ratings and writeups are AI-generated opinions. Check times and ticket details on the
            official site before you buy. Menus in Claude and ChatGPT change from time to time; if a
            step doesn’t match, search their help pages for “custom connector”.
          </p>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
