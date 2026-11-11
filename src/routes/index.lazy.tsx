import { useQuery, useSuspenseInfiniteQuery } from '@tanstack/react-query'
import { createLazyFileRoute, useNavigate } from '@tanstack/react-router'
import { LoaderCircle } from 'lucide-react'
import { Suspense, lazy, startTransition, useEffect, useMemo, useRef, useState } from 'react'

import { FilterBar } from '@/components/FilterBar'
import { ScrollToTopButton } from '@/components/ScrollToTopButton'
import type { SessionDetailStatus } from '@/components/SessionDetail'
import { SessionTable } from '@/components/SessionTable'
import { useBookmarks } from '@/hooks/useBookmarks'
import { sessionDetailQueryOptions, sessionsInfiniteQueryOptions } from '@/lib/session-query'
import {
  DEFAULT_FILTERS,
  routeSearchToFilters,
  routeSearchToSort,
  type SessionRouteSearch,
} from '@/lib/session-search'
import type { Filters, SortColumn, SortDirection } from '@/types/session'

// The side drawers (and the report dialog inside SessionDetail) pull in base-ui's Drawer
// and Dialog, which aren't needed for first paint. Lazy chunks stay out of the document's
// preloads and load during hydration instead. They still server-render, so
// `/?session=…` deep links arrive with the drawer open.
const SessionDetail = lazy(() =>
  import('@/components/SessionDetail').then((m) => ({ default: m.SessionDetail })),
)
const BookmarkPanel = lazy(() =>
  import('@/components/BookmarkPanel').then((m) => ({ default: m.BookmarkPanel })),
)

// The component lives in a lazy route file so its chunk isn't preloaded with the document:
// the browser fetches it after the main bundle runs, which is after first paint. That
// costs about one round trip before the page is interactive, but nothing visible changes,
// since the HTML is server-rendered. It also keeps the JS that Lighthouse's simulated
// LCP counts down to the main bundle.
export const Route = createLazyFileRoute('/')({ component: SessionPicker })

