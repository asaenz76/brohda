// Phase G (Brohda 2.0 redesign, spec §21/§28) — the explicit allowlist of
// notification `type` values the redesigned /notifications center (and
// its unread-count badge, and its toast) shows. `notifications.type` is a
// plain `text not null` column with no DB-level enum or CHECK constraint
// (confirmed against every migration touching the table) — new, legacy,
// and currently-disabled-feature types all live in the same table with
// nothing stopping a future insert from using any string. Safety here is
// therefore an explicit ALLOWLIST, never a denylist of "known bad" types
// — matching this phase's own "do not expose obsolete Pool notification
// concepts" instruction precisely: an unrecognized type is hidden by
// default, not shown by default.
//
// Full classification, from an exhaustive audit of every `type` literal
// across lib/notifications/*.ts (A = Brohda 2.0 active and social,
// B = legacy Pool/test, C = admin/internal, D = disabled-feature):
//
//   POST_COMMENT_REPLY                                    A — shown
//   prediction_graded                                     A — shown
//
//   COMMENT_REPLY, COMMENT_MENTION,
//   FOLLOWED_USER_ENTERED_POOL, POOL_PUBLISHED_FOLLOWED,
//   QUICK_TOPUP_ENTERED, QUICK_TOPUP_FUNDS_AVAILABLE,
//   SETTLED_WON, SETTLED_LOST,
//   every pool void/cancel-reason string (buildNoticeCopy)      B — hidden.
//     All V1 Pool activity was test data (spec §28) — Pool backend/jobs
//     untouched, no consumer archive built for these.
//
//   WALLET_REQUEST_SUBMITTED                               C — hidden.
//     Staff-only recipients; never appears in a player's own notification
//     list in the first place.
//
//   DEPOSIT_APPROVED, WITHDRAWAL_APPROVED,
//   DEPOSIT_REJECTED, WITHDRAWAL_REJECTED                  — hidden from
//     this social center on purpose: these are account/financial
//     infrastructure events, not social activity (spec's own
//     notifications-vs-wallet split, §16-20) — and each wallet request's
//     own status badge on /wallet already communicates exactly this, so
//     hiding the notification row duplicates nothing a user can't already
//     see there.
//
//   MONETARY_PROPOSAL_RECEIVED, _ACCEPTED, _DECLINED, _WITHDRAWN,
//   MONETARY_POSITION_SETTLED_WIN, _SETTLED_LOSS, _VOIDED  A — shown.
//     These were hidden while monetary_p2p_enabled was false (spec §41).
//     P2P is now switched on, and these are the only way a person learns
//     someone put money on their pick, that it was accepted, or how it
//     settled. They are social activity between two users on a shared
//     disagreement, so they belong here rather than only on /wallet. Each
//     row carries post_id/market_id, so lib/notifications/links.ts lands on
//     the Post (falling back to the Market). Rows can only exist once the
//     flag has been on: propose_money() refuses while it's off.
//
//   CALL_BS_RECEIVED, CALL_BS_ACCEPTED,
//   CALL_BS_DECLINED, CALL_BS_RESOLVED                     A — shown.
//     Free Call BS is activated (the exclusive 1v1 pairing rule is
//     enforced in accept_call_bs()). These are social activity between
//     two users on a shared disagreement, with no money involved. Each
//     row carries post_id/market_id, so lib/notifications/links.ts lands
//     on the Post (falling back to the Market). Rows can only exist once
//     call_bs_enabled has been turned on — call_bs() refuses to create a
//     Challenge while it's off — so listing the types here early exposes
//     nothing.
//
// Hiding a type here never deletes it, never touches the row, and never
// touches the code path that creates it — every notification-creating
// function in lib/notifications/*.ts, lib/predictions/*.ts, and
// lib/challenges/*.ts is completely untouched by this phase.
export const NOTIFICATION_CENTER_TYPES = [
  "POST_COMMENT_REPLY",
  "prediction_graded",
  "CALL_BS_RECEIVED",
  "CALL_BS_ACCEPTED",
  "CALL_BS_DECLINED",
  "CALL_BS_RESOLVED",
  "MONETARY_PROPOSAL_RECEIVED",
  "MONETARY_PROPOSAL_ACCEPTED",
  "MONETARY_PROPOSAL_DECLINED",
  "MONETARY_PROPOSAL_WITHDRAWN",
  "MONETARY_POSITION_SETTLED_WIN",
  "MONETARY_POSITION_SETTLED_LOSS",
  "MONETARY_POSITION_VOIDED",
] as const;

export type NotificationCenterType = (typeof NOTIFICATION_CENTER_TYPES)[number];
