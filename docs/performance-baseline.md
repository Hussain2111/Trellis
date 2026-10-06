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

## Deployed preview validation — 6 October 2026

**Blocked by preview authentication and unavailable platform connections. No deployed app timing was collected.** This section records access evidence separately from the local production-build baseline above. The reviewable [sanitized access artifact](performance-artifacts/deployed-preview-access-2026-10-06.json) contains the request outcomes and a twelve-cell route/visit matrix with `n: 0` and null medians/p95s; redirects are not counted as app observations.

### Observed facts

PR #4 was open and draft, with latest remote head `3a344e528f61e8a8a8c239f2352ee71570cfd191`, at the access check. `git fetch` confirmed that SHA. GitHub's Vercel integration lists two projects for the PR; the requested **`trellis_v2`** has project ID `prj_d51kAzxIDY6jAqRv3UL9qd8ohPS3`. Its inspection link is [the `trellis_v2` deployment](https://vercel.com/hussain-9c72/trellis_v2/5Cbrf6XcJdpzzzyFoYpwgmLB32NT), and GitHub deployment record `6889782123` associates that SHA with the `Preview` environment and immutable URL:

`https://trellisv2-cjekr1a5x-hussain-9c72.vercel.app/`

The PR's branch alias is `https://trellisv2-git-sd-01-performance-thread-deletion-hussain-9c72.vercel.app/`. Both URLs returned **HTTP 302 to `vercel.com/sso-api`** on the final access probes. No redirect query, cookie, HTTP body, or sign-in token was saved. Initial attempts failed at the cloud egress proxy with `CONNECT 403`; after the exact two preview hosts were added to the network draft, connectivity was observed. Publication of that environment draft was not verified.

These deployment identities come from GitHub's Vercel integration, not an authenticated Vercel deployment API inspection. The Vercel and Supabase plugin references exposed no callable tools in this task; neither service had an available process credential or CLI authentication file. After their API hosts became reachable, the read-only Vercel project request returned HTTP 403 and Supabase's projects request returned HTTP 401; neither response body was recorded. No authenticated preview browser state was available. GitHub access works and does not imply access to either service.

| Required condition                                    | Verified value / status                                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Source SHA at access check                            | `3a344e528f61e8a8a8c239f2352ee71570cfd191`                                                                               |
| Requested Vercel project                              | `trellis_v2`, from GitHub integration metadata                                                                           |
| Preview URL / environment                             | Immutable URL above / `Preview`, from GitHub deployment metadata                                                         |
| Function region                                       | Unknown; no deployment configuration inspected. An edge/request region would not establish the function region.          |
| Connected Supabase project and database region        | Unknown. The user-supplied name `Trellis` has not been verified against the preview's actual connection.                 |
| Dataset and selected-history size                     | Unknown; no Supabase query was run.                                                                                      |
| Server/browser performance flags and prior settings   | Unknown; neither flag was inspected or changed. No restoration was needed.                                               |
| Measured browser, device, network and cold/warm state | Unmeasured. The access probes used Python urllib through the configured HTTPS proxy, not a browser navigation benchmark. |

| Route                | Initial / first tab / repeat samples | Feedback median / p95 | Usable median / p95 |
| -------------------- | ------------------------------------ | --------------------- | ------------------- |
| Dashboard `/`        | 0 / 0 / 0                            | Unmeasured            | Unmeasured          |
| Calendar `/calendar` | 0 / 0 / 0                            | Unmeasured            | Unmeasured          |
| Chat `/chat`         | 0 / 0 / 0                            | Unmeasured            | Unmeasured          |
| Settings `/settings` | 0 / 0 / 0                            | Unmeasured            | Unmeasured          |

No live prompts or provider calls were made, no test threads were created, and no conversations were deleted or modified. Success, failure recovery, and delayed-delete races have **not** been verified on this deployed preview. The earlier local deletion tests remain local results.

### Resume capture after access is available

