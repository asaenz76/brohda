# NFL Integration — Architecture Note & Implementation Plan

**Scope**: read-only investigation + proposed plan, grounded in the actual `brohda-rc1`+ codebase (current `main`, commit `595702c` and later). No code, migrations, or config changed to produce this note.

**Context correction**: this repo now lives at `/Users/andresaenz/Claude/PollPools:Brohda` (renamed from `/Users/andresaenz/Claude/PollPools` since the last session — confirmed via matching git remote/history). All paths below are relative to that repo.

---

## tl;dr

Adding NFL is a **much smaller lift than the racing clone**, because NFL fixtures fit Brohda's existing two-team fixture/pool shape almost exactly — no schema redesign needed. The real work is: a new provider client (`API-NFL`, sibling to the existing `API-Football` integration), widening ~4 files from single-provider to provider-aware, a small NFL competition config, and 2–3 new grading templates. **7,500 requests/day is very generous** for NFL's fixture volume — likely 10–50x more than actually needed even at peak season, based on direct comparison against current production usage.

---

## 1. Quota Analysis (your specific question)

**Direct answer: yes, 7,500 req/day is enough — comfortably.**

Reasoning, grounded in live production data pulled just now (2026-08-12, read-only):

- Current API-Football usage in production: **~64 requests/hour (~1,536/day at current rate)**, tracking **904 non-terminal fixtures** across 14 soccer competitions (`fixtures` table, `internal_status not in ('COMPLETED','CANCELLED','ABANDONED','AWARDED')`).
- NFL has a radically smaller footprint: 32 teams, a 17-game regular season played over 18 weeks (272 games total), ~4 preseason games/team, 13 playoff games — roughly **350 games across an entire season**, and never more than ~16 games "live or upcoming soon" in any given week. That's two to three orders of magnitude fewer concurrently-tracked fixtures than the current soccer footprint.
- **API-NFL is a separate subscription/quota from API-Football** on api-sports.io — this 7,500/day is entirely independent, not a shared pool with the existing football quota. No risk of NFL polling starving football, or vice versa.

**One real caveat, not a live problem right now but worth stating plainly**: production previously had a documented, disclosed incident (`SECURITY_RPC_PRIVILEGE_INCIDENT_REPORT.md`'s root-cause section, and the "Cron batching" item in `PUBLIC_LAUNCH_RELEASE_REPORT.md`'s Known Deferred Items) where the `sync-fixtures` cron overlapped itself — each run took 4–5 minutes but fired every 1 minute with no lock, so concurrent runs stacked up and multiplied request volume to **~1.18 million requests/day** at its worst. I checked live production just now: this appears resolved — `sync-fixtures` currently completes in 500–1000ms per run (`background_jobs` table, last 5 runs), cleanly spaced one per minute, zero errors. I'm citing this as **historical context, not a current live risk** — but the underlying architecture (a cron with no overlap guard) is the same code path a new `sync-fixtures-nfl` job would reuse. Recommend adding an explicit overlap guard (e.g., a `pg_try_advisory_lock` at the top of the cron handler, or checking for an already-`running` `background_jobs` row before starting) as a small, cheap hardening step *before* a second provider makes a recurrence twice as expensive. This is a genuinely good moment to fix it, not a blocker to starting NFL work.

---

## 2. Data Model Fit — the key finding

Unlike the racing clone (which needed a full new domain model because races have N competitors), **NFL fits the existing `fixtures`/`pools`/`pool_options`/`entries` schema with zero structural changes.** Evidence:

- `fixtures.provider text default 'api_football'`, unique on `(provider, external_fixture_id)` — the schema was already built anticipating more than one provider. Same pattern on `teams`/`leagues` (`unique (provider, external_id)`). Adding `provider = 'api_nfl'` rows requires no migration.
- `fixtures.regulation_home_score`/`regulation_away_score` are plain integer columns — not soccer-typed. NFL's final score (touchdowns/field goals/safeties summed, including any overtime — NFL doesn't have a separate "extra time" phase the way soccer does) maps directly onto these two columns with no semantic mismatch, despite the "regulation" name being a soccer-era naming choice.
- `pool_options`/`entries`/`entries` cardinality and the entire settlement chain (`create_pool_entry`, `confirm_pool_settlement`, `confirm_pool_refund`, `apply_wallet_transaction`) need **zero changes** — confirmed by direct inspection during the racing-clone investigation; none of these reference fixtures/scores/teams at all.

**What does need to change**, precisely:

