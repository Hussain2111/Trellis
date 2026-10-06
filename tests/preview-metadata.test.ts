import { describe, expect, it } from 'vitest';
import {
  browserRecord,
  isTrellisDeploymentUrl,
  previewConfig,
  resourceRoute,
  responseMetadata,
  serverRecord,
  statistics,
} from '../scripts/benchmark/preview-metadata';

const metadata = {
  kind: 'server',
  requestId: 'a1d79f8a-9bcb-4517-8ddc-45748b9ab31d',
  route: '/chat',
  durationMs: 42,
  outcome: 'ok',
  stages: { database: { count: 1, failed: 0, totalMs: 20, wallMs: 20 } },
  counters: { historyMessages: 20 },
  databaseQueries: [{ ordinal: 1, offsetMs: 0, durationMs: 20, failed: false }],
  queryTimingsTruncated: false,
  otherRequestMs: 42,
};

describe('deployed preview artifact privacy and target guards', () => {
  it('accepts only immutable URLs of the requested Vercel project, without credentials or queries', () => {
    expect(isTrellisDeploymentUrl('https://trellisv2-cjekr1a5x-hussain-9c72.vercel.app/')).toBe(
      true,
    );
    for (const url of [
      'https://trellisv2.vercel.app/',
      'http://trellisv2-cjekr1a5x-hussain-9c72.vercel.app/',
      'https://secret@trellisv2-cjekr1a5x-hussain-9c72.vercel.app/',
      'https://trellisv2-cjekr1a5x-hussain-9c72.vercel.app/?token=secret',
      'https://trellisv2-cjekr1a5x-hussain-9c72.vercel.app/#secret',
      'https://trellisv2-cjekr1a5x-hussain-9c72.vercel.app.evil.example/',
    ])
      expect(isTrellisDeploymentUrl(url)).toBe(false);
  });

  it('strips unknown sensitive fields at every level before writing metadata', () => {
    const privateText = 'PRIVATE prompt, SQL parameter, row and credential';
    const server = {
      ...metadata,
      prompt: privateText,
      credentials: privateText,
      stages: {
        database: { ...metadata.stages.database, sql: privateText },
        arbitrary: privateText,
      },
      counters: { ...metadata.counters, parameters: privateText },
      databaseQueries: [{ ...metadata.databaseQueries[0], rows: privateText }],
    };
    expect(serverRecord.parse(server)).toEqual(metadata);
    const event = browserRecord.parse({ kind: 'initial', server, messages: privateText });
    expect(JSON.stringify(event)).not.toContain(privateText);
    expect(event).toEqual({ kind: 'initial', server: metadata });
  });

  it('requires platform identity, regions and a nonempty dataset before any browser requests', () => {
    const config = {
      deploymentUrl: 'https://trellisv2-cjekr1a5x-hussain-9c72.vercel.app/',
      environment: 'preview',
      commit: '3a344e528f61e8a8a8c239f2352ee71570cfd191',
      deploymentId: 'dpl_5Cbrf6XcJdpzzzyFoYpwgmLB32NT',
      projectName: 'trellis_v2',
      projectId: 'prj_d51kAzxIDY6jAqRv3UL9qd8ohPS3',
      // Synthetic identity/region fixtures; no Supabase project was verified.
      appRegions: ['iad1'],
      supabaseProjectRef: 'abcdefghijklmnopqrst',
      databaseRegion: 'us-east-1',
      dataset: {
        accounts: 1,
        posts: 1,
        accountDays: 1,
        threads: 1,
        messages: 1,
        calendarEntries: 1,
        insightBatches: 1,
        insightCards: 1,
      },
    };
    expect(previewConfig.safeParse(config).success).toBe(true);
    for (const value of [
      { ...config, supabaseProjectRef: null },
      { ...config, appRegions: [] },
      { ...config, projectName: 'trellis' },
      { ...config, environment: 'production' },
      { ...config, commit: 'main' },
      { ...config, dataset: { ...config.dataset, threads: 0 } },
    ])
      expect(previewConfig.safeParse(value).success).toBe(false);
    expect(
      JSON.stringify(previewConfig.parse({ ...config, databaseUrl: 'PRIVATE credential' })),
    ).not.toContain('PRIVATE');
  });

  it('rejects text in numeric fields, unknown routes, oversized query samples, and invalid IDs', () => {
    for (const value of [
      { ...metadata, durationMs: 'secret' },
      { ...metadata, durationMs: Infinity },
      { ...metadata, requestId: 'PRIVATE' },
      { ...metadata, route: '/chat?thread=123' },
      { ...metadata, counters: { historyMessages: 'conversation' } },
      { ...metadata, databaseQueries: Array(101).fill(metadata.databaseQueries[0]) },
    ])
      expect(serverRecord.safeParse(value).success).toBe(false);
  });

  it('removes search parameters, thread IDs, hostnames and private asset names', () => {
    expect(resourceRoute('https://user:secret@example.com/chat?thread=123&prompt=PRIVATE')).toBe(
      '/chat',
    );
    expect(resourceRoute('https://example.com/api/chat/threads/123')).toBe(
      '/api/chat/threads/[id]',
    );
    expect(resourceRoute('https://example.com/_next/static/private-build/chunk.js')).toBe(
      '/_next/asset',
    );
    expect(resourceRoute('https://example.com/private-title')).toBe('/other');
    expect(resourceRoute('malformed PRIVATE')).toBe('/other');
  });

  it('retains only valid correlation IDs and numerical allowlisted Server-Timing fields', () => {
    expect(
      responseMetadata(
        metadata.requestId,
        'app;dur=42, model;dur=12;desc="PRIVATE", secret;dur=9, tool;dur=Infinity',
      ),
    ).toEqual({ requestId: metadata.requestId, stages: { app: 42, model: 12 } });
    expect(responseMetadata('PRIVATE credential', 'app;dur=PRIVATE')).toEqual({
      requestId: null,
      stages: {},
    });
  });

  it('reports actual sample sizes and nearest-rank p95 without treating missing observations as zero', () => {
    expect(statistics([null, undefined, NaN])).toEqual({ n: 0, median: null, p95: null });
    expect(statistics([10, 20, null, 40, 30])).toEqual({ n: 4, median: 25, p95: 40 });
    expect(statistics(Array.from({ length: 20 }, (_, index) => index + 1))).toEqual({
      n: 20,
      median: 10.5,
      p95: 19,
    });
  });
});
