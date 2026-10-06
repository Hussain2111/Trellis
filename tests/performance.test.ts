import { afterEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { createServer } from 'node:net';
import { instrumentSql } from '../lib/performance/database';
import { count, measure, summarize, timed, timedResponse } from '../lib/performance/server';
import { localPostgresUrl, startServer } from '../scripts/benchmark/fixture';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('metadata-only performance measurements', () => {
  it('refuses an occupied benchmark port before launching or sending application requests', async () => {
    const listener = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    try {
      const address = listener.address();
      if (!address || typeof address === 'string') throw new Error('Expected a local TCP port');
      await expect(
        startServer('postgres://postgres@127.0.0.1/unused', address.port),
      ).rejects.toThrow('already in use');
    } finally {
      await new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('separates concurrent wall time from the sum of individual query times', () => {
    expect(
      summarize([
        { start: 0, end: 10, failed: false },
        { start: 5, end: 20, failed: true },
        { start: 30, end: 35, failed: false },
      ]),
    ).toEqual({ count: 3, failed: 1, totalMs: 30, wallMs: 25 });
  });

  it('keeps parallel request scopes isolated and preserves response bodies', async () => {
    vi.stubEnv('TRELLIS_PERFORMANCE', '1');
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const response = (route: '/api/chat' | '/api/calendar', delay: number) =>
      timedResponse(route, new Request('http://localhost'), async () => {
        count('historyMessages', delay);
        await measure('tool', () => new Promise((resolve) => setTimeout(resolve, delay)));
        return Response.json({ unchanged: true });
      });
    const [chat, calendar] = await Promise.all([
      response('/api/chat', 20),
      response('/api/calendar', 5),
    ]);
    expect(await chat.json()).toEqual({ unchanged: true });
    expect(chat.headers.get('x-trellis-request-id')).not.toBe(
      calendar.headers.get('x-trellis-request-id'),
    );
    const logs = vi.mocked(console.info).mock.calls.map((call) => JSON.parse(call[1] as string));
    expect(logs.find((log) => log.route === '/api/chat').counters.historyMessages).toBe(20);
    expect(logs.find((log) => log.route === '/api/calendar').counters.historyMessages).toBe(5);
    expect(chat.headers.get('server-timing')).toContain('tool;dur=');
  });

  it('does not log errors, body text, arbitrary headers, or untrusted correlation strings', async () => {
    vi.stubEnv('TRELLIS_PERFORMANCE', '1');
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const secret = 'PRIVATE conversation and credential';
    await expect(
      timed(
        '/api/chat',
        () =>
          measure('model', async () => {
            throw new Error(secret);
          }),
        secret,
      ),
    ).rejects.toThrow(secret);
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    const metadata = JSON.parse(log.mock.calls[0]![1] as string);
    expect(metadata.outcome).toBe('error');
    expect(metadata.stages.model.failed).toBe(1);
    expect(metadata.requestId).toMatch(/^[0-9a-f-]{36}$/);
    const id = 'a1d79f8a-9bcb-4517-8ddc-45748b9ab31d';
    const response = await timedResponse(
      '/api/chat',
      new Request('http://localhost', {
        headers: { 'x-trellis-request-id': id, authorization: secret },
      }),
      async () => Response.json({ text: secret }, { status: 503 }),
    );
    expect(response.headers.get('x-trellis-request-id')).toBe(id);
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    expect(JSON.parse(log.mock.calls[1]![1] as string).outcome).toBe('error');
  });

  it('has no log or response changes when instrumentation is disabled', async () => {
    vi.stubEnv('TRELLIS_PERFORMANCE', '0');
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const response = await timedResponse('/api/chat', new Request('http://localhost'), async () =>
      Response.json({ ok: true }),
    );
    expect(log).not.toHaveBeenCalled();
    expect(response.headers.has('server-timing')).toBe(false);
    expect(response.headers.has('x-trellis-request-id')).toBe(false);
  });

  it('preserves lazy execution, values, rejection, and transactions against real PostgreSQL', async () => {
    vi.stubEnv('TRELLIS_PERFORMANCE', '1');
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const client = postgres(process.env.DATABASE_URL!, { max: 2 });
    const sql = instrumentSql(client);
    try {
      const { value, metadata } = await timed('/chat', async () => {
        // This unconsumed query must never run or appear in the measurements.
        sql.unsafe('select 1 / 0');
        const query = sql.unsafe('select 42 as answer').values();
        expect(await query).toEqual([[42]]);
        expect(await query).toEqual([[42]]); // no double counting
        await expect(sql.unsafe('select 1 / 0')).rejects.toMatchObject({ code: '22012' });
        await sql.begin(async (transaction) => {
          expect(await transaction.unsafe('select 7 as answer')).toMatchObject([{ answer: 7 }]);
        });
        return 'unchanged';
      });
      expect(value).toBe('unchanged');
      expect(metadata!.stages.database).toMatchObject({ count: 3, failed: 1 });
      expect(metadata!.databaseQueries).toHaveLength(3);
      expect(metadata!.databaseQueries.map((query) => query.ordinal)).toEqual([1, 2, 3]);
      expect(metadata!.databaseQueries.filter((query) => query.failed)).toHaveLength(1);
      expect(metadata!.queryTimingsTruncated).toBe(false);
    } finally {
      await client.end();
    }
  });

  it('refuses production/non-Postgres benchmark destinations before any DB work', () => {
    expect(() => localPostgresUrl('postgres://user:secret@production.supabase.com/db')).toThrow(
      /local/,
    );
    expect(() => localPostgresUrl('https://localhost/db')).toThrow(/local/);
    expect(localPostgresUrl('postgres://postgres@127.0.0.1/anything').hostname).toBe('127.0.0.1');
  });
});
