import { describe, expect, it } from "vitest";
import { resolveNotificationHref } from "@/lib/notifications/links";
import type { NotificationRow } from "@/lib/notifications/fetch";

function makeNotification(overrides: Partial<NotificationRow>): NotificationRow {
  return {
    id: "notif-1",
    type: "SETTLED_WON",
    title: "You won!",
    body: "You won this pool.",
    pool_id: "pool-1",
    transaction_id: null,
    read_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("resolveNotificationHref", () => {
  it("always points a reply at its pool, ignoring any ledger match", () => {
    const n = makeNotification({ type: "COMMENT_REPLY", pool_id: "pool-1" });
    const transactionIdByPoolId = new Map([["pool-1", "tx-1"]]);
    expect(resolveNotificationHref(n, transactionIdByPoolId)).toBe("/pool/pool-1");
  });

  it("returns null for a reply with no pool_id", () => {
    const n = makeNotification({ type: "COMMENT_REPLY", pool_id: null });
    expect(resolveNotificationHref(n, new Map())).toBeNull();
  });

  it("points a payout notification at its ledger row when one is found", () => {
    const n = makeNotification({ type: "SETTLED_WON", pool_id: "pool-1" });
    const transactionIdByPoolId = new Map([["pool-1", "tx-42"]]);
    expect(resolveNotificationHref(n, transactionIdByPoolId)).toBe("/activity#tx-tx-42");
  });

  it("points a void/refund notification at its ledger row when one is found", () => {
    const n = makeNotification({ type: "MATCH_POSTPONED_NOT_COMPLETED_SAME_DAY", pool_id: "pool-1" });
    const transactionIdByPoolId = new Map([["pool-1", "tx-99"]]);
    expect(resolveNotificationHref(n, transactionIdByPoolId)).toBe("/activity#tx-tx-99");
  });

  it("falls back to the pool page when no ledger row exists (e.g. SETTLED_LOST)", () => {
    const n = makeNotification({ type: "SETTLED_LOST", pool_id: "pool-1" });
    expect(resolveNotificationHref(n, new Map())).toBe("/pool/pool-1");
  });

  it("returns null when there's no pool_id and no ledger match", () => {
    const n = makeNotification({ type: "SETTLED_LOST", pool_id: null });
    expect(resolveNotificationHref(n, new Map())).toBeNull();
  });

  it("points a followed-user-entered notification at its pool, ignoring a coincidental ledger match", () => {
    // The recipient could independently have their own payout/refund on
    // this same pool_id — that transaction has nothing to do with someone
    // else's entry, so it must never be picked up here.
    const n = makeNotification({ type: "FOLLOWED_USER_ENTERED_POOL", pool_id: "pool-1" });
    const transactionIdByPoolId = new Map([["pool-1", "tx-1"]]);
    expect(resolveNotificationHref(n, transactionIdByPoolId)).toBe("/pool/pool-1");
  });

  it("always points a mention at its pool, ignoring any ledger match", () => {
    const n = makeNotification({ type: "COMMENT_MENTION", pool_id: "pool-1" });
    const transactionIdByPoolId = new Map([["pool-1", "tx-1"]]);
    expect(resolveNotificationHref(n, transactionIdByPoolId)).toBe("/pool/pool-1");
  });

  it("prefers a stamped transaction_id over the pool_id-keyed lookup", () => {
    const n = makeNotification({ type: "SETTLED_WON", pool_id: "pool-1", transaction_id: "tx-direct" });
    const transactionIdByPoolId = new Map([["pool-1", "tx-from-lookup"]]);
    expect(resolveNotificationHref(n, transactionIdByPoolId)).toBe("/activity#tx-tx-direct");
  });

  it("uses the stamped transaction_id even once its pool has been detached (pool_id null)", () => {
    // Mirrors delete_terminal_pool nulling notifications.pool_id when a
    // SETTLED pool is hard-deleted — the notification must stay clickable
    // via the ledger row it was stamped with, not fall back to /pool/null.
    const n = makeNotification({ type: "SETTLED_WON", pool_id: null, transaction_id: "tx-direct" });
    expect(resolveNotificationHref(n, new Map())).toBe("/activity#tx-tx-direct");
  });
});
