import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';
import { localPostgresUrl } from '../../scripts/benchmark/fixture';

const connection = process.env.BENCHMARK_DATABASE_URL;
if (!connection || !/^\/trellis_benchmark_\d+_\d+$/.test(localPostgresUrl(connection).pathname)) {
  throw new Error('Browser deletion tests require a database created by the benchmark fixture.');
}
const sql = postgres(connection);
let ids: number[] = [];
const row = (page: Page, id: number) =>
  page
    .locator('aside')
    .locator('li')
    .filter({ has: page.locator(`a[href="/chat?thread=${id}"]`) });
async function remove(page: Page, index: number) {
  await page
    .locator('aside')
    .getByRole('button', { name: `Delete Deletion fixture ${index}`, exact: true })
    .click();
  await page.locator('aside').getByRole('button', { name: 'Delete', exact: true }).click();
}
test.beforeEach(async ({ page }) => {
  for (let index = 0; index < 3; index++) {
    const [thread] = await sql`INSERT INTO chat_threads(account_id, title, updated_at)
      SELECT id, ${'Deletion fixture ' + index}, now() + interval '1 hour' FROM accounts LIMIT 1 RETURNING id`;
    ids.push(Number(thread!.id));
  }
  await page.goto('/chat?thread=' + ids[0]);
  await expect(page.getByPlaceholder('Ask about your posts…')).toBeEnabled();
});
test.afterEach(async () => {
  await sql`DELETE FROM chat_threads WHERE id IN ${sql(ids)}`;
  ids = [];
});
test.afterAll(async () => {
  await sql.end();
});

test('500 restores the active row, shows an error, and permits retry without premature navigation', async ({
  page,
}) => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/chat/threads/${ids[0]}`, async (route) => {
    await blocked;
    await route.fulfill({ status: 500, body: 'server failed', contentType: 'text/plain' });
  });
  await remove(page, 0);
  await expect(row(page, ids[0]!)).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp('thread=' + ids[0] + '$'));
  await expect(page.getByPlaceholder('Ask about your posts…')).toBeEnabled();
  release();
  await expect(row(page, ids[0]!)).toBeVisible();
  await expect(row(page, ids[0]!).getByRole('alert')).toContainText('server error 500');
  await expect(page).toHaveURL(new RegExp('thread=' + ids[0] + '$'));
  await page.unroute(`**/api/chat/threads/${ids[0]}`);
  await remove(page, 0);
  await expect(page).toHaveURL(/\/chat$/);
  const rows = await sql`SELECT id FROM chat_threads WHERE id = ${ids[0]!}`;
  expect(rows).toHaveLength(0);
});

test('network failure restores an inactive row and keeps the selected conversation', async ({
  page,
}) => {
  await page.route(`**/api/chat/threads/${ids[1]}`, (route) => route.abort('failed'));
  await remove(page, 1);
  await expect(row(page, ids[1]!)).toBeVisible();
  await expect(row(page, ids[1]!).getByRole('alert')).toContainText('Could not reach the server');
  await expect(page).toHaveURL(new RegExp('thread=' + ids[0] + '$'));
});

test('a successful inactive deletion refreshes summaries without changing selection', async ({
  page,
}) => {
  await remove(page, 1);
  await expect(row(page, ids[1]!)).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp('thread=' + ids[0] + '$'));
  await expect
    .poll(async () => (await sql`SELECT id FROM chat_threads WHERE id = ${ids[1]!}`).length)
    .toBe(0);
  await page.reload();
  await expect(row(page, ids[1]!)).toHaveCount(0);
});

test('an earlier failed delete cannot restore another successfully deleted row', async ({
  page,
}) => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/chat/threads/${ids[1]}`, async (route) => {
    await blocked;
    await route.fulfill({ status: 503, body: '{}' });
  });
  await remove(page, 1);
  await expect(row(page, ids[1]!)).toHaveCount(0);
  await remove(page, 2);
  await expect
    .poll(async () => (await sql`SELECT id FROM chat_threads WHERE id = ${ids[2]!}`).length)
    .toBe(0);
  release();
  await expect(row(page, ids[1]!)).toBeVisible();
  await expect(row(page, ids[1]!).getByRole('alert')).toContainText('503');
  await expect(row(page, ids[2]!)).toHaveCount(0);
});

test('completion of an old active deletion does not navigate away from a newly selected thread', async ({
  page,
}) => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/chat/threads/${ids[0]}`, async (route) => {
    await blocked;
    await route.continue();
  });
  await remove(page, 0);
  await row(page, ids[1]!).getByRole('link').click();
  await expect(page).toHaveURL(new RegExp('thread=' + ids[1] + '$'));
  await expect(page.getByPlaceholder('Ask about your posts…')).toBeEnabled();
  release();
  await expect
    .poll(async () => (await sql`SELECT id FROM chat_threads WHERE id = ${ids[0]!}`).length)
    .toBe(0);
  await expect(page).toHaveURL(new RegExp('thread=' + ids[1] + '$'));
});

test('an unmounted sidebar cannot redirect a different main tab when deletion completes', async ({
  page,
}) => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/chat/threads/${ids[0]}`, async (route) => {
    await blocked;
    await route.continue();
  });
  await remove(page, 0);
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByTitle('Calendar', { exact: true })
    .click();
  await expect(page.getByRole('button', { name: 'Today', exact: true })).toBeEnabled();
  release();
  await expect
    .poll(async () => (await sql`SELECT id FROM chat_threads WHERE id = ${ids[0]!}`).length)
    .toBe(0);
  await page.waitForLoadState('networkidle');
  await expect(page).toHaveURL(/\/calendar$/);
});

test('main-tab measurements separate first/repeat visits and contain only metadata', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('[data-performance-ready="/"]')).toHaveCount(1);
  let completed = 0;
  for (const name of ['Calendar', 'Chat', 'Calendar']) {
    await page.getByRole('navigation', { name: 'Main' }).getByTitle(name, { exact: true }).click();
    await expect(page.locator(`[data-performance-ready="/${name.toLowerCase()}"]`)).toHaveCount(1);
    completed += 1;
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.__trellisPerformance?.filter((event) => event.kind === 'navigation').length ?? 0,
        ),
      )
      .toBe(completed);
  }
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__trellisPerformance?.filter((event) => event.kind === 'navigation').length ?? 0,
      ),
    )
    .toBe(3);
  const events = await page.evaluate(() =>
    window.__trellisPerformance?.filter((event) => event.kind === 'navigation'),
  );
  expect(events!.map((event) => event.visit)).toEqual(['first', 'first', 'repeat']);
  for (const event of events!) {
    expect(event.clickToUsableMs).toBeGreaterThanOrEqual(event.clickToFeedbackMs);
    expect(event.server.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(event.server.stages.database!.count).toBeGreaterThan(0);
  }
  expect(JSON.stringify(events)).not.toMatch(
    /Synthetic benchmark message|Deletion fixture|postgres:\/\//,
  );
});
