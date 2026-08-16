# Testing

## The invariant

**Running the test suite must be incapable of mutating production.**

This wasn't always true. Before the Phase 4.1 remediation (2026-08-16),
`pnpm test:integration` loaded `.env.local` — the same file that holds real
production Supabase credentials on a developer's machine — with no check on
what it resolved to. Two real incidents came out of that: a test file used
real Premier League/LaLiga provider IDs with a business-key cleanup sweep
and deleted the real production rows every run, and a separate cleanup bug
(a missing `notifications` delete before a `pools` delete, blocked by an FK)
silently leaked test pools/fixtures/notifications into production for
weeks. Both are fixed. The architecture below is what makes the *next*
version of this mistake structurally impossible, not just "please be
careful."

The same invariant applies to E2E (Phase 4.2, same day): `test:e2e` had no
guard at all, and `next dev` — spawned by Playwright to run the app under
test — does its own independent `.env.local` loading regardless of what
loaded Playwright itself, so the exposure was real even though no incident
had yet resulted from it. Closed the same way: a validated, no-fallback
target, checked before anything starts.

If you're extending this suite, read this document before touching how
tests resolve their Supabase target — that's exactly the surface that
caused the incidents above.

## Three separate configs, three separate purposes

| Purpose | Env file | Vars | Target |
|---|---|---|---|
| Production / prod-facing dev | `.env.local` | `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, ... | Whatever hosted project `.env.local` points at (real production on most machines) |
| Local dev seeding | `.env.development.local` | same var names, different values | Local Supabase (`http://127.0.0.1:54321`) |
| **Integration tests** | `.env.test.local` | `TEST_SUPABASE_URL`, `TEST_SUPABASE_ANON_KEY`, `TEST_SUPABASE_SERVICE_ROLE_KEY` | Local Supabase, and **only** local Supabase — enforced, not just configured |

The test config uses a namespace nothing else reads. This is deliberate: if
integration tests read `NEXT_PUBLIC_SUPABASE_URL` like production code
does, then whichever `.env` file happens to be loaded (or whatever's
already exported in your shell) becomes the test target by accident. A
separate namespace means a missing test var can never resolve to a real
value meant for something else — see "The guard" below for how that's
enforced, not just hoped for.

## Running the tests

### Unit tests (no database)

```bash
pnpm test
```

### Integration tests (real local Postgres/Auth/PostgREST via Supabase CLI + Docker)

```bash
pnpm supabase:start          # boots local Supabase (Docker required)
cp .env.test.example .env.test.local
pnpm supabase status -o env  # prints ANON_KEY/SERVICE_ROLE_KEY — fixed,
                              # publicly-documented local-dev values,
                              # identical on every machine; not secrets
# paste those into .env.test.local
pnpm create-super-admin --email you@example.com --password 'xxxx' --name "Admin"
                              # most integration tests look up an existing
                              # super_admin rather than creating their own
pnpm test:integration
```

To reset the database to a clean slate (wipes all data, reapplies every
migration under `supabase/migrations/` from scratch):

```bash
pnpm supabase:reset
```

Do this whenever local migration history has drifted from
`supabase/migrations/` — `supabase migration list --local` shows any
mismatch. `pnpm supabase:start` on an *already-running* instance does NOT
pick up new migration files added since it last booted; only `reset` (or a
fresh `start`) does.

### E2E tests (Playwright)

```bash
pnpm supabase:start          # boots local Supabase (Docker required), if not already running
cp .env.test.example .env.test.local   # if you haven't already for integration tests
pnpm test:e2e
```

`pnpm test:e2e` is safe by default — no flag to remember. It loads
`.env.test.local` (same file, same `TEST_SUPABASE_*` vars integration tests
use — E2E and integration deliberately share one isolated target, not two),
and `playwright.config.ts` validates and projects that target onto the
running app before `next dev` ever starts. See "The E2E guard" below for
exactly what closes this and why it was a real, structural gap before
Phase 4.2 (2026-08-16) — not just a documentation gap: `next dev` does its
own internal `.env.local` loading, independent of whatever loaded
Playwright itself, so `NODE_ENV=test` or a "don't run this against prod"
comment was never going to be enough.

