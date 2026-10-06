/**
 * Why this file exists, and what its absence did.
 *
 * Every route here is `force-dynamic` — it reads the database on request. Next
 * will not begin a navigation to a dynamic route until either the server has
 * responded or the route offers a fallback. With no fallback, clicking
 * "Dashboard" left the previous page on screen, unchanged, with no spinner and
 * no reaction, for as long as the queries took. It read as a dead button.
 *
 * This is the fallback. It renders instantly, so a click always produces a
 * visible change on the next frame, and the real page swaps in underneath when
 * it is ready.
 */
import { LoadingFeedback } from '@/components/performance-markers';

export default function Loading() {
  return (
    <div className="animate-pulse space-y-10" aria-busy="true" aria-label="Loading">
      <LoadingFeedback />
      <div className="space-y-3">
        <div className="h-7 w-48 rounded-md bg-paper-sunk" />
        <div className="h-4 w-80 max-w-full rounded bg-paper-sunk" />
      </div>

      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-52 rounded-note bg-paper-sunk" />
        ))}
      </div>

      <div className="space-y-3">
        <div className="h-24 rounded-xl bg-paper-sunk" />
        <div className="h-24 rounded-xl bg-paper-sunk" />
      </div>
    </div>
  );
}