function SessionPicker() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: '/' })
  const loadMoreRef = useRef<HTMLDivElement | null>(null)
  const [bookmarkPanelOpen, setBookmarkPanelOpen] = useState(false)
  const { bookmarks, toggle, clearAll, isBookmarked } = useBookmarks()

  const sessionsQuery = useSuspenseInfiniteQuery(sessionsInfiniteQueryOptions(search))
  const pages = sessionsQuery.data.pages
  const firstPage = pages[0]
  // Pages are offset-based, so a page fetched against newer data than the cached first page
  // (CDN-cached HTML from a previous deploy, or a dev server reloading regenerated JSON) can
  // repeat or skip sessions that shifted across the page boundary. When that happens, refetch
  // every loaded page from the current data; until it lands, keep the first occurrence of
  // each session so keys stay unique.
  const dataVersionMismatch = pages.some((page) => page.dataVersion !== firstPage.dataVersion)
  useEffect(() => {
    if (dataVersionMismatch && !sessionsQuery.isFetching) void sessionsQuery.refetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataVersionMismatch, sessionsQuery.isFetching, sessionsQuery.refetch])
  const sessions = useMemo(() => {
    const seen = new Set<string>()
    return pages.flatMap((page) =>
      page.items.filter((session) => !seen.has(session.id) && seen.add(session.id)),
    )
  }, [pages])
  const filters = useMemo(() => routeSearchToFilters(search), [search])
  const sort = useMemo(() => routeSearchToSort(search), [search])
  const selectedSessionId = search.session ?? null
  const sessionById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  )
  const selectedSummary = selectedSessionId ? (sessionById.get(selectedSessionId) ?? null) : null

  const selectedDetailQuery = useQuery({
    ...sessionDetailQueryOptions(selectedSessionId ?? ''),
    enabled: !!selectedSessionId,
  })

  const selectedSession = selectedDetailQuery.data?.session ?? selectedSummary
  const selectedInsights = selectedDetailQuery.data?.insights ?? null
  // The detail lookup returns `null` for an id that doesn't exist (e.g. a stale or mistyped
  // `?session=` link), which is distinct from still loading.
  const selectedDetailStatus: SessionDetailStatus = selectedDetailQuery.isPending
    ? 'loading'
    : selectedDetailQuery.isError
      ? 'error'
      : selectedDetailQuery.data
        ? 'ready'
        : 'not-found'

  useEffect(() => {
    const element = loadMoreRef.current
    if (!element || !sessionsQuery.hasNextPage) return

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (!entry?.isIntersecting || sessionsQuery.isFetchingNextPage) return
        void sessionsQuery.fetchNextPage()
      },
      { rootMargin: '300px 0px' },
    )

    observer.observe(element)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    sessionsQuery.fetchNextPage,
    sessionsQuery.hasNextPage,
    sessionsQuery.isFetchingNextPage,
    sessions.length,
  ])

  useEffect(() => {
    if (!selectedSessionId && !bookmarkPanelOpen) return

    function handleMouseDown(event: MouseEvent) {
      const target = event.target as HTMLElement
      if (target.closest('[data-side-drawer]')) return
      if (target.closest('[data-session-item]')) return

      if (selectedSessionId) {
        startTransition(() => {
          void navigate({
            search: (prev) => ({ ...prev, session: undefined }),
            resetScroll: false,
          })
        })
      }

      if (bookmarkPanelOpen) {
        setBookmarkPanelOpen(false)
      }
    }

    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [bookmarkPanelOpen, navigate, selectedSessionId])

  function updateSearch(nextSearch: SessionRouteSearch) {
    startTransition(() => {
      void navigate({
        search: nextSearch,
        resetScroll: false,
      })
    })
  }

  function handleFilterChange(nextFilters: Filters) {
    updateSearch({
      ...search,
      ...nextFilters,
    })
  }

  function handleClearFilters() {
    updateSearch({
      ...search,
      ...DEFAULT_FILTERS,
    })
  }

  function handleSort(col: SortColumn) {
    updateSearch({
      ...search,
      sortCol: col,
      sortDir: search.sortCol === col && search.sortDir === 'desc' ? 'asc' : 'desc',
    })
  }

  function handleSortChange(col: SortColumn, dir: SortDirection) {
    updateSearch({
      ...search,
      sortCol: col,
      sortDir: dir,
    })
  }

  function handleSelectSessionId(sessionId: string) {
    setBookmarkPanelOpen(false)
    updateSearch({
      ...search,
      session: search.session === sessionId ? undefined : sessionId,
    })
  }

  function handleCloseSession() {
    updateSearch({
      ...search,
      session: undefined,
    })
  }

  function handleOpenBookmarks() {
    updateSearch({
      ...search,
      session: undefined,
    })
    setBookmarkPanelOpen(true)
  }

  const bookmarkIds = useMemo(() => [...bookmarks], [bookmarks])

  return (
    <main>
      <FilterBar
        filters={filters}
        onChange={handleFilterChange}
        onClear={handleClearFilters}
        sports={firstPage.sports}
        zones={firstPage.zones}
        bookmarkCount={bookmarks.size}
        onOpenBookmarks={handleOpenBookmarks}
        sort={sort}
        onSortChange={handleSortChange}
      />

      <div className="mx-auto max-w-[1400px] px-4 pt-2 pb-15">
        {sessionsQuery.isFetching && !sessionsQuery.isFetchingNextPage ? (
          <div className="text-ink3 mb-3 flex items-center justify-end gap-3 text-[0.72rem]">
            <span className="inline-flex items-center gap-1.5">
              <LoaderCircle size={12} className="animate-spin" />
              Updating results...
            </span>
          </div>
        ) : null}

        <SessionTable
          sessions={sessions}
          sort={sort}
          onSort={handleSort}
          isBookmarked={isBookmarked}
          onToggleBookmark={toggle}
          selectedSessionId={selectedSessionId}
          onSelectSessionId={handleSelectSessionId}
        />

        <div ref={loadMoreRef} className="flex min-h-16 items-center justify-center">
          {sessionsQuery.isFetchingNextPage ? (
            <div className="text-ink3 inline-flex items-center gap-2 text-[0.8rem]">
              <LoaderCircle size={16} className="animate-spin" />
              Loading more sessions...
            </div>
          ) : sessionsQuery.hasNextPage ? (
            <span className="text-ink3 text-[0.75rem]">Scroll to load more</span>
          ) : firstPage.total > 0 ? (
            <span className="text-ink3 text-[0.75rem]">All matching sessions loaded</span>
          ) : null}
        </div>

        <Suspense fallback={null}>
          <SessionDetail
            open={!!selectedSessionId}
            session={selectedSession}
            insights={selectedInsights}
            status={selectedDetailStatus}
            onClose={handleCloseSession}
            isBookmarked={isBookmarked}
            onToggleBookmark={toggle}
          />
        </Suspense>

        <Suspense fallback={null}>
          <BookmarkPanel
            open={bookmarkPanelOpen}
            onClose={() => setBookmarkPanelOpen(false)}
            bookmarkIds={bookmarkIds}
            onToggleBookmark={toggle}
            onClearAll={clearAll}
            onSelectSessionId={handleSelectSessionId}
          />
        </Suspense>
      </div>

      <ScrollToTopButton />
    </main>
  )
}
