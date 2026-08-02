import type { FixtureInternalStatus } from "@/lib/sports-data/types";
import { formatCents } from "@/lib/utils/money";
import type { PoolVoidReason } from "./anomaly";
import { isAnomalyStatus } from "./anomaly";
import type { EntryStatusForCard, PoolStatus } from "./card-state";
import type { PoolType } from "./templates";
import { computeFeeRetainedRefund } from "./settlement-logic";

export interface Notice {
  type: string;
  message: string;
}

export interface NoticeInput {
  poolStatus: PoolStatus;
  fixtureInternalStatus: FixtureInternalStatus;
  voidReason: PoolVoidReason | null;
  entryStatus: EntryStatusForCard;
  /** The entry's original amount in cents (0 if the user never entered). */
  entryAmount: number;
  /** From settlement_payouts, only present once WON. */
  finalPayout: number | null;
  /** Label of the settled winning option, for the SETTLED_LOST copy. */
  winningOptionLabel?: string | null;
  /** Label of the user's own choice, for the SETTLED_LOST copy. */
  selectedOptionLabel?: string | null;
  /** "Match"/"kickoff" framing doesn't fit a CUSTOM poll's LOCKED/
   * READY_FOR_REVIEW copy — optional so existing non-CUSTOM callers (and
   * tests) don't need updating. */
  poolType?: PoolType;
  /** Only needed for NO_WINNING_ENTRIES_FEE_RETAINED — every other void
   * reason refunds entryAmount in full, so this is otherwise unused. */
  houseFeeBasisPoints?: number;
  /** Only present when poolStatus is MANUAL_REVIEW. */
  reviewReason?: string | null;
}

const REVIEW_REASON_LABELS: Record<string, string> = {
  BINARY_OPTIONS_UNRESOLVABLE: "its Yes/No options couldn't be verified",
  TEMPLATE_VERSION_UNRESOLVABLE: "its question template couldn't be resolved",
  TEMPLATE_CONFIG_INVALID: "its stored configuration couldn't be validated",
};

const ANOMALY_LABEL: Partial<Record<FixtureInternalStatus, string>> = {
  POSTPONED: "Match Postponed.",
  SUSPENDED: "Match Suspended.",
  ABANDONED: "Match Abandoned.",
  CANCELLED: "Match Cancelled.",
};

const VOID_REASON_LABELS: Record<PoolVoidReason, string> = {
  MATCH_POSTPONED_NOT_COMPLETED_SAME_DAY: "Match postponed",
  MATCH_SUSPENDED_NOT_COMPLETED_SAME_DAY: "Match suspended",
  MATCH_ABANDONED: "Match abandoned",
  MATCH_CANCELLED: "Match cancelled",
  MATCH_AWARDED: "Match awarded",
  MATCH_STATUS_UNKNOWN: "Match status unknown",
  MINIMUM_ENTRIES_NOT_REACHED: "Not enough players joined",
  NO_WINNING_ENTRIES: "No winning picks",
  ALL_ENTRIES_WINNING: "Everyone picked the winner",
  ADMIN_MANUAL_CANCEL: "Cancelled by an admin",
  NO_WINNING_ENTRIES_FEE_RETAINED: "No winning picks (fee retained)",
  COMBO_PLAYER_DID_NOT_PLAY: "Player did not play",
  ONE_SIDED_POOL: "Everyone picked the same side",
};

/**
 * Short, ledger-friendly label for a pool_void_reason enum value —
 * different from buildNoticeCopy's full-sentence messages below, which are
 * for the pool card's own status banner, not a one-line ledger row.
 * wallet_transactions.reason also stores free-text admin notes (manual
 * deposits, account closures, etc.), so anything not a recognized void
 * reason passes through unchanged rather than being reformatted.
 */
export function voidReasonLabel(value: string): string {
  return (VOID_REASON_LABELS as Record<string, string>)[value] ?? value;
}

