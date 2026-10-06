import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export type TimedRoute =
  | '/'
  | '/calendar'
  | '/chat'
  | '/settings'
  | '/api/chat'
  | '/api/alerts'
  | '/api/calendar'
  | '/api/chat/threads'
  | '/api/chat/threads/[id]';
export type Stage = 'database' | 'preflight' | 'model' | 'tool' | 'validation' | 'persistence';
type Counter =
  | 'historyMessages'
  | 'modelCalls'
  | 'inputTokens'
  | 'outputTokens'
  | 'accountCacheHits'
  | 'accountCacheMisses';
export interface Interval {
  start: number;
  end: number;
  failed: boolean;
}
export interface StageSummary {
  count: number;
  failed: number;
  totalMs: number;
  wallMs: number;
}
export interface ServerTiming {
  kind: 'server';
  requestId: string;
  route: TimedRoute;
  durationMs: number;
  outcome: 'ok' | 'error';
  stages: Partial<Record<Stage, StageSummary>>;
  counters: Partial<Record<Counter, number>>;
  otherRequestMs: number;
}
interface Scope {
  requestId: string;
  started: number;
  intervals: Partial<Record<Stage, Interval[]>>;
  counters: ServerTiming['counters'];
  open: Set<(failed?: boolean) => void>;
}
const scope = new AsyncLocalStorage<Scope>();
const round = (n: number) => Math.round(n * 100) / 100;

/** Union of intervals, not their sum: parallel queries/tools overlap. */
export function summarize(intervals: Interval[]): StageSummary {
  let wallMs = 0;
  let end = -Infinity;
  for (const interval of [...intervals].sort((a, b) => a.start - b.start)) {
    wallMs += Math.max(0, interval.end - Math.max(end, interval.start));
    end = Math.max(end, interval.end);
  }
  return {
    count: intervals.length,
    failed: intervals.filter((i) => i.failed).length,
    totalMs: round(intervals.reduce((n, i) => n + i.end - i.start, 0)),
    wallMs: round(wallMs),
  };
}

export function startStage(stage: Stage): (failed?: boolean) => void {
  const current = scope.getStore();
  if (!current) return () => {};
  const start = performance.now() - current.started;
  let finished = false;
  const finish = (failed = false) => {
    if (finished) return;
    finished = true;
    (current.intervals[stage] ??= []).push({
      start,
      end: performance.now() - current.started,
      failed,
    });
    current.open.delete(finish);
  };
  current.open.add(finish);
  return finish;
}

export async function measure<T>(stage: Stage, work: () => PromiseLike<T>): Promise<T> {
  const finish = startStage(stage);
  try {
    const result = await work();
    finish();
    return result;
  } catch (error) {
    finish(true);
    throw error;
  }
}

export function count(name: Counter, amount = 1): void {
  const current = scope.getStore();
  if (current && Number.isFinite(amount) && amount >= 0) {
    current.counters[name] = (current.counters[name] ?? 0) + amount;
  }
}

export function requestId(): string | undefined {
  return scope.getStore()?.requestId;
}

/** Only typed, allowlisted metadata leaves this scope; never serialize errors or inputs. */
export async function timed<T>(route: TimedRoute, work: () => Promise<T>, incomingId?: string) {
  if (process.env.TRELLIS_PERFORMANCE !== '1') return { value: await work(), metadata: undefined };
  const current: Scope = {
    requestId:
      incomingId &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(incomingId)
        ? incomingId
        : randomUUID(),
    started: performance.now(),
    intervals: {},
    counters: {},
    open: new Set(),
  };
  return scope.run(current, async () => {
    let failed = false;
    let metadata: ServerTiming | undefined;
    try {
      const value = await work();
      if (value instanceof Response) failed = value.status >= 400;
      metadata = finish();
      return { value, metadata };
    } catch (error) {
      failed = true;
      finish();
      throw error;
    }
    function finish(): ServerTiming {
      for (const close of current.open) close(failed);
      const duration = performance.now() - current.started;
      const generation = summarize([
        ...(current.intervals.model ?? []),
        ...(current.intervals.tool ?? []),
      ]);
      const result: ServerTiming = {
        kind: 'server',
        requestId: current.requestId,
        route,
        durationMs: round(duration),
        outcome: failed ? 'error' : 'ok',
        stages: Object.fromEntries(
          Object.entries(current.intervals).map(([stage, intervals]) => [
            stage,
            summarize(intervals),
          ]),
        ),
        counters: { ...current.counters },
        otherRequestMs: round(Math.max(0, duration - generation.wallMs)),
      };
      console.info('[performance]', JSON.stringify(result));
      return result;
    }
  });
}

export async function timedResponse(
  route: TimedRoute,
  request: Request,
  work: () => Promise<Response>,
) {
  const { value, metadata } = await timed(
    route,
    work,
    request.headers.get('x-trellis-request-id') ?? undefined,
  );
  if (metadata) {
    value.headers.set('x-trellis-request-id', metadata.requestId);
    value.headers.set(
      'server-timing',
      [
        `app;dur=${metadata.durationMs}`,
        ...Object.entries(metadata.stages).map(([stage, data]) => `${stage};dur=${data.wallMs}`),
      ].join(', '),
    );
  }
  return value;
}
