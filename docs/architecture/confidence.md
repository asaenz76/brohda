# Confidence economy (r82 foundation, Milestone 3 · r84 Confidence-backed Picks, Milestone 4 · r89 mandatory Confidence)

**Confidence is scarce internal reputation capital a Member puts behind their own prediction.** Public name: *Confidence*; unit: *Confidence points*; shorthand: 🔥 (`🔥50`, `+5🔥`, `−5🔥`). This milestone builds the permanent foundation — accounts, an immutable ledger, the initial grant and the Daily Claim, configuration, and aggregate observability. It does **not** build Confidence-backed Picks, Sponsored Confidence or Rewards, and nothing about Picks, grading or Call BS changes. **The capability ships OFF.**

## Permanent product rules

Confidence **cannot be purchased, redeemed or transferred**; it has **no cash value** and no payment-provider dependency; it is earned or recovered only through Brohda mechanisms. There is no Buy/Recover-with-money path, checkout, fiat/USDT/stablecoin purchase, withdrawal, Member-to-Member transfer, marketplace or gifting — and none of that exists as dormant code. A static test (`tests/unit/confidence/domain-guard.test.ts`) reads the real source and fails if the schema or code imports or names wallet, monetary, payment-provider, transfer, redemption, purchase, price or cash concepts, or uses the Cred/Gold/coin/chip/token vocabulary, or touches Call BS. Picks are touched only by the narrow Milestone 4 attach/settlement path (see below); grading itself is never reimplemented here.

The Confidence domain is **separate from the Member monetary wallet** (`wallet_balances` / `wallet_transactions` / the P2P ledger). It reads, writes and references none of it, so the monetary system can be removed at the replacement gate without touching Confidence. Sponsorship payments are separate and untouched.

## Audit (what was reused, what is new)

| Area | Finding |
| --- | --- |
| Old paid-recovery remnants | None. No `confidence_recovery_purchase_enabled`, no checkout/provider hooks, no Cred/Gold/coin terminology in source (only unrelated English prose). Nothing to delete. |
| Existing monetary ledger | `wallet_balances` (account-per-profile via the `create_wallet_for_new_profile` trigger) + append-only `wallet_transactions`. Legacy; **not reused**. |
| Settings pattern | `platform_settings` columns + one audited `admin_set_*_config` function + a Settings → Brohda card + a registry entry (the drift test requires every column to be accounted for). **Reused.** |
| Audit infrastructure | `audit_logs` (append-only). **Reused** for admin adjustments, reversals and config changes. The ledger itself is the audit trail for grants and claims. |
| Member bootstrap | Profiles get their other rows via `after insert on user_profiles` triggers. **Reused**, gated on the capability and made failure-safe. |
| Background jobs | The single housekeeping cron route runs bounded, failure-isolated steps. **Reused** for the backfill (no new scheduler entry). |
| Account closure | `user_profiles.account_closed_at` (r80) is the canonical closure source. **Reused.** |
| New | `confidence_accounts`, `confidence_ledger_entries`, the Confidence functions, the settings, the Member card/history/public flame, the Super Admin economy page. |

## Data model (migration 201)

- **`confidence_accounts`** — one row per eligible Member (`member_id` primary key, `on delete restrict` so history outlives any profile change). `available`, `reserved` (both `>= 0`), `total` = **generated** `available + reserved` (the invariant holds by construction and cannot be written), `last_daily_claim_at`. A trigger refuses any balance write that is not a side effect of a ledger insert (even from the service role) and refuses a non-empty new account.
- **`confidence_ledger_entries`** — the canonical, **immutable** accounting events (update/delete refused). `entry_type` is a canonical set — **`INITIAL_GRANT`, `DAILY_CLAIM`, `ADMIN_ADJUSTMENT`, `REVERSAL`** — never free text; `available_delta` / `reserved_delta` with `available_after` / `reserved_after` stamped by the trigger; `reason_code` (canonical: `REMEDIATION`, `CORRECTION`, `SUPPORT_CASE`) and a bounded private `note` for admin adjustments; `actor_id`; `reverses_entry_id` (unique — an entry is reversed at most once); `idempotency_key`; bounded `metadata`. Check constraints enforce each type's shape (e.g. grants/claims positive with no actor, adjustments signed with actor+reason+note, reversals point at one entry). `reserved_delta` is constrained to 0 until Confidence-backed Picks exist; that milestone relaxes it and adds its event types (reserve / release / win / loss, sponsored and Brohda drops) with its own migration — nothing here implements them.
- **Integrity.** A `before insert` trigger locks the account row, computes the resulting balances and refuses a negative result; an `after insert` trigger applies the deltas (so an `ON CONFLICT DO NOTHING` that skips a row can never move a balance). `confidence_reconcile()` returns any account whose cached balance disagrees with the sum of its ledger (must always be empty; the overview reports the count).
- **Unique indexes**: one `INITIAL_GRANT` per Member **ever** (a reversed grant is never granted again), `(member, idempotency_key)`; indexes for a Member's history and aggregates by type.
- **Eligibility** (`confidence_member_eligible`): a Member profile (a Sponsor login never has one) that is active and has not closed its account (`account_closed_at is null`). Suspended and closed accounts get no grant and no claim; their ledger is preserved.

