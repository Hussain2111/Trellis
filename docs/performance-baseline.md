# Performance baseline and deletion correctness (SD-01 / SD-02)

This is a navigation baseline for subsequent work. It adds opt-in measurements and corrects failed thread deletion. It does not claim a performance speedup or enable caching, a new conversation flow, or retention deletion.

## Reproduce

Use Node 22 or newer, an installed Chromium browser, and a **local** PostgreSQL instance whose role can create databases. Run from the repository root:

```sh
npm ci
# On the prepared Codex environment:
bash /workspace/.trellis/start-db.sh

PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run benchmark:navigation -- \
  --dataset=representative --device=desktop --network=lab --trials=5
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run benchmark:navigation -- \
  --skip-build --dataset=small --device=desktop --network=lab --trials=5
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run benchmark:navigation -- \
  --skip-build --dataset=representative --device=mobile --network=lab --trials=5

PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:browser -- --skip-build
```

If using Playwright's bundled browser instead, install it with `npx playwright install chromium` and omit `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. The first benchmark command builds with both instrumentation flags and uses `next start`; `--skip-build` is only valid with that unchanged, instrumented production build. Stop development servers for this checkout before building.

The harness creates a new `trellis_benchmark_<timestamp>_<pid>` database for each run, applies the repository migrations, and inserts entirely synthetic fixtures. It never reuses or truncates an existing database. `BENCHMARK_POSTGRES_URL` can select another local PostgreSQL instance; remote hosts and non-Postgres schemes are rejected before DB work. Browser deletion tests also require the generated database-name prefix. Ports 3100/3101 must be free: the harness refuses occupied ports and waits for its own production server's readiness before accessing the app. Only its own process group is stopped. Databases remain available for inspection; this is not a conversation-retention job.

## Measurement boundaries

Enable server measurements with `TRELLIS_PERFORMANCE=1` at runtime and browser measurements with `NEXT_PUBLIC_TRELLIS_PERFORMANCE=1` **at build time**. Both are off by default.

- Main-tab clicks start a browser mark. The existing pending indicator or loading skeleton supplies feedback. Page readiness is recorded after the page's client effect and two animation frames; the harness also interacts with Today/the chat input to check hydration. These are native browser-clock timings and a rendering-opportunity approximation to painted feedback/usability, not a screenshot-based measurement of the first changed pixel or field INP.
- First/repeat means first/completed visit to that route in the current browser context. First visits can use Next's existing prefetching. A UUID correlates the ready marker with server metadata. `serverRequestFresh` distinguishes a newly observed server request from reused metadata; it does not establish that a request started after the click.
- Page `durationMs` measures account lookup, database reads, and page-data preparation, ending when the page returns its React tree. It excludes Next's subsequent rendering/serialization and delivery. API `durationMs` covers the complete handler through response construction, including preflight and final ledger persistence, and is exposed in `Server-Timing` with `x-trellis-request-id`.
- Database timings measure consumption of the lazy postgres-js queries used by Drizzle, including pool/connection/network wait and driver decoding, not database-only execution time. Records include query ordinals, offsets, duration, and failure, capped at 100 individual samples. Counts and aggregates remain complete and `queryTimingsTruncated` identifies any cap. SQL, parameters and rows are never recorded. Transaction control statements internal to the driver are excluded.
- Stage `totalMs` sums individual operations; `wallMs` measures the union of overlapping intervals. Do not add concurrent query/tool times as wall latency, or add DB time again to tools that already include those queries.
- Chat uses the SDK's provider-call start/end callbacks and tool-execution callbacks. Metadata separates preflight, model calls, tools, validation and persistence; `otherRequestMs` excludes the union of model/tool intervals. Failed model calls are closed on the error path. History-message and token counts are recorded; prompts, messages, tool arguments/results, provider errors and credentials are excluded. Existing reasoning, quota, validation and model-run accounting are preserved.
- Browser chat metadata separates submit-to-feedback, buffered JSON response/parse completion, and the subsequent rendering opportunity. The same UUID links it to the handler. No live provider latency was benchmarked: credentials were neither required nor propagated to the fixture app. Deterministic SDK model/tool tests validate these timing boundaries and preserve request accounting.
- The benchmark records native Navigation/Resource Timing response and payload-size fields, post-click resource counts, and server records. It waits for network idle after capturing the usability mark to include trailing alert requests; that wait is not part of click-to-usable. Requests already started by prefetch before the click are excluded from that count. Zero transferred bytes alone is not treated as proof of a cache hit.

