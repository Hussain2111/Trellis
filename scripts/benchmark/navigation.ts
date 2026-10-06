import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import {
  buildProduction,
  createFixture,
  datasets,
  referenceTime,
  startServer,
  stopServer,
  type Dataset,
} from './fixture';

const option = (name: string, fallback: string) =>
  process.argv.find((arg) => arg.startsWith(name + '='))?.split('=')[1] ?? fallback;
const dataset = option('--dataset', 'representative') as Dataset;
if (!(dataset in datasets)) throw new Error('Unknown dataset');
const trials = Number(option('--trials', '5'));
if (!Number.isInteger(trials) || trials < 1 || trials > 30)
  throw new Error('Trials must be between 1 and 30');
const device = option('--device', 'desktop');
const network = option('--network', 'lab');
if (!['desktop', 'mobile'].includes(device) || !['local', 'lab'].includes(network))
  throw new Error('Unknown device or network');
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
if (!process.argv.includes('--skip-build')) await buildProduction();
const fixture = await createFixture(dataset);
const browser = await chromium.launch({ executablePath, headless: true });
const result: Record<string, unknown> = {
  baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  trackedWorkingTreeChanged:
    execFileSync('git', ['diff', '--stat'], { encoding: 'utf8' }).trim().length > 0,
  build: 'next build + next start',
  browser: browser.version(),
  device,
  viewport: device === 'desktop' ? { width: 1440, height: 900 } : { width: 390, height: 844 },
  network:
    network === 'lab'
      ? { latencyMs: 100, downloadBytesPerSecond: 1250000, uploadBytesPerSecond: 125000 }
      : 'loopback, unthrottled',
  cpu: 'unthrottled shared cloud container',
  region: 'local cloud container; app and database co-located; not a deployed preview',
  referenceTime,
  dataset: fixture.size,
  totalMessages: fixture.size.threads * fixture.size.messagesPerThread,
  conditions:
    'fresh browser context and restarted app per trial; PostgreSQL process/page cache retained; first route visits may already be prefetched; second cycle repeats routes with existing browser/router caches',
};
const navigations: unknown[] = [];
const initialLoads: unknown[] = [];
const serverRecords: unknown[] = [];
try {
  for (let trial = 1; trial <= trials; trial++) {
    const server = await startServer(fixture.databaseUrl, 3100);
    const context = await browser.newContext({
      viewport: result.viewport as { width: number; height: number },
      isMobile: device === 'mobile',
      hasTouch: device === 'mobile',
      timezoneId: 'Asia/Riyadh',
    });
    try {
      const page = await context.newPage();
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
      await page.goto(server.baseURL);
      await page.waitForFunction(
        () => window.__trellisPerformance?.some((event) => event.kind === 'initial'),
        undefined,
        { timeout: 30_000 },
      );
      initialLoads.push({
        trial,
        timing: await page.evaluate(() => {
          const timing = performance.getEntriesByType(
            'navigation',
          )[0] as PerformanceNavigationTiming;
          return {
            responseMs: timing.responseEnd - timing.requestStart,
            ttfbMs: timing.responseStart - timing.requestStart,
            domContentLoadedMs: timing.domContentLoadedEventEnd,
            encodedBodySize: timing.encodedBodySize,
            server: window.__trellisPerformance?.find((event) => event.kind === 'initial'),
          };
        }),
      });
      await page.waitForLoadState('networkidle');
      for (let cycle = 1; cycle <= 2; cycle++) {
        for (const [label, route] of [
          ['Calendar', '/calendar'],
          ['Chat', '/chat'],
          ['Calendar', '/calendar'],
        ] as const) {
          const since = await page.evaluate(() => performance.now());
          await page
            .getByRole('navigation', { name: 'Main' })
            .getByTitle(label, { exact: true })
            .click();
          await page.waitForFunction(
            ({ route, since }) =>
              window.__trellisPerformance?.some(
                (event) =>
                  event.kind === 'navigation' &&
                  event.route === route &&
                  performance
                    .getEntriesByName('trellis.navigation.click')
                    .some((mark) => mark.startTime >= since),
              ),
            { route, since },
            { timeout: 30_000 },
          );
          // Confirm the current event rather than an earlier visit to the same route.
          await page.waitForFunction((route) => {
            const events = window.__trellisPerformance ?? [];
            const last = events[events.length - 1];
            return last?.kind === 'navigation' && last.route === route;
          }, route);
          if (route === '/calendar')
            await page.getByRole('button', { name: 'Today', exact: true }).click();
          else await page.getByPlaceholder('Ask about your posts…').fill(''); // check hydrated composer, no submission
          await page.waitForLoadState('networkidle');
          navigations.push({
            trial,
            cycle,
            ...(await page.evaluate(
              ({ since }) => {
                const events = window.__trellisPerformance ?? [];
                const event = events[events.length - 1];
                const requests = (
                  performance.getEntriesByType('resource') as PerformanceResourceTiming[]
                )
                  .filter((entry) => entry.startTime >= since)
                  .map((entry) => {
                    const path = new URL(entry.name).pathname;
                    return {
                      route: path.startsWith('/_next/')
                        ? '/_next/asset'
                        : path.replace(/\/\d+(?=\/|$)/g, '/[id]'),
                      ttfbMs: entry.responseStart - entry.requestStart,
                      responseMs: entry.responseEnd - entry.requestStart,
                      encodedBodySize: entry.encodedBodySize,
                      transferSize: entry.transferSize,
                    };
                  });
                return { event, requestCount: requests.length, requests };
              },
              { since },
            )),
          });
        }
        if (cycle === 1) {
          await page
            .getByRole('navigation', { name: 'Main' })
            .getByTitle('Dashboard', { exact: true })
            .click();
          await page.waitForFunction(() => {
            const events = window.__trellisPerformance ?? [];
            const last = events[events.length - 1];
            return last?.kind === 'navigation' && last.route === '/';
          });
          await page.waitForLoadState('networkidle');
        }
      }
    } finally {
      await context.close();
      await stopServer(server.child);
      serverRecords.push(...server.records);
    }
  }
} finally {
  await browser.close();
}
const output = option('--output', `benchmark-results/${dataset}-${device}-${network}.json`);
await mkdir(output.slice(0, output.lastIndexOf('/')) || '.', { recursive: true });
await writeFile(
  output,
  JSON.stringify({ ...result, initialLoads, navigations, serverRecords }, null, 2) + '\n',
);
console.log(
  `Recorded ${navigations.length} browser navigations in ${output}; disposable database retained: ${fixture.database}`,
);