1. Enable authenticated Vercel and Supabase connections for this chat, with access to `trellis_v2` configuration, deployments and runtime logs, and `Trellis` project metadata and aggregate counts. If callable connections remain unavailable, optional secure `VERCEL_TOKEN` and `SUPABASE_ACCESS_TOKEN` requirements have been saved in the cloud environment draft, restricted to `api.vercel.com` and `api.supabase.com`; enter values through environment settings, not chat. Only requirement names/destinations were saved, not credential values. Supply an authorized preview browser session through a private storage-state file outside the repository if protection remains enabled. Do not paste credentials or bypass tokens into chat or committed files; do not disable production protection.
2. Recheck PR #4's latest SHA. Inspect the actual Vercel project/deployment target and configured function regions. Inspect its existing database binding privately, match the project reference with the authenticated Supabase project metadata, and record only project reference, database region and aggregate dataset counts. Do not export the connection string, credentials, SQL parameters, database response rows or user messages. Counts must describe the app's active account, including its thread/message sizes. The navigation runner requires an existing account with at least one thread because `/chat` otherwise implicitly creates one.
3. Record both performance flags' prior presence, value, target and branch scope privately. Set `TRELLIS_PERFORMANCE=1` and `NEXT_PUBLIC_TRELLIS_PERFORMANCE=1` for this PR's **Preview** scope only, leaving other variables and production settings alone. Rebuild the verified latest SHA: the `NEXT_PUBLIC_` flag is inlined at build time. Verify the resulting deployment's SHA, environment, URL, function regions and actual database binding before collecting observations. A successful status on the older preview does not verify an instrumented rebuild.
4. Prepare a metadata-only JSON manifest for the runner, as described below, then capture navigation. Keep instrumentation overhead and the existing prefetch/cache policies in the conditions. Server/DB cold state cannot be forced or inferred from a fresh browser; label it uncontrolled unless platform evidence establishes otherwise.
5. For chat, create a small, explicitly named test conversation and keep a private ownership ledger of its new ID. Name only that newly created thread using the existing title helper or an equivalent scoped update; the public creation API does not accept a title. Use at most two harmless submissions, check remaining provider allowance first, and stop on quota/access failure. A submission can cause multiple model calls and failed calls consume quota; do not retry automatically or alter limits. Capture only allowlisted browser chat metadata and matching `[performance]` server records through `browserRecord`/`serverRecord` in `scripts/benchmark/preview-metadata.ts`. Record submit-to-feedback/response/visible times, preflight/model/tool/validation/persistence, history counts, token counts, status and call counts. `Server-Timing` alone does not include history/token/query counts; authenticated runtime logs are still required. Do not capture message bodies, provider errors, tool arguments/results, HAR, traces, screenshots or console logs.
6. For deletion, create disposable threads and keep every newly returned ID in that private ledger. Use exact browser interception of a ledger-owned DELETE URL to simulate HTTP 500 and network failure without forwarding either failed request. Confirm optimistic hiding, restoration, a visible error and unchanged selection, then remove interception and retry against the preview. For success races, delay forwarding a DELETE for a test-owned active thread; switch to another test thread or leave Chat before releasing it. Verify the successful response cannot redirect the changed selection/page. Confirm persisted deletion by checking only the owned ID's existence, without exporting rows. Never intercept unrelated calls or modify existing user threads. Remove only ledger-owned remaining test threads; preserve quota/accounting records.
7. Restore each flag's exact previous presence/value/scope even if capture fails. Because the browser flag is compiled into the bundle, build a replacement Preview with the restored settings and verify the branch alias and disabled/restored behavior. Remove the measurement deployment if necessary to prevent an instrumented immutable URL remaining accessible. Record restoration evidence, sanitized measurements, summaries, limits and checks in this section and keep PR #4 draft. Do not merge, promote or deploy to production.

### Prepared navigation runner (not deployed results)

`npm run benchmark:preview` is a separate runner from the disposable local fixture harness. It imports no database client, applies no migrations, creates no fixtures, submits no prompts and deletes no threads. It accepts only an immutable `trellisv2-…-hussain-9c72.vercel.app` HTTPS URL without credentials/search/hash, and requires complete, operator-verified platform/dataset metadata before opening the browser. It cannot authenticate or verify Vercel/Supabase configuration itself.

