import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  test: {
    include: ['tests/**/*.test.ts'],
    /**
     * Load `.env` before any test imports `lib/env.ts`.
     *
     * Without this, `DATABASE_URL` falls through to the schema default in
     * lib/env.ts and the DB-backed tests silently run against whatever
     * database happens to be at that address — which, on a machine that has
     * ever run a different project, is a real database with a real schema that
     * is not this one. The failure mode is tests that pass or fail for reasons
     * having nothing to do with the code under test.
     *
     * dotenv does not override variables already set, so CI keeps the
     * DATABASE_URL it exports and only local runs read the file.
     */
    // Order matters: dotenv first so DATABASE_URL is populated, then the
    // guard, which refuses to let a truncating test suite touch a non-local
    // database.
    setupFiles: ['dotenv/config', './tests/guard.setup.ts'],
    /**
     * Several test files share one real database — there is no per-file
     * sandbox — so parallel files let one file's cleanup race another's
     * assertions.
     */
    fileParallelism: false,
  },
});