/**
 * The single source of truth for every X.7.6-11 / X.5.14 copy string, plus
 * the reasonable on-brand defaults spec doesn't literally give (READY_FOR_
 * REVIEW's neutral copy, and the AWARDED/UNKNOWN void reasons — spec §16.4
 * lists those statuses but X.7 only writes copy for the original four).
 * `SocialPoolCardViewModel.notice` is built from this once, server-side —
 * `PoolStatusNotice` just renders the precomputed message.
 */
export function buildNoticeCopy(input: NoticeInput): Notice | null {
  const {
    poolStatus,
    fixtureInternalStatus,
    voidReason,
    entryStatus,
    entryAmount,
    finalPayout,
    winningOptionLabel,
    selectedOptionLabel,
    poolType,
    houseFeeBasisPoints,
    reviewReason,
  } = input;

  const isCustom = poolType === "CUSTOM" || poolType === "COMBO";

  if (poolStatus === "MANUAL_REVIEW") {
    const detail = reviewReason ? REVIEW_REASON_LABELS[reviewReason] : null;
    const hasActiveEntry = entryStatus === "ACTIVE";
    const base = detail
      ? `This pool needs a closer look — ${detail}.`
      : "This pool needs a closer look before it can be settled.";
    return {
      type: "MANUAL_REVIEW",
      message: hasActiveEntry ? `${base} Your entry is safe; nothing has been settled or refunded yet.` : base,
    };
  }

  if (poolStatus === "VOIDED" || poolStatus === "CANCELLED") {
    return buildVoidNotice(voidReason, entryStatus, entryAmount, houseFeeBasisPoints);
  }

  if (
    (poolStatus === "LOCKED" || poolStatus === "AWAITING_RESULT") &&
    isAnomalyStatus(fixtureInternalStatus)
  ) {
    return buildPendingAnomalyNotice(fixtureInternalStatus);
  }

  if (poolStatus === "LOCKED") {
    return {
      type: "LOCKED",
      message: isCustom
        ? "Choices are locked. Waiting for the result."
        : "Choices are locked. Waiting for kickoff.",
    };
  }

  if (
    poolStatus === "READY_FOR_REVIEW" ||
    poolStatus === "SETTLEMENT_REVERSED" ||
    poolStatus === "REVERSAL_FAILED_MANUAL_REVIEW"
  ) {
    return {
      type: "READY_FOR_REVIEW",
      message: isCustom
        ? "Voting has ended. Results are pending review."
        : "Match complete. Results are pending review.",
    };
  }

  if (poolStatus === "SETTLED" && entryStatus === "WON") {
    return {
      type: "SETTLED_WON",
      message: finalPayout != null ? `You won ${formatCents(finalPayout)}` : "You won!",
    };
  }

  // X.5.14's losing copy ("Spain advanced. Your choice was France.") needs
  // the winning option's and the user's own choice's labels — only buildable
  // once both are known, so this stays a no-op notice until the caller has
  // them (avoids shaming/loss-focused messaging by omission otherwise).
  if (poolStatus === "SETTLED" && entryStatus === "LOST" && winningOptionLabel && selectedOptionLabel) {
    return {
      type: "SETTLED_LOST",
      message: `${winningOptionLabel} won. Your choice was ${selectedOptionLabel}.`,
    };
  }

  return null;
}

// X.7.9's "waiting" copy is only spelled out for SUSPENDED; the other three
// X.7.1 statuses get the same shape (status label + waiting sentence) for
// consistency while their same-calendar-day window is still open.
function buildPendingAnomalyNotice(status: FixtureInternalStatus): Notice {
  const label = ANOMALY_LABEL[status] ?? "";
  return {
    type: `${status}_PENDING`,
    message: `${label} Choices are closed while we wait for an official update.`.trim(),
  };
}

