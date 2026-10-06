# Trellis

A tool for one Instagram creator. It reads their own account through Meta's
Graph API and helps them understand and plan their content.

Three surfaces and nothing else:

- **Dashboard** — 4–6 AI insight cards rendered as sticky notes, over account
  and follower metrics. Clicking a card hands it to the chat.
- **Chat** — a grounded conversation about the account. It reads synced data
  through tools, every statistic is computed in SQL, and **every figure it
  states must appear in what a tool returned** or it is dropped.
- **Calendar** — manually added posting dates and drafts, with a copy button on
  every field. Riyadh time throughout.

Cloud-hosted on **Vercel** and **Supabase**, at $0/month.

## Where this is

**The chat works.** It reads 246 posts going back to June 2021, with per-post
performance on every one of them, plus account metrics over 696 days.

**Not yet built:** the dashboard's insight cards and the calendar.

## The chat

Ask it about your account. It answers from your own data, or it doesn't answer.

The mechanism rather than the promise:

1. **Every statistic is computed in SQL** (`lib/chat/queries.ts`). The model
   never does arithmetic — it asks for a median and is given one.
2. **The tools are pre-computed aggregates**, never a query runner. The model
   chooses what to fetch, not how it is calculated.
3. **The answer is buffered, validated, then rendered.** Every figure in it must
   appear in what a tool actually returned that turn. One that does not is
   **dropped**, not caveated — a wrong number with a hedge in front of it is
   still a wrong number. That is also why it does not stream: you cannot un-send
   a token.
4. **Refusal is a first-class path.** Ask it to compare formats where one has
   too few measured posts and it says so, rather than comparing them anyway.

The distinction it is built around: a post published before measurement began
has **no** 24-hour or 48-hour reading. That is not zero, and it is not "too
new" — nobody measured at that age and nobody can now. Keeping those three
apart is the job.

The full plan is in [`docs/plan.md`](docs/plan.md) — foundation, three surface
lifecycles, a staged roadmap, and an open-questions register. The written record
of the previous build is in [`docs/history/`](docs/history/README.md).

## Alerts

In-app only — no email, no push, no third-party service. A banner above every
page, dismissible, plus a count on the calendar icon.

| Alert                 | Fires when                                                                |
| --------------------- | ------------------------------------------------------------------------- |
| Followers fell / rose | The two most recent daily readings of the profile's follower total differ |
| Post due today        | A planned entry is still ahead of you today, in Riyadh                    |
| Post past its time    | A planned entry's time has gone                                           |

The follower alert reports a **net** change and says so. Instagram publishes no
follower list, no follow or unfollow events and no webhook for either, so there
is no way to know who unfollowed, and no way to separate three arrivals and
twelve departures from a bare loss of nine. Anything claiming otherwise is
scraping or asking for the password.

It also reads a column this app writes, not one Meta serves: the daily sync
snapshots the profile's follower total into `account_daily.followers_total`.
Meta's own `follower_count` metric is **not** a running total and must never be
subtracted end to end — see `docs/graph-api.md`. With only one reading there is
no alert at all; a comparison never made is not "no change".

## What the free tier allows

`[VERIFIED-LIVE]` 2026-08-27, from the provider's console: **5 requests a
minute, 20 a day.** A question is a tool loop costing up to four requests, so a
day is **about four questions**. `/settings` shows how many are left rather than
a request count, because that is the unit you think in.

Both limits are environment variables, so a paid tier is a config change — and
so is a different provider. `google`, `groq`, `deepseek`, `openrouter`,
`together`, `cerebras` and `mistral` are registered; all but Google share one
adapter because they speak the same wire format. Set `MODEL_PRIMARY`, the
matching key, and the two limits from that provider's console.

`MODEL_FALLBACK` is used when the primary is **out of requests**, not only when
its key is missing, so a second provider there is what stops a spent daily limit
from stopping the app. It has to be a different provider: a limit belongs to a
project, not a model.

See `docs/quota.md` for the arithmetic and for why raising the per-minute value
costs you questions.

## The rules everything follows

1. **A number that is not known renders blank, never zero.** Summing an empty
   series gives 0, which reads as "you held steady" — a different and false
   claim.
2. **Every statistic is computed in SQL.** The model never does arithmetic.
3. **Every figure in model output must appear in what a tool returned** —
   enforced in `lib/validate/numbers.ts`, not asked for in a prompt. Unbacked
   figures are dropped, never caveated.
4. **Every aggregate declares its real sample size.** `17 posts (2 measured)`.
5. **Sample floors are applied before the model call**, so it cannot caveat its
   way around thin data.
6. **No model name outside the provider interface.**
7. **No API field name in the interface.** "Accounts reached", not `reach`.
8. **Nothing is generated on page load.**

## Running it

```bash
npm install
cp .env.example .env        # fill in DATABASE_URL at minimum
npm run db:migrate
npm run dev
```

Checks — one command, matching exactly what Vercel runs on deploy:

```bash
npm run verify
```

Run it before every push. It exists because running a _subset_ — lint and tests
but not typecheck — once put a type error into a production deploy that had
passed local checks.

It does **not** include the test suite, and that is deliberate rather than a
compromise: Vercel's build does not run tests either, so this matches what
actually gates a deploy. CI runs the tests on every push, against its own
throwaway database.

If you do have a local Postgres, `npm run verify:full` adds them.

The production-build navigation benchmark and thread-deletion browser checks are documented in
[`docs/performance-baseline.md`](docs/performance-baseline.md). They use fresh local databases
with synthetic data and report first and repeat visits separately.

> **The tests refuse to run against a non-local database.** They begin with
> `truncate ... cascade`, and vitest loads `.env` — which on a machine that also
> operates this app points at production Supabase. A guard in
> `tests/guard.setup.ts` stops the suite rather than destroying 246 posts and
> the follower history Meta will not serve twice.
>
> To run them locally, point somewhere disposable in `.env.test.local`
> (git-ignored, vitest loads it):
>
> ```
> DATABASE_URL=postgres://postgres:postgres@localhost:5432/trellis_test
> ```

## Scheduling

Vercel Hobby cron allows **2 entries, once daily each** — a cap, not a rate.
The single slot in use is the keepalive, because Supabase Free pauses a project
after ~7 days idle and that is the one job that must not depend on GitHub.

Everything else runs from GitHub Actions, which is not subject to that cap. It
needs a repository **variable** `APP_URL` pointing at the stable production
domain — never a per-deployment URL — and a repository **secret** `CRON_SECRET`
byte-identical to the Vercel variable.

If a scheduled workflow gets a 401 from Vercel rather than from the app,
**Deployment Protection** is on. It is on by default and blocks every external
scheduler and webhook.