Browser metadata lives in a bounded 200-event in-memory array (`window.__trellisPerformance`) and `trellis:performance` events; it is not persisted or sent to an analytics service. Server records use the `[performance]` prefix and allowlisted metadata. Benchmark JSON contains no DOM snapshots, URLs with search parameters, messages, credentials, raw HTTP bodies, SQL, or raw server error logs. Browser-runner screenshots, videos and traces are disabled.

## Conditions and limits

Recorded on 6 October 2026 against local production builds, using Chromium 151.0.7922.173 on Debian 13, Node 24.19.0, PostgreSQL 17.11, and Playwright 1.62.1. The app and database were co-located in the cloud container (5 available CPUs); no Vercel/Supabase deployment or region was tested.

Desktop viewport: 1440×900. Mobile-sized Chromium viewport: 390×844 with touch/mobile emulation; this is not a physical phone and CPU was not throttled. Both profiles use automated clicks; mobile touch hardware latency is not measured. The lab profile uses CDP network emulation: 100 ms configured latency, 1,250,000 bytes/s download and 125,000 bytes/s upload (10/1 Mbps). `--network=local` provides an unthrottled comparison. Raw artifacts record these settings, the source commit and working-tree state.

Each profile has five trials. Each trial restarts the app and creates a fresh browser context, loads Dashboard, then runs Calendar → Chat → Calendar, returns to Dashboard, and repeats that sequence. PostgreSQL's process/page cache and Chromium's process remain warm. Only the initial Dashboard request is cold with respect to the app process; subsequent first route visits run in that now-warm process. No DB/OS cache flush is claimed. Browser and server clocks are untouched. Fixtures are generated deterministically relative to UTC noon of the run date, recorded as `referenceTime`; compare runs on the same date/time conditions because calendar and alert states are time-dependent.

| Dataset        | Accounts | Posts / latest readings | Account days | Threads / messages | Calendar entries | Insight batches / cards |
| -------------- | -------: | ----------------------: | -----------: | -----------------: | ---------------: | ----------------------: |
| Small          |        1 |                 20 / 20 |           90 |           10 / 200 |               90 |                   1 / 4 |
| Representative |        1 |               246 / 246 |          696 |         80 / 1,600 |              365 |                   1 / 4 |

The chat landing lists at most 50 summaries and loads the newest thread's 20 messages. Calendar still loads all saved entries. Account-ID caching and alert-promise sharing are the existing mechanisms; this task does not change their policy.

## Validation

The instrumented production build and browser regression suite pass. Tests cover HTTP 500, network failure, retry, active/inactive deletion, independent rollback of concurrent requests, selection changes, and unmounting before completion. The successful deletion refreshes summaries; navigation happens only after a successful response and only if the deleted thread is still active.

The normal build/type/lint/format checks and 186 unit/database tests pass. Run destructive suites only against the disposable local database:

```sh
npm run verify
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/trellis_test npm run db:migrate
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/trellis_test npm test -- --testTimeout=30000
```

The cloud storage needs the 30-second timeout for the existing DB-heavy sync-loop test. It changes no assertion and no test configuration. Driver integration tests verify lazy execution, results, rejection and transactions; metadata tests verify privacy, scope isolation, overlap accounting, and refusal to attach a benchmark to another listener.

## Measured results

