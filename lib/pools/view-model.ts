import {
  deriveCardState,
  type CardState,
  type PoolStatus,
  type EntryStatusForCard,
  type PoolVisibility,
} from "./card-state";
import { getRuleLabel, type PoolType } from "./templates";
import { buildNoticeCopy, type Notice } from "./notices";
import type { PoolVoidReason } from "./anomaly";
import type { FixtureInternalStatus } from "@/lib/sports-data/types";

export interface SocialPoolCardViewModel {
  poolId: string;
  status: CardState;
  visibility: PoolVisibility;
  // Not in X.14's literal example interface, but X.5.2 explicitly requires
  // "Posted 18m ago" copy, which needs a creation timestamp — added as a
  // representative extension, not a deviation.
  postedAt: string;
  fixture: {
    competitionName: string | null;
    competitionCountry: string | null;
    competitionLogoUrl: string | null;
    round: string | null;
    kickoffAt: string;
    homeTeamName: string;
    homeTeamLogoUrl: string | null;
    awayTeamName: string;
    awayTeamLogoUrl: string | null;
    status: string;
    elapsedMinutes: number | null;
    homeScore: number | null;
    awayScore: number | null;
  };
  question: string;
  /** Short context line for CUSTOM/COMBO pools (e.g. "2026 World Cup
   *  Semifinal France – England"), shown above `question` where
   *  MatchIdentity would otherwise render. Null for fixture-backed pools. */
  title: string | null;
  poolType: PoolType;
  ruleLabel: string;
  /** COMBO's N graded conditions (e.g. "Mbappé 1+ goals") — informational
   *  only, shown alongside the Yes/No options but never itself selectable
   *  (only the fixed Yes/No pool_options are entries). Null for every other
   *  pool type. */
  comboLegs: Array<{ id: string; label: string }> | null;
  entryFee: number;
  houseFeeBasisPoints: number;
  minTotalEntries: number;
  locksAt: string;
  totalEntries: number;
  grossPool: number;
  estimatedNetPrizePool: number;
  options: Array<{
    optionId: string;
    label: string;
    teamLogoUrl: string | null;
    percentage: number | null;
    /** Pari-mutuel "if this option wins" estimate — same house-fee formula
     *  the backend uses at settlement, just applied prospectively per
     *  option. Gated identically to `percentage` (null whenever
     *  distribution isn't visible to this viewer yet). */
    estimatedPayout: number | null;
    isCurrentUserChoice: boolean;
  }>;
  currentUser: {
    hasEntered: boolean;
    selectedOptionId: string | null;
    entryCount: number;
    entryAmount: number;
    estimatedPayout: number | null;
    finalPayout: number | null;
    refundedAmount: number | null;
  };
  socialProof: {
    participantCount: number;
    visibleParticipants: Array<{ displayName: string; avatarUrl: string | null }>;
  };
  likeCount: number;
  isLikedByCurrentUser: boolean;
  commentCount: number;
  notice: Notice | null;
}

export interface BuildViewModelInput {
  pool: {
    id: string;
    question: string;
    title: string | null;
    pool_type: PoolType;
    entry_fee: number;
    house_fee_bps: number;
    min_total_entries: number;
    locks_at: string;
    status: PoolStatus;
    created_at: string;
    void_reason: PoolVoidReason | null;
    visibility: PoolVisibility;
    like_count: number;
    comment_count: number;
  };
  fixture: {
    competition_name: string | null;
    competition_country: string | null;
    competition_logo_url: string | null;
    round: string | null;
    scheduled_start_utc: string;
    home_team_name: string;
    home_team_logo_url: string | null;
    away_team_name: string;
    away_team_logo_url: string | null;
    internal_status: FixtureInternalStatus;
    elapsed_minutes: number | null;
    home_score: number | null;
    away_score: number | null;
  };
  options: Array<{
    id: string;
    label: string;
    logo_url: string | null;
    entry_count: number | null;
    total_entry_amount: number | null;
    is_winning_option: boolean;
  }>;
  currentUserEntry: { option_id: string; amount: number; status: EntryStatusForCard } | null;
  totals: { total_entries: number; gross_pool: number };
  participants: Array<{ display_name: string; avatar_url: string | null }>;
  participantCount: number;
  /** From settlement_payouts, only present once the current user's entry is WON. */
  finalPayout: number | null;
  isLikedByCurrentUser: boolean;
  /** Only populated (and only meaningful) for COMBO pools. */
  comboLegs?: Array<{ id: string; label: string }>;
}

/**
 * Per-option percentage + "if this option wins" payout estimate — the same
 * math `buildPoolCardViewModel` needs for its initial server render, and
 * what a live realtime-triggered refetch (`getPoolLiveStats`) needs too.
 * Kept in one place so the two paths can never drift. `entry_count` is
 * already nulled upstream (in `pool_options_public`) whenever this viewer
 * isn't allowed to see distribution yet — both outputs inherit that null
 * for free, no separate gating logic needed here.
 */
