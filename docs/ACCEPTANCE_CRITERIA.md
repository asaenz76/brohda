# Acceptance Criteria Audit (Appendix X.16 + Appendix Y)

Phase 7 audit against the spec's X.16 (24 items, Social UI/UX Overhaul, v1.0 verbatim)
and Appendix Y (12 additive v1.1 items). Each entry: pass/fail + the file(s) that
satisfy it. All 36 items pass as of this audit.

## X.16 — Social UI/UX Overhaul (24 items)

1. **PASS** — Main player experience is a vertical social feed. [app/(app)/feed/page.tsx](../app/(app)/feed/page.tsx)
2. **PASS** — No sportsbook odds displayed anywhere. No decimal/fractional/American-odds values exist in any component; only entry fee, percentages, and payout estimates.
3. **PASS** — Pool cards display creator identity and match context. [PoolCreatorHeader.tsx](../components/pools/PoolCreatorHeader.tsx), [MatchIdentity.tsx](../components/pools/MatchIdentity.tsx)
4. **PASS** — Every pool card displays the correct rule pill. [RulePill.tsx](../components/pools/RulePill.tsx), `getRuleLabel()` in [templates.ts](../lib/pools/templates.ts)
5. **PASS** — Entry distributions hidden before the current user enters. `showDistribution = isPostVote || isLive || isLocked` in [SocialPoolCard.tsx:30](../components/pools/SocialPoolCard.tsx)
6. **PASS** — Tapping an option opens a slide-up confirmation sheet. [EntryConfirmationSheet.tsx](../components/pools/EntryConfirmationSheet.tsx)
7. **PASS** — MVP confirmation displays "Entry Fee × 1". [EntryConfirmationSheet.tsx:108](../components/pools/EntryConfirmationSheet.tsx)
8. **PASS** — Successful entry transitions the card to its post-vote state, via server revalidation after `enterPoolAction`.
9. **PASS** — Selected option receives an indigo highlighted border (`border-accent-primary bg-accent-primary/10`). [PoolOptionButton.tsx:34](../components/pools/PoolOptionButton.tsx)
10. **PASS** — Aggregate pool percentages appear only after entry (same `showDistribution` gate as #5).
11. **PASS** — Potential payout clearly marked as an estimate. [PotentialPayoutFooter.tsx](../components/pools/PotentialPayoutFooter.tsx): "Estimate only. Your final share depends on the pool at lock time."
12. **PASS** — Wallet history renders as a conversational activity feed, date-grouped (Today/Yesterday/This week/Earlier). [app/(app)/activity/page.tsx](../app/(app)/activity/page.tsx), [date-grouping.ts](../lib/utils/date-grouping.ts)
13. **PASS** — Winning credits use coral and include 🎉. [notices.ts:80](../lib/pools/notices.ts) (copy), [PoolStatusNotice.tsx](../components/pools/PoolStatusNotice.tsx) (coral styling on `SETTLED_WON`)
14. **PASS** — Winning transactions expand into a payout explanation. [TransactionRow.tsx](../components/activity/TransactionRow.tsx) accordion, showing gross/fee/net/winners/payout-per-entry.
15. **PASS** — Postponed/cancelled/abandoned/suspended matches produce the correct system-notice states. [anomaly.ts](../lib/pools/anomaly.ts), [notices.ts](../lib/pools/notices.ts)
16. **PASS** — Anomalous matches not completed on the same calendar day are automatically voided (X.7.2 grace window). [anomaly.ts](../lib/pools/anomaly.ts) `requiresSameDayWait`
17. **PASS** — All affected entries are refunded exactly once — idempotent settlement/reversal functions with unique constraints (`unique(pool_id, grading_version)` equivalent).
18. **PASS** — Refund notices display the current user's actual refunded amount. [notices.ts](../lib/pools/notices.ts) uses `entryAmount`/`refundedAmount`.
19. **PASS** — Both dark and light themes use centralized semantic tokens. [app/globals.css](../app/globals.css)
20. **PASS** — The mobile experience works without horizontal scrolling. Verified via browser resize (375/768/1280px); fixed two real bugs found this phase (AdminNav tab overflow, admin table `overflow-hidden` clipping) — see [AdminNav.tsx](../components/AdminNav.tsx) and all `app/(admin)/admin/*/page.tsx` table wrappers.
21. **PASS** — Interactive controls meet minimum touch-target requirements. Primary player controls use `min-h-11`/`h-11` (44px): [PoolOptionButton.tsx:32](../components/pools/PoolOptionButton.tsx), [SlideToConfirm.tsx:78](../components/pools/SlideToConfirm.tsx), [MobileBottomNavigation.tsx:36](../components/MobileBottomNavigation.tsx).
22. **PASS** — Restricted distribution data is not sent to pre-entry users, enforced at the query/RLS layer via the `pool_options_public` view, not client-side hiding.
23. **PASS** — The interface contains no casino-style visual motifs (no neon, flashing, chips, dice, roulette).
24. **PASS** — The interface uses "choice," "entry," "pool," and "lock in" terminology consistently across all copy.

## Appendix Y — v1.1 additive criteria (12 items)

25. **PASS** — Entry fee and house fee are immutable after the first entry, in both API and admin UI (Decision 4, enforced in `create_pool_entry`/pool update functions).
26. **PASS** — Exactly one active entry per user per pool enforced at the database level; a duplicate attempt returns the existing entry (unique index + idempotent RPC).
27. **PASS** — Pools lock at kickoff − 5 minutes by default; no entry is accepted at or after lock by server time.
28. **PASS** — A pool below its minimum entry count at lock is automatically cancelled and fully refunded with zero fee.
29. **PASS** — No-winner and all-winner settlements produce full refunds with zero fee and the specified copy. [card-state.ts](../lib/pools/card-state.ts), [notices.ts](../lib/pools/notices.ts)
30. **PASS** — Every settled pool's payout math is reproducible from its snapshot, and the rounding remainder is credited to the house and disclosed in the accordion. [settlements table](../supabase/migrations/20260101000010_settlements.sql), [TransactionRow.tsx](../components/activity/TransactionRow.tsx) (Phase 7).
31. **PASS** — Settlement reversal performs a dry-run first; insufficient winner balances route the pool to `REVERSAL_FAILED_MANUAL_REVIEW` with an affected-user report; reversal never partially executes and never runs twice. [20260101000011_reversal_and_reporting.sql](../supabase/migrations/20260101000011_reversal_and_reporting.sql)
32. **PASS** — An admin manual debit can never drive a balance negative (validated in `lib/validations/wallet.ts` + DB constraint).
33. **PASS** — Wallet transactions and audit logs cannot be updated or deleted through any application path (`REVOKE UPDATE/DELETE` + raise-trigger, both tables).
34. **PASS** — RLS prevents any player from reading another player's entries, transactions, or notifications, and pre-entry users never receive distribution data in any payload. Confirmed via Phase 7's security audit (task #60) — only `rate_limits` and `pool_options` are grant-less, both deliberately.
35. **PASS** — House fee is stored and transmitted as basis points and displayed as a percentage. `houseFeeBasisPoints` in [view-model.ts](../lib/pools/view-model.ts), `formatBps()` in [money.ts](../lib/utils/money.ts)
36. **PASS** — Card states are derived, never stored; `LIVE` does not exist in the pool state machine. `PoolStatus` enum in [card-state.ts](../lib/pools/card-state.ts) has no `LIVE`; it's a `CardState`-only value derived from fixture status.

## Appendix Y re-verification (post-CUSTOM-pools)

Items #25–36 above were re-checked against the current codebase after adding
CUSTOM (fixture-less) pools, Grade Manually, Cancel Pool, and full reversal
parity. All still hold — every function involved (`confirm_pool_refund`,
`confirm_pool_settlement`, `reverse_pool_settlement`,
`prepare_pool_settlement_manual`) is written generically over `pools`/
`entries`/`settlements`/`pool_options`, never branching on `pool_type` except
where explicitly noted below; none of the invariants (fee immutability,
one-active-entry, append-only ledgers, no-negative-balance, RLS isolation,
bps storage, no `LIVE` state) are fixture-specific.

## Appendix Z — CUSTOM pools: full lifecycle parity (5 items)

37. **PASS** — A super_admin can create a CUSTOM (from-scratch, no-fixture)
    pool with 2–8 free-text options, and manually grade any pool type once
    LOCKED/AWAITING_RESULT. [lib/actions/pools.ts](../lib/actions/pools.ts),
    [prepare_pool_settlement_manual](../supabase/migrations/20260101000025_fix_manual_grading_zero_entries.sql)
38. **PASS** — Fund flow (entry fee collection, house fee, payout math,
    refunds) for a CUSTOM pool is byte-identical to a real-fixture pool —
    both flow through the same `confirm_pool_settlement`/`confirm_pool_refund`
    RPCs, which never inspect `fixture_id`.
39. **PASS** — Reversing a settlement lands the pool back on
    `READY_FOR_REVIEW` regardless of whether it has a fixture: a fixture-less
    pool (or a real-fixture pool graded via Grade Manually) re-settles through
    `prepare_pool_settlement_manual`; a real-fixture pool re-settles through
    the automatic `prepare_pool_settlement`, giving live fixture data another
    chance to resolve it. Previously this raised `fixture_not_found` for any
    pool without a fixture. [20260101000027_reverse_and_cancel_custom_pools.sql](../supabase/migrations/20260101000027_reverse_and_cancel_custom_pools.sql)
40. **PASS** — A super_admin can cancel any pool outright from
    DRAFT/OPEN/LOCKED/AWAITING_RESULT (`ADMIN_MANUAL_CANCEL`), refunding every
    active entry in full with zero fee — same money-flow guarantee as the
    automatic below-minimum-entries cancellation.
    [lib/actions/pool-lifecycle.ts](../lib/actions/pool-lifecycle.ts)
41. **PASS** — The real `lockDuePools()`/`processAwaitingResults()` cron
    functions handle a CUSTOM pool correctly: the lock job advances
    OPEN → LOCKED → AWAITING_RESULT with no fixture involved at all, and the
    results job counts a CUSTOM pool's expected "no fixture" case as
    `skipped`, not `failed` — a real-fixture pool with a genuinely missing
    fixture row still counts as `failed`. Verified against a live pool via
    [scripts/verify-custom-pool-cron.ts](../scripts/verify-custom-pool-cron.ts)
    (`pnpm verify-custom-pool-cron`) — kept as a standalone script rather
    than a vitest integration test since both functions operate on every
    pool in the database with no scoping, which races with other test files'
    assumptions under parallel execution.

Not applicable / already covered: notifications and reports
([lib/notifications/create.ts](../lib/notifications/create.ts),
[lib/reports/fetch.ts](../lib/reports/fetch.ts)) were already fixture-agnostic
by design, confirmed unchanged. There is no pool-search feature in the app to
check (only player/profile-name search exists). Leaderboard/streak logic
(`correct_prediction_log`, `user_profiles` counters) is populated inside
`confirm_pool_settlement` and unwound inside `reverse_pool_settlement`
identically for every pool type.

## Summary

41 / 41 criteria pass. No gaps found requiring remediation beyond what Phase 7's other
work items (B: ledger accordion, F: responsive fixes) already closed.
