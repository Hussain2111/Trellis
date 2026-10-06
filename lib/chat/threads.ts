import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { accounts, chatMessages, chatThreads } from '../db/schema';
import { renderChatSystem } from '../prompts/chat-system';
import { accountOverview, insightCard } from './queries';
import { count } from '../performance/server';

/**
 * The one account's id, remembered for the life of a warm function.
 *
 * Single account, no auth (decision 1) — so this row is written once by the
 * bootstrap script and never changes. It was being looked up again on every
 * page render and every API call, which is a whole round trip to Supabase in
 * front of work that had not started yet.
 *
 * Only a HIT is cached. A miss means the account has not been created yet, and
 * caching that would leave a warm function insisting the app is unconfigured
 * long after it was configured.
 */
let cachedAccountId: number | null = null;

export async function selfAccountId(): Promise<number | null> {
  if (cachedAccountId !== null) {
    count('accountCacheHits');
    return cachedAccountId;
  }
  count('accountCacheMisses');
  const [row] = await db().select({ id: accounts.id }).from(accounts).limit(1);
  cachedAccountId = row?.id ?? null;
  return cachedAccountId;
}

export async function listThreads(accountId: number) {
  return db()
    .select()
    .from(chatThreads)
    .where(eq(chatThreads.accountId, accountId))
    .orderBy(desc(chatThreads.updatedAt))
    .limit(50);
}

export async function createThread(accountId: number, sourceCardId?: number) {
  const [row] = await db()
    .insert(chatThreads)
    .values({ accountId, sourceCardId: sourceCardId ?? null })
    .returning();
  return row!;
}

/**
 * Opening a dashboard note starts a conversation that already contains it.
 *
 * The first version created an empty thread and navigated to it, so the note
 * you had just clicked appeared nowhere, the previous conversation was no
 * longer the most recent one, and the whole thing read as though the chat had
 * been wiped. The note is now seeded as the assistant's opening turn: it is on
 * screen, it is what you reply to, and nothing else is disturbed.
 *
 * What is seeded is the note's own already-validated text — never its evidence.
 * The figures still have to come back through `getInsightCard` before the model
 * may restate them, which is what the validator checks the next answer against.
 */
export async function createThreadFromCard(accountId: number, cardId: number) {
  const card = await insightCard(accountId, cardId);
  const thread = await createThread(accountId, cardId);

  if (!card.found) return thread;

  await appendMessage({
    threadId: thread.id,
    role: 'assistant',
    content: `${card.body}\n\nThat note was ${card.freshness}. Ask me anything about it — what it was based on, which posts, or what to do about it.`,
  });

  await titleThread(thread.id, card.body);
  return thread;
}

export async function threadMessages(threadId: number) {
  return db()
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.threadId, threadId))
    .orderBy(chatMessages.createdAt);
}

export async function appendMessage(input: {
  threadId: number;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: unknown;
  validation?: unknown;
}) {
  await db()
    .insert(chatMessages)
    .values({
      threadId: input.threadId,
      role: input.role,
      content: input.content,
      toolCalls: (input.toolCalls ?? null) as object,
      validation: (input.validation ?? null) as object,
    });
  await db()
    .update(chatThreads)
    .set({ updatedAt: new Date() })
    .where(eq(chatThreads.id, input.threadId));
}

export async function titleThread(threadId: number, from: string) {
  const title = from.trim().slice(0, 70) + (from.trim().length > 70 ? '…' : '');
  // Never rename a thread that already has a name — a thread opened from a note
  // is titled at creation, and the first thing you type in it is a follow-up
  // question, not a better title for what you were shown.
  await db()
    .update(chatThreads)
    .set({ title })
    .where(and(eq(chatThreads.id, threadId), isNull(chatThreads.title)));
}

export async function deleteThread(accountId: number, threadId: number) {
  await db()
    .delete(chatThreads)
    .where(and(eq(chatThreads.accountId, accountId), eq(chatThreads.id, threadId)));
}

