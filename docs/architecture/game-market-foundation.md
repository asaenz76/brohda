# Game ↔ Market Foundation (Milestone R1)

**Status**: Implements `docs/BROHDA_2_0_MILESTONE_MAP.md` Milestone R1 in full. This document records CURRENT STATE — what actually exists in the repository as of this migration — not a target or aspiration. See `docs/architecture/brohda-2.0-reconciliation.md` for the R0.5 audit this milestone builds on, and `docs/architecture/sports-prediction-network.md`'s numbering note for how this relates to that document's own (older, differently-numbered) milestone labels.

## What R1 is

The structural relationship between sports truth (`fixtures`, the Game object) and objectively gradeable propositions (`markets`, the Market object), plus the deterministic grading logic that reads a Market's result from its linked Game. R1 is schema and pure logic only — it does not ingest any new data, does not create Posts, Communities, Challenges, or touch money in any way.

## Canonical relationship

```
fixtures (Game)  <── fixture_id (real FK, NOT NULL) ──  markets (Market)
```

`fixture_id` is a real foreign key, not a soft reference — deliberately different from `predictions.market_id` (soft, by design). The two cases are not analogous: `fixtures` rows are never deleted anywhere in this codebase (verified: no `delete from fixtures` call exists in the repository; the fixture-archive admin surface hides rows, never deletes them), and `pools.fixture_id` already used a plain, non-cascading FK to `fixtures` as a proven precedent. A soft reference exists to let history outlive a row that might disappear or be restructured; `fixtures` never does either, so a real FK gives genuine integrity at no durability cost.

`fixture_id` and `market_template` are `NOT NULL` on every Market row. The `markets` table was verified empty (`select count(*) from markets` returned 0) in every environment this migration was written against, so this is a direct schema tightening with no backfill — not a nullable column deferred "for a future non-sports provider." R0.5 found no such provider exists or is planned; Brohda is sports-only.

## Market proposition identity

A Market row is one immutable proposition. Structural columns:

| Column | Meaning | Nullability |
|---|---|---|
| `fixture_id` | The Game this proposition is about | NOT NULL |
| `market_template` | `MONEYLINE` \| `SPREAD` \| `TOTAL` | NOT NULL |
| `line_value` | The points line (e.g. 6.5, 47.5), exact `numeric(6,2)` — never a float | NOT NULL for SPREAD/TOTAL, NULL for MONEYLINE |
| `yes_side` | `HOME` \| `AWAY` — which fixture side YES refers to | NOT NULL for MONEYLINE/SPREAD, NULL for TOTAL (YES always means OVER there — a fixed template convention) |

Enforced by `markets_template_shape` (a CHECK constraint) and `markets_sports_proposition_unique` (a unique index over `fixture_id, market_template, coalesce(line_value,-1), coalesce(yes_side,'')`, preventing two rows from ever representing the identical proposition).

**Immutability**: a `before update` trigger (`markets_forbid_identity_mutation`) raises an exception if `fixture_id`, `market_template`, `line_value`, or `yes_side` change on an existing row. Every other column (`status`, prices, `resolved_outcome`, etc.) remains freely updatable — `upsertMarket`'s existing update-in-place behavior for price/status changes is unaffected. **Consequence, by design**: a moved sportsbook line can never be represented as an UPDATE to an existing Market row — it must be a new row. R2 (Sports Market Ingestion) will need to create a new row when a line moves, not update the old one; this migration guarantees that mistake fails loudly rather than silently corrupting a Pick's history.

## Objective grading

Grading no longer depends on `markets.resolved_outcome` (a raw, diagnostic, provider-pass-through field) for any Market with a template. Instead (`lib/predictions/sports-resolution.ts`'s `computeSportsMarketOutcome`, wired into `lib/predictions/grading.ts`'s `decideGradingForMarket`), the result is computed deterministically from the linked Game's final score:

- **MONEYLINE**: YES if the `yes_side` team's score is strictly greater than the other side's. A draw resolves NO (a template rule: MONEYLINE is a strict "wins outright" proposition, not a three-way market) — never VOID.
- **SPREAD**: YES if `yes_side`'s score + `line_value` exceeds the other side's score; NO if less; **VOID (push)** if exactly equal.
- **TOTAL**: YES (over) if the combined score exceeds `line_value`; NO (under) if less; **VOID (push)** if exactly equal.

## Game lifecycle interaction

`fixtures.internal_status` values are handled as follows, evidence-based (`tests/unit/predictions/sports-resolution.test.ts`):

| Fixture status | Grading behavior | Why |
|---|---|---|
| `COMPLETED` | Resolvable — computes the objective result from `home_score`/`away_score` | The only true final |
| `CANCELLED` | `VOID`, deterministically | The Game never happened; no proposition about it can be true |
| `NOT_STARTED`, `LIVE`, `HALFTIME`, `EXTRA_TIME`, `PENALTIES`, `UNKNOWN`, `POSTPONED` | `PENDING` (never graded) | Genuinely not yet resolved, or (POSTPONED) will still happen |
| `SUSPENDED`, `ABANDONED`, `AWARDED` | `PENDING` (never graded) | **Explicitly deferred product policy** — see Open decisions below. Treated conservatively (never falsely graded), not guessed. |

`decideGrading` (the pre-R1 generic ARCHIVED→VOID + `resolvedOutcome`-comparison function) is preserved unchanged for its shared ARCHIVED rule and remains unit-tested in isolation; `decideGradingForMarket` is the function `runGradingJob` actually calls now.

## Open decisions (not resolved by R1, not guessed)

- What SUSPENDED/ABANDONED/AWARDED fixtures should ultimately mean for grading (currently: never graded, held PENDING indefinitely until a founder decision exists).
- Whether a provider score correction that arrives *before* grading (fixture updated while still PENDING) should be trusted as-is — currently yes, since grading always reads live fixture state at decision time; this is a positive property, not a gap, but is worth a founder confirmation.
- Line-value versioning/history display (e.g. showing a user "the line moved after your Pick") is not addressed — R1 only guarantees the old Pick's meaning cannot be corrupted, not that the UI surfaces line movement.

## What R1 explicitly does not do

No sports Market ingestion (R2), no Post (R3), no Community (R4), no Pick editing (R5), no Comments (R6), no Challenge (R7), no wallet/reservation change (R8), no Monetary Position (R9), no P2P settlement (R10). `resolved_outcome`/`resolution_status`/`resolved_by` remain on `markets` unchanged, for non-sports/diagnostic provenance only — no sports Market ever needs them for grading now.