Source commit: `1f7e659b982e0cbba8c495c6511c946a9a9837c2` (clean tracked tree at capture). There was no deployment SHA because these are local production builds. Raw metadata artifacts are in ignored `benchmark-results/*.json`; rerun the commands above to regenerate them. The table reports native browser observations from 90 primary navigations, not inferred timings.

Median / p95 are in milliseconds. p95 uses nearest rank; with 5 or 15 samples here it is the sample maximum, with substantial uncertainty. First and repeat visits are never pooled.

| Profile / dataset             | Route / visit      |   n | Feedback median / p95 | Usable median / p95 | Prep median | DB wall median | RSC response median |
| ----------------------------- | ------------------ | --: | --------------------: | ------------------: | ----------: | -------------: | ------------------: |
| Desktop / representative      | /calendar / first  |   5 |           37.3 / 38.6 |       338.1 / 359.0 |        25.3 |           14.2 |               106.1 |
| Desktop / representative      | /calendar / repeat |  15 |           42.4 / 56.6 |       342.2 / 358.7 |        10.0 |            4.9 |               105.4 |
| Desktop / representative      | /chat / first      |   5 |           42.5 / 43.4 |       343.1 / 343.4 |        12.8 |           10.0 |               105.6 |
| Desktop / representative      | /chat / repeat     |   5 |           43.6 / 45.0 |       343.9 / 344.9 |         6.4 |            5.2 |               105.4 |
| Mobile-sized / representative | /calendar / first  |   5 |           38.6 / 43.5 |       350.6 / 360.3 |        34.7 |           22.9 |               105.4 |
| Mobile-sized / representative | /calendar / repeat |  15 |           44.1 / 48.6 |       343.5 / 353.1 |        10.7 |            4.5 |               105.7 |
| Mobile-sized / representative | /chat / first      |   5 |           45.6 / 47.9 |       344.2 / 345.4 |         9.9 |            6.7 |               105.0 |
| Mobile-sized / representative | /chat / repeat     |   5 |           44.7 / 45.2 |       344.8 / 345.2 |         7.0 |            4.6 |               105.5 |
| Desktop / small               | /calendar / first  |   5 |           40.6 / 53.7 |       339.6 / 340.7 |        25.9 |           20.5 |               105.5 |
| Desktop / small               | /calendar / repeat |  15 |           43.0 / 44.7 |       342.6 / 492.3 |         5.8 |            3.7 |               105.2 |
| Desktop / small               | /chat / first      |   5 |           42.7 / 56.3 |       344.8 / 358.1 |        10.1 |            7.5 |               105.0 |
| Desktop / small               | /chat / repeat     |   5 |           42.4 / 46.9 |       343.0 / 345.0 |        12.3 |           10.4 |               105.3 |

Initial Dashboard loads are kept separate from click navigation:

| Profile / dataset             |   n | Response median (ms) | Preparation median (ms) | Encoded HTML median (bytes) |
| ----------------------------- | --: | -------------------: | ----------------------: | --------------------------: |
| Desktop / representative      |   5 |                528.0 |                   146.3 |                        7078 |
| Mobile-sized / representative |   5 |                544.4 |                   143.9 |                        7079 |
| Desktop / small               |   5 |                561.0 |                   168.5 |                        7072 |

Every primary navigation produced a newly observed page request ID. Calendar made 1 data query on each first/repeat navigation; Chat made 2 (summaries and selected history). The existing account-ID cache hit on these visits. Post-click resource counts were 3 on first visits (page RSC, alerts, route JS) and 2 on repeats (page RSC and alerts). The intermediate return to Dashboard is excluded from the primary-sequence table.

These observations identify useful boundaries, not a cause: browser usability often takes substantially longer than the local preparation and response timings. Investigate rendering/scheduling, loading transitions, hydration and the network profile before attributing that difference to SQL or choosing a cache. Measurements include instrumentation overhead. No speedup or field-latency guarantee is claimed; rerun against a production-build preview with the same fixtures and actual deployment region before making a Vercel/Supabase claim.
