import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { chatThreads } from '@/lib/db/schema';
import { ChatPanel } from '@/components/chat-panel';
import { ChatSidebar, type ThreadSummary } from '@/components/chat-sidebar';
import { createThread, listThreads, selfAccountId, threadMessages } from '@/lib/chat/threads';
import { EmptyState, Panel, PanelHeader } from '@/components/ui/primitives';
import { relativeRiyadh } from '@/lib/time';
import { preparePage } from '@/lib/performance/page';

export const dynamic = 'force-dynamic';

export default function ChatPage(input: { searchParams: Promise<{ thread?: string }> }) {
  return preparePage('/chat', () => renderChat(input));
}

async function renderChat({ searchParams }: { searchParams: Promise<{ thread?: string }> }) {
  const accountId = await selfAccountId();

  if (!accountId) {
    return (
      <main className="space-y-8">
        <Header />
        <Panel>
          <PanelHeader title="Not set up yet" />
          <EmptyState title="No account synced">
            The chat reads your own posts and follower history. Run the sync first and it will have
            something to reason about.
          </EmptyState>
        </Panel>
      </main>
    );
  }

  const params = await searchParams;
  const requested = params.thread ? Number(params.thread) : null;

  // The thread list and the requested thread's messages do not depend on each
  // other, so they go together rather than one after the other. Two sequential
  // round trips is one more than this page needs.
  const [threads, requestedHistory] = await Promise.all([
    listThreads(accountId),
    requested ? threadMessages(requested) : Promise.resolve(null),
  ]);

  // A requested thread must belong to this account; anything else falls back to
  // the most recent one. Visiting /chat never creates a thread unless there are
  // none at all — a page that spawns an empty conversation every time you look
  // at it is how the thread list filled with noise.
  let thread = requested ? (threads.find((t) => t.id === requested) ?? null) : null;
  if (!thread && requested) {
    const [found] = await db()
      .select()
      .from(chatThreads)
      .where(and(eq(chatThreads.accountId, accountId), eq(chatThreads.id, requested)))
      .limit(1);
    thread = found ?? null;
  }
  thread ??= threads[0] ?? (await createThread(accountId));

  const history =
    requestedHistory && thread.id === requested
      ? requestedHistory
      : await threadMessages(thread.id);

  const summaries: ThreadSummary[] = (
    threads.some((t) => t.id === thread.id) ? threads : [thread, ...threads]
  ).map((t) => ({
    id: t.id,
    title: t.title,
    fromNote: t.sourceCardId !== null,
    updatedLabel: relativeRiyadh(t.updatedAt),
  }));

  return (
    <main className="space-y-6">
      <Header />

      <div className="lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-8">
        {/* Desktop: a permanent rail. Mobile: a disclosure, because a phone
            screen belongs to the conversation, not to a list of them. */}
        <aside className="hidden lg:block">
          <ChatSidebar threads={summaries} activeId={thread.id} />
        </aside>

        <details className="mb-4 rounded-xl border border-rule bg-card px-4 py-3 lg:hidden">
          <summary className="cursor-pointer text-sm font-medium">
            Chats <span className="text-ink-faint">({summaries.length})</span>
          </summary>
          <div className="mt-3">
            <ChatSidebar threads={summaries} activeId={thread.id} />
          </div>
        </details>

        {/* Keyed on the thread, and it has to be. The panel seeds its state
            from `initial` with useState, which only reads on mount — without a
            key React reuses the same instance across a thread switch and the
            previous conversation stays on screen while the URL says otherwise. */}
        <ChatPanel
          key={thread.id}
          threadId={thread.id}
          initial={history.map((m) => ({
            role: m.role as 'user' | 'assistant',
            content: m.content,
          }))}
          fromNote={thread.sourceCardId !== null}
        />
      </div>
    </main>
  );
}

function Header() {
  return (
    <header>
      <h1 className="text-2xl font-semibold tracking-tight">Chat</h1>
      <p className="mt-1 text-sm text-ink-muted">
        Ask about your own account. Every number comes from your data, or it doesn&rsquo;t get said.
      </p>
    </header>
  );
}