export function computeOptionStats(
  options: Array<{ id: string; entry_count: number | null }>,
  totalEntries: number,
  estimatedNetPrizePool: number,
): Array<{ optionId: string; percentage: number | null; estimatedPayout: number | null }> {
  return options.map((option) => ({
    optionId: option.id,
    percentage:
      option.entry_count != null && totalEntries > 0
        ? Math.round((option.entry_count / totalEntries) * 100)
        : null,
    estimatedPayout:
      option.entry_count != null && option.entry_count > 0
        ? Math.floor(estimatedNetPrizePool / option.entry_count)
        : null,
  }));
}

/** Shapes raw DB rows (pool + pool_options_public + fixture + entry +
 * participants) into the X.14 SocialPoolCardViewModel contract. Kept
 * separate from the page-level data fetching so it's independently
 * testable and reused by Feed / pool detail / My Picks alike. */
export function buildPoolCardViewModel(input: BuildViewModelInput): SocialPoolCardViewModel {
  const {
    pool,
    fixture,
    options,
    currentUserEntry,
    totals,
    participants,
    participantCount,
    finalPayout,
    isLikedByCurrentUser,
    comboLegs,
  } = input;

  const status = deriveCardState(
    { status: pool.status, locksAt: pool.locks_at },
    { internalStatus: fixture.internal_status },
    currentUserEntry?.status ?? null,
  );

  const houseFeeMultiplier = (10000 - pool.house_fee_bps) / 10000;
  const estimatedNetPrizePool = Math.floor(totals.gross_pool * houseFeeMultiplier);

  const optionStatsById = new Map(
    computeOptionStats(options, totals.total_entries, estimatedNetPrizePool).map((s) => [
      s.optionId,
      s,
    ]),
  );

  const hasEntered =
    currentUserEntry != null &&
    (currentUserEntry.status === "ACTIVE" ||
      currentUserEntry.status === "WON" ||
      currentUserEntry.status === "LOST");

  const selectedOption = hasEntered
    ? options.find((o) => o.id === currentUserEntry!.option_id)
    : undefined;

  const estimatedPayout =
    hasEntered && selectedOption?.entry_count && selectedOption.entry_count > 0
      ? Math.floor(estimatedNetPrizePool / selectedOption.entry_count)
      : null;

  const refundedAmount =
    currentUserEntry?.status === "REFUNDED" ? currentUserEntry.amount : null;

  const winningOption = options.find((o) => o.is_winning_option);

  const notice = buildNoticeCopy({
    poolStatus: pool.status,
    fixtureInternalStatus: fixture.internal_status,
    voidReason: pool.void_reason,
    entryStatus: currentUserEntry?.status ?? null,
    entryAmount: currentUserEntry?.amount ?? 0,
    finalPayout,
    winningOptionLabel: winningOption?.label ?? null,
    selectedOptionLabel: selectedOption?.label ?? null,
    poolType: pool.pool_type,
    houseFeeBasisPoints: pool.house_fee_bps,
  });

  return {
    poolId: pool.id,
    status,
    visibility: pool.visibility,
    postedAt: pool.created_at,
    fixture: {
      competitionName: fixture.competition_name,
      competitionCountry: fixture.competition_country,
      competitionLogoUrl: fixture.competition_logo_url,
      round: fixture.round,
      kickoffAt: fixture.scheduled_start_utc,
      homeTeamName: fixture.home_team_name,
      homeTeamLogoUrl: fixture.home_team_logo_url,
      awayTeamName: fixture.away_team_name,
      awayTeamLogoUrl: fixture.away_team_logo_url,
      status: fixture.internal_status,
      elapsedMinutes: fixture.elapsed_minutes,
      homeScore: fixture.home_score,
      awayScore: fixture.away_score,
    },
    question: pool.question,
    title: pool.title,
    poolType: pool.pool_type,
    ruleLabel: getRuleLabel(pool.pool_type),
    comboLegs:
      pool.pool_type === "COMBO"
        ? (comboLegs ?? []).map((leg) => ({ id: leg.id, label: leg.label }))
        : null,
    entryFee: pool.entry_fee,
    houseFeeBasisPoints: pool.house_fee_bps,
    minTotalEntries: pool.min_total_entries,
    locksAt: pool.locks_at,
    totalEntries: totals.total_entries,
    grossPool: totals.gross_pool,
    estimatedNetPrizePool,
    options: options.map((option) => {
      const stats = optionStatsById.get(option.id);
      return {
        optionId: option.id,
        label: option.label,
        teamLogoUrl: option.logo_url,
        percentage: stats?.percentage ?? null,
        estimatedPayout: stats?.estimatedPayout ?? null,
        isCurrentUserChoice: hasEntered && currentUserEntry!.option_id === option.id,
      };
    }),
    currentUser: {
      hasEntered,
      selectedOptionId: hasEntered ? currentUserEntry!.option_id : null,
      entryCount: hasEntered ? 1 : 0,
      entryAmount: hasEntered ? currentUserEntry!.amount : 0,
      estimatedPayout,
      finalPayout,
      refundedAmount,
    },
    socialProof: {
      participantCount,
      visibleParticipants: participants.slice(0, 3).map((p) => ({
        displayName: p.display_name,
        avatarUrl: p.avatar_url,
      })),
    },
    likeCount: pool.like_count,
    isLikedByCurrentUser,
    commentCount: pool.comment_count,
    notice,
  };
}
