import { preparePage } from '@/lib/performance/page';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { env } from '@/lib/env';
import {
  knownProviders,
  maxStepsFor,
  parseModelRef,
  questionsLeft,
  quotaCaps,
  resolveLanes,
} from '@/lib/model/provider';
import { callsLastMinute, callsToday } from '@/lib/chat/threads';
import { ALL_SCOPES, REQUIRED_SCOPES, SCOPE_PURPOSE } from '@/lib/graph/scopes';
import { formatRiyadh } from '@/lib/time';
import { Badge, Panel, PanelHeader } from '@/components/ui/primitives';

export const dynamic = 'force-dynamic';

/**
 * The instrument panel, built in Stage 1 rather than last.
 *
 * It renders the RESOLVED environment the running function actually sees. On
 * the previous build that turned out to be a more reliable way to confirm a
 * Vercel variable change had taken effect than the Vercel dashboard itself —
 * particularly once variables had been marked "Sensitive" and become
 * write-only, making a failed save indistinguishable from a successful one.
 *
 * Values are reported as set/not set. Nothing here prints a secret.
 */

async function databaseStatus(): Promise<{ ok: boolean; detail: string; lastBeat: Date | null }> {
  try {
    const rows = await db().execute<{ at: Date | null }>(sql`select max(at) as at from heartbeats`);
    const raw = rows[0]?.at ?? null;
    return {
      ok: true,
      detail: 'connected',
      // Raw sql aggregates arrive as strings — there is no column type for
      // postgres-js to parse them against, and handing one to a date formatter
      // throws. Coerce at the boundary.
      lastBeat: raw == null ? null : raw instanceof Date ? raw : new Date(String(raw)),
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      lastBeat: null,
    };
  }
}

/**
 * Reports what it can read, and says so when it cannot.
 *
 * A failure here almost always means one thing — a migration that has not been
 * run against this database — so it names the error rather than substituting a
 * plausible number for it.
 */
async function modelUsage(): Promise<
  { ok: true; lastMinute: number; chat: number; cards: number } | { ok: false; error: string }
> {
  try {
    // Scoped to the lane actually in use. A rate limit belongs to a provider,
    // so a count that mixes two of them describes neither.
    const provider = parseModelRef(env().MODEL_PRIMARY).provider;
    const [lastMinute, chat, cards] = await Promise.all([
      callsLastMinute(provider),
      callsToday('chat', provider),
      callsToday('cards', provider),
    ]);
    return { ok: true, lastMinute, chat, cards };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 120) : 'unknown error',
    };
  }
}

export default function SettingsPage() {
  return preparePage('/settings', renderSettings);
}

