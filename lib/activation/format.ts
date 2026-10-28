import type { ActivationFunnel, ActivationWeek } from "./types";

// Fail-closed parsing of activation_funnel_summary(), and the few figures the report states. A rate is only ever shown next to its counts, and with fewer than MIN_COHORT Members in the denominator the report says
// it is too few to read (Production is tiny, and test accounts are not a population): the numbers are a foundation, not a claim.

/** Below this many Members in a denominator, a percentage means nothing. */
export const MIN_COHORT = 30;

function int(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

export function parseActivationFunnel(raw: unknown): ActivationFunnel | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const registered = int(r.registered), registered24hOld = int(r.registered_24h_old), pickedEver = int(r.picked_ever), pickedWithin24h = int(r.picked_within_24h);
  const activated7dOld = int(r.activated_7d_old), secondPickWithin7d = int(r.second_pick_within_7d), firstGraded48hOld = int(r.first_graded_48h_old), cameBackWithin48h = int(r.came_back_within_48h);
  const commented = int(r.commented), calledBs = int(r.called_bs), weeklyMinDecided = int(r.weekly_min_decided), rankedThisWeek = int(r.ranked_this_week);
  if ([registered, registered24hOld, pickedEver, pickedWithin24h, activated7dOld, secondPickWithin7d, firstGraded48hOld, cameBackWithin48h, commented, calledBs, weeklyMinDecided, rankedThisWeek].some((v) => v === null)) return null;
  if (typeof r.from !== "string" || typeof r.to !== "string" || !Array.isArray(r.by_week)) return null;
  const byWeek: ActivationWeek[] = [];
  for (const w of r.by_week) {
    if (typeof w !== "object" || w === null) return null;
    const x = w as Record<string, unknown>;
    const reg = int(x.registered), aged = int(x.registered_24h_old), pick = int(x.picked_within_24h);
    if (typeof x.week !== "string" || reg === null || aged === null || pick === null || pick > aged || aged > reg) return null;
    byWeek.push({ week: x.week, registered: reg, registered24hOld: aged, pickedWithin24h: pick });
  }
  const median = r.median_minutes_to_first_pick === null || r.median_minutes_to_first_pick === undefined ? null : Number(r.median_minutes_to_first_pick);
  if (median !== null && !Number.isFinite(median)) return null;
  // Internal consistency: a numerator can never exceed its denominator.
  if (pickedWithin24h! > registered24hOld! || registered24hOld! > registered! || pickedWithin24h! > pickedEver! || pickedEver! > registered! || secondPickWithin7d! > activated7dOld! || cameBackWithin48h! > firstGraded48hOld!) return null;
  return {
    from: r.from, to: r.to, registered: registered!, registered24hOld: registered24hOld!, pickedEver: pickedEver!, pickedWithin24h: pickedWithin24h!, medianMinutesToFirstPick: median,
    activated7dOld: activated7dOld!, secondPickWithin7d: secondPickWithin7d!, firstGraded48hOld: firstGraded48hOld!, cameBackWithin48h: cameBackWithin48h!, commented: commented!, calledBs: calledBs!,
    weeklyMinDecided: weeklyMinDecided!, rankedThisWeek: rankedThisWeek!, byWeek,
  };
}

/** "3 of 12 (25%)", or "3 of 12" when the denominator is too small for a percentage to mean anything, or "no one yet" for an empty denominator. */
export function rateLabel(numerator: number, denominator: number): string {
  if (denominator === 0) return "no one yet";
  if (denominator < MIN_COHORT) return `${numerator} of ${denominator}`;
  return `${numerator} of ${denominator} (${Math.round((numerator / denominator) * 100)}%)`;
}

export function tooSmall(denominator: number): boolean {
  return denominator > 0 && denominator < MIN_COHORT;
}
