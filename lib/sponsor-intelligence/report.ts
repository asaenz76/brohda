// Turns the exact aggregates (sponsor_intelligence_aggregates, migration 196) into the two views of a campaign's results:
//   * the SPONSOR view — every figure passed through the small-cohort suppression, nothing below the threshold, no Member-level data of any kind;
//   * the ADMIN view — the exact figures, plus which figures a Sponsor would currently NOT be shown.
// PURE (no database, no settings read): the numbers come in, the threshold comes in. The raw shape contains only counts and labels — never a Member id, name or e-mail.
//
// Sponsor Intelligence measures attention, participation, prediction behaviour and social engagement around a Sponsored Game. It has NO monetary metric of any kind: nothing about
// wallets, stakes, P2P, Positions, fees or balances exists in the raw shape or in either view (tests/unit/sponsor-intelligence/no-monetary.test.ts guards that).

import { getChoicePresentation } from "@/lib/prediction-markets/selection-labels";
import { computePickSentiment } from "@/lib/predictions/sentiment";
import { suppressBreakdown, suppressCount, suppressSubset, type BreakdownCell, type SuppressedBreakdown, type SuppressedCount } from "./suppression";

export interface RawMarketAggregate {
  marketId: string;
  template: string | null;
  lineValue: number | null;
  yesSide: string | null;
  /** Members who made a Pick on this Market inside the window. */
  members: number;
  yesCount: number;
  noCount: number;
}

export interface RawAggregates {
  sponsorshipId: string;
  windowStart: string | null;
  windowEnd: string | null;
  started: boolean;
  impressions: number;
  uniqueViewers: number;
  repeatViewers: number;
  clicks: number;
  picks: number;
  pickMembers: number;
  viewersWhoPicked: number;
  comments: number;
  replies: number;
  commenters: number;
  callBsChallenges: number;
  callBsAccepted: number;
  callBsMembers: number;
  callBsPickers: number;
  returningMembers: number;
  sportAffinity: Array<{ key: string; count: number }>;
  teamAffinity: Array<{ key: string; label: string; count: number }>;
  markets: RawMarketAggregate[];
  game: { homeTeamName: string | null; awayTeamName: string | null; sport: string | null } | null;
  affinityLookbackDays: number;
}

export const METRIC_KEYS = [
  "uniqueViewers",
  "repeatViewers",
  "impressions",
  "clicks",
  "pickMembers",
  "viewersWhoPicked",
  "picks",
  "commenters",
  "comments",
  "replies",
  "callBsMembers",
  "callBsPickers",
  "callBsChallenges",
  "callBsAccepted",
  "returningMembers",
] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

/**
 * A percentage is only ever computed from two figures that are BOTH shown (so both already passed suppression). `null` = withheld (a figure it needs is under the threshold);
 * `"none"` = there is nothing to measure yet (the denominator is a shown zero) — not a privacy matter, so the page reads "—" rather than "Not enough data yet".
 */
export type SponsorRate = number | "none" | null;

export interface SponsorRates {
  /** Of the Members who saw it, the share who made a Pick. */
  participation: SponsorRate;
  /** Of the Call BS challenges, the share the recipient accepted. */
  callBsAcceptance: SponsorRate;
  /** Of the Members who made a Pick, the share who took part in a Call BS. */
  callBsEngagement: SponsorRate;
}

export interface SponsorMarketRow {
  marketId: string;
  label: string;
  /** Members who picked this Market, or null when withheld. */
  members: SuppressedCount;
  /** The split of Picks between the two sides, or null unless BOTH sides are individually large enough to show. */
  sentiment: Array<{ label: string; percent: number }> | null;
}

export interface SponsorReport {
  windowStart: string | null;
  windowEnd: string | null;
  minCohort: number;
  affinityLookbackDays: number;
  metrics: Record<MetricKey, SuppressedCount>;
  rates: SponsorRates;
  markets: SponsorMarketRow[];
  sportAffinity: SuppressedBreakdown;
  teamAffinity: SuppressedBreakdown;
  /** True when at least one figure was withheld, so the page can explain why. */
  anySuppressed: boolean;
}

export interface AdminMarketRow {
  marketId: string;
  label: string;
  members: number;
  yesLabel: string;
  yesCount: number;
  noLabel: string;
  noCount: number;
}

export interface AdminReport {
  exact: RawAggregates;
  adminMarkets: AdminMarketRow[];
  /** Sport affinity in words, exact counts. */
  adminSportAffinity: Array<{ label: string; count: number }>;
  /** Which figures the Sponsor would NOT be shown right now at the current threshold. */
  suppressedForSponsor: MetricKey[];
  sponsorView: SponsorReport;
}

function numberOr0(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0;
}

function rate(part: SuppressedCount, whole: SuppressedCount): SponsorRate {
  if (part === null || whole === null) return null;
  return whole > 0 ? Math.round((part / whole) * 100) : "none";
}

/** The label source for one Market, built from the shared label helper's own input shape — no label is composed here. */
function marketPresentation(raw: RawAggregates, m: RawMarketAggregate) {
  return getChoicePresentation({
    marketTemplate: m.template as never,
    lineValue: m.lineValue,
    yesSide: m.yesSide as never,
    homeTeamName: raw.game?.homeTeamName ?? null,
    awayTeamName: raw.game?.awayTeamName ?? null,
    sport: raw.game?.sport ?? null,
  });
}

