// Why a Call BS ended without being answered — the canonical reasons stored in challenges.expiry_reason (migration 199), and THE policy for which of them can ever count against a Member.
// Pure and client-safe. The database has the same policy as challenge_expiry_counts_as_ignored(); a parity test keeps the two identical.

export const CHALLENGE_EXPIRY_REASONS = [
  /** Nobody answered before the cutoff. The only reason that is a Member's own silence. */
  "NO_RESPONSE",
  /** The Game was cancelled / postponed / suspended / abandoned, or the Market was deactivated. */
  "GAME_OR_MARKET_CANCELLED",
  /** A Pick changed or was graded, the Market vanished, or the provider status was unknown. */
  "SYSTEM_INVALIDATED",
  /** Another Call BS involving one of the two Members was accepted first. */
  "COMPETING_CHALLENGE_RESOLVED",
  /** One of the two accounts stopped being eligible (deactivated or closed). */
  "ACCOUNT_STATE_CHANGE",
  /** One of the two Members blocked the other. */
  "RELATIONSHIP_BLOCKED",
  /** Any other system cause, and every Call BS that expired before reasons were recorded (never counted as ignored). */
  "OTHER_SYSTEM_REASON",
  /** One of the two Members changed their (editable) Pick, so the pair no longer disagrees — shown as "Challenge cancelled because the Pick changed". Never counted as ignored. */
  "PICK_CHANGED",
] as const;

export type ChallengeExpiryReason = (typeof CHALLENGE_EXPIRY_REASONS)[number];

/** The ONLY expiry reasons that count as "ignored" — for "Challenges ignored" and for the Challenge response rate. System-driven and relationship-driven expirations never punish a Member. */
export const IGNORED_EXPIRY_REASONS: readonly ChallengeExpiryReason[] = ["NO_RESPONSE"];

export function expiryCountsAsIgnored(reason: string | null | undefined): boolean {
  return IGNORED_EXPIRY_REASONS.includes(reason as ChallengeExpiryReason);
}

export interface ResponseRecord {
  accepted: number;
  declined: number;
  ignored: number;
}

/** Challenge response rate = answered / (answered + genuinely ignored), or null when there is nothing to measure. Pending and system-expired Call BS are in neither number. */
export function challengeResponseRate(record: ResponseRecord): number | null {
  const answerable = record.accepted + record.declined + record.ignored;
  return answerable === 0 ? null : (record.accepted + record.declined) / answerable;
}