`playwright.config.ts` sets `reuseExistingServer: false` — deliberately not
Playwright's usual "reuse a server already on that port" local-dev
convenience. Reusing an existing server would skip `webServer.env`
entirely (the mechanism that keeps the running app off production), so if
you already have `pnpm dev` running locally against real `.env.local` on
port 3000, `pnpm test:e2e` will fail to bind that port rather than silently
testing against your production-pointed server. Stop your other `pnpm dev`
first.

## The integration-test guard

`tests/integration/helpers/test-env.ts` is the single choke point every
integration test's Supabase client goes through — no test file constructs
its own client from raw env vars anymore. It enforces two things,
independently:

1. **No fallback.** `TEST_SUPABASE_URL`/`TEST_SUPABASE_ANON_KEY`/
   `TEST_SUPABASE_SERVICE_ROLE_KEY` must be set. If any is missing, it
   throws — it does NOT fall back to `NEXT_PUBLIC_SUPABASE_URL`/
   `SUPABASE_SERVICE_ROLE_KEY`. A missing test var fails loudly instead of
   silently resolving to whatever production config happens to be sitting
   in the ambient environment.
2. **Hard allowlist.** The resolved `TEST_SUPABASE_URL` must match the
   Supabase CLI's fixed local address (`http://127.0.0.1:54321` or
   `http://localhost:54321`) — nothing else. Not a "trusted" remote test
   project, not staging, nothing. Any other value throws
   `UnsafeTestSupabaseTargetError` before a client is ever constructed.

This is checked in two places, deliberately redundant:

- **`vitest.integration.config.ts`'s `globalSetup`** (`tests/integration/helpers/global-setup.ts`)
  runs once, before any test file is even imported — the earliest possible
  point to abort. A misconfigured target fails the whole run instantly
  instead of 45 files each independently discovering the same problem.
- **Every test file's own client construction** (`getTestAdminClient()`/
  `getTestAnonClient()`/`getTestSupabaseConfig()`) runs the same check
  again. Belt and suspenders: if a new test file were ever added that
  somehow bypassed `globalSetup`, it still can't get a client without
  passing this check itself.

Proof this actually blocks production (see `tests/unit/test-env-guard.test.ts`
for the automated version):

```bash
TEST_SUPABASE_URL="https://<real-project-ref>.supabase.co" \
TEST_SUPABASE_ANON_KEY=x TEST_SUPABASE_SERVICE_ROLE_KEY=x \
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/wallet.test.ts
# → "Refusing to run integration tests against ... this is not the local
#    Supabase CLI's address." Exit code 1. No test ran, no query issued.
```

## The E2E guard

E2E and integration tests deliberately share ONE definition of "safe test
target" — `tests/e2e/helpers/test-env.ts` is a pure re-export of
`tests/integration/helpers/test-env.ts`, not a second, subtly different
implementation (Phase 4.2 explicitly avoided ending up with two competing
test infrastructures, or three definitions of "production" across
`scripts/lib/production-guard.ts` and each test layer).

Root cause this closes (Phase 4.2, 2026-08-16): unlike `vitest`, which only
resolves env through whatever `dotenv -e <file>` explicitly loads,
`next dev` — spawned by Playwright's `webServer.command` — does its OWN
internal env-file loading via `@next/env`, and that loading always includes
`.env.local` for any variable not already present in the process's env.
`test:e2e` previously had no `dotenv` wrapper at all, so the spawned
`next dev` fell straight through to `.env.local` (real production
credentials on a dev machine) for `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` — both the
server (Server Actions, route handlers) and the browser (`NEXT_PUBLIC_*`
vars are embedded into the client bundle at compile time) inherited the
same resolved production values from that one root cause.

Three enforcement layers:

1. **`playwright.config.ts`'s top-level `getTestSupabaseConfig()` call.**
   Runs synchronously the instant Playwright loads the config file — before
   `globalSetup`, before `webServer` spawns `next dev`, before any spec
   file is read. A missing or unsafe `TEST_SUPABASE_URL` throws here and
   the whole `playwright test` invocation aborts with no browser launched,
   no server started, no network call made. This is the load-bearing
   check.
2. **`tests/e2e/helpers/global-setup.ts`** (Playwright's `globalSetup`
   option) re-validates and logs the resolved target
   (`[e2e globalSetup] Verified E2E Supabase target: ...`) — defense in
   depth, and what makes a run's own logs self-proving.