/**
 * The thread, if it belongs to this account.
 *
 * Returns the row rather than just its card reference, so a caller can tell a
 * thread with no card apart from a thread that is not there. Those used to be
 * the same answer, and the second one then failed further down as a foreign key
 * violation — a 500 about database internals, where the truthful answer is that
 * the conversation does not exist.
 */
export async function findThread(accountId: number, threadId: number) {
  const [row] = await db()
    .select()
    .from(chatThreads)
    .where(and(eq(chatThreads.accountId, accountId), eq(chatThreads.id, threadId)))
    .limit(1);
  return row ?? null;
}

/** Built fresh every turn from real state, so it can never describe a stale account. */
export async function buildSystemPrompt(accountId: number): Promise<string> {
  const overview = await accountOverview(accountId);
  return renderChatSystem({
    handle: overview.handle,
    followers: overview.followers,
    posts: overview.coverage.posts,
    postsWithInsights: overview.coverage.postsWithInsights,
    oldestPost: overview.coverage.oldestPost,
    followerDays: overview.coverage.followerDays,
    today: new Date().toISOString().slice(0, 10),
  });
}

/**
 * Today's model CALLS, for rationing. Failures count — they spent the same
 * quota as a success.
 *
 * Summed, not counted. A row is one chat message, and a message is a tool loop
 * of several provider requests; every published rate limit counts requests. A
 * row that predates the `calls` column stands for at least one.
 */
export async function callsToday(purpose: 'chat' | 'cards', provider?: string): Promise<number> {
  // Scoped to a provider, because a limit belongs to a provider. Switching from
  // an exhausted Gemini key to Groq must not inherit Gemini's spent counter —
  // the whole point of switching is a fresh allowance.
  const [row] = (await db().execute(sql`
    select coalesce(sum(coalesce(calls, 1)), 0)::int as n from model_runs
    where purpose = ${purpose}
      and created_at > now() - interval '24 hours'
      ${provider ? sql`and provider = ${provider}` : sql``}
  `)) as unknown as { n: number }[];
  return row?.n ?? 0;
}

/**
 * When the oldest call still inside the 24-hour window was made.
 *
 * The daily cap is a rolling window, so this is the moment the first slot frees
 * again. A true statement about this app's own guard, which is not the same as
 * guessing when the provider resets its counter.
 */
export async function oldestCallInWindow(provider?: string): Promise<Date | null> {
  const [row] = (await db().execute(sql`
    select min(created_at) as oldest from model_runs
    where created_at > now() - interval '24 hours'
      ${provider ? sql`and provider = ${provider}` : sql``}
  `)) as unknown as { oldest: string | Date | null }[];
  if (!row?.oldest) return null;
  // The driver hands back a raw string for an aggregate over a timestamp, and
  // this is the third time in this project that has needed coercing at a
  // boundary rather than being assumed to arrive as a Date.
  return row.oldest instanceof Date ? row.oldest : new Date(row.oldest);
}

/**
 * Calls in the last sixty seconds, across every purpose.
 *
 * This is the limit that actually fires on a free tier — five requests a
 * minute, where the daily cap is two hundred. A guard that only knows about the
 * day never sees it coming.
 */
export async function callsLastMinute(provider?: string): Promise<number> {
  const [row] = (await db().execute(sql`
    select coalesce(sum(coalesce(calls, 1)), 0)::int as n from model_runs
    where created_at > now() - interval '60 seconds'
      ${provider ? sql`and provider = ${provider}` : sql``}
  `)) as unknown as { n: number }[];
  return row?.n ?? 0;
}

/** A ledger scoped to one provider, which is the scope every rate limit has. */
export function ledgerFor(provider: string) {
  return {
    callsToday: (purpose: 'chat' | 'cards') => callsToday(purpose, provider),
    callsLastMinute: () => callsLastMinute(provider),
    oldestCallInWindow: () => oldestCallInWindow(provider),
  };
}
