# FREE Prediction Mode — Architecture Proposal

**Status: ARCHITECTURE READY FOR IMPLEMENTATION** (see §18's "FINAL ARCHITECTURE STATUS"), pending the implementation acceptance criteria at the end of §18 being satisfied during Phase 1. No schema or application code has been changed.

**Revision history**:
- **Round 1** incorporated four locked decisions from the first architecture review: (1) the global platform toggle blocks new entries immediately, even into an already-`OPEN` pool, not just new pool creation; (2) `create_pool_entry` re-checks the relevant platform capability inside its own transaction, before any mutation, on every call; (3) a FREE entry request with a client-supplied amount is rejected outright, not silently coerced to `null`; (4) the database CHECK constraints on `pools` now jointly enforce `entry_fee`/`house_fee_bps`/`tier_group_id` consistency with `entry_mode`, not just `entry_fee` alone.
- **Round 2** (this revision) closed two gaps identified in Round 1's design: (1) the capability check is now genuinely **fail-closed** — `SELECT ... FOR SHARE` plus `IS DISTINCT FROM TRUE` and explicit `not found` handling, rather than a bare `not (select ...)` that would fail *open* on a missing settings row; (2) the toggle/entry race is now backed by a **real Postgres linearization mechanism** (`FOR SHARE` vs. the admin `UPDATE`'s implicit `FOR NO KEY UPDATE`), with an explicit deadlock analysis and a canonical lock order, rather than the overstated "same transaction" claim from Round 1. The re-enable test was also split into two pools (§15), since a locked/settled pool cannot legitimately receive a new entry regardless of the toggle. See the "REVISED" markers throughout for exactly what changed in each round.

This document is the output of a read-only codebase audit (six parallel research passes over the pool domain, entry/wallet domain, UI, analytics, background jobs, and test coverage) plus the resulting design. Every claim below is grounded in an actual file/line/migration found in `/Users/andresaenz/Claude/PollPools_Brohda` — not assumed from prior conversations.

---

## 1. CURRENT MONEY FLOW

End-to-end, as it exists today:

1. **Creation** — Admin uses the 3-step wizard (`app/(admin)/admin/pools/new/pool-template-builder.tsx`). Step 3 ("Financials & review") requires `entryFee`/`houseFeePercent` (or a tier list) to be non-empty before the form validates (`step3Valid`, lines 621-625). `createPoolForFixture` (`lib/actions/pools.ts:167-402`) inserts the row: `entry_fee: input.entryFeeCents`, `house_fee_bps: input.houseFeeBps`, `min_total_entries: MINIMUM_POOL_ENTRIES` (hardcoded `2`, `lib/validations/pools.ts:10`), `status: 'DRAFT'` or `'OPEN'`.
2. **Entry** — Player picks an option on `SocialPoolCard.tsx`. If `balanceCents < viewModel.entryFee` (line 328), `TopUpAndJoinModal` renders instead of `EntryConfirmationSheet`. On confirm, `EntryConfirmationSheet` posts to `enterPoolAction` (`lib/actions/entries.ts`), which calls RPC `create_pool_entry`. That RPC (`supabase/migrations/20260101000122_pool_entry_fee_tiers.sql:40-140`), in one Postgres transaction: validates the user, locks the pool row, checks `p_amount = v_pool.entry_fee` exactly (`amount_mismatch` otherwise), inserts the `entries` row, then calls `apply_wallet_transaction(..., 'pool_entry_debit', 'debit', ...)` which locks the wallet balance row and debits it (raising `insufficient_balance` if it would go negative — the whole transaction rolls back, entry included).
3. **Lock** — Cron `lock-pools` (`lib/pools/lock.ts`) flips `OPEN → LOCKED` at `locks_at`, then calls RPC `advance_or_cancel_locked_pool` (`20260101000089_binary_pool_participation_rpc.sql`), which checks `sum(entry_count) < min_total_entries` and, if true, calls `confirm_pool_refund('MINIMUM_ENTRIES_NOT_REACHED', ...)` — refunding every `ACTIVE` entry via `apply_wallet_transaction('pool_refund_credit', ...)` and setting `status = 'CANCELLED'`.
4. **Grading/Settlement** — Cron `process-results` (`lib/pools/settle.ts`) detects fixture anomalies (voids via `confirm_pool_refund`) or a completed fixture. For `TEMPLATE_GRADED` pools (the only live creation path besides `COMBO`), `gradeTemplatePool()` (`lib/pools/templates/grade.ts`) runs the template's pure `gradingRule`, calls `prepare_pool_settlement_manual` (computes parimutuel math, no money moves), writes `pool_grading_evidence`, then **immediately** calls `confirm_pool_settlement` — which sets entries `WON`/`LOST`, credits winners (`pool_payout_credit`), credits the house (`house_fee_credit`, `rounding_remainder_credit`), and updates `user_profiles.current_streak`/`correct_predictions_count` inline. Legacy/`COMBO` pools stop at `READY_FOR_REVIEW` for an admin to click confirm.
5. **History/Analytics** — Profile shows the same `SocialPoolCard`; notification/status copy comes from `buildNoticeCopy()` (`lib/pools/notices.ts`), which is 100% dollar-denominated. Admin/user analytics pages (`get_platform_*`/`get_user_*` SQL functions) sum `entries.amount` and `wallet_transactions.amount`. The leaderboard (`get_leaderboard`) and streaks (`user_profiles.current_streak`) are the one part of this flow that is **already money-agnostic**.

Every step above is `SECURITY DEFINER`, `service_role`-only — `entries` and `wallet_transactions` grant only `SELECT` to `authenticated`, confirmed by grep across all 125 migrations. **Real precedent worth internalizing**: production once drifted so that all 61 public-schema functions had `EXECUTE` granted to `anon`+`authenticated` regardless of their intended grants, for an unknown window, caught only by a dedicated audit (`SECURITY_RPC_PRIVILEGE_INCIDENT_REPORT.md`, remediated in `20260101000107_security_incident_restore_rpc_privileges.sql`). This is the single most important piece of institutional memory for this proposal's security section: **the RPC grant table is the real boundary, and it has drifted from intent at least once without being caught by application code.**

---

## 2. CURRENT MONEY ASSUMPTIONS

Every place that assumes a pool is paid, found by the audit:

| Layer | Assumption | Location |
|---|---|---|
| DB schema | `pools.entry_fee bigint not null check (entry_fee > 0)` | `20260101000009_pools.sql:38` |
| DB schema | `entries.amount bigint not null check (amount > 0)` | `20260101000009_pools.sql:115` |
| DB schema | `wallet_transactions.amount bigint not null check (amount > 0)` | `20260101000007_wallet.sql` |
| RPC | `create_pool_entry` unconditionally calls `apply_wallet_transaction` | `20260101000122_...sql:112-125` |
| RPC | `apply_wallet_transaction` itself: `if p_amount <= 0 then raise exception` | `20260101000007_wallet.sql` |
| RPC | `confirm_pool_settlement` unconditionally computes/pays `payout_per_entry`, credits house fee | `20260101000010_settlements.sql:262-423` |
| RPC | `confirm_pool_refund` unconditionally loops `ACTIVE` entries and credits `pool_refund_credit` | same file, `433-506` |
| View model | `SocialPoolCardViewModel.entryFee`/`grossPool`/`estimatedNetPrizePool`/etc. are non-nullable required fields | `lib/pools/view-model.ts:25-100` |
| UI | `SocialPoolCard`'s single money gate: `balanceCents < viewModel.entryFee` | `SocialPoolCard.tsx:328` |
| UI | `PoolSummary` always renders `{formatCents(grossPool)} pot` — no absent-state | `PoolSummary.tsx:66-84` |
| UI | `EntryConfirmationSheet` props (`entryFee`, `houseFeeBasisPoints`, `balanceCents`) all required | `EntryConfirmationSheet.tsx:11-37` |
| Copy | `buildNoticeCopy()` — every one of ~14 message branches (WON + 13 void reasons) is dollar-phrased | `lib/pools/notices.ts` |
| Analytics | `get_platform_overview`/`get_platform_financial_overview`/`get_platform_top_users`/etc. — `count(*)`/`sum(e.amount)` with zero pool-type filter | `20260101000074_platform_analytics_functions.sql` |
| Admin form | Step 3 (`pool-template-builder.tsx`) gates `step3Valid` on non-empty fee fields | lines 621-625 |
| Notifications | `wallet_transactions.transaction_id` is the notification's own correlation key, so its identity assumes a financial transaction exists | `lib/notifications/create.ts:396-407` |

Notably **not** assuming money: the leaderboard RPC (`get_leaderboard`), streak math (`lib/analytics/streaks.ts`), and `CommunitySplit.tsx` (explicitly commented as "entry-count-based, not money-weighted"). These are the parts of the system that already generalize to FREE with zero changes.

---

## 3. ZERO-DOLLAR ANALYSIS

**Can FREE safely be `entry_fee = 0` inside the current PAID engine? No.**

Tracing the consequences:

