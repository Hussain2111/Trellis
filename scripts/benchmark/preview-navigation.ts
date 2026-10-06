import { chromium, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  browserRecord,
  pageRoutes,
  previewConfig,
  responseMetadata,
  resourceRoute,
  statistics,
} from './preview-metadata';
import type { z } from 'zod';

const option = (name: string, fallback = '') =>
  process.argv.find((arg) => arg.startsWith(name + '='))?.slice(name.length + 1) ?? fallback;
const trials = Number(option('--observations', '10'));
const output = option('--output', 'benchmark-results/deployed-preview.json');
const network = option('--network', 'lab');
const config = previewConfig.safeParse(
  await readFile(option('--config'), 'utf8').then(
    (text) => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    },
    () => null,
  ),
);
if (
  !config.success ||
  !Number.isInteger(trials) ||
  trials < 10 ||
  trials > 30 ||
  !['lab', 'native'].includes(network)
) {
  console.error(
    'Provide a verified preview metadata config, 10–30 observations, and lab/native network.',
  );
  process.exit(1);
}

type Route = (typeof pageRoutes)[number];
type CaptureWindow = Window & {
  __previewEvents?: { atMs: number; event: unknown }[];
  __previewLongTasks?: { startMs: number; durationMs: number }[];
};
type Observation = {
  trial: number;
  route: Route;
  category: 'initial' | 'first' | 'repeat';
  feedbackMs: number | null;
  usableMs: number;
  event: z.infer<typeof browserRecord>;
  networkSettled: boolean;
  requestCount: number;
  longTasks: { supported: boolean; count: number; totalMs: number };
  resources: {
    route: string;
    startMs: number;
    ttfbMs: number | null;
    responseMs: number | null;
    encodedBodySize: number;
    transferSize: number;
  }[];
};
const observations: Observation[] = [];
const responses: {
  trial: number;
  initialRoute: Route;
  route: string;
  status: number;
  requestId: string | null;
  stages: ReturnType<typeof responseMetadata>['stages'];
}[] = [];
const proxyUrl = (() => {
  try {
    return process.env.HTTPS_PROXY ? new URL(process.env.HTTPS_PROXY) : undefined;
  } catch {
    console.error('Invalid HTTPS_PROXY configuration; no credential values were printed.');
    process.exit(1);
  }
})();
const browser = await chromium
  .launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    headless: true,
    proxy: proxyUrl
      ? {
          server: proxyUrl.origin,
          username: decodeURIComponent(proxyUrl.username),
          password: decodeURIComponent(proxyUrl.password),
        }
      : undefined,
  })
  .catch(() => {
    console.error('Chromium could not start; preview capture has not begun.');
    process.exit(1);
  });
let stopped: 'preview_access' | 'marker_missing_or_timeout' | 'unexpected_metadata' | null = null;
const labels = {
  '/': 'Dashboard',
  '/calendar': 'Calendar',
  '/chat': 'Chat',
  '/settings': 'Settings',
};