The manifest's required fields are `deploymentUrl`, `environment` (must be `preview`), `commit` (full SHA), `deploymentId`, `projectName`, `projectId`, `appRegions`, `supabaseProjectRef`, `databaseRegion`, and `dataset` with numeric `accounts`, `posts`, `accountDays`, `threads`, `messages`, `calendarEntries`, `insightBatches`, `insightCards`. Get these from the verified deployment/project/aggregate reads; missing values deliberately prevent a run. An immutable hostname alone does not prove a deployment is Preview: verify the platform target before populating the manifest. Keep credentials out of the manifest. If needed, `TRELLIS_PREVIEW_STORAGE_STATE` points to a private authentication file outside the repository; its contents are never included in artifacts.

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run benchmark:preview -- \
  --config=/tmp/trellis-preview-metadata.json --observations=10 --network=lab \
  --output=docs/performance-artifacts/deployed-preview-navigation.json
```

With ten complete trials, the runner plans 130 observations: ten initial loads of each route; ten first tab visits of each; ten repeat visits of Dashboard, Calendar and Chat and twenty of Settings. Dashboard-start sessions preserve Dashboard → Calendar → Chat → Calendar before visiting Settings. Settings-start sessions provide Dashboard's first tab visit. Each initial load uses a fresh browser context; first/repeat tabs share that context. Use `--network=native` for an unthrottled cloud-egress comparison. Lab conditions match the earlier desktop profile (1440×900, 100 ms emulated latency, 10/1 Mbps, unthrottled CPU). The actual Chromium version and proxy presence are recorded at capture, without proxy addresses or credentials. HTTP/router caches and default prefetch remain enabled; no browser clocks are mocked.

Initial feedback is **first contentful paint**, and initial usable time is the first route-ready event measured from the document's native navigation time origin; neither is a click metric. Tab feedback/usability uses the existing double-animation-frame instrumentation. Resources started after a tab's click mark are counted, and completed document/resource timings supply TTFB, response duration and encoded/transfer sizes. A trailing network-idle wait is excluded from usability; timeouts are recorded. Pre-click prefetch and still-in-flight resources may be absent from those counts. Sanitized response UUIDs and numerical `Server-Timing` stages provide correlation, without saving headers or bodies wholesale. Page metadata supplies preparation, DB wait/counts and individual query durations. Available Long Task entries supply count and intersecting main-thread time through readiness; they exclude tasks under 50 ms, do not identify React work, and are not a rendering profile.

Unknown event/log fields are stripped at every level, paths are reduced to a fixed allowlist, and malformed records are rejected. Separate per-route/category summaries report sample sizes, medians and nearest-rank p95; missing observations remain null. With ten samples p95 is still the maximum, so uncertainty remains high. A blocked/partial run exits nonzero and labels its artifact accordingly. No production flags, rate limits, chat behavior or cleanup policy are changed by this runner.

### Comparison, hypotheses and outstanding limits

There is no deployed/local numerical comparison yet. The local representative desktop medians were roughly 338–343 ms to usable for Calendar/Chat, with preparation medians of 6–25 ms and response medians around 105–106 ms under the stated lab profile. Those observations neither identify the preview's region/DB wait nor explain the reported two-second delay.

Possible repeated RSC/alert requests, loading transitions, browser scheduling/rendering and remote connection/query wait remain **hypotheses to test**, not deployed findings. Provider quota, actual history/token sizes, cold-start behavior and deletion races remain unmeasured. No evidence currently supports selecting a deployed performance fix; the smallest justified next action is to unblock access and collect the separated timings before choosing one. No caching, UI redesign, chat/rate-limit change or conversation cleanup has been implemented.

Validation for this follow-up: 14 focused instrumentation/privacy tests passed (7 existing instrumentation tests and 7 new preview-artifact tests); `npm run verify` passed typecheck, lint, formatting and the normal production build. The CLI also refused a missing metadata manifest with the expected exit status 1 before opening a browser. The runner has not been exercised against an authenticated preview, and these checks are not deployed navigation/chat/deletion results. The full DB/browser suites above were from the earlier local-baseline work and were not rerun as a substitute for deployed tests.
