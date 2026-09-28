-- Real-production gap found during Stage 4C (Buccaneers @ Vikings, Post
-- 6ad61709-...): a Post can have more than one concurrently ACTIVE Market
-- (MONEYLINE + TOTAL for the same NFL Game is the common case). Both
-- Markets' prediction_graded notifications previously resolved through
-- notifications.post_id alone, to the identical generic /post/{id} href —
-- clicking either notification landed on the Post's *primary* Market
-- (lib/posts/primary-market.ts), not necessarily the one the notification
-- was actually about. Mirrors notifications.pool_id/post_id/challenge_id's
-- own real, non-cascading, nullable-FK convention exactly — markets are
-- never hard-deleted in production (only upserted/deactivated via status;
-- confirmed only test cleanup ever deletes a markets row).
alter table public.notifications add column market_id uuid references public.markets (id);

comment on column public.notifications.market_id is
  'The specific Market this notification is about, for click-through (lib/notifications/links.ts''s resolveNotificationHref prefers this over post_id when present, linking to /markets/{id} — the market-specific canonical destination that already exists). Populated only for type=prediction_graded (lib/predictions/grading.ts, the Market is already in scope at grading time). Null for every other notification type, and for any prediction_graded row created before this column existed.';
