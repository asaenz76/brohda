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
//   MONETARY_POSITION_SETTLED_*, MONETARY_PROPOSAL_*       D — hidden.
//     monetary_p2p_enabled is false; spec §41 explicitly forbids exposing
//     stake/payout/monetary-position activity in the redesigned center.
//
//   CALL_BS_*                                              D — hidden.
//     call_bs_enabled is false; spec §40 explicitly forbids exposing
//     Call BS/challenge activity in the redesigned center.
//
// Hiding a type here never deletes it, never touches the row, and never
// touches the code path that creates it — every notification-creating
// function in lib/notifications/*.ts, lib/predictions/*.ts, and
// lib/challenges/*.ts is completely untouched by this phase.
export const NOTIFICATION_CENTER_TYPES = ["POST_COMMENT_REPLY", "prediction_graded"] as const;

export type NotificationCenterType = (typeof NOTIFICATION_CENTER_TYPES)[number];