3. **`webServer.env`** in `playwright.config.ts` explicitly projects the
   already-validated local values onto `NEXT_PUBLIC_SUPABASE_URL` /
   `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` (plus
   `API_FOOTBALL_ENABLED=false`, `API_NFL_ENABLED=false`, and safe
   placeholders for `CRON_SECRET`/`RESEND_API_KEY`/`NEXT_PUBLIC_SENTRY_DSN`)
   before spawning `next dev`. Empirically confirmed in this repo (Next
   16.2.10): a value already present in `process.env` when `next dev`
   starts is NOT overridden by `.env.local` — only a variable `.env.local`
   would otherwise be the first to set can be. This is a one-way,
   validated-value-only *projection*, never a fallback — nothing here ever
   reads the plain var names as input.

Runtime proof (2026-08-16, this exact repo): with the projection in place,
`curl`'ing the running app's CSP header shows
`connect-src 'self' http://127.0.0.1:54321 ...` — the browser is
CSP-restricted to the local instance regardless of what any component's
code does, a defense-in-depth property beyond the projection itself. The
guard's rejection behavior (production URL / arbitrary hosted URL /
missing / malformed, all refused before webServer starts, all exit code 1)
uses the exact same `assertSafeTestSupabaseUrl` proven in
`tests/unit/test-env-guard.test.ts`.

E2E deliberately supports no production mode. There is no `--production`
flag and none is planned — normal Playwright runs are local-test-only,
categorically. A future read-only production smoke-test system, if ever
needed, would be a separate, explicitly-designed tool, not a flag on this
suite.

## CI

`.github/workflows/ci.yml`'s `integration` job boots a fresh local Supabase
stack, applies every migration, writes `.env.test.local` from
`supabase status -o env` (fixed local-dev values, no GitHub secret needed),
bootstraps a super admin by invoking `create-super-admin.ts` directly with
inline env vars (not through `.env.local` — nothing in that job ever writes
that file), then runs `pnpm test:integration`. The VM is thrown away after
every run, so there's no persistence between runs to drift or leak.

The `e2e` job follows the identical pattern — local Supabase, writes only
`.env.test.local`, runs `pnpm test:e2e`. `playwright.config.ts`'s
`webServer.env` projection means CI doesn't need its own separate
provider-disabled/placeholder-credential logic anymore; the same
protection applies whether the run is local or CI, by construction, not by
each caller remembering to set it up.

## If you're adding a new integration test file

- Import your Supabase client(s) from `tests/integration/helpers/test-env.ts`
  (`getTestAdminClient()` for the service-role client every file needs;
  `getTestSupabaseConfig()` if you also need to construct a per-user anon
  client, e.g. for RLS tests that sign different fake users in). Never
  construct a client from `process.env.NEXT_PUBLIC_SUPABASE_URL` or
  `process.env.SUPABASE_SERVICE_ROLE_KEY` directly — that's the exact
  pattern that caused the original incident.
- Track every row your test creates (in a module-level array, or however
  the file already does it) and delete it all in `afterAll`. Check every
  cleanup delete's `.error` — an unchecked cleanup delete that fails
  silently (e.g. on an FK you didn't know about, like `notifications.pool_id`
  having no `ON DELETE CASCADE`) is exactly how rows leaked for weeks
  undetected. If cleanup fails, throw — a loud cleanup failure is much
  cheaper than a silent one.
- Don't create real production auth users, ever — not even "just for this
  one test." Everything runs against the isolated local instance now, so
  `admin.auth.admin.createUser(...)` via `getTestAdminClient()` is already
  local-only; there's no need for a script-level workaround like
  `rls.test.ts` used to have.

## If you're adding a new E2E spec

- Import `getTestAdminClient()` (or `getTestSupabaseConfig()`) from
  `tests/e2e/helpers/test-env`, same as integration tests — never
  `process.env.NEXT_PUBLIC_SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`
  directly. `invite-flow.spec.ts` is the reference example.
- You don't need to think about the server-side app's Supabase target at
  all — `playwright.config.ts`'s `webServer.env` already handles that for
  every spec. You only need the guarded client for direct DB setup/teardown
  your spec does itself (seeding an invitation row, asserting on a row
  after a UI action, etc.).
- If a flow needs API-Football/API-NFL data, don't flip the provider flags
  on for your spec — seed deterministic local fixtures/pools directly via
  the guarded admin client instead (see `scripts/seed-dev-grading.ts` for
  the same deterministic-fixture-ID pattern applied to dev seeding).
