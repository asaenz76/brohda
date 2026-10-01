# Brohda Repository Cleanup Inventory

**Status**: Read-only inventory. Nothing was deleted, moved, or modified to produce this document — every item below is a recommendation, not an action taken.
**Repo**: `github.com/asaenz76/brohda`, branch `main`, commit `fe2b181d4a4bc289aaca047c08fdf6a03a2f3023`.

Companion to `brohda-prediction-network-audit.md`. That document covers what should architecturally survive the proposed Polymarket pivot; this one covers ordinary repository hygiene, independent of that pivot.

---

## Part 1 — The 5 pre-existing dirty-worktree items

These were already uncommitted at audit time, unrelated to this audit, and were **not** touched while producing it.

| File | Status | What it actually is | Classification |
|---|---|---|---|
| `package.json` | Modified | One added line: `"send-beta-sunset-email": "dotenv -e .env.local -- tsx scripts/send-beta-sunset-email.ts"`. `git diff` confirms this is the *only* change. | Directly tied to the script below — see there. |
| `scripts/send-beta-sunset-email.ts` | Untracked | A one-time announcement script (defaults to dry-run, gated by `--send` + `CONFIRM_PRODUCTION_WRITE`) that emailed every registered user that beta testing ended and play-money balances would be zeroed on a fixed date. **Already executed** — its own code comment documents and fixes a real bug it shipped with (a hardcoded `APP_URL` mismatch broke the "Add funds" link in the sent email). | Finished, one-time, already run. Commit-or-archive is an owner call; not risky either way. |
| `scripts/send-link-correction-email.ts` | Untracked | The direct follow-up: a short correction re-sent to a hardcoded list of exactly the 15 people who got the broken link. **Already executed** (per its own comment: "10 sent cleanly, 5 retried after a rate-limit failure — all 15 got the corrected link"). Correctly has no `package.json` entry — it targets a fixed, one-time recipient list, not a general-purpose tool. | Finished, one-time, already run. |
| `NFL_INTEGRATION_ARCHITECTURE_NOTE.md` | Untracked | A dated (2026-08-12) investigation proposing NFL as a second sports-data provider alongside the then-live API-Football integration. | See Part 2 — its subject has since been overtaken. |
| `NFL_LAUNCH_VERIFICATION_REPORT.md` | Untracked | The verification report (also 2026-08-12) confirming the NFL integration above was built and works — regression suite green, a real overtime-status bug found and fixed, sport-eligibility gaps found and fixed. Corroborated by current code. | See Part 2. |
| `UNIVERSAL_SPORTS_ARCHITECTURE_PROPOSAL.md` | Untracked | A 487-line proposal (marked "APPROVED with 15 decisions" internally) for generalizing the dual-provider architecture to multiple sports. | See Part 2. |

**None of these six items are abandoned or broken work.** All are finished, and the two email scripts already ran in production. They were correctly excluded from this session's separate production-rollout push per that task's own explicit instructions, and nothing here changes that assessment.

---

## Part 2 — Cross-cutting finding: three docs describe a retired architecture

`docs/ARCHITECTURE.md:1946` contains an explicit ADR: **"Association football / soccer retired (2026-09-08)"** — `api-football-provider.ts` and its whole competition-discovery/import subsystem were deleted outright, football-only cron routes removed, 17 football templates and `/admin/competitions` deleted, new football-pool creation blocked by a DB trigger (`20260101000124`). Confirmed against the filesystem: `lib/sports-data/` today contains only `api-nfl-provider.ts`; `.env.example` explicitly notes API-Football "was supported at launch and has since been retired."

The three untracked NFL/Universal-Sports docs (Part 1) all predate this ADR by nearly a month and describe the football+NFL dual-provider period as current. By contrast, every *other* pre-retirement strategy doc (`BROHDA_MANIFESTO.md`, `BROHDA_PRODUCT_REINVENTION.md`, `FOUNDER_IMPLEMENTATION_PLAN.md`, `PRODUCT_ALIGNMENT_REPORT.md`, `THE_LAST_50_PERCENT_REPORT.md`) was updated the same day as the ADR with an explicit **"Status: Superseded September 2026"** banner. These three are the exception — because they were never committed, they never received that pass.

