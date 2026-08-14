# Deployment

brohda. deploys as a standard Next.js app on Vercel, backed by a hosted
Supabase project. This doc covers what's specific to this project — for
general Vercel/Next.js deployment mechanics, see Vercel's own docs.

## 1. Provision Supabase

Create a hosted Supabase project (supabase.com), then apply this repo's
migrations to it:

```bash
pnpm supabase login
pnpm supabase link --project-ref <your-project-ref>
pnpm supabase db push
```

This applies every file under `supabase/migrations/` in order. There is no
`supabase/seed.sql` — seeding is handled by `scripts/seed.ts` (dev/demo only,
see the warning below), not by the Supabase CLI's seed mechanism.

Create the first (and, for this app, only) super-admin account against the
hosted project the same way you would locally:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
pnpm create-super-admin --email you@example.com --password 'xxxx' --name "Admin"
```

## 2. Environment variables

Set these in the Vercel project's Environment Variables settings (values
sourced from `.env.example`):

| Variable | Notes |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Hosted project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public, RLS-scoped |
| `SUPABASE_SERVICE_ROLE_KEY` | **Server-only.** Bypasses RLS — never expose to the client, never commit it |
| `API_FOOTBALL_BASE_URL` | `https://v3.football.api-sports.io` |
| `API_FOOTBALL_KEY` | From API-Sports; request it, don't paste it into chat — put it directly in the env file |
| `API_FOOTBALL_ENABLED` | `true` in production once a real key is set |
| `DEFAULT_TIMEZONE` | `America/Costa_Rica` — used for the same-calendar-day anomaly-void grace window (X.7.2) |
| `APP_URL` | The deployed app's public URL |
| `CRON_SECRET` | Random secret; see below |
| `RESEND_API_KEY` | Used both by Supabase Auth's SMTP relay and directly by the app for pool-published emails — see Resend setup below |
| `NEXT_PUBLIC_SENTRY_DSN` | Optional — see Sentry setup below. Leave unset to disable error monitoring entirely |
| `SENTRY_ORG` / `SENTRY_PROJECT` / `SENTRY_AUTH_TOKEN` | Optional, build-time only — enables source-map upload for readable stack traces |

## 3. Email delivery (Resend)

