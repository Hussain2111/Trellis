import { selfAccountId } from '@/lib/chat/threads';
import { latestCards } from '@/lib/dashboard/generate';
import { followerChart, followsSummary, recentTotals } from '@/lib/dashboard/metrics';
import { accountOverview } from '@/lib/chat/queries';
import { StickyNote } from '@/components/sticky-note';
import { RefreshInsights } from '@/components/refresh-insights';
import { EmptyState, Panel, PanelHeader, Stat, sampleNote } from '@/components/ui/primitives';
import { formatRiyadhDate } from '@/lib/time';
import { preparePage } from '@/lib/performance/page';

export const dynamic = 'force-dynamic';

export default function DashboardPage() {
  return preparePage('/', renderDashboard);
}

async function renderDashboard() {
  const accountId = await selfAccountId();

  if (!accountId) {
    return (
      <main className="space-y-8">
        <Header handle={null} />
        <Panel>
          <PanelHeader title="Nothing synced yet" />
          <EmptyState title="No account">
            Run <span className="font-mono">npm run setup:account</span>, then the Sync workflow.
          </EmptyState>
        </Panel>
      </main>
    );
  }

  const [overview, { batch, cards }, followers, totals, follows] = await Promise.all([
    accountOverview(accountId),
    latestCards(accountId),
    followerChart(accountId, 30),
    recentTotals(accountId, 30),
    followsSummary(accountId, 30),
  ]);

  return (
    <main className="space-y-10">
      <Header handle={overview.handle} />

      <section>
        <div className="mb-4 flex items-baseline justify-between gap-4">
          <h2 className="text-base font-semibold">Opportunities</h2>
          <RefreshInsights />
        </div>

        {cards.length > 0 ? (
          <>
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {cards.map((card, i) => (
                <StickyNote
                  key={card.id}
                  id={card.id}
                  body={card.body}
                  index={i}
                  citedPosts={card.citedPosts}
                />
              ))}
            </div>
            {/* Fewer than six is the honest outcome, not a failure — so say so
                rather than leaving a gap that reads as something missing. */}
            {cards.length < 4 ? (
              <p className="mt-4 text-xs text-ink-faint">
                {cards.length} note{cards.length === 1 ? '' : 's'} this time. The rest weren&rsquo;t
                supported by enough data to be worth showing.
              </p>
            ) : null}
          </>
        ) : (
          <Panel>
            <EmptyState title="No notes yet">
              {batch?.reason ??
                'Notes are generated on a schedule from your own data. Nothing has been generated yet.'}
            </EmptyState>
          </Panel>
        )}
      </section>

      <section className="space-y-5">
        <h2 className="text-base font-semibold">Your account</h2>

        {/* One panel, not three. The lower half had two headed panels, five
            sample lines and two paragraphs of explanation around eight
            numbers — more furniture than content, and the eye had nowhere to
            land. The caveats still have to be said; they are said once. */}
        <Panel>
          <div className="grid divide-y divide-rule sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            <Stat
              label="Followers"
              value={overview.followers ?? null}
              note={
                followers.change === null
                  ? followers.changeUnavailable
                  : `${formatChange(followers.change)} in 30 days`
              }
            />
            <Stat label="Following" value={overview.following ?? null} />
            <Stat
              label="Posts"
              value={overview.coverage.posts}
              note={
                overview.coverage.oldestPost
                  ? `back to ${formatRiyadhDate(new Date(overview.coverage.oldestPost))}`
                  : undefined
              }
            />
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="Last 30 days" />
          <div className="grid divide-y divide-rule sm:grid-cols-2 sm:divide-x lg:grid-cols-3">
            {totals.map((metric) => (
              <Stat
                key={metric.metric}
                label={metric.label}
                value={metric.total}
                marked={metric.unstable && metric.measured > 0}
                unknownReason={metric.measured === 0 ? 'Not collected for this period' : undefined}
                note={sampleNote(metric.measured, metric.days, 'day')}
              />
            ))}
          </div>
          {totals.some((m) => m.unstable && m.measured > 0) ? (
            <p className="border-t border-rule px-5 py-3 text-xs text-ink-faint">
              <span className="text-accent">*</span> Instagram changed what these count within the
              last two years. Worth reading now; not worth comparing against older periods.
            </p>
          ) : null}
        </Panel>

        {follows.measured > 0 && !follows.labelled ? (
          <p className="text-xs text-ink-faint">
            Instagram also reports {follows.follows} and {follows.unfollows} for follows and
            unfollows over 30 days, but does not say which is which. They stay unlabelled until a
            check against your actual follower count settles it.
          </p>
        ) : null}

        <p className="text-xs text-ink-faint">
          Instagram serves no follower history at all, so the change above is measured from readings
          this app takes daily — it grows forward from the first sync, and there is nothing before
          it. {overview.coverage.postsWithInsights} of {overview.coverage.posts} posts have
          performance data.
        </p>
      </section>
    </main>
  );
}

function formatChange(change: number): string {
  return change > 0 ? `+${change}` : String(change);
}

function Header({ handle }: { handle: string | null }) {
  return (
    <header>
      <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
      <p className="mt-1 text-sm text-ink-muted">
        {handle ? `@${handle} — ` : ''}what your account is doing, and what you could do about it.
      </p>
    </header>
  );
}