function buildVoidNotice(
  voidReason: PoolVoidReason | null,
  entryStatus: EntryStatusForCard,
  entryAmount: number,
  houseFeeBasisPoints?: number,
): Notice {
  const hasEntry = entryStatus === "REFUNDED" || entryStatus === "VOID";

  // X.7.10: users with no entry never see refund-specific wording, no
  // matter the reason.
  if (!hasEntry) {
    return {
      type: voidReason ?? "VOIDED",
      message: "This pool has been voided and all entries have been refunded.",
    };
  }

  const amount = formatCents(entryAmount);
  // Only this one void reason ever refunds less than entryAmount — the
  // platform fee is retained instead of refunded, unlike every other
  // reason. Mirrors confirm_combo_refund_fee_retained's per-entry SQL exactly.
  const netAmount = formatCents(
    computeFeeRetainedRefund(entryAmount, houseFeeBasisPoints ?? 0).netRefund,
  );

  switch (voidReason) {
    case "MATCH_POSTPONED_NOT_COMPLETED_SAME_DAY":
      return {
        type: voidReason,
        message: `Match Postponed. This pool has been voided. Your ${amount} entry fee has been automatically credited back to your balance.`,
      };
    case "MATCH_CANCELLED":
      return {
        type: voidReason,
        message: `Match Cancelled. This pool has been voided. Your ${amount} entry fee has been automatically credited back to your balance.`,
      };
    case "MATCH_ABANDONED":
      return {
        type: voidReason,
        message: `Match Abandoned. This pool has been voided. Your ${amount} entry fee has been automatically credited back to your balance.`,
      };
    case "MATCH_SUSPENDED_NOT_COMPLETED_SAME_DAY":
      return {
        type: voidReason,
        message: `Match Suspended. The match was not completed today, so this pool has been voided. Your ${amount} entry fee has been credited back to your balance.`,
      };
    case "MINIMUM_ENTRIES_NOT_REACHED":
      return {
        type: voidReason,
        message: `Not enough players joined. This pool has been cancelled and your ${amount} entry has been credited back to your balance.`,
      };
    case "ADMIN_MANUAL_CANCEL":
      return {
        type: voidReason,
        message: `This pool has been cancelled by an admin. Your ${amount} entry has been credited back to your balance.`,
      };
    case "NO_WINNING_ENTRIES":
      return {
        type: voidReason,
        message: `Nobody picked the winning outcome, so this pool has been refunded. Your ${amount} entry has been credited back to your balance.`,
      };
    case "ALL_ENTRIES_WINNING":
      return {
        type: voidReason,
        message: `Everyone picked the winner! This pool has been refunded — no fee taken. Your ${amount} entry has been credited back to your balance.`,
      };
    case "NO_WINNING_ENTRIES_FEE_RETAINED":
      return {
        type: voidReason,
        message: `Nobody picked the graded outcome, so this pool has been refunded. Your ${netAmount} entry (net of the platform fee) has been credited back to your balance.`,
      };
    case "COMBO_PLAYER_DID_NOT_PLAY":
      return {
        type: voidReason,
        message: `A featured player did not take the pitch, so this pool has been voided — no fee taken. Your ${amount} entry has been credited back to your balance.`,
      };
    case "ONE_SIDED_POOL":
      return {
        type: voidReason,
        message: `Everyone picked the same side, so this pool has been cancelled — no fee taken. Your ${amount} entry has been credited back to your balance.`,
      };
    case "MATCH_AWARDED":
      // Not literal spec copy (§16.4 only lists AWARDED as never-settling;
      // X.7 doesn't write copy for it) — same tone/shape as the four it does.
      return {
        type: voidReason,
        message: `Match Awarded. This pool has been voided. Your ${amount} entry fee has been automatically credited back to your balance.`,
      };
    case "MATCH_STATUS_UNKNOWN":
      return {
        type: voidReason,
        message: `This match's status could not be confirmed, so this pool has been voided. Your ${amount} entry fee has been automatically credited back to your balance.`,
      };
    default:
      return {
        type: "VOIDED",
        message: `This pool has been voided. Your ${amount} entry fee has been credited back to your balance.`,
      };
  }
}
