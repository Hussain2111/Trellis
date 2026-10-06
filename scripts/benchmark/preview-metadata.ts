import { z } from 'zod';

export const pageRoutes = ['/', '/calendar', '/chat', '/settings'] as const;
const routes = [
  ...pageRoutes,
  '/api/chat',
  '/api/alerts',
  '/api/calendar',
  '/api/chat/threads',
  '/api/chat/threads/[id]',
] as const;
const duration = z.number().finite().nonnegative();
const count = z.number().int().nonnegative();
const stage = z.object({ count, failed: count, totalMs: duration, wallMs: duration });

// Every nested object strips unknown fields. Never spread raw events or log records
// into a public artifact, even if a future instrument adds more fields.
export const serverRecord = z.object({
  kind: z.literal('server'),
  requestId: z.uuid(),
  route: z.enum(routes),
  durationMs: duration,
  outcome: z.enum(['ok', 'error']),
  stages: z.object({
    database: stage.optional(),
    preflight: stage.optional(),
    model: stage.optional(),
    tool: stage.optional(),
    validation: stage.optional(),
    persistence: stage.optional(),
  }),
  counters: z.object({
    historyMessages: count.optional(),
    modelCalls: count.optional(),
    inputTokens: count.optional(),
    outputTokens: count.optional(),
    accountCacheHits: count.optional(),
    accountCacheMisses: count.optional(),
  }),
  databaseQueries: z
    .array(
      z.object({ ordinal: count, offsetMs: duration, durationMs: duration, failed: z.boolean() }),
    )
    .max(100),
  queryTimingsTruncated: z.boolean(),
  otherRequestMs: duration,
});

export const browserRecord = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('initial'), server: serverRecord }),
  z.object({
    kind: z.literal('navigation'),
    navigationId: z.uuid(),
    route: z.enum(pageRoutes),
    visit: z.enum(['first', 'repeat']),
    feedback: z.enum(['pending', 'loading', 'page']),
    clickToFeedbackMs: duration,
    clickToUsableMs: duration,
    server: serverRecord,
    serverRequestFresh: z.boolean(),
  }),
  z.object({
    kind: z.literal('chat'),
    requestId: z.uuid(),
    outcome: z.enum(['ok', 'error']),
    submitToFeedbackMs: duration.nullable(),
    submitToResponseMs: duration,
    submitToVisibleMs: duration,
  }),
]);

export const previewConfig = z.object({
  deploymentUrl: z.string().refine(isTrellisDeploymentUrl),
  environment: z.literal('preview'),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  deploymentId: z.string().regex(/^(?:dpl_)?[a-zA-Z0-9]{20,40}$/),
  projectName: z.literal('trellis_v2'),
  projectId: z.literal('prj_d51kAzxIDY6jAqRv3UL9qd8ohPS3'),
  appRegions: z.array(z.string().regex(/^[a-z]{3}[1-9]$/)).min(1),
  supabaseProjectRef: z.string().regex(/^[a-z]{20}$/),
  databaseRegion: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/),
  dataset: z.object({
    accounts: count.min(1),
    posts: count,
    accountDays: count,
    // /chat can create an implicit thread for an empty account. Require a
    // verified nonempty account before this navigation-only runner is used.
    threads: count.min(1),
    messages: count,
    calendarEntries: count,
    insightBatches: count,
    insightCards: count,
  }),
});

// An immutable URL does not establish the deployment's environment. That must
// be checked against platform metadata before setting environment: 'preview'.
export function isTrellisDeploymentUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      /^trellisv2-[a-z0-9]{9}-hussain-9c72\.vercel\.app$/.test(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash &&
      url.href === value
    );
  } catch {
    return false;
  }
}

/** Low-cardinality paths only: never preserve queries, thread IDs or asset names. */
export function resourceRoute(value: string): string {
  try {
    const path = new URL(value).pathname;
    if ((routes as readonly string[]).includes(path)) return path;
    if (/^\/api\/chat\/threads\/\d+$/.test(path)) return '/api/chat/threads/[id]';
    if (path.startsWith('/_next/')) return '/_next/asset';
  } catch {
    // No raw URL in either errors or results.
  }
  return '/other';
}

/** Ignore descriptions and all unrecognized header fields. */
export function responseMetadata(id: string | null, timing: string | null) {
  const stages: Partial<
    Record<
      'app' | 'database' | 'preflight' | 'model' | 'tool' | 'validation' | 'persistence',
      number
    >
  > = {};
  for (const field of (timing ?? '').split(',')) {
    const match =
      /^(app|database|preflight|model|tool|validation|persistence);dur=(\d+(?:\.\d+)?)(?:;|$)/.exec(
        field.trim(),
      );
    if (match && Number.isFinite(Number(match[2])))
      stages[match[1] as keyof typeof stages] = Number(match[2]);
  }
  const parsed = z.uuid().safeParse(id);
  return { requestId: parsed.success ? parsed.data : null, stages };
}

export function statistics(values: (number | null | undefined)[]) {
  const sorted = values.filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
  sorted.sort((a, b) => a - b);
  if (!sorted.length) return { n: 0, median: null, p95: null };
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    n: sorted.length,
    median: round(median),
    p95: round(sorted[Math.ceil(sorted.length * 0.95) - 1]!),
  };
}