| Area | File(s) | Change needed |
|---|---|---|
| Provider client | `lib/sports-data/api-football-provider.ts` | Net new sibling file, `api-nfl-provider.ts`, implementing the same `SportsDataProvider` interface (`lib/sports-data/types.ts`) against API-NFL's endpoints. |
| Status mapping | `lib/sports-data/status-map.ts` | New `CODE_MAP` entries (or a parallel map) for API-NFL's status codes (quarters/halftime/overtime/final — structurally simpler than soccer's HT/ET/PEN split, since NFL has no penalty-shootout-equivalent). |
| Hardcoded single-provider assumptions | `lib/actions/competitions.ts`, `lib/competitions/availability-cache.ts`, `lib/competitions/discovery-sync.ts`, `lib/sports-data/provider-gateway.ts` | Each currently hardcodes the literal string `"api_football"` (confirmed via grep) — needs to become provider-parameterized so both providers get independent circuit-breaker/quota tracking (`provider_request_log` already has a `provider` column, so this is a filter-parameter change, not a schema change). |
| Competition config | `lib/sports-data/supported-competitions.ts` | `SupportedCompetition` currently has **no `provider` field at all** (confirmed — it implicitly assumes API-Football). Needs a `provider: "api_football" \| "api_nfl"` field added, plus a new NFL entry (or entries, if tracking multiple NFL competition types — regular season vs. playoffs). |
| Grading templates | `lib/pools/templates/*.ts` | New template bodies (see §3) — reuse the exact registry mechanism, don't rewrite it. |
| Cron | `app/api/cron/sync-fixtures/route.ts` (or a new sibling route) | Either extend the existing job to loop over both providers, or add a second cron job — see §5. |

Nothing in `wallet_*`, `settlements`, `settlement_payouts`, `entries`, `pool_options`, or any of the money-moving RPCs needs to change at all.

---

## 3. Templates & Scoring Model

Reviewed the existing template pattern directly (`lib/pools/templates/match-result.ts`): every template reads `TemplateFixtureScore` (`homeTeamName`/`awayTeamName`/`regulationHomeScore`/`regulationAwayScore`/halftime scores) via the registry's `gradingRule(data, config) → {result: "YES"|"NO"|"VOID"|"PENDING"}` contract. This is fully reusable for NFL — a new template is close to a copy of `homeTeamToWin`/`awayTeamToWin`, not new machinery.

**One real scoring-model difference worth flagging**: the existing `REGULATION_RESULT` legacy pool type (home win / draw / away win, 3-way) exists because soccer draws are common. NFL games essentially never end in a tie (one 10-minute regular-season OT period; if still tied, the game just ends tied — it happens roughly once every couple of seasons league-wide; playoffs use sudden-death OT and cannot end tied). A 3-way market with an almost-always-dead "tie" option is bad UX and not how real NFL prediction/betting products are structured. **Recommend a 2-way "Moneyline" template (who wins) that VOIDs/refunds in the rare tie case**, rather than reusing the legacy `REGULATION_RESULT` SQL-side pool type — this also matches the registry's own stated direction (its header comment already treats the legacy SQL-graded pool types as something not to extend further).

**V1 template recommendation** (same "smallest first" philosophy as the racing report):
1. **Moneyline — Who wins?** (2-way, void on tie) — directly reuses `homeTeamToWin`/`awayTeamToWin`'s exact logic pattern.
2. **Total Points Over/Under** — directly reuses the existing `matchTotalGoals`-style over/under template shape (`lib/pools/templates/goals.ts`), just renamed and pointed at combined final score instead of goals.

**Fast-follow, not V1**: **Point Spread (against the spread)** — the single most common real-world NFL prediction product, but it needs genuinely new grading logic (compare the actual margin against a configured line, not just "who's ahead") that has no existing analog in the current template system — this is new work, not a reskin, so it's better scoped as its own follow-up than bundled into an initial launch.

