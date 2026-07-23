-- Did Not Play (DNP): a per-leg flag independent of is_met — a leg's named
-- athlete can fail to appear in the match at all, which invalidates the
-- combo's entire premise rather than just resolving one condition against
-- them (a scratched/injured player isn't the same as "played and missed").
-- Nullable is_met is untouched; did_not_play is a separate boolean any leg
-- can carry, checked by the app layer (gradeComboLegsAction) before it ever
-- computes an all-legs-met winner — if any leg is DNP, the whole pool voids
-- via confirm_pool_refund(void_reason = 'COMBO_PLAYER_DID_NOT_PLAY'), which
-- already refunds every active entry regardless of which option they
-- picked, so no new SQL function is needed for the refund mechanics
-- themselves.
alter table public.pool_combo_legs
  add column did_not_play boolean not null default false;
