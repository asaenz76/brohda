# Admin + Configuration (Milestone R12)

## Goal and boundary

R12 makes Brohda 2.0's mutable product and operational policy manageable by
authorized administrators without SQL edits, source-code edits,
environment-variable changes, or a deployment. It does not redesign the
consumer product, does not change financial accounting semantics, does not
introduce new sports-market behavior or new reputation algorithms, and does
not begin R13 (abuse/security tooling) beyond what this milestone's own
admin surface strictly requires.

## Philosophy

Every mutable setting Brohda's product logic already reads from
`platform_settings` is a policy decision someone made once, in code, that
should be revisable by an authorized human without a release. R12 does not
invent new policy — it takes the R1–R11 policy that already existed
(scattered across migrations and TypeScript defaults) and gives it one
typed, validated, audited, role-protected front door. Settings that are not
product policy — technical invariants, secrets, derived state — are
deliberately left alone: making everything "configurable" is not the goal;
making the things that are *already* policy *manageable* is.

## Classification model

Every column considered for this milestone was classified into exactly one
of:

- **TRUE TECHNICAL INVARIANT** — a fact about how the system is built, not
  a business choice (e.g. the shape of a state machine). Never exposed.
- **CONFIGURABLE PRODUCT POLICY** — a business rule that could reasonably
  change without a code change (e.g. how long before kickoff a Pick locks).
- **CONFIGURABLE OPERATIONAL POLICY** — a throughput/ops knob with no
  product-facing meaning (e.g. settlement batch size).
- **PRESENTATION CONFIGURATION** — copy or display ordering.
- **FINANCIAL CONTRACT POLICY** — anything that changes money movement or
  its snapshot semantics. Held to the same super_admin-only bar as every
  other domain here, with the added non-retroactivity guarantee described
  below.
- **PROVIDER-SECRET CONFIGURATION** — API keys/enablement for external
  providers. Environment variables, not `platform_settings` — out of an
  admin UI's reach by design.
- **DERIVED-RUNTIME STATE** — `updated_at`/`updated_by` and similar audit
  metadata. Never a setting, always a read-only artifact of a real one.
- **UNRESOLVED PRODUCT DECISION** — a genuine gap found while auditing the
  repository that this milestone deliberately does not resolve (see
  "Unresolved product decisions" below).

## Configuration catalog

Nine domains, exposed at `/admin/settings/brohda`, each with its own atomic
Save action:

| Domain | Fields | Notes |
|---|---|---|
| Predictions | Pick lock, prediction cutoff, allow-repeat, allow-stale-price, allow-unavailable-price, allow-closed-market | R3/R5 eligibility policy, already live before R12 |
| Notifications | Grading-notification master switch, per-outcome switches, 6 copy fields | The only configurable notification copy anywhere in the codebase |
| Markets | Ingestion switch + minimum bookmaker count, post-publication switch + active-market requirement | |
| Communities | Distribution master switch + 3 per-type switches (team/league/sport) | Disabling never deletes existing Post/Community relationships |
| Conversation | Max comment length, rate-limit window/attempts | Comment length additionally capped by an absolute DB CHECK of 2000 |
| Call BS | Master switch, rate-limit window/attempts | Disabling never affects an already-PENDING/ACCEPTED Challenge |
| Monetary P2P | Master switch, proposal rate-limit window/attempts, P2P settlement fee | Financial domain — see snapshot semantics below |
| Reputation | Leaderboard minimum decided-picks sample | Query-derived; takes effect immediately, rewrites no history |
| Operations | Settlement batch size | Pure throughput; new in this milestone, closes an R10 caveat |

Full field-by-field labels, descriptions, and types live in
`lib/admin-settings/registry.ts` (`SETTINGS_REGISTRY`) — that file is
presentation metadata only, never the security boundary.

## Intentionally unexposed configuration

`lib/admin-settings/registry.ts`'s `NOT_EXPOSED_SETTINGS` lists every
`platform_settings` column this milestone deliberately does not expose,
with its reason — `id`/`updated_at`/`updated_by` (derived metadata, not
settings); `registration_enabled`, the legacy pool fee defaults, and the
paid/free pool capability flags (already exposed on the pre-existing
`/admin/settings` page — this milestone does not hijack that surface, only
adds one discoverability link to it); `discovery_fresh_within_minutes`/
`discovery_stale_within_minutes` (pre-existing Milestone 2 policy,
orthogonal to R1–R11, deferred rather than expanding scope without an
explicit product ask); `post_primary_market_template_priority` (a
display-ordering array over a hard-coded enum, no real operator-control
signal). `tests/integration/admin-brohda-settings.test.ts`'s "configuration
discovery" test queries the live schema directly and fails if a future
column lands in neither list — the registry cannot silently drift from
reality.

