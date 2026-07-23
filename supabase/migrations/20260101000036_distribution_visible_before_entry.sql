-- Product decision reversal: per-option percentage/estimated-payout and the
-- distribution bar should drive engagement (Polymarket/Kalshi convention),
-- so the new default is to show them before entry rather than gating them
-- behind an entry. participation_visibility itself is untouched as a
-- mechanism — an admin can still dial a specific pool back to
-- SHOW_AFTER_ENTRY/SHOW_AFTER_LOCK/NEVER_SHOW via the admin pool
-- create/edit forms — this just flips what "not explicitly chosen" means,
-- for both new pools and every pool already sitting on the old default.
alter table public.pools
  alter column participation_visibility set default 'SHOW_BEFORE_ENTRY';

update public.pools
set participation_visibility = 'SHOW_BEFORE_ENTRY'
where participation_visibility = 'SHOW_AFTER_ENTRY';