async function capture(page: Page, trial: number, route: Route, initial: boolean, after: number) {
  await page.waitForFunction(
    ({ route, initial, after }) =>
      (window as CaptureWindow).__previewEvents?.some(({ atMs, event }) => {
        const item = event as { kind?: string; route?: string; server?: { route?: string } };
        return (
          atMs >= after &&
          (initial
            ? item.kind === 'initial' && item.server?.route === route
            : item.kind === 'navigation' && item.route === route)
        );
      }),
    { route, initial, after },
    { timeout: 30_000 },
  );
  // The usability timing comes from the event; the trailing-request wait is excluded.
  let networkSettled = true;
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {
    networkSettled = false;
  });
  const raw = await page.evaluate(
    ({ route, initial, after }) => {
      const record = (window as CaptureWindow).__previewEvents!.find(({ atMs, event }) => {
        const item = event as { kind?: string; route?: string; server?: { route?: string } };
        return (
          atMs >= after &&
          (initial
            ? item.kind === 'initial' && item.server?.route === route
            : item.kind === 'navigation' && item.route === route)
        );
      })!;
      const click =
        performance.getEntriesByName('trellis.navigation.click').at(-1)?.startTime ?? after;
      const start = initial ? 0 : click;
      const document = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
      const resources = (
        performance.getEntriesByType('resource') as PerformanceResourceTiming[]
      ).filter((item) => item.startTime >= start);
      const longTasks = (window as CaptureWindow).__previewLongTasks?.filter(
        (item) => item.startMs < record.atMs && item.startMs + item.durationMs > start,
      );
      return {
        event: record.event,
        readyAtMs: record.atMs,
        firstContentfulPaintMs:
          performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
        longTasks: {
          supported: longTasks !== undefined,
          count: longTasks?.length ?? 0,
          totalMs:
            longTasks?.reduce(
              (n, item) =>
                n +
                Math.min(record.atMs, item.startMs + item.durationMs) -
                Math.max(start, item.startMs),
              0,
            ) ?? 0,
        },
        resources: [...(initial ? [document] : []), ...resources].map((item) => ({
          url: item.name,
          startMs: item.startTime,
          ttfbMs: item.responseStart > 0 ? item.responseStart - item.requestStart : null,
          responseMs: item.requestStart > 0 ? item.responseEnd - item.requestStart : null,
          encodedBodySize: item.encodedBodySize,
          transferSize: item.transferSize,
        })),
      };
    },
    { route, initial, after },
  );
  const parsed = browserRecord.safeParse(raw.event);
  if (!parsed.success || parsed.data.kind === 'chat' || parsed.data.server.route !== route) {
    stopped = 'unexpected_metadata';
    throw new Error('unexpected_metadata');
  }
  const event = parsed.data;
  observations.push({
    trial,
    route,
    category: event.kind === 'initial' ? 'initial' : event.visit,
    feedbackMs: event.kind === 'initial' ? raw.firstContentfulPaintMs : event.clickToFeedbackMs,
    usableMs: event.kind === 'initial' ? raw.readyAtMs : event.clickToUsableMs,
    event,
    networkSettled,
    requestCount: raw.resources.length,
    longTasks: raw.longTasks,
    resources: raw.resources.map(({ url, ...timing }) => ({
      ...timing,
      route: resourceRoute(url),
    })),
  });
}

try {
  for (let trial = 1; trial <= trials; trial++) {
    for (const initialRoute of pageRoutes) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        timezoneId: 'Asia/Riyadh',
        storageState: process.env.TRELLIS_PREVIEW_STORAGE_STATE,
      });
      // No request interception: preserve ordinary HTTP/router/prefetch behavior.
      // Authentication state, if needed, stays in a private file outside the repo.
      const responseWork: Promise<void>[] = [];
      await context.addInitScript(() => {
        const events: { atMs: number; event: unknown }[] = [];
        (window as CaptureWindow).__previewEvents = events;
        window.addEventListener('trellis:performance', (event) => {
          events.push({ atMs: performance.now(), event: (event as CustomEvent).detail });
          if (events.length > 200) events.shift();
        });
        if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
          const tasks: { startMs: number; durationMs: number }[] = [];
          (window as CaptureWindow).__previewLongTasks = tasks;
          new PerformanceObserver((list) => {
            tasks.push(
              ...list
                .getEntries()
                .map((entry) => ({ startMs: entry.startTime, durationMs: entry.duration })),
            );
            if (tasks.length > 200) tasks.splice(0, tasks.length - 200);
          }).observe({ type: 'longtask', buffered: true });
        }
      });
      try {
        const page = await context.newPage();
        page.on('response', (response) => {
          responseWork.push(
            (async () => {
              const metadata = responseMetadata(
                await response.headerValue('x-trellis-request-id'),
                await response.headerValue('server-timing'),
              );
              responses.push({
                trial,
                initialRoute,
                route: resourceRoute(response.url()),
                status: response.status(),
                ...metadata,
              });
            })().catch(() => {}),
          );
        });
        if (network === 'lab') {
          const cdp = await context.newCDPSession(page);
          await cdp.send('Network.enable');
          await cdp.send('Network.emulateNetworkConditions', {
            offline: false,
            latency: 100,
            downloadThroughput: 1250000,
            uploadThroughput: 125000,
          });
        }
        let response;
        try {
          response = await page.goto(new URL(initialRoute, config.data.deploymentUrl).href);
        } catch {
          stopped = 'preview_access';
          throw new Error('preview_access');
        }
        if (
          !response?.ok() ||
          new URL(page.url()).origin !== new URL(config.data.deploymentUrl).origin
        ) {
          stopped = 'preview_access';
          throw new Error('preview_access');
        }
        await capture(page, trial, initialRoute, true, 0);
        // Dashboard → Calendar → Chat → Calendar is preserved, then cover Settings.
        // A Settings-start session gives Dashboard its first-tab observations.
        const sequence: Route[] =
          initialRoute === '/'
            ? ['/calendar', '/chat', '/calendar', '/settings', '/chat', '/', '/settings']
            : initialRoute === '/settings'
              ? ['/', '/settings']
              : [];
        for (const route of sequence) {
          const after = await page.evaluate(() => performance.now());
          await page
            .getByRole('navigation', { name: 'Main' })
            .getByTitle(labels[route], { exact: true })
            .click();
          await capture(page, trial, route, false, after);
          // Focus alone confirms the hydrated composer without changing any text.
          if (route === '/chat') await page.getByPlaceholder('Ask about your posts…').focus();
          if (route === '/calendar')
            await page.getByRole('button', { name: 'Today', exact: true }).click();
        }
      } finally {
        await Promise.all(responseWork);
        await context.close();
      }
    }
  }
} catch {
  stopped ??= 'marker_missing_or_timeout';
} finally {
  await browser.close();
}