## Role model

The entire Brohda 2.0 settings surface — `/admin/settings/brohda` and
`/admin/settings/brohda/history` — is `super_admin`-only, gated by the same
`requireSuperAdmin()` the pre-existing `/admin/settings` page already uses
for its own entire content. This was a deliberate choice, not an oversight:
this codebase's existing `admin`/`super_admin` split (`lib/auth/guards.ts`)
draws the line at money movement and account/role management staying
`super_admin`-only, with everything else open to plain `admin`. Nearly
every field exposed here is a significant product or financial lever — Pick
eligibility windows, notification behavior, market ingestion, monetary
enablement and its fee — so this milestone extends the *existing*,
already-precedented monolithic gate rather than inventing a new, unproven
per-domain `admin`/`super_admin` split for `platform_settings` specifically.
If a future milestone wants a finer split (e.g. `admin` may edit
Notifications copy but not the P2P fee), that is a new, explicit product
decision — not something this milestone should quietly default into.

Authorization is enforced twice, independently:

1. **Server Action layer** (`lib/actions/brohda-settings.ts`) — every one
   of the 9 actions calls `requireSuperAdmin()` as its first statement,
   before any validation or repository call. Verified for all 9 actions in
   `tests/unit/admin-brohda-settings-actions.test.ts`.
2. **Postgres grant layer** — every `update_*_settings` RPC is
   `revoke all ... from public, anon, authenticated; grant execute ... to
   service_role` only. Even if a Server Action's own guard were ever
   bypassed or misconfigured, the RPC itself refuses any caller but the
   trusted service-role client. Verified for all 9 RPCs in
   `tests/integration/rpc-privilege-boundary.test.ts`.

Client-claimed role state is never trusted at either layer — both re-derive
the caller's identity server-side.

## No generic settings writer

There is no `updatePlatformSetting(key, value)`. Every mutation is a
specific, typed, explicitly-named Server Action calling a specific,
explicitly-named RPC with explicitly-named parameters — the same
discipline the pre-existing `lib/actions/settings.ts` already used for its
3 legacy mutations. A future setting requires a new, deliberate line of
code in three places (RPC parameter, repository wrapper, Server Action) —
never a config value flowing straight from a client payload into a SQL
`UPDATE`.

## Validation

Every numeric/text field is validated in TypeScript (`lib/actions/
brohda-settings.ts`) before any RPC call, mirroring each field's own
database CHECK constraint (added or already existing on `platform_settings`
— see the R12 migration for the 4 new ones: prediction cutoff, and the 3
non-empty notification-copy pairs). The database constraint is defense in
depth, not the only defense: the TypeScript layer exists so a bad input
gets a clean, specific, operator-readable error instead of a raw Postgres
error, and so an invalid value in a multi-field domain never causes a
*partial* write — a single bad field rejects the whole atomic group before
the RPC is ever called.

## Cross-setting validation

