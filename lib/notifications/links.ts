import "server-only";
import type { NotificationRow } from "./fetch";

export type NotificationWithHref = NotificationRow & { href: string | null };

// Call BS exclusivity addendum (§15 of the activation report): these four
// types prefer the canonical Post over the Market — the social
// disagreement itself lives on the Post, unlike prediction_graded's own
// market-first reasoning below (disambiguating between several concurrent
// Markets on one Post, which a Challenge doesn't need since it's not
// about "which Market," just "where's the conversation"). Both post_id and
// market_id are stamped directly onto the notification at creation time
// (lib/notifications/challenges.ts) — no per-row lookup needed here.
const CALL_BS_NOTIFICATION_TYPES = new Set(["CALL_BS_RECEIVED", "CALL_BS_ACCEPTED", "CALL_BS_DECLINED", "CALL_BS_RESOLVED"]);

export function resolveNotificationHref(n: NotificationRow): string | null {
  // Not about the recipient's own money — always the admin wallet-requests
  // queue, regardless of transaction_id (null for this type).
  if (n.type === "WALLET_REQUEST_SUBMITTED") return "/admin/wallet-requests";

  if (CALL_BS_NOTIFICATION_TYPES.has(n.type)) {
    if (n.post_id) return `/post/${n.post_id}`;
    if (n.market_id) return `/markets/${n.market_id}`;
    return null;
  }

  // Stage 4C remediation — a Post can have more than one concurrently
  // ACTIVE Market (e.g. MONEYLINE + TOTAL for the same NFL Game), so two
  // different prediction_graded notifications about the SAME Post can be
  // about two DIFFERENT Markets. market_id (populated only for
  // prediction_graded, lib/predictions/grading.ts) is checked first so
  // each notification lands on the exact Market it's about — /markets/{id},
  // the market-specific canonical page that already backs "More markets
  // for this game" on the Post detail page — rather than collapsing to
  // the Post's primary Market. Falls through to post_id for any other
  // market_id-less row (see below).
  if (n.market_id) return `/markets/${n.market_id}`;

  // Stage 4A remediation (Stage 4 audit §14 — "prediction_graded
  // notifications currently resolve to no destination"). Generic, not a
  // per-type branch: `post_id` is populated only for POST_COMMENT_REPLY
  // (lib/notifications/post-comments.ts, pre-existing) and, as of Stage 4A,
  // prediction_graded (lib/predictions/grading.ts, resolved once at
  // creation time — the grading job already has the Market's fixture_id in
  // scope, one extra getPostByFixtureId lookup) — both resolve identically,
  // so one shared branch fixes both gaps rather than duplicating the same
  // one-liner per type. Still the fallback for a prediction_graded row with
  // no market_id (a pre-Stage-4C row, or the rare case where the Post was
  // somehow unresolvable at notification time) and the only branch for
  // POST_COMMENT_REPLY, which has no Market at all.
  if (n.post_id) return `/post/${n.post_id}`;

  // Phase G — /activity no longer renders the ledger (it redirects to the
  // new /notifications center); /wallet already showed the complete
  // ledger independently before this phase and still does, via the same
  // TransactionList component (and its own identical hash-anchor
  // auto-open behavior), so this repoints there rather than at a page
  // that no longer has anything for the anchor to scroll to.
  if (n.transaction_id) return `/wallet#tx-${n.transaction_id}`;

  return null;
}

/** Annotates each notification with where clicking it should navigate. */
export function attachNotificationHrefs(notifications: NotificationRow[]): NotificationWithHref[] {
  return notifications.map((n) => ({ ...n, href: resolveNotificationHref(n) }));
}