async function renderSettings() {
  const e = env();
  const caps = quotaCaps();

  // The instrument panel, and the reason it exists: the limit that stops this
  // app is requests per minute, and it is invisible everywhere else.
  // `.catch(() => 0)` here would have been worse than useless: a missing column
  // — a migration that has not been run against this database — would render as
  // a confident "0 of 5" on the one page whose entire job is to report what the
  // running function actually resolved.
  const [database, usage] = await Promise.all([databaseStatus(), modelUsage()]);
  // Built, not merely configured — the difference is a missing API key.
  const lanes = (() => {
    try {
      return resolveLanes();
    } catch {
      return [];
    }
  })();

  const rows: { label: string; value: string; tone?: 'good' | 'bad' }[] = [
    { label: 'Graph API version requested', value: e.GRAPH_API_VERSION },
    { label: 'Environment', value: e.NODE_ENV },
    { label: 'App URL', value: e.APP_URL ?? 'not set' },
    { label: 'Instagram handle', value: e.IG_HANDLE ?? 'not set' },
    { label: 'Instagram user id', value: e.IG_USER_ID ?? 'not set' },
    {
      label: 'Instagram token',
      value: e.IG_ACCESS_TOKEN ? 'set' : 'not set',
      tone: e.IG_ACCESS_TOKEN ? 'good' : 'bad',
    },
    {
      label: 'Cron secret',
      value: e.CRON_SECRET ? 'set' : 'not set',
      tone: e.CRON_SECRET ? 'good' : 'bad',
    },
    { label: 'Primary model', value: e.MODEL_PRIMARY },
    { label: 'Fallback model', value: e.MODEL_FALLBACK ?? 'not set' },
    {
      label: 'Model API key',
      value: e.GOOGLE_GENERATIVE_AI_API_KEY ? 'set' : 'not set',
      tone: e.GOOGLE_GENERATIVE_AI_API_KEY ? 'good' : 'bad',
    },
    {
      // Requests, not messages. One chat message is a whole tool loop.
      label: 'Requests in the last minute',
      value: usage.ok
        ? `${usage.lastMinute} of ${caps.callsPerMinute}`
        : `cannot read — ${usage.error}`,
      tone: !usage.ok || usage.lastMinute >= caps.callsPerMinute ? 'bad' : 'good',
    },
    {
      label: 'Requests today',
      value: usage.ok
        ? `${usage.chat + usage.cards} of ${caps.dailyCalls} (${usage.chat} chat, ${usage.cards} notes)`
        : 'cannot read',
      tone: usage.ok ? undefined : 'bad',
    },
    {
      // The number that actually governs what you can do with this today.
      label: 'Questions left today',
      value: usage.ok ? `about ${questionsLeft(usage.chat, caps)}` : 'cannot read',
      tone: usage.ok && questionsLeft(usage.chat, caps) === 0 ? 'bad' : undefined,
    },
    {
      label: 'Requests a question can spend',
      value: `up to ${maxStepsFor(caps)}`,
    },
    {
      // A fallback that cannot be built is not a fallback, and finding that out
      // when the primary runs dry is finding out too late.
      label: 'Lanes available',
      value: lanes.length
        ? lanes.map((lane) => `${lane.provider}:${lane.modelId}`).join(' → ')
        : 'none',
      tone: lanes.length > 1 ? 'good' : undefined,
    },
    {
      label: 'Providers this build can reach',
      value: knownProviders().join(', '),
    },
  ];

  return (
    <main className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-ink-muted">
          What this deployment actually resolved — not what a dashboard says it should have.
        </p>
      </header>

      <Panel>
        <PanelHeader
          title="Database"
          aside={<Badge tone={database.ok ? 'good' : 'bad'}>{database.ok ? 'ok' : 'error'}</Badge>}
        />
        <dl className="divide-y divide-rule">
          <Row label="Connection" value={database.detail} />
          <Row
            label="Last keepalive write"
            value={database.lastBeat ? formatRiyadh(database.lastBeat) : 'never'}
          />
        </dl>
      </Panel>

      <Panel>
        <PanelHeader title="Configuration" />
        <dl className="divide-y divide-rule">
          {rows.map((row) => (
            <Row key={row.label} label={row.label} value={row.value} tone={row.tone} />
          ))}
        </dl>
      </Panel>

      <Panel>
        <PanelHeader
          title="Token scopes"
          aside={`${REQUIRED_SCOPES.length} required · ${ALL_SCOPES.length} requested`}
        />
        <div className="px-5 py-3 text-xs text-ink-faint">
          Live scope checking arrives with the Graph client. Until then this is the list a token
          must be generated with — <span className="font-mono">business_management</span> included,
          whose absence returns an empty Page list rather than an error.
        </div>
        <dl className="divide-y divide-rule">
          {ALL_SCOPES.map((scope) => (
            <Row key={scope} label={scope} value={SCOPE_PURPOSE[scope] ?? ''} mono />
          ))}
        </dl>
      </Panel>
    </main>
  );
}

function Row({
  label,
  value,
  tone,
  mono,
}: {
  label: string;
  value: string;
  tone?: 'good' | 'bad';
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-5 py-3">
      <dt className={`text-sm text-ink-muted ${mono ? 'font-mono text-xs' : ''}`}>{label}</dt>
      <dd className={`text-right text-sm ${tone === 'bad' ? 'text-negative' : 'text-ink'}`}>
        {value}
      </dd>
    </div>
  );
}
