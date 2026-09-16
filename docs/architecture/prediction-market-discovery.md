# Prediction Market Discovery — Milestone 2

**Status**: Implements `docs/PRODUCT_TRANSFORMATION_ROADMAP.md` Milestone 2 — Prediction Market Discovery Experience, and only that milestone.

**Milestone 2 is read-only discovery. No Brohda Prediction, financial position, order, wallet, or execution capability exists on this surface.** No code introduced by this milestone moves money, submits an order, or creates a position — the only writes are to the discovery taxonomy configuration itself (categories/mappings), made by a super-admin through the protected admin surface.

## 1. Milestone scope

Users can open `/markets`, browse real normalized questions with live YES/NO probabilities, filter by a founder-configured category taxonomy, and open a market's detail page — all reading Brohda's own normalized data (Milestone 1's `markets` table plus this milestone's taxonomy tables). Nothing here calls Polymarket directly, and nothing triggers ingestion.

## 2. Consumer Market view model

`lib/prediction-markets/discovery/types.ts` — `DiscoveryMarketCard`/`DiscoveryMarketDetail`. Deliberately separate from `MarketRecord` (Milestone 1's internal repository shape, which still carries `provider`/`providerMarketId`/`providerEventId`/`categoryTags`) and from `NormalizedMarket` (the provider-adapter contract). `lib/prediction-markets/discovery/view-model.ts`'s `toDiscoveryMarketCard`/`toDiscoveryMarketDetail` are the *only* functions allowed to bridge the two — verified in `tests/unit/prediction-markets/discovery/view-model.test.ts` by asserting the output object's keys never include `provider`, `providerMarketId`, `providerEventId`, `categoryTags`, or raw metadata, and that the raw provider id strings never appear anywhere in the serialized output.

## 3. Configurable taxonomy architecture

Per this milestone's core principle ("hard-code invariants, configure policy"): category taxonomy is **database-backed data**, never a TypeScript union. No file in this codebase contains a literal list of category names — `lib/prediction-markets/discovery/repository.ts`'s `listEnabledCategories()`/`listAllCategories()` are the only way any code learns what categories exist, and every consumer component (`CategoryTabs.tsx`) renders purely from whatever that call returns.

## 4. Category data model

`supabase/migrations/20260101000137_discovery_taxonomy.sql` — `discovery_categories`: `id`, `slug` (unique), `display_name`, `description`, `display_order` (a plain integer — no drag-and-drop, per the roadmap's explicit "a simple explicit order number is acceptable"), `enabled`, `icon_key`, timestamps.

## 5. Provider → Brohda category mapping

`discovery_category_provider_mappings`: `(category_id, provider, provider_tag, enabled)`, unique on `(provider, provider_tag)`. Deliberately simple exact-match, case-insensitive lookup (`lib/prediction-markets/discovery/category-mapping.ts`'s `computeMarketCategoryIds`) — no ML, no semantic matching, no rules engine, matching the roadmap's explicit prohibition. A market's raw tags (captured by Milestone 1's ingestion into `markets.provider_metadata._categoryTagsExtracted`, exposed internally as `MarketRecord.categoryTags`) are matched against enabled mapping rows; an unmapped tag is silently skipped, never a crash — proven in `tests/unit/prediction-markets/discovery/category-mapping.test.ts` with an intentionally invented, non-standard category name to demonstrate the mechanism carries no assumption about what categories exist.

**Note on Milestone 1 real-data field**: live validation (the Polymarket sanity check) found the Gamma `/markets/keyset` market object does not itself carry a `tags` field — category tags are more likely sourced from the associated event object in a future ingestion refinement. `_categoryTagsExtracted` is currently populated only when a market response happens to include a `tags` field; this milestone's mapping mechanism is fully correct and tested but has no real Polymarket data to categorize yet. Not a Milestone 2 defect — flagged as a known limitation (§21) for whoever revisits Milestone 1's ingestion.

## 6. Category admin/configuration flow

`app/(admin)/admin/discovery-categories/page.tsx`, gated by `requireDiscoveryTaxonomyManager()` (`lib/prediction-markets/discovery/authorization.ts`) — a named capability boundary that resolves against **configured** policy (`capability_policies`, migration `20260101000140`), whose seeded value is super-admin-only (the same tier as `platform_settings`' toggles, since taxonomy is platform-wide product configuration affecting every consumer's experience, not ordinary content management, which uses the looser `requireAdminOrAbove()` elsewhere, e.g. fixtures/events). Neither the page nor any action contains the allowed-role list — see §14. Plain server-rendered tables (no DataTable framework), Server Actions (`lib/actions/discovery-categories.ts`) for create/update/enable-disable/reorder/delete on categories, create/enable-disable/delete on mappings, and update on sort-policy rules, each writing to `audit_logs` via `writeAuditLog` with `before`/`after` snapshots — mirroring `app/(admin)/admin/invitations/`'s established convention exactly.

## 7. Consumer discovery eligibility

`lib/prediction-markets/discovery/eligibility.ts`. Two distinct functions:
- `isFeedEligible` — the main browse feed: only markets with a genuine question and `ACTIVE` consumer status.
- `isDetailReachable` — the detail page: `ACTIVE`, `CLOSED`, or `RESOLVED` (anything with *some* consumer status) — a bookmarked market that has since closed still renders honestly rather than 404ing.

## 8. Distinction from Milestone 1 ingestion eligibility

```
Provider universe -> Milestone 1 ingestion eligibility (lib/prediction-markets/eligibility.ts)
-> normalized Brohda market catalog -> Milestone 2 discovery eligibility (lib/prediction-markets/discovery/eligibility.ts)
-> consumer feed
```
A market can be correctly, validly ingested and still be excluded from today's discovery feed (e.g. it has since closed). Milestone 2 never re-validates anything Milestone 1's ingestion already guarantees (schema shape, provider id presence) — it only asks the consumer-facing question of "should this appear to a browsing user right now."

## 9-10. Freshness policy and where it lives

`lib/prediction-markets/discovery/policy.ts`. Three states — FRESH / STALE / UNAVAILABLE — from two signals: sync age (`markets.last_synced_at`) and whether a usable price exists at all (missing price always wins, regardless of recency).

**Configuration decision, made explicitly per the standing hard-coding rule**: freshness thresholds (`freshWithinMinutes`/`staleWithinMinutes`) are stored on the existing `platform_settings` singleton (`supabase/migrations/20260101000138_discovery_freshness_settings.sql`) — reusing the exact table/pattern already established for `registration_enabled`/`paid_pools_enabled`/`free_pools_enabled`, not a new framework. `classifyFreshness` itself stays a pure function taking the policy as an explicit parameter (testable without any database), and `getFreshnessPolicy()` is the one function that reads it — deliberately via the service-role admin client, not the cookie-bound RLS client, so this repository-layer function works from any context (a script, a future background job, a test) rather than only inside a live HTTP request. Proven configurable end-to-end (not just in principle) in `tests/integration/discovery-categories.test.ts`'s "freshness classification is genuinely configurable via platform_settings" test — it flips a market from STALE to FRESH purely by updating a database row, no code change.

## 11-12. Probability semantics and rounding

`lib/prediction-markets/discovery/probability.ts`'s `formatProbabilityPercent` is the *only* place a 0-1 price becomes a whole-number consumer percentage. Rounding: standard round-half-up (`Math.round`), matching this codebase's existing `CommunitySplit.tsx` convention. Never derives one side from the other — YES and NO are formatted completely independently, and are never forced to sum to 100 (tested explicitly with prices that don't sum to 1).

## 13. Sorting/ordering

`lib/prediction-markets/discovery/ordering.ts`'s `compareDiscoveryMarkets` applies the configured, enabled `discovery_sort_policy` rules in priority order — default: freshness tier first (FRESH before STALE before UNAVAILABLE), then soonest-close-time, then liquidity as a final tiebreaker. No personalization, no weighted scoring formula — only priority/direction/enabled per fixed criterion is configurable. See §14 (updated after a remediation pass — the priority sequence was initially left as a code-only decision, then corrected to be data-driven).

## 14. Configuration vs hard-coded invariant decisions (hard-coding audit)

Per the standing rule ("hard-code invariants, configure policy"), every new constant/rule/threshold introduced by this milestone, classified explicitly. **This table was revised once**, in a dedicated remediation pass, after an initial audit incorrectly treated two mutable-policy items as sufficiently handled by "centralized in code" — see the two flagged rows below for what changed and why.

| Item | Classification | Where it lives | Why |
|---|---|---|---|
| Category taxonomy (name/slug/order/enabled/icon) | Configurable product policy | `discovery_categories` table, admin CRUD | Explicitly demanded by the roadmap; genuinely changes through normal operation. |
| Provider tag → category mapping | Configurable product policy | `discovery_category_provider_mappings` table, admin CRUD | Same reasoning; also isolates provider vocabulary from consumer code. |
| Freshness thresholds (fresh/stale window) | Configurable operational policy | `platform_settings.discovery_fresh_within_minutes`/`discovery_stale_within_minutes` | An operator may reasonably retune staleness tolerance without a deploy (e.g. if ingestion cadence changes) — moved to DB during this milestone's own hard-coding audit; see migration `20260101000138`. |
| **Discovery ordering priority/direction/enabled** (which of FRESHNESS/CLOSE_TIME/LIQUIDITY applies, in what order, ascending or descending) | Configurable operational policy — **remediated** | `discovery_sort_policy` table (migration `20260101000139`), admin CRUD via `SortRuleControls` | **Correction**: the first audit pass classified the whole ordering *algorithm* as Tier-4 centralized code and stopped there, missing that the priority *sequence* itself is exactly the kind of thing a founder could reasonably want to change (e.g. close-time-first instead of freshness-first) without a deploy — "centralized in code" is not sufficient justification when the value is mutable policy, which this genuinely was. Fixed by moving priority/direction/enabled to `discovery_sort_policy`, proven configurable end-to-end in `tests/integration/discovery-categories.test.ts`. |
| Supported sort primitives (`FRESHNESS`, `CLOSE_TIME`, `LIQUIDITY` — the closed set of things that can be sorted on at all) | True invariant (architectural) | `lib/prediction-markets/discovery/ordering.ts`'s `extractSortValue` switch | This is the one part of ordering the remediation itself says may stay hard-coded: adding a fourth sortable signal requires teaching the extractor a new case, a genuine code capability — not a value a founder tunes. |
| Category-tag matching algorithm (exact, case-insensitive) | True invariant (architectural) | `lib/prediction-markets/discovery/category-mapping.ts` | The *mechanism* is a Milestone 2 design decision the roadmap explicitly pins ("no ML/semantic matching"); the *data* it operates on is fully configurable (§5). |
| Discovery route path (`/markets`, `/markets/[id]`) | True invariant (architectural) | Next.js file-based routing | A route's URL is inherently code-defined in this framework; not a product-policy axis. |
| **Taxonomy-management authorization policy** (which role may manage categories/mappings/ordering) | Configurable authorization policy — **remediated twice** | `capability_policies` table (migration `20260101000140`), read by `lib/auth/capabilities.ts`, asked for by `requireDiscoveryTaxonomyManager()` | **Correction 1**: the first audit pass classified admin gating as a "true invariant" on the reasoning that authorization itself is architectural — true, but it conflated *that an authorization check must exist* (a real invariant) with *which specific role satisfies it* (mutable policy). Fixed by routing every taxonomy Server Action and the admin page through `requireDiscoveryTaxonomyManager()`. **Correction 2**: that centralization still left the answer — `requireSuperAdmin()` — written in source, so changing it remained a code edit plus a deployment, which the standing rule does not accept for mutable policy. The allowed-role list now lives in `capability_policies` and is changed through `pnpm set-capability-policy`. Proven end to end in `tests/integration/capability-policy.test.ts`: `admin` gains and loses taxonomy access by writing a row, with no source change. |
| That an authorization check exists at all for taxonomy mutation, and that it fails closed | True invariant (architectural security decision) | `requireDiscoveryTaxonomyManager()` → `requireCapability()`; authentication still via `lib/auth/session.ts`'s `requireUser()` | Matches the standing rule's own example ("unauthorized client roles cannot mutate protected records") — *some* gate must exist, and a missing/unreadable/malformed policy must deny rather than widen; which role satisfies the gate is the policy layer above. |
| Capability KEYS (`discovery_taxonomy_management` — the closed set of capabilities that exist at all) | True invariant (architectural) | `APP_CAPABILITIES` in `lib/auth/capability-policy.ts` | Same reasoning the remediation already accepted for sort primitives: a capability only means something because code enforces it, so adding one is a genuine application change, not a value a founder tunes. |
| Role NAMES this build understands (`super_admin`/`admin`/`player`) | True invariant (architectural) | `APP_ROLES` in `lib/auth/capability-policy.ts`, from which `UserProfile['role']` is derived | The role vocabulary is enforced throughout the app (RLS policies, `guards.ts`); a policy naming a role this build does not know is treated as malformed and denies, rather than being partially honored. |
| Zod validation bounds (slug/name length limits) | Provider-specific/structural implementation detail | `lib/validations/discovery.ts` | Data-integrity bounds, not business policy — reviewed and judged not to warrant configuration (configuration theater for a value nobody has asked to tune). |
| `PREDICTION_MARKETS_POLYMARKET_ENABLED` (Milestone 1, unaffected) | Configurable operational policy (environment) | `.env.local`/`.env.example` | Pre-existing, unaffected by this milestone — confirmed still correctly environment-gated. |

**Copy/labels**: reviewed for duplication per the standing rule's "no scattered magic values" guidance — the "pricing isn't available" message was found genuinely duplicated (a live bug: a card with no price rendered it twice, once from an inline branch and once from `FreshnessNote`) and consolidated into `DiscoveryStatusPill.tsx`'s `FreshnessNote` as the single source, with `MarketCard`/the detail page each rendering it exactly once. No other new consumer string is duplicated across components; each of the small, fixed set of empty-state/status strings is judged not to need a CMS layer at this stage (roadmap's own "do not over-engineer a full CMS for every sentence").

**Founder/admin changes requiring a deployment after this milestone**: none, except the true architectural items in the table above (route paths, the matching algorithm's mechanism, the closed sets of sort primitives / capability keys / role names) — all genuinely require a code change by their nature, not because mutable policy was left embedded. Changing *who* may manage discovery taxonomy is no longer among them.

## 14a. Capability policy (how taxonomy authorization is configured)

```
Server Action / admin page
  -> requireDiscoveryTaxonomyManager()            lib/prediction-markets/discovery/authorization.ts
       -> requireCapability("discovery_taxonomy_management")   lib/auth/capabilities.ts
            -> requireUser()                      lib/auth/session.ts   (authentication, unchanged)
            -> loadCapabilityPolicy()             capability_policies row, service-role read
            -> policyAllowsRole()                 lib/auth/capability-policy.ts (pure decision)
```

One table, one row per capability, one column of allowed role names:

| capability | allowed_roles |
|---|---|
| `discovery_taxonomy_management` | `{super_admin}` (seeded default) |

Deliberately **not** a generic RBAC system: no permission grammar, no
per-user grants, no roles table, no inheritance. The capability keys and the
role vocabulary stay code-defined (§14); the only configurable axis is which
of those roles satisfy which capability — the same split `discovery_sort_policy`
already makes between fixed sort primitives and their configured order.

**Changing it** (no code change, no deployment):

```
pnpm set-capability-policy --show
pnpm set-capability-policy --capability discovery_taxonomy_management --roles super_admin,admin
pnpm set-capability-policy --capability discovery_taxonomy_management --roles super_admin
```

A script rather than an admin screen, on purpose: this codebase already keeps
privilege decisions (role assignment, the first super admin) behind the
service-role key rather than in the admin panel, and a UI that let an admin
widen their own authorization would be a privilege-escalation surface. Every
change writes an `audit_logs` row (`capability_policy.updated`, with before
and after). `capability_policies` has RLS enabled with no anon/authenticated
policy at all and grants only to `service_role`, so ordinary users cannot read
this configuration, let alone write it.

**Fail closed.** `loadCapabilityPolicy()` returns `null` — and `policyAllowsRole(null, …)`
denies — when the row is missing, the query fails, or the stored value cannot
be fully interpreted (a typo, a non-list, or a role name this build does not
know). One unrecognized entry invalidates the whole row rather than being
dropped from it: a policy that cannot be read in full is unknown, not
narrower, and there is no fallback to a broader role anywhere in the path. An
empty `allowed_roles` is well-formed configuration that permits nobody. The
policy is re-read on every check, so a change takes effect without a restart.

No SECURITY DEFINER function was added — consistent with this project's two
prior EXECUTE-grant-drift incidents and the Gate 1A remediation.

## 15. Feed data flow

```
app/(app)/markets/page.tsx (Server Component)
  -> lib/prediction-markets/discovery/repository.ts's getDiscoveryFeed(categorySlug?)
       -> lib/prediction-markets/repository.ts's listActiveMarkets() [1 query]
       -> listEnabledMappingRows() + listEnabledCategories() [2 queries, category index built once]
       -> getFreshnessPolicy() [1 query]
       -> per-market: isFeedEligible -> computeMarketCategoryIds -> toDiscoveryMarketCard
       -> compareDiscoveryMarkets sort
  -> components/discovery/{CategoryTabs,MarketCard}.tsx
```
Four queries total regardless of market count — no N+1.

## 16. Market detail data flow

```
app/(app)/markets/[id]/page.tsx -> getMarketDetail(id)
  -> getMarketById(id) [1 query]
  -> listEnabledMappingRows() + listEnabledCategories() + getFreshnessPolicy() [3 queries]
  -> isDetailReachable -> computeMarketCategoryIds -> toDiscoveryMarketDetail
```
`notFound()` (Next.js's standard 404) for anything `getMarketDetail` returns `null` for — a genuinely nonexistent id and an INACTIVE/ARCHIVED market are indistinguishable to the visitor, by design.

## 17. Provider isolation

Every consumer-facing read in this milestone goes through `lib/prediction-markets/discovery/repository.ts`, which itself only calls Milestone 1's own repository (`lib/prediction-markets/repository.ts`) and the new taxonomy tables — never the Polymarket adapter, never `fetch` against `gamma-api.polymarket.com`. `Brohda UI -> Brohda server/domain read layer -> normalized Brohda database`, with no path from a React component to Polymarket.

## 18. Empty/error states

- No markets at all / no markets in a category: `EmptyFeedState` (reused from the legacy feed) with discovery-specific copy, no technical terms.
- Disabled or unknown category slug: `getDiscoveryFeed` returns `[]` rather than throwing — renders the same empty state, never an error page.
- Market with no usable price: renders "Pricing isn't available right now." — never a fabricated percentage, never `0%`.
- Stale price: a small, honest "may be a little out of date" note alongside the real numbers.
- Nonexistent/unreachable market detail: Next.js's standard `notFound()`.

## 19. Security/RLS model for configuration

Both new tables (`discovery_categories`, `discovery_category_provider_mappings`) have RLS enabled with **no policy for `anon`/`authenticated`** — deny-by-default, matching Milestone 1's own `markets` posture exactly. `grant select, insert, update, delete` to `service_role` only. No `SECURITY DEFINER` function was introduced (verified: neither new migration contains a `create function` statement) — every admin mutation goes through an ordinary Server Action using the existing service-role admin client, per this project's own established preference (and its documented history of two prior EXECUTE-grant-drift incidents on functions). Gate 1A's privilege-hygiene regression test (`tests/integration/table-privilege-hygiene.test.ts`) was extended to cover both new tables and remains green.

## 20. Accessibility decisions

- `DiscoveryStatusPill`/`FreshnessNote` always pair color with explicit text — YES/NO meaning and status/freshness are never color-only.
- `CategoryTabs` renders plain `<Link>` elements (real anchors), not a custom JS tab widget — keyboard/screen-reader accessible by default, with `aria-current="page"` marking the active one.
- All interactive elements use semantic roles (`link`, `button`) with real accessible names (the question text, category display name).
- No icon is ever the sole representation of a category — `icon_key` is stored for future use but the current UI renders the text `display_name` unconditionally.
- Mobile-first: the feed/detail pages inherit `app/(app)/layout.tsx`'s existing responsive shell (bottom-nav clearance, safe-area padding) with no extra per-page work.

## 21. Known limitations

- Milestone 1's real Polymarket ingestion does not currently populate `_categoryTagsExtracted` with real tag data for `/markets/keyset` responses (see §5) — the mapping mechanism is fully built and tested, but has no live provider-sourced categories to work with yet.
- No live manual browser verification was possible in this development environment (the preview/browser tooling was anchored to an unrelated project directory) — functional verification instead relied on the full automated suite, including a comprehensive new Playwright E2E spec exercising the actual rendered UI in a real browser via a correctly-scoped `next dev` server.
- The selective-ingestion pagination inefficiency documented in Milestone 1's own architecture doc (§15 there) is unchanged and out of scope here — Milestone 2 never triggers ingestion at all (roadmap STEP 19/20).
- Ordering has no personalization or weighting yet, by design (roadmap STEP 14).
- Resolution display (§16 of the roadmap) is built correctly but functionally unexercised with real data, since Milestone 1 never populates `resolved_outcome` yet (documented there as its own limitation).

## 22. Explicit Milestone 3 boundary

Nothing in this milestone creates, references, or assumes a `Prediction` record, an `Order`, a `Trade`, a `Position`, a wallet, or any financial mutation. `docs/PRODUCT_TRANSFORMATION_ROADMAP.md` Milestone 3 (Brohda Prediction Layer) is the next milestone to introduce the permanent social prediction object — independent of, and layered on top of, this milestone's read-only `Market` domain, exactly as this document's Market view model was designed to allow.