**Classification (per the audit's historical-documentation guardrail):**

| Doc | Classification | Reasoning |
|---|---|---|
| `NFL_INTEGRATION_ARCHITECTURE_NOTE.md` | **ARCHIVE AS HISTORICAL** | Accurate record of real, finished investigation work; describes a state of the system that genuinely existed. Valuable evidence, not current guidance — should get the same "Superseded" banner as its siblings before being committed, or live in an explicitly historical location. |
| `NFL_LAUNCH_VERIFICATION_REPORT.md` | **ARCHIVE AS HISTORICAL** | Same reasoning — a real verification record of real, still-corroborated fixes (the `AOT` overtime-status bug fix is confirmed present in current code). |
| `UNIVERSAL_SPORTS_ARCHITECTURE_PROPOSAL.md` | **ARCHIVE AS HISTORICAL** | Largely overtaken by the later single-sport-focus decision implied by the soccer retirement, but the multi-sport analysis itself may still be useful reference if NFL is ever joined by a third sport. Not a delete candidate — a real decision record. |

None of these three are **DELETE CANDIDATE**s — they're accurate, finished records of real decisions and real work, exactly the kind of historical evidence the audit guardrails say to preserve rather than discard just because the product direction moved on.

---

## Part 3 — Broader repository inventory

### Dead files / unused components

| Item | Classification | Evidence |
|---|---|---|
| `components/analytics/ChartErrorState.tsx` | **PROBABLY REMOVE** | Zero imports anywhere (grepped). Independently flagged in the repo's own `ARCHITECTURE_REVIEW_REPORT.md:164` as a near-duplicate of `ChartEmptyState.tsx` ("identical layout, differing only in color/message"); `ChartEmptyState.tsx` is confirmed actively used in 4 files. Recommend unifying via a `variant` prop rather than keeping both. |
| `components/pools/PoolListRow.tsx` | **KEEP** | Zero imports, but *deliberately* — its own header comment says it's built ahead of being wired in ("wiring is a separate integration decision"), not dead code. Self-documented in-progress work, not abandoned. |
| `public/{file,globe,next,vercel,window}.svg` | **SAFE TO REMOVE** | Unmodified `create-next-app` scaffold assets. Grepped each filename across all `.ts`/`.tsx`/`.css` — zero references. (`public/logo-combo.svg`, by contrast, is confirmed used in `components/pools/LeagueIdentity.tsx`.) |
| 8 other spot-checked components (`TieredPoolCard`, `PoolCardSkeleton`, `EntryHighlightsTable`, `FreeEntryConfirmationSheet`, `UserFollowToggle`, `LeagueFollowToggle`, etc.) | **KEEP** | All have confirmed real consumers. |

### Unused routes

`app/(admin)/admin/fixtures` and `app/(admin)/admin/fixture-archive` initially looked orphaned (absent from `AdminNav.tsx`'s current tab list) but are **confirmed intentional redirect shims**, not dead code — `fixtures/page.tsx` explicitly redirects to `/admin/events` or `/admin/data/fixtures` depending on query params, citing "spec §18's explicit 'do not delete functionality merely to remove the route,'" and is covered by `tests/unit/admin-fixtures-redirect.test.ts` across all four redirect branches. **KEEP.** No other orphaned routes found in a full pass of `page.tsx`/`route.ts` files. `app/(admin)/admin/competitions/` is confirmed fully absent, consistent with the soccer-retirement ADR.

### Duplicate utilities

Only one genuine duplicate found: `ChartEmptyState`/`ChartErrorState` (above). A suspected duplicate (`scripts/lib/production-guard.ts` vs. a hypothetical `lib/production-guard.ts`) turned out to be a single, sole copy — not a duplicate. A previously-flagged dead dependency (`@tanstack/react-query`, per the older `ARCHITECTURE_REVIEW_REPORT.md`) is **already fully removed** from `package.json` with zero remaining code references — that old finding is now stale/resolved and needs no action.

### Migrations

128 migrations, none deleted or squashed — expected and healthy for an append-only Postgres migration history, not a problem to fix. The clearest "later migration fully neuters an earlier feature" instance — `20260101000124_block_new_legacy_soccer_pools.sql` + `20260101000125_disable_soccer_competition_imports.sql` — is exactly the DB-side twin of the soccer-retirement ADR, done correctly (block via trigger, deactivate import rows, preserve historical data). **KEEP as-is.**

### Documentation currency

| Doc | Currency |
|---|---|
| `README.md`, `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/PLATFORM_REPORT.md`, `docs/DEPLOYMENT.md`, `docs/TESTING.md` | Current, actively maintained |
| `docs/ACCEPTANCE_CRITERIA.md` | Point-in-time audit (36/36 pass); presumably still accurate, not independently re-verified here |
| `docs/audits/` | Was an **empty tracked directory** before this audit — now holds this document and its companion |
| `FREE_MODE_ARCHITECTURE_PROPOSAL.md` | Current — matches the FREE-mode rollout completed in this same session |
| `BROHDA_MANIFESTO.md`, `BROHDA_PRODUCT_REINVENTION.md`, `FOUNDER_IMPLEMENTATION_PLAN.md`, `PRODUCT_ALIGNMENT_REPORT.md`, `THE_LAST_50_PERCENT_REPORT.md` | Correctly self-labeled **"Superseded September 2026"** — no action needed |
| `ARCHITECTURE_REVIEW_REPORT.md` | **INVESTIGATE** — scoped to an older commit, predates the football retirement, unmarked as superseded. Two of its own findings are already independently resolved since it was written (react-query removal; a `hooks` alias fix), confirming it's aging. Recommend the same superseded-banner treatment as the strategy docs, or archiving. |
| `UX_FRICTION_REPORT.md`, `SECURITY_RPC_PRIVILEGE_INCIDENT_REPORT.md`, `PUBLIC_LAUNCH_RELEASE_REPORT.md` | Point-in-time historical/incident records — **KEEP**, don't need a superseded banner since they're records of specific past events, not standing product guidance. |
| The 3 untracked NFL/Universal-Sports docs | See Part 2. |

### Dependencies

Sampled 8 production dependencies (`@base-ui/react`, `recharts`, `sharp`, `shadcn`, `tw-animate-css`, `next-themes`, `class-variance-authority`, `tailwind-merge`) — **all show real usage**. One placement nit, not a dead-weight issue: `shadcn` (a CLI scaffolding tool, not an import) sits in `dependencies` rather than `devDependencies`.

### Environment variables

`API_FOOTBALL_BASE_URL`/`API_FOOTBALL_ENABLED`/`API_FOOTBALL_KEY` — fully and consistently retired, appearing nowhere in current code or env files (code and env files agree with each other). One item worth confirming intentional: `API_NFL_DAILY_REQUEST_BUDGET` is read in `lib/sports-data/quota-reserve.ts` and covered by an integration test, but is absent from `.env.local`/`.env.example`/`.env.development.local` — **INVESTIGATE** whether it's relying on an undocumented code default deliberately, or was meant to be documented. `SUPABASE_ACCESS_TOKEN`/`VERCEL_OIDC_TOKEN` in `.env.local` never appear as `process.env.*` reads in app code — expected, since these are consumed by the Supabase/Vercel CLIs directly, not application code; **not actually obsolete**.

### Other checks — all clean

- **TODO/FIXME/HACK**: zero matches anywhere in the main tree.
- **Generated files/build artifacts**: none accidentally tracked; `.gitignore` correctly excludes `.next/`, `tsconfig.tsbuildinfo`, `test-results/`.
- **Large tracked files**: nothing alarming — `pnpm-lock.yaml` (320K, expected) and `docs/ARCHITECTURE.md` (124K) are the largest, both plain text.
- **Scripts** (`scripts/`, 7 files): all either referenced by `package.json`/CI or, for the two completed email scripts, intentionally standalone. One cosmetic item: `scripts/seed-dev-grading.ts`'s header comment still references "API-Football imports," a provider that no longer exists in this codebase — **INVESTIGATE** (harmless, just stale wording).
- **Orphaned tests**: none — every test file matches its config's include glob. The football-era test files that exist only in gitignored `.claude/worktrees/` copies are correctly absent from the real `tests/` tree.
- **Abandoned feature flags**: `API_NFL_ENABLED` is the one true flag found, and both branches (enabled/disabled) are live and reachable — not abandoned.
- **Commented-out code**: none found in a full sweep.
- **Deprecated integrations**: the API-Football → API-NFL transition is the one deprecated integration, and it's already cleanly removed per the ADR — nothing lingering.
- **Stale seeds**: `scripts/seed.ts` is current (`sport: "american_football"`); `scripts/seed-dev-grading.ts` is functionally current but shares the same stale API-Football comment noted above.
- **Naming**: no real inconsistency found — the apparent PascalCase-vs-lowercase split in `components/` is a deliberate, consistent distinction between product components and shadcn-convention primitives, not disorganization.

---

## Summary table

| Item | Classification |
|---|---|
| `components/analytics/ChartErrorState.tsx` | PROBABLY REMOVE — merge into `ChartEmptyState` via a `variant` prop |
| `public/{file,globe,next,vercel,window}.svg` | SAFE TO REMOVE |
| `NFL_INTEGRATION_ARCHITECTURE_NOTE.md`, `NFL_LAUNCH_VERIFICATION_REPORT.md`, `UNIVERSAL_SPORTS_ARCHITECTURE_PROPOSAL.md` | ARCHIVE AS HISTORICAL — add the same "Superseded" banner as their committed siblings before committing, or file under an explicitly historical path |
| `ARCHITECTURE_REVIEW_REPORT.md` | INVESTIGATE — stale in ≥2 confirmed spots, unmarked; recommend a superseded banner or archiving |
| `scripts/send-beta-sunset-email.ts`, `scripts/send-link-correction-email.ts`, the `package.json` line | KEEP or archive at owner's discretion — finished, already-executed one-time work, not broken or abandoned |
| `scripts/seed-dev-grading.ts` header comment | INVESTIGATE — cosmetic stale reference to API-Football |
| `API_NFL_DAILY_REQUEST_BUDGET` missing from env files | INVESTIGATE — confirm the code default is intentional |
| `components/pools/PoolListRow.tsx` | KEEP — deliberate, self-documented, not yet wired in |
| Everything else checked (routes, migrations, dependencies, scripts, tests, flags, naming) | KEEP — no evidence of dead weight |

No item in this inventory was classified SAFE TO REMOVE or PROBABLY REMOVE without a confirmed reference check; nothing was deleted.
