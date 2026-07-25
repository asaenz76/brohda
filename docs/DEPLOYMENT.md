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

The app needs three routes hit once a minute — `/api/cron/sync-fixtures`,
`/api/cron/lock-pools`, `/api/cron/process-results`. Vercel's Hobby plan
only allows daily cron invocations (Pro is required for per-minute native
Vercel Cron), so instead this project uses
[cron-job.org](https://cron-job.org) — a free external scheduler that calls
these routes over plain authenticated HTTP, independent of the Vercel plan
tier.

Each route checks `Authorization: Bearer $CRON_SECRET` and returns `401` on
a mismatch — the same header Vercel's native cron would have sent, so
cron-job.org just needs to be told to send it too. Set `CRON_SECRET` to a
long random value in the Vercel project's env vars first, then on
cron-job.org create three jobs:

| Job | URL | Schedule | Header |
| --- | --- | --- | --- |
| Sync fixtures | `https://brohda.com/api/cron/sync-fixtures` | Every 1 minute | `Authorization: Bearer <CRON_SECRET>` |
| Lock pools | `https://brohda.com/api/cron/lock-pools` | Every 1 minute | `Authorization: Bearer <CRON_SECRET>` |
| Process results | `https://brohda.com/api/cron/process-results` | Every 1 minute | `Authorization: Bearer <CRON_SECRET>` |

For each job: request method `GET`, and add the `Authorization` line under
that job's "Request headers" section using the actual `CRON_SECRET` value
(never paste that value anywhere outside cron-job.org's own settings and
the Vercel env var). Leaving cron off Vercel entirely also means Vercel's
Hobby (free) plan is sufficient for hosting — no Pro upgrade is required
purely for this.

Every run is recorded in `background_jobs` (job name, success/error, result)
— check `/admin/reports`' Job Health section after the first deploy to
confirm all three are actually firing, and check cron-job.org's own job
history for delivery failures (e.g. a 401 means `CRON_SECRET` doesn't match
between cron-job.org and the Vercel env var).

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
