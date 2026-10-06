import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../env';
import * as schema from './schema';
import { instrumentSql } from '../performance/database';

/**
 * A small pool, created lazily and reused across invocations within a warm
 * function. `prepare: false` is required by Supabase's transaction-mode pooler
 * — prepared statements cannot survive a connection being handed to another
 * transaction between statements.
 *
 * `max` is not 1, and that was not a free choice. With a single connection,
 * postgres-js queues every query behind the one in front of it, so a page that
 * fires five independent queries through `Promise.all` still pays five round
 * trips end to end. Against a pooler on the other side of the internet that is
 * the difference between a page that feels instant and one that takes a
 * noticeable second. A handful of connections lets independent work actually be
 * independent; it stays small because Supabase's pooler is a shared resource
 * and this app serves one person.
 */
const POOL_SIZE = 5;

let sql: ReturnType<typeof postgres> | null = null;
let database: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function db() {
  if (!database) {
    sql = postgres(env().DATABASE_URL, {
      prepare: false,
      max: POOL_SIZE,
      // A serverless function is frozen between invocations; a connection left
      // open forever is one the pooler is holding for nobody.
      idle_timeout: 20,
      connect_timeout: 10,
    });
    database = drizzle(process.env.TRELLIS_PERFORMANCE === '1' ? instrumentSql(sql) : sql, {
      schema,
    });
  }
  return database;
}

/** Only for scripts and tests — a serverless function should never call this. */
export async function closeDb(): Promise<void> {
  await sql?.end({ timeout: 5 });
  sql = null;
  database = null;
}