/** The Sponsor-facing report: everything suppressed at `minCohort`. `sportLabel` turns a sport key into the words a Sponsor reads. */
export function buildSponsorReport(raw: RawAggregates, minCohort: number, sportLabel: (key: string) => string): SponsorReport {
  const v = (key: MetricKey): number => numberOr0(raw[key]);
  const metrics: Record<MetricKey, SuppressedCount> = {
    uniqueViewers: suppressCount(v("uniqueViewers"), minCohort),
    impressions: suppressCount(v("impressions"), minCohort),
    clicks: suppressCount(v("clicks"), minCohort),
    pickMembers: suppressCount(v("pickMembers"), minCohort),
    picks: suppressCount(v("picks"), minCohort),
    commenters: suppressCount(v("commenters"), minCohort),
    comments: suppressCount(v("comments"), minCohort),
    replies: suppressCount(v("replies"), minCohort),
    callBsMembers: suppressCount(v("callBsMembers"), minCohort),
    callBsChallenges: suppressCount(v("callBsChallenges"), minCohort),
    // A SUBSET is shown only when its remainder is safe too — otherwise "total − subset" would reveal a small group.
    repeatViewers: suppressSubset(v("repeatViewers"), v("uniqueViewers"), minCohort),
    viewersWhoPicked: suppressSubset(v("viewersWhoPicked"), v("uniqueViewers"), minCohort),
    callBsAccepted: suppressSubset(v("callBsAccepted"), v("callBsChallenges"), minCohort),
    callBsPickers: suppressSubset(v("callBsPickers"), v("pickMembers"), minCohort),
    returningMembers: suppressSubset(v("returningMembers"), v("pickMembers"), minCohort),
  };
  // An event total is withheld when the Members behind it are a small group (45 impressions from 3 Members would point at 3 people).
  if (metrics.uniqueViewers === null) metrics.impressions = null;
  if (metrics.pickMembers === null) metrics.picks = null;
  if (metrics.commenters === null) {
    metrics.comments = null;
    metrics.replies = null;
  }
  if (metrics.callBsMembers === null) metrics.callBsChallenges = null;
  // …and the same rule the other way: a subset needs its parent shown.
  if (metrics.uniqueViewers === null) {
    metrics.repeatViewers = null;
    metrics.viewersWhoPicked = null;
  }
  if (metrics.callBsChallenges === null) metrics.callBsAccepted = null;
  if (metrics.pickMembers === null) {
    metrics.callBsPickers = null;
    metrics.returningMembers = null;
  }

  const rates: SponsorRates = {
    participation: rate(metrics.viewersWhoPicked, metrics.uniqueViewers),
    callBsAcceptance: rate(metrics.callBsAccepted, metrics.callBsChallenges),
    callBsEngagement: rate(metrics.callBsPickers, metrics.pickMembers),
  };

  // Per Market: how many Members picked it, and — only when each side is large enough on its own — how the Picks split. The split uses the product's one sentiment calculation.
  const markets: SponsorMarketRow[] = (raw.markets ?? []).map((m) => {
    const presentation = marketPresentation(raw, m);
    const members = suppressCount(numberOr0(m.members), minCohort);
    const yes = numberOr0(m.yesCount);
    const no = numberOr0(m.noCount);
    const bothSidesShown = suppressCount(yes, minCohort) !== null && suppressCount(no, minCohort) !== null && yes > 0 && no > 0;
    let sentiment: SponsorMarketRow["sentiment"] = null;
    if (members !== null && bothSidesShown) {
      const s = computePickSentiment({ marketId: m.marketId, totalPickCount: yes + no, yesCount: yes, noCount: no });
      const percentFor = (outcome: "YES" | "NO") => (outcome === "YES" ? s.yesPercent : s.noPercent);
      sentiment = presentation.choices.map((c) => ({ label: c.label, percent: percentFor(c.outcome) ?? 0 }));
    }
    return { marketId: m.marketId, label: presentation.marketLabel ?? "Market", members, sentiment };
  });

  const sportCells: BreakdownCell[] = (raw.sportAffinity ?? []).map((c) => ({ key: c.key, label: sportLabel(c.key), count: numberOr0(c.count) }));
  const teamCells: BreakdownCell[] = (raw.teamAffinity ?? []).map((c) => ({ key: c.key, label: c.label, count: numberOr0(c.count) }));
  const sportAffinity = suppressBreakdown(sportCells, minCohort);
  const teamAffinity = suppressBreakdown(teamCells, minCohort);

  const anySuppressed =
    METRIC_KEYS.some((key) => metrics[key] === null) ||
    markets.some((m) => m.members === null || m.sentiment === null) ||
    sportAffinity.cells.length < sportCells.length ||
    teamAffinity.cells.length < teamCells.length;

  return { windowStart: raw.windowStart, windowEnd: raw.windowEnd, minCohort, affinityLookbackDays: raw.affinityLookbackDays, metrics, rates, markets, sportAffinity, teamAffinity, anySuppressed };
}

export function buildAdminReport(raw: RawAggregates, minCohort: number, sportLabel: (key: string) => string): AdminReport {
  const sponsorView = buildSponsorReport(raw, minCohort, sportLabel);
  const adminMarkets: AdminMarketRow[] = (raw.markets ?? []).map((m) => {
    const presentation = marketPresentation(raw, m);
    const labelFor = (outcome: "YES" | "NO") => presentation.choices.find((c) => c.outcome === outcome)?.label ?? outcome;
    return { marketId: m.marketId, label: presentation.marketLabel ?? "Market", members: numberOr0(m.members), yesLabel: labelFor("YES"), yesCount: numberOr0(m.yesCount), noLabel: labelFor("NO"), noCount: numberOr0(m.noCount) };
  });
  const adminSportAffinity = (raw.sportAffinity ?? []).map((c) => ({ label: sportLabel(c.key), count: numberOr0(c.count) }));
  return { exact: raw, adminMarkets, adminSportAffinity, suppressedForSponsor: METRIC_KEYS.filter((key) => sponsorView.metrics[key] === null), sponsorView };
}