const summaries = pageRoutes.flatMap((route) =>
  (['initial', 'first', 'repeat'] as const).map((category) => {
    const group = observations.filter((item) => item.route === route && item.category === category);
    return {
      route,
      category,
      n: group.length,
      feedbackMs: statistics(group.map((item) => item.feedbackMs)),
      usableMs: statistics(group.map((item) => item.usableMs)),
      preparationMs: statistics(
        group.map((item) => (item.event.kind === 'chat' ? null : item.event.server.durationMs)),
      ),
      databaseWallMs: statistics(
        group.map((item) =>
          item.event.kind === 'chat' ? null : (item.event.server.stages.database?.wallMs ?? 0),
        ),
      ),
      databaseQueryCount: statistics(
        group.map((item) =>
          item.event.kind === 'chat' ? null : (item.event.server.stages.database?.count ?? 0),
        ),
      ),
      requestCount: statistics(group.map((item) => item.requestCount)),
      encodedBodyBytes: statistics(
        group.map((item) =>
          item.resources.reduce((n, resource) => n + resource.encodedBodySize, 0),
        ),
      ),
    };
  }),
);
await mkdir(dirname(output), { recursive: true });
await writeFile(
  output,
  JSON.stringify(
    {
      status: stopped ? (observations.length ? 'partial' : 'blocked') : 'complete',
      stopped,
      capturedAt: new Date().toISOString(),
      identity: config.data,
      identitySource:
        'Operator-supplied verified platform metadata; this runner cannot inspect Vercel/Supabase configuration.',
      browser: browser.version(),
      viewport: { width: 1440, height: 900 },
      device: 'headless desktop Chromium in cloud container; CPU unthrottled',
      network:
        network === 'lab'
          ? { latencyMs: 100, downloadBytesPerSecond: 1250000, uploadBytesPerSecond: 125000 }
          : 'native cloud egress, unthrottled',
      proxyUsed: Boolean(proxyUrl),
      conditions:
        'Fresh browser context per initial load. First/repeat tabs share a session. Vercel/DB/OS cold state uncontrolled. Default prefetch and HTTP/router caches preserved. No screenshots, traces, console logs or response bodies captured.',
      observations,
      responses,
      summaries,
    },
    null,
    2,
  ) + '\n',
);
console.log(
  `Preview capture ${stopped ? 'incomplete' : 'complete'}: ${observations.length} observations. Artifact: ${output}`,
);
if (stopped) process.exitCode = 1;