Audited explicitly (per this milestone's own requirement) and no genuine
cross-field ordering invariant was found among the fields this milestone
exposes. The one pair that looks related at a glance — `pick_lock_minutes_
before_kickoff` and `prediction_cutoff_minutes_before_close` — actually
gates two different mechanisms against two different reference timestamps
(kickoff vs. the Market's own close time), so no relationship between them
needs to be enforced. This is a reasoned "no," not an oversight: no
artificial constraint was invented just to have one.

## Concurrency / versioning

`platform_settings` is a genuine singleton row. Every `update_*_settings`
RPC reuses its existing `updated_at` column as the optimistic-concurrency
token — no new version column was added. Each RPC locks the row (`for
update`), compares the caller's `p_expected_updated_at` against the current
value, and returns a distinct `'conflict'` outcome (never a silent
overwrite, never an exception) if they differ, alongside the *current*
settings so the caller can refresh and retry. The UI surfaces this as an
amber, clearly-worded notice ("Someone else changed these settings since
you loaded this page...") distinct from an ordinary validation error, and
refreshes that section's fields to the current values.

**Accepted trade-off:** because all 9 domains share one row's own
`updated_at`, a change to *any* domain bumps the token every other domain's
already-open form is holding — an admin editing Notifications while another
admin saves Predictions will see a conflict on their next Save, even though
the two changes don't overlap. This is an explicit, accepted consequence of
reusing the existing singleton architecture rather than a bug: the
alternative (a version column per domain, or splitting `platform_settings`
into 9 tables) is a real architectural change this milestone chose not to
make for a UX edge case with a simple, correct resolution (reload, reapply
your own change). `tests/integration/admin-brohda-settings.test.ts` proves
both halves: a stale write on the *same* domain conflicts and applies
nothing, and a fresh token on a *different* domain never gets a spurious
conflict from another domain's own recent write.

## Audit history

Every successful `update_*_settings` call inserts one `audit_logs` row
**inside the same Postgres transaction** as the `platform_settings` update
— `actor_id`, `action` (e.g. `settings.monetary_updated`), `before`, and
`after`, the latter two scoped to just that domain's own fields (never the
whole 48-column row). This is a deliberate improvement over the
pre-existing legacy settings pattern (`lib/actions/settings.ts`), which
calls `writeAuditLog()` as a *second*, separate write after its own
`.update()` — non-atomic, and out of this milestone's authorized scope to
retrofit. `audit_logs` itself is already hard append-only platform-wide (a
`forbid_audit_log_mutation` trigger blocks `UPDATE`/`DELETE`
unconditionally, even for `service_role`) and already `SELECT`-restricted
to `super_admin` via RLS — R12 relies on both guarantees rather than
re-implementing them. A read-only history view at `/admin/settings/brohda/
history` lists every `platform_settings` audit entry, newest first, with
the actor's resolved display name and the before/after diff.

One documented, intentional (not accidental) behavior: saving a domain's
form with *unchanged* values still writes a new audit row, `before ===
after`. "Save" always means "apply these values now," exactly matching the
pre-existing legacy settings pattern's own behavior — it does not silently
diff and skip.

**Fixed during this milestone:** `update_notification_settings()`'s audit
`before`/`after` was initially written as `to_jsonb(v_before) - 'id' -
'updated_at' - 'updated_by'` — a shortcut that, unlike every other domain's
explicit `jsonb_build_object(...)`, captured the *entire* 48-column row
instead of just the Notifications domain's own 10 fields. Caught by this
milestone's own integration test and corrected in a new migration
(`20260101000160_fix_notification_settings_audit_scope.sql`) rather than
editing the already-applied original, matching this project's own
established migration discipline.

## Financial settings and snapshot semantics

The P2P settlement fee (`p2p_fee_bps`) is the one field in this milestone
with real financial-contract weight. R10 already established that
`accept_monetary_proposal()` snapshots the *current* platform fee onto
`monetary_positions.fee_bps` the moment a Position commits, and that
`settle_monetary_position()` reads only that snapshot, never the live
config, when computing the actual fee charged. R12 changes nothing about
that mechanism — it only adds an admin-facing way to change the platform
rate going forward. The guarantee this milestone re-verifies, end-to-end,
through its *own* new admin path specifically (not just re-trusting R10's
own tests): change the fee via `updateMonetarySettingsAction` →
`update_monetary_settings` RPC, commit a Position, change the fee again via
the same path, settle the *original* Position, and confirm its charged fee
still matches the *first* rate — proven in both
`tests/integration/admin-brohda-settings.test.ts` and
`tests/e2e/admin-brohda-settings.spec.ts`. A fee change is never
retroactive, by construction, not by convention.

## Feature-disable semantics

Disabling a feature switch (`monetary_p2p_enabled`, `call_bs_enabled`,
`market_ingestion_enabled`, `post_publication_enabled`,
`community_distribution_enabled`) only ever blocks *new* activity of that
kind. None of these RPCs, and none of the settings themselves, have any
mechanism to reach into in-flight state:

- Disabling Monetary P2P blocks new proposals and new acceptances. An
  already-committed Position always settles normally — `settle_monetary_
  position()` has no feature-flag check at all, by design, so there is
  nothing for this setting to interfere with. Reservations always resolve.
  Re-verified through the admin path in both the integration and E2E
  suites.
- Disabling Call BS blocks new free Challenges. An already-PENDING/ACCEPTED
  Challenge's own lifecycle is untouched.
- Disabling market ingestion or post publication stops new Markets/Posts
  from being created or published; existing ones are untouched.
- Disabling Community distribution stops new Post-to-Community fan-out;
  existing relationships are never deleted or rewritten.

This is stated explicitly in each toggle's own UI copy (and, for Monetary
P2P specifically, gated behind a `window.confirm()` before a disabling save
commits — the one deliberately "are you sure" moment in this surface,
reserved for the one switch with the highest blast radius).

## Secrets boundary

No secret of any kind lives in `platform_settings`, and this milestone adds
none. Provider API keys/enablement (`API_NFL_ENABLED`, `API_NFL_KEY`) stay
environment variables, entirely outside this admin surface's reach —
changing them still requires redeploying, by design, because they are
infrastructure/vendor configuration, not product policy a human should be
able to flip from a web form.

## Environment-variable classification

- `API_NFL_ENABLED` / `API_NFL_KEY` — PROVIDER-SECRET CONFIGURATION.
  Deliberately left as environment variables.
- `DEFAULT_TIMEZONE` (`lib/analytics/timezone.ts`'s
  `DEFAULT_ANALYTICS_TIMEZONE`) — legacy-pool-domain analytics scope,
  already resolved as out of scope in R11; untouched here.

Neither was migrated into `platform_settings` — doing so would have been
scope creep beyond what R12's own task authorized, and neither is a
product-policy lever a non-technical operator would reasonably expect to
flip without a deploy.

## Hard-coding audit

Confirmed, across the repository, what is and is not configurable after
this milestone:

1. **Prediction eligibility policy** (`lib/predictions/policy.ts`) — fully
   configurable via the Predictions domain; confirmed genuinely live,
   fail-safe product policy, not diagnostic-only flags.
2. **Prediction-graded notification copy** — the *only* configurable
   notification copy anywhere in the codebase, via the Notifications
   domain.
3. **Call BS notifications** — 100% hard-coded plain TypeScript strings.
   Not exposed; no product ask to change this.
4. **Monetary proposal/settlement notifications** (`lib/notifications/
   monetary-proposals.ts`, `lib/notifications/monetary-settlements.ts`) —
   100% hard-coded. Not exposed.
5. **R5's Pick-eligibility status gate** — see "Unresolved product
   decisions" below; explicitly NOT exposed by this milestone's own
   instruction.
6. **Legacy pool fee defaults, registration, payment methods, provider
   status** — already configurable on the pre-existing `/admin/settings`
   page, untouched by this milestone.
7. **`post_primary_market_template_priority`** — a hard-coded enum
   ordering; not exposed (see above).
8. **Deferred streak columns** (`user_profiles.prediction_current_streak`/
   `prediction_best_streak`) — reserved, unused, untouched; not a
   `platform_settings` concern.

## Unresolved product decisions

**R5's Pick-eligibility gate.** `lib/predictions/policy.ts` (or its R5-era
equivalent) hard-codes eligibility to a Market/Game in the `NOT_STARTED`
lifecycle state only — there is no `platform_settings` column governing
which lifecycle states accept a new Pick, and this milestone's own
instructions explicitly forbid inventing one as a side effect of R12. This
is reported here as **NOT EXPOSED — PRODUCT DECISION REQUIRED**: whether
Picks should ever be allowed against, say, an IN_PROGRESS Game is a real
product question this milestone deliberately did not answer, and did not
let block the rest of R12's own scope, exactly as R12's own task text
permitted.