- **It's not even legal today.** `pools.entry_fee bigint not null check (entry_fee > 0)` and `entries.amount bigint not null check (amount > 0)` both hard-reject zero. Relaxing those CHECKs to `>= 0` is possible, but that alone doesn't make zero *semantically* safe — it just makes it *insertable*.
- **The wallet engine itself refuses a zero-amount transaction.** `apply_wallet_transaction` raises if `p_amount <= 0`. So `create_pool_entry`'s unconditional debit call would throw for a $0 entry — meaning either (a) the wallet engine's positive-amount invariant gets modified (directly touching the money engine, which is explicitly off-limits), or (b) `create_pool_entry` special-cases `p_amount = 0` to skip the debit call. Option (b) is a conditional branch inside the *same authoritative RPC* the PAID path depends on — riskier than a distinct mode flag, not safer, because it's a fragile "is this row special" test buried in the money engine rather than a first-class, greppable pool attribute.
- **Settlement breaks the same way, worse.** `confirm_pool_settlement` computes `payout_per_entry = net_prize_pool / winning_entry_count`. If every entry is $0, `gross_pool = 0`, so `payout_per_entry = 0` for every winner — and crediting a winner `pool_payout_credit` of `$0` hits the exact same `apply_wallet_transaction` positive-amount guard. Same for the house-fee credit (`0 * house_fee_bps / 10000 = 0`) and the rounding-remainder credit. **A $0 pool cannot even complete settlement today without touching the settlement RPC.**
- **Analytics would silently distort, not just extend.** `get_platform_overview`/`get_platform_top_users`/etc. `count(*)` over `entries` with no fee filter — a $0-fee pool's entries would inflate "Pools entered"/"Entries" counts as if they were real financial activity, and would corrupt "average entry amount" (a true $0 datapoint dragging the average down, rather than being cleanly excluded).
- **Every notification would lie.** `buildNoticeCopy()`'s phrasing — *"Your $0.00 entry fee has been automatically credited back to your balance"* — describes a wallet event that never happened. This isn't a cosmetic bug; it's incorrect information about the user's own money.
- **Idempotency-key correlation would become ambiguous.** Financial reporting joins (e.g. `get_platform_financial_overview`'s `left join wallet_transactions wt on wt.entry_id = e.id and wt.type = 'pool_payout_credit'`) currently assume "an entry has a wallet row ⇒ it's financial." A $0 entry might or might not have a corresponding wallet row depending on which special-case path handled it, making "is this actually money" something every future consumer has to re-derive rather than read off one column.

**Conclusion: FREE must be a distinct mode, never a `$0` PAID entry.** This confirms the user's own stated instinct. See §4 for the recommended discriminator.

---

## 4. PROPOSED DOMAIN MODEL

### 4.1 `pools.entry_mode`

```sql
create type public.entry_mode as enum ('PAID', 'FREE');

alter table public.pools
  add column entry_mode public.entry_mode not null default 'PAID';

alter table public.pools alter column entry_fee drop not null;
alter table public.pools drop constraint pools_entry_fee_check; -- old: entry_fee > 0
-- The conditional CHECK constraint here was strengthened per a later locked
-- decision (Decision 4) to also cover house_fee_bps and tier_group_id, not just
-- entry_fee — see the current, superseding version in §12 ("Database migration").
```

`house_fee_bps` needs **no schema change** — it already allows `0`, and a FREE pool simply carries `house_fee_bps = 0` with no settlement math ever reading it. `tier_group_id` needs no change either — tiers are inherently a PAID-only concept (fee tiers only make sense where there's a fee); FREE pools simply never populate it, and the existing partial index (`where tier_group_id is not null`) is already a no-op for them.

This mirrors the codebase's own established idiom for extending pool-level enums (`pool_type` grew via four separate `alter type ... add value` migrations, each paired with a matching TS union update in `lib/pools/templates.ts` and flat `pool.pool_type === "X"` branches at specific call sites — confirmed pattern). `entry_mode` follows the identical shape: one enum, one TS union, flat branches at the same handful of call sites that already branch on `pool_type` today (`lib/pools/view-model.ts`, `lib/pools/settle.ts`, the admin pool pages).

### 4.2 `entries.amount` — nullable, not zero

```sql
alter table public.entries alter column amount drop not null;
alter table public.entries drop constraint entries_amount_check; -- old: amount > 0
alter table public.entries add constraint entries_amount_check
  check (amount is null or amount > 0);
```

`NULL` means "not applicable" (a FREE entry never had a cost); `0` would mean "a zero-dollar transaction occurred," which is the wrong claim and the thing §3 shows is actually unsafe. This is a deliberate, minimal schema change — not a new financial relation — and it buys something important for free: every `SUM(e.amount)` in the existing analytics RPCs **already excludes FREE rows under standard SQL NULL semantics**, with no new `WHERE` clause required. The only aggregates that need an explicit filter are the `COUNT(*)`-based ones (see §11), since `COUNT(*)` doesn't care whether a column is null.

### 4.3 Capability predicates

Per the user's own naming preference, centralize the money-vs-free branching into small predicate functions (e.g. `lib/pools/capabilities.ts`) rather than scattering `pool.entryMode === "FREE"` through dozens of files:

```ts
export function requiresPayment(pool: { entryMode: EntryMode }): boolean {
  return pool.entryMode === "PAID";
}
export const usesWallet = requiresPayment;
export function hasPrizePool(pool: { entryMode: EntryMode }): boolean {
  return pool.entryMode === "PAID"; // today. See §"sponsored prizes" note below.
}
export const showsEstimatedReturn = hasPrizePool;
export const requiresFinancialSettlement = requiresPayment;
export function supportsRefund(pool: { entryMode: EntryMode }): boolean {
  return pool.entryMode === "PAID";
}
export const supportsCashPayout = hasPrizePool;
```

Every predicate is a one-line function of `entryMode` today — but naming `hasPrizePool`/`supportsCashPayout` *separately* from `requiresPayment` is exactly what keeps a future sponsored-prize FREE pool (out of scope for this proposal, per your instruction) from requiring a rename: that future feature would only need `hasPrizePool` to stop being a pure alias of `requiresPayment`, with zero call-site changes anywhere these predicates are already used.

### 4.4 What does NOT change

No `FreePool`/`PaidPool` type split. `pools` stays one table, `entries` stays one table. `SocialPoolCard` stays one component (see §10). The existing money engine (`apply_wallet_transaction`, `confirm_pool_settlement`, `confirm_pool_refund`, `reverse_pool_settlement`) gets **zero modifications** — only new call sites deciding *whether* to invoke them (see §7–9).

---

## 5. GLOBAL PLATFORM CONTROL

### 5.1 Storage

Extend the existing `platform_settings` singleton row — the exact same table `registration_enabled` already lives on (`id boolean primary key default true, constraint platform_settings_singleton check (id)`). This is a proven, audited pattern already used for a global capability flag; no new table needed.

```sql
alter table public.platform_settings
  add column paid_pools_enabled boolean not null default true,
  add column free_pools_enabled boolean not null default true;
```

**Two independent booleans, not a two-state `PAID_AND_FREE`/`FREE_ONLY` enum.** This directly answers your own rollback-safety concern: a two-state enum cannot represent "disable FREE, keep PAID" without adding a third value later (more schema churn, another migration). Two booleans naturally cover every sensible combination:

| `paid_pools_enabled` | `free_pools_enabled` | Meaning |
|---|---|---|
| true | true | Normal operation (default) |
| false | true | FREE ONLY — what you described |
| true | false | PAID ONLY — FREE disabled if something's wrong with it |
| false | false | No new pools of either mode — legal at the DB level, but the admin UI should require an explicit confirmation and show a strong warning, not forbid it outright (forbidding it would be a business-logic opinion baked into schema, which is the same rigidity problem the two-state enum has) |

### 5.2 Backend enforcement — where the check actually lives

**REVISED per locked decision.** The original proposal put the capability check only at creation/publish time, reasoning that an already-`OPEN` pool's entrants should be unaffected by a later toggle flip. **That reasoning has been overruled.** The locked semantics are:

> If `paid_pools_enabled = false`, no new PAID entry may be created from that moment forward — including into a pool that was already `OPEN` before the toggle changed. Existing entries and the pool's own lifecycle (lock, grading, settlement, refund, reversal) are completely unaffected. The toggle is a kill switch on *new exposure*, not a pool-level circuit breaker.

This means the check now happens at **two** points, with the second one being the actual security boundary:

1. **Creation/publish layer** (unchanged in mechanism from the original proposal — Server Action pre-check + the `enforce_paid_pool_capability`/`enforce_free_pool_capability` DB triggers scoped to the `DRAFT/absent → OPEN` transition). This remains useful as a UX courtesy — it stops an admin from publishing a new pool of a currently-disabled mode — but per the locked decision it is **no longer sufficient on its own**, since a pool published while enabled can still be sitting `OPEN` when the toggle later flips off.
2. **Entry-time layer — now the authoritative gate.** `create_pool_entry` re-reads the relevant capability flag inside its own transaction, on every call, immediately after resolving `v_pool.entry_mode` and strictly **before** the entry insert, before any `pool_options` counter mutation, and before `apply_wallet_transaction` is ever reached.

**REVISED — fail-closed and genuinely serialized against the admin toggle**, correcting two gaps identified in review: (a) the original pseudocode treated a missing/NULL flag as implicitly falsy via `not (select ...)`, which is fragile — a `NULL` boolean makes `not NULL` evaluate to `NULL`, not `TRUE`, so an `if not (select ...)` guard would silently **fail open** (skip the `raise`) if the singleton row were ever missing; (b) reading `platform_settings` with a plain (lock-free) `SELECT` inside the same transaction as the `pools` row lock does *not* by itself create any ordering guarantee against a concurrent `UPDATE platform_settings` — the two are different rows in a different table, so nothing stops the sequence "entry reads `enabled=true` → admin's UPDATE commits `disabled` → entry's `apply_wallet_transaction` still proceeds." Both gaps are closed by locking the settings row with `FOR SHARE` and testing `IS DISTINCT FROM TRUE` rather than `NOT (...)`. See the "TOGGLE/ENTRY SERIALIZATION DESIGN" analysis below the code block for why `FOR SHARE` specifically is the correct lock mode.

```sql
-- inside create_pool_entry, after the existing pool/status/lock/option/user
-- validation (unchanged, including the pools-row `for update` lock, which is
-- acquired FIRST — see the canonical lock order note below), and before any
-- mutation:

declare
  v_paid_enabled boolean;
  v_free_enabled boolean;
begin
  select paid_pools_enabled, free_pools_enabled
    into v_paid_enabled, v_free_enabled
    from public.platform_settings
    where id = true
    for share;

  if not found then
    -- Fail closed: a missing singleton row is an operational anomaly, not an
    -- implicit "enabled." Distinct exception name so this is distinguishable
    -- from an intentional disable in logs/monitoring.
    raise exception 'platform_settings_missing';
  end if;

  if v_pool.entry_mode = 'PAID' then
    if v_paid_enabled is distinct from true then
      -- Catches false AND null. NULL is not reachable under the current
      -- `not null` column definition, but this is deliberately defensive
      -- against any future relaxation of that constraint.
      raise exception 'paid_pools_disabled';
    end if;
  else
    if v_free_enabled is distinct from true then
      raise exception 'free_pools_disabled';
    end if;
  end if;
end;

-- only past this point: entry insert, pool_options mutation, apply_wallet_transaction (PAID only)
```

**Canonical lock order (documented invariant, not just a comment on this one function)**: any transaction that needs both a specific `pools` row and the `platform_settings` singleton row must acquire the `pools` row lock first, then `platform_settings`. This is already `create_pool_entry`'s natural order (the pool is locked during the existing validation block, before this new code runs) and must be preserved by any future RPC touching both. See the deadlock analysis in §13 for why this order, combined with the fact that the only writer of `platform_settings` (the admin toggle action) never subsequently locks any `pools` row, makes a deadlock structurally impossible rather than merely unlikely.

Only the RPC's own read, at the moment it acquires (or waits for) the `platform_settings` lock, is authoritative. See §7 for the full updated RPC sketch and §13 for the confirmed race scenario, the serialization design, and the deadlock analysis.

**Settlement, grading, refund, and reversal never consult these flags — this is unchanged and explicitly reaffirmed.** `confirm_pool_settlement`, `confirm_pool_grading_only`, `confirm_pool_refund`, `void_pool_no_refund`, and `reverse_pool_settlement` do not read `platform_settings` at all. Once an entry exists, its pool's lifecycle completes exactly as it would have regardless of the toggle's current state at any later point. The toggle is consulted exactly once per entry attempt, inside `create_pool_entry`, and nowhere else.

The DB triggers from the original proposal are retained (below) as the creation/publish-time courtesy layer described above — kept tightly scoped so they never fire on ordinary lifecycle transitions (`LOCKED → AWAITING_RESULT`, settlement, etc.) for a pool that's already `OPEN`:

**REVISED — same fail-closed and lock discipline as §5.2's entry-time check, for consistency**, even though this layer is now a courtesy rather than the primary boundary:

```sql
create or replace function public.enforce_paid_pool_capability()
returns trigger language plpgsql as $$
declare v_paid_enabled boolean;
begin
  if NEW.entry_mode = 'PAID' and NEW.status = 'OPEN'
     and (TG_OP = 'INSERT' or OLD.status is distinct from 'OPEN') then

    select paid_pools_enabled into v_paid_enabled
      from public.platform_settings where id = true for share;

    if not found or v_paid_enabled is distinct from true then
      raise exception 'paid_pools_disabled';
    end if;
  end if;
  return NEW;
end;
$$;
```

(A mirror trigger/condition for `free_pools_enabled` when `entry_mode = 'FREE'`.) Using `FOR SHARE` here too is not strictly required by the review's linearization ask (which targeted the entry-time check specifically), but it's free to add and closes the analogous, much-lower-value gap where an admin disables mid-commit of a publish. Because this trigger's transaction locks its own `pools` row before this `SELECT ... FOR SHARE` — the same order as §5.2 — it introduces no new deadlock risk (see §13).

### 5.3 Admin UX

New `<Card>` block on `/admin/settings`, following the exact `RegistrationToggle` component shape (`app/(admin)/admin/settings/registration-toggle.tsx` — controlled boolean, optimistic local state, `useTransition`, server-action call, error display on failure). Two toggles, each requiring an explicit confirmation dialog when being switched **off** (since turning either off is the consequential direction), with warning copy specific to which one:

- Turning off **Paid pools**: *"No new paid entries will be accepted, effective immediately — including on pools that are already open. Pools already open, locked, or in review continue to their normal conclusion: existing entries, grading, settlement, refunds, and reversals are unaffected."*
- Turning off **Free pools**: *"No new free predictions will be accepted, effective immediately — including on predictions already in progress. Existing free predictions continue grading normally."*

### 5.4 Lifecycle semantics per pool state — LOCKED DECISION

This is a locked decision, not an open question (the original proposal's "flag for sign-off" framing here is superseded). Applies to **PAID** pools reacting to `paid_pools_enabled` flipping to `false`; the identical rule applies symmetrically to **FREE** pools under `free_pools_enabled`.

| Pool state | Behavior when `paid_pools_enabled` flips to false |
|---|---|
| `DRAFT` | Editable/deletable freely (never had money). Publishing is blocked (creation/publish-layer check, §5.2 item 1). |
| `OPEN`, zero entries | **New entries blocked immediately** — re-checked on every `create_pool_entry` call for this exact pool, not just at publish time. The global switch never mutates this row directly. At its natural `locks_at`, the existing below-minimum logic in `advance_or_cancel_locked_pool` cancels it via `confirm_pool_refund` — a no-op refund loop since there are no entries. No new code needed for this case. |
| `OPEN`, real entries | **New entries blocked immediately** for every user from this moment forward, including for the pool's own existing entrants attempting a *second* entry (though `max_entries_per_user` already forbids that independently). Existing entries are completely unaffected — no entry is deleted, refunded, or altered. The pool still locks, grades, and settles on its normal schedule. |
| `LOCKED`, `AWAITING_RESULT`, `READY_FOR_REVIEW` | No entry is possible in these states regardless of the toggle (status machine's existing behavior) — proceeds to grading/settlement exactly as before, since these paths never consult the toggle (§5.2). |
| `SETTLED`, `VOIDED`, `CANCELLED`, `SETTLEMENT_REVERSED`, `REVERSAL_FAILED_MANUAL_REVIEW`, `MANUAL_REVIEW` | Terminal or admin-attention states — completely untouched by the global toggle either way. |

**Re-enabling**: if `paid_pools_enabled` is switched back to `true` while a pool is still `OPEN` and before `locks_at`, new entries resume immediately on the very next `create_pool_entry` call — there is no separate "re-activation" step, since the RPC reads the current flag value fresh on every invocation (§5.2, §7).

### 5.5 Audit trail

Reuse `audit_logs` (already proven: append-only via trigger, `before`/`after` jsonb, `actor_id`, super-admin-only read via RLS) exactly as `setRegistrationEnabledAction` already does — but improve on that precedent by populating **both** `before` and `after` (the existing registration toggle only writes `after`, a gap worth closing here):

```ts
await writeAuditLog({
  actorId: admin.id,
  action: "settings.paid_pools_enabled_changed",
  entityType: "platform_settings",
  entityId: null,
  before: { paidPoolsEnabled: previousValue },
  after: { paidPoolsEnabled: enabled },
});
```

---

## 6. PER-POOL MODE

**Creation**: admin picks `Paid` / `Free` as a new field in the creation wizard (§10). The chosen value is inserted once, at row-creation time, from the trusted server action — never client-echoed back for a later update.

**Immutability**: extend `enforce_pool_fee_immutability`'s protected-column list (currently `question`, `pool_type`, `title`, `template_id`, `template_config`) to include `entry_mode`, once `first_entry_at is not null`. This is a one-line addition to an existing trigger, not a new mechanism — and it's actually a *stronger* guarantee than fee immutability currently gets: recall `entry_fee`/`house_fee_bps` were deliberately *un*-frozen in `20260101000072_relax_fee_immutability.sql` for beta flexibility. `entry_mode` must **not** get that same relaxation — converting an active PAID pool to FREE in place (or vice versa) is exactly the scenario you called out as never acceptable, and it's semantically different from adjusting a fee amount: it would silently invalidate every already-collected entry's meaning.

Immutability and the creation/publish-time DB trigger (§5.2 item 1) are the guardrails on a pool's *own* mode; they are a separate concern from the entry-time capability gate (§5.2 item 2, §7), which governs whether *new entries* are currently allowed into an already-`OPEN` pool of that mode. A reader should not conflate the two: a pool's mode being immutable says nothing about whether the platform is currently accepting new entries of that mode.

**Historical snapshot behavior**: because `entry_mode` is a plain column on the `pools` row (not derived from a template or a platform setting at read time), a pool's mode remains knowable forever regardless of later template/platform changes — exactly your stated requirement. This mirrors the existing precedent of `pools.analytics_category` and `pools.template_version`, both deliberately snapshotted at creation and immune to later drift in their source-of-truth tables (confirmed in the audit of the template system).

---

## 7. FREE ENTRY FLOW

Exact backend sequence, as an added branch inside the existing `create_pool_entry` RPC (not a parallel RPC — entry creation is generic enough across modes that a second RPC would duplicate the validation preamble: user-active check, pool-lock check, option-validity check, idempotency-replay check, all identical for both modes):

**REVISED per three locked decisions**: (1) the capability check from §5.2 is now the first thing this branch does, before any mutation, and (2) it is fail-closed and lock-serialized against the admin toggle (`FOR SHARE` + `IS DISTINCT FROM TRUE`, not a bare boolean read); (3) FREE no longer silently coerces a supplied amount to `null` — it rejects a caller-supplied amount outright.

```sql
-- inside create_pool_entry, after validating option/pool/user (unchanged
-- — including the pools-row `for update` lock, acquired first per the
-- canonical lock order in §5.2/§13):

declare
  v_paid_enabled boolean;
  v_free_enabled boolean;
begin
  select paid_pools_enabled, free_pools_enabled
    into v_paid_enabled, v_free_enabled
    from public.platform_settings
    where id = true
    for share; -- linearization point against the admin toggle — see §13

  if not found then
    raise exception 'platform_settings_missing'; -- fail closed on missing config
  end if;

  if v_pool.entry_mode = 'PAID' then
    if v_paid_enabled is distinct from true then -- catches false AND null
      raise exception 'paid_pools_disabled';
    end if;

    -- explicit null-check added: previously `p_amount <> v_pool.entry_fee` with a
    -- null p_amount evaluates to SQL NULL (neither true nor false), which would
    -- have silently fallen through this guard rather than raising. Made explicit.
    if p_amount is null or p_amount <> v_pool.entry_fee then
      raise exception 'amount_mismatch';
    end if;
  else -- FREE
    if v_free_enabled is distinct from true then
      raise exception 'free_pools_disabled';
    end if;

    -- Reject, don't coerce. The canonical FREE request supplies p_amount = null.
    -- A caller that supplies any non-null amount (including 0) is rejected
    -- explicitly, before the entry row exists — never silently rewritten.
    if p_amount is not null then
      raise exception 'amount_not_allowed_for_free_pool';
    end if;
  end if;
end;

insert into public.entries (pool_id, user_id, option_id, amount, status, idempotency_key, tier_group_id)
values (p_pool_id, p_user_id, p_option_id, p_amount, 'ACTIVE', p_idempotency_key, v_pool.tier_group_id)
returning * into v_result;

-- (unique_violation handling unchanged — idempotency/dup-entry logic is mode-agnostic)

if v_pool.entry_mode = 'PAID' then
  perform public.apply_wallet_transaction(
    'user'::public.wallet_account_type, p_user_id, 'pool_entry_debit'::public.wallet_transaction_type,
    'debit'::public.wallet_direction, p_amount, null, null,
    p_idempotency_key || ':wallet', p_pool_id, v_result.id, null
  );
end if;
-- FREE: apply_wallet_transaction is never called. Zero changes to that function.

update public.pool_options
  set entry_count = entry_count + 1,
      total_entry_amount = total_entry_amount + coalesce(p_amount, 0)
where id = p_option_id;
-- (total_entry_amount naturally stays untouched by FREE entries via coalesce)
```

The PAID money-moving code itself — the `apply_wallet_transaction` call and everything after the guards — is **byte-identical** to today's unconditional code; the capability check and the amount validation are both guard clauses that run *before* it, not modifications to it.

**Client-side contract** (`enterPoolAction`, `lib/actions/entries.ts`, and `enterPoolSchema`, `lib/validations/pools.ts`): `amountCents` becomes genuinely optional/nullable. For a FREE pool, the client must **omit the field or send an explicit `null`** — never default it to `0`. `0` is not "absent," and per Decision 3 a `0` sent against a FREE pool is now rejected exactly like any other non-null amount; this is intentional, not a bug to work around. `enterPoolAction`'s error-mapping chain gains four new branches:

```ts
if (error.message.includes("paid_pools_disabled")) {
  return { error: "Paid pools are temporarily unavailable. Try again later.", success: false };
}
if (error.message.includes("free_pools_disabled")) {
  return { error: "Free pools are temporarily unavailable. Try again later.", success: false };
}
if (error.message.includes("platform_settings_missing")) {
  // Operational anomaly, not a user-caused state — same fallback copy as
  // *_disabled from the player's point of view, but should page/alert
  // on-call separately (see §16) since it indicates broken config, not an
  // intentional admin action.
  return { error: "Entries are temporarily unavailable. Try again later.", success: false };
}
if (error.message.includes("amount_not_allowed_for_free_pool")) {
  // Should never fire from legitimate UI — the FREE confirmation sheet never
  // sends an amount field at all. A generic fallback is fine here since this
  // only indicates a manipulated request, not a state the UI needs to explain.
  return { error: "Could not submit your entry. Try again.", success: false };
}
```

---

## 8. FREE GRADING / RESULT FLOW

The audit confirms grading and financial settlement are **already structurally separable** even though they're operationally chained today for `TEMPLATE_GRADED` pools: `pool_grading_evidence` is its own append-only table with no FK to `pools` (survives even a hard-deleted pool), and the pure `gradingRule(fixture, config) → YES/NO/VOID/PENDING` function has zero awareness of money. This is exactly the "smallest safe separation" you asked to leverage rather than build from scratch.

**Recommendation: reuse the same grading determination, route to a new sibling RPC instead of `confirm_pool_settlement`.**

```sql
create or replace function public.confirm_pool_grading_only(
  p_pool_id uuid, p_grading_version int, p_idempotency_key text, p_winning_option_id uuid
) returns public.pools
security definer set search_path = public
language plpgsql as $$
begin
  -- same idempotent/terminal-state guards as confirm_pool_settlement

  update public.entries set status = 'WON'
    where pool_id = p_pool_id and status = 'ACTIVE' and option_id = p_winning_option_id;
  update public.entries set status = 'LOST'
    where pool_id = p_pool_id and status = 'ACTIVE' and option_id <> p_winning_option_id;

  update public.pool_options set is_winning_option = (id = p_winning_option_id)
    where pool_id = p_pool_id;

  -- duplicated verbatim from confirm_pool_settlement's streak block (see risk note below):
  update public.user_profiles set current_streak = 0
    where id in (select user_id from public.entries where pool_id = p_pool_id and status = 'LOST');
  update public.user_profiles
    set correct_predictions_count = correct_predictions_count + 1,
        current_streak = current_streak + 1,
        best_streak = greatest(best_streak, current_streak + 1)
    where id in (select user_id from public.entries where pool_id = p_pool_id and status = 'WON');

  update public.pools set status = 'SETTLED' where id = p_pool_id
  returning * into ...;
end;
$$;
```

Dispatch point: `gradeTemplatePool()` (`lib/pools/templates/grade.ts`) branches on `pool.entry_mode` to call `confirm_pool_settlement` (unchanged, PAID) vs. `confirm_pool_grading_only` (new, FREE) after the identical `prepare_pool_settlement_manual`/evidence-write steps.

**Explicit reaffirmation given §5/§13's revision**: neither `confirm_pool_grading_only` nor `confirm_pool_settlement` reads `paid_pools_enabled`/`free_pools_enabled` at all. The capability toggle is consulted exactly once, inside `create_pool_entry`, at the moment an entry is created (§5.2, §7) — never again for that entry's remaining lifecycle. A pool that was entered while its mode was enabled grades and settles identically regardless of the toggle's state by the time grading runs. Reusing `SETTLED` as the terminal status (rather than inventing a 13th `pool_status` value) is deliberate — "grading is final" is true for both modes, and every consumer that already branches on `pool_status = 'SETTLED'` (leaderboard eligibility, profile history bucketing) keeps working with zero changes.

**Void/cancel for FREE** (below-minimum at lock, fixture anomaly): needs an analogous new sibling, `void_pool_no_refund(p_pool_id, p_void_reason, p_idempotency_key)`, since routing a FREE pool through `confirm_pool_refund` would try to credit `$0` refunds and hit the same wallet-engine guard from §3. This new function sets `ACTIVE` entries to `VOID`, pool status to `CANCELLED`/`VOIDED` per the same reason mapping as today, and skips the wallet loop entirely. `advance_or_cancel_locked_pool` and the anomaly-handling call in `lib/pools/settle.ts` branch on `entry_mode` to call one or the other.

**Explicit risk called out, not hidden**: `confirm_pool_grading_only`'s streak-update block is a **duplicate** of SQL that already lives inside `confirm_pool_settlement`, not an extracted shared helper. Extracting a shared function would technically touch (refactor) the settlement engine, which you asked to avoid unless necessary; duplicating a small, stable block keeps `confirm_pool_settlement` completely untouched at the cost of the two blocks needing to be kept in sync if streak logic ever changes. This is a deliberate tradeoff — flagging it for your call before implementation, since either choice is defensible depending on how much you weigh "zero touch to the money engine" against "no duplicated logic."

---

## 9. PAID FLOW REGRESSION SAFETY

The existing money engine requires **zero modifications** under this design:

- `apply_wallet_transaction` — untouched. Never called for FREE entries/settlement/void.
- `confirm_pool_settlement` — untouched. Only called for PAID pools, exactly as today.
- `confirm_pool_refund` — untouched. Only called for PAID pools; FREE uses the new `void_pool_no_refund` sibling.
- `reverse_pool_settlement` — untouched; reversal is inherently a PAID-only concept (there's nothing to claw back from a FREE pool), and `entry_mode = 'PAID'` can be asserted defensively at the top of `requestReversalAction` if desired.
- `create_pool_entry` — the **one** function that grows new logic, now in two forms: a capability gate (§5.2) and a mode dispatch (PAID amount-match vs. FREE amount-rejection, §7), both guard clauses evaluated *before* any mutation. The existing PAID money-moving code itself — the `apply_wallet_transaction` call and everything structurally after the guards — is preserved verbatim (see §7's inline diff — every line that runs today for a legitimate PAID entry still runs, unchanged, in the same order, once past the two new guards).

**Verification discipline**: the full existing suite — 708 tests across 82 unit + 36 integration files, including the specifically financial-invariant-focused `wallet.test.ts` (concurrent-debit serialization, idempotent replay), `settlement-logic.test.ts` (exact parimutuel math), `settlements.test.ts`, and `reversal.test.ts` — must pass **unchanged, with zero modified assertions**, after every phase of implementation. Because `entry_mode` defaults to `'PAID'` and every seeded/existing pool backfills to `'PAID'` (§12), none of today's tests exercise a new code path unless they're extended to — meaning the entire existing suite functions as a regression gate essentially for free.

---

## 10. UI CHANGES

### Player-facing

- **`SocialPoolCard.tsx`**: the single existing money gate (`balanceCents < viewModel.entryFee`, line 328) becomes a three-way dispatch on `requiresPayment(viewModel)`: `false` → new lightweight `FreeEntryConfirmationSheet` (no fee/balance/top-up UI at all — "Pick → Confirm → You're in", per your mock); `true` and insufficient balance → `TopUpAndJoinModal` (unchanged); `true` and sufficient balance → `EntryConfirmationSheet` (unchanged). This is a component-selection branch, not new internal branching inside either existing sheet — matching your "centralize, don't scatter" instruction at the point where it matters most.
- **`PoolSummary.tsx`**: `grossPool` prop becomes optional; when absent (FREE), render `"{participantCount} predicted"` instead of `"{participantCount} entered"` and omit the pot line entirely — never `$0 pot`, per your explicit instruction.
- **`CommunitySplit.tsx`**: **no change** — already entry-count-based, confirmed by its own code comment.
- **`view-model.ts`**: `entryFee`, `houseFeeBasisPoints`, `grossPool`, `estimatedNetPrizePool`, `options[].estimatedPayout`, `currentUser.{entryAmount,estimatedPayout,finalPayout,refundedAmount}` all become `| null` in the TS type; `buildPoolCardViewModel` skips the parimutuel-math block (`computeOptionStats`'s payout half, `estimatedNetPrizePool` computation) entirely for FREE pools — that block is already cleanly isolated (confirmed by the audit), so this is a guard clause, not a rewrite.
- **Entry confirmation error display**: because capability rejection (§5.2, §7) can now happen at the moment a player presses Confirm — even for a pool that loaded successfully and looked enterable — `EntryConfirmationSheet`/`FreeEntryConfirmationSheet` must surface the new `paid_pools_disabled`/`free_pools_disabled` error text (§7) clearly rather than falling back to a generic "something went wrong" string, since the player did nothing wrong and a vague error would read as a bug. This is the one new player-facing failure mode introduced by Decision 1/2 and should get its own short copy review, not just reuse the sheet's existing generic fallback.
- **Notification/history copy**: `buildNoticeCopy()` (`lib/pools/notices.ts`) needs a parallel FREE-mode arm for each of its ~14 branches (WON + 13 void reasons) — this is a concrete, enumerable list, not open-ended work. Examples: `"You won ${formatCents(...)}"` → `"You got it right!"`; `"Not enough players joined. This pool has been cancelled and your $X entry has been credited back"` → `"Not enough players joined. This pool has been cancelled."` (no refund clause). `lib/notifications/create.ts`'s `transaction_id`-based correlation must become optional/null for FREE notifications (a FREE settlement/void never produces a `wallet_transactions` row to correlate to).
- **Pool detail page** (`app/(app)/pool/[id]/page.tsx`): no changes needed — it's a thin wrapper around `SocialPoolCard` and inherits every change above automatically. It will keep fetching `wallet_balances`/`paymentMethods` unconditionally even for FREE pools; this is deliberately left as-is (harmless, cheap) rather than special-cased, to avoid complicating a data-fetch for a minor efficiency gain.
- **Profile/history** (`predictions-tab.tsx`): no changes needed beyond what `SocialPoolCard`/`buildNoticeCopy` already provide — it just re-renders the card per entry.

### Admin

- **Pool creation wizard**: new "Pool mode" field (Paid/Free radio), gated by `free_pools_enabled`/`paid_pools_enabled` (disabled options, not just hidden, when the platform forbids one). When `Free` is selected, Step 3's entire fee UI (single/tiered entry-fee inputs, house-fee-percent input, tier picker) is hidden outright — never rendered with a `$0` value — and `step3Valid` for FREE requires only `locksAt` to be set. The existing PAID single/tiered branch stays completely intact as a sibling path, not nested inside new mode-conditional logic (avoids risking the already-shipped, already-tested tier-fee feature).
- **Super Admin settings** (`/admin/settings`): two new toggle cards (§5.3), following `RegistrationToggle`'s exact shape.

### Security-relevant UI note

Every hide/disable above is a UX convenience only — §5.2 and §13 specify the actual enforcement at the Server Action and DB-trigger layers, since (per the RPC-drift precedent) a UI-only gate is not a security boundary in this codebase's own demonstrated history.

---

## 11. ANALYTICS / LEADERBOARDS / STREAKS

**Leaderboard** (`get_leaderboard` SQL RPC): confirmed **zero references to `entry_fee`, `pool_type`, `amount`, or any money value anywhere** — ranked purely by `correct_count / total_count` over `entries.status in ('WON','LOST')`. This means **combined PAID+FREE accuracy/rank is the default, zero-code-change outcome** the moment FREE entries start writing `WON`/`LOST` via `confirm_pool_grading_only` (§8). No leaderboard code needs to change.

**Streaks** (`user_profiles.current_streak`/`best_streak`): same story — updated unconditionally inside the settlement path regardless of pool type today, confirmed by the audit. Combined by default once `confirm_pool_grading_only` includes the duplicated streak-update block (§8).

**Recommendation: Option C (both)** — ship combined accuracy/streak/leaderboard (the free default), and treat any future "paid-only leaderboard" as an explicit, separate, not-yet-requested filter using `pool.entry_mode`, rather than building it speculatively now.

**Financial analytics** — must exclude FREE, and mostly do so automatically via §4.2's nullable-`amount` design (`SUM`/`AVG` skip `NULL`):

| Function | Needs a new filter? | Why |
|---|---|---|
| `get_platform_financial_overview`, `get_user_financial_overview` | No | Already driven by `wallet_transactions` joins — FREE never writes wallet rows, so these are naturally PAID-only. |
| `get_user_bankroll_balance`, `get_user_cumulative_pnl` | No | Same — pure `wallet_transactions` derivation. |
| `get_platform_overview`, `get_user_analytics_overview` (`pools_entered`, `entry_volume` counts) | **Yes** | `count(*)` counts rows regardless of `amount` being `NULL` — needs `count(*) filter (where e.amount is not null)` or an `entry_mode = 'PAID'` join condition. |
| `get_platform_top_users` (Entries/Volume columns) | **Yes** | Same reason. |
| `get_platform_category_performance`, `get_platform_monthly_activity` | **Yes**, for the count-shaped columns only | The `sum(e.amount)`/`sum(net)` columns self-exclude via NULL; any adjacent `count(*)` column does not. |
| `get_user_entry_history` | Partial | Display-only; needs to render "Free" rather than `$0.00` wherever `amount is null`, but needs no aggregate filter. |
| `get_leaderboard` | No | Confirmed money-agnostic already. |

**Engagement metrics (participants, predictions made, accuracy, retention, community split, streaks)**: combine PAID+FREE with no filtering — already mode-agnostic today.

This produces a clean two-tier taxonomy: **"how much money moved" (PAID-only, mostly free via NULL semantics) vs. "how much the community engaged" (combined, already mode-agnostic)** — directly matching what you asked for.

---

## 12. DATABASE MIGRATION

Forward-only, no edits to applied migrations (matching this repo's own discipline — confirmed via `20260101000107_security_incident_restore_rpc_privileges.sql` and `20260101000122`/`20260101000123` all being pure forward migrations that redefine functions with `create or replace` rather than editing history).

```sql
-- Migration N: entry_mode + nullable amount, fully additive/backward-compatible

create type public.entry_mode as enum ('PAID', 'FREE');

alter table public.pools add column entry_mode public.entry_mode not null default 'PAID';
-- every existing row backfills to 'PAID' via the column default at add-time — explicit, not inferred from entry_fee.
-- NOT NULL is safe to apply immediately (not a two-step "add nullable, backfill, then NOT NULL" dance)
-- specifically because the default makes every existing row already correct at add-time.

alter table public.entries alter column amount drop not null;
alter table public.entries drop constraint entries_amount_check;
alter table public.entries add constraint entries_amount_check check (amount is null or amount > 0);
-- existing rows are untouched (all currently non-null, positive) — this only widens what's legal going forward.

alter table public.pools alter column entry_fee drop not null;
alter table public.pools drop constraint pools_entry_fee_check;

-- STRENGTHENED per locked decision (§4.1 superseded — this is the current version):
-- a FREE pool must be unable to retain ANY financial configuration, not just entry_fee.
alter table public.pools add constraint pools_entry_mode_financial_check check (
  (entry_mode = 'PAID'
    and entry_fee is not null
    and entry_fee > 0)
  or
  (entry_mode = 'FREE'
    and entry_fee is null
    and house_fee_bps = 0
    and tier_group_id is null)
);
-- every existing row has entry_mode = 'PAID', entry_fee > 0 already — constraint is
-- satisfied by construction, no backfill needed. The existing
-- `house_fee_bps between 0 and 10000` range check is untouched: 0 is already legal
-- under it for every pool; this constraint adds the requirement that it be *exactly*
-- 0 specifically when entry_mode = 'FREE', without loosening or tightening PAID's
-- range. tier_group_id is null for FREE is now enforced at the constraint level,
-- not just "FREE happens to never populate it" — a FREE + paid-fee-tier row becomes
-- genuinely impossible to insert, not merely unlikely. No existing tier/fee rule for
-- PAID pools is touched — `unique_active_user_entry_per_tier_group` and the tier
-- creation path (§ per pool-domain audit) are unaffected.
--
-- entries.amount is unchanged from the original proposal
-- (`amount is null or amount > 0`) — Decision 4 named pools-level financial
-- configuration columns specifically, not the entry-level amount. The
-- reject-vs-null-coerce rule for a client-supplied FREE amount (Decision 3) is
-- procedural, enforced inside create_pool_entry (§7), not via a table CHECK — a
-- CHECK constraint can't distinguish "caller supplied a value" from "caller
-- supplied null after server-side processing," so it has to be RPC-level logic.

alter table public.platform_settings
  add column paid_pools_enabled boolean not null default true,
  add column free_pools_enabled boolean not null default true;

create index idx_pools_entry_mode on public.pools (entry_mode) where entry_mode = 'FREE';
-- sparse index: FREE pools will be a minority for the foreseeable future, mirrors the existing tier_group_id partial-index idiom.
```

```sql
-- Migration N+1: enforce_pool_fee_immutability trigger extended to also freeze entry_mode
-- (redefine the existing function via create or replace, add entry_mode to its protected-column comparison — no new trigger object needed)
```

```sql
-- Migration N+2: enforce_paid_pool_capability / enforce_free_pool_capability triggers (§5.2)
-- Migration N+3: confirm_pool_grading_only, void_pool_no_refund RPCs (§8), with the same
--   revoke all from public; grant execute to service_role only pattern as every existing
--   money-adjacent RPC, and — given §1's precedent — an explicit manual verification pass
--   confirming their actual grants in the target database match intent before this ships.
```

`entry_mode NOT NULL` from day one (no separate "make it required later" step) is safe here specifically because the column has a default and there is no ambiguity to resolve — every current row genuinely *is* historically PAID, not "PAID because we don't know," so there's no inference risk your instructions correctly worried about.

---

## 13. SECURITY / RACE CONDITIONS

**Trusted enforcement points** (fail-closed, per layer):

| Concern | Layer | Mechanism |
|---|---|---|
| Global PAID/FREE capability — new entries | `create_pool_entry` RPC, `SECURITY DEFINER`, `service_role`-only, re-checked on every call, `FOR SHARE`-locked and fail-closed | §5.2 item 2, §7, and the serialization design below |
| Global PAID/FREE capability — new pool creation/publish | Server Action (fast UX) + DB trigger (courtesy layer, same fail-closed treatment) | §5.2 item 1 |
| Per-pool `entry_mode` immutability | DB trigger (extended `enforce_pool_fee_immutability`) | §6 |
| Entry amount contract (PAID exact-match / FREE reject-non-null) | `create_pool_entry` RPC | §7 |
| Settlement routing | Dispatch in `gradeTemplatePool`, calling one of two RPCs both `SECURITY DEFINER`/`service_role`-only, neither reading platform capability | §8 |
| RLS on `entries`/`wallet_transactions` | **Unchanged** — FREE entries are ordinary `entries` rows under the same owner-scoped `SELECT` policy; `wallet_transactions` simply never gets a FREE-related row | §1 |

**REVISED — the race described is the confirmed, intended behavior, and this revision closes a genuine gap in how the prior draft claimed that was guaranteed.** The prior draft asserted that reading `platform_settings` "inside the same transaction as the pool row's `for update` lock" was, by itself, enough to serialize a toggle flip against an in-flight entry. **That was an overstatement, corrected here.** `pools` and `platform_settings` are different rows in different tables — locking one creates no ordering relationship with the other. Without an explicit mechanism, the following interleaving is possible under a plain (lock-free) read:

```
T1 (entry):  reads paid_pools_enabled = true
T2 (admin):  UPDATE platform_settings SET paid_pools_enabled = false ...
T2 (admin):  COMMIT
T1 (entry):  proceeds to apply_wallet_transaction anyway — using its stale read
T1 (entry):  COMMIT
```

This is exactly the gap the review flagged. The fix is a genuine linearization point, not just "read inside a transaction."

**TOGGLE/ENTRY SERIALIZATION DESIGN.** `create_pool_entry` acquires the `platform_settings` singleton row with `SELECT ... FOR SHARE` (§5.2, §7) rather than a plain `SELECT`. The admin's toggle write (`UPDATE platform_settings SET paid_pools_enabled = ... WHERE id = true`) does not touch the primary-key column, so Postgres implicitly acquires a `FOR NO KEY UPDATE` row lock for it. Per PostgreSQL's row-locking compatibility rules (stable since 9.3, confirmed unchanged on this project's configured Postgres 17 — `supabase/config.toml: major_version = 17`; see the "Explicit Locking" chapter of the PostgreSQL manual): `FOR SHARE` and `FOR NO KEY UPDATE` **conflict** — a session holding one blocks a session requesting the other, for as long as the holder's transaction remains open — while multiple concurrent `FOR SHARE` holders **do not conflict with each other**. This gives exactly the two required linearizations, and nothing more:

- **Case A — entry wins the race.** The entry transaction's `FOR SHARE` is granted before the admin's `UPDATE` is issued (or before it manages to acquire its lock). The admin's `UPDATE` then **blocks** — it cannot acquire `FOR NO KEY UPDATE` while a `FOR SHARE` holder is still open — until the entry transaction commits or rolls back. The entry proceeds using the value it legitimately read (`enabled = true`), completes, commits, releasing its shared lock; only then does the admin's disable take effect. This is the "entry occurred before the disable" outcome the review specified.
- **Case B — toggle wins the race.** The admin's `UPDATE` acquires its `FOR NO KEY UPDATE` lock first (or has already committed). A subsequent entry transaction's `SELECT ... FOR SHARE` either (i) blocks until the admin's transaction ends, and — this is the specific PostgreSQL row-locking behavior that makes this pattern work — **re-reads the row's latest committed version once unblocked**, rather than using its original MVCC snapshot for that row; or (ii) if the admin already committed before the entry's `SELECT` even runs, simply reads the already-committed `disabled` value directly, no blocking needed. Either way, the entry sees `disabled` and rejects via `paid_pools_disabled` before any mutation. This is the "toggle occurred before the entry" outcome the review specified.

**Concurrency among entries themselves is preserved.** `FOR SHARE` locks held by multiple simultaneous `create_pool_entry` calls (for the same pool or different pools) **do not conflict with one another** — any number of entry transactions can hold the shared lock on `platform_settings` at once. The only thing that ever blocks is the rare admin write against the (momentarily) many concurrent readers, not readers against each other. This satisfies the requirement that entries not be serialized through the singleton row as if it were an exclusive lock.

**LOCK ORDER / DEADLOCK ANALYSIS.** The canonical order, already `create_pool_entry`'s natural order and now a documented invariant (§5.2): **lock the specific `pools` row first (`for update`), then lock `platform_settings` (`for share`)**. A deadlock requires a cycle — transaction A holds lock 1 and waits on lock 2, while transaction B holds lock 2 and waits on lock 1. For a cycle to form here, some transaction would need to acquire `platform_settings` first and *then* attempt to lock a specific `pools` row while another transaction held it. **No such transaction exists in this design**: the only writer of `platform_settings` is the admin toggle action (`setPaidPoolsEnabledAction`-equivalent), and it touches `platform_settings` exclusively — it never subsequently acquires a lock on any `pools` row. Every transaction that touches both resources (`create_pool_entry`, and the optional `FOR SHARE` addition to the publish trigger) acquires them in the same order: `pools` row, then `platform_settings`. Because `platform_settings` is therefore always a *terminal* resource — nothing downstream of acquiring it ever reaches back for a `pools` row — no cycle is structurally possible, not merely unlikely. This holds regardless of how many pools or how many concurrent entries are involved, since each entry's `pools`-row lock is on a distinct row with no relationship to any other entry's `pools`-row lock. **This canonical order must be preserved by any future RPC that touches both tables** — the risk is not in today's code, it's in a future author reversing the order without realizing why it matters (flagged in §16).

**New RPCs must not repeat the §1 incident.** `confirm_pool_grading_only` and `void_pool_no_refund` are new `SECURITY DEFINER` functions touching entries/pools/user_profiles — implementation must include an explicit grant-verification step (query `information_schema.role_routine_grants` or equivalent for these two functions, confirming `anon`/`authenticated` have no `EXECUTE`) as part of the PR, not assumed from the migration's stated intent alone.

---

## 14. STATE MATRIX

**REVISED per locked decision.** Platform capability is now consulted at entry time, not just creation time — the "New Entry" column below reflects `create_pool_entry`'s live re-check on every call, not a value fixed at the pool's publish time. (`✓` allowed / `✗` blocked / `n/a` state doesn't apply)

| Platform state | Pool mode | Lifecycle state | Create/Publish | New Entry | Grading | Settlement |
|---|---|---|---|---|---|---|
| `paid_pools_enabled=true` | PAID | DRAFT | ✓ | n/a | n/a | n/a |
| `paid_pools_enabled=false` | PAID | DRAFT | ✗ (blocked at publish) | n/a | n/a | n/a |
| `paid_pools_enabled=true` | PAID | OPEN | n/a | ✓ | n/a | n/a |
| `paid_pools_enabled=false` | PAID | OPEN | n/a | ✗ (`paid_pools_disabled` — regardless of when the pool opened, regardless of whether it already has entries) | n/a | n/a |
| either | PAID | LOCKED / AWAITING_RESULT | n/a | ✗ (status-driven, not toggle-driven) | ✓ (unaffected by toggle — §8) | n/a |
| either | PAID | READY_FOR_REVIEW | n/a | ✗ | n/a | ✓ (`confirm_pool_settlement`, unaffected by toggle) |
| either | PAID | SETTLED / VOIDED / CANCELLED / SETTLEMENT_REVERSED / REVERSAL_FAILED_MANUAL_REVIEW / MANUAL_REVIEW | n/a | ✗ | n/a | n/a (terminal or admin-attention; refunds/reversals proceed normally when applicable, unaffected by toggle) |
| `free_pools_enabled=true` | FREE | DRAFT | ✓ | n/a | n/a | n/a |
| `free_pools_enabled=false` | FREE | DRAFT | ✗ (blocked at publish) | n/a | n/a | n/a |
| `free_pools_enabled=true` | FREE | OPEN | n/a | ✓ | n/a | n/a |
| `free_pools_enabled=false` | FREE | OPEN | n/a | ✗ (`free_pools_disabled` — regardless of when the pool opened, regardless of whether it already has predictions) | n/a | n/a |
| either | FREE | LOCKED / AWAITING_RESULT | n/a | ✗ | ✓ (unaffected by toggle — §8) | n/a |
| either | FREE | READY_FOR_REVIEW-equivalent | n/a | ✗ | ✓ (`confirm_pool_grading_only`, unaffected by toggle) | n/a (no financial settlement ever) |
| either | FREE | SETTLED / VOIDED / CANCELLED | n/a | ✗ | n/a | n/a |

Both-disabled (`paid_pools_enabled=false, free_pools_enabled=false`): legal at the DB level, blocks all new creation/publish and all new entries of either mode; existing pools of either mode in-flight complete exactly as their individual rows above describe.

**Key invariant, stated plainly**: every "Grading"/"Settlement" cell above is `✓ (unaffected by toggle)` regardless of the platform state column — grading, settlement, refund, and reversal never read `paid_pools_enabled`/`free_pools_enabled`. The toggle is consulted exactly once per entry attempt, inside `create_pool_entry`, and at no other point in a pool's or entry's lifecycle. This corrects the earlier draft, where §5.4's original recommendation (entry unaffected by a later toggle flip) was inconsistent with this section's framing of "New Entry" as fixed at publish time.

**Two additional notes now that §13 specifies the enforcement mechanism precisely**: (1) `paid_pools_enabled=true`/`=false` in the "Platform state" column above should be read as shorthand for "the flag's value at the moment `create_pool_entry`'s `FOR SHARE` read resolves" — not a value fixed at page-load or pool-publish time (§13's serialization design is what makes this precise rather than approximate); (2) a row not shown here — the singleton `platform_settings` row missing entirely — is not a distinct "platform state" but a universal override: every "New Entry" cell in this table becomes `✗ (platform_settings_missing)` regardless of pool mode or lifecycle state, per the fail-closed design in §5.2/§7.

---

## 15. TEST PLAN

Mapped to this repo's actual conventions (`tests/unit/`, `tests/integration/` against real local Supabase via direct RPC calls, `fileParallelism: false`, and the one existing Playwright spec's structure).

**REVISED per this review's corrections** — the global-mode test plan now covers entry-time enforcement, fail-closed behavior, and the toggle/entry linearization explicitly, and the original single "enters → disables → re-enables" test is split in two, since a re-enabled pool cannot be the same pool that was just locked and settled a few lines earlier.

**CORRECTED TEST CASES — Global mode, PAID** (new `tests/integration/platform-mode.test.ts`):

*A. In-flight lifecycle* (a disabled toggle must not disturb a pool already in motion):
- Create and publish a PAID pool while `paid_pools_enabled = true`.
- User A enters successfully.
- Flip `paid_pools_enabled` to `false`.
- User B attempts to enter the same, still-`OPEN` pool → rejected with `paid_pools_disabled`.
- Assert: **no** `entries` row for User B, **no** `wallet_transactions` row for User B, `pool_options.entry_count` unchanged by the rejected attempt.
- Assert: User A's existing entry is completely untouched.
- Advance the pool through lock → grading → settlement normally (toggle remains `false` throughout); assert User A's payout (or refund, if the pool ends up below minimum or voided) computes correctly — proving the toggle being off during a pool's later lifecycle has zero effect on its financial outcome.

*B. Re-enable* (on a **separate** pool — a locked/settled pool cannot receive a new entry regardless of the toggle, so re-enabling against pool A would prove nothing):
- Create and publish a **second, independent** PAID pool while `paid_pools_enabled = true`, then immediately flip `paid_pools_enabled` to `false` before anyone enters it.
- A user's entry attempt is rejected with `paid_pools_disabled`.
- Flip `paid_pools_enabled` back to `true`, with this second pool still `OPEN` and before its `locks_at`.
- The same user's entry now succeeds — assert the resulting `wallet_transactions` debit amount is exactly `pools.entry_fee`, with no special re-activation step required beyond the flag itself being `true` again.

**CORRECTED TEST CASES — Global mode, FREE**: the identical A/B split, using `free_pools_enabled`/`free_pools_disabled` and `confirm_pool_grading_only` in place of `confirm_pool_settlement`:
- *A*: an existing FREE prediction (entered while enabled) continues grading correctly — including `current_streak`/`correct_predictions_count` updates — after `free_pools_enabled` is flipped off, while a second user's new prediction attempt on the same pool is rejected with `free_pools_disabled` during the disabled window.
- *B*: on a separate FREE pool, an entry rejected while disabled succeeds normally once `free_pools_enabled` is flipped back to `true`, while the pool is still `OPEN`.

**FAIL-CLOSED DESIGN — test coverage** (same file):
- `paid_pools_enabled = true` (row present) → entry allowed.
- `paid_pools_enabled = false` (row present) → entry blocked with `paid_pools_disabled`.
- **Singleton row deleted entirely** (test-only: temporarily remove the row in a setup step) → entry blocked with `platform_settings_missing`, for **both** PAID and FREE pools — proves the missing-row path fails closed for both modes, not just one. Restore the row in teardown.
- Defensive-NULL coverage: since `paid_pools_enabled`/`free_pools_enabled` are `not null` at the schema level, a literal `NULL` value cannot be constructed through normal writes — assert this directly (attempt `UPDATE platform_settings SET paid_pools_enabled = null` and confirm Postgres itself rejects it with a `not-null constraint` violation), which is what makes the `IS DISTINCT FROM TRUE` check in `create_pool_entry` a defense-in-depth measure rather than a reachable path today. Do not skip this test on the reasoning that "NULL can't happen" — the assertion is what proves that claim rather than assumes it.
- Same three cases (true/false/missing-row) repeated against the creation/publish-time trigger (`enforce_paid_pool_capability`) directly via a `pools` insert/update, confirming it fails closed identically to the entry-time RPC.

**TOGGLE/ENTRY SERIALIZATION DESIGN — concurrency test** (new, proves the ordering claim in §13 rather than just asserting the end state): using two concurrent database sessions/connections against the real local Supabase instance —
1. Session 1 opens a transaction, executes `create_pool_entry` up through its `SELECT ... FOR SHARE` on `platform_settings`, and **pauses before committing** (achievable via a `pg_sleep()`-based test hook, or by driving the RPC's statements individually rather than as one opaque call, for test purposes only).
2. Session 2 concurrently issues the admin's `UPDATE platform_settings SET paid_pools_enabled = false ...` and attempts to commit.
3. Assert Session 2's `UPDATE` **blocks** (does not commit) until Session 1 finishes.
4. Session 1 completes and commits (using the `enabled = true` value it read).
5. Assert Session 2's `UPDATE` then proceeds and commits.
6. Assert the entry from Session 1 exists and is valid (proves Case A: entry-before-disable ordering).
7. Repeat in the opposite order (Session 2's `UPDATE` commits first, then Session 1 starts) and assert Session 1's entry is rejected with `paid_pools_disabled`, seeing the fresh post-commit value rather than a stale snapshot (proves Case B).

This test is the one piece of concrete proof — not just documentation — that the `FOR SHARE`/`FOR NO KEY UPDATE` conflict actually linearizes the two operations on this project's Postgres 17 instance, rather than relying on the general PostgreSQL manual's description being correctly applied here.

**Race/stale-client** (the confirmed scenario from §13, black-box version — complements the white-box concurrency test above): open a pool, select an option, flip the relevant capability off, then submit — asserting rejection happens **inside the RPC itself**, not only via a pre-flight Server Action check. This test must call `create_pool_entry` directly at least once (bypassing `enterPoolAction`) to prove the enforcement lives in the RPC and isn't reachable-around through a hypothetical alternate caller.

**Decision 3 coverage** (new, `tests/integration/free-entry.test.ts`):
- `create_pool_entry` against a FREE pool with `p_amount = null` succeeds — the canonical path. Asserts the resulting entry has `amount = null` and writes **zero** rows to `wallet_transactions`.
- `create_pool_entry` against a FREE pool with `p_amount = 500` (or any non-null value, including `0`) is rejected with `amount_not_allowed_for_free_pool`, and produces **no** `entries` row — proves rejection, not silent coercion.
- `create_pool_entry` against a PAID pool with `p_amount = null` is rejected with `amount_mismatch` — confirms the previously-implicit SQL `NULL`-comparison gap identified in the revised §7 is actually closed, not just documented.
- Duplicate-entry / idempotency-replay behavior identical to PAID (reuse `unique_active_user_entry_per_pool`).
- Lock enforcement (can't enter a `LOCKED` FREE pool) identical to PAID.
- Notifications generate with FREE-mode copy, no `transaction_id` correlation.

**PAID regression** (no new test files — the existing 708 must pass unmodified): `wallet.test.ts`, `settlement-logic.test.ts`, `settlements.test.ts`, `reversal.test.ts` are the load-bearing gate here. Explicitly add one new assertion to `settlements.test.ts`: settling a PAID pool while `free_pools_enabled` is in either state produces byte-identical `wallet_transactions` rows (proves the global FREE toggle has zero cross-contamination into PAID settlement math), and a new assertion in `wallet.test.ts` or an equivalent file confirming a legitimate PAID entry with a correctly-matching amount still succeeds identically before and after the `amount_mismatch` null-check tightening in §7 (proves that guard-clause change is behavior-preserving for every existing valid request shape).

**Analytics**: for each SQL function touched in §11, a regression test asserting **identical output before/after the filter is added, using only PAID seed data** (no FREE rows present) — the cheapest possible proof the filter change didn't accidentally exclude legitimate PAID rows. Then a second test with a mixed PAID+FREE dataset confirming FREE rows are excluded from `entry_volume`/`pools_entered` but counted in `wins`/`graded_entries`/leaderboard rank.

**Security**: confirm `create_pool_entry`/`confirm_pool_grading_only`/`void_pool_no_refund` have no `EXECUTE` grant to `anon`/`authenticated` — a direct regression test for the §1 incident class, run in CI going forward, not just checked once by hand.

**E2E**: the audit found **zero existing E2E coverage of the paid entry flow** — only `invite-flow.spec.ts` exists today. Recommend this work ship **two** new Playwright specs, not one: `paid-entry-flow.spec.ts` (pick → confirm → entered → graded, establishing a baseline for the flow that actually moves money, which currently has no E2E coverage at all) and `free-entry-flow.spec.ts` (pick → confirm → entered → graded, no wallet involved) plus a `platform-mode-toggle.spec.ts` (switch to FREE_ONLY-equivalent, confirm paid UI/entry blocked in the browser, switch back, confirm paid flow works again). Shipping FREE without ever having E2E-tested PAID would leave the more critical revenue path proportionally less covered than the new feature — worth calling out plainly.

---

## 16. RISKS

1. **`entries.amount`/`pools.entry_fee` becoming nullable touches a column read in many places** (view-model, notices, analytics services) — the TS type change (`number` → `number | null`) will surface every call site that assumed non-null via the compiler, which is good (fail at build time, not runtime), but the list is nontrivial and should be enumerated exhaustively during implementation, not just the handful named in this proposal.
2. **Duplicated streak-update SQL** (§8) between `confirm_pool_settlement` and `confirm_pool_grading_only` — a future change to streak logic risks being applied to only one. Mitigate with a code comment cross-referencing the twin location, and/or revisit extracting a shared helper once both functions have shipped and stabilized (deliberately not now, to keep this rollout's touch to the settlement engine at zero).
3. **RPC grant drift** (§1's precedent) — the two new RPCs are the highest-risk surface for a repeat of that incident, specifically because they're new and therefore have no existing test/monitoring watching their grants. Mitigate per §13's explicit verification step.
4. **`buildNoticeCopy()` is a single shared function** consumed by both settlement and refund notification paths for PAID pools today — adding FREE branches must be strictly additive (new `if` arms), verified by the existing notification-adjacent tests continuing to pass with zero modified PAID assertions.
5. **Admin wizard `step3Valid` branching** — the tier-fee feature (`entryMode: "single"|"tiered"`, an unfortunately-named-the-same-as-the-new-`entry_mode`-concept local variable in `pool-template-builder.tsx`) is an already-shipped, tested feature; the new Paid/Free mode field must be a sibling top-level branch, not nested inside the existing single/tiered logic, and the naming collision (`entryMode` local state vs. new `entry_mode` domain concept) should be resolved with a rename during implementation to avoid confusing the two.
6. **DB trigger scope creep** — the capability-enforcement *creation/publish* trigger (§5.2 item 1) must be scoped precisely to the `DRAFT/absent → OPEN` transition for the relevant mode; an overly broad condition risks blocking unrelated lifecycle writes (settlement, lock, void) to a pool that's already legitimately `OPEN`. Directly tested in §15's "already-open PAID pool keeps working after toggle flip" case. (Note: the *entry-time* gate in `create_pool_entry`, §5.2 item 2, has no equivalent scope-creep risk — it's a plain `if` inside one function, not a trigger that could fire on unrelated writes.)
7. **No existing E2E coverage of the money path at all** — this is a pre-existing gap this proposal inherits, not one it creates, but it means the first real E2E proof of the paid flow's correctness would be happening concurrently with a new feature's rollout rather than as an established baseline. Recommend the PAID E2E spec ship first, independent of FREE-mode work if timeline pressure requires prioritizing.

**New risks introduced by this revision's locked decisions:**

8. **Every entry now does one extra read of `platform_settings`** inside the transaction, on the hot path (§5.2 item 2), now specifically a `SELECT ... FOR SHARE` rather than a plain read. This is a single-row, primary-key-indexed lookup — negligible cost in isolation, and concurrent entries never block each other on it (§13) — but worth noting explicitly since it's now evaluated, and lock-acquired, on *every entry attempt* rather than only at the relatively rare pool-creation moment. If `platform_settings` read latency or locking ever becomes a concern, `create_pool_entry` is now a direct stakeholder in that table's performance, not just the admin settings page.
9. **UX cliff at confirmation time** — a player can fill out an entire entry flow and have it rejected at the very last step, with no advance warning, if an admin flips the toggle mid-session. This is the intended, locked behavior (Decision 1), but it makes the error-copy work in §10 non-optional: a generic "something went wrong" message would read as a bug to a player who did nothing wrong. The confirmation sheet must surface the specific `paid_pools_disabled`/`free_pools_disabled` message.
10. **Client contract precision for Decision 3 becomes load-bearing, not cosmetic.** A client bug that sends `amountCents: 0` instead of omitting the field for a FREE pool now *hard-fails every free entry attempt* — previously (under the original silent-coercion design) such a bug would have been silently forgiven. This tightening is intentional, but it means the FREE entry form's request-building code needs explicit test coverage proving it never includes a numeric `amountCents` field, since a regression here would present as "free entry is completely broken," not a subtle edge case.
11. **`create_pool_entry`'s PAID `amount_mismatch` branch changes shape** (explicit `p_amount is null` check added, §7) even though its observable behavior for every existing legitimate PAID request is unchanged. The SQL diff is easy to eyeball as safe, but "easy to eyeball" is not the same as proven — §15 adds an explicit regression test for this specific guard rather than relying on the existing suite to happen to cover it (the existing suite has never had a reason to send a null amount against a PAID pool, since the client has never done that).
12. **`platform_settings` becomes a dependency of the single highest-frequency financial RPC in the system**, not just of admin-facing/creation-time code. Any future change to that table's shape, RLS, or read path now needs to be evaluated against entry-path correctness and latency, not only settings-page correctness — worth a one-line comment in the implementing migration flagging this new coupling for whoever touches `platform_settings` next.

**New risks introduced by this revision's fail-closed and serialization corrections:**

13. **A missing `platform_settings` row is now a hard outage for all new entries of both modes**, by design (fail-closed, Decision-review requirement). This is the correct tradeoff — silently treating missing config as "enabled" would be far worse — but it means the singleton row's existence becomes an operational invariant worth its own monitoring (e.g., an alert if `platform_settings_missing` ever appears in logs at all, since it should never legitimately occur once the seed migration has run). Distinguishing this from an intentional admin disable (§10's `platform_settings_missing` error branch) is what makes that monitoring possible.
14. **`FOR SHARE` introduces a genuine, if very short, wait window.** An entry transaction can now briefly block on the admin's `UPDATE` (Case B in §13) for as long as that `UPDATE`'s own transaction takes to commit — normally sub-millisecond for a single-row update, but worth stating explicitly: this is a real (bounded) lock wait on the entry path that did not exist before this revision, not merely a read. If the admin action's transaction were ever wrapped in something slower (e.g., accidentally batched with an unrelated slow query), every concurrent entry attempt would feel that delay. Recommend the admin toggle action's transaction remain exactly what it is today — a single-row `UPDATE` plus an `audit_logs` insert, nothing slower — and flag this constraint in the implementing code so it isn't casually violated later.
15. **The canonical lock order (`pools` row, then `platform_settings`) is an invariant enforced by convention, not by the database.** Nothing stops a future RPC from acquiring `platform_settings` first and a `pools` row second, which — per §13's deadlock analysis — would still not deadlock *today* (since the only `platform_settings` writer never touches `pools`), but would silently invalidate the reasoning that makes that guarantee hold. This should be called out in a code comment on both `create_pool_entry` and the admin toggle action, not left as only a fact documented in this proposal.
16. **The concurrency test in §15 requires driving `create_pool_entry`'s internal statements individually** (to pause mid-transaction between the `FOR SHARE` read and commit) rather than treating the RPC as an opaque black box, which is a heavier test to write and maintain than this codebase's existing integration tests typically are. This is a one-time cost to prove the linearization claim rigorously rather than by inspection alone — worth the investment given this is the one guarantee the entire fail-closed design rests on, but it should be written once, carefully, and treated as a high-value regression test rather than a template to be casually copied for unrelated concurrency questions.

---

## 17. IMPLEMENTATION PHASES

Smallest safe stages, each independently shippable and independently revertible:

- **Phase 0 — Schema only.** `entry_mode` enum/column (default `PAID`, backfilled by construction), nullable `entries.amount`/`pools.entry_fee` with the strengthened cross-column CHECK (§12, Decision 4), `platform_settings` booleans (both default `true`). Zero behavior change — nothing new is reachable since every existing/new pool still defaults to PAID everywhere. All 708 existing tests pass unmodified. This phase alone is safe to ship and sit on indefinitely.
- **Phase 1 — Backend FREE path + entry-time capability enforcement, no UI.** `create_pool_entry`'s FREE branch *and* its capability gate (§5.2 item 2, §7) ship together in this phase, not separately — they're both guard clauses added to the same function in the same migration wave, and testing one without the other would leave the RPC in an inconsistent, partially-reviewed state. Also: `confirm_pool_grading_only`, `void_pool_no_refund`, dispatch wiring in `gradeTemplatePool`/`lock.ts`/`settle.ts`. Exercised only via direct RPC calls (extend `scripts/seed.ts` with a FREE demo-pool scenario) and the new integration tests from §15, including the entry-time toggle-enforcement tests — these do not depend on any UI and should be proven at this phase, not deferred to Phase 3. No admin UI exposes FREE creation yet — nothing changes for real users.
- **Phase 2 — Admin surface.** Creation wizard mode field, capability DB triggers, Super Admin global-toggle UI + audit log. FREE pools become creatable end-to-end, but still admin-only surface (no player-facing changes needed yet since `SocialPoolCard` hasn't changed — a FREE pool would render oddly with the old card, so this phase should stay internal/unreleased until Phase 3 lands).
- **Phase 3 — Player UI.** `FreeEntryConfirmationSheet`, `PoolSummary` conditional pot line, `view-model.ts` nullable financial fields, `buildNoticeCopy()` FREE branches. Full player experience for a FREE pool.
- **Phase 4 — Analytics + E2E.** The explicit count-based filters in §11, before/after regression tests for each, the three new Playwright specs from §15.
- **Phase 5 — Controlled rollout.** Flip `free_pools_enabled` on for real; monitor via the same `background_jobs`/audit-log surfaces already in place. A simple on/off flip is sufficient per your stated preference for a simple Super Admin control — no percentage-rollout mechanism is being proposed, though the two-boolean design doesn't preclude adding one later without another architecture change.

---

## 18. RECOMMENDATION

**Yes — this can be added safely, without touching the existing money engine, using the design above.** This section is revised to reflect the four locked amendments from the architecture review; the core conclusion is unchanged, but the enforcement model is meaningfully stronger than the original draft.

- `pools.entry_mode` (`PAID`/`FREE`), a snapshotted, immutable-after-first-entry enum column — **not** derived from `entry_fee = 0`, which §3 shows is actively unsafe under the current wallet-engine invariants.
- Two independent `platform_settings` booleans (`paid_pools_enabled`, `free_pools_enabled`) rather than a two-state enum, extending the exact singleton-row + service-role-write + audit-log pattern already proven by `registration_enabled`.
- **The global toggle is now an entry-time kill switch, re-checked inside `create_pool_entry` on every single call — not merely a creation/publish-time gate.** This was the first review's central amendment: disabling `paid_pools_enabled` blocks new PAID entries immediately, even into a pool that was already `OPEN`, while leaving every already-existing entry's lock/grade/settle/refund/reversal lifecycle completely untouched.
- **That check is now provably fail-closed and genuinely serialized against the admin's toggle write**, correcting two gaps this second review round identified: a bare `not (select ...)` boolean read would have failed *open* if the `platform_settings` singleton row were ever missing (fixed via explicit `not found` handling plus `IS DISTINCT FROM TRUE`, which treats anything other than a literal `true` — false, null, or absent — as blocked); and a lock-free read inside the entry's own transaction created no actual ordering guarantee against a concurrent admin `UPDATE` (fixed via `SELECT ... FOR SHARE`, which — because it conflicts with the `FOR NO KEY UPDATE` lock an `UPDATE` implicitly takes, while never conflicting with other concurrent `FOR SHARE` readers — produces a real linearization point without serializing entries against each other; see §13's Case A/Case B analysis, verified deadlock-free via a documented canonical lock order, and proven by a dedicated two-session concurrency test in §15 rather than asserted by documentation alone). The race scenario confirmed in the first review round — an admin flipping the toggle between page-load and confirm-press — now resolves to a clean, atomic rejection with zero side effects, and this round closes the gap between that claim and what the original transaction-scoping argument actually guaranteed.
- **FREE entries reject a client-supplied amount outright rather than silently coercing it to `null`** (Decision 3) — `amount_not_allowed_for_free_pool` makes invalid client behavior visible instead of quietly forgiven, keeping the domain contract precise: a canonical FREE request supplies `amount = null` itself.
- **The database now makes a `FREE` pool with financial configuration unrepresentable**, not just unlikely (Decision 4) — a single combined CHECK constraint requires `entry_fee is null and house_fee_bps = 0 and tier_group_id is null` whenever `entry_mode = 'FREE'`, and the inverse for `PAID`. `FREE + $10 entry fee`, `FREE + non-zero house fee`, and `FREE + paid fee tier` are all now impossible to insert, independent of what the admin UI does or fails to do.
- Capability predicates (`requiresPayment`, `hasPrizePool`, etc.) as the single place money-vs-free branching is decided, named apart from each other specifically so a future sponsored-prize FREE pool doesn't require renaming anything.
- Nullable `entries.amount`/`pools.entry_fee` (never a `$0` sentinel) as the financial-vs-not discriminator at the row level, which gets most of analytics-exclusion "for free" via SQL `NULL` semantics.
- **Zero modifications** to `apply_wallet_transaction`, `confirm_pool_settlement`, `confirm_pool_refund`, or `reverse_pool_settlement` — new sibling RPCs (`confirm_pool_grading_only`, `void_pool_no_refund`) and new guard-clause logic inside `create_pool_entry` (capability check + mode dispatch, both evaluated before any mutation, with the existing PAID money-moving code preserved verbatim past them) are the entire footprint on the money engine. This guarantee survives the review's amendments intact — the entry-time capability check is new *logic*, but it is a guard clause ahead of the existing code, not a change to it.
- DB-level trigger enforcement for pool-mode immutability and the creation/publish-time capability courtesy check, directly informed by this codebase's own documented history of an RPC-grant drift incident — application-layer checks alone are not treated as sufficient here, on purpose. The entry-time check (now the primary boundary) goes further: it lives inside the same `SECURITY DEFINER`, `service_role`-only RPC that already moves money, re-read fresh on every call, closing the exact gap a trigger-only or Server-Action-only design would have left open.
- A staged rollout (§17) where the riskiest-looking phase (schema) is actually the lowest-risk one (fully additive, zero reachable behavior change), the entry-time capability check ships in the same phase as the FREE entry branch rather than being deferred, and the highest-risk phase (new settlement-adjacent RPCs) gets an explicit, repeatable grant-verification step rather than a one-time assumption.

The leaderboard and streak systems need **no changes at all** to support combined PAID+FREE accuracy — that's already how they're built. The parts of the system that genuinely need new code are narrow and enumerable: one RPC's guard-clause logic (capability + amount contract), two new sibling RPCs, one new UI sheet component, a handful of nullable view-model fields, ~14 notification-copy branches, four new player-facing error strings, and a handful of `COUNT(*)`-shaped analytics filters. Nothing here requires forking the domain model, and nothing here requires touching a single line of the code that currently moves real money.

### Implementation acceptance criteria — fail-closed and concurrency guarantees

These are non-negotiable checks, not suggestions, before Phase 1 (§17) is considered complete:

1. `create_pool_entry` and the creation/publish trigger(s) read `platform_settings` via `SELECT ... FOR SHARE`, never a plain `SELECT`, and never via `NOT (...)` — always `IS DISTINCT FROM TRUE` against an explicitly-fetched value.
2. A missing `platform_settings` row is verified (by test, not inspection) to reject with `platform_settings_missing` for both PAID and FREE, at both the entry-time RPC and the creation/publish trigger.
3. The two-session concurrency test from §15 passes, demonstrating both Case A (entry-before-disable) and Case B (disable-before-entry) resolve correctly on the project's actual Postgres 17 instance — not merely asserted from the PostgreSQL manual.
4. The canonical lock order (`pools` row, then `platform_settings`) is documented in a code comment on `create_pool_entry`, the publish trigger(s), and the admin toggle Server Action, so a future change doesn't invert it unknowingly.
5. The admin toggle Server Action's transaction is confirmed to contain only the `platform_settings` `UPDATE` and the `audit_logs` insert — nothing slower — since every concurrent entry's `FOR SHARE` wait is bounded by this transaction's own duration (§16, risk 14).
6. The A/B split re-enable test (§15) passes using two distinct pools, not one pool reused across a lock/settle boundary.
7. All four new error strings (`paid_pools_disabled`, `free_pools_disabled`, `platform_settings_missing`, `amount_not_allowed_for_free_pool`) are mapped to player-facing copy in `enterPoolAction`, with `platform_settings_missing` also wired to on-call alerting (§16, risk 13) separately from ordinary application logs.

---

## FINAL ARCHITECTURE STATUS

**ARCHITECTURE READY FOR IMPLEMENTATION**, contingent on the acceptance criteria above being satisfied during Phase 1 before any later phase builds on top of them. All three corrections from this review round — fail-closed capability checks, a proven `FOR SHARE`-based linearization mechanism with a documented deadlock-free lock order, and a corrected two-part re-enable test — are now reflected throughout §5, §7, §13, §14, §15, §16, and §18. No migration, application code, or commit has been made.

---

*This document is a proposal only. Await final review confirmation before any migration or code change is made.*