## Configuration (`platform_settings`, no deploy to change policy)

| Setting | Default | Notes |
| --- | --- | --- |
| `confidence_enabled` | **false** | Fails closed everywhere (UI, server actions, RLS). |
| `confidence_baseline` | 50 | Initial grant **and** the Daily Claim ceiling (≥ 1). Changing it **never rewrites existing balances**. |
| `confidence_daily_claim_amount` | 1 | Global, 1–5, never above the baseline. |
| `confidence_daily_claim_interval_hours` | 24 | Rolling, from the last successful claim (≥ 1 whole hour). |
| `confidence_allowed_stakes` | `{1,2,3,4,5}` | The future stake ladder (non-empty, strictly ascending, positive whole numbers; any length). Nothing reads it until Milestone 4. |

Edited on Settings → Brohda → Confidence through one audited function (`settings.confidence_updated`), validated as a whole and applied or refused as a whole (the table's own constraints are the authority). Only true invariants are hard-coded; none of 50, 1, 24 h or 1–5 is a constant in the database functions, the server, the UI or the tests (tests read the configured value).

## Initial grant (exactly once, race-safe, idempotent)

`confidence_bootstrap_member(member)` takes a per-Member advisory lock, creates the account if missing and inserts the one `INITIAL_GRANT` of the **configured baseline** (`on conflict do nothing`; the unique index is the final word). It is a no-op unless the capability is ON and the Member eligible.

- **Existing Members** (production has ~66): a bounded, observable backfill — `confidence_bootstrap_batch(limit)` (≤1000, oldest first, reports `processed`/`remaining`) — runs inside the existing housekeeping cron (`lib/confidence/bootstrap.ts`, own failure domain `confidence_bootstrap`) and **does nothing while OFF**. A Member who looks at their profile first gets their account on first view (the same idempotent function), so nobody waits for the backfill. No balance is ever edited by hand.
- **New Members**: an `after insert on user_profiles` trigger calls the same function — only while ON, and any failure is swallowed (signup is never blocked; the backfill and first view catch up).

## Daily Claim (an active action)

`confidence_daily_claim(member, idempotency_key)` (service-role only; the server action derives the Member from the session and never accepts a client-supplied one) does, atomically under the account row lock: capability → eligibility → ensure account → replay check → **available < baseline** → **now ≥ last claim + interval** → amount = `least(configured amount, baseline − available)` → one ledger entry. So a claim can never push available above the baseline, missed days are never banked (one claim per eligible moment), and eligibility is pure `timestamptz` arithmetic — **no time zone, midnight or calendar day is involved** (tested across extreme zones). Concurrent claims yield exactly one entry; a retry with the same key returns the first result without a second entry. Nothing grants Confidence automatically, and there is no notification per claim.

## Visibility

- **Public**: a Member's current Confidence total, on their profile (`🔥50`), only while ON (server-side loader; the public cannot read the tables).
- **Private (Member)**: their own account and history through RLS **and** the capability (policies use `confidence_enabled_flag()`, so the database itself fails closed), with only the non-sensitive columns granted. The admin note, reason, actor, metadata, reversal link and idempotency key are **not granted to Members at all**. History is at `/profile/confidence` (a 404 while OFF).
- **Sponsor**: no profile ⇒ no account, no read, no call. Sponsor Intelligence has no Confidence metric yet.
- **Super Admin**: Settings → Confidence (policy), and Admin → Confidence: the economy overview and one Member's account/ledger with the adjustment and reversal controls. Deliberately small.

## Admin adjustments and reversals

Both are compensating **ledger entries** — nothing is overwritten. `admin_confidence_adjust` needs Super Admin, a canonical reason, a note, a signed non-zero amount (any amount a 64-bit balance can hold) and an idempotency key; the result can never be negative; audited (`confidence.adjusted`). `admin_confidence_reverse` writes the opposite entry for one ledger entry (once; a reversal can't be reversed; refused if it would go negative); audited (`confidence.reversed`).

## Economy observability

`confidence_economy_overview()` (service role, aggregates only — no Member is named): accounts vs eligible Members, total / available / reserved Confidence, average, median and a percentile distribution (min, p10, p25, p50, p75, p90, max), Members below / at / above the baseline, initial grants and Daily Claims (count and total), admin adjustments and reversals (count and net), and the ledger-reconciliation mismatch count. Winnings minted, losses burned, Sponsored Confidence, prediction volume, average stake and 7/30-day net supply change are **not** invented: they arrive with the events that produce them.

## Roadmap

1 Sponsor Intelligence ✔ · 2 Messaging ✔ · **3 Confidence foundation (this)** · 4 Confidence-backed Picks · 5 Sponsored Confidence Drops · 6 Brohda Rewards Platform · 7 Rivalry · 8 Economy recommendations · 9 Soak / replacement gate · 10 Monetary P2P destruction. The old paid Confidence Recovery milestone is **retired**.

## Mandatory Confidence (r89, migration 205) — the canonical rule

> **A Pick cannot exist without Confidence behind it.** Confidence is Brohda's in-game prediction currency (non-purchasable, non-redeemable, non-transferable, no cash value). The optional "Pick, then maybe attach Confidence" flow of Milestone 4 is **retired**; there is no alternate path.

**The composer.** A prediction is a side AND Confidence, chosen together on the card (`PredictionComposer`, one component for the feed's primary Market, every inline Market, the Market page and the Post): *choose a side* (local state only — the server never hears about it; switch freely) → *tap a Confidence level*. **Tapping the level IS the commitment** — there is no separate confirm button. The levels (the configured ladder, `confidence_allowed_stakes`, nothing hard-coded) wait for a side and are limited to the Member's **available** Confidence. While the one transaction runs the levels are disabled with a subtle "Saving…" status (no blanking); a double tap is blocked client-side and made exactly-once by the idempotency key. Success replaces the composer with the committed, locked prediction ("You picked X · 🔥N Confidence · Locked") — there is no "Change your prediction" afterwards. A rejection restores the composer with the side still chosen. Because nothing is saved until the level is tapped, there is no "save the Pick, then load Confidence" round trip at all.

**The transaction.** `create_confidence_prediction` (service role only; the server action `commitPredictionAction` derives the Member from the session) validates everything first and returns a plain outcome without writing: capability (Confidence **and** predictions on), Member, ladder, the canonical deadline (`pick_lock_minutes_before_kickoff`, evaluated now against authoritative Game state), and **available ≥ amount**. Only then does it create the Pick, the stake, the reserve ledger entry and the lock together; any unexpected failure raises and rolls the whole transaction back, so there is never a Pick without a stake, a stake without a Pick, a reserve without a Pick, or a Pick that is still editable. A per-(Member, Market) advisory lock serialises double taps; the same key returns the original result. Zero available Confidence → no prediction (and no unbacked fallback): the card says "You need Confidence to make a prediction" and shows the Daily Claim path only when a claim is actually open (eligibility is still on **total** Confidence, so reserving never manufactures one). Nothing offers a purchase.

**T-10 (`pick_lock_minutes_before_kickoff`) now means "the deadline to submit a new prediction".** A confirmed prediction is already final and unaffected by it. Call BS (free, no Confidence of its own) no longer needs to lock Picks: every Pick is already locked, so accepting a challenge leaves `CONFIDENCE_COMMITTED` as the lock reason (exclusivity of pairings is enforced by the challenge rows).

**Commit before the crowd.** Sentiment is revealed only for a prediction that is **final** (a stake exists / it is locked or graded). Tapping a side shows nothing; an old open unbacked Pick does not reveal it either. One Pick is one vote — Confidence never weights it. Only confirmed (backed) predictions are created going forward, so only they enter history and accuracy; abandoned composers leave no record.

**The cutover (database-level invariant, permanent and one-way).** `platform_settings.confidence_mandatory_since` (NULL = not enforced) is set from the Super Admin Confidence card ("Make it permanent: no Pick can exist without Confidence", audited as `settings.confidence_updated`; activation needs predictions on). It moves exactly one way, NULL → the server's current timestamp, and a BEFORE UPDATE trigger (`confidence_mandatory_one_way`) refuses everything else for every role including the service role: set → NULL, set → a different instant (earlier or later), NULL → anything other than now (`cutover_is_permanent` / `cutover_must_be_now`). `admin_set_confidence_config` treats `confidence_mandatory=true` as "set it if unset, keep it if set" and `false` after it is set as an error; the Settings card shows a locked, checked block once enforced. Once set: (1) `set_pick` refuses to persist anything outside `create_confidence_prediction` (it returns `rejected_backing_required`); (2) the separate `confidence_attach_stake` returns `retired`; (3) a deferred constraint trigger refuses to COMMIT a Pick created at/after the instant that has no stake; (4) `confidence_reconcile_stakes` reports `PICK_WITHOUT_STAKE_AFTER_CUTOVER`. **The operational kill switches stay separate:** `confidence_enabled` and `confidence_backed_picks_enabled` stop NEW commitments (the composer answers `disabled`), but never erase or reverse the marker and never allow an unbacked Pick; Confidence already reserved behind Picks still settles. Members have no direct database access to any of it (no INSERT/UPDATE on predictions or stakes, no RPC grant). The application code path is composer-only regardless of the marker; the marker is the database-side enforcement the owner activates after reviewing the legacy inventory. Remediation of a wrongly activated marker is a deliberate database operation by the owner (a connection with triggers disabled), never a Settings action.

**Legacy Picks are never rewritten.** Picks made before the cutover are historical records and are never given an invented stake. Graded ones stay as they are. A still-open, never-locked unbacked Pick is **completed** by the same composer (its side is pre-selected and may still be changed; choosing a level makes it a final, backed prediction — same Pick row). A legacy Pick that is already locked (cutoff, accepted Call BS, a monetary position) is shown as the record it is and grades under legacy semantics. Admin → Confidence shows the split (earlier picks total / graded / open / still completable, members who cannot predict now, backed predictions).

## Milestone 4 — Confidence-backed Picks (r84, migration 203) — superseded by the section above where they differ

A Member may put Confidence behind their **own** Pick, before the canonical deadline: *"How confident are you?"* — an amount from the configured ladder, an explicit confirmation, then **reserve + Pick lock happen in one transaction**. Available −N, reserved +N, total unchanged. After that the Pick and the stake are immutable.

**Capability.** `platform_settings.confidence_backed_picks_enabled` (default **OFF**), separate from `confidence_enabled`. It gates only *new* commitments. Turning either switch off never strands a reserved stake: settlement is independent of both.

**Data.** `confidence_prediction_stakes` — one row per Pick (unique `prediction_id`), the minimum record binding Member, Pick, Market, Game, side and amount, plus the ladder in force at commit time. Guard triggers enforce: the Member owns the Pick, it is still PENDING, side/market match, the amount was on the ladder; afterwards only the one-way RESERVED→SETTLED transition is possible and nothing is ever deleted. A Pick with a stake can never change its side, whoever writes it. The ledger gains four entry types tied to the stake (`stake_id`): `PREDICTION_RESERVE` (avail −N, res +N), `PREDICTION_RELEASE` (avail +N, res −N), `PREDICTION_WIN` (res −N, avail +2N), `PREDICTION_LOSS` (res −N). Unique indexes allow exactly one reserve and one settlement per stake.

**Attach** (`confidence_attach_stake`, service role; the server action derives the Member from the session). Lock order is Pick → stake → account. The canonical deadline is the same helper `set_pick` uses (`pick_market_timing`: kickoff minus `pick_lock_minutes_before_kickoff`), evaluated with `clock_timestamp()` **after** the row locks, against authoritative Game state — never the client. The stake is the *second* lock reason: an existing `lock_reason` (an accepted Call BS, a money Position) is kept; otherwise it becomes `CONFIDENCE_COMMITTED`. A Pick locked by `CUTOFF` can't be backed. Outcomes: attached/replay, disabled, ineligible, not_found, already_backed, pick_graded, game_started, past_deadline, invalid_amount, insufficient (availability, never total), idempotency_conflict.

**Settlement** comes only from the canonical grade and happens **exactly once**: an AFTER UPDATE trigger on the PENDING→GRADED transition settles in the *same transaction* as grading (failures contained: grading is never blocked), backed by an indexed retry-safe sweep (`confidence_settle_pending`, run by the housekeeping cron as its own failure domain, `confidence_settlement`). Correct ⇒ net **+N** (reserved N returned + N newly issued); incorrect ⇒ net **−N**; void ⇒ **0**. No fees, no odds, no multipliers, no money. Grading is permanent, so there is no regrade path.

**Daily Claim** eligibility and the baseline cap now use **total** Confidence (so reserving can't create eligibility); the credit lands in available. Example: 45 available + 5 reserved = 50 → nothing to claim; 44 + 5 → claimable; 42 + 5 with a claim of 5 → 3 credited.

**Surface.** The signed-in shell shows one always-visible **total** (`🔥50`, accessible label "50 Confidence[: 47 available, 3 reserved]"), desktop and mobile, hidden for Sponsors and while Confidence is off; it reads the Confidence domain only (`getShellConfidence`) — the monetary wallet row is untouched. The existing "your Pick was graded" notification is *enriched* (never a second notification) with the configured sentence per result (`confidence_notify_correct/incorrect/void`, `{{amount}}` placeholder). Private history shows reserve/settlement rows with the available/reserved split; the public profile shows total Confidence; the 🔥N conviction chip appears only on already-visible Picks. Sentiment, accuracy and Call BS are unchanged (Call BS has no Confidence economics).

**One control on every Pick surface (r85, migration 204).** Any surface that lets a Member make or change a Pick also offers the optional Confidence action: the Post detail and the Home feed card use the **same** shared components (`PickConfidence` / `CommittedConfidence` → `ConfidenceBacking` → `attachConfidenceAction`) and the **same** database decision (`confidence_stake_status`). The feed gets that decision for every Pick on the page in ONE batched call — `confidence_stake_status_many(member, ids[])` (read-only, service role; it simply calls the single-Pick function per id, so the two can never disagree) — never a query per card. After a successful Pick, `PredictionActions` re-reads the server view (`router.refresh()`) so the control appears inline with no reload; the control is keyed by Pick and side so a changed Pick starts a fresh selector. A Pick locked by an accepted Call BS still gets the control when the server says it is open (the lock is not the Confidence rule).

**Every Market of a Game on the feed card (r87).** The Home feed is the whole prediction surface: for a signed-in Member the Game's other displayable Markets expand **inline** on the card ("See more markets" / "Show fewer markets" — component state only, nothing stored, no navigation) and use the very same component as the primary Market (`FeedMarketPick`: Pick, lock state, Confidence control, committed amount, Pick-first sentiment for that Market). The feed item carries `secondaryMarkets`, built by the same `summarizeMarket` as the primary Market, ordered by the configured template priority (`post_primary_market_template_priority`, the setting that also decides the primary Market). Reads are batched and constant per page (Markets, the viewer's Picks on them, sentiment only for Markets the viewer has Picked, one Confidence call) — no query per Market. Each backed Pick reserves its own amount; a Game is not one Pick.

**Integrity.** `confidence_reconcile` also requires each account's `reserved` to equal the sum of its active stakes. `confidence_reconcile_stakes` reports SETTLED_WITHOUT_ENTRY, ENTRY_WITHOUT_SETTLEMENT, RESERVE_ENTRY_MISSING_OR_WRONG and STRANDED_RESERVE (graded > 15 min with no settlement). `admin_confidence_reverse` refuses any entry that belongs to a stake. The economy overview adds active/total backed Picks, reserved, committed, average committed, winnings issued, losses burned, void returns, by-amount distribution and 7/30-day net change.

**Deployment order.** Migration 203 is additive and must be applied (`supabase db push`) **before** the code that reads it is merged and deployed; the capability ships OFF.

## Hard-coding audit (owner rule: nothing that doesn't need to be hard-coded is hard-coded)

Every literal in the schema and code, classified. **A** = genuine technical/security/schema invariant; **B** = configurable product policy; **C** = implementation safety bound (a concrete technical reason, not a product rule).

| Value | Class | Where it lives / why |
| --- | --- | --- |
| Baseline 50, Daily Claim 1, interval 24 h, ladder `{1,2,3,4,5}`, capability OFF | **B** | `platform_settings` defaults only; read live everywhere. |
| Baseline upper limit | **A** | None beyond the 32-bit `integer` column (2,147,483,647). The earlier 1,000,000 cap had no technical reason and was **removed**. |
| Interval upper limit | **A** | None beyond the 32-bit integer column. The earlier 168-hour cap was product policy with no technical reason and was **removed** (minimum stays 1 whole hour: 0 would turn the rolling interval off, contradicting the rule). |
| Stake ladder length and size | **A** | Only "non-empty, strictly ascending, positive integers" (semantic) and the integer column's range. The earlier ≤10 entries / ≤1000 caps were product choices and were **removed**. |
| Daily Claim amount 1–5, and ≤ baseline | **B (owner-approved product constraint)** | Approved by the owner as a product constraint; stays as a table check. |
| Admin adjustment size | **A** | Any amount the 64-bit balance can hold (overflow is refused). The earlier ±1,000,000 cap had no technical reason and was **removed**. |
| `available`/`reserved` ≥ 0, `total` = available + reserved, one account per Member, one initial grant per Member ever, ledger append-only, canonical entry types and reason codes; prediction entries tied to exactly one stake with the 1:1 settlement shape (reserve ±N, win +N net, loss −N net, void 0 — a true V1 product invariant, not a tunable) | **A** | Accounting/security invariants the owner specified; enforced as database constraints and triggers. |
| Note ≤ 500 characters; idempotency key 8–100 characters; ledger `metadata` ≤ 2000 characters | **C** | Bounds on free text so a row, an index entry and a screen stay small (a UUID is 36 characters; the note matches the other private notes in the product). Not Brohda product rules. |
| Backfill batch ≤ 1000 per call (default 200), 10 calls per cron tick | **C** | Bounds one call's work under PostgREST's 8-second statement timeout and one cron request's duration; the backlog drains over ticks. |
| Member history shows the latest 100 (admin lookup 100, hard maximum 200) | **C** | Payload bound for an unpaginated list. |
| Economy percentiles (p10/25/50/75/90) | — | A reporting choice, not policy. |
| Backed-Pick amounts | **B** | The ladder in `platform_settings.confidence_allowed_stakes`, snapshotted on the stake at commit time. |
| Pick deadline | **B** | `pick_lock_minutes_before_kickoff` (existing Pick policy), via the one shared `pick_market_timing` helper. |
| Settlement sentences | **B** | `confidence_notify_correct/incorrect/void` in `platform_settings`, editable on the Confidence settings card. |
| Settlement sweep batch 200 (max 1000); stranded-reserve grace 15 minutes | **C** | Bounds one cron call's work; the grace is only a reporting threshold for "settlement should already have happened". |
| `FLAME_ROW_MAX = 5` | **C** | A layout bound for the selector's width: above it a choice is written `🔥N` instead of N flames. Any ladder works. |
| Prediction ladder, deadline, balance rule | **B** | `confidence_allowed_stakes`, `pick_lock_minutes_before_kickoff` and the Member's available Confidence — the composer and `create_confidence_prediction` read them live; the smallest ladder value is the minimum stake (never a literal 1). |
| One stake per Pick, a Pick needs its stake (after cutover), 1:1 settlement | **A** | True product invariants, enforced as constraints/triggers and the single creation function. |
| Cutover instant | **B** | `confidence_mandatory_since`, set by an audited Super Admin action; nothing in code decides when. |
