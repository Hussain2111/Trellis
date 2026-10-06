import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import postgres from 'postgres';

export const datasets = {
  small: { posts: 20, days: 90, threads: 10, messagesPerThread: 20, calendar: 90 },
  representative: { posts: 246, days: 696, threads: 80, messagesPerThread: 20, calendar: 365 },
} as const;
export type Dataset = keyof typeof datasets;
export const referenceTime = '2026-10-06T12:00:00.000Z';

export function localPostgresUrl(value: string): URL {
  const url = new URL(value);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  ) {
    throw new Error(
      'Benchmarks require a local PostgreSQL instance; remote databases are refused.',
    );
  }
  return url;
}

async function command(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(command, args, { cwd: process.cwd(), env, stdio: 'inherit' });
  await new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)),
    );
  });
}
export async function buildProduction() {
  await command('npm', ['run', 'build'], {
    ...process.env,
    TRELLIS_PERFORMANCE: '1',
    NEXT_PUBLIC_TRELLIS_PERFORMANCE: '1',
    NEXT_TELEMETRY_DISABLED: '1',
  });
}
export async function createFixture(dataset: Dataset) {
  const url = localPostgresUrl(
    process.env.BENCHMARK_POSTGRES_URL ?? 'postgres://postgres@127.0.0.1:5432/postgres',
  );
  url.pathname = '/postgres';
  const admin = postgres(url.toString(), { max: 1 });
  const database = `trellis_benchmark_${Date.now()}_${process.pid}`;
  // Always CREATE a fresh database. Never truncate, migrate, or reuse a supplied DB.
  try {
    await admin.unsafe(`CREATE DATABASE "${database}"`);
  } finally {
    await admin.end();
  }
  url.pathname = '/' + database;
  const databaseUrl = url.toString();
  await command('npm', ['run', 'db:migrate'], { ...process.env, DATABASE_URL: databaseUrl });
  const sql = postgres(databaseUrl, { max: 1 });
  const size = datasets[dataset];
  const [account] =
    await sql`INSERT INTO accounts(handle, followers_count, follows_count) VALUES ('synthetic_benchmark', 5000, 200) RETURNING id`;
  const accountId = account!.id;
  await sql`INSERT INTO posts(account_id, ig_media_id, shortcode, media_type, published_at)
    SELECT ${accountId}, 'benchmark-' || n, 'B' || n, 'image', ${referenceTime}::timestamptz - n * interval '1 day'
    FROM generate_series(1, ${size.posts}) n`;
  await sql`INSERT INTO post_insights(account_id, post_id, checkpoint, reach)
    SELECT ${accountId}, id, 'latest', 1000 + id FROM posts WHERE account_id = ${accountId}`;
  await sql`INSERT INTO account_daily(account_id, day, follower_count, followers_total, reach)
    SELECT ${accountId}, to_char(${referenceTime}::timestamptz - n * interval '1 day', 'YYYY-MM-DD'), 2, 5000 - n, 1000
    FROM generate_series(0, ${size.days - 1}) n`;
  await sql`INSERT INTO chat_threads(account_id, title, updated_at)
    SELECT ${accountId}, 'Synthetic thread ' || n, ${referenceTime}::timestamptz - n * interval '1 second'
    FROM generate_series(0, ${size.threads - 1}) n`;
  await sql`INSERT INTO chat_messages(thread_id, role, content, created_at)
    SELECT t.id, CASE WHEN n % 2 = 0 THEN 'user' ELSE 'assistant' END,
    'Synthetic benchmark message. No real account or conversation data.',
    ${referenceTime}::timestamptz - (${size.messagesPerThread} - n) * interval '1 minute'
    FROM chat_threads t CROSS JOIN generate_series(1, ${size.messagesPerThread}) n`;
  await sql`INSERT INTO calendar_entries(account_id, scheduled_for, title, format)
    SELECT ${accountId}, ${referenceTime}::timestamptz + (n - 30) * interval '1 day', 'Synthetic calendar entry', 'image'
    FROM generate_series(0, ${size.calendar - 1}) n`;
  await sql.end();
  return { database, databaseUrl, dataset, size };
}

export async function startServer(databaseUrl: string, port: number) {
  const records: unknown[] = [];
  // Child processes get only runtime prerequisites and the disposable connection.
  // No production provider keys, Instagram token, or cron secret are propagated.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
    DATABASE_URL: databaseUrl,
    TRELLIS_PERFORMANCE: '1',
  };
  const child = spawn(
    'npm',
    ['run', 'start', '--', '--hostname', '127.0.0.1', '--port', String(port)],
    {
      cwd: process.cwd(),
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let buffer = '';
  child.stdout!.on('data', (chunk) => {
    buffer += String(chunk);
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const at = line.indexOf('[performance] ');
      if (at < 0) continue;
      try {
        records.push(JSON.parse(line.slice(at + '[performance] '.length)));
      } catch {
        /* incomplete metadata is omitted */
      }
    }
  });
  child.stderr!.resume(); // Never save raw application error output.
  const start = Date.now();
  while (true) {
    if (child.exitCode !== null) throw new Error('Production server exited before readiness.');
    const listening = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (listening) break;
    if (Date.now() - start > 30_000) {
      await stopServer(child);
      throw new Error('Production server did not start within 30 seconds.');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { child, records, baseURL: `http://127.0.0.1:${port}` };
}
export async function stopServer(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return;
  // Kill the process group we created, including Next's child server.
  process.kill(-child.pid, 'SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (child.exitCode === null) process.kill(-child.pid, 'SIGKILL');
}