Supabase's built-in email sending is capped at 2/hour, which is enough for
demo/testing but not for real password-reset traffic. This project uses
[Resend](https://resend.com) as a custom SMTP relay for Supabase Auth's
transactional emails (password reset, etc.). `RESEND_API_KEY` in the table
above is needed for both that SMTP relay (Supabase Auth's own settings) and
directly by the app's Next.js code (`lib/email/resend.ts`), which calls
Resend's HTTP API to email every opted-in player when a coordinator publishes
a new pool (`lib/email/notify-pool-published.ts`). Without a key set,
`sendEmail` no-ops silently (same pattern as `API_FOOTBALL_ENABLED`) — no
key is needed for local dev/CI.

1. **Sign up at [resend.com](https://resend.com)** (do this yourself — I
   won't create third-party accounts on your behalf).
2. **Add and verify `brohda.com` as a sending domain** under Resend's
   Domains settings. Resend will give you a handful of DNS records (SPF —
   a `TXT` record; DKIM — one or more `TXT`/`CNAME` records; optionally a
   `MX`/`TXT` pair for a custom return-path). Add those at your DNS
   registrar and wait for Resend to show the domain as verified — this can
   take anywhere from a few minutes to a few hours depending on DNS
   propagation.
3. **Create an API key** in Resend (Settings → API Keys). Treat it like any
   other secret — put it directly in the Vercel env var, never in chat.
4. **Once the hosted Supabase project exists**, go to the Supabase
   dashboard → Authentication → Emails → SMTP Settings, enable custom SMTP,
   and set:
   - Host: `smtp.resend.com`
   - Port: `465` (SSL) or `587` (STARTTLS) — either works
   - Username: `resend`
   - Password: the Resend API key from step 3
   - Sender email: something on the verified domain, e.g. `noreply@brohda.com`
   - Sender name: `brohda.`
5. Send a test password-reset email once configured and confirm it lands
   (check spam on the first send) — this replaces Supabase's 2/hour default
   limit with whatever Resend's plan allows.
6. Pool-published emails send from `notifications@brohda.com` — no
   additional Resend setup needed beyond the domain verification in step 2,
   since that covers every address on `brohda.com`. Players can opt out
   individually from their Edit Profile tab (`email_notifications_enabled`
   on `user_profiles`, defaults to on).

## 4. Error monitoring (Sentry)

The app ships with `@sentry/nextjs` wired up (`instrumentation.ts`,
`instrumentation-client.ts`, both `error.tsx` boundaries, and
`app/global-error.tsx`) but **inert until you supply a DSN** — with
`NEXT_PUBLIC_SENTRY_DSN` unset, the SDK no-ops everywhere, which is why
local dev and CI both work today with no Sentry account at all.

1. **Sign up at [sentry.io](https://sentry.io)** (do this yourself — I
   won't create third-party accounts on your behalf).
2. **Create a project** and pick "Next.js" as the platform. Sentry will
   show you a DSN (a URL like `https://xxxx@oyyyy.ingest.us.sentry.io/zzzz`).
3. **Set `NEXT_PUBLIC_SENTRY_DSN`** to that value in the Vercel project's
   env vars. That's the only required step — errors from both the server
   and the browser will start showing up in the Sentry project immediately
   after the next deploy.
4. **Optional: readable stack traces.** Without source maps, Sentry shows
   minified/bundled code in stack traces. To enable upload, also set
   `SENTRY_ORG` and `SENTRY_PROJECT` (both visible in the Sentry project's
   URL/settings) and `SENTRY_AUTH_TOKEN` (Settings → Auth Tokens — treat it
   like any other secret, put it directly in the Vercel env var, never in
   chat). Leave all three unset to skip source-map upload entirely; the SDK
   still captures and reports errors either way.

## 5. Cron jobs (cron-job.org, not Vercel Cron)

The app exposes **7** cron-secret-gated routes under `app/api/cron/*`.
**6 are meant to be scheduled** (per the operational phase that followed
Phase 3 of the universal-sports-architecture work); one
(`refresh-recommendation-cache`) is deliberately left unscheduled for now.
Vercel's Hobby plan only allows daily cron invocations (Pro is required for
per-minute native Vercel Cron), so this project uses
[cron-job.org](https://cron-job.org) — a free external scheduler that calls
these routes over plain authenticated HTTP, independent of the Vercel plan
tier. **cron-job.org's own dashboard is the actual scheduler configuration
and lives entirely outside this repo** — nothing here can prove a job is
firing on schedule; it can only prove the endpoint itself works correctly
when called (see "Live verification" below) and document what the
dashboard *should* be set to.

Every route checks `Authorization: Bearer $CRON_SECRET` and returns `401`
on a mismatch. Set `CRON_SECRET` to a long random value in the Vercel
project's env vars first — this value is Vercel-side only; `.env.local` in
this repo is not deployed and does not need to (and may not) match it.

Every route is also wrapped in `recordJobRun` (`lib/jobs/record.ts`), which
acquires a named Postgres advisory lock (`try_acquire_cron_lock`) scoped to
that job's own name before running, and skips the tick entirely (no
provider call, no `background_jobs` row) if a previous invocation of the
*same* job is still holding it — so two overlapping runs of the same job
can never stack, and one job's lock never affects another job's. This
guard already exists for every route below; nothing needed to change for
this operational phase, only the scheduling itself.

**Full inventory and target schedule:**

| Endpoint | Provider | Consumes quota? | Function | Target cadence | Scheduled today? |
| --- | --- | --- | --- | --- | --- |
| `/api/cron/sync-fixtures` | api_football | Yes | `runFixtureSync` | Every 1 minute (unchanged) | **Yes** |
| `/api/cron/lock-pools` | none (DB-only) | No | `lockDuePools` | Every 1 minute (unchanged) | **Yes** |
| `/api/cron/process-results` | none (DB-only) | No | `processAwaitingResults` | Every 1 minute (unchanged) | **Yes** |
| `/api/cron/sync-fixtures-nfl` | api_nfl | Yes — one request per tick regardless of season size | `runNflFixtureSync` | **Every 5 minutes** | Add to cron-job.org (see below) |
| `/api/cron/discover-competitions` | api_football | Yes — up to `DISCOVERY_COMPETITIONS_PER_CRON_TICK` (10) requests per tick, only for competitions actually due (6h staleness) | `runCompetitionDiscoverySync` | **Every 6 hours** | Add to cron-job.org (see below) |
| `/api/cron/process-competition-imports` | none — DB-only, processes already-staged import chunks; makes zero provider calls even when API-Football quota is exhausted | `runCompetitionImportProcessing` | **Every 5 minutes** | Add to cron-job.org (see below) |
| `/api/cron/refresh-recommendation-cache` | api_football | Yes | `refreshRecommendationAvailabilityCache` | **Intentionally not scheduled** — the architecture is moving away from recommendation/provider-discovery as a primary workflow now that browsing is local-first (see the Phase 2 local-first browsing work). Endpoint stays live; whether to schedule it is deferred to the later Competition Management cleanup phase. | **No** — deliberate, not an oversight |

Expected max duration for every job is well under cron-job.org's timeout —
observed production durations are sub-second to a few seconds
(`sync-fixtures`) and low seconds (`discover-competitions`,
`sync-fixtures-nfl`, both bounded by their per-tick limits above).
`process-competition-imports` is bounded by `IMPORT_CHUNKS_PER_CRON_TICK`
(10 chunks) and is DB-only, so its duration is dominated by database round
trips, not network latency to a provider.

**Adding the 3 new jobs to cron-job.org** (same pattern as the 3 existing
ones — request method `GET`, `Authorization` header under that job's
"Request headers" section, using the real `CRON_SECRET` value from Vercel;
never paste that value anywhere outside cron-job.org's own settings and
the Vercel env var):

| Job | URL | Schedule | Header |
| --- | --- | --- | --- |
| Sync NFL fixtures | `https://brohda.com/api/cron/sync-fixtures-nfl` | Every 5 minutes | `Authorization: Bearer <CRON_SECRET>` |
| Discover competitions | `https://brohda.com/api/cron/discover-competitions` | Every 6 hours | `Authorization: Bearer <CRON_SECRET>` |
| Process competition imports | `https://brohda.com/api/cron/process-competition-imports` | Every 5 minutes | `Authorization: Bearer <CRON_SECRET>` |

**The 3 existing jobs**, unchanged:

| Job | URL | Schedule | Header |
| --- | --- | --- | --- |
| Sync fixtures | `https://brohda.com/api/cron/sync-fixtures` | Every 1 minute | `Authorization: Bearer <CRON_SECRET>` |
| Lock pools | `https://brohda.com/api/cron/lock-pools` | Every 1 minute | `Authorization: Bearer <CRON_SECRET>` |
| Process results | `https://brohda.com/api/cron/process-results` | Every 1 minute | `Authorization: Bearer <CRON_SECRET>` |

Leaving cron off Vercel entirely also means Vercel's Hobby (free) plan is
sufficient for hosting — no Pro upgrade is required purely for this.

**Practical effect of the 3 newly-scheduled jobs, once added:** NFL
fixtures now refresh (status/scores/newly-resolved playoff matchups) every
5 minutes instead of only at initial season import — this is what makes
NFL genuinely self-maintaining rather than a one-time import. Already-
imported football competitions now pick up newly-added, postponed/
rescheduled, and newly-resolved-participant fixtures every 6 hours instead
of never. A multi-chunk competition import now finishes automatically
within minutes of being started, instead of depending on some *other*
cron tick's reconciliation pass to notice it's stuck.

**Live verification, not scheduling.** Nothing in this repo — or in a
single successful `curl` — can prove a cron-job.org schedule is actually
configured and firing on the stated cadence; only cron-job.org's own
dashboard is authoritative for that. What repo-level verification *can*
prove, and what was checked before recommending the schedule above: each
endpoint requires the correct `CRON_SECRET` and returns a real success
response when called once; the overlap lock and provider quota/breaker
guards behave correctly; and the DB-only job makes zero provider calls.
After adding a job to cron-job.org, confirm it's actually firing via
`/admin/reports`' Job Health section (reads `background_jobs`) and
cron-job.org's own job history (a 401 there means `CRON_SECRET` doesn't
match between cron-job.org and the Vercel env var).

Every run is recorded in `background_jobs` (job name, success/error,
result) regardless of whether the job is externally scheduled — an
unscheduled route simply never gets invoked, so it never appears there at
all.

## 6. Deploying migrations for later changes

Any new file added to `supabase/migrations/` needs `pnpm supabase db push`
run against the hosted project before (or as part of) the corresponding
code deploy — Vercel does not run migrations automatically. Keep schema
changes and the code that depends on them in the same deploy where
possible; this app has no migration-rollback tooling beyond writing a new
forward migration.

## 7. Seed data — dev/demo only, never production

`pnpm seed` (`scripts/seed.ts`) creates 5 demo player accounts with a fixed,
publicly-known password (`PollPoolsDemo123!`) and 10 demo pools with fake
fixtures. **Never run this against a production database.** It exists purely
to give a freshly reset local (or staging) database realistic data to
demo/test against — it is not idempotent and assumes a clean slate
(`pnpm supabase db reset` immediately before it, followed by
`pnpm create-super-admin`).

If you need a staging environment with realistic-looking data, provision a
separate Supabase project for it and run `pnpm seed` there — never against
the same project serving production traffic.

### Deterministic grading-pipeline seed

`pnpm seed:dev-grading` (`scripts/seed-dev-grading.ts`) is a separate,
narrower seed for exercising the pool lifecycle and automatic-grading
pipeline locally, without live API-Football imports. Unlike `pnpm seed`, it:

- **refuses to run against anything but a local Supabase instance** (checks
  `NEXT_PUBLIC_SUPABASE_URL` is `127.0.0.1`/`localhost` and exits otherwise)
  — it is wired to `.env.development.local`, not `.env.local`
- **is idempotent** — every entity is looked up before being created; rerun
  it as many times as you like. If you've since graded/settled a seeded
  pool by hand, rerunning does not reset it — it only fills in what's
  missing
- uses the fixed provider name `dev_seed` and fixed external IDs/UUIDs so
  every entity is deterministic across runs

It creates: a league + `league_season_imports` row (`IMPORTED`,
`pool_creation_enabled`), 2 teams, 5 fixtures, and 4 `TEMPLATE_GRADED`
(`HOME_TEAM_TO_WIN`) pools covering the full lifecycle:

| Fixture | Status | Paired pool | Purpose |
|---|---|---|---|
| `dev-seed-fixture-open-eligible` | `NOT_STARTED`, no pool | — | Pool-creation wizard fixture search |
| `dev-seed-fixture-will-lock` | `NOT_STARTED` | Pool 1 — `OPEN`, `locks_at` already past | Exercising the lock-pools cron |
| `dev-seed-fixture-locked` | `LIVE` | Pool 2 — `LOCKED` | Inspecting a locked pool directly |
| `dev-seed-fixture-completed` | `COMPLETED`, home 2–1 away | Pool 3 — `AWAITING_RESULT` | Exercising automatic grading + settlement (2 winners, 1 loser) |
| `dev-seed-fixture-cancelled` | `CANCELLED` | Pool 4 — `AWAITING_RESULT` | Exercising the automatic anomaly-refund path |

Three dev-only players (`dev-seed-alice/bob/carol@brohda.dev`, password
`DevSeedGrading123!`) are funded with $50 each and entered across these
pools on different outcomes.

Run it with:

```bash
pnpm supabase:start
pnpm create-super-admin --email you@example.com --password 'xxxx' --name "Admin"
pnpm seed:dev-grading
```

Then exercise the real pipeline against the seeded data, e.g.:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/lock-pools
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/process-results
```

Pool 3 should grade automatically and move to `READY_FOR_REVIEW` with Alice
and Carol as winners; an admin confirm click (or `confirm_pool_settlement`)
completes the payout. Pool 4 should refund both entries automatically, no
admin action needed.