**Deferred, per the same reasoning the racing report used for Podium/Head-to-Head**: player props (would need a roster/player-stats data feed — API-NFL likely has one, unconfirmed — and doesn't yet exist for football in this codebase beyond the dormant `team_players` table built for a "player to score" template), first-team-to-score, and anything requiring live in-game event data (`provider_events_payload`, currently only fetched for a narrow class of football templates).

---

## 4. Admin & Player Experience

Because this is a genuine schema-level fit (not a clone), the admin/player surfaces need **content changes, not structural ones**:

- `admin/competitions/*` — works as-is once `SUPPORTED_COMPETITIONS` gains a provider dimension and an NFL entry; the whole import/sync/health/lifecycle workspace is provider-agnostic already (it operates on `league_season_imports` rows, which already key on `provider`).
- `admin/fixtures` — same three modes (by-date/by-competition/by-fixture-ID) work unchanged once the provider client exists; `searchFixturesByDateRange` etc. are already provider-shaped, just single-provider-called today.
- `admin/pools/new` wizard — the fixture-picker step works as-is; `getTemplateEligibility(competitionType)` gains an NFL branch (or simply: NFL fixtures only ever offer the new NFL-specific templates, gated by `fixture.sport === 'american_football'` or similar, mirroring how `WHO_WILL_ADVANCE`/`REGULATION_RESULT` are already gated by League/Cup type today).
- Feed/pool cards/search — `fixtures.sport` is already a free-text column (`default 'football'` — confirmed in the racing investigation); setting it to `'american_football'` (or similar) for NFL fixtures and filtering by it is a data-level change, not a code change, in the Feed's existing sport-derived filter options.
- `MatchIdentity.tsx`'s hardcoded 2-team layout — **no change needed for NFL** (unlike racing) — NFL is still exactly 2 teams, home vs. away, so the existing "VS" component works unmodified.

This is the clearest way to see how much smaller this is than the racing clone: **almost the entire player-facing surface, and most of the admin surface, needs zero changes** — only new copy/config/templates and one new provider client.

---

## 5. Cron

Two reasonable approaches, both compatible with the existing architecture:

- **(a) Separate cron job** (`sync-fixtures-nfl`) — cleanest isolation, own `background_jobs` row, own failure blast radius; slightly more cron-job.org config.
- **(b) Extend the existing `sync-fixtures` job** to loop over both providers — less new cron infrastructure, but couples both providers' failure modes into one job's success/failure signal.

**Recommend (a)** — matches the existing pattern of one job per concern (`lock-pools`/`process-results` are already separate from `sync-fixtures`), and given NFL's much lower fixture volume, its cron can safely run less frequently (e.g., every 5 minutes rather than every 1 minute) without meaningfully hurting freshness, which further reduces any quota-overlap risk discussed in §1.

`CRON_SECRET`, the bearer-auth pattern, and `background_jobs` logging are all already generic and reusable for a new job with no changes.

---

## 6. Environment / Config

New: `API_NFL_BASE_URL`, `API_NFL_KEY`, `API_NFL_ENABLED` — following the exact naming/gating convention already used for `API_FOOTBALL_*` (confirmed pattern: `isEnabled()` checks the flag first, provider is a complete no-op when disabled). No existing env var needs to change.

---

## 7. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Reintroducing the cron-overlap pattern in a new NFL sync job | MEDIUM | Add an explicit overlap guard (advisory lock or `background_jobs`-status check) before writing the NFL cron — cheap, and worth retrofitting onto `sync-fixtures` too while touching this area. |
| Hardcoded `"api_football"` assumptions missed in the 4 files identified | LOW–MEDIUM | The 4 files were found via a direct grep sweep, not exhaustive manual review — worth a second, careful pass through `lib/competitions/*` and `lib/actions/competitions.ts` specifically before writing NFL-specific calls into them. |
| Rare-tie edge case in Moneyline template | LOW | Explicit `VOID` branch, refunded via the existing `confirm_pool_refund` path — no new settlement logic needed, just correct template `gradingRule` output. |
| API-NFL response shape differs from assumptions in this note | MEDIUM | This note reasons from the existing API-Football integration pattern and general NFL domain knowledge, not from having inspected real API-NFL responses — the first concrete implementation step should be a raw request against the real API to confirm field names/shapes before writing the provider client, same as any new integration. |
| `fixtures.sport` filter/copy work missed somewhere in the player UI | LOW | Confirmed `sport` is already read generically in the Feed's filter derivation; a focused smoke-test pass across Feed/pool cards/search with a real NFL fixture in a dev seed would catch anything missed. |

---

## 8. Proposed Implementation Phases

Not implemented — proposed sequence only, following the same subtraction-and-foundations-first spirit as the racing report (here, "foundations first" means "provider + config before templates before UI").

1. **Provider client** — `api-nfl-provider.ts` against the real API-NFL, verified with live test calls; status-map entries; `provider-gateway.ts`/`http.ts` wiring (already generic, just needs a second `provider` value flowing through).
2. **Multi-provider config** — add `provider` field to `SupportedCompetition`, widen the 4 hardcoded-`"api_football"` files to be provider-parameterized, add the NFL competition entry/entries.
3. **Cron** — new `sync-fixtures-nfl` job with an explicit overlap guard (and retrofit the guard onto the existing `sync-fixtures` while in the area).
4. **Templates** — Moneyline (void-on-tie) and Total Points Over/Under, added to the registry alongside the existing 17.
5. **Admin/creation flow** — template eligibility gating, competition workspace verification with a real imported NFL competition.
6. **Player-facing verification** — Feed/search/pool-card smoke test with real NFL fixtures; confirm zero changes needed to `MatchIdentity`/settlement/wallet, as predicted in §4.
7. **Launch verification** — mirror the existing release-runbook rigor (test gate, live smoke test, quota/cron health check) before going live with real NFL pools.

Fast-follow (not part of initial launch): Point Spread template, player props (pending API-NFL data-availability confirmation).

---

## 9. Open Questions

1. Exact API-NFL competition scope for launch — regular season only, or preseason/playoffs too? (Affects §5's cron cadence and §2's competition-config entries.)
2. Should the rare regular-season tie VOID the pool (refund, no fee — matching the existing `NO_WINNING_ENTRIES`-style pattern) or something else?
3. Does API-NFL's PRO plan include the play-by-play/roster data needed for player props, if that's ever wanted as a fast-follow? Unconfirmed from this repo alone — first real API call would answer this.
4. Should NFL fixtures share the existing `admin/fixtures`/`admin/competitions` UI unmodified (as this note assumes), or does the founder want a lighter-weight NFL-specific admin view given the much smaller competition count (one league vs. 14)?

---

## Recommendation

**Proceed.** This is a well-bounded, low-risk addition that reuses nearly the entire product — unlike the racing clone, it needs no new domain model, no new settlement logic, and almost no player-facing changes. The 7,500 req/day API-NFL quota is more than sufficient. The main real work is a new provider client and a handful of new templates, both following patterns the codebase already has fully worked out.
