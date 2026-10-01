-- Phase I (V1 backend + test-data decommission), step 2 of 3 — purge
-- Pool-only notification rows.
--
-- The consumer notification center has hidden every one of these types
-- since Phase G's allowlist (lib/notifications/center.ts); their
-- generation code paths are removed in step 3 of this phase. This purges
-- the now-permanently-unreachable historical rows rather than leaving test
-- noise behind indefinitely (§5/§6 of this phase's own spec).
--
-- Written as an explicit KEEP-list (delete everything NOT in it), not a
-- Pool-type delete-list — a keep-list can't silently miss a Pool-era type
-- variant that existed but wasn't enumerated; it can only ever be too
-- conservative, never accidentally destructive to a current/shared type.
-- Every type below was confirmed by grepping every `type: "..."` literal
-- actually written anywhere in the current codebase (lib/notifications/*,
-- lib/monetary/*) — this is exhaustive, not a sample.
delete from public.notifications
where type not in (
  -- Brohda 2.0 / shared — never touch these
  'prediction_graded',
  'POST_COMMENT_REPLY',
  'WALLET_REQUEST_SUBMITTED',
  'DEPOSIT_APPROVED',
  'WITHDRAWAL_APPROVED',
  'DEPOSIT_REJECTED',
  'WITHDRAWAL_REJECTED',
  -- Call BS (disabled, but future Brohda 2.0 architecture — §32)
  'CALL_BS_RECEIVED',
  'CALL_BS_ACCEPTED',
  'CALL_BS_DECLINED',
  'CALL_BS_RESOLVED',
  -- Monetary P2P (disabled, but future Brohda 2.0 architecture — §32)
  'MONETARY_PROPOSAL_RECEIVED',
  'MONETARY_PROPOSAL_ACCEPTED',
  'MONETARY_PROPOSAL_DECLINED',
  'MONETARY_PROPOSAL_WITHDRAWN',
  'MONETARY_POSITION_SETTLED_WIN',
  'MONETARY_POSITION_SETTLED_LOSS',
  'MONETARY_POSITION_VOIDED'
);

-- notifications.pool_id has no Brohda 2.0 role once the Pool-only
-- generation paths (step 3) and the rows above are gone — no remaining
-- type ever populates it (prediction_graded/POST_COMMENT_REPLY resolve via
-- post_id/market_id; every wallet/Call BS/monetary type uses its own
-- dedicated column). Dropping it also removes notifications_pool_id_fkey,
-- the other hard FK into pools the pre-destructive audit flagged.
alter table public.notifications drop column if exists pool_id;