## Extension pattern

Adding a 10th setting to an existing domain: add the `platform_settings`
column (+ CHECK constraint if it has a range), add the parameter to that
domain's `update_*_settings()` RPC signature and its `jsonb_build_object`
audit scoping, add the field to the domain's TypeScript interface
(`lib/admin-settings/types.ts`) and repository mapper (`lib/admin-settings/
repository.ts`), add TypeScript validation in the matching Server Action
(`lib/actions/brohda-settings.ts`), add a `SettingRegistryEntry` to
`lib/admin-settings/registry.ts`, add the UI field to that domain's section
component (`app/(admin)/admin/settings/brohda/settings-sections.tsx`).
Adding an entirely new 10th domain follows the same shape once more, plus a
new RPC and a new section component. The "configuration discovery"
integration test will fail loudly if a new column is added to
`platform_settings` without a corresponding `SETTINGS_REGISTRY` or
`NOT_EXPOSED_SETTINGS` entry — the fastest way to notice a forgotten
setting.

## R13 boundary

This milestone does not begin R13. No abuse/security tooling, no new
reputation algorithm, no consumer-facing redesign, and no financial
accounting change of any kind was introduced here — only a management
surface over policy that already existed. Anything past that — a
finer-grained `admin`/`super_admin` split for specific settings, per-domain
concurrency tokens, resolving the R5 status-eligibility question, exposing
`discovery_fresh_within_minutes`/`discovery_stale_within_minutes` — is a
new, explicit product decision for a future milestone, not something this
one should be read as having quietly started.
